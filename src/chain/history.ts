/* The chain as it stood at a past block. The LCD can answer for a past height, but only through
 * an `x-cosmos-block-height` header, and the public node refuses that header's CORS preflight.
 * The Tendermint RPC's `abci_query` takes the height as a plain query parameter and is CORS-open,
 * but it speaks protobuf. So this module encodes the request and decodes the four replies it
 * needs (Planet, Fleet, Struct with StructAttributes) by field number, from structsd's proto files.
 * The node keeps state for about the last million blocks; older heights fail and callers fall back. */
import { RPC_WS_URL } from './live';

const ENV = (import.meta as { env?: Record<string, string | undefined> }).env || {};
/** The RPC's HTTP side: the same host and port as the WebSocket. */
export const RPC_HTTP_URL = ENV.VITE_RPC_URL || RPC_WS_URL.replace(/^ws/, 'http').replace(/\/websocket\/?$/, '');

/* ── Protobuf, just enough ─────────────────────────────────────────────── */
type Fields = Map<number, (number | Uint8Array)[]>;
const td = new TextDecoder();

function varint(b: Uint8Array, p: { i: number }): number {
  let x = 0, s = 0, byte: number;
  do {
    if (p.i >= b.length) throw new Error('protobuf: truncated varint');
    byte = b[p.i++];
    x += (byte & 0x7f) * 2 ** s;
    s += 7;
  } while (byte & 0x80);
  return x;
}

/** One message's fields by number. Numbers stay exact up to 2^53, which covers every field read here. */
export function fields(b: Uint8Array): Fields {
  const out: Fields = new Map();
  const p = { i: 0 };
  while (p.i < b.length) {
    const key = varint(b, p);
    const no = Math.floor(key / 8), wire = key % 8;
    let v: number | Uint8Array;
    if (wire === 0) v = varint(b, p);
    else if (wire === 2) { const n = varint(b, p); if (p.i + n > b.length) throw new Error('protobuf: truncated field'); v = b.subarray(p.i, p.i + n); p.i += n; }
    else if (wire === 1) { v = 0; p.i += 8; }
    else if (wire === 5) { v = 0; p.i += 4; }
    else throw new Error('protobuf: unsupported wire type ' + wire);
    const list = out.get(no);
    if (list) list.push(v); else out.set(no, [v]);
  }
  return out;
}
const str = (f: Fields, n: number) => { const v = f.get(n)?.[0]; return v instanceof Uint8Array ? td.decode(v) : ''; };
const strs = (f: Fields, n: number) => (f.get(n) || []).flatMap((v) => (v instanceof Uint8Array ? [td.decode(v)] : []));
const num = (f: Fields, n: number) => { const v = f.get(n)?.[0]; return typeof v === 'number' ? v : 0; };
const sub = (f: Fields, n: number): Fields => { const v = f.get(n)?.[0]; return v instanceof Uint8Array ? fields(v) : new Map(); };

function varintBytes(n: number): number[] {
  const out: number[] = [];
  for (; ; n = Math.floor(n / 128)) { if (n < 128) { out.push(n); break; } out.push((n % 128) | 128); }
  return out;
}

/** `{ string id = 1; }`, the shape of the Planet, Fleet and Struct requests. */
export function idRequest(id: string): Uint8Array {
  const body = new TextEncoder().encode(id);
  return Uint8Array.from([0x0a, ...varintBytes(body.length), ...body]);
}

/** `{ uint64 id = 1; }`, the StructType request. */
export function numRequest(id: number): Uint8Array {
  return Uint8Array.from([0x08, ...varintBytes(id)]);
}

/* ── Shapes (structsd proto/structs/structs/*.proto) ───────────────────── */
const AMBIT_OF: Record<number, string> = { 1: 'water', 2: 'land', 3: 'air', 4: 'space' };
const AMBIT_FIELDS = { planet: [5, 6, 7, 8], fleet: [8, 9, 10, 11] } as const; // space, air, land, water

export interface PastPlanet { id: string; owner: string; structs: string[]; queueHead: string }
export interface PastFleet { id: string; owner: string; locationId: string; away: boolean; structs: string[]; commandStruct: string }
export interface PastStruct {
  id: string; typeId: number; owner: string; locationType: 'planet' | 'fleet' | 'other'; locationId: string;
  ambit: string; slot: number; health: number; status: number; destroyed: boolean; hidden: boolean; defenders: string[];
  /** The type's max health at that height (rules change: planetary structs had 3 before v0.18). 0 if unknown. */
  maxHealth: number;
}

export function decodePlanet(b: Uint8Array): PastPlanet {
  const p = sub(fields(b), 1);
  return { id: str(p, 1), owner: str(p, 4), structs: AMBIT_FIELDS.planet.flatMap((n) => strs(p, n)).filter(Boolean), queueHead: str(p, 14) };
}

export function decodeFleet(b: Uint8Array): PastFleet {
  const f = sub(fields(b), 1);
  return { id: str(f, 1), owner: str(f, 2), locationId: str(f, 4), away: num(f, 5) === 1, structs: AMBIT_FIELDS.fleet.flatMap((n) => strs(f, n)).filter(Boolean), commandStruct: str(f, 16) };
}

export function decodeStruct(b: Uint8Array): PastStruct {
  const r = fields(b);
  const s = sub(r, 1), a = sub(r, 2);
  const lt = num(s, 6);
  return {
    id: str(s, 1), typeId: num(s, 3), owner: str(s, 5),
    locationType: lt === 2 ? 'planet' : lt === 9 ? 'fleet' : 'other', locationId: str(s, 7),
    ambit: AMBIT_OF[num(s, 8)] || 'land', slot: num(s, 9),
    health: num(a, 1), status: num(a, 2), hidden: num(a, 11) === 1, destroyed: num(a, 12) === 1,
    defenders: strs(r, 4), maxHealth: 0,
  };
}

