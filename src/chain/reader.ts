/* Reads that the guild's indexer answers better than the chain's LCD, with the LCD as fallback.
 *
 * The LCD answers one entity per call. A board of 30 structs is 30 reads, every few blocks, for
 * every player in view. The Guild API (Postgres, kept current by the guild's indexer within about a
 * second of each block) answers "every struct this player owns, with health, status and defenders"
 * in one call, the proof-of-work clocks in another, and a whole grid attribute across every reactor
 * or substation in one more. Those are the reads that move here.
 *
 * Single-entity reads where the LCD already returns exactly the composite the screens use (a player
 * with its grid and inventory, a planet with its slot map and attributes, a fleet) stay on the LCD:
 * the Guild API would take several calls to rebuild each.
 *
 * Only with an open guild session (src/guild/session.ts), and only once the guild has indexed the
 * block the caller needs. The guild's GRASS heartbeat is sent after each block is committed to its
 * database, so a GRASS height at or past `minHeight` means the rows are there. A guild that lags,
 * errs or answers 401 costs one fallback to the LCD, never a wrong board. Shapes are the LCD's, so
 * nothing downstream knows which source answered. */
import { lcd, type StructFull, type Grid } from './lcd';
import { live } from './live';
import { session } from '../guild/session';
import { grass } from '../grass/grass';
import { idIndex, sleep } from '../core/util';
import { galaxy, PLANET_ATTRS } from './galaxy';
import type { GuildApi, StructRow, WorkRow } from '../guild/api';

/** How long a read waits for the guild to index the block it needs before asking the LCD. */
const WAIT_MS = 3000;

/** The guild indexer's height as this tab knows it: its GRASS heartbeat when GRASS is dialled to
 * the same guild, else the session's last probe. */
export function indexedHeight(): number {
  const g = session.status.guildId;
  const viaGrass = g && grass.guildId === g && grass.state === 'live' ? grass.height : 0;
  return Math.max(viaGrass, session.status.height);
}

/** After the guild fell behind, reads go straight to the LCD until then (no wait per read). */
let lagUntil = 0;
const LAG_PAUSE_MS = 30_000;

/** The session's Guild API once its indexer has reached `minHeight` (default: the chain tip this
 * tab has seen), else null. Waits up to WAIT_MS. Without GRASS on the session's guild to vouch
 * for it, the guild is asked how far it got (at most once a second, shared by every read). */
export async function guildAt(minHeight = live.height): Promise<GuildApi | null> {
  const api = session.api();
  if (!api) return null;
  if (!minHeight || indexedHeight() >= minHeight) return api;
  if (Date.now() < lagUntil) return null;
  const vouched = () => grass.guildId === session.status.guildId && grass.state === 'live';
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    if (!vouched()) await session.probeHeight().catch(() => 0);
    if (!session.open) return null;
    if (indexedHeight() >= minHeight) return session.api();
    await sleep(250);
  }
  if (indexedHeight() >= minHeight) return session.api();
  lagUntil = Date.now() + LAG_PAUSE_MS;
  return null;
}

/* ── Structs ────────────────────────────────────────────────────────────── */

const s = (v: unknown) => (v == null ? '0' : String(v));

/** `defending_struct_ids` is jsonb: an array, or its JSON text. */
function idList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.startsWith('[')) { try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } }
  return [];
}

/** One Guild API struct row (+ the owner's proof-of-work clocks) in the LCD's StructFull shape. */
export function structFromRow(r: StructRow, work: WorkRow[] = []): StructFull {
  const st = Number(r.status) || 0;
  const clock = (cat: WorkRow['category']) => s(work.find((w) => w.object_id === r.id && w.category === cat)?.block_start ?? 0);
  return {
    Struct: {
      id: r.id, index: s(r.index), type: s(r.type), creator: r.creator, owner: r.owner,
      locationType: r.location_type, locationId: r.location_id, operatingAmbit: r.operating_ambit, slot: s(r.slot),
    },
    structAttributes: {
      health: s(r.health), status: String(st),
      // The guild keeps a clock only while it runs (api_work): building, mining, refining.
      blockStartBuild: clock('BUILD'),
      ...({ blockStartOreMine: clock('MINE'), blockStartOreRefine: clock('REFINE') } as object),
      protectedStructIndex: r.protected_struct_id ? String(idIndex(r.protected_struct_id)) : '0',
      isMaterialized: !!(st & 1), isBuilt: !!(st & 2), isOnline: !!(st & 4), isHidden: !!(st & 16), isDestroyed: !!(st & 32) || !!r.is_destroyed, isLocked: !!(st & 64),
    },
    gridAttributes: { fuel: s(r.fuel) },
    structDefenders: idList(r.defending_struct_ids),
  };
}

