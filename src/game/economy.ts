/* The economy's arithmetic, exactly as the chain does it: units, grid health, brownouts,
 * infusion yield, guild-bank quotes and energy-market pricing. All amounts are bigint in
 * the chain's base units (ualpha, mW, uguild, blocks) so nothing drifts through a float;
 * numbers only appear for display ratios. Pure: no DOM, no network — tested in
 * scripts/economy.test.ts. Sources are cited from structsd v0.21 (x/structs/keeper). */

/* ── Units ──────────────────────────────────────────────────────────────── */

/** LegacyDec precision: chain decimals ("0.040000000000000000") carry 18 places. */
export const DEC = 10n ** 18n;
export const UALPHA = 1_000_000n;          // 1 alpha = 1 g = 1e6 ualpha
export const MW_PER_KW = 1_000_000n;       // power is stored in milliwatts

/** Alpha ladder (exponent of ualpha). "alpha" and "g" are the same unit. */
export const ALPHA_UNITS: Record<string, number> = { ualpha: 0, 'μg': 0, ug: 0, mg: 3, g: 6, alpha: 6, a: 6, kg: 9, t: 12 };
/** Power ladder (exponent of mW). */
export const POWER_UNITS: Record<string, number> = { mw: 0, w: 3, kw: 6, mwatt: 9, gw: 12 };

/** Commas are only ever thousands separators ("1,234,567.5"): a comma that could be a decimal
 * point ("0,5", "1,5", "12,34") is refused rather than guessed, since reading "0,5" as 5 or 500
 * would move a hundredfold more than meant. Only "." marks decimals. */
const GROUPED = /^[1-9]\d{0,2}(,\d{3})+$/;

/** Why a typed number is ambiguous ("Use a point for decimals"), or null if it is not. */
export function decimalProblem(input: string): string | null {
  const s = String(input ?? '').trim().replace(/[_\s]/g, '').replace(/[a-zA-Zμ]+$/, '');
  if (!s.includes(',')) return null;
  const [i, f = ''] = s.split('.');
  if (f.includes(',') || !GROUPED.test(i)) return `“${s}”: use a point for decimals (0.5, not 0,5); commas only group thousands (1,234.5)`;
  return null;
}

/** "1.25" at `decimals` places → 1250000n (decimals 6). Exact; null if unreadable, negative,
 * ambiguous (see decimalProblem), or more fractional digits than the unit can hold (we never
 * round a user's amount silently). */
export function parseDecimal(input: string, decimals: number): bigint | null {
  const raw = String(input ?? '').trim().replace(/[_\s]/g, '');
  if (raw.includes(',') && decimalProblem(raw)) return null;
  const s = raw.replace(/,/g, '');
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return null;
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) {
    // Trailing zeros past the precision are harmless ("1.5000000" at 6 places).
    if (/[^0]/.test(f.slice(decimals))) return null;
  }
  return BigInt((i || '0') + f.slice(0, decimals).padEnd(decimals, '0'));
}

/** 1250000n at 6 places → "1.25"; `group` adds thousands separators to the whole part. */
export function formatDecimal(v: bigint, decimals: number, opts: { maxFrac?: number; group?: boolean } = {}): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  let frac = decimals ? (a % base).toString().padStart(decimals, '0') : '';
  if (opts.maxFrac != null && opts.maxFrac < decimals) {
    // Truncate toward zero: a display never shows more than the account holds.
    frac = frac.slice(0, opts.maxFrac);
  }
  frac = frac.replace(/0+$/, '');
  const w = opts.group ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole.toString();
  return (neg ? '-' : '') + w + (frac ? '.' + frac : '');
}

/** "2.5 kg", "250mg", "1000 ualpha", "3" (alpha) → ualpha. */
export function parseAlpha(input: string, defaultUnit = 'alpha'): bigint | null {
  const m = /^\s*([\d.,_]+)\s*([a-zA-Zμ]*)\s*$/.exec(String(input ?? ''));
  if (!m) return null;
  const unit = (m[2] || defaultUnit).toLowerCase();
  const exp = ALPHA_UNITS[unit];
  if (exp == null) return null;
  return parseDecimal(m[1], exp);
}