/** A StructType reply's max health (field 7). */
export function decodeStructTypeMax(b: Uint8Array): number {
  return num(sub(fields(b), 1), 7);
}

/* ── Queries ───────────────────────────────────────────────────────────── */
const cache = new Map<string, Promise<Uint8Array>>();
/** Boards are a few dozen reads each; an autoplay through the archive must not keep them all. */
const CACHE_MAX = 2400;
let inFlight = 0;
const waiting: (() => void)[] = [];
/** At most eight requests at a time: a board is a few dozen reads and the node is shared. */
async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (inFlight >= 8) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try { return await f(); } finally { inFlight--; waiting.shift()?.(); }
}

/** One `abci_query` at `height`: the reply's protobuf bytes. Cached per path, id and height; failures are forgotten. */
export function queryAt(path: string, id: string | number, height: number): Promise<Uint8Array> {
  const key = `${path}|${id}|${height}`;
  let p = cache.get(key);
  if (!p) {
    p = slot(async () => {
      const hex = Array.from(typeof id === 'number' ? numRequest(id) : idRequest(id), (x) => x.toString(16).padStart(2, '0')).join('');
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      try {
        const res = await fetch(`${RPC_HTTP_URL}/abci_query?path=%22${encodeURIComponent(path)}%22&data=0x${hex}&height=${Math.floor(height)}`, { signal: ctl.signal });
        if (!res.ok) throw new Error(`RPC ${res.status}`);
        const body = await res.json() as { result?: { response?: { code?: number; log?: string; value?: string | null } }; error?: { message?: string } };
        const r = body.result?.response;
        if (!r) throw new Error(body.error?.message || 'RPC: no response');
        if (r.code) throw new Error(r.log || `abci code ${r.code}`);
        return Uint8Array.from(atob(r.value || ''), (c) => c.charCodeAt(0));
      } finally { clearTimeout(timer); }
    });
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    if (cache.size > CACHE_MAX) for (const k of [...cache.keys()].slice(0, 400)) cache.delete(k);
  }
  return p;
}

export const planetAt = (id: string, h: number) => queryAt('/structs.structs.Query/Planet', id, h).then(decodePlanet);
export const fleetAt = (id: string, h: number) => queryAt('/structs.structs.Query/Fleet', id, h).then(decodeFleet);
export const structAt = (id: string, h: number) => queryAt('/structs.structs.Query/Struct', id, h).then(decodeStruct);
export const structTypeMaxAt = (typeId: number, h: number) => queryAt('/structs.structs.Query/StructType', typeId, h).then(decodeStructTypeMax);

/** `missing`: structs on the field whose read failed (rate limit, network), so the board is partial. */
export interface Battlefield { height: number; planetId: string; structs: PastStruct[]; missing: number }

/**
 * Every struct on the field at `height`: the planet's own, its owner's fleet if it was home, the
 * fleet at the head of the raid queue, and any fleet named by the fight itself (`fleets`), which
 * is included wherever it stood. Destroyed structs are left out.
 */
export async function battlefieldAt(height: number, where: { planetId?: string; fleets: string[] }): Promise<Battlefield> {
  const named = [...new Set(where.fleets.filter((f) => /^9-\d+$/.test(f)))];
  const namedReads = await Promise.allSettled(named.map((f) => fleetAt(f, height)));
  const namedFleets = namedReads.map((r) => (r.status === 'fulfilled' ? r.value : null));
  // The planet: given, or wherever the named fleets stood.
  const planetId = where.planetId || namedFleets.find((f) => f?.locationId?.startsWith('2-'))?.locationId || '';
  if (!planetId) {
    // Most often the fleets couldn't be read at all (a pruned height): pass that reason on.
    const failed = namedReads.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    throw failed ? failed.reason : new Error('no planet for this fight');
  }
  const planet = await planetAt(planetId, height);
  const fleetIds = new Set(named);
  if (planet.owner) fleetIds.add('9-' + planet.owner.split('-')[1]);
  if (planet.queueHead) fleetIds.add(planet.queueHead);
  const fleets = await Promise.all([...fleetIds].map((f) => fleetAt(f, height).catch(() => null)));
  const ids = new Set(planet.structs);
  for (const f of fleets) {
    if (!f) continue;
    // A fleet not named by the fight counts only if it was at this planet.
    if (!named.includes(f.id) && f.locationId !== planetId) continue;
    for (const s of f.structs) ids.add(s);
    if (f.commandStruct) ids.add(f.commandStruct);
  }
  const reads = await Promise.allSettled([...ids].map((s) => structAt(s, height)));
  const structs = reads.flatMap((r) => (r.status === 'fulfilled' && r.value.id && !r.value.destroyed ? [r.value] : []));
  const missing = reads.filter((r) => r.status === 'rejected').length;
  // Each type's max health as the rules stood then (one read per type, shared by every board at this height).
  const maxes = new Map<number, number>();
  await Promise.all([...new Set(structs.map((s) => s.typeId))].map((t) => structTypeMaxAt(t, height).then((m) => { maxes.set(t, m); }, () => { /* the catalogue's then */ })));
  for (const s of structs) s.maxHealth = maxes.get(s.typeId) || 0;
  return { height, planetId, structs, missing };
}
