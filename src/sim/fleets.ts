/* Fleet layouts for the battle simulator: the presets the desktop simulator
 * ships (Easy / Difficult / Hard / Random), validation, and the chain setup. */
import { AMBIT_FLAG, AMBITS, type Ambit, COMMAND_SHIP_ID, STRUCT_TYPES, TYPES_BY_ID } from '../data/catalogue';
import { rngFor } from '../core/util';
import type { ChainSetup, Msg } from './chain';
import type { Difficulty } from './ai';

export type Side = 'player' | 'computer';
export interface Unit { id: string; side: Side; type: number; ambit: Ambit; slot: number; protects: string | null; /** Starting hull points (default: full). */ health?: number }
export type Preset = 'easy' | 'difficult' | 'hard' | 'random';

export const SIDES: Side[] = ['player', 'computer'];
export const FLEET_TYPES = STRUCT_TYPES.filter((t) => t.category === 'fleet');
export const YOU = { id: '1-1', fleetId: '9-1', name: 'You', pfp: '{"background":3,"arms":12,"body":21,"neck":4,"head":33}' };
export const CPU = { id: '1-2', fleetId: '9-2', name: 'Computer', pfp: '{"background":5,"arms":7,"body":40,"neck":8,"head":61}' };
export const PRESETS: { id: Preset; name: string; enemy: string; note: string }[] = [
  { id: 'easy', name: 'Easy', enemy: '4', note: 'A thin picket. Learn the ropes.' },
  { id: 'difficult', name: 'Difficult', enemy: '8', note: 'Even fleets, guarded flagship.' },
  { id: 'hard', name: 'Hard', enemy: '12', note: 'Outnumbered. Flagships in orbit.' },
  { id: 'random', name: 'Random', enemy: '6–16', note: 'Two random fleets, any layer.' },
];
export const MAX_CHARGE = 30;

export const fits = (typeId: number, ambit: Ambit) => (TYPES_BY_ID[typeId].possibleAmbit & AMBIT_FLAG[ambit]) !== 0;
export const unitId = (side: Side, typeId: number, ambit: Ambit, slot: number) => side + '-' + (typeId === COMMAND_SHIP_ID ? 'cmd' : ambit + '-' + slot);
const fleetTypesFor = (ambit: Ambit) => FLEET_TYPES.map((t) => t.id).filter((id) => id !== COMMAND_SHIP_ID && fits(id, ambit));

/* Random: each fleet its own size (6–16 structs, Command Ship included),
 * and roughly a third of the hulls defend a random struct of their fleet. */
function randomFleet(side: Side, random: () => number, size?: number): Unit[] {
  const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
  const shuffle = <T,>(list: T[]) => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const total = Math.min(17, size ?? 6 + Math.floor(random() * 11));
  const cmd: Unit = { id: unitId(side, COMMAND_SHIP_ID, 'space', 0), side, type: COMMAND_SHIP_ID, ambit: pick(AMBITS.filter((a) => fits(COMMAND_SHIP_ID, a))), slot: 0, protects: null };
  const cells: { ambit: Ambit; slot: number }[] = [];
  for (const ambit of AMBITS) for (let i = 0; i < 4; i++) cells.push({ ambit, slot: i });
  const units = shuffle(cells).slice(0, total - 1).map((c) => {
    const type = pick(fleetTypesFor(c.ambit));
    return { id: unitId(side, type, c.ambit, c.slot), side, type, ambit: c.ambit, slot: c.slot, protects: null } as Unit;
  });
  const fleet = [cmd, ...units];
  const guards = shuffle(units.filter((u) => TYPES_BY_ID[u.type].canDefend));
  const share = 0.2 + random() * 0.3;
  for (const u of guards.slice(0, Math.max(units.length ? 1 : 0, Math.round(units.length * share)))) {
    u.protects = pick(fleet.filter((v) => v !== u)).id;
  }
  return fleet;
}

