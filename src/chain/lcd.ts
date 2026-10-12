/* The REST channel: the chain's LCD (Cosmos REST). Read-only, CORS-open on the
 * public testnet. Numbers arrive as strings; models keep big values as
 * strings and convert small, bounded fields (slots, health, status) once,
 * here at the boundary. */

const ENV = (import.meta as { env?: Record<string, string | undefined> }).env || {};
export const LCD_URL = ENV.VITE_LCD_URL || 'https://public.testnet.structs.network';

export class LcdError extends Error {
  status: number; code?: number;
  constructor(message: string, status: number, code?: number) { super(message); this.status = status; this.code = code; }
}

async function get<T>(path: string, timeoutMs = 20000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(LCD_URL + path, { signal: ctl.signal });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new LcdError(`LCD ${res.status}: non-JSON response`, res.status); }
    if (!res.ok) {
      const b = body as { message?: string; code?: number };
      throw new LcdError(b?.message || `LCD ${res.status}`, res.status, b?.code);
    }
    return body as T;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new LcdError('LCD request timed out', 0);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ── Raw shapes (as the LCD sends them) ─────────────────────────────────── */

export interface RawPlayer {
  id: string; index: string; guildId: string; substationId: string; creator: string; primaryAddress: string;
  planetId: string; fleetId: string; guildRank: string; name: string; pfp: string; pfpClientRenderAttributes: string;
}
export interface Grid {
  ore?: string; fuel?: string; capacity?: string; load?: string; structsLoad?: string; power?: string;
  connectionCapacity?: string; connectionCount?: string; lastAction?: string; nonce?: string; ready?: string;
}
export interface RawPlanet {
  id: string; maxOre: string; creator: string; owner: string; space: string[]; air: string[]; land: string[]; water: string[];
  spaceSlots: string; airSlots: string; landSlots: string; waterSlots: string; status: string; name: string;
  locationListStart: string; locationListLast: string; locationListExtra: string; locationListCount: string;
}
export interface PlanetAttributes {
  planetaryShield?: string; repairNetworkQuantity?: string; defensiveCannonQuantity?: string; coordinatedGlobalShieldNetworkQuantity?: string;
  lowOrbitBallisticsInterceptorNetworkQuantity?: string; advancedLowOrbitBallisticsInterceptorNetworkQuantity?: string;
  lowOrbitBallisticsInterceptorNetworkSuccessRateNumerator?: string; lowOrbitBallisticsInterceptorNetworkSuccessRateDenominator?: string;
  orbitalJammingStationQuantity?: string; advancedOrbitalJammingStationQuantity?: string; blockStartRaid?: string; blockRaiderArrived?: string;
  blockStartOreMine?: string; blockStartOreRefine?: string; oreMiningActiveQuantity?: string; oreRefiningActiveQuantity?: string;
}
export interface RawFleet {
  id: string; owner: string; locationType: string; locationId: string; status: string; locationListForward: string; locationListBackward: string;
  space: string[]; air: string[]; land: string[]; water: string[]; commandStruct: string;
}
export interface RawStruct { id: string; index: string; type: string; creator: string; owner: string; locationType: string; locationId: string; operatingAmbit: string; slot: string }
export interface StructAttributes {
  health?: string; status?: string; blockStartBuild?: string; protectedStructIndex?: string;
  isMaterialized?: boolean; isBuilt?: boolean; isOnline?: boolean; isHidden?: boolean; isDestroyed?: boolean; isLocked?: boolean;
}
export interface RawGuild {
  id: string; index: string; endpoint: string; creator: string; owner: string; joinInfusionMinimum: string; primaryReactorId: string;
  entrySubstationId: string; entryRank: string; name: string; pfp: string;
}

export interface RawReactor { id: string; validator: string; guildId: string; defaultCommission: string; owner: string }
export interface RawSubstation { id: string; owner: string; creator: string; name: string; pfp: string }
export interface RawAllocation { id: string; type: string; sourceObjectId: string; index: string; destinationId: string; controller: string }
export interface RawProvider { id: string; substationId: string; rate: { denom: string; amount: string }; accessPolicy: string; capacityMinimum: string; capacityMaximum: string; durationMinimum: string; durationMaximum: string; owner: string }
export interface RawInfusion { destinationType: string; destinationId: string; fuel: string; power: string; commission: string; playerId: string; address: string; ratio: string; defusing: string }

