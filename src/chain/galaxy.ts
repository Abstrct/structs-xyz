/* The galaxy snapshot: every struct, struct attribute, planet attribute and grid value in the
 * galaxy, in memory, kept current by both live feeds. A browser port of structs-universe's
 * perception snapshot (src-tauri/src/mcp/perception.rs; proposals/perception-shared-prefetch.md).
 *
 * Why: the galaxy-wide screens (another commander's board, the enemy board, targets, the economy,
 * the power grid) otherwise read the chain one entity at a time, and each read is stale the moment
 * it lands. One bulk walk (the guild's catalog when a session is open, else the LCD's stores) and
 * then every change is a patch in place:
 *   - GRASS frames carry absolute new values (grid `value_p`, struct health/status, build clocks,
 *     guard links, moves, shields, raid clocks);
 *   - the chain's own WebSocket carries the typed events (EventStruct, EventStructAttribute,
 *     EventPlanetAttribute, EventGrid): new structs and the ore clocks, which GRASS never sends.
 * Absolute values make replays harmless; old frames are dropped by height (planet activity, chain
 * events) or by time (grid frames). Frames that arrive during a re-walk are applied to the old copy
 * and replayed onto the new one before it is swapped in. Re-walked every 10 minutes while a screen
 * wants it and the page is visible.
 *
 * Trusted only while fresh (walked within 20 minutes) and a live feed is up. Your own empire never
 * reads from here: proofs and actions need exact clocks, so src/game/empire.ts reads fresh.
 *
 * The indexer deletes a value that drops to zero, and the LCD omits it: absent means 0. Size today
 * is about 830k rows, so it loads only when a screen asks for it (`want`), and not at all on a
 * device that reports under 4 GB of memory. */
import { LCD_URL, type StructFull, type Grid, type PlanetAttributes } from './lcd';
import { live, type LiveTx } from './live';
import { session } from '../guild/session';
import { grass, type GrassEvent } from '../grass/grass';
import { idIndex, safeEach } from '../core/util';
import type { GuildApi } from '../guild/api';

export const GRID_ATTRS = ['ore', 'fuel', 'capacity', 'load', 'structsLoad', 'power', 'connectionCapacity', 'connectionCount', 'allocationPointerStart', 'allocationPointerEnd', 'proxyNonce', 'lastAction', 'nonce', 'ready', 'checkpointBlock'] as const;
/** Struct attributes 0–5 (6, typeCount, lives on player ids and isn't kept). */
export const STRUCT_ATTRS = ['health', 'status', 'blockStartBuild', 'blockStartOreMine', 'blockStartOreRefine', 'protectedStructIndex'] as const;
export const PLANET_ATTRS = ['planetaryShield', 'repairNetworkQuantity', 'defensiveCannonQuantity', 'coordinatedGlobalShieldNetworkQuantity',
  'lowOrbitBallisticsInterceptorNetworkQuantity', 'advancedLowOrbitBallisticsInterceptorNetworkQuantity',
  'lowOrbitBallisticsInterceptorNetworkSuccessRateNumerator', 'lowOrbitBallisticsInterceptorNetworkSuccessRateDenominator',
  'orbitalJammingStationQuantity', 'advancedOrbitalJammingStationQuantity', 'blockStartRaid', 'blockRaiderArrived',
  'blockStartOreMine', 'blockStartOreRefine', 'oreMiningActiveQuantity', 'oreRefiningActiveQuantity'] as const;
const S_HEALTH = 0, S_STATUS = 1, S_BUILD = 2, S_MINE = 3, S_REFINE = 4, S_PROTECTED = 5;
const P_SHIELD = 0, P_RAID = 10, P_MINE = 12, P_REFINE = 13;
const BUILT = 2;

const REFRESH_MS = 10 * 60_000;
const TRUST_MS = 20 * 60_000;
/** A screen's interest lasts this long after its last `want()`. */
const WANT_MS = 10 * 60_000;
const PENDING_MAX = 20_000;