/** "1.5 kW", "500 W", "2" (kW by default) → mW. */
export function parsePower(input: string, defaultUnit = 'kW'): bigint | null {
  const m = /^\s*([\d.,_]+)\s*([a-zA-Z]*)\s*$/.exec(String(input ?? ''));
  if (!m) return null;
  // "MW" is megawatts and "mW" milliwatts: the one place case matters.
  const raw = m[2] || defaultUnit;
  const unit = raw === 'MW' ? 'mwatt' : raw.toLowerCase();
  const exp = POWER_UNITS[unit];
  if (exp == null) return null;
  return parseDecimal(m[1], exp);
}

/** A chain LegacyDec string ("0.04", "0.040000000000000000") → bigint scaled by 1e18. */
export function decOf(s: string | null | undefined): bigint {
  return parseDecimal(String(s ?? '0') || '0', 18) ?? 0n;
}
/** Scaled 1e18 → percent number for display ("4"). */
export const decPct = (d: bigint) => Number((d * 1_000_000n) / DEC) / 10_000;

export const ceilDiv = (a: bigint, b: bigint) => (a <= 0n ? a / b : (a + b - 1n) / b);
export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
export const big0 = (v: unknown): bigint => { try { return BigInt(String(v ?? '0').split('.')[0] || '0'); } catch { return 0n; } };

/** Human ladders for amounts already in base units. */
export function alphaLadder(ualpha: bigint): { label: string; value: string }[] {
  return [
    { label: 'ualpha', value: formatDecimal(ualpha, 0, { group: true }) },
    { label: 'mg', value: formatDecimal(ualpha, 3, { group: true }) },
    { label: 'alpha (g)', value: formatDecimal(ualpha, 6, { group: true }) },
    { label: 'kg', value: formatDecimal(ualpha, 9, { group: true }) },
  ];
}

/* ── Grid health (keeper/player_cache.go) ───────────────────────────────── */

export interface GridIn { capacity: bigint; load: bigint; structsLoad: bigint; /** the substation's per-connection share */ connectionCapacity: bigint }
export type GridState = 'dark' | 'thin' | 'healthy' | 'spare';
export interface GridHealth {
  supply: bigint; demand: bigint; headroom: bigint; allocatable: bigint; online: boolean; marginPct: number; state: GridState; spare: bigint;
}

/** The fallback "one build" of headroom the desktop uses (an Ore Extractor's draw). */
export const BUILD_MW = 500_000n;

/** IsOnline: load + structsLoad ≤ capacity + capacitySecondary (the substation's connection share).
 * Only a player's own capacity can be allocated out: allocatable = capacity − load. */
export function gridHealth(g: GridIn, keepBuilds = 2n): GridHealth {
  const supply = g.capacity + g.connectionCapacity;
  const demand = g.load + g.structsLoad;
  const headroom = supply - demand;
  const allocatable = maxBig(0n, g.capacity - g.load);
  const spare = maxBig(0n, minBig(allocatable, headroom) - keepBuilds * BUILD_MW);
  const marginPct = supply > 0n ? Number((headroom * 10_000n) / supply) / 100 : headroom < 0n ? -100 : 0;
  const state: GridState = headroom < 0n ? 'dark' : headroom < keepBuilds * BUILD_MW ? 'thin' : spare >= MW_PER_KW ? 'spare' : 'healthy';
  return { supply, demand, headroom, allocatable, online: headroom >= 0n, marginPct, state, spare };
}

/** Substation share per connection: (capacity − load) / connections (keeper/grid_context.go). */
export function connectionShare(capacity: bigint, load: bigint, connections: bigint): bigint {
  if (connections <= 0n || load >= capacity) return 0n;
  return (capacity - load) / connections;
}

/* ── Brownout (keeper/grid_context.go GridCascade) ──────────────────────── */

export interface OutAlloc { id: string; power: bigint; type?: string; destinationId?: string }

/** The cascade walks a source's allocations in KV-store order: byte order of the allocation
 * id string ("6-10" before "6-2"), which is creation order only within the same digit count. */
