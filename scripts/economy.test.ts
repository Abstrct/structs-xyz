/* The economy's arithmetic: exact unit conversion, grid health, the brownout cascade, infusion
 * yield, guild-bank quotes and guards, and energy-market pricing. Figures marked "chain" were
 * read from the public testnet LCD (block ~3,007,000) and must match to the unit. */
import {
  parseDecimal, formatDecimal, parseAlpha, parsePower, decOf, decPct, gridHealth, connectionShare, cascadeOrder, brownout, pausePlan, whatIf,
  infusionYield, alphaForPower, defusions, convertQuote, redeemQuote, convertTokenQuote, guardFor, slippageBps, ratio, agreementCost,
  durationIncreaseCost, rescaledDuration, blocksPerDay, ratePerKwDay, agreementProblems, termsOf, guildOfDenom, alphaLadder, ceilDiv,
  decimalProblem, capacityChangeProblems, extendProblems,
  type BankPool, type DrawItem,
} from '../src/game/economy';

let failures = 0;
const check = (cond: unknown, msg: string) => { if (!cond) { failures++; console.error('FAIL', msg); } };
const eq = <T>(a: T, b: T, msg: string) => check(a === b, `${msg}: got ${String(a)}, want ${String(b)}`);

/* ── Units: no float drift ──────────────────────────────────────────────── */
eq(parseAlpha('1.5'), 1_500_000n, 'bare numbers are alpha');
eq(parseAlpha('0.3'), 300_000n, '0.3 alpha is exactly 300000 ualpha (0.1 + 0.2 never happens)');
eq(parseAlpha('0.1'), 100_000n, '0.1 alpha');
eq(parseAlpha('250 mg'), 250_000n, 'milligrams');
eq(parseAlpha('2kg'), 2_000_000_000n, 'kilograms, no space');
eq(parseAlpha('1000 ualpha'), 1000n, 'base units pass through');
eq(parseAlpha('3 g'), 3_000_000n, 'grams are alpha');
eq(parseAlpha('1,234.5'), 1_234_500_000n, 'thousands separators');
eq(parseAlpha('123456789.123456'), 123_456_789_123_456n, 'large amounts stay exact');
eq(parseAlpha('9007199254740.993'), 9_007_199_254_740_993_000n, 'past 2^53 stays exact');
eq(parseAlpha('0.0000001'), null, 'finer than a ualpha is refused, not rounded');
eq(parseAlpha('1.5000000'), 1_500_000n, 'trailing zeros past precision are fine');
eq(parseAlpha('1.5 lb'), null, 'unknown unit');
eq(parseAlpha('-1'), null, 'negative');
eq(parseAlpha(''), null, 'empty');
eq(parseAlpha('.5'), 500_000n, 'leading dot');
eq(parseDecimal('12', 0), 12n, 'integers at 0 places');
// Commas only group thousands: anything that could be a decimal comma is refused, never guessed.
eq(parseDecimal('0,5', 2), null, '"0,5" is not 50 (or 0.5): refused');
eq(parseDecimal('1,5', 6), null, '"1,5" is not 15: refused');
eq(parseDecimal('12,34', 6), null, 'two digits after a comma: refused');
eq(parseDecimal('1,2345', 6), null, 'four digits after a comma: refused');
eq(parseDecimal('0,500', 6), null, 'a leading zero group cannot be grouping');
eq(parseDecimal('1.234,5', 6), null, 'a comma after the point: refused');
eq(parseDecimal('1,234,567', 0), 1_234_567n, 'grouped integer');
eq(parseDecimal('12,345.25', 2), 1_234_525n, 'grouped with decimals');
eq(parseAlpha('0,5'), null, 'alpha "0,5" refused');
eq(parseAlpha('1,5 kg'), null, 'alpha "1,5 kg" refused');
eq(parsePower('2,5 kW'), null, 'power "2,5 kW" refused');
check(decimalProblem('0,5')?.includes('point'), 'decimalProblem explains "0,5"');
check(decimalProblem('2,5 kW') != null, 'decimalProblem sees past the unit');
eq(decimalProblem('1,234.5'), null, 'grouping is not a problem');
eq(decimalProblem('0.5'), null, 'a point is not a problem');
eq(decimalProblem(''), null, 'empty is not ambiguous');
eq(parseDecimal('1.2', 0), null, 'fractions at 0 places');
eq(formatDecimal(1_500_000n, 6), '1.5', 'format trims zeros');
eq(formatDecimal(1_000_000n, 6), '1', 'format drops a bare point');
eq(formatDecimal(1_234_567_891n, 6, { group: true, maxFrac: 2 }), '1,234.56', 'group and truncate (never round up)');
eq(formatDecimal(-2_500n, 3), '-2.5', 'negative');
eq(formatDecimal(7n, 0), '7', 'zero places');
for (const s of ['0.000001', '1', '42.42', '1000000.000001']) eq(formatDecimal(parseDecimal(s, 6)!, 6), s, `round trip ${s}`);
eq(alphaLadder(1_500_000n)[2].value, '1.5', 'ladder: alpha rung');
eq(alphaLadder(1_500_000n)[1].value, '1,500', 'ladder: mg rung');