export interface StructRow { id: string; type: number; owner: string; locationType: string; locationId: string; ambit: string; slot: number }

type Frame = { at: number } & ({ kind: 'grass'; e: GrassEvent } | { kind: 'chain'; tx: LiveTx });

/** One walked copy of the galaxy. */
export class Snapshot {
  structs = new Map<string, StructRow>();
  /** Struct id → attributes 0–5 (absent: all zero). */
  sattrs = new Map<string, Float64Array>();
  /** Planet id → attributes 0–15. */
  pattrs = new Map<string, Float64Array>();
  /** Object id → grid values, as decimal strings (fuel in ualpha can pass 2^53). */
  grid = new Map<string, string[]>();
  /** Location (planet or fleet) id → struct ids there. */
  private at = new Map<string, Set<string>>();
  /** Protected struct index → its guards' ids. */
  private guards = new Map<number, Set<string>>();
  /** The height the walk started at: frames older than this are already in it. */
  minHeight = 0;
  /** When the walk started (ms): grid frames stamped before it are already in it. */
  takenAt = 0;
  source: 'guild' | 'lcd' = 'lcd';
  /** Structs a build clock named before their row arrived (the chain event usually follows). */
  pendingNew = new Set<string>();
  applied = 0;
  stale = 0;

  /* ── Writes ─────────────────────────────────────────────────────────── */

  putStruct(r: StructRow) {
    const old = this.structs.get(r.id);
    if (old && old.locationId !== r.locationId) this.at.get(old.locationId)?.delete(r.id);
    this.structs.set(r.id, r);
    if (r.locationId) { let s = this.at.get(r.locationId); if (!s) this.at.set(r.locationId, (s = new Set())); s.add(r.id); }
    this.pendingNew.delete(r.id);
  }
  setStructAttr(id: string, i: number, v: number): boolean {
    let a = this.sattrs.get(id);
    if (!a) { if (!v) return false; this.sattrs.set(id, (a = new Float64Array(STRUCT_ATTRS.length))); }
    if (a[i] === v) return false;
    if (i === S_PROTECTED) {
      if (a[i]) this.guards.get(a[i])?.delete(id);
      if (v) { let s = this.guards.get(v); if (!s) this.guards.set(v, (s = new Set())); s.add(id); }
    }
    a[i] = v;
    return true;
  }
  setPlanetAttr(id: string, i: number, v: number): boolean {
    let a = this.pattrs.get(id);
    if (!a) { if (!v) return false; this.pattrs.set(id, (a = new Float64Array(PLANET_ATTRS.length))); }
    if (a[i] === v) return false;
    a[i] = v;
    return true;
  }
  setGrid(id: string, i: number, v: string): boolean {
    let g = this.grid.get(id);
    if (!g) { if (v === '0') return false; this.grid.set(id, (g = new Array(GRID_ATTRS.length).fill('0'))); }
    if (g[i] === v) return false;
    g[i] = v;
    return true;
  }
  /** An attribute record by its chain id ("<attr>-<objectType>-<index>[-<sub>]"). */
  putAttribute(store: 'struct' | 'planet' | 'grid', attributeId: string, value: unknown): boolean {
    const m = /^(\d+)-(\d+)-(\d+)/.exec(attributeId);
    if (!m) return false;
    const attr = Number(m[1]), obj = `${m[2]}-${m[3]}`;
    const raw = value == null || value === '' ? '0' : String(value).split('.')[0];
    if (!/^-?\d+$/.test(raw)) return false;
    if (store === 'grid') return attr < GRID_ATTRS.length && this.setGrid(obj, attr, raw);
    if (store === 'planet') return attr < PLANET_ATTRS.length && this.setPlanetAttr(obj, attr, Number(raw));
    return attr < STRUCT_ATTRS.length && m[2] === '5' && this.setStructAttr(obj, attr, Number(raw));
  }

  /* ── Reads, in the LCD's shapes ─────────────────────────────────────── */

