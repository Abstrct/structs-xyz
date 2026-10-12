/* GRASS: the guild stack's real-time feed (Postgres NOTIFY → NATS → WebSocket). Public, no
 * auth, CORS-free. It carries decoded game state as it changes: grid attributes (ore,
 * power, lastAction…), planet activity (struct status/health diffs, raids, fleet moves,
 * shields), players, guilds, ledger rows, and a `consensus` block heartbeat.
 *
 * One connection per tab: `structs.>` and `consensus` on the active guild's server (the
 * commander's guild by default). Every guild's indexer sees the whole chain, so any guild's
 * GRASS shows the whole galaxy; the choice is about whose infrastructure you lean on. */
import { NatsWs, type NatsMsg, type NatsState } from './nats';
import { DEFAULT_GUILD, FALLBACK_GRASS, homeGuild, servicesFor } from '../guild/directory';
import { cache } from '../cache/idb';

export type GrassKind = 'block' | 'grid' | 'planet' | 'player' | 'guild' | 'inventory' | 'address' | 'provider' | 'agreement' | 'other';

export interface GrassEvent {
  subject: string;
  category: string;
  kind: GrassKind;
  /** When this tab received it (ms). */
  at: number;
  /** The payload was too big for pg_notify: ids only, re-read the rest. */
  stub: boolean;
  /** The whole payload as sent. */
  data: Record<string, any>;
  /** `data.detail` as an object (planet activity), else {}. */
  detail: Record<string, any>;
  playerId?: string;
  planetId?: string;
  objectId?: string;
  guildId?: string;
  height?: number;
  /** Per-planet activity sequence. */
  seq?: number;
  /** Monotonic id within this tab. */
  n: number;
}

export type GrassFilter = string | { subject?: string; category?: string | string[]; kind?: GrassKind | GrassKind[] };
export type GrassState = 'idle' | 'connecting' | 'live' | 'down';

const dec = new TextDecoder();
let counter = 0;
const str = (v: unknown) => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);

/** One NATS message → a GrassEvent; null for anything that isn't a GRASS payload. */
export function parseGrass(subject: string, payload: Uint8Array | string, at = Date.now()): GrassEvent | null {
  let data: any;
  try { data = JSON.parse(typeof payload === 'string' ? payload : dec.decode(payload)); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const category = str(data.category);
  if (!category) return null;
  const subj = str(data.subject) || subject;
  const parts = subj.split('.');
  const kind: GrassKind = subj === 'consensus' ? 'block'
    : parts[0] === 'structs' && ['grid', 'planet', 'player', 'guild', 'inventory', 'address', 'provider', 'agreement'].includes(parts[1]) ? parts[1] as GrassKind : 'other';
  let detail: any = data.detail;
  if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch { detail = {}; } }
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) detail = {};
  const e: GrassEvent = {
    subject: subj, category, kind, at, data, detail,
    stub: data.stub === true || data.stub === 'true',
    n: ++counter,
  };
  // Who and where, from the payload first, then from the subject's tokens.
  switch (kind) {
    case 'block': e.height = Number(data.height) || undefined; break;
    case 'grid': // structs.grid.{object_type}.{object_id}.{owner|noPlayer}
      e.objectId = str(data.object_id) || parts[3];
      e.playerId = str(data.player_id) || (parts[4] && parts[4] !== 'noPlayer' ? parts[4] : undefined);
      if (e.objectId?.startsWith('2-')) e.planetId = e.objectId;
      break;
    case 'planet': // structs.planet.{planet_id}.{owner|noPlayer}
      e.planetId = str(data.planet_id) || parts[2];
      e.playerId = str(data.player_id) || (parts[3] && parts[3] !== 'noPlayer' ? parts[3] : undefined);
      e.seq = Number(data.seq) || undefined;
      e.height = Number(data.block_height) || undefined;
      e.objectId = str(detail.struct_id) || str(detail.fleet_id);
      break;
    case 'player': // structs.player.{guild_id}.{player_id}
      e.guildId = str(data.guild_id) || parts[2];
      e.playerId = str(data.player_id) || (category === 'player_consensus' ? str(data.id) : undefined) || parts[3];
      e.planetId = str(data.planet_id);
      break;
    case 'guild': e.guildId = str(data.guild_id) || (category === 'guild_consensus' || category === 'guild_meta' ? str(data.id) : undefined) || parts[2]; e.playerId = str(data.player_id); break;
    case 'inventory': // structs.inventory.{denom}.{guild|noGuild}.{player|noPlayer}.{address}
      e.playerId = str(data.player_id) || (parts[4] && parts[4] !== 'noPlayer' ? parts[4] : undefined);
      e.guildId = str(data.guild_id) || (parts[3] && parts[3] !== 'noGuild' ? parts[3] : undefined);
      e.height = Number(data.block_height) || undefined;
      break;
    default: e.playerId = str(data.player_id); break;
  }
  return e;
}