eq(parsePower('1.5 kW'), 1_500_000n, 'kW → mW');
eq(parsePower('500 W'), 500_000n, 'W → mW');
eq(parsePower('1 MW'), 1_000_000_000n, 'MW is megawatts');
eq(parsePower('5 mW'), 5n, 'mW is milliwatts');
eq(parsePower('2'), 2_000_000n, 'bare power is kW');
eq(parsePower('2', 'W'), 2_000n, 'default unit override');
eq(parsePower('1.0000001 kW'), null, 'finer than a mW is refused');

eq(decOf('0.040000000000000000'), 40_000_000_000_000_000n, 'LegacyDec string');
eq(decPct(decOf('0.04')), 4, '4%');
eq(decPct(decOf('0.110000000000000000')), 11, '11%');
eq(decOf(''), 0n, 'empty dec');
eq(ceilDiv(101n, 100n), 2n, 'ceilDiv rounds up');
eq(ceilDiv(100n, 100n), 1n, 'ceilDiv exact');

/* ── Grid health ────────────────────────────────────────────────────────── */
// chain: player 1-194 on substation 4-1.
const p194 = { capacity: 144_612_241_295n, load: 128_101_002_000n, structsLoad: 6_530_000n, connectionCapacity: 8_093_703n };
const g194 = gridHealth(p194);
check(g194.online, '1-194 is online');
eq(g194.headroom, 144_612_241_295n + 8_093_703n - 128_101_002_000n - 6_530_000n, 'headroom = supply − demand');
eq(g194.allocatable, 144_612_241_295n - 128_101_002_000n, 'allocatable = own capacity − load');
eq(g194.state, 'spare', 'lots of headroom is spare');
check(Math.abs(g194.marginPct - 11.41) < 0.01, `margin ${g194.marginPct}`);
// chain: substation 4-1 shares 29,614,860,000 mW among 3,659 connections → 8,093,703 each.
eq(connectionShare(29_614_860_000n, 0n, 3659n), 8_093_703n, 'connection share matches the chain');
eq(connectionShare(10n, 20n, 3n), 0n, 'over-allocated substation shares nothing');
eq(connectionShare(10n, 0n, 0n), 0n, 'no connections');
const edge = gridHealth({ capacity: 1_000_000n, load: 0n, structsLoad: 1_000_000n, connectionCapacity: 0n });
check(edge.online && edge.headroom === 0n, 'exactly at capacity is still online (≤)');
eq(edge.state, 'thin', 'zero headroom is thin');
const dark = gridHealth({ capacity: 0n, load: 0n, structsLoad: 25_000n, connectionCapacity: 0n });
check(!dark.online && dark.state === 'dark', 'base draw with no supply is dark');
eq(gridHealth({ capacity: 0n, load: 0n, structsLoad: 25_000n, connectionCapacity: 1_000_000n + 24_999n }).state, 'thin', 'under two builds of room is thin');
eq(gridHealth({ capacity: 0n, load: 0n, structsLoad: 25_000n, connectionCapacity: 2_000_000n + 25_000n }).state, 'healthy', 'shared power is never spare (only own capacity can be allocated)');

/* ── Brownout ───────────────────────────────────────────────────────────── */
const ord = cascadeOrder([{ id: '6-2' }, { id: '6-10' }, { id: '6-1' }, { id: '6-53' }, { id: '6-100' }]).map((a) => a.id);
eq(ord.join(','), '6-1,6-10,6-100,6-2,6-53', 'cascade walks ids in byte order, like the KV store');
const allocs = [{ id: '6-2', power: 30n }, { id: '6-10', power: 40n }, { id: '6-1', power: 10n }];
const b1 = brownout(100n, 150n, allocs);
eq(b1.victims.map((v) => v.id).join(','), '6-1,6-10', 'cuts in cascade order until load ≤ capacity');
eq(b1.loadAfter, 100n, 'load after the cut');
check(!b1.stillOver, 'cascade restored the balance');
eq(brownout(100n, 100n, allocs).victims.length, 0, 'at capacity nothing is cut');
const b2 = brownout(0n, 150n, allocs);
check(b2.victims.length === 3 && b2.stillOver, 'not enough allocations to shed: still over');

