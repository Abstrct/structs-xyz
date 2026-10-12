/* The computer player: one signer, the chain's charge, one message per block
 * it can afford, sent after a reaction delay. It judges an attack by playing
 * it forward on forks of the chain — the real resolution, not an estimate.
 * Port of structs-universe's simulator-ai.js (tuned 2026-10-07). */
import { AMBIT_FLAG, AMBITS, type WeaponSystem, weaponField } from '../data/catalogue';
import type { Chain, Msg, SimStruct } from './chain';

export type Difficulty = 'easy' | 'difficult' | 'hard';
interface Level { reactionMs: number; samples: number; wait: boolean; guard: boolean; move: boolean; stealth: boolean; noise: number; spread?: number }

export const LEVELS: Record<Difficulty, Level> = {
  easy: { reactionMs: 12000, samples: 1, wait: false, guard: false, move: false, stealth: false, noise: 2.5 },
  difficult: { reactionMs: 16000, samples: 6, wait: true, guard: true, move: false, stealth: false, noise: 0.6, spread: 1 },
  hard: { reactionMs: 8000, samples: 6, wait: true, guard: true, move: true, stealth: true, noise: 0 },
};

const alive = (c: Chain, s: SimStruct) => !c.isDestroyed(s);
const mine = (c: Chain, pid: string) => Object.values(c.structs).filter((s) => s.owner === pid && alive(c, s));
const theirs = (c: Chain, pid: string) => Object.values(c.structs).filter((s) => s.owner !== pid && alive(c, s));

/* Board value for `pid`: hulls weighted by health, Command Ships dominating. */
function score(c: Chain, pid: string) {
  let v = 0;
  for (const s of Object.values(c.structs)) {
    const t = c.typeOf(s), cmd = c.isCommand(s);
    const hp = c.isDestroyed(s) ? 0 : s.health;
    const w = (cmd ? 6 : 1) * hp / t.maxHealth + (hp > 0 ? (cmd ? 40 : 1) : 0);
    v += s.owner === pid ? w : -w;
  }
  const fleets = c.fleetsAtBattle();
  const own = c.players[pid].fleetId;
  if (fleets.indexOf(own) < 0) v -= 1000;
  else if (fleets.length === 1) v += 1000;
  return v;
}