/** NATS-style subject match: `*` one token, `>` the rest; a pattern without wildcards is a prefix. */
export function subjectMatches(pattern: string, subject: string): boolean {
  if (!pattern.includes('*') && !pattern.endsWith('>')) return subject.startsWith(pattern);
  const p = pattern.split('.'), s = subject.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== '*' && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

export function grassMatches(f: GrassFilter | undefined, e: GrassEvent): boolean {
  if (!f) return true;
  if (typeof f === 'string') return subjectMatches(f, e.subject);
  if (f.subject && !subjectMatches(f.subject, e.subject)) return false;
  if (f.category && !(Array.isArray(f.category) ? f.category.includes(e.category) : f.category === e.category)) return false;
  if (f.kind && !(Array.isArray(f.kind) ? f.kind.includes(e.kind) : f.kind === e.kind)) return false;
  return true;
}

/* ── The block tip ──────────────────────────────────────────────────────── */

/** A height further ahead of the tip than this is not a block, it's a bad payload. */
export const MAX_LEAP = 10_000;
/** This many refused heights in a row and the feed's count wins: it was the tip that was wrong. */
export const RESYNC_AFTER = 5;

/** Whether a consensus height moves the tip. Forward only, by a plausible amount; a bogus huge
 * height would otherwise wedge the tip above every real block. `refused` counts heights turned
 * away in a row, so a wrong tip (or a server that went back) heals itself. */
export function nextTip(tip: number, height: number | undefined, refused: number): { tip: number; refused: number; advanced: boolean; resync: boolean } {
  if (!height || !Number.isFinite(height) || height <= 0) return { tip, refused, advanced: false, resync: false };
  if (!tip || (height > tip && height - tip <= MAX_LEAP)) return { tip: height, refused: 0, advanced: true, resync: false };
  if (height === tip) return { tip, refused: 0, advanced: false, resync: false };
  if (refused + 1 >= RESYNC_AFTER) return { tip: height, refused: 0, advanced: true, resync: true };
  return { tip, refused: refused + 1, advanced: false, resync: false };
}

/* ── A fixed ring ───────────────────────────────────────────────────────── */

export class Ring<T> {
  private a: (T | undefined)[];
  private head = 0;
  size = 0;
  constructor(readonly cap: number) { this.a = new Array(cap); }
  push(v: T) { this.a[(this.head + this.size) % this.cap] = v; if (this.size < this.cap) this.size++; else this.head = (this.head + 1) % this.cap; }
  /** Oldest first. */
  toArray(): T[] { const out: T[] = []; for (let i = 0; i < this.size; i++) out.push(this.a[(this.head + i) % this.cap] as T); return out; }
  last(): T | undefined { return this.size ? this.a[(this.head + this.size - 1) % this.cap] : undefined; }
  clear() { this.a = new Array(this.cap); this.head = 0; this.size = 0; }
}

/* ── The singleton ──────────────────────────────────────────────────────── */

const PREF = 'structs.grass.guild';
/** How much of the feed is kept across reloads (charge ticks excluded: they'd crowd out the news). */
const KEEP = 400;
const STALE_MS = 60_000;
const MINUTES = 60;

class Grass {
  state: GrassState = 'idle';
  /** Latest block height heard on `consensus`. */
  height = 0;
  /** When a consensus heartbeat last arrived (whatever its height): the feed's pulse. */
  lastBlockAt = 0;
  private refused = 0;
  /** The guild whose server we're on, and its URL. */
  guildId: string | null = null;
  url: string | null = null;
  /** Set when the chosen guild's server never answered and this tab fell back to the default one. */
  failedOver: { guildId: string; url: string } | null = null;
  /** Messages received since the page loaded (all kinds, blocks included). */
  received = 0;
  /** The last 2000 non-block events, oldest first via recent(). */
  readonly ring = new Ring<GrassEvent>(2000);
  /** (height, receivedAt) of recent blocks, for block-time charts. */
  readonly blocks = new Ring<{ height: number; at: number }>(240);
  private conn: NatsWs | null = null;
  private listeners = new Set<{ f?: GrassFilter; fn: (e: GrassEvent) => void }>();
  private stateL = new Set<(s: GrassState) => void>();
  private blockL = new Set<(height: number) => void>();
  private connectedAt = 0;
  /** When this tab first dialled GRASS: per-minute series start here, not before. */
  startedAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private woken = false;
  private starting: Promise<void> | null = null;
  private earlierP: Promise<GrassEvent[]> | null = null;
  private dirty = false;
  /** Per-category message counts in one-minute buckets: minute → category → count. */
  private tallies = new Map<number, Map<string, number>>();

  /** Hear events matching a filter. Starts the connection on first use. */
  on(filter: GrassFilter | undefined, fn: (e: GrassEvent) => void): () => void {
    const l = { f: filter, fn };
    this.listeners.add(l);
    void this.start();
    return () => { this.listeners.delete(l); };
  }

  onState(fn: (s: GrassState) => void): () => void { this.stateL.add(fn); fn(this.state); return () => { this.stateL.delete(fn); }; }
  onBlock(fn: (height: number) => void): () => void { this.blockL.add(fn); void this.start(); return () => { this.blockL.delete(fn); }; }

  /** Recent events (newest last), optionally filtered. */
  recent(filter?: GrassFilter, limit = 2000): GrassEvent[] {
    const all = this.ring.toArray();
    const out = filter ? all.filter((e) => grassMatches(filter, e)) : all;
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  /** Counts per minute (oldest first) for one category, a set, or all: the last `minutes`, or fewer
   * if this tab has listened for less. */
  perMinute(category?: string | string[], minutes = 30): number[] {
    const now = Math.floor(Date.now() / 60000);
    const first = Math.max(now - minutes + 1, this.startedAt ? Math.floor(this.startedAt / 60000) : now);
    const cats = category == null ? null : Array.isArray(category) ? category : [category];
    const out: number[] = [];
    for (let m = first; m <= now; m++) {
      const t = this.tallies.get(m);
      let n = 0;
      if (t) for (const [c, k] of t) if (!cats || cats.includes(c)) n += k;
      out.push(n);
    }
    return out;
  }

  /** Categories seen in the last `minutes`, busiest first. */
  categories(minutes = MINUTES): { category: string; count: number }[] {
    const from = Math.floor(Date.now() / 60000) - minutes;
    const sum = new Map<string, number>();
    for (const [m, t] of this.tallies) if (m > from) for (const [c, k] of t) sum.set(c, (sum.get(c) || 0) + k);
    return [...sum].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
  }

  /** Events kept from earlier visits (newest last), read once before this session saves over them. */
  earlier(): Promise<GrassEvent[]> {
    if (!this.earlierP) {
      this.earlierP = cache.get<GrassEvent[]>('ring', 'grass').then((v) => (Array.isArray(v) ? v : []), () => []);
      // Only start saving once the old copy is in hand.
      void this.earlierP.then(() => {
        if (typeof window === 'undefined') return;
        setInterval(() => this.persist(), 15_000);
        window.addEventListener('pagehide', () => this.persist());
      });
    }
    return this.earlierP;
  }

  private persist() {
    if (!this.dirty) return;
    this.dirty = false;
    const keep = this.ring.toArray().filter((e) => e.category !== 'lastAction').slice(-KEEP);
    void cache.set('ring', keep, 86_400_000, 'grass');
  }

  start(): Promise<void> {
    if (this.conn || typeof window === 'undefined') return Promise.resolve();
    void this.earlier();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const { guildId, url } = await this.resolve(this.preferred());
      // A switchGuild() may have dialled while we were resolving: theirs stands.
      if (!this.conn) this.dial(guildId, url);
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  stop() {
    this.conn?.close();
    this.conn = null;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    this.setState('idle');
  }

  /** Move to another guild's GRASS server (remembered for next time). Null forgets the choice. */
  async switchGuild(id: string | null) {
    try { if (id) localStorage.setItem(PREF, id); else localStorage.removeItem(PREF); } catch { /* ignore */ }
    if (this.starting) await this.starting.catch(() => { /* resolved below anyway */ });
    const { guildId, url } = await this.resolve(id);
    this.failedOver = null;
    if (this.conn && url === this.url) { this.guildId = guildId; this.emitState(); return; }
    this.conn?.close();
    this.conn = null;
    this.dial(guildId, url);
  }

  /** The stored choice, if any. */
  preferred(): string | null { try { return localStorage.getItem(PREF); } catch { return null; } }

  private async resolve(want: string | null): Promise<{ guildId: string; url: string }> {
    const g = want || (await homeGuild().catch(() => null)) || DEFAULT_GUILD;
    const s = await servicesFor(g).catch(() => null);
    if (s?.grass) return { guildId: g, url: s.grass };
    if (g !== DEFAULT_GUILD) {
      const d = await servicesFor(DEFAULT_GUILD).catch(() => null);
      return { guildId: DEFAULT_GUILD, url: d?.grass || FALLBACK_GRASS };
    }
    return { guildId: DEFAULT_GUILD, url: FALLBACK_GRASS };
  }

  private dial(guildId: string, url: string) {
    if (!this.startedAt) this.startedAt = Date.now();
    this.guildId = guildId;
    this.url = url;
    // A new server counts its own blocks: it may be a few behind the last one.
    this.height = 0;
    this.refused = 0;
    this.lastBlockAt = 0;
    this.blocks.clear();
    const conn = new NatsWs({ url, name: 'structs-xyz' });
    this.conn = conn;
    // A guild's server that never comes up (a bad certificate, a dead port) shouldn't leave the
    // tab without a feed: after a few failed dials, lean on the default guild's server instead.
    let everLive = false, downs = 0;
    conn.onState((s: NatsState) => {
      if (this.conn !== conn) return;
      if (s === 'live') { this.connectedAt = Date.now(); everLive = true; }
      if (s === 'down' && !everLive && ++downs >= 3 && guildId !== DEFAULT_GUILD) { void this.failOver(guildId, url); return; }
      this.setState(s === 'live' ? 'live' : s === 'connecting' ? 'connecting' : s === 'closed' ? 'idle' : 'down');
    });
    conn.subscribe('structs.>', (m) => this.ingest(m));
    conn.subscribe('consensus', (m) => this.ingest(m));
    conn.connect();
    if (!this.watchdog) this.watchdog = setInterval(() => this.checkStale(), 15_000);
    if (!this.woken) {
      this.woken = true;
      const wake = () => { if (document.visibilityState !== 'hidden') this.checkStale(); };
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('online', wake);
      window.addEventListener('focus', wake);
    }
  }

  private async failOver(guildId: string, url: string) {
    const d = await servicesFor(DEFAULT_GUILD).catch(() => null);
    const next = d?.grass || FALLBACK_GRASS;
    if (next === url || this.url !== url) return;
    console.warn(`[grass] ${url} never answered; using ${next}`);
    this.conn?.close();
    this.conn = null;
    this.dial(DEFAULT_GUILD, next);
    this.failedOver = { guildId, url };
    this.emitState();
  }

  /** No block heartbeat for a minute on an open link: the feed is stale, dial again. */
  private checkStale() {
    const c = this.conn;
    if (!c || c.state !== 'live') return;
    if (Date.now() - Math.max(this.lastBlockAt, this.connectedAt) > STALE_MS) {
      console.warn('[grass] no consensus for 60 s, reconnecting');
      c.restart();
    }
  }

  private ingest(m: NatsMsg) {
    this.received++;
    const e = parseGrass(m.subject, m.payload);
    if (!e) return;
    this.tally(e.category);
    if (e.kind === 'block') {
      // Any heartbeat proves the link alive, even one whose height we don't believe.
      this.lastBlockAt = e.at;
      const t = nextTip(this.height, e.height, this.refused);
      this.refused = t.refused;
      if (t.advanced) {
        if (t.resync) { console.warn(`[grass] block tip resynced ${this.height} → ${t.tip}`); this.blocks.clear(); }
        this.height = t.tip;
        this.blocks.push({ height: t.tip, at: e.at });
        for (const f of this.blockL) { try { f(t.tip); } catch (err) { console.error(err); } }
      }
    } else { this.ring.push(e); this.dirty = true; }
    for (const l of this.listeners) {
      if (!grassMatches(l.f, e)) continue;
      try { l.fn(e); } catch (err) { console.error(err); }
    }
  }

  private tally(category: string) {
    const m = Math.floor(Date.now() / 60000);
    let t = this.tallies.get(m);
    if (!t) {
      t = new Map();
      this.tallies.set(m, t);
      for (const k of this.tallies.keys()) if (k < m - MINUTES) this.tallies.delete(k);
    }
    t.set(category, (t.get(category) || 0) + 1);
  }

  private setState(s: GrassState) {
    if (s === this.state) return;
    this.state = s;
    this.emitState();
  }
  private emitState() { for (const f of this.stateL) { try { f(this.state); } catch (e) { console.error(e); } } }
}

export const grass = new Grass();