export function layout(mode: Preset, seed: string): Unit[] {
  const random = rngFor(seed);
  let units: Unit[] = [];
  if (mode === 'random') {
    for (const side of SIDES) units = units.concat(randomFleet(side, random));
    return units;
  }
  for (const side of SIDES) {
    // Easy and Difficult open with the Command Ships on land; Hard keeps them in space.
    const cmdAmbit: Ambit = mode === 'hard' ? 'space' : 'land';
    units.push({ id: unitId(side, COMMAND_SHIP_ID, cmdAmbit, 0), side, type: COMMAND_SHIP_ID, ambit: cmdAmbit, slot: 0, protects: null });
    for (const ambit of AMBITS) {
      const types = fleetTypesFor(ambit);
      const count = side === 'player' ? 2 : mode === 'easy' ? 1 : mode === 'hard' ? 3 : 2;
      for (let i = 0; i < count; i++) {
        const type = types[i % types.length];
        const u: Unit = { id: unitId(side, type, ambit, i), side, type, ambit, slot: i, protects: null };
        if (mode !== 'easy' && i === 0 && ambit === cmdAmbit && TYPES_BY_ID[type].canDefend) u.protects = unitId(side, COMMAND_SHIP_ID, cmdAmbit, 0);
        units.push(u);
      }
    }
  }
  return units;
}

export function validate(units: Unit[]): string | null {
  // Ids are derived from side, battleground and slot; a code that says otherwise could alias two hulls.
  if (new Set(units.map((u) => u.id)).size !== units.length) return 'Two structs share an id.';
  if (units.some((u) => !SIDES.includes(u.side) || u.id !== unitId(u.side, u.type, u.ambit, u.slot))) return 'A struct id does not match its slot.';
  for (const side of SIDES) {
    if (units.filter((u) => u.side === side && u.type === COMMAND_SHIP_ID).length !== 1) return 'Each fleet needs exactly one Command Ship.';
  }
  const seen = new Set<string>();
  for (const u of units) {
    if (!TYPES_BY_ID[u.type] || TYPES_BY_ID[u.type].category !== 'fleet') return 'Only fleet structs can join a battle.';
    if (!fits(u.type, u.ambit)) return `${TYPES_BY_ID[u.type].type} cannot operate in ${u.ambit}.`;
    if (u.type !== COMMAND_SHIP_ID) {
      const k = u.side + u.ambit + u.slot;
      if (seen.has(k) || u.slot < 0 || u.slot > 3) return 'Two structs share a slot.';
      seen.add(k);
    }
    if (u.protects) {
      const ward = units.find((w) => w.id === u.protects);
      if (!ward || ward.side !== u.side || ward === u) return 'A defender guards a struct of its own fleet.';
    }
  }
  return null;
}

/** The chain's view of a layout: ids become real struct ids (5-n). */
export function chainSetup(units: Unit[], seed: string, charge: { player: number; computer: number }): { setup: ChainSetup; idMap: Record<string, string> } {
  const idMap: Record<string, string> = {};
  let n = 101;
  const ordered = units.slice().sort((a, b) => (a.side === b.side ? 0 : a.side === 'player' ? -1 : 1));
  for (const u of ordered) idMap[u.id] = '5-' + (n++);
  return {
    idMap,
    setup: {
      types: STRUCT_TYPES,
      seed,
      height: 1000,
      planetId: '2-0',
      players: [
        { id: YOU.id, name: YOU.name, fleetId: YOU.fleetId, charge: charge.player },
        { id: CPU.id, name: CPU.name, fleetId: CPU.fleetId, charge: charge.computer },
      ],
      structs: ordered.map((u) => ({ id: idMap[u.id], typeId: u.type, owner: u.side === 'player' ? YOU.id : CPU.id, ambit: u.ambit, slot: u.slot, protects: u.protects ? idMap[u.protects] : null, health: u.health })),
    },
  };
}

export const DIFFICULTY_FOR: Record<Preset, Difficulty> = { easy: 'easy', difficult: 'difficult', hard: 'hard', random: 'difficult' };

/* ── Battle codes: a layout in a URL (#/sim/<code>) ─────────────────────── */
export interface BattleCode { units: Unit[]; difficulty?: Difficulty; blockMs?: number; title?: string }

