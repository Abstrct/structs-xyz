/* Matchup practice: endless yes/no questions made from the real unit data. "Can a Tank in Land
 * hit a Starfighter in Space?" The answer comes from the same reach rules the battles use
 * (canTargetAmbit), so practising here is practising the game. Stealth is left out: it is its
 * own lesson. Browser-free: tests import it under node. */
import { STRUCT_TYPES, WEAPON_SYSTEMS, AMBIT_NAME, ambitsOf, canTargetAmbit, hasWeapon, reachLabel, weaponLabel, type Ambit, type StructType } from '../data/catalogue';

export interface MatchupQuestion { q: string; yes: boolean; why: string; attacker: number; defender: number }

const FLEET = STRUCT_TYPES.filter((t) => t.category === 'fleet');
const ARMED = FLEET.filter((t) => WEAPON_SYSTEMS.some((ws) => hasWeapon(t, ws)));

/** Whether `a` operating in `from` has any weapon that reaches `to`. */
export function canHit(a: StructType, from: Ambit, to: Ambit): boolean {
  return WEAPON_SYSTEMS.some((ws) => hasWeapon(a, ws) && canTargetAmbit(a, ws, from, to));
}

/** A fresh question; about half the answers are yes. `rand` defaults to Math.random. */
export function matchupQuestion(rand: () => number = Math.random): MatchupQuestion {
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const wantYes = rand() < 0.5;
  let last: MatchupQuestion | null = null;
  for (let i = 0; i < 60; i++) {
    const a = pick(ARMED), b = pick(FLEET.filter((t) => t.id !== a.id));
    const from = pick(ambitsOf(a.possibleAmbit)), to = pick(ambitsOf(b.possibleAmbit));
    if (!from || !to) continue;
    const yes = canHit(a, from, to);
    const reach = WEAPON_SYSTEMS.filter((ws) => hasWeapon(a, ws)).map((ws) => `${weaponLabel(a, ws)} reaches ${reachLabel(a, ws) === 'Its own layer' ? `its own layer (${AMBIT_NAME[from]})` : reachLabel(a, ws)}`).join('; ');
    last = {
      q: `Can a ${a.type} in ${AMBIT_NAME[from]} hit a ${b.type} in ${AMBIT_NAME[to]}?`,
      yes,
      why: `${yes ? 'Yes' : 'No'}: its ${reach}. The ${b.type} is in ${AMBIT_NAME[to]}.`,
      attacker: a.id, defender: b.id,
    };
    if (yes === wantYes) return last;
  }
  return last!;
}

/* Price practice: what does energy cost? kW × days × price, with friendly numbers. */
export interface PriceQuestion { q: string; choices: string[]; answer: number; why: string }

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

export function priceQuestion(rand: () => number = Math.random): PriceQuestion {
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const kw = pick([1, 2, 3, 4, 5]), days = pick([1, 2, 3, 4, 7]), price = pick([0.25, 0.5, 1, 2, 3]);
  const total = kw * days * price;
  // Wrong answers people really make: forgetting a factor, or adding instead of multiplying.
  const wrong = [kw * price, days * price, kw + days + price, kw * days].map(fmt).filter((w) => w !== fmt(total));
  const opts = [...new Set([fmt(total), ...wrong])].slice(0, 3);
  // Too few distinct slips (small numbers): pad with nearby totals that aren't already there.
  for (let k = 2; opts.length < 3; k++) { const c = fmt(total * k); if (!opts.includes(c)) opts.push(c); }
  // Shuffle so the right answer moves around.
  for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [opts[i], opts[j]] = [opts[j], opts[i]]; }
  return {
    q: `Energy costs ${fmt(price)} alpha per kW per day. You need ${kw} kW for ${days} day${days === 1 ? '' : 's'}. What does it cost?`,
    choices: opts.map((o) => `${o} alpha`),
    answer: opts.indexOf(fmt(total)),
    why: `${kw} kW × ${days} day${days === 1 ? '' : 's'} × ${fmt(price)} alpha = ${fmt(total)} alpha.`,
  };
}