/** The chain's guard links, all of them: the per-player struct route reports a link only while the
 * two structs stand together, but the link stays on chain (and "Stop guarding" needs it) when a
 * fleet sails off. One read per indexed block, shared. */
let links: { height: number; at: number; p: Promise<Map<string, string>> } | null = null;
function guardLinks(api: GuildApi): Promise<Map<string, string>> {
  const h = indexedHeight();
  if (!links || links.height !== h || Date.now() - links.at > 60_000) {
    const p = api.all<{ defending_struct_id: string; protected_struct_id: string }>('struct-defender/all', { limit: 10_000 }, 100_000)
      .then((rows) => new Map(rows.map((r) => [r.defending_struct_id, r.protected_struct_id])));
    links = { height: h, at: Date.now(), p };
    p.catch(() => { if (links?.p === p) links = null; });
  }
  return links.p;
}

/** Every struct of these owners, by id, from one guild (two calls per owner, plus the guard links). */
async function ownersFrom(api: GuildApi, owners: string[]): Promise<Map<string, StructFull>> {
  const out = new Map<string, StructFull>();
  const guards = guardLinks(api);
  await Promise.all(owners.map(async (o) => {
    // A failed clock read fails the lot (to the LCD): structs without their clocks would drop proofs.
    const [rows, work] = await Promise.all([api.structsOf(o), api.workOf(o)]);
    for (const r of rows || []) out.set(r.id, structFromRow(r, work || []));
  }));
  // The chain's links, wherever the structs stand.
  const g = await guards;
  const defenders = new Map<string, string[]>();
  for (const [d, p] of g) { const l = defenders.get(p) ?? []; l.push(d); defenders.set(p, l); }
  for (const x of out.values()) {
    const prot = g.get(x.Struct.id);
    x.structAttributes!.protectedStructIndex = prot ? String(idIndex(prot)) : '0';
    x.structDefenders = (defenders.get(x.Struct.id) ?? []).sort((a, b) => idIndex(a) - idIndex(b));
  }
  return out;
}

async function lcdStructs(ids: string[], into = new Map<string, StructFull>()): Promise<Map<string, StructFull>> {
  for (let i = 0; i < ids.length; i += 8) {
    const chunk = await Promise.all(ids.slice(i, i + 8).map((id) => lcd.struct(id).catch(() => null)));
    for (const x of chunk) if (x) into.set(x.Struct.id, x);
  }
  return into;
}

/** These structs (owned by these players), current to `minHeight`. From the galaxy snapshot when
 * it holds them all (src/chain/galaxy.ts; not with `fresh`, which your own empire asks for: its
 * proofs need exact clocks); else from the guild in one call per owner; anything the guild hasn't
 * got (or everything, without a session) from the LCD. */
export async function structsByIds(ids: Iterable<string>, owners: Iterable<string>, minHeight = live.height, opts: { fresh?: boolean } = {}): Promise<Map<string, StructFull>> {
  const want = [...new Set([...ids].filter(Boolean))];
  if (!want.length) return new Map();
  const snap = opts.fresh ? null : galaxy.want();
  if (snap && want.every((id) => snap.structs.has(id))) {
    reads.snapshot++;
    return new Map(want.map((id) => [id, snap.structFull(id)!]));
  }
  const who = [...new Set([...owners].filter(Boolean))];
  const api = who.length ? await guildAt(minHeight) : null;
  if (api) {
    try {
      const all = await ownersFrom(api, who);
      const out = new Map<string, StructFull>();
      const missing: string[] = [];
      for (const id of want) { const x = all.get(id); if (x) out.set(id, x); else missing.push(id); }
      reads.guild++;
      if (missing.length) { reads.lcdStructs += missing.length; await lcdStructs(missing, out); }
      return out;
    } catch (e) {
      console.warn('[reader] guild structs failed, using the LCD', e);
    }
  }
  reads.lcdStructs += want.length;
  return lcdStructs(want);
}