export function encodeBattle(c: BattleCode): string {
  // Hull damage rides along as an optional sixth field (older codes simply have five).
  const o = { u: c.units.map((u) => (u.health != null ? [u.id, u.type, u.ambit, u.slot, u.protects, u.health] : [u.id, u.type, u.ambit, u.slot, u.protects])), d: c.difficulty, b: c.blockMs, t: c.title };
  return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBattle(code: string): BattleCode | null {
  try {
    const o = JSON.parse(decodeURIComponent(escape(atob(code.replace(/-/g, '+').replace(/_/g, '/')))));
    if (!o || !Array.isArray(o.u) || o.u.length > 40) return null;
    const units: Unit[] = o.u.map((r: [string, number, Ambit, number, string | null, number?]) => ({
      id: r[0], side: String(r[0]).startsWith('player') ? 'player' : 'computer', type: Number(r[1]), ambit: r[2], slot: Number(r[3]), protects: r[4] || null,
      health: r[5] == null ? undefined : r[5],
    }));
    // Shared links are untrusted: whole slots, unique ids, a sane block time, health within the hull.
    if (units.some((u) => !Number.isInteger(u.slot) || typeof u.id !== 'string')) return null;
    if (units.some((u) => u.health != null && (!Number.isInteger(u.health) || u.health < 1 || !TYPES_BY_ID[u.type] || u.health > TYPES_BY_ID[u.type].maxHealth))) return null;
    if (new Set(units.map((u) => u.id)).size !== units.length) return null;
    if (validate(units)) return null;
    const blockMs = o.b === 2000 || o.b === 6000 ? o.b : undefined;
    const difficulty = o.d === 'easy' || o.d === 'difficult' || o.d === 'hard' ? o.d : undefined;
    return { units, difficulty, blockMs, title: typeof o.t === 'string' ? o.t.slice(0, 80) : undefined };
  } catch { return null; }
}

/** A real fleet from the chain as one side of a simulated battle: its
 * fleet-type hulls in their slots, its Command Ship, and the guard
 * assignments read from each struct's defenders. */
export interface ChainFleetInput {
  slots: Record<Ambit, string[]>;
  commandStruct: string;
  structs: Map<string, { type: number; ambit: Ambit; destroyed: boolean; defenders: string[]; health?: number }>;
}
export function unitsFromChainFleet(f: ChainFleetInput, side: Side): { units: Unit[]; problem: string | null } {
  const units: Unit[] = [];
  const byStruct = new Map<string, Unit>();
  const cmd = f.structs.get(f.commandStruct);
  if (!cmd || cmd.destroyed) return { units: [], problem: 'it has no Command Ship' };
  // Damage carries over from the chain (full hulls stay undefined, i.e. full).
  const hp = (type: number, h?: number) => (h != null && h >= 1 && h < TYPES_BY_ID[type].maxHealth ? Math.round(h) : undefined);
  const cu: Unit = { id: unitId(side, COMMAND_SHIP_ID, cmd.ambit, 0), side, type: COMMAND_SHIP_ID, ambit: cmd.ambit, slot: 0, protects: null, health: hp(COMMAND_SHIP_ID, cmd.health) };
  units.push(cu);
  byStruct.set(f.commandStruct, cu);
  for (const ambit of AMBITS) {
    (f.slots[ambit] || []).forEach((sid, slot) => {
      const s = sid ? f.structs.get(sid) : undefined;
      if (!s || s.destroyed || !TYPES_BY_ID[s.type] || TYPES_BY_ID[s.type].category !== 'fleet' || s.type === COMMAND_SHIP_ID) return;
      const u: Unit = { id: unitId(side, s.type, ambit, slot), side, type: s.type, ambit, slot, protects: null, health: hp(s.type, s.health) };
      units.push(u);
      byStruct.set(sid, u);
    });
  }
  for (const [sid, s] of f.structs) {
    const ward = byStruct.get(sid);
    if (!ward) continue;
    for (const d of s.defenders) {
      const du = byStruct.get(d);
      if (du && du !== ward && TYPES_BY_ID[du.type].canDefend) du.protects = ward.id;
    }
  }
  return { units, problem: null };
}

/** The same fleet flown by the other side. */
export function mirrorUnits(units: Unit[], side: Side): Unit[] {
  const swap = (id: string) => id.replace(/^(player|computer)-/, side + '-');
  return units.map((u) => ({ ...u, id: swap(u.id), side, protects: u.protects ? swap(u.protects) : null }));
}

/* ── Gauntlet: five escalating engagements, losses carry over ───────────── */
/* The run ramps: a picket, then fleets that grow before the computer gets sharper, and a hard
 * armada to finish. Tuned on the studio soak (scripts/studio/soak.test.ts), where the Hard autopilot
 * clears round 3 about two runs in three and round 4 about half the time; round 5 is the boss. */
export const GAUNTLET_ROUNDS: { preset: Preset; difficulty: Difficulty; name: string; minEnemy?: number }[] = [
  { preset: 'easy', difficulty: 'easy', name: 'Picket' },
  { preset: 'random', difficulty: 'easy', name: 'Patrol' },
  { preset: 'difficult', difficulty: 'easy', name: 'Ambush' },
  { preset: 'difficult', difficulty: 'difficult', name: 'Blockade' },
  { preset: 'random', difficulty: 'hard', name: 'Armada', minEnemy: 10 },
];

/** The boss round's largest fleet against `players` ships of yours: a fifth more, and at least two more. */
export function bossCap(players: number) { return Math.max(Math.ceil(players * 1.2), players + 2); }

/** A round's enemy. `players` (your fleet's size, when known): the boss round is capped at bossCap(players)
 * (their Command Ship always stays; guards of a ship left out stand down). */
export function gauntletEnemy(round: number, seed: string, players?: number): Unit[] {
  const enemy = gauntletEnemyFull(round, seed);
  if (!players || round < GAUNTLET_ROUNDS.length) return enemy;
  const max = bossCap(players);
  if (enemy.length <= max) return enemy;
  const cs = enemy.filter((u) => u.type === COMMAND_SHIP_ID);
  const rest = enemy.filter((u) => u.type !== COMMAND_SHIP_ID).sort((a, b) => a.slot - b.slot || AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit));
  const kept = [...cs, ...rest.slice(0, Math.max(0, max - cs.length))], ids = new Set(kept.map((u) => u.id));
  return kept.map((u) => (u.protects && !ids.has(u.protects) ? { ...u, protects: null } : u));
}
function gauntletEnemyFull(round: number, seed: string): Unit[] {
  const r = GAUNTLET_ROUNDS[Math.min(round, GAUNTLET_ROUNDS.length) - 1];
  // Random rounds reroll until the enemy is at least as big as the round demands.
  const min = r.minEnemy || 0;
  for (let i = 0; i < 40; i++) {
    const enemy = layout(r.preset, seed + ':g' + round + ':' + i).filter((u) => u.side === 'computer');
    if (enemy.length >= min) return enemy;
  }
  return layout('hard', seed + ':g' + round).filter((u) => u.side === 'computer');
}