/* Code practice: run a simplified copy of the robots' program (Robot Rules) in your head. A helper's situation,
 * four possible moves; the first rule that fits wins, top to bottom, as decide() does. */
export interface CodeQuestion { q: string; choices: string[]; answer: number; why: string }

type Job = 'productive' | 'bait' | 'raider';
export interface Situation { job: Job; planetUsedUp: boolean; machineOff: boolean; missing: boolean; building: boolean; alpha: number; keep: number; rally: string }

/** The move the Robot Rules program picks (mirrors the order of src/game/replicants.ts decide()). */
export function robotMove(s: Situation): string {
  if (s.planetUsedUp) return 'explore()';
  if (s.machineOff) return 'switchOn(machine)';
  // decide() builds nothing new while something is still under construction (one proof at a time).
  if (s.missing && !s.building) return 'build(next one)';
  if (s.job === 'raider') return `sail("${s.rally || 'home'}")`;
  if (s.job === 'productive' && s.alpha > s.keep + 0.1) return `sendHome(${Math.round((s.alpha - s.keep) * 100) / 100})`;
  return 'wait()';
}

export function codeQuestion(rand: () => number = Math.random): CodeQuestion {
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const job = pick<Job>(['productive', 'productive', 'bait', 'raider']);
  const s: Situation = {
    job,
    planetUsedUp: rand() < 0.15, machineOff: rand() < 0.25, missing: rand() < 0.3, building: false,
    alpha: pick([0, 1, 3, 5, 8]), keep: pick([2, 4]), rally: job === 'raider' ? pick(['', '', '2-7']) : '',
  };
  s.building = s.missing && rand() < 0.35;
  const move = robotMove(s);
  const facts = [
    `job is "${s.job}"`,
    s.planetUsedUp ? 'its planet is used up' : 'its planet still has ore',
    s.machineOff ? 'a machine is switched off (and there is power for it)' : 'all its machines are on',
    s.missing ? (s.building ? 'it is missing a machine from its list, but another one is still being built' : 'it is missing a machine from its list and nothing is being built') : 'everything on its list is built',
    `it holds ${s.alpha} alpha`,
    `keep (the “send alpha home above” setting) is ${s.keep}`,
    ...(s.job === 'raider' ? [s.rally ? `the meeting point is ${s.rally}` : 'the meeting point is empty'] : []),
  ];
  const pool = ['explore()', 'switchOn(machine)', 'build(next one)', `sail("${s.rally || 'home'}")`, `sendHome(${Math.max(1, Math.round((s.alpha - s.keep) * 100) / 100)})`, 'wait()'];
  const opts = [move, ...pool.filter((p) => p !== move).sort(() => rand() - 0.5).slice(0, 3)];
  for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [opts[i], opts[j]] = [opts[j], opts[i]]; }
  const busy = s.missing && s.building ? 'A machine is missing, but another one is still being built, so the build rule doesn’t fit. ' : '';
  const why = s.planetUsedUp ? 'The first rule fits: the planet is used up, so it explores.'
    : s.machineOff ? 'The planet rule doesn’t fit, but the next one does: a machine is off, so it switches it on.'
    : s.missing && !s.building ? 'The first two rules don’t fit; a machine is missing and nothing is being built, so it builds.'
    : busy + (s.job === 'raider' ? `No earlier rule fits, so the raider rule runs: sail to ${s.rally || 'home'}.`
      : move.startsWith('sendHome') ? `No earlier rule fits. It’s productive and ${s.alpha} > ${s.keep} + 0.1, so it sends ${s.alpha} − ${s.keep} home.`
      : s.job === 'productive' ? `No rule fits: ${s.alpha} alpha isn’t more than ${s.keep} + 0.1, so it waits.` : 'No rule fits this bait helper, so it waits.');
  return { q: `A helper: ${facts.join('; ')}. Which line of the program runs?`, choices: opts, answer: opts.indexOf(move), why };
}
