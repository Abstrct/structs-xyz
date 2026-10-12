/* A key/value cache that survives reloads: IndexedDB behind a memory front, with TTLs,
 * namespaces and a size cap (least recently used goes first). When IndexedDB is missing or
 * refused (private windows, blocked storage, Node tests) it quietly stays in memory.
 * Values must be structured-cloneable. Everything cached is "last known", never live.
 *
 * Each value row has a small twin in `meta` (key, namespace, expiry, last hit, size), so a
 * prune walks the twins and never deserialises a value. Read hits are noted in memory and
 * written to `meta` in batches (and before every prune), so the LRU sees reads without a
 * write per read. */

export interface CacheEntry<T = unknown> { k: string; ns: string; v: T; at: number; exp: number; size: number; hit: number }
type Meta = Pick<CacheEntry, 'k' | 'ns' | 'exp' | 'hit' | 'size'>;

const DB = 'structs-xyz-cache';
const VERSION = 2;
const STORE = 'kv';
const META = 'meta';
const MAX_ENTRIES = 3000;
const MAX_BYTES = 40 * 1024 * 1024;
/** Memory-only mode keeps a far smaller set. */
const MEM_MAX_ENTRIES = 600;

let dbP: Promise<IDBDatabase | null> | null = null;
/** Whether IndexedDB opened (memory-only mode has no LRU on disk to feed). */
let onDisk = false;
const mem = new Map<string, CacheEntry>();
let memBytes = 0;
let writesSincePrune = 0;
/** Read hits not yet on disk: key → when (oldest first). */
const hits = new Map<string, number>();
let hitTimer: ReturnType<typeof setTimeout> | null = null;
const HIT_FLUSH_MS = 30_000;

const metaOf = (e: CacheEntry): Meta => ({ k: e.k, ns: e.ns, exp: e.exp, hit: e.hit, size: e.size || 0 });

function openDb(): Promise<IDBDatabase | null> {
  if (dbP) return dbP;
  dbP = new Promise<IDBDatabase | null>((resolve) => {
    let idb: IDBFactory | undefined;
    try { idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB; } catch { idb = undefined; }
    if (!idb) { resolve(null); return; }
    // A blocked or hung open must not stall every reader: give up after 3 s and stay in memory.
    const t = setTimeout(() => resolve(null), 3000);
    try {
      const req = idb.open(DB, VERSION);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        const up = req.transaction!;
        const kv = db.objectStoreNames.contains(STORE) ? up.objectStore(STORE) : db.createObjectStore(STORE, { keyPath: 'k' });
        if (!kv.indexNames.contains('ns')) kv.createIndex('ns', 'ns');
        // v1 kept recency on the value rows; it lives in `meta` now.
        if (kv.indexNames.contains('hit')) kv.deleteIndex('hit');
        if (!db.objectStoreNames.contains(META)) {
          const meta = db.createObjectStore(META, { keyPath: 'k' });
          meta.createIndex('ns', 'ns');
          // A v1 database: give every value its twin, once, inside the upgrade.
          if (ev.oldVersion > 0) {
            const c = kv.openCursor();
            c.onsuccess = () => {
              const cur = c.result;
              if (!cur) return;
              const e = cur.value as CacheEntry;
              if (e && typeof e.k === 'string') meta.put(metaOf(e));
              cur.continue();
            };
          }
        }
      };
      req.onsuccess = () => {
        clearTimeout(t);
        const db = req.result;
        db.onversionchange = () => { db.close(); onDisk = false; dbP = Promise.resolve(null); };
        onDisk = true;
        resolve(db);
      };
      req.onerror = () => { clearTimeout(t); resolve(null); };
      req.onblocked = () => { clearTimeout(t); resolve(null); };
    } catch { clearTimeout(t); resolve(null); }
  });
  return dbP;
}

/** One transaction; resolves with `run`'s request result once it commits (undefined on failure). */
function tx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(stores, mode);
      const r = run(t);
      t.oncomplete = () => resolve(r ? r.result : undefined);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

/** A rough byte size, for the cap. JSON length is close enough and cheap for our rows. */
function sizeOf(v: unknown): number {
  try { return (JSON.stringify(v) ?? '').length * 2; } catch { return 1024; }
}