  structFull(id: string): StructFull | null {
    const r = this.structs.get(id);
    if (!r) return null;
    const a = this.sattrs.get(id) ?? new Float64Array(STRUCT_ATTRS.length);
    const st = a[S_STATUS];
    const g = this.gridOf(id);
    return {
      Struct: { id, index: String(idIndex(id)), type: String(r.type), creator: '', owner: r.owner, locationType: r.locationType, locationId: r.locationId, operatingAmbit: r.ambit, slot: String(r.slot) },
      structAttributes: {
        health: String(a[S_HEALTH]), status: String(st), blockStartBuild: String(a[S_BUILD]),
        ...({ blockStartOreMine: String(a[S_MINE]), blockStartOreRefine: String(a[S_REFINE]) } as object),
        protectedStructIndex: String(a[S_PROTECTED]),
        isMaterialized: !!(st & 1), isBuilt: !!(st & 2), isOnline: !!(st & 4), isHidden: !!(st & 16), isDestroyed: !!(st & 32), isLocked: !!(st & 64),
      },
      gridAttributes: g,
      structDefenders: [...(this.guards.get(idIndex(id)) ?? [])].filter((d) => this.structs.has(d)).sort((x, y) => idIndex(x) - idIndex(y)),
    };
  }
  /** Struct ids standing at a planet or in a fleet. */
  structsAt(locationId: string): string[] { return [...(this.at.get(locationId) ?? [])]; }
  gridOf(id: string): Grid {
    const g = this.grid.get(id);
    const out: Record<string, string> = {};
    GRID_ATTRS.forEach((k, i) => { out[k] = g ? g[i] : '0'; });
    return out as Grid;
  }
  planetAttrs(id: string): PlanetAttributes {
    const a = this.pattrs.get(id);
    const out: Record<string, string> = {};
    PLANET_ATTRS.forEach((k, i) => { out[k] = String(a ? a[i] : 0); });
    return out as PlanetAttributes;
  }

  /* ── Live patches ───────────────────────────────────────────────────── */

  /** One GRASS frame. True when it changed something. */
  applyGrass(e: GrassEvent): boolean {
    if (e.stub) return false;
    if (e.kind === 'grid') {
      const i = (GRID_ATTRS as readonly string[]).indexOf(String(e.data.attribute_type ?? e.category));
      const id = e.objectId;
      // Only the chain-precision value: `value` is a floored display figure.
      if (i < 0 || !id || e.data.value_p == null) return false;
      const ts = Date.parse(String(e.data.updated_at || ''));
      if (ts && this.takenAt && ts + 2000 < this.takenAt) { this.stale++; return false; }
      return this.count(this.setGrid(id, i, String(e.data.value_p).split('.')[0]));
    }
    if (e.kind !== 'planet') return false;
    if (e.height && e.height < this.minHeight) { this.stale++; return false; }
    const d = e.detail;
    const n = (v: unknown) => Number(v) || 0;
    const sid = typeof d.struct_id === 'string' ? d.struct_id : '';
    switch (e.category) {
      case 'struct_status': {
        if (!sid) return false;
        const was = this.sattrs.get(sid)?.[S_STATUS] ?? 0, now = n(d.status);
        const r = this.setStructAttr(sid, S_STATUS, now);
        // The chain clears the build clock when a build completes and never says so.
        if (now & BUILT && !(was & BUILT)) this.setStructAttr(sid, S_BUILD, 0);
        return this.count(r);
      }
      case 'struct_health': return sid ? this.count(this.setStructAttr(sid, S_HEALTH, n(d.health))) : false;
      case 'struct_block_build_start':
        if (!sid) return false;
        if (!this.structs.has(sid)) this.pendingNew.add(sid);
        return this.count(this.setStructAttr(sid, S_BUILD, n(d.block ?? d.block_height)));
      case 'struct_defense_add':
      case 'struct_defense_remove': {
        const def = typeof d.defender_struct_id === 'string' ? d.defender_struct_id : '';
        if (!def) return false;
        const to = e.category === 'struct_defense_add' && typeof d.protected_struct_id === 'string' ? idIndex(d.protected_struct_id) : 0;
        return this.count(this.setStructAttr(def, S_PROTECTED, to));
      }
      case 'struct_move': {
        const r = this.structs.get(sid);
        if (!r || typeof d.location_id !== 'string') return false;
        const next = { ...r, locationType: String(d.location_type ?? r.locationType), locationId: d.location_id, ambit: String(d.ambit ?? r.ambit), slot: n(d.slot) };
        if (next.locationType === r.locationType && next.locationId === r.locationId && next.ambit === r.ambit && next.slot === r.slot) return false;
        this.putStruct(next);
        return this.count(true);
      }
      case 'shield_change': return e.planetId ? this.count(this.setPlanetAttr(e.planetId, P_SHIELD, n(d.planetary_shield))) : false;
      case 'struct_block_ore_mine_start':
      case 'struct_block_ore_refine_start': {
        const pid = typeof d.planet_id === 'string' ? d.planet_id : e.planetId;
        return pid ? this.count(this.setPlanetAttr(pid, e.category === 'struct_block_ore_mine_start' ? P_MINE : P_REFINE, n(d.block ?? d.block_height))) : false;
      }
      // The frame carries the raid clock itself (0 when the raid ended), not the frame's height.
      case 'block_raid_start': return e.planetId ? this.count(this.setPlanetAttr(e.planetId, P_RAID, n(d.block_start_raid ?? d.block ?? d.block_height))) : false;
    }
    return false;
  }

