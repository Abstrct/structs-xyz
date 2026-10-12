/* The Guild API: each guild's indexer over Postgres — rosters, leaderboards, ledgers, planet
 * activity history, time series — far richer than the LCD. Calls go straight to the guild
 * (src/guild/transport.ts), without cookies. Public routes (the clock, guild info, player lookups)
 * work wherever a guild allows this site (CORS). Members-only routes answer 401: the guild's
 * sign-in (`LOGIN_GUILD{g}ADDRESS{addr}DATETIME{ts}`, signed by a member's address) opens a
 * session cookie, which a site the guild allows with `Access-Control-Allow-Origin: *` can't use.
 * Those calls fail as 'blocked', in plain words, without signing anything. */
import { guildFetch, GuildBlockedError } from './transport';
import { cached } from '../cache/idb';

export interface Envelope<T> { success: boolean; errors: Record<string, string> | unknown[]; data: T; total?: number; meta?: { height?: number } }

export type GuildApiErrorCode = 'http' | 'server' | 'network' | 'blocked';
export class GuildApiError extends Error {
  constructor(message: string, readonly code: GuildApiErrorCode, readonly status = 0, readonly errors: Record<string, string> = {}) { super(message); this.name = 'GuildApiError'; }
}

/* ── Login message and request (pure; unit-tested): the guild's sign-in format ─ */

export function buildLoginMessage(guildId: string, address: string, unixTimestamp: number): string {
  return `LOGIN_GUILD${guildId}ADDRESS${address}DATETIME${unixTimestamp}`;
}

export interface LoginRequest { address: string; signature: string; pubkey: string; guild_id: string; unix_timestamp: number }
export type MessageSigner = (message: string) => { address: string; pubkey: string; signature: string };

export function buildLoginRequest(guildId: string, address: string, unixTimestamp: number, sign: MessageSigner): LoginRequest {
  const s = sign(buildLoginMessage(guildId, address, unixTimestamp));
  // The server checks the signature against the address in the message: they must agree.
  if (s.address !== address) throw new Error('The signing key is not ' + address);
  return { address, signature: s.signature, pubkey: s.pubkey, guild_id: guildId, unix_timestamp: unixTimestamp };
}

/* ── Row shapes (NUMERIC columns arrive as strings; jsonb as JSON strings) ─ */