function remember(e: CacheEntry) {
  const old = mem.get(e.k);
  if (old) memBytes -= old.size;
  mem.delete(e.k);              // re-insert so Map order tracks recency
  mem.set(e.k, e);
  memBytes += e.size;
  // The memory front is only a front: keep it small whatever the backing store holds.
  while (mem.size > MEM_MAX_ENTRIES || memBytes > MAX_BYTES / 4) {
    const first = mem.keys().next().value as string | undefined;
    if (first === undefined) break;
    memBytes -= mem.get(first)!.size;
    mem.delete(first);
  }
}

function noteHit(k: string, at: number) {
  if (!onDisk) return;
  hits.delete(k);
  hits.set(k, at);
  if (hits.size > MAX_ENTRIES) hits.delete(hits.keys().next().value as string);
  if (!hitTimer) hitTimer = setTimeout(() => { hitTimer = null; void flushHits(); }, HIT_FLUSH_MS);
}

/** Write the noted read hits onto their `meta` twins (only those rows). */
async function flushHits(): Promise<void> {
  if (!hits.size) return;
  const db = await openDb();
  if (!db) { hits.clear(); return; }
  const pending = [...hits];
  hits.clear();
  await tx(db, [META], 'readwrite', (t) => {
    const meta = t.objectStore(META);
    for (const [k, at] of pending) {
      const g = meta.get(k);
      g.onsuccess = () => { const r = g.result as Meta | undefined; if (r && at > r.hit) { r.hit = at; meta.put(r); } };
    }
  });
}

function forget(k: string) {
  const m = mem.get(k);
  if (m) { memBytes -= m.size; mem.delete(k); }
  hits.delete(k);
}

const full = (ns: string, key: string) => ns + '\u0000' + key;

export const cache = {
  /** The entry (even an expired one: callers decide whether stale is useful), or null. */
  async entry<T>(key: string, ns = 'default'): Promise<CacheEntry<T> | null> {
    const k = full(ns, key);
    const now = Date.now();
    const m = mem.get(k);
    if (m) { m.hit = now; noteHit(k, now); remember(m); return m as CacheEntry<T>; }
    const db = await openDb();
    if (!db) return null;
    const row = await tx<CacheEntry<T>>(db, [STORE], 'readonly', (t) => t.objectStore(STORE).get(k) as IDBRequest<CacheEntry<T>>);
    if (!row) return null;
    row.hit = now;
    noteHit(k, now);
    remember(row);
    return row;
  },

  /** A fresh value or undefined. */
  async get<T>(key: string, ns = 'default'): Promise<T | undefined> {
    const e = await cache.entry<T>(key, ns);
    return e && e.exp > Date.now() ? e.v : undefined;
  },

  async set<T>(key: string, value: T, ttlMs: number, ns = 'default'): Promise<void> {
    const now = Date.now();
    const e: CacheEntry<T> = { k: full(ns, key), ns, v: value, at: now, exp: now + ttlMs, size: sizeOf(value), hit: now };
    remember(e);
    hits.delete(e.k);
    const db = await openDb();
    if (!db) return;
    await tx(db, [STORE, META], 'readwrite', (t) => { t.objectStore(STORE).put(e); t.objectStore(META).put(metaOf(e)); });
    if (++writesSincePrune >= 25) { writesSincePrune = 0; void cache.prune(); }
  },

  async del(key: string, ns = 'default'): Promise<void> {
    const k = full(ns, key);
    forget(k);
    const db = await openDb();
    if (db) await tx(db, [STORE, META], 'readwrite', (t) => { t.objectStore(STORE).delete(k); t.objectStore(META).delete(k); });
  },

  /** Drop a namespace (or everything). */
  async clear(ns?: string): Promise<void> {
    for (const [k, e] of mem) if (!ns || e.ns === ns) forget(k);
    if (!ns) hits.clear();
    const db = await openDb();
    if (!db) return;
    if (!ns) { await tx(db, [STORE, META], 'readwrite', (t) => { t.objectStore(STORE).clear(); t.objectStore(META).clear(); }); return; }
    await tx(db, [STORE, META], 'readwrite', (t) => {
      const kv = t.objectStore(STORE), meta = t.objectStore(META);
      const req = meta.index('ns').openKeyCursor(IDBKeyRange.only(ns));
      req.onsuccess = () => { const c = req.result; if (c) { kv.delete(c.primaryKey); meta.delete(c.primaryKey); c.continue(); } };
    });
  },

  /** Expired rows first, then the least recently used, until under the caps. Walks `meta` only. */
  async prune(): Promise<void> {
    const db = await openDb();
    if (!db) return;
    await flushHits();
    const rows: Meta[] = [];
    await tx(db, [META], 'readonly', (t) => {
      const req = t.objectStore(META).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        rows.push(c.value as Meta);
        c.continue();
      };
    });
    const now = Date.now();
    // Expired a day ago: nobody will want it even as stale.
    const doomed = new Set(rows.filter((r) => r.exp < now - 86_400_000).map((r) => r.k));
    const live = rows.filter((r) => !doomed.has(r.k)).sort((a, b) => a.hit - b.hit);
    let bytes = live.reduce((n, r) => n + (r.size || 0), 0);
    while (live.length && (live.length > MAX_ENTRIES || bytes > MAX_BYTES)) {
      const r = live.shift()!;
      doomed.add(r.k);
      bytes -= r.size || 0;
    }
    if (!doomed.size) return;
    for (const k of doomed) forget(k);
    await tx(db, [STORE, META], 'readwrite', (t) => { const kv = t.objectStore(STORE), meta = t.objectStore(META); for (const k of doomed) { kv.delete(k); meta.delete(k); } });
  },

  /** Whether values persist across reloads here (false = memory only). */
  async persistent(): Promise<boolean> { return !!(await openDb()); },
};