  /** One transaction from the chain's WebSocket: its typed events, as absolute values. */
  applyChain(tx: LiveTx): boolean {
    if (tx.height && tx.height < this.minHeight) { this.stale++; return false; }
    let changed = false;
    for (const ev of tx.events) {
      const d = (ev.data || {}) as Record<string, any>;
      const rec = (k: string) => (d[k] && typeof d[k] === 'object' ? d[k] : d) as Record<string, any>;
      switch (ev.type) {
        case 'EventStruct': {
          const x = rec('structure');
          if (typeof x.id !== 'string' || !x.id.startsWith('5-')) break;
          this.putStruct({ id: x.id, type: Number(x.type) || 0, owner: String(x.owner || ''), locationType: String(x.locationType || ''), locationId: String(x.locationId || ''), ambit: String(x.operatingAmbit || ''), slot: Number(x.slot) || 0 });
          changed = true;
          break;
        }
        case 'EventStructAttribute': { const r = rec('structAttributeRecord'); changed = this.putAttribute('struct', String(r.attributeId ?? ''), r.value) || changed; break; }
        case 'EventPlanetAttribute': { const r = rec('planetAttributeRecord'); changed = this.putAttribute('planet', String(r.attributeId ?? ''), r.value) || changed; break; }
        case 'EventGrid': { const r = rec('gridRecord'); changed = this.putAttribute('grid', String(r.attributeId ?? ''), r.value) || changed; break; }
      }
    }
    return this.count(changed);
  }

  private count(changed: boolean) { if (changed) this.applied++; return changed; }

  /** Row counts per store. (A destroyed struct lingers here, flagged, until the next walk prunes it.) */
  sizes() { return { structs: this.structs.size, structAttrs: this.sattrs.size, planetAttrs: this.pattrs.size, grid: this.grid.size }; }
}

/* ── Walks ──────────────────────────────────────────────────────────────── */

type Row = Record<string, any>;

/** A guild catalog route, walked by keyset (`after_id`): rows that change or vanish mid-walk can't
 * shift the pages under it the way an offset does. Ends on a page shorter than the first (the
 * server clamps `limit`). Throws on a walk cut short. */
async function walkGuild(api: GuildApi, path: string, onRows: (rows: Row[]) => void, q: Record<string, string | number> = {}): Promise<void> {
  let after = '', full = 0;
  for (let p = 0; p < 200; p++) {
    const res = await api.call<Row[]>(`${path}/page/1?${new URLSearchParams({ limit: '10000', ...Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])), ...(after ? { after_id: after } : {}) })}`);
    const rows = res.data || [];
    if (p === 0) full = rows.length;
    onRows(rows);
    if (!rows.length || rows.length < full) return;
    const last = rows[rows.length - 1]?.id;
    if (last == null || String(last) === after) throw new Error(`walk of ${path} could not advance`);
    after = String(last);
  }
  throw new Error(`walk of ${path} was cut short`);
}