export type Num = string | number;
export interface GuildRow {
  id: string; endpoint: string; join_infusion_minimum: Num; join_infusion_minimum_p?: string; join_infusion_minimum_bypass_by_request: string; join_infusion_minimum_bypass_by_invite: string;
  primary_reactor_id: string; entry_substation_id: string; creator: string; owner: string; name: string; description: string; tag: string; logo: string;
  socials: string; website: string; this_infrastructure: boolean; status: string; default_commission: string; validator: string; reactor_ratio: string;
}
export interface DirectoryRow { guild_id: string; name: string; logo: string; alpha: Num; alpha_p?: string; members: number }
export interface RosterRow { id: string; guild_id: string; username: string; pfp: string; pfp_client_render_attributes: string; guild_name: string; tag: string; alpha: Num; alpha_p?: string }
export interface PowerStats { guild_id: string; total_fuel: Num; total_load: Num; total_capacity: Num; avg_connection_capacity: Num; total_fuel_p?: string; total_load_p?: string; total_capacity_p?: string; avg_connection_capacity_p?: string }
export interface BankRow { guild_id: string; denom: string; collateral: Num; supply: Num; ratio: Num }
export interface BucketVolume { bucket: string; action: string; denom: string; volume: Num; count?: number }
export interface PlayerRow {
  id: string; primary_address: string; guild_id: string; substation_id: string; planet_id: string; fleet_id: string; fleet: string; username: string; pfp: string; pfp_client_render_attributes: string;
  guild_name: string; tag: string; alpha: Num; ore: Num; load: Num; structs_load: Num; capacity: Num; connection_capacity: Num;
}
export interface PowerRow { player_id: string; username: string; capacity: Num; connection_capacity: Num; load: Num; structs_load: Num; total_load: Num; total_capacity: Num; margin: Num; connection_capacity_is_player_share: boolean }
export interface OreStats { player_id: string; forfeited: Num; mined: Num; seized: Num }
export interface PlanetRow { id: string; owner: string; map: string; space_slots: number; air_slots: number; land_slots: number; water_slots: number; name: string; undiscovered_ore: Num }
export interface RaidRow { planet_id: string; fleet_id: string; status: string; updated_at: string; fleet_owner?: string; planet_owner?: string; seized_ore?: Num }
export interface ActivityRow { time: string; seq: number; planet_id: string; block_height?: number; category: string; detail: string; detail_json: Record<string, unknown> | null }
export interface StatBucket { bucket: string; category: string; count: number; role?: string }
export interface StructRow {
  id: string; index: number; type: number; creator: string; owner: string; location_type: string; location_id: string; operating_ambit: string; slot: number;
  is_destroyed: boolean; destroyed_block: number | null; created_at: string; updated_at: string; health: number; status: number; protected_struct_id: string | null; defending_struct_ids: string; fuel: Num;
}
export interface StructStatusCounts { materialized: number; built: number; online: number; stored: number; hidden: number; destroyed: number; locked: number; total: number }
export interface FleetRow { id: string; owner: string; map: string; location_type: string; location_id: string; status: string; location_list_forward: string; location_list_backward: string; command_struct: string }
export interface InfusionRow { destination_id: string; address: string; destination_type: string; player_id: string; fuel: Num; defusing: Num; power: Num; ratio: Num; commission: Num; created_at: string; updated_at: string }
export interface AllocationRow { id: string; allocation_type: string; source_id: string; index: number; destination_id: string; creator: string; controller: string }
export interface ProviderRow { id: string; owner: string; substation_id: string; rate_amount: Num; rate_denom: string; access_policy: string; capacity_minimum: Num; capacity_maximum: Num; duration_minimum: Num; duration_maximum: Num; guild_id?: string; committed_capacity?: Num; alpha_equivalent_rate_p?: string }
export interface AgreementRow { id: string; provider_id: string; allocation_id: string; capacity: Num; start_block: number; end_block: number; creator: string; owner: string; blocks_remaining?: number; escrow_remaining?: Num }
export interface PermissionRow { id: string; object_type: string; object_index: number; object_id: string; player_id: string; val: number; updated_at: string }
export interface LedgerRow { id: number; address: string; counterparty: string; amount: Num; denom: string; action: string; direction: string; time: string; counterparty_player_id?: string; counterparty_username?: string; block_height?: number; amount_p?: string }
export interface WorkRow { object_id: string; player_id: string; target_id: string; category: 'BUILD' | 'MINE' | 'REFINE' | 'RAID'; block_start: number; difficulty_target: number; location_type?: string; location_id?: string; planet_id?: string }
export type LeaderboardKind = 'player' | 'guild' | 'reactor' | 'substation' | 'provider';
export interface LeaderPlayer { player_id: string; username: string; guild_id: string; alpha_balance_p: string; alpha_value_p: string }
export interface LeaderGuild { guild_id: string; name: string; onchain_name: string; player_count: number; collateral_p: string; supply_p: string; ratio: Num; member_capacity_p: string; member_load_p: string; shared_connection_capacity_p: string }
export interface LeaderReactor { reactor_id: string; fuel_p: string; power_p: string }
export interface LeaderSubstation { substation_id: string; owner: string; load_p: string; member_capacity_p: string; shared_connection_capacity_p: string; player_count: number }
export interface LeaderProvider { provider_id: string; owner: string; rate_amount_p: string; rate_denom: string; agreement_count: number }
export interface LeaderRows { player: LeaderPlayer; guild: LeaderGuild; reactor: LeaderReactor; substation: LeaderSubstation; provider: LeaderProvider }
export interface StatPoint { time: string; value: Num }
export interface StatAggregate { bucket: string; sum: Num; avg: Num; population: number; samples: number }
export type PlayerMetric = 'ore' | 'fuel' | 'capacity' | 'load' | 'power' | 'structs_load';
export type StatMetric = PlayerMetric | 'connection_count' | 'connection_capacity' | 'struct_health' | 'struct_status';
export interface BlockRow { height: number; tip_height: number; lag_blocks: number; status: string; updated_at: string }
export interface SettingRow { name: string; value: string; updated_at: string }
export interface ObjectRow { id: string; type: string; object: Record<string, unknown> }
export interface ResolveRow { q: string; type: string; id: string; name?: string; object: Record<string, unknown>; is_player: boolean }