/* ── cached(): the loader pattern ───────────────────────────────────────── */

export interface CachedOpts<T> {
  ns?: string;
  /** Hand back an expired value at once and refresh behind it (onUpdate hears the new one). */
  staleWhileRevalidate?: boolean;
  onUpdate?: (v: T) => void;
  /** Skip the cache and load (the result is still stored). */
  force?: boolean;
  /** Don't store this result (e.g. an empty list that is probably a transient failure). */
  keep?: (v: T) => boolean;
}

const inflight = new Map<string, Promise<unknown>>();

/** One load per key at a time; concurrent callers share it. */
function load<T>(key: string, ttlMs: number, loader: () => Promise<T>, o: CachedOpts<T>): Promise<T> {
  const k = full(o.ns || 'default', key);
  const running = inflight.get(k) as Promise<T> | undefined;
  if (running) return running;
  const p = (async () => {
    try {
      const v = await loader();
      if (!o.keep || o.keep(v)) await cache.set(key, v, ttlMs, o.ns);
      return v;
    } finally { inflight.delete(k); }
  })();
  inflight.set(k, p);
  return p;
}

export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>, o: CachedOpts<T> = {}): Promise<T> {
  if (o.force) return load(key, ttlMs, loader, o);
  const e = await cache.entry<T>(key, o.ns);
  if (e && e.exp > Date.now()) return e.v;
  if (e && o.staleWhileRevalidate) {
    load(key, ttlMs, loader, o).then((v) => o.onUpdate?.(v), () => { /* keep serving stale */ });
    return e.v;
  }
  return load(key, ttlMs, loader, o);
}

/* ── Galaxy roster, for an instant boot ─────────────────────────────────── */

export interface RosterSnapshot<P = unknown, F = unknown, G = unknown> { at: number; height?: number; players: P[]; fleets: F[]; guilds: G[] }
const ROSTER_KEY = 'galaxy-roster';

/** Save the roster the store just read (players, fleets, guilds), so the next boot paints at once. */
export function saveRoster<P, F, G>(snap: Omit<RosterSnapshot<P, F, G>, 'at'> & { at?: number }): Promise<void> {
  // Kept a week: stale is fine for a first paint; the LCD read replaces it seconds later.
  return cache.set(ROSTER_KEY, { ...snap, at: snap.at ?? Date.now() }, 7 * 86_400_000, 'roster');
}

/** The last roster saved, if any and younger than maxAgeMs (default a week). */
export async function loadRoster<P, F, G>(maxAgeMs = 7 * 86_400_000): Promise<RosterSnapshot<P, F, G> | null> {
  const e = await cache.entry<RosterSnapshot<P, F, G>>(ROSTER_KEY, 'roster');
  if (!e || Date.now() - e.v.at > maxAgeMs) return null;
  return e.v;
}