function attackMsgs(c: Chain, pid: string) {
  const out: { cost: number; msg: Msg }[] = [];
  for (const a of mine(c, pid)) {
    if (!c.isOnline(a)) continue;
    const t = c.typeOf(a);
    for (const ws of ['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]) {
      if (weaponField(t, ws, '') === 'noActiveWeaponry') continue;
      if ((weaponField(t, ws, 'Targets') || 0) !== 1) continue;
      for (const target of theirs(c, pid)) {
        if (c.canAttack(a, target, ws)) continue;
        out.push({ cost: weaponField(t, ws, 'Charge') || 0, msg: { '@type': '/structs.structs.MsgStructAttack', operatingStructId: a.id, targetStructId: [target.id], weaponSystem: ws } });
      }
    }
  }
  return out;
}

/* Who could shoot `s` where it stands (or at `ambit`). */
function threatsTo(c: Chain, pid: string, s: SimStruct, ambit?: SimStruct['ambit']) {
  const ghost = { ...s, ambit: ambit || s.ambit };
  return theirs(c, pid).filter((e) => c.isOnline(e) && (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).some((ws) =>
    weaponField(c.typeOf(e), ws, '') !== 'noActiveWeaponry' && !c.canAttack(e, ghost, ws))).length;
}

export class Ai {
  readonly pid: string;
  readonly level: Level;
  readonly difficulty: Difficulty;
  private state: number;

  constructor(playerId: string, difficulty: Difficulty, seed: string) {
    this.pid = playerId;
    this.difficulty = difficulty;
    this.level = LEVELS[difficulty] || LEVELS.difficult;
    let n = 0;
    const s = String(seed || '') + playerId;
    for (let i = 0; i < s.length; i++) n = Math.imul(n ^ s.charCodeAt(i), 16777619) >>> 0;
    this.state = n || 1;
  }

  rand() {
    this.state = (Math.imul(this.state ^ (this.state >>> 15), 1 | this.state) + 0x6D2B79F5) >>> 0;
    return (this.state >>> 8) / 16777216;
  }

  /** Expected value of `msg` sent now, by playing the next block forward. */
  private evaluate(c: Chain, msg: Msg): number | null {
    let total = 0;
    const n = this.level.samples;
    for (let i = 0; i < n; i++) {
      const f = c.fork('ai' + c.height + ':' + i + ':' + JSON.stringify(msg).length + ':' + this.rand());
      f.mempool = [];
      f.submit(this.pid, msg);
      const b = f.produceBlock();
      if (!b.txs[0].ok) return null;
      total += score(f, this.pid);
    }
    return total / n - score(c, this.pid);
  }

  /** Decide this block's message, or null to keep charging. */
  decide(c: Chain): Msg | null {
    const pid = this.pid, L = this.level;
    const player = c.players[pid];
    if (!player || c.fleetsAtBattle().indexOf(player.fleetId) < 0) return null;
    const charge = c.chargeOf(pid, c.height + 1);
    const options: { msg: Msg; cost: number; value: number }[] = [];
    let best: { msg?: Msg; cost: number; value: number } = { cost: 0, value: -Infinity };

    for (const o of attackMsgs(c, pid)) {
      if (o.cost > charge && !L.wait) continue;
      let v = this.evaluate(c, o.msg);
      if (v == null) continue;
      v += L.noise * (this.rand() - 0.5) * 4;
      const opt = { msg: o.msg, cost: o.cost, value: v };
      if (o.cost <= charge) options.push(opt);
      if (v > best.value) best = opt;
    }

    const command = mine(c, pid).find((s) => c.isCommand(s));
    if (command && L.guard) {
      for (const d of mine(c, pid)) {
        if (d === command || !c.isOnline(d) || !c.canDefend(d) || d.protectedStructId === command.id) continue;
        if (d.ambit !== command.ambit && command.health > 3) continue;
        const cost = c.typeOf(d).defendChangeCharge || 0;
        if (cost > charge) continue;
        const urgency = (threatsTo(c, pid, command) > 0 ? 3 : 0.5) + (d.ambit === command.ambit ? 2 : 0) + (command.health <= 3 ? 3 : 0);
        options.push({ value: urgency, cost, msg: { '@type': '/structs.structs.MsgStructDefenseSet', defenderStructId: d.id, protectedStructId: command.id } });
      }
    }
    if (command && L.move && c.isOnline(command)) {
      const here = threatsTo(c, pid, command);
      const cost = c.typeOf(command).moveCharge || 0;
      for (const ambit of AMBITS) {
        if (ambit === command.ambit || cost > charge) continue;
        if ((AMBIT_FLAG[ambit] & c.typeOf(command).possibleAmbit) === 0) continue;
        const there = threatsTo(c, pid, command, ambit);
        if (there < here) options.push({ value: (here - there) * (command.health <= 3 ? 4 : 1.2), cost, msg: { '@type': '/structs.structs.MsgStructMove', structId: command.id, locationType: 'fleet', ambit, slot: 0 } });
      }
    }
    if (L.stealth) {
      for (const s of mine(c, pid)) {
        const t = c.typeOf(s);
        if (t.unitDefenses !== 'stealthMode' || c.isHidden(s) || !c.isOnline(s)) continue;
        // Stealth spends the whole charge, so only when it can just afford
        // it and the hull is exposed.
        const cost = t.stealthActivateCharge || 0;
        if (cost > charge || charge > cost + 1 || threatsTo(c, pid, s) === 0) continue;
        options.push({ value: 1.5, cost, msg: { '@type': '/structs.structs.MsgStructStealthActivate', structId: s.id } });
      }
    }

    options.sort((a, b) => b.value - a.value);
    let pick: { msg: Msg; cost: number; value: number } | null = options[0] || null;
    if (L.spread && L.spread > 1 && options.length) {
      const top = options.slice(0, L.spread).filter((o) => o.value > -1);
      if (top.length) pick = top[Math.floor(this.rand() * top.length)];
    }
    // Easy plays loosely, not suicidally: never sends the Command Ship into an
    // exchange its look-ahead expects to lose.
    if (this.difficulty === 'easy' && options.length) {
      const loose = options.filter((o) => !(command && 'operatingStructId' in o.msg && o.msg.operatingStructId === command.id && o.value < 0));
      pick = loose.length ? loose[Math.floor(this.rand() * loose.length)] : null;
    }
    // Holding charge: a clearly better attack is within reach of more charge.
    if (L.wait && best.cost > charge && (!pick || best.value > pick.value * 1.5 + 1)) return null;
    if (!pick) return null;
    if (this.difficulty !== 'easy' && pick.value <= -1) return null;
    return pick.msg;
  }
}