export { walkGuild as __walkGuild };

/** An LCD store, walked by its own keys, 60,000 rows a page. */
async function walkLcd(store: string, field: string, onRows: (rows: Row[]) => void, startKey = ''): Promise<void> {
  let key = startKey;
  for (let p = 0; p < 100; p++) {
    const q = `pagination.limit=60000${key ? `&pagination.key=${encodeURIComponent(key)}` : ''}`;
    const r = await fetch(`${LCD_URL}/structs/${store}?${q}`, { signal: AbortSignal.timeout(90_000) });
    if (!r.ok) throw new Error(`LCD ${store} ${r.status}`);
    const body = await r.json() as Row;
    onRows((body[field] as Row[]) || []);
    key = body.pagination?.next_key || '';
    if (!key) return;
  }
  throw new Error(`walk of ${store} was cut short`);
}

const structRowOf = (r: Row): StructRow => ({
  id: String(r.id), type: Number(r.type) || 0, owner: String(r.owner || ''),
  locationType: String(r.location_type ?? r.locationType ?? ''), locationId: String(r.location_id ?? r.locationId ?? ''),
  ambit: String(r.operating_ambit ?? r.operatingAmbit ?? ''), slot: Number(r.slot) || 0,
});

async function fromGuild(api: GuildApi, snap: Snapshot) {
  snap.source = 'guild';
  await Promise.all([
    walkGuild(api, 'struct/list/all', (rows) => { for (const r of rows) if (!r.is_destroyed) snap.putStruct(structRowOf(r)); }, { is_destroyed: 0 }),
    // Keyed by the row's id (the chain's attribute id): the indexer leaves some names NULL.
    walkGuild(api, 'struct-attribute/all', (rows) => { for (const r of rows) snap.putAttribute('struct', String(r.id), r.val); }),
    walkGuild(api, 'planet-attribute/all', (rows) => { for (const r of rows) snap.putAttribute('planet', String(r.id), r.val); }),
    walkGuild(api, 'grid/all', (rows) => { for (const r of rows) snap.putAttribute('grid', String(r.id), r.val); }),
  ]);
}

async function fromLcd(snap: Snapshot) {
  snap.source = 'lcd';
  await Promise.all([
    walkLcd('struct', 'Struct', (rows) => { for (const r of rows) snap.putStruct(structRowOf(r)); }),
    // The attribute store must be entered at "0-": a walk from the very start runs out of query gas.
    walkLcd('struct_attribute', 'structAttributeRecords', (rows) => { for (const r of rows) snap.putAttribute('struct', String(r.attributeId), r.value); }, btoa('0-')),
    walkLcd('planet_attribute', 'planetAttributeRecords', (rows) => { for (const r of rows) snap.putAttribute('planet', String(r.attributeId), r.value); }),
    walkLcd('grid', 'gridRecords', (rows) => { for (const r of rows) snap.putAttribute('grid', String(r.attributeId), r.value); }),
  ]);
}

/** A walk that came back far smaller than the last one lost pages somewhere: keep the old copy. */
export function plausible(next: Snapshot, prev: Snapshot | null): boolean {
  const a = next.sizes();
  if (!a.structs || !a.structAttrs || !a.planetAttrs || !a.grid) return false;
  if (!prev) return true;
  const b = prev.sizes();
  return a.structs * 2 >= b.structs && a.structAttrs * 2 >= b.structAttrs && a.planetAttrs * 2 >= b.planetAttrs && a.grid * 2 >= b.grid;
}

/* ── The galaxy ─────────────────────────────────────────────────────────── */

const ENV = (import.meta as { env?: Record<string, string | undefined> }).env || {};