export function cascadeOrder<T extends { id: string }>(allocs: T[]): T[] {
  return [...allocs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** While load > capacity, destroy the next outgoing allocation (its power leaves the load). */
export function brownout(capacity: bigint, load: bigint, allocs: OutAlloc[]): { victims: OutAlloc[]; loadAfter: bigint; stillOver: boolean } {
  const victims: OutAlloc[] = [];
  let l = load;
  for (const a of cascadeOrder(allocs)) {
    if (l <= capacity) break;
    victims.push(a);
    l -= a.power;
    if (l < 0n) l = 0n;
  }
  return { victims, loadAfter: l, stillOver: l > capacity };
}

export type DrawKind = 'command' | 'fleet' | 'planet' | 'production';
export interface DrawItem { id: string; name: string; draw: bigint; kind: DrawKind }

/** What to power down to come back online: fleet hulls first, then planetary defences, then
 * production; never the Command Ship (it is the fleet). Biggest draw first within a tier, so
 * the fewest structs go dark. */
export function pausePlan(deficit: bigint, items: DrawItem[]): { plan: DrawItem[]; covered: boolean } {
  const tier: Record<DrawKind, number> = { fleet: 0, planet: 1, production: 2, command: 9 };
  const order = items.filter((i) => i.kind !== 'command' && i.draw > 0n)
    .sort((a, b) => tier[a.kind] - tier[b.kind] || (b.draw > a.draw ? 1 : b.draw < a.draw ? -1 : 0) || (a.id < b.id ? -1 : 1));
  const plan: DrawItem[] = [];
  let left = deficit;
  for (const it of order) {
    if (left <= 0n) break;
    plan.push(it);
    left -= it.draw;
  }
  return { plan, covered: left <= 0n };
}

/** "If my own capacity fell by `drop`": which allocations the cascade eats, then whether the
 * structs still fit, and what to switch off if not. Allocations that fed the player's own
 * substation take their power out of it too, shrinking everyone's share — the player's included. */
export function whatIf(g: GridIn, drop: bigint, allocs: OutAlloc[], items: DrawItem[], sub?: { id: string; capacity: bigint; load: bigint; connections: bigint } | null) {
  const capacity = maxBig(0n, g.capacity - drop);
  const cascade = brownout(capacity, g.load, allocs);
  const subLoss = sub ? cascade.victims.filter((v) => v.destinationId === sub.id).reduce((a, v) => a + v.power, 0n) : 0n;
  const share = sub && subLoss > 0n ? connectionShare(maxBig(0n, sub.capacity - subLoss), sub.load, sub.connections) : g.connectionCapacity;
  const after = gridHealth({ ...g, capacity, load: cascade.loadAfter, connectionCapacity: share });
  const deficit = after.headroom < 0n ? -after.headroom : 0n;
  return { capacity, cascade, subLoss, share, after, deficit, pause: pausePlan(deficit, items) };
}

/* ── Reactors and infusion (keeper/infusion_cache.go) ───────────────────── */

/** ReactorFuelToEnergyConversion = 1: one ualpha infused is one milliwatt. The reactor keeps
 * its commission; the player gets the rest. The chain rounds the reactor's cut (3,406,001,349
 * fuel at 4% shows 136,240,054 mW on reactor 3-1), so this is an estimate to the milliwatt. */
export function infusionYield(ualpha: bigint, commission: bigint): { power: bigint; player: bigint; reactor: bigint } {
  const power = ualpha;
  const reactor = (power * commission + DEC / 2n) / DEC;
  return { power, player: power - reactor, reactor };
}

/** Alpha to infuse for the player to receive `mw` after commission. */
export function alphaForPower(mw: bigint, commission: bigint): bigint {
  if (mw <= 0n) return 0n;
  const keep = DEC - commission;
  return keep > 0n ? ceilDiv(mw * DEC, keep) : 0n;
}

export interface Defusion { validator: string; creationHeight: string; completionTime: string; initial: bigint; balance: bigint }
/** /cosmos/staking/v1beta1/delegators/{a}/unbonding_delegations → one row per entry. */
export function defusions(r: { unbonding_responses?: { validator_address: string; entries: { creation_height: string; completion_time: string; initial_balance: string; balance: string }[] }[] }): Defusion[] {
  const out: Defusion[] = [];
  for (const u of r.unbonding_responses || []) for (const e of u.entries || [])
    out.push({ validator: u.validator_address, creationHeight: e.creation_height, completionTime: e.completion_time, initial: big0(e.initial_balance), balance: big0(e.balance) });
  return out.sort((a, b) => a.completionTime.localeCompare(b.completionTime));
}

/* ── Guild banks (keeper/guild_cache.go BankConvert / BankRedeem) ───────── */

export interface BankPool { collateral: bigint; supply: bigint; inFee: bigint; outFee: bigint }
export type Quote<T> = (T & { ok: true }) | { ok: false; reason: string };

/** Alpha in → tokens out. Fee rounds up (guild-favoured); tokens = floor(net × supply / collateral). */
export function convertQuote(alpha: bigint, b: BankPool): Quote<{ fee: bigint; net: bigint; tokens: bigint }> {
  if (alpha <= 0n) return { ok: false, reason: 'Enter an amount' };
  if (b.collateral <= 0n || b.supply <= 0n) return { ok: false, reason: 'This bank has no ratio yet (its guild must mint first)' };
  const fee = ceilDiv(b.inFee * alpha, DEC);
  const net = alpha - fee;
  const tokens = (net * b.supply) / b.collateral;
  if (tokens <= 0n) return { ok: false, reason: 'Too small to mint a single token unit' };
  return { ok: true, fee, net, tokens };
}

/** Tokens in → alpha out: gross = floor(tokens × collateral / supply), fee rounds up. */
export function redeemQuote(tokens: bigint, b: BankPool): Quote<{ gross: bigint; fee: bigint; alpha: bigint }> {
  if (tokens <= 0n) return { ok: false, reason: 'Enter an amount' };
  if (b.collateral <= 0n || b.supply <= 0n) return { ok: false, reason: 'This bank has no collateral to redeem against' };
  if (tokens > b.supply) return { ok: false, reason: 'More than the whole supply' };
  const gross = (tokens * b.collateral) / b.supply;
  const fee = ceilDiv(b.outFee * gross, DEC);
  const alpha = gross - fee;
  if (alpha <= 0n) return { ok: false, reason: 'Too small to redeem any alpha' };
  return { ok: true, gross, fee, alpha };
}

/** One token for another: redeem at the source (out fee), convert at the target (in fee). */
export function convertTokenQuote(tokens: bigint, src: BankPool, dst: BankPool): Quote<{ bridge: bigint; tokens: bigint }> {
  const r = redeemQuote(tokens, src);
  if (!r.ok) return r;
  const c = convertQuote(r.alpha, dst);
  if (!c.ok) return c;
  return { ok: true, bridge: r.alpha, tokens: c.tokens };
}

/** Slippage guard: the least we accept, `bps` basis points under the quote (never 0: the chain
 * requires a nonzero minimum). */
export function guardFor(quote: bigint, bps: number): bigint {
  if (quote <= 0n) return 0n;
  const b = BigInt(Math.max(0, Math.min(10_000, Math.round(bps))));
  const g = (quote * (10_000n - b)) / 10_000n;
  return g > 0n ? g : 1n;
}
/** "0.5" (%) → 50 bps; null if not a percentage between 0 and 100 with at most two decimals
 * (a basis point is the guard's resolution: "0.005" is refused, never read as 0 or 0.5). */
export function slippageBps(pct: string): number | null {
  const v = parseDecimal(pct, 2);
  if (v == null || v > 10_000n) return null;
  return Number(v);
}
/** Alpha backing one whole token (6 places), as a display number. */
export const ratio = (b: BankPool) => (b.supply > 0n ? Number((b.collateral * 1_000_000_000n) / b.supply) / 1e9 : 0);

/* ── Energy market (keeper/msg_server_agreement_*.go) ───────────────────── */

export interface Terms { rate: bigint; capMin: bigint; capMax: bigint; durMin: bigint; durMax: bigint }

/** Collateral to open: duration × capacity × rate (rate is per mW per block). */
export const agreementCost = (capacityMw: bigint, durationBlocks: bigint, rate: bigint) => capacityMw * durationBlocks * rate;
/** Extending costs the same rate on the existing capacity. */
export const durationIncreaseCost = (capacityMw: bigint, extraBlocks: bigint, rate: bigint) => capacityMw * extraBlocks * rate;
/** Capacity changes keep the collateral and re-price the remaining span: remaining × old / new. */
export const rescaledDuration = (remaining: bigint, capacity: bigint, newCapacity: bigint) => (newCapacity > 0n ? (remaining * capacity) / newCapacity : 0n);

export const blocksPerDay = (blockSeconds: number) => BigInt(Math.max(1, Math.round(86_400 / (blockSeconds > 0 ? blockSeconds : 6))));
/** Price of one kW for one day, in the rate denom's base units. */
export const ratePerKwDay = (rate: bigint, perDay: bigint) => rate * MW_PER_KW * perDay;

/** Every reason the chain would refuse MsgAgreementOpen for these terms (AgreementVerify, CanOpenAgreement). */
export function agreementProblems(t: Terms, capacity: bigint, duration: bigint, available: bigint | null, policy: string, balance: bigint | null): string[] {
  const out: string[] = [];
  if (policy === 'closedMarket') out.push('This provider is closed to new agreements');
  if (capacity <= 0n) out.push('Enter a capacity');
  else if (capacity < t.capMin) out.push('Below the provider’s minimum capacity');
  else if (capacity > t.capMax) out.push('Above the provider’s maximum capacity');
  if (duration <= 0n) out.push('Enter a duration');
  else if (duration < t.durMin) out.push('Shorter than the provider’s minimum duration');
  else if (duration > t.durMax) out.push('Longer than the provider’s maximum duration');
  if (available != null && capacity > available) out.push('More than the provider’s substation has free');
  if (balance != null && capacity > 0n && duration > 0n && agreementCost(capacity, duration, t.rate) > balance) out.push('Not enough balance for the collateral');
  return out;
}

/** Why the chain would refuse a capacity change (AgreementCache.CapacityIncrease/Decrease): the
 * new capacity must sit in the provider's range, the re-priced span (remaining × old ÷ new) in its
 * duration range, and an increase must fit the substation's free capacity. */
export function capacityChangeProblems(t: Terms, capacity: bigint, newCapacity: bigint, remaining: bigint, available: bigint | null): string[] {
  const out: string[] = [];
  if (newCapacity <= 0n) return ['Capacity must stay above zero'];
  if (newCapacity === capacity) return ['That is the current capacity'];
  if (newCapacity < t.capMin) out.push('Below the provider’s minimum capacity');
  else if (newCapacity > t.capMax) out.push('Above the provider’s maximum capacity');
  const nd = rescaledDuration(remaining, capacity, newCapacity);
  if (nd < t.durMin) out.push('The time left would shrink below the provider’s minimum duration');
  else if (nd > t.durMax) out.push('The time left would stretch past the provider’s maximum duration');
  if (newCapacity > capacity && available != null && newCapacity - capacity > available) out.push('More than the provider’s substation has free');
  return out;
}

/** Why the chain would refuse an extension (AgreementCache.DurationIncrease): the whole span,
 * (end − start) + extra, must stay within the provider's duration range. */
export function extendProblems(t: Terms, startBlock: bigint, endBlock: bigint, extra: bigint): string[] {
  if (extra <= 0n) return ['Enter a duration'];
  if (endBlock < startBlock) return ['This agreement’s window is invalid'];
  const span = endBlock - startBlock + extra;
  if (span > t.durMax) return [`Too long: the agreement may span at most ${t.durMax.toLocaleString()} blocks (it already spans ${(endBlock - startBlock).toLocaleString()})`];
  if (span < t.durMin) return ['Shorter than the provider’s minimum duration'];
  return [];
}

/** A provider's terms from the LCD row. */
export function termsOf(p: { rate: { amount: string }; capacityMinimum: string; capacityMaximum: string; durationMinimum: string; durationMaximum: string }): Terms {
  return { rate: big0(p.rate.amount), capMin: big0(p.capacityMinimum), capMax: big0(p.capacityMaximum), durMin: big0(p.durationMinimum), durMax: big0(p.durationMaximum) };
}

/** uguild.0-3 → 0-3, anything else null. */
export const guildOfDenom = (denom: string) => (/^uguild\.(\d+-\d+)$/.exec(denom)?.[1] ?? null);