/** Query string from a plain object; undefined/null/'' are dropped. */
export function qs(q?: Record<string, string | number | boolean | undefined | null>): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v != null && v !== '') p.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  const s = p.toString();
  return s ? '?' + s : '';
}
const enc = encodeURIComponent;

/** List query parameters the catalog routes share. */
export interface ListQuery { limit?: number; include_total?: boolean; include_meta?: boolean; updated_since?: number; after_id?: string; order?: string; [k: string]: string | number | boolean | undefined }

/* ── The client ─────────────────────────────────────────────────────────── */

export class GuildApi {
  constructor(readonly guildId: string) {}

  /** One HTTP round trip, envelope and all. */
  async raw<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: Envelope<T> | null }> {
    let r: Response;
    try { r = await guildFetch(this.guildId, path, init); } catch (e) {
      if (e instanceof GuildBlockedError) throw new GuildApiError(e.message, 'blocked', 0, { detail: e.detail });
      throw new GuildApiError(String((e as Error).message || e), 'network');
    }
    const ct = r.headers.get('content-type') || '';
    let body: Envelope<T> | null = null;
    if (ct.includes('json')) { try { body = await r.json() as Envelope<T>; } catch { body = null; } }
    return { status: r.status, body };
  }

  /** GET/POST a path. Returns the whole envelope; a members-only route (401) is 'blocked'. */
  async call<T>(path: string, init: RequestInit = {}): Promise<Envelope<T>> {
    const res = await this.raw<T>(path, init);
    if (res.status === 401) throw membersOnly(res.body);
    const b = res.body;
    if (!b) throw new GuildApiError(`Guild API ${res.status}: not JSON`, res.status >= 500 ? 'server' : 'http', res.status);
    if (res.status >= 400 || !b.success) {
      const e = errs(b);
      throw new GuildApiError(Object.values(e).join('; ') || `Guild API ${res.status}`, res.status >= 500 ? 'server' : 'http', res.status, e);
    }
    return b;
  }

  async get<T>(path: string, q?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
    return (await this.call<T>(path + qs(q))).data;
  }

  /** A cached GET: shared across tabs of the app via IndexedDB, stale-while-revalidate. */
  cachedGet<T>(path: string, ttlMs: number, q?: Record<string, string | number | boolean | undefined | null>, onUpdate?: (v: T) => void): Promise<T> {
    return cached(`${this.guildId}:${path}${qs(q)}`, ttlMs, () => this.get<T>(path, q), { ns: 'guild-api', staleWhileRevalidate: true, onUpdate });
  }

  /** One page (1-based) of a `/page/{n}` route. */
  page<T>(path: string, page = 1, q?: ListQuery): Promise<Envelope<T[]>> {
    return this.call<T[]>(`${path.replace(/\/+$/, '')}/page/${page}${qs(q)}`);
  }

  /** Walk a paged route until a short page (or maxRows). */
  async *pages<T>(path: string, q: ListQuery = {}, maxRows = 10_000): AsyncGenerator<T[]> {
    const limit = q.limit ?? 100;
    let seen = 0;
    for (let p = 1; p < 1000 && seen < maxRows; p++) {
      const rows = (await this.page<T>(path, p, { ...q, limit })).data || [];
      seen += rows.length;
      yield rows;
      if (rows.length < limit) return;
    }
  }

  async all<T>(path: string, q: ListQuery = {}, maxRows = 10_000): Promise<T[]> {
    const out: T[] = [];
    for await (const rows of this.pages<T>(path, q, maxRows)) out.push(...rows);
    return out.slice(0, maxRows);
  }

  /* ── Public (no session) ─────────────────────────────────────────────── */

  thisGuild() { return this.cachedGet<GuildRow>('guild/this', 3_600_000); }
  timestamp() { return this.get<{ unix_timestamp: number }>('timestamp'); }
  settings() { return this.cachedGet<SettingRow[]>('setting', 3_600_000); }
  /** An address's player id in this guild, or null if not approved here. */
  playerIdFor(address: string) { return this.get<{ player_id: string } | null>(`auth/player-address/${enc(address)}/guild/${enc(this.guildId)}/player-id`).then((r) => r?.player_id ?? null); }
  activationCode(code: string) { return this.get<{ player_id: string; tag: string; username: string; pfp: string; pfp_client_render_attributes: string }>(`auth/activation-code/${enc(code)}`); }

  /* ── Guilds ──────────────────────────────────────────────────────────── */

  guild(id: string) { return this.cachedGet<GuildRow>(`guild/${enc(id)}`, 600_000); }
  guildNames() { return this.cachedGet<{ id: string; name: string }[]>('guild/name', 600_000); }
  guildCount() { return this.get<{ count: number }>('guild/count'); }
  directory(onUpdate?: (v: DirectoryRow[]) => void) { return this.cachedGet<DirectoryRow[]>('guild/directory', 300_000, undefined, onUpdate); }
  roster(id: string, onUpdate?: (v: RosterRow[]) => void) { return this.cachedGet<RosterRow[]>(`guild/${enc(id)}/roster`, 300_000, undefined, onUpdate); }
  memberCount(id: string) { return this.get<{ count: number }>(`guild/${enc(id)}/members/count`); }
  powerStats(id: string) { return this.cachedGet<PowerStats>(`guild/${enc(id)}/power/stats`, 120_000); }
  planetsCompleted(id: string) { return this.get<{ count: number }>(`guild/${enc(id)}/planet/complete/count`); }
  guildList(page = 1, q?: ListQuery) { return this.page<GuildRow>('guild/list/all', page, q); }
  bank() { return this.cachedGet<BankRow[]>('guild-bank', 120_000); }
  bankHistory(id: string, bucket: '1h' | '1d' = '1d') { return this.cachedGet<BucketVolume[]>(`guild-bank/${enc(id)}/history`, 600_000, { bucket }); }
  membershipApplications(id: string, page = 1) { return this.page<Record<string, unknown>>(`guild-membership-application/guild/${enc(id)}`, page); }

  /* ── Players ─────────────────────────────────────────────────────────── */

  player(id: string) { return this.get<PlayerRow>(`player/${enc(id)}`); }
  playerCount() { return this.get<{ count: number }>('player/count'); }
  activePlayers(windowBlocks?: number) { return this.get<{ count: number }>('player/active/count', { window_blocks: windowBlocks }); }
  atRisk(limit = 25) { return this.get<PowerRow[]>('player/power/at-risk', { limit }); }
  playerPower(id: string) { return this.get<PowerRow>(`player/${enc(id)}/power`); }
  lastAction(id: string) { return this.get<{ last_action_block_height: number }>(`player/${enc(id)}/action/last/block/height`); }
  oreStats(id: string) { return this.cachedGet<OreStats>(`player/${enc(id)}/ore/stats`, 600_000); }
  planetsCompletedBy(id: string) { return this.get<{ count: number }>(`player/${enc(id)}/planet/completed`); }
  raidsLaunched(id: string) { return this.get<{ count: number }>(`player/${enc(id)}/raid/launched`); }
  raidSearch(q: { guild_id?: string; min_ore?: number; search_string?: string; fleet_away_only?: boolean; not_under_attack?: boolean; page?: number }) { return this.get<Record<string, unknown>[]>('player/raid/search', q); }
  transferSearch(search: string, guildId?: string) { return this.get<Record<string, unknown>[]>('player/transfer/search', { search_string: search, guild_id: guildId }); }
  playerList(scope: 'all' | { guild: string } | { substation: string } = 'all', page = 1, q?: ListQuery) {
    const p = scope === 'all' ? 'player/list/all' : 'guild' in scope ? `player/list/guild/${enc(scope.guild)}` : `player/list/substation/${enc(scope.substation)}`;
    return this.page<Record<string, unknown>>(p, page, q);
  }
  addresses(playerId: string) { return this.get<{ address: string; block_time: string; ip: string; user_agent: string; permissions: number }[]>(`player-address/player/${enc(playerId)}`); }

  /* ── Planets, raids, activity ────────────────────────────────────────── */

  planet(id: string) { return this.get<PlanetRow>(`planet/${enc(id)}`); }
  shield(id: string) { return this.get<{ planet_id: string; planetary_shield: Num; block_start_raid: Num }>(`planet/${enc(id)}/shield`); }
  shieldHealth(id: string) { return this.get<{ health: number }>(`planet/${enc(id)}/shield/health`); }
  activeRaid(planetId: string) { return this.get<RaidRow | null>(`planet/${enc(planetId)}/raid/active`); }
  activeRaidByFleet(fleetId: string) { return this.get<RaidRow | null>(`planet/raid/active/fleet/${enc(fleetId)}`); }
  raids(status?: string, page = 1, limit = 100) { return this.page<RaidRow>(status ? `planet-raid/status/${enc(status)}` : 'planet-raid/all', page, { limit }); }
  planetCount() { return this.get<{ count: number }>('planet/count'); }
  /** The activity feed, newest first; `since_seq` turns it into a cursor for one planet. */
  activity(scope: 'all' | { planet: string; since_seq?: number } | { category: string } | { player: string; category?: string; role?: string; since_height?: number; order?: 'asc' | 'desc' } = 'all', page = 1, limit = 100) {
    if (scope === 'all') return this.page<ActivityRow>('planet-activity/all', page, { limit });
    if ('planet' in scope) return this.page<ActivityRow>(`planet-activity/planet/${enc(scope.planet)}`, page, { limit, since_seq: scope.since_seq });
    if ('category' in scope && !('player' in scope)) return this.page<ActivityRow>(`planet-activity/category/${enc(scope.category)}`, page, { limit });
    const s = scope as { player: string; category?: string; role?: string; since_height?: number; order?: 'asc' | 'desc' };
    return this.page<ActivityRow>(`planet-activity/player/${enc(s.player)}`, page, { limit, category: s.category, role: s.role, since_height: s.since_height, order: s.order });
  }
  activityStats(bucket: '1h' | '1d' = '1h', category?: string) { return this.cachedGet<StatBucket[]>('planet-activity/stats', 300_000, { bucket, category }); }
  playerActivityStats(playerId: string, q: { category?: string; role?: string } = {}) { return this.cachedGet<StatBucket[]>(`planet-activity/player/${enc(playerId)}/stats`, 300_000, { ...q, bucket: '1d' }); }

  /* ── Structs and fleets ──────────────────────────────────────────────── */

  struct(id: string) { return this.get<StructRow>(`struct/${enc(id)}`); }
  structsOf(playerId: string) { return this.get<StructRow[]>(`struct/player/${enc(playerId)}`); }
  structTypes() { return this.cachedGet<Record<string, unknown>[]>('struct/type', 86_400_000); }
  structStatusCounts() { return this.cachedGet<StructStatusCounts>('struct/status/counts', 120_000); }
  structCount(destroyed?: boolean) { return this.get<{ count: number }>('struct/count', { is_destroyed: destroyed }); }
  defenders(protectedStructId: string, page = 1) { return this.page<{ defending_struct_id: string; protected_struct_id: string }>(`struct-defender/protected/${enc(protectedStructId)}`, page); }
  fleetOf(playerId: string) { return this.get<FleetRow>(`fleet/player/${enc(playerId)}`); }
  fleetCount() { return this.get<{ count: number }>('fleet/count'); }
  fleetsAt(locationId: string, page = 1) { return this.page<FleetRow>(`fleet/list/location/${enc(locationId)}`, page); }

  /* ── Energy, market, permissions ─────────────────────────────────────── */

  infusionOf(playerId: string) { return this.get<InfusionRow>(`infusion/player/${enc(playerId)}`); }
  infusions(scope: 'all' | { destination: string } | { address: string } | { player: string } = 'all', page = 1, q?: ListQuery) {
    return this.page<InfusionRow>(scope === 'all' ? 'infusion/list/all' : 'destination' in scope ? `infusion/list/destination/${enc(scope.destination)}` : 'address' in scope ? `infusion/list/address/${enc(scope.address)}` : `infusion/list/player/${enc(scope.player)}`, page, q);
  }
  allocations(scope: 'all' | { source: string } | { destination: string } | { creator: string } | { controller: string } = 'all', page = 1, q?: ListQuery) {
    const [k, v] = scope === 'all' ? ['all', ''] : Object.entries(scope)[0];
    return this.page<AllocationRow>(k === 'all' ? 'allocation/all' : `allocation/${k}/${enc(v)}`, page, q);
  }
  providerMarket() { return this.cachedGet<ProviderRow[]>('provider/market', 120_000); }
  providers(scope: 'all' | { owner: string } | { denom: string } | { substation: string } = 'all', page = 1, q?: ListQuery) {
    const [k, v] = scope === 'all' ? ['all', ''] : Object.entries(scope)[0];
    return this.page<ProviderRow>(k === 'all' ? 'provider/all' : `provider/${k}/${enc(v)}`, page, q);
  }
  agreements(scope: 'all' | { provider: string } = 'all', page = 1, q?: ListQuery) {
    return this.page<AgreementRow>(scope === 'all' ? 'agreement/all' : `agreement/provider/${enc(scope.provider)}`, page, q);
  }
  agreementMarket(owner: string) { return this.get<AgreementRow[]>(`agreement/owner/${enc(owner)}/market`); }
  permissions(scope: 'all' | { object: string } | { player: string } = 'all', page = 1, q?: ListQuery) {
    return this.page<PermissionRow>(scope === 'all' ? 'permission/all' : 'object' in scope ? `permission/object/${enc(scope.object)}` : `permission/player/${enc(scope.player)}`, page, q);
  }
  reactors(scope: 'all' | { guild: string } = 'all', page = 1) { return this.page<Record<string, unknown>>(scope === 'all' ? 'reactor/all' : `reactor/guild/${enc(scope.guild)}`, page); }
  substations(page = 1) { return this.page<Record<string, unknown>>('substation/all', page); }
  inventory(ownerType: string, ownerId: string) { return this.get<{ owner_type: string; owner_id: string; denom: string; balance: string }[]>(`inventory/owner/${enc(ownerType)}/${enc(ownerId)}`); }
  grid(scope: 'all' | { object: string } | { attribute: string; objectType?: string } = 'all', page = 1, q?: ListQuery) {
    const p = scope === 'all' ? 'grid/all' : 'object' in scope ? `grid/object/${enc(scope.object)}` : scope.objectType ? `grid/attribute-type/${enc(scope.attribute)}/object-type/${enc(scope.objectType)}` : `grid/attribute-type/${enc(scope.attribute)}`;
    return this.page<Record<string, unknown>>(p, page, q);
  }

  /* ── Ledger ──────────────────────────────────────────────────────────── */

  ledger(playerId: string, page = 1) { return this.page<LedgerRow>(`ledger/player/${enc(playerId)}`, page); }
  ledgerCount(playerId: string) { return this.get<{ count: number }>(`ledger/player/${enc(playerId)}/count`); }
  ledgerTx(id: number | string) { return this.get<LedgerRow>(`ledger/${enc(String(id))}`); }
  ledgerStats(bucket: '1h' | '1d' = '1d', denom?: string) { return this.cachedGet<BucketVolume[]>('ledger/stats', 600_000, { bucket, denom }); }
  /** Every action and denom (mined, refined, infused, …), not just ualpha transfers. */
  ledgerFull(scope: 'all' | { player: string } | { address: string } = 'all', page = 1, q?: ListQuery) {
    return this.page<LedgerRow>(scope === 'all' ? 'ledger/list/all' : 'player' in scope ? `ledger/list/player/${enc(scope.player)}` : `ledger/list/address/${enc(scope.address)}`, page, q);
  }

  /* ── Work, leaderboards, stats, misc ─────────────────────────────────── */

  workOf(playerId: string) { return this.get<WorkRow[]>(`work/player/${enc(playerId)}`); }
  work(scope: 'all' | { guild: string } = 'all', page = 1) { return this.page<WorkRow>(scope === 'all' ? 'work/all' : `work/guild/${enc(scope.guild)}`, page); }
  workCount() { return this.get<{ count: number }>('work/count'); }
  leaderboard<K extends LeaderboardKind>(kind: K, q: { order?: string; limit?: number } = {}, onUpdate?: (v: LeaderRows[K][]) => void) {
    return this.cachedGet<LeaderRows[K][]>(`leaderboard/${kind}`, 120_000, { limit: q.limit ?? 50, order: q.order }, onUpdate);
  }
  /** A metric's time series for one object (max 7 days raw, 30 bucketed). Times are unix seconds. */
  statSeries(metric: StatMetric, objectKey: string, q: { start_time: number; end_time: number; bucket?: '1h' | '1d'; limit?: number }, page = 1) {
    return this.call<StatPoint[]>(`stat/${enc(metric)}/object/${enc(objectKey)}/range/page/${page}${qs(q)}`).then((r) => r.data);
  }
  statAggregate(metric: StatMetric, q: { object_type: string; start_time: number; end_time: number; bucket?: '1h' | '1d' }) {
    return this.cachedGet<StatAggregate[]>(`stat/${enc(metric)}/aggregate/range`, 600_000, q);
  }
  block() { return this.get<BlockRow>('block'); }
  denoms() { return this.cachedGet<Record<string, unknown>>('denom', 86_400_000); }
  resolve(q: string) { return this.get<ResolveRow[]>('resolve', { q }); }
  /** Raw rows for up to 200 object keys at once ("1-12,2-40,5-7"). */
  objects(ids: string[]) { return this.get<ObjectRow[]>('objects', { ids: ids.slice(0, 200).join(',') }); }
  bannedWords() { return this.cachedGet<{ value: string }[]>('banned-word/all', 3_600_000); }
}

/** Members-only data: the guild's session is a cookie, and this site can't use it. */
function membersOnly(body: Envelope<unknown> | null): GuildApiError {
  return new GuildApiError('This guild’s members-only data can’t be opened from this website yet.', 'blocked', 401,
    { ...errs(body), detail: 'its sign-in is a session cookie, which a site it allows with Access-Control-Allow-Origin: * can’t use (that needs credentials allowed for this origin and a SameSite=None cookie, or a token)' });
}

function errs(b: Envelope<unknown> | null): Record<string, string> {
  const e = b?.errors;
  if (!e || Array.isArray(e)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  return out;
}

const clients = new Map<string, GuildApi>();
/** The Guild API of one guild (one client per guild per tab). */
export function guildApi(guildId: string): GuildApi {
  let c = clients.get(guildId);
  if (!c) { c = new GuildApi(guildId); clients.set(guildId, c); }
  return c;
}