class Galaxy {
  snap: Snapshot | null = null;
  takenAt = 0;
  error = '';
  private walking: Promise<void> | null = null;
  private pending: Frame[] | null = null;
  private wantedUntil = 0;
  private listening = false;
  private listeners = new Set<() => void>();

  /** Off on a small device, or by VITE_GALAXY=off. */
  get enabled(): boolean {
    if (ENV.VITE_GALAXY === 'off') return false;
    const mem = typeof navigator !== 'undefined' ? (navigator as { deviceMemory?: number }).deviceMemory : undefined;
    return mem == null || mem >= 4;
  }

  /** Fresh enough to answer for the galaxy: walked lately, and a live feed patching it. */
  get ready(): boolean {
    return !!this.snap && Date.now() - this.takenAt < TRUST_MS && (live.state === 'live' || grass.state === 'live');
  }

  onChange(f: () => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }

  /** A screen needs galaxy-wide data: walk now if there's no copy, and keep it fresh for a while. */
  want(): Snapshot | null {
    if (!this.enabled) return null;
    this.wantedUntil = Date.now() + WANT_MS;
    this.listen();
    if (!this.snap && !this.walking) void this.refresh();
    return this.ready ? this.snap : null;
  }

  private listen() {
    if (this.listening) return;
    this.listening = true;
    // GRASS only where the app runs it (a devnet turns it off): subscribing would dial it.
    if (ENV.VITE_GRASS_URL !== 'off') grass.on(undefined, (e) => this.feed({ kind: 'grass', e, at: Date.now() }));
    live.onTx((tx) => this.feed({ kind: 'chain', tx, at: Date.now() }));
    if (typeof setInterval !== 'undefined') setInterval(() => {
      const visible = typeof document === 'undefined' || !document.hidden;
      if (visible && Date.now() < this.wantedUntil && Date.now() - this.takenAt >= REFRESH_MS) void this.refresh();
      // Nobody has asked for a while: let the memory go.
      if (this.snap && Date.now() > this.wantedUntil + REFRESH_MS) { this.snap = null; this.takenAt = 0; }
    }, 30_000);
  }

  private feed(f: Frame) {
    if (this.pending) { if (this.pending.length < PENDING_MAX) this.pending.push(f); }
    if (this.snap && apply(this.snap, f)) this.emit();
  }

  private emit() { safeEach(this.listeners, (f) => f()); }

  /** Walk the galaxy again (single flight). The guild's catalog with a session, else the LCD's
   * stores; a guild walk that fails or comes back implausible falls back to the LCD. */
  refresh(): Promise<void> {
    if (!this.walking) this.walking = this.walk().finally(() => { this.walking = null; });
    return this.walking;
  }

  private async walk() {
    this.pending = [];
    const begin = () => {
      const s = new Snapshot();
      s.takenAt = Date.now();
      s.minHeight = live.height || session.status.height || 0;
      return s;
    };
    let next: Snapshot | null = null;
    try {
      const api = session.api();
      if (api) {
        try {
          const s = begin();
          await fromGuild(api, s);
          if (plausible(s, this.snap)) next = s;
          else console.warn('[galaxy] the guild’s walk came back short; reading the LCD', s.sizes());
        } catch (e) { console.warn('[galaxy] guild walk failed; reading the LCD', e); }
      }
      if (!next) {
        const s = begin();
        await fromLcd(s);
        if (!plausible(s, this.snap)) throw new Error('the LCD walk came back short');
        next = s;
      }
      // What happened during the walk, onto the new copy, before anyone reads it.
      for (const f of this.pending || []) apply(next, f);
      this.snap = next;
      this.takenAt = next.takenAt;
      this.error = '';
      this.emit();
    } catch (e) {
      this.error = String((e as Error).message || e);
      console.warn('[galaxy] walk failed', e);
    } finally {
      this.pending = null;
    }
  }
}

function apply(s: Snapshot, f: Frame): boolean {
  return f.kind === 'grass' ? s.applyGrass(f.e) : s.applyChain(f.tx);
}

export const galaxy = new Galaxy();