/** Three reinforcement offers that fit somewhere in the fleet. */
export function reinforcementOffers(fleet: Unit[], seed: string): { type: number; ambit: Ambit; slot: number }[] {
  const random = rngFor(seed);
  const free: { ambit: Ambit; slot: number }[] = [];
  for (const ambit of AMBITS) for (let slot = 0; slot < 4; slot++) if (!fleet.some((u) => u.type !== COMMAND_SHIP_ID && u.ambit === ambit && u.slot === slot)) free.push({ ambit, slot });
  const offers: { type: number; ambit: Ambit; slot: number }[] = [];
  const pool = FLEET_TYPES.map((t) => t.id).filter((id) => id !== COMMAND_SHIP_ID);
  for (let i = 0; i < 60 && offers.length < 3 && free.length; i++) {
    const type = pool[Math.floor(random() * pool.length)];
    if (offers.some((o) => o.type === type)) continue;
    const cell = free.find((c) => fits(type, c.ambit) && !offers.some((o) => o.ambit === c.ambit && o.slot === c.slot));
    if (cell) offers.push({ type, ...cell });
  }
  return offers;
}

/* ── Replays: layout + seed + executed transactions reproduce a battle ──── */
/** `end` and `stalemate` (optional; older links have neither): the height the fight was decided at, and
 * the rule that decided it when no flagship fell ('time' is a decision on hull). */
export interface ReplayCode { units: Unit[]; seed: string; start: number; txs: { height: number; signer: string; msg: Msg }[]; title?: string; winner?: string; end?: number; stalemate?: 'moves' | 'quiet' | 'time' }