/* ── Grid attributes in bulk ────────────────────────────────────────────── */

/** Grid attribute names as the guild stores them (`structs.grid.attribute_type`). */
type GridField = keyof Grid;
/** Object type names → the id's leading digit. */
const OBJECT_TYPES: Record<string, number> = { guild: 0, player: 1, planet: 2, reactor: 3, substation: 4, struct: 5, allocation: 6, infusion: 7, address: 8, fleet: 9, provider: 10, agreement: 11 };

/** Grid attributes for every object of a type, as LCD-shaped Grid records keyed by object id:
 * one paged Guild API read per attribute instead of one LCD read per object. Null without a
 * session (or on any error): the caller reads per entity from the LCD as before. */
export async function gridsOfType(objectType: string, fields: GridField[], minHeight = live.height - 1): Promise<Map<string, Grid> | null> {
  const snap = galaxy.want();
  const digit = OBJECT_TYPES[objectType];
  if (snap && digit != null) {
    reads.snapshot++;
    const out = new Map<string, Grid>();
    const prefix = digit + '-';
    for (const id of snap.grid.keys()) if (id.startsWith(prefix)) out.set(id, snap.gridOf(id));
    return out;
  }
  const api = await guildAt(minHeight);
  if (!api) return null;
  try {
    const out = new Map<string, Grid>();
    await Promise.all(fields.map(async (f) => {
      // Ordered by id, which never moves (the default orders by last update, which shifts rows
      // between pages while values change); big pages, so it's usually one.
      const rows = await api.all<{ object_id: string; val: unknown }>(`grid/attribute-type/${encodeURIComponent(f)}/object-type/${encodeURIComponent(objectType)}`, { limit: 10_000, order: 'id.asc' }, 100_000);
      for (const r of rows) {
        const g = out.get(r.object_id) ?? {};
        (g as Record<string, string>)[f] = s(r.val).split('.')[0];
        out.set(r.object_id, g);
      }
    }));
    reads.guild++;
    return out;
  } catch (e) {
    console.warn('[reader] guild grid failed, using the LCD', e);
    return null;
  }
}

/** Every listed object's grid from a guild bulk read, each field present (the guild deletes a value
 * that drops to zero; the LCD reports it as "0"), or null to read them per entity from the LCD. */
export async function gridsFor(objectType: string, ids: string[], fields: GridField[]): Promise<Map<string, Grid> | null> {
  if (!ids.length) return new Map();
  const m = await gridsOfType(objectType, fields);
  if (!m) return null;
  const out = new Map<string, Grid>();
  for (const id of ids) {
    const g: Record<string, string> = { ...(m.get(id) || {}) };
    for (const f of fields) g[f] ??= '0';
    out.set(id, g as Grid);
  }
  return out;
}

/** Planet attributes of one type across every planet (shield, raid clock…), keyed by planet id. */
export async function planetAttributeAll(attribute: string, minHeight = live.height - 1): Promise<Map<string, string> | null> {
  const snap = galaxy.want();
  const i = (PLANET_ATTRS as readonly string[]).indexOf(attribute);
  if (snap && i >= 0) {
    reads.snapshot++;
    const out = new Map<string, string>();
    for (const [id, a] of snap.pattrs) if (a[i]) out.set(id, String(a[i]));
    return out;
  }
  const api = await guildAt(minHeight);
  if (!api) return null;
  try {
    // This route only orders by last update: one big page covers today's galaxy; past that, a value
    // that changes between pages can be missed (it reads as 0 until the next read).
    const rows = await api.all<{ object_id: string; val: unknown }>(`planet-attribute/type/${encodeURIComponent(attribute)}`, { limit: 10_000 }, 200_000);
    reads.guild++;
    return new Map(rows.map((r) => [r.object_id, s(r.val).split('.')[0]]));
  } catch (e) {
    console.warn('[reader] guild planet attributes failed, using the LCD', e);
    return null;
  }
}

/** Where reads went this visit (shown to experts in Ops, and handy in the console). */
export const reads = { snapshot: 0, guild: 0, lcdStructs: 0 };