const items: DrawItem[] = [
  { id: '5-1', name: 'Command Ship', draw: 50_000n, kind: 'command' },
  { id: '5-2', name: 'Ore Extractor', draw: 500_000n, kind: 'production' },
  { id: '5-3', name: 'Frigate', draw: 75_000n, kind: 'fleet' },
  { id: '5-4', name: 'Battleship', draw: 135_000n, kind: 'fleet' },
  { id: '5-5', name: 'PDC', draw: 600_000n, kind: 'planet' },
];
const pp = pausePlan(150_000n, items);
eq(pp.plan.map((p) => p.id).join(','), '5-4,5-3', 'fleet hulls first, biggest first');
check(pp.covered, 'covered');
const pp2 = pausePlan(2_000_000n, items);
eq(pp2.plan.map((p) => p.id).join(','), '5-4,5-3,5-5,5-2', 'then planetary, then production; never the Command Ship');
check(!pp2.covered, 'cannot cover more than the switchable draw');
eq(pausePlan(0n, items).plan.length, 0, 'nothing to do with no deficit');

const w = whatIf({ capacity: 1_000n, load: 800n, structsLoad: 300n, connectionCapacity: 200n }, 500n, [{ id: '6-5', power: 300n }, { id: '6-40', power: 500n }],
  [{ id: '5-9', name: 'Tank', draw: 75n, kind: 'fleet' }, { id: '5-8', name: 'Cmd', draw: 50n, kind: 'command' }]);
eq(w.capacity, 500n, 'what-if capacity');
eq(w.cascade.victims.map((v) => v.id).join(','), '6-40', '6-40 sorts before 6-5 and covers it alone');
eq(w.cascade.loadAfter, 300n, 'load after');
eq(w.after.headroom, 500n + 200n - 300n - 300n, 'headroom after');
check(w.after.online && w.deficit === 0n, 'stays online');
// Feeding your own substation: losing that allocation shrinks your own share too.
const own = whatIf({ capacity: 1_000n, load: 900n, structsLoad: 100n, connectionCapacity: 100n }, 1_000n, [{ id: '6-1', power: 900n, destinationId: '4-1' }],
  [{ id: '5-3', name: 'Frigate', draw: 75n, kind: 'fleet' }], { id: '4-1', capacity: 1_000n, load: 0n, connections: 10n });
eq(own.subLoss, 900n, 'the substation loses what the cut allocation carried');
eq(own.share, 10n, 'share falls to (1000 − 900) / 10');
check(!own.after.online && own.deficit === 90n, `the player goes dark: deficit ${own.deficit}`);
eq(own.pause.plan.map((p) => p.id).join(','), '5-3', 'and must power down the frigate');
check(!own.pause.covered, '…which is not enough');

/* ── Infusion ───────────────────────────────────────────────────────────── */
// chain: reactor 3-1 holds 3,406,001,349 fuel at 4% and shows 136,240,054 mW of its own capacity.
const y = infusionYield(3_406_001_349n, decOf('0.04'));
eq(y.reactor, 136_240_054n, 'reactor cut matches the chain');
eq(y.player + y.reactor, 3_406_001_349n, '1 ualpha = 1 mW, split between player and reactor');
eq(infusionYield(3_000_000n, decOf('0.04')).player, 2_880_000n, '3 alpha → 2.88 kW for the player');
const need = alphaForPower(2_880_000n, decOf('0.04'));
eq(need, 3_000_000n, 'alpha needed for 2.88 kW at 4%');
check(infusionYield(alphaForPower(1_234_567n, decOf('0.07')), decOf('0.07')).player >= 1_234_567n, 'alphaForPower never falls short');
const d = defusions({ unbonding_responses: [{ validator_address: 'v1', entries: [
  { creation_height: '20', completion_time: '2026-10-12T00:00:00Z', initial_balance: '5', balance: '5' },
  { creation_height: '10', completion_time: '2026-10-11T00:00:00Z', initial_balance: '7', balance: '6' }] }] });
eq(d.map((x) => x.creationHeight).join(','), '10,20', 'defusions sorted by completion');
eq(d[0].balance, 6n, 'defusion balance');
eq(defusions({}).length, 0, 'no unbondings');