export interface PlayerFull { Player: RawPlayer; gridAttributes?: Grid; playerInventory?: { rocks?: { denom: string; amount: string } } }
export interface PlanetFull { Planet: RawPlanet; gridAttributes?: Grid; planetAttributes?: PlanetAttributes }
export interface StructFull { Struct: RawStruct; structAttributes?: StructAttributes; gridAttributes?: Grid; structDefenders?: string[] }

/* ── Queries ────────────────────────────────────────────────────────────── */

export const lcd = {
  player: (id: string) => get<PlayerFull>(`/structs/player/${encodeURIComponent(id)}`),
  planet: (id: string) => get<PlanetFull>(`/structs/planet/${encodeURIComponent(id)}`),
  fleet: (id: string) => get<{ Fleet: RawFleet }>(`/structs/fleet/${encodeURIComponent(id)}`).then((r) => r.Fleet),
  struct: (id: string) => get<StructFull>(`/structs/struct/${encodeURIComponent(id)}`),
  guild: (id: string) => get<{ Guild: RawGuild }>(`/structs/guild/${encodeURIComponent(id)}`).then((r) => r.Guild),
  address: (addr: string) => get<{ playerId: string }>(`/structs/address/${encodeURIComponent(addr)}`),
  planetsByPlayer: (id: string) => get<{ Planet: RawPlanet[] }>(`/structs/planet_by_player/${encodeURIComponent(id)}`).then((r) => r.Planet || []),
  /** Any entity with its grid attributes: reactor, substation, allocation, provider… */
  entity: <T>(kind: string, id: string) => get<T>(`/structs/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`),
  latestHeight: () => get<{ block: { header: { height: string; time: string } } }>(`/cosmos/base/tendermint/v1beta1/blocks/latest`)
    .then((r) => ({ height: Number(r.block.header.height), time: r.block.header.time })),

  /** Page through a list endpoint; `onPage` sees each page as it lands. */
  async list<T>(entity: string, field: string, opts: { limit?: number; onPage?: (rows: T[]) => void; signal?: { cancelled: boolean } } = {}): Promise<T[]> {
    const out: T[] = [];
    let key = '';
    const limit = opts.limit ?? 5000;
    for (let guard = 0; guard < 200; guard++) {
      if (opts.signal?.cancelled) break;
      const q = `pagination.limit=${limit}` + (key ? `&pagination.key=${encodeURIComponent(key)}` : '');
      const page = await get<Record<string, unknown> & { pagination?: { next_key: string | null } }>(`/structs/${entity}?${q}`, 45000);
      const rows = (page[field] as T[]) || [];
      out.push(...rows);
      opts.onPage?.(rows);
      key = page.pagination?.next_key || '';
      if (!key) break;
    }
    return out;
  },
};

/* ── Small conversions ──────────────────────────────────────────────────── */

export const num = (v: string | number | undefined | null) => (v == null || v === '' ? 0 : Number(v));
export const big = (v: string | undefined | null) => { try { return BigInt(String(v || '0').split('.')[0]); } catch { return 0n; } };

/** Struct status bit flags (types/keys.go). */
export const STATUS_FLAGS = { materialized: 1, built: 2, online: 4, stored: 8, hidden: 16, destroyed: 32, locked: 64 } as const;
export function statusText(mask: number): string {
  if (mask & 32) return 'Destroyed';
  if (!(mask & 2)) return mask & 1 ? 'Building' : 'Planned';
  if (mask & 16) return 'Hidden';
  if (mask & 4) return 'Online';
  return 'Offline';
}

/** structsd grid attribute ids: the first part of a gridRecord's `attributeId` ("<attr>-<objectType>-<index>"). */
const GRID_FIELDS: Record<number, keyof Grid> = { 0: 'ore', 1: 'fuel', 2: 'capacity', 3: 'load', 4: 'structsLoad', 5: 'power', 6: 'connectionCapacity', 7: 'connectionCount', 11: 'lastAction', 12: 'nonce' };

/** An EventGrid payload as the object it touched, the field and the new value; null if it isn't one. */
export function gridRecord(data: unknown): { objectId: string; objectType: number; field: keyof Grid; value: string } | null {
  const rec = ((data as { gridRecord?: unknown })?.gridRecord ?? data) as { attributeId?: unknown; value?: unknown } | null;
  if (!rec || typeof rec !== 'object') return null;
  const m = /^(\d+)-(\d+)-(\d+)$/.exec(String(rec.attributeId ?? ''));
  if (!m) return null;
  const field = GRID_FIELDS[Number(m[1])];
  if (!field || rec.value == null || !/^-?\d+$/.test(String(rec.value))) return null;
  return { objectId: `${m[2]}-${m[3]}`, objectType: Number(m[2]), field, value: String(rec.value) };
}