const MSG_KEYS: Record<string, string[]> = {
  '/structs.structs.MsgStructAttack': ['operatingStructId', 'targetStructId', 'weaponSystem'],
  '/structs.structs.MsgStructDefenseSet': ['defenderStructId', 'protectedStructId'],
  '/structs.structs.MsgStructDefenseClear': ['defenderStructId'],
  '/structs.structs.MsgStructMove': ['structId', 'locationType', 'ambit', 'slot'],
  '/structs.structs.MsgStructStealthActivate': ['structId'],
  '/structs.structs.MsgStructStealthDeactivate': ['structId'],
  '/structs.structs.MsgStructActivate': ['structId'],
  '/structs.structs.MsgStructDeactivate': ['structId'],
};
const TYPE_LIST = Object.keys(MSG_KEYS);
const STRUCT_ID = /^5-\d{1,9}$/;

export function encodeReplay(r: ReplayCode): string {
  const o = {
    u: r.units.map((u) => [u.id, u.type, u.ambit, u.slot, u.protects, u.health ?? null]),
    s: r.seed, h: r.start, t: r.title, w: r.winner, e: r.end != null ? r.end - r.start : undefined, k: r.stalemate,
    x: r.txs.map((tx) => [tx.height - r.start, tx.signer === YOU.id ? 0 : 1, TYPE_LIST.indexOf(tx.msg['@type']), ...MSG_KEYS[tx.msg['@type']].map((k) => (tx.msg as unknown as Record<string, unknown>)[k])]),
  };
  return 'R' + btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeReplay(code: string): ReplayCode | null {
  if (!code.startsWith('R')) return null;
  try {
    if (code.length > 200000) return null;
    const o = JSON.parse(decodeURIComponent(escape(atob(code.slice(1).replace(/-/g, '+').replace(/_/g, '/')))));
    if (!Array.isArray(o.u) || o.u.length > 40 || !Array.isArray(o.x) || o.x.length > 5000) return null;
    const units: Unit[] = o.u.map((r: [string, number, Ambit, number, string | null, number | null]) => ({
      id: r[0], side: String(r[0]).startsWith('player') ? 'player' : 'computer', type: Number(r[1]), ambit: r[2], slot: Number(r[3]), protects: r[4] || null, health: r[5] ?? undefined,
    }));
    // Shared links are untrusted: the same unit checks as battle codes, a chain that starts
    // where chainSetup starts it, and tx rows that are well-formed and in block order.
    if (units.some((u) => typeof u.id !== 'string' || !Number.isInteger(u.slot) || (u.health != null && !Number.isInteger(u.health)))) return null;
    if (new Set(units.map((u) => u.id)).size !== units.length) return null;
    if (validate(units) || typeof o.s !== 'string' || o.s.length > 200 || o.h !== 1000 || !Array.isArray(o.x)) return null;
    let prev = 1;
    const txs = o.x.map((row: unknown[]) => {
      if (!Array.isArray(row)) throw new Error('bad tx');
      const off = Number(row[0]);
      if (!Number.isInteger(off) || off < prev || off > 100000 || (row[1] !== 0 && row[1] !== 1)) throw new Error('bad tx');
      prev = off;
      const type = TYPE_LIST[Number(row[2])];
      if (!type) throw new Error('bad tx');
      const msg: Record<string, unknown> = { '@type': type };
      MSG_KEYS[type].forEach((k, i) => {
        const v = row[3 + i];
        // Every field has one legal shape; anything else (markup, odd ids) rejects the link.
        const ok = k === 'targetStructId' ? Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every((x) => typeof x === 'string' && STRUCT_ID.test(x))
          : k === 'weaponSystem' ? v === 'primaryWeapon' || v === 'secondaryWeapon'
          : k === 'ambit' ? AMBITS.includes(v as Ambit)
          : k === 'slot' ? Number.isInteger(v) && (v as number) >= 0 && (v as number) < 8
          : k === 'locationType' ? v === 'fleet' || v === 'planet'
          : typeof v === 'string' && STRUCT_ID.test(v);
        if (!ok) throw new Error('bad tx field');
        msg[k] = v;
      });
      // A ship firing on itself is something the battle screen can't order; a link that does is forged.
      if (Array.isArray(msg.targetStructId) && msg.targetStructId.includes(msg.operatingStructId)) throw new Error('self-target');
      return { height: o.h + Number(row[0]), signer: row[1] === 0 ? YOU.id : CPU.id, msg: msg as unknown as Msg };
    });
    const end = Number.isInteger(o.e) && o.e >= 0 && o.e <= 100000 ? o.h + o.e : undefined;
    const stalemate = o.k === 'moves' || o.k === 'quiet' || o.k === 'time' ? o.k : undefined;
    return { units, seed: o.s, start: o.h, txs, title: typeof o.t === 'string' ? o.t.slice(0, 80) : undefined, winner: o.w, end, stalemate };
  } catch { return null; }
}

/* ── Daily engagement: one scenario per UTC day, the same for every commander ─
 * Fleets, twist, difficulty and the chain's dice all derive from the date, so
 * the same orders always produce the same battle. */
export interface DailyTwist { id: 'standard' | 'outnumbered' | 'battered' | 'no-guards' | 'orbit' | 'fortress'; name: string; note: string }
export interface Daily { key: string; name: string; twist: DailyTwist; difficulty: Difficulty; units: Unit[]; seed: string }

const DAILY_ADJ = ['Silent', 'Iron', 'Hollow', 'Crimson', 'Last', 'Broken', 'Pale', 'Burning', 'Quiet', 'Frozen', 'Sunken', 'Black', 'Long', 'Narrow', 'Bitter', 'Distant'];
const DAILY_NOUN = ['Anvil', 'Meridian', 'Lantern', 'Tide', 'Spire', 'Harvest', 'Vigil', 'Ledger', 'Furnace', 'Orbit', 'Margin', 'Covenant', 'Shoal', 'Ember', 'Frontier', 'Reckoning'];
export const DAILY_TWISTS: DailyTwist[] = [
  { id: 'standard', name: 'Even terms', note: 'Matched fleets. Read the board and plan your strikes.' },
  { id: 'outnumbered', name: 'Outnumbered', note: 'The enemy brought four more ships than you.' },
  { id: 'battered', name: 'Battered', note: 'Your ships arrive already damaged from the last fight.' },
  { id: 'no-guards', name: 'No escorts', note: 'Nobody is guarding anything, on either side.' },
  { id: 'orbit', name: 'High orbit', note: 'Both Command Ships hold space.' },
  { id: 'fortress', name: 'Fortress', note: 'Every enemy ship that can guard is guarding its Command Ship.' },
];

/** Today's key in UTC (YYYY-MM-DD), so every commander shares the same daily. */
export const dailyKey = (d = new Date()) => d.toISOString().slice(0, 10);

export function dailyScenario(key = dailyKey()): Daily {
  const seed = 'daily:' + key;
  const random = rngFor(seed);
  const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
  const name = `Operation ${pick(DAILY_ADJ)} ${pick(DAILY_NOUN)}`;
  const twist = pick(DAILY_TWISTS);
  const day = new Date(key + 'T12:00:00Z').getUTCDay();
  // Weekends are harder.
  const difficulty: Difficulty = day === 0 || day === 6 || day === 5 ? 'hard' : 'difficult';
  const yours = 8 + Math.floor(random() * 4);
  const theirs = Math.min(17, yours + (twist.id === 'outnumbered' ? 4 : Math.floor(random() * 3) - 1));
  const player = randomFleet('player', random, yours);
  const computer = randomFleet('computer', random, theirs);
  const units = [...player, ...computer];
  if (twist.id === 'orbit') for (const u of units) if (u.type === COMMAND_SHIP_ID) u.ambit = 'space';
  if (twist.id === 'no-guards') for (const u of units) u.protects = null;
  if (twist.id === 'fortress') {
    const cmd = computer.find((u) => u.type === COMMAND_SHIP_ID)!;
    for (const u of computer) if (u !== cmd && TYPES_BY_ID[u.type].canDefend) u.protects = cmd.id;
  }
  if (twist.id === 'battered') {
    for (const u of player) if (u.type !== COMMAND_SHIP_ID) u.health = Math.max(1, Math.round(TYPES_BY_ID[u.type].maxHealth * (0.5 + random() * 0.3)));
  }
  return { key, name, twist, difficulty, units, seed };
}