/* ── Guild banks ────────────────────────────────────────────────────────── */
// chain: guild 0-1's pool holds 20,990,008 ualpha against 1,111,001,633,249 uguild.0-1.
const oh: BankPool = { collateral: 20_990_008n, supply: 1_111_001_633_249n, inFee: 0n, outFee: 0n };
const c1 = convertQuote(1_000_000n, oh);
check(c1.ok && c1.tokens === (1_000_000n * oh.supply) / oh.collateral, 'convert = floor(alpha × supply / collateral)');
const r1 = redeemQuote(c1.ok ? c1.tokens : 0n, oh);
check(r1.ok && r1.alpha <= 1_000_000n && r1.alpha >= 999_999n, 'a round trip never gains and loses at most a unit');
const fee: BankPool = { collateral: 1_000n, supply: 2_000n, inFee: decOf('0.01'), outFee: decOf('0.025') };
const c2 = convertQuote(101n, fee);
check(c2.ok && c2.fee === 2n && c2.net === 99n && c2.tokens === 198n, `in fee rounds up for the pool: ${JSON.stringify(c2, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
const r2 = redeemQuote(400n, fee);
check(r2.ok && r2.gross === 200n && r2.fee === 5n && r2.alpha === 195n, 'out fee on the gross, rounded up');
check(!convertQuote(1n, { collateral: 0n, supply: 0n, inFee: 0n, outFee: 0n }).ok, 'an unopened bank has no ratio');
check(!convertQuote(1n, { collateral: 1_000_000n, supply: 1n, inFee: 0n, outFee: 0n }).ok, 'too small to mint a unit');
check(!redeemQuote(3_000n, fee).ok, 'cannot redeem more than the supply');
check(!convertQuote(0n, oh).ok, 'zero amount');
const sw = convertTokenQuote(400n, fee, oh);
check(sw.ok && sw.bridge === 195n && sw.tokens === (195n * oh.supply) / oh.collateral, 'swap = redeem at source then convert at target');
eq(guardFor(1_000n, 50), 995n, '0.5% guard');
eq(guardFor(1n, 50), 1n, 'the guard is never zero (the chain requires a positive minimum)');
eq(guardFor(1_000n, 0), 1_000n, 'zero slippage');
eq(guardFor(0n, 50), 0n, 'nothing quoted');
eq(slippageBps('0.5'), 50, '0.5% → 50 bps');
eq(slippageBps('3'), 300, '3% → 300 bps');
eq(slippageBps('101'), null, 'over 100% refused');
eq(slippageBps('0.001'), null, 'finer than a basis point refused');
eq(slippageBps('0.005'), null, '"0.005" refused (not silently 50 bps)');
eq(slippageBps('150'), null, '"150" refused (not silently 50 bps)');
eq(slippageBps('0,5'), null, '"0,5" refused, not 50% (5000 bps)');
eq(slippageBps('1,5'), null, '"1,5" refused, not 15%');
eq(slippageBps('0'), 0, '0% is a valid (exact) guard');
eq(slippageBps('100'), 10_000, '100% is the ceiling');
check(Math.abs(ratio(oh) - 20_990_008 / 1_111_001_633_249) < 1e-9, 'ratio is alpha per token');

/* ── Energy market ──────────────────────────────────────────────────────── */
eq(agreementCost(1_000_000n, 100n, 1n), 100_000_000n, 'collateral = capacity × duration × rate');
eq(durationIncreaseCost(2_000_000n, 50n, 3n), 300_000_000n, 'extension cost');
eq(rescaledDuration(1_000n, 2_000_000n, 4_000_000n), 500n, 'doubling capacity halves the time left');
eq(rescaledDuration(999n, 3n, 2n), 1498n, 'rescaling floors');
eq(blocksPerDay(5.3), 16_302n, 'blocks per day at 5.3 s');
eq(blocksPerDay(0), 14_400n, 'unknown block time falls back to 6 s');
eq(ratePerKwDay(1n, 16_302n), 16_302_000_000n, 'price of a kW·day at rate 1');
// chain: provider 10-3's terms.
const t3 = termsOf({ rate: { amount: '1' }, capacityMinimum: '1000000', capacityMaximum: '12906666', durationMinimum: '100', durationMaximum: '1000000' });
eq(agreementProblems(t3, 2_000_000n, 1_000n, 5_000_000n, 'openMarket', 10n ** 12n).length, 0, 'valid terms pass');
eq(agreementProblems(t3, 500_000n, 1_000n, null, 'openMarket', null)[0], 'Below the provider’s minimum capacity', 'below minimum');
eq(agreementProblems(t3, 2_000_000n, 50n, null, 'openMarket', null)[0], 'Shorter than the provider’s minimum duration', 'too short');
eq(agreementProblems(t3, 2_000_000n, 1_000n, 1_000_000n, 'openMarket', null)[0], 'More than the provider’s substation has free', 'substation full');
eq(agreementProblems(t3, 2_000_000n, 1_000n, null, 'openMarket', 1n)[0], 'Not enough balance for the collateral', 'balance');
eq(agreementProblems(t3, 2_000_000n, 1_000n, null, 'closedMarket', null)[0], 'This provider is closed to new agreements', 'closed');

// Capacity changes: range, re-priced span (remaining × old ÷ new) and substation room.
eq(capacityChangeProblems(t3, 2_000_000n, 4_000_000n, 1_000n, 5_000_000n).length, 0, 'double capacity, half the span: fine');
eq(capacityChangeProblems(t3, 2_000_000n, 4_000_000n, 150n, 5_000_000n)[0], 'The time left would shrink below the provider’s minimum duration', 'span 75 < 100');
eq(capacityChangeProblems(t3, 12_000_000n, 1_000_000n, 900_000n, null)[0], 'The time left would stretch past the provider’s maximum duration', 'span 10.8M > 1M');
eq(capacityChangeProblems(t3, 2_000_000n, 4_000_000n, 1_000n, 1_000_000n)[0], 'More than the provider’s substation has free', 'increase of 2 kW into 1 kW free');
eq(capacityChangeProblems(t3, 2_000_000n, 1_500_000n, 1_000n, 0n).length, 0, 'a decrease ignores free room');
eq(capacityChangeProblems(t3, 2_000_000n, 500_000n, 1_000n, null)[0], 'Below the provider’s minimum capacity', 'below minimum');
eq(capacityChangeProblems(t3, 2_000_000n, 0n, 1_000n, null)[0], 'Capacity must stay above zero', 'zero');
eq(capacityChangeProblems(t3, 2_000_000n, 2_000_000n, 1_000n, null)[0], 'That is the current capacity', 'no change');
// Extensions: the whole window (end − start + extra) must stay ≤ the maximum.
eq(extendProblems(t3, 100n, 600_100n, 400_000n).length, 0, 'exactly the maximum');
check(extendProblems(t3, 100n, 600_100n, 400_001n)[0]?.startsWith('Too long'), 'one block past the maximum');
eq(extendProblems(t3, 100n, 600_100n, 0n)[0], 'Enter a duration', 'zero extension');
eq(guildOfDenom('uguild.0-3'), '0-3', 'guild denom');
eq(guildOfDenom('ualpha'), null, 'alpha is not a guild denom');

/* ── Live reads only while someone looks ────────────────────────────────── */
// The full economy is a dozen LCD lists: leaving the screen must stop the chain triggers that reload it.
{
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
  const g = globalThis as Record<string, unknown>;
  g.localStorage = mem();
  g.window = Object.assign(new EventTarget(), { setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout });
  const { eco } = await import('../src/ui/economy/data');
  const { live } = await import('../src/chain/live');
  const { txq } = await import('../src/wallet/queue');
  const { wallet } = await import('../src/wallet/wallet');
  const sizes = () => {
    const x = (o: unknown, k: string) => ((o as Record<string, Set<unknown>>)[k]).size;
    return [x(live, 'blockL'), x(live, 'txL'), x(txq, 'doneL'), x(wallet, 'listeners')].join();
  };
  const idle = sizes();
  const a = eco.onChange(() => {});
  const bound = sizes();
  check(bound !== idle, 'the first listener binds the chain triggers');
  const b = eco.onChange(() => {});
  eq(sizes(), bound, 'a second listener binds nothing more');
  a();
  eq(sizes(), bound, 'still bound while one listens');
  a();
  eq(sizes(), bound, 'a repeated unsubscribe is harmless');
  b();
  eq(sizes(), idle, 'the last listener leaving unbinds everything');
  const c = eco.onChange(() => {});
  eq(sizes(), bound, 'coming back binds again');
  c();
}

if (failures) { console.error(`economy: ${failures} failure(s)`); process.exit(1); }
console.log('economy: all checks passed');
// The live/queue modules imported above keep timers of their own.
process.exit(0);
