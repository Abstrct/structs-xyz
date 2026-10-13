/* Soak test for the battle simulator: hundreds of seeded computer-vs-computer battles across every
 * fleet preset and AI difficulty pairing, plus Daily scenarios, full Gauntlet runs (losses and
 * damage carried over, a reinforcement picked between rounds), mirror matches, fuzzed fleets
 * (pre-damaged hulls, odd opening charge, 6 s blocks) and chaos battles, where your side is flown by
 * a monkey sending random, mostly illegal orders of every message type through session.submit (the
 * screen's own order path) to exercise every rejection path. Each battle runs through BattleSession the
 * way the battle screen runs it: 60 fps frame ticks, a block every blockMs, the computer flying its
 * fleet and the autopilot flying yours. Every block is checked against the rules' invariants. Then
 * the battle is replayed from its replay code (executed txs only) and must reproduce the event log
 * and final board, and it is fought again from scratch and must reproduce everything, tx hashes too.
 *
 *   npx tsx scripts/studio/soak.test.ts
 *   SOAK_N=1000 SOAK_SEED=night-2 SOAK_WORKERS=8 npx tsx scripts/studio/soak.test.ts
 *   SOAK_SEED=soak SOAK_ONLY=17,58 npx tsx scripts/studio/soak.test.ts     (re-run single jobs inline, no report)
 *
 * SOAK_N jobs (default 400; a Gauntlet run is one job of up to five battles), SOAK_SEED (default
 * "soak"), SOAK_WORKERS (child processes, default cores-1 up to 8), SOAK_RERUN (re-fight every k-th
 * job for the determinism check, default 1 = all), SOAK_BLOCK_CAP (default 1500 blocks).
 * Exit 0 = every invariant held, 1 = a failure (each printed with its repro). Balance outliers are
 * warnings only. Stats are written to studio/reports/soak.json. */
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chain, STATUS, STRUCT_SWEEP_DELAY, type Block, type Msg } from '../../src/sim/chain';
import { Ai, type Difficulty } from '../../src/sim/ai';
import { BattleSession, DECIDE_AT, type Outcome } from '../../src/screens/battle/session';
import {
  bossCap, chainSetup, CPU, dailyScenario, decodeReplay, encodeReplay, fits, GAUNTLET_ROUNDS, gauntletEnemy, layout, MAX_CHARGE,
  mirrorUnits, type Preset, reinforcementOffers, type Unit, unitId, validate, YOU,
} from '../../src/sim/fleets';
import { AMBIT_FLAG, AMBITS, COMMAND_SHIP_ID, type StructType, TYPES_BY_ID, type WeaponSystem, weaponField } from '../../src/data/catalogue';
import { hash32, rngFor } from '../../src/core/util';

const SELF = fileURLToPath(import.meta.url);
const REPORT = resolve(dirname(SELF), '../../studio/reports/soak.json');
const N = Math.max(1, Math.floor(Number(process.env.SOAK_N) || 400));
const BASE = process.env.SOAK_SEED || 'soak';
const RERUN = Math.max(1, Math.floor(Number(process.env.SOAK_RERUN) || 1));
const BLOCK_CAP = Math.max(50, Math.floor(Number(process.env.SOAK_BLOCK_CAP) || 1500));
const ONLY = process.env.SOAK_ONLY ? process.env.SOAK_ONLY.split(',').map((s) => Math.floor(Number(s))).filter((i) => i >= 0) : null;
const WORKERS = ONLY ? 1 : Math.max(1, Math.floor(Number(process.env.SOAK_WORKERS) || Math.min(8, availableParallelism() - 1)));
const FRAME_MS = 1000 / 60;                          // the battle screen ticks the session once per frame
const CHARGE = { player: 9, computer: 9 };          // what the battle screen opens every fight with
const BUDGET_MS = 60_000;

/* ── The job list: job i is a pure function of (SOAK_SEED, i), so any failure re-runs alone ── */
const DIFFS: Difficulty[] = ['easy', 'difficult', 'hard'];
const PRESET_IDS: Preset[] = ['easy', 'difficult', 'hard', 'random'];
const PRESET_CELLS = PRESET_IDS.length * DIFFS.length * DIFFS.length;   // 36: preset × computer × autopilot
const CYCLE = PRESET_CELLS + 7;                                        // + 2 dailies, 1 gauntlet, 2 mirrors, 1 fuzz, 1 chaos
type Kind = 'preset' | 'daily' | 'gauntlet' | 'mirror' | 'fuzz' | 'chaos';
type Pilot = Difficulty | 'monkey';
interface Job { i: number; kind: Kind; seed: string; preset?: Preset; day?: string; cpu: Difficulty; you: Pilot }

function jobFor(i: number): Job {
  const cycle = Math.floor(i / CYCLE), k = i % CYCLE, seed = `${BASE}:${i}`;
  if (k < PRESET_CELLS) return { i, kind: 'preset', seed, preset: PRESET_IDS[k % 4], cpu: DIFFS[Math.floor(k / 4) % 3], you: DIFFS[Math.floor(k / 12)] };
  const extra = k - PRESET_CELLS, n = cycle * 2 + (extra % 2);
  if (extra < 2) {
    // A different UTC day each time (stride 11 so weekday and twist both move).
    const day = new Date(Date.UTC(2026, 0, 1) + ((hash32(BASE) % 997) + n * 11) * 86_400_000).toISOString().slice(0, 10);
    return { i, kind: 'daily', seed, day, cpu: dailyScenario(day).difficulty, you: DIFFS[n % 3] };
  }
  if (extra === 2) return { i, kind: 'gauntlet', seed, cpu: 'hard', you: cycle % 2 ? 'difficult' : 'hard' };
  if (extra < 5) return { i, kind: 'mirror', seed, cpu: DIFFS[n % 3], you: DIFFS[n % 3] };
  if (extra === 6) return { i, kind: 'chaos', seed, cpu: DIFFS[cycle % 3], you: 'monkey' };
  const r = rngFor(seed + ':fuzz-ai');
  return { i, kind: 'fuzz', seed, cpu: DIFFS[Math.floor(r() * 3)], you: DIFFS[Math.floor(r() * 3)] };
}

/* ── Records ───────────────────────────────────────────────────────────── */
type Winner = Outcome['winner'] | 'none';
interface Rec {
  job: number; scenario: string; variant?: string; cpu: Difficulty; you: Pilot; blockMs: number;
  winner: Winner; stalemate?: string; blocks: number; txs: number; failedTx: Record<string, number>; okTx: Record<string, number>;
  fielded: { you: number; cpu: number }; lost: { you: number; cpu: number }; ms: number;
}
interface JobResult { i: number; kind: Kind; battles: Rec[]; failures: string[]; gauntletWon?: number; ms: number }
type Fail = (msg: string) => void;
interface Spec { scenario: string; variant?: string; units: Unit[]; chainSeed: string; aiSeed: string; cpu: Difficulty; you: Pilot; blockMs: number; charge: { player: number; computer: number } }

const actorOf = (m: Msg) => ('operatingStructId' in m ? m.operatingStructId : 'defenderStructId' in m ? m.defenderStructId : m.structId);
const short = (m: Msg) => m['@type'].replace('/structs.structs.Msg', '') + ' ' + actorOf(m) + ('targetStructId' in m ? '→' + m.targetStructId.join('+') : '');
/* Tx hashes count every submission, including orders a newer one replaced before its block, so a
 * replay (executed txs only) renumbers them: the event log is compared without them. */
const noHash = (k: string, v: unknown) => (k === 'hash' ? undefined : v);
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const stateOf = (c: Chain) => sha1(JSON.stringify({ s: c.structs, f: c.fleets, p: c.players, d: c.defenders, q: c.destructionQueue }));
/** What a message costs in charge, read from the catalogue (independently of the chain's own check). */
function costOf(t: StructType, m: Msg): number {
  switch (m['@type']) {
    case '/structs.structs.MsgStructAttack': return weaponField(t, m.weaponSystem, 'Charge') || 0;
    case '/structs.structs.MsgStructDefenseSet': case '/structs.structs.MsgStructDefenseClear': return t.defendChangeCharge || 0;
    case '/structs.structs.MsgStructMove': return t.moveCharge || 0;
    case '/structs.structs.MsgStructStealthActivate': case '/structs.structs.MsgStructStealthDeactivate': return t.stealthActivateCharge || 0;
    case '/structs.structs.MsgStructActivate': return t.activateCharge || 0;
    default: return 0;
  }
}

/* ── Invariants, checked on every block the session produces ───────────── */
class Checker {
  readonly dead = new Map<string, number>();                    // struct id → height it was destroyed
  readonly failedTx: Record<string, number> = {};
  readonly okTx: Record<string, number> = {};
  txs = 0;
  private readonly info: Record<string, { owner: string; max: number; command: boolean; type: StructType }> = {};
  private readonly flagship: Record<string, string> = {};       // owner → Command Ship id
  private readonly lastAction: Record<string, number> = {};     // our own charge ledger: height of each player's last discharge
  private readonly offline = new Set<string>();                 // our own record of the ONLINE bit, from status frames
  private readonly hash = createHash('sha1');                    // the event log, block by block
  private readonly txHashes = createHash('sha1');
  private height: number;

  constructor(private readonly chain: Chain, private readonly fail: Fail, private readonly pilot: string) {
    this.height = chain.height;
    for (const s of Object.values(chain.structs)) {
      const command = chain.isCommand(s);
      this.info[s.id] = { owner: s.owner, max: chain.typeOf(s).maxHealth, command, type: chain.typeOf(s) };
      if (command) this.flagship[s.owner] = s.id;
    }
    for (const [pid, p] of Object.entries(chain.players)) this.lastAction[pid] = p.lastAction;
    this.state();
  }

  digest() { return { log: this.hash.digest('hex'), txHashes: this.txHashes.digest('hex') }; }
  private who(pid: string) { return pid === YOU.id ? this.pilot : pid === CPU.id ? 'computer' : pid; }

  /** A computer decision, on the chain as it stands when it is made. */
  order(pid: string, msg: Msg) {
    const c = this.chain, id = actorOf(msg), s = c.structs[id];
    if (!s) { this.fail(`h${c.height}: ${this.who(pid)} ordered a struct that is not on the board (${short(msg)})`); return; }
    if (s.owner !== pid) this.fail(`h${c.height}: ${this.who(pid)} ordered a struct it does not own (${short(msg)})`);
    if (c.isDestroyed(s)) this.fail(`h${c.height}: ${this.who(pid)} ordered destroyed struct ${id} (${short(msg)})`);
    if (msg['@type'] === '/structs.structs.MsgStructAttack') {
      for (const tid of msg.targetStructId) {
        const t = c.structs[tid];
        if (!t || c.isDestroyed(t) || t.owner === pid) this.fail(`h${c.height}: ${this.who(pid)} aimed at ${tid}, which is gone, destroyed or friendly`);
      }
    }
  }

  block(b: Block) {
    this.hash.update(JSON.stringify(b, noHash));
    for (const tx of b.txs) this.txHashes.update(tx.hash);
    if (b.height !== this.height + 1) this.fail(`block ${b.height} follows block ${this.height}`);
    this.height = b.height;
    for (const e of b.events) {
      if (e.category !== 'struct_sweep') continue;
      const at = this.dead.get(e.detail.struct_id);
      if (at == null) this.fail(`h${b.height}: swept ${e.detail.struct_id}, which was never destroyed`);
      else if (b.height - at !== STRUCT_SWEEP_DELAY) this.fail(`h${b.height}: ${e.detail.struct_id} swept ${b.height - at} blocks after it was destroyed (want ${STRUCT_SWEEP_DELAY})`);
    }
    for (const tx of b.txs) {
      this.txs++;
      if (!tx.ok) {
        const code = this.who(tx.signer) + ':' + (tx.code || 'error');
        this.failedTx[code] = (this.failedTx[code] || 0) + 1;
        if (tx.events.length) this.fail(`h${b.height}: a reverted tx still emitted ${tx.events.length} events (${short(tx.msg)})`);
        continue;
      }
      const kind = tx.msg['@type'].replace('/structs.structs.Msg', '');
      this.okTx[kind] = (this.okTx[kind] || 0) + 1;
      const at = `h${b.height} ${this.who(tx.signer)} ${short(tx.msg)}`;
      const actor = actorOf(tx.msg);
      if (this.dead.has(actor)) this.fail(`${at}: destroyed struct ${actor} acted (destroyed at h${this.dead.get(actor)})`);
      if (this.info[actor]?.owner !== tx.signer) this.fail(`${at}: signer does not own ${actor}`);
      // Charge: every executed order was affordable, and everything but a deactivation spends it all.
      const cost = this.info[actor] ? costOf(this.info[actor].type, tx.msg) : 0, charge = b.height - this.lastAction[tx.signer];
      if (cost > charge) this.fail(`${at}: executed with ${charge} charge, it costs ${cost}`);
      if (tx.msg['@type'] !== '/structs.structs.MsgStructDeactivate') this.lastAction[tx.signer] = b.height;
      // Every order but an activation needs its struct online; an activation needs it offline.
      const activation = tx.msg['@type'] === '/structs.structs.MsgStructActivate';
      if (this.info[actor] && activation !== this.offline.has(actor)) this.fail(`${at}: executed while ${actor} was ${activation ? 'online' : 'offline'}`);
      const died: string[] = [], flips: [string, boolean][] = [];
      for (const e of tx.events) {
        const d = e.detail;
        if (e.category === 'struct_attack') this.attack(at, d);
        else if (e.category === 'struct_health') {
          if (this.dead.has(d.struct_id)) this.fail(`${at}: destroyed struct ${d.struct_id} took damage`);
          this.hp(at, d.struct_id, d.health, 0);
          this.hp(at, d.struct_id, d.health_old, 1);
          if (!(d.health < d.health_old)) this.fail(`${at}: ${d.struct_id} health went ${d.health_old} → ${d.health} (combat never heals)`);
        } else if (e.category === 'struct_status') {
          if (this.dead.has(d.struct_id)) this.fail(`${at}: destroyed struct ${d.struct_id} changed status ${d.status_old} → ${d.status}`);
          const was = (d.status_old & STATUS.DESTROYED) !== 0, is = (d.status & STATUS.DESTROYED) !== 0;
          if (was && !is) this.fail(`${at}: ${d.struct_id} came back from destruction`);
          if (!was && is) died.push(d.struct_id);
          if ((d.status ^ d.status_old) & STATUS.ONLINE) flips.push([d.struct_id, (d.status & STATUS.ONLINE) !== 0]);
        } else if (e.category === 'struct_move') {
          if (this.dead.has(d.struct_id)) this.fail(`${at}: destroyed struct ${d.struct_id} moved`);
        }
      }
      for (const id of died) this.dead.set(id, b.height);
      for (const [id, on] of flips) { if (on) this.offline.delete(id); else this.offline.add(id); }
    }
    this.state();
  }

  private attack(at: string, d: any) {
    const a = d.attackerStructId;
    if (this.dead.has(a)) this.fail(`${at}: destroyed ${a} fired`);
    this.hp(at, a, d.attackerHealthBefore, 1);
    this.hp(at, a, d.attackerHealthAfter, 0);
    if (this.offline.has(a)) this.fail(`${at}: offline ${a} fired`);
    let attackerDown = false;
    for (const r of d.eventAttackShotDetail || []) {
      const dmg = Number(r.damage || 0);
      if (this.dead.has(r.targetStructId)) this.fail(`${at}: shot at destroyed ${r.targetStructId}`);
      this.hp(at, r.targetStructId, r.targetHealthBefore, 1);
      this.hp(at, r.targetStructId, r.targetHealthAfter, 0);
      if (!(dmg >= 0)) this.fail(`${at}: negative damage ${r.damage}`);
      if (r.blocked) {
        const bid = r.blockedByStructId;
        if (this.dead.has(bid) || this.offline.has(bid)) this.fail(`${at}: ${this.dead.has(bid) ? 'destroyed' : 'offline'} ${bid} blocked a shot`);
        if (r.targetHealthAfter !== r.targetHealthBefore) this.fail(`${at}: a blocked shot still hurt ${r.targetStructId}`);
        if (r.blockerHealthAfter != null) {
          this.hp(at, bid, r.blockerHealthBefore, 1);
          this.hp(at, bid, r.blockerHealthAfter, 0);
          if (r.blockerHealthBefore - r.blockerHealthAfter !== Math.min(dmg, r.blockerHealthBefore)) this.fail(`${at}: blocker ${bid} took ${dmg} but went ${r.blockerHealthBefore} → ${r.blockerHealthAfter}`);
        }
      } else if (r.targetStructId !== a && r.targetHealthBefore - r.targetHealthAfter !== Math.min(dmg, r.targetHealthBefore)) {
        // (A struct the monkey aims at itself also takes its own counter, so only other targets add up exactly.)
        this.fail(`${at}: ${r.targetStructId} took ${dmg} but went ${r.targetHealthBefore} → ${r.targetHealthAfter}`);
      }
      for (const cd of r.eventAttackDefenderCounterDetail || []) {
        if (this.dead.has(cd.counterByStructId) || this.offline.has(cd.counterByStructId)) this.fail(`${at}: ${this.dead.has(cd.counterByStructId) ? 'destroyed' : 'offline'} ${cd.counterByStructId} counter-attacked`);
        if (!(cd.counterDamage >= 0)) this.fail(`${at}: negative counter damage ${cd.counterDamage}`);
        if (cd.counterDestroyedAttacker) attackerDown = true;
      }
      if (attackerDown && (dmg > 0 || r.targetCountered)) this.fail(`${at}: ${a} kept fighting after a defender's counter destroyed it`);
    }
  }

  private hp(at: string, id: string, v: unknown, min: number) {
    const max = this.info[id]?.max;
    if (max == null) { this.fail(`${at}: event names unknown struct ${id}`); return; }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) this.fail(`${at}: ${id} health ${v} outside ${min}..${max}`);
  }

  /* The whole board after each block. */
  private state() {
    const c = this.chain, h = c.height;
    const cells = new Set<string>();
    for (const [id, inf] of Object.entries(this.info)) {
      const s = c.structs[id], died = this.dead.get(id);
      if (!s) {
        if (died == null) this.fail(`h${h}: ${id} left the board without being destroyed`);
        else if (h - died < STRUCT_SWEEP_DELAY) this.fail(`h${h}: ${id} swept ${h - died} blocks after it was destroyed`);
        continue;
      }
      const t = c.typeOf(s);
      if (s.owner !== inf.owner) this.fail(`h${h}: ${id} changed owner`);
      if (c.isDestroyed(s)) {
        if (died == null) this.fail(`h${h}: ${id} is destroyed but no status frame said so`);
        if (s.health !== 0) this.fail(`h${h}: destroyed ${id} has health ${s.health}`);
        if (c.isOnline(s)) this.fail(`h${h}: destroyed ${id} is still online`);
        if (s.protectedStructId) this.fail(`h${h}: destroyed ${id} still guards ${s.protectedStructId}`);
        if (s.destroyedAt == null || h - s.destroyedAt >= STRUCT_SWEEP_DELAY) this.fail(`h${h}: ${id} (destroyed at h${s.destroyedAt}) was never swept`);
      } else {
        if (died != null) this.fail(`h${h}: ${id} is live again after being destroyed at h${died}`);
        if (!Number.isInteger(s.health) || s.health < 1 || s.health > inf.max) this.fail(`h${h}: ${id} health ${s.health} outside 1..${inf.max}`);
        if (!inf.command) {
          if (!Number.isInteger(s.slot) || s.slot < 0 || s.slot > 3) this.fail(`h${h}: ${id} in slot ${s.slot}`);
          const cell = s.locationId + ':' + s.ambit + ':' + s.slot;
          if (cells.has(cell)) this.fail(`h${h}: two live structs share ${cell}`);
          cells.add(cell);
        }
      }
      if ((AMBIT_FLAG[s.ambit] & t.possibleAmbit) === 0) this.fail(`h${h}: ${t.type} ${id} sits in ${s.ambit}, outside its ambits`);
      if (c.isHidden(s) && t.unitDefenses !== 'stealthMode') this.fail(`h${h}: ${t.type} ${id} is hidden without stealth`);
      if (c.isOnline(s) === this.offline.has(id)) this.fail(`h${h}: ${id} is ${c.isOnline(s) ? 'online' : 'offline'} but no status frame said so`);
    }
    for (const [pid, p] of Object.entries(c.players)) {
      const charge = c.chargeOf(pid);
      if (!(charge >= 0)) this.fail(`h${h}: ${this.who(pid)} has charge ${charge}`);
      if (p.lastAction !== this.lastAction[pid]) this.fail(`h${h}: ${this.who(pid)} last discharged at h${p.lastAction} on the chain, at h${this.lastAction[pid]} by the executed orders`);
      if (p.load < 0 || p.load > p.capacity) this.fail(`h${h}: ${this.who(pid)} load ${p.load} outside 0..${p.capacity}`);
    }
    for (const f of Object.values(c.fleets)) {
      const cmd = this.flagship[f.owner];
      const down = !cmd || this.dead.has(cmd);
      if (f.atBattle === down) this.fail(`h${h}: fleet ${f.id} atBattle=${f.atBattle} but its Command Ship is ${down ? 'destroyed' : 'alive'}`);
    }
    for (const [ward, ds] of Object.entries(c.defenders)) {
      for (const d of Object.keys(ds)) {
        const s = c.structs[d];
        if (!s) this.fail(`h${h}: defender index still lists swept ${d} as guarding ${ward}`);
        else if (s.protectedStructId !== ward) this.fail(`h${h}: defender index has ${d} guarding ${ward}, the struct says ${s.protectedStructId}`);
      }
    }
    for (const s of Object.values(c.structs)) {
      if (s.protectedStructId && !c.defenders[s.protectedStructId]?.[s.id]) this.fail(`h${h}: ${s.id} guards ${s.protectedStructId} but the defender index does not list it`);
    }
  }

  /** The verdict agrees with the board, and the debrief's tallies with the chain. */
  end(session: BattleSession, o: Outcome) {
    const c = this.chain, left = c.fleetsAtBattle();
    const youIn = left.includes(YOU.fleetId), cpuIn = left.includes(CPU.fleetId);
    if (o.height !== c.height) this.fail(`outcome at h${o.height}, chain at h${c.height}`);
    // Decided on hull (time, or a standoff): both fleets still in (at DECIDE_AT for time), and the winner
    // is the one with more hull (Command Ship fraction, then the fleet's; even on both, a draw).
    if (o.stalemate) {
      const hl = o.hull;
      const by = (a: number, b: number) => (a > b + 1e-9 ? 'you' : b > a + 1e-9 ? 'cpu' : null);
      if (!(youIn && cpuIn)) this.fail(`decided on hull (${o.stalemate}) with fleets ${left.join(',') || 'none'} at battle`);
      else if (o.stalemate === 'time' && o.height - session.startHeight !== DECIDE_AT) this.fail(`decided on time after ${o.height - session.startHeight} turns, not ${DECIDE_AT}`);
      else if (!hl) this.fail('decided on time with no hull figures');
      else if ((by(hl.you, hl.cpu) || by(hl.fleetYou, hl.fleetCpu) || 'draw') !== o.winner) this.fail(`decided on hull (${o.stalemate}) for "${o.winner}" with hull ${JSON.stringify(hl)}`);
    }
    else if (o.winner === 'you' && !(youIn && !cpuIn)) this.fail(`outcome "you" with fleets ${left.join(',') || 'none'} at battle`);
    else if (o.winner === 'cpu' && !(cpuIn && !youIn)) this.fail(`outcome "cpu" with fleets ${left.join(',') || 'none'} at battle`);
    else if (o.winner === 'draw' && left.length !== 0) this.fail(`a draw with no hull decision and no mutual kill (fleets ${left.join(',')})`);
    else if (!['you', 'cpu', 'draw'].includes(o.winner)) this.fail(`unknown winner ${o.winner}`);
    const kills = session.kills.map((k) => k.structId).sort().join(), deaths = [...this.dead.keys()].sort().join();
    if (kills !== deaths) this.fail(`debrief tallies ${session.kills.length} kills, the chain destroyed ${this.dead.size}`);
    if (session.executed.length !== this.txs) this.fail(`session logged ${session.executed.length} txs, its blocks carried ${this.txs}`);
  }
}

/* ── One battle, driven like the battle screen drives it ───────────────── */
interface Fight { outcome: Outcome | null; chain: Chain; idMap: Record<string, string>; session: BattleSession; check: Checker; start: number; digest: { log: string; txHashes: string }; state: string; ms: number }

function fight(spec: Spec, fail: Fail): Fight | null {
  const bad = validate(spec.units);
  if (bad) { fail(`layout rejected by validate(): ${bad}`); return null; }
  const t0 = performance.now();
  const { setup, idMap } = chainSetup(spec.units, spec.chainSeed, spec.charge);
  const chain = new Chain(setup);
  const session = new BattleSession(chain, spec.cpu, spec.aiSeed, spec.blockMs);
  const pilot = spec.you === 'monkey' ? monkey(spec.aiSeed, session, chain) : null;
  if (spec.you !== 'monkey') session.autopilot = new Ai(YOU.id, spec.you, spec.aiSeed + ':you');
  const check = new Checker(chain, fail, spec.you === 'monkey' ? 'monkey' : 'autopilot');
  session.onBlock = (b) => check.block(b);
  session.onAiOrder = (m) => check.order(CPU.id, m);
  session.onAutoOrder = (m) => check.order(YOU.id, m);
  session.start();
  while (!session.finished && chain.height - session.startHeight < BLOCK_CAP) { pilot?.(); session.update(FRAME_MS); }
  const outcome = session.finished;
  if (outcome) check.end(session, outcome);
  else fail(`no result within ${BLOCK_CAP} blocks`);
  return { outcome, chain, idMap, session, check, start: session.startHeight, digest: check.digest(), state: stateOf(chain), ms: performance.now() - t0 };
}

/* Chaos pilot for your side: about one random order per block, most of them illegal (someone else's
 * struct, a destroyed one, an unknown id, a friendly target, two targets, slot 4, no charge, no
 * stealth to toggle…), sent through session.submit so a newer order replaces the queued one, as on
 * the battle screen. The chain must reject the bad ones whole and the invariants must still hold. */
function monkey(seed: string, s: BattleSession, c: Chain): () => void {
  const r = rngFor(seed + ':monkey');
  const pick = <T,>(list: T[]) => list[Math.floor(r() * list.length)];
  return () => {
    if (r() > (FRAME_MS / s.blockMs) * 0.8) return;
    if (r() < 0.05) { s.cancelPending(); return; }
    const all = Object.values(c.structs);
    const own = all.filter((x) => x.owner === YOU.id).map((x) => x.id), foe = all.filter((x) => x.owner !== YOU.id).map((x) => x.id);
    const actor = () => (r() < 0.85 && own.length ? pick(own) : r() < 0.7 && foe.length ? pick(foe) : '5-999');
    // Some orders are only legal for a few ships (offline, guarding, hidden): aim at those most of the time.
    const ownWhere = (ok: (x: (typeof all)[number]) => boolean) => { const l = all.filter((x) => x.owner === YOU.id && ok(x)).map((x) => x.id); return l.length && r() < 0.7 ? pick(l) : actor(); };
    const target = () => (r() < 0.9 && foe.length ? pick(foe) : pick(all).id);
    const ws: WeaponSystem = r() < 0.6 ? 'primaryWeapon' : 'secondaryWeapon';
    const roll = r();
    s.submit(roll < 0.4 ? { '@type': '/structs.structs.MsgStructAttack', operatingStructId: actor(), targetStructId: r() < 0.95 ? [target()] : [target(), target()], weaponSystem: ws }
      : roll < 0.5 ? { '@type': '/structs.structs.MsgStructDefenseSet', defenderStructId: actor(), protectedStructId: r() < 0.8 ? actor() : target() }
      : roll < 0.58 ? { '@type': '/structs.structs.MsgStructDefenseClear', defenderStructId: ownWhere((x) => !!x.protectedStructId) }
      : roll < 0.72 ? { '@type': '/structs.structs.MsgStructMove', structId: actor(), locationType: 'fleet', ambit: pick(AMBITS), slot: Math.floor(r() * 5) }
      : roll < 0.8 ? { '@type': '/structs.structs.MsgStructStealthActivate', structId: ownWhere((x) => c.typeOf(x).unitDefenses === 'stealthMode') }
      : roll < 0.86 ? { '@type': '/structs.structs.MsgStructStealthDeactivate', structId: ownWhere((x) => c.isHidden(x)) }
      : roll < 0.93 ? { '@type': '/structs.structs.MsgStructActivate', structId: ownWhere((x) => !c.isOnline(x)) }
      : { '@type': '/structs.structs.MsgStructDeactivate', structId: actor() });
  };
}

/* The battle again, from its executed transactions only — through the replay code the debrief
 * shares whenever the opening is one the screen can express. */
function replayCheck(spec: Spec, f: Fight, fail: Fail) {
  let units = spec.units, seed = spec.chainSeed, txs = f.session.executed;
  if (spec.charge.player === CHARGE.player && spec.charge.computer === CHARGE.computer) {
    const code = encodeReplay({ units: spec.units, seed: spec.chainSeed, start: f.start, txs, title: spec.scenario, winner: f.outcome?.winner });
    const rp = decodeReplay(code);
    // A ship firing on itself (only the chaos monkey orders one) makes a link decodeReplay refuses as forged.
    const selfShot = txs.some((t) => { const m = t.msg as { targetStructId?: string[]; operatingStructId?: string }; return Array.isArray(m.targetStructId) && m.targetStructId.includes(String(m.operatingStructId)); });
    if (selfShot) { if (rp) fail('a replay with a self-shot decodes, but links like it must be refused'); return; }
    if (!rp) { fail(`its replay code (${code.length} chars, ${txs.length} txs) is rejected by decodeReplay`); return; }
    units = rp.units; seed = rp.seed; txs = rp.txs;
  }
  const chain = new Chain(chainSetup(units, seed, spec.charge).setup);
  const hash = createHash('sha1');
  let i = 0;
  while (chain.height < f.chain.height) {
    const next = chain.height + 1;
    while (i < txs.length && txs[i].height === next) { chain.submit(txs[i].signer, txs[i].msg); i++; }
    hash.update(JSON.stringify(chain.produceBlock(), noHash));
  }
  if (i !== txs.length) fail(`replay left ${txs.length - i} of ${txs.length} txs unplayed`);
  if (hash.digest('hex') !== f.digest.log) fail(`replaying its ${txs.length} txs does not reproduce the event log`);
  if (stateOf(chain) !== f.state) fail(`replaying its ${txs.length} txs does not reproduce the final state`);
}

function record(job: Job, spec: Spec, f: Fight): Rec {
  const lost = { you: 0, cpu: 0 };
  for (const k of f.session.kills) lost[k.owner === YOU.id ? 'you' : 'cpu']++;
  return {
    job: job.i, scenario: spec.scenario, variant: spec.variant, cpu: spec.cpu, you: spec.you, blockMs: spec.blockMs,
    winner: f.outcome?.winner ?? 'none', stalemate: f.outcome?.stalemate, blocks: f.chain.height - f.start, txs: f.check.txs,
    failedTx: f.check.failedTx, okTx: f.check.okTx, fielded: { you: f.session.fielded[YOU.id] || 0, cpu: f.session.fielded[CPU.id] || 0 }, lost, ms: Math.round(f.ms),
  };
}

/* ── A job: one battle, or a whole Gauntlet run ────────────────────────── */
function play(job: Job, fail: Fail): { recs: Rec[]; prints: string[]; gauntletWon?: number } {
  const recs: Rec[] = [], prints: string[] = [];
  const one = (spec: Spec): Fight | null => {
    const tag = spec.scenario + (spec.variant ? '/' + spec.variant : '');
    const f = fight(spec, (m) => fail(`${tag}: ${m}`));
    if (!f) { prints.push(tag + ':invalid'); return null; }
    replayCheck(spec, f, (m) => fail(`${tag}: ${m}`));
    recs.push(record(job, spec, f));
    prints.push(`${tag}:${f.outcome?.winner}:${f.outcome?.stalemate}@${f.chain.height}:log ${f.digest.log}:txs ${f.digest.txHashes}:state ${f.state}`);
    return f;
  };
  const base = { chainSeed: job.seed + ':chain', aiSeed: job.seed, cpu: job.cpu, you: job.you, blockMs: 2000, charge: CHARGE };
  switch (job.kind) {
    case 'preset':
      one({ ...base, scenario: 'preset:' + job.preset, units: layout(job.preset!, job.seed) });
      break;
    case 'daily': {
      // The screen seeds both the chain's dice and the computer with the daily's own seed.
      const d = dailyScenario(job.day);
      one({ ...base, scenario: 'daily', variant: d.twist.id, units: d.units, chainSeed: d.seed, aiSeed: d.seed, cpu: d.difficulty });
      break;
    }
    case 'mirror': {
      const fleet = layout('random', job.seed).filter((u) => u.side === 'player');
      one({ ...base, scenario: 'mirror', units: [...fleet, ...mirrorUnits(fleet, 'computer')], blockMs: job.i % 2 ? 6000 : 2000 });
      break;
    }
    case 'fuzz': {
      const r = rngFor(job.seed + ':fuzz');
      const units = layout('random', job.seed).map((u) => (r() < 0.4 ? { ...u, health: 1 + Math.floor(r() * TYPES_BY_ID[u.type].maxHealth) } : u));
      const charge = { player: Math.floor(r() * (MAX_CHARGE + 1)), computer: Math.floor(r() * (MAX_CHARGE + 1)) };
      one({ ...base, scenario: 'fuzz', units, charge, blockMs: r() < 0.5 ? 2000 : 6000 });
      break;
    }
    case 'chaos':
      one({ ...base, scenario: 'chaos', units: layout(job.i % 2 ? 'random' : 'difficult', job.seed), blockMs: job.i % 3 ? 2000 : 6000 });
      break;
    case 'gauntlet':
      return { recs, prints, gauntletWon: gauntlet(job, one, fail) };
  }
  return { recs, prints };
}

/* A Gauntlet run as battle.ts plays it: loadGauntletRound → fight → carryOver → showReinforcements. */
function gauntlet(job: Job, one: (s: Spec) => Fight | null, fail: Fail): number {
  let fleet = layout('difficult', job.seed).filter((u) => u.side === 'player');
  for (let round = 1; round <= GAUNTLET_ROUNDS.length; round++) {
    const r = GAUNTLET_ROUNDS[round - 1];
    // (As the game does: the boss sized to the fleet that reaches it.)
    const enemy = gauntletEnemy(round, job.seed, fleet.length);
    const need = Math.min(GAUNTLET_ROUNDS[round - 1]?.minEnemy || 0, round === GAUNTLET_ROUNDS.length ? bossCap(fleet.length) : Infinity);
    if (enemy.length < need) fail(`gauntlet:${round}: the round fields ${enemy.length} enemy ships, it promises at least ${need}`);
    const units = [...fleet.map((u) => ({ ...u })), ...enemy];
    const f = one({ scenario: `gauntlet:${round}`, variant: r.name, units, chainSeed: `${job.seed}:g${round}:chain`, aiSeed: `${job.seed}:g${round}`, cpu: r.difficulty, you: job.you, blockMs: 2000, charge: CHARGE });
    if (!f || f.outcome?.winner !== 'you') return round - 1;
    // carryOver(): survivors keep their wounds and positions, dead hulls stay dead, orphaned guards stand down.
    const alive = new Set<string>();
    fleet = units.filter((u) => u.side === 'player').flatMap((u) => {
      const s = f.chain.structs[f.idMap[u.id]];
      if (!s || f.chain.isDestroyed(s)) return [];
      alive.add(u.id);
      return [{ ...u, ambit: s.ambit, slot: s.slot, health: s.health }];
    });
    for (const u of fleet) if (u.protects && !alive.has(u.protects)) u.protects = null;
    if (round === GAUNTLET_ROUNDS.length) return round;
    // showReinforcements(): one of the offers, or a flagship repair when it is hurt.
    const offers = reinforcementOffers(fleet, `${job.seed}:r${round}`);
    for (const o of offers) {
      if (!fits(o.type, o.ambit) || fleet.some((u) => u.type !== COMMAND_SHIP_ID && u.ambit === o.ambit && u.slot === o.slot)) fail(`gauntlet:${round}: reinforcement ${TYPES_BY_ID[o.type].type} offered into ${o.ambit}:${o.slot}, which does not fit`);
    }
    const cmd = fleet.find((u) => u.type === COMMAND_SHIP_ID);
    const choices = offers.length + (cmd && (cmd.health ?? 6) < 6 ? 1 : 0);
    if (!choices) continue;
    const k = Math.floor(rngFor(`${job.seed}:pick${round}`)() * choices);
    if (k < offers.length) {
      const o = offers[k];
      fleet.push({ id: unitId('player', o.type, o.ambit, o.slot), side: 'player', type: o.type, ambit: o.ambit, slot: o.slot, protects: null });
    } else if (cmd) cmd.health = undefined;
  }
  return GAUNTLET_ROUNDS.length;
}

function runJob(i: number): JobResult {
  const job = jobFor(i);
  const tag = `[job ${i} ${job.kind}${job.preset ? ':' + job.preset : ''}${job.day ? ':' + job.day : ''} computer=${job.cpu} autopilot=${job.you}]`;
  const res: JobResult = { i, kind: job.kind, battles: [], failures: [], ms: 0 };
  let n = 0;
  const fail: Fail = (m) => {
    n++;
    if (n <= 6) res.failures.push(`${tag} ${m}`);
    else if (n === 7) res.failures.push(`${tag} … further failures in this job suppressed`);
  };
  const t0 = performance.now();
  try {
    const first = play(job, fail);
    res.battles = first.recs;
    res.gauntletWon = first.gauntletWon;
    res.ms = performance.now() - t0;
    if (i % RERUN === 0) {
      // Determinism: the same seeds and fleets, fought again from nothing, give the same battle.
      const again = play(job, () => {});
      const a = first.prints.join('\n'), b = again.prints.join('\n');
      if (a !== b) {
        const k = first.prints.findIndex((p, j) => p !== again.prints[j]);
        fail(`not deterministic: fought twice, battle ${k + 1} differs\n    first: ${first.prints[k]}\n    again: ${again.prints[k]}`);
      }
    }
  } catch (e) {
    fail(`threw: ${(e as Error)?.stack?.split('\n').slice(0, 6).join('\n    ') || e}`);
  }
  return res;
}

/* ── Child process: run the jobs the parent hands over ─────────────────── */
if (process.env.SOAK_CHILD) {
  process.on('message', (m: { i?: number }) => {
    if (m.i == null) process.exit(0);
    process.send!(runJob(m.i));
  });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}

function runAll(ids: number[]): Promise<JobResult[]> {
  const results: JobResult[] = [];
  const marks = new Set([0.25, 0.5, 0.75].map((f) => Math.ceil(ids.length * f)));
  const progress = () => { if (marks.has(results.length)) console.log(`  … ${results.length}/${ids.length} jobs`); };
  if (WORKERS <= 1) {
    for (const i of ids) {
      results.push(runJob(i));
      if (ONLY) for (const r of results[results.length - 1].battles) console.log(`  job ${i} ${r.scenario}${r.variant ? '/' + r.variant : ''} computer=${r.cpu} autopilot=${r.you}: ${r.winner}${r.stalemate ? ' (' + r.stalemate + ')' : ''} after ${r.blocks} blocks, ${r.txs} txs, ${r.ms} ms`);
      else progress();
    }
    return Promise.resolve(results);
  }
  return new Promise((done) => {
    let next = 0, live = 0;
    const spawn = () => {
      const child = fork(SELF, [], { env: { ...process.env, SOAK_CHILD: '1' } });
      let current: number | null = null;
      const feed = () => {
        current = next < ids.length ? ids[next++] : null;
        child.send(current == null ? {} : { i: current });
      };
      child.on('message', (r: JobResult) => { results.push(r); current = null; progress(); feed(); });
      child.on('exit', (code, signal) => {
        if (current != null) results.push({ i: current, kind: jobFor(current).kind, battles: [], failures: [`[job ${current}] worker died (exit ${code}${signal ? ', ' + signal : ''})`], ms: 0 });
        if (--live === 0) {
          // Jobs nobody got to (every worker died) are failures too.
          const seen = new Set(results.map((r) => r.i));
          for (const i of ids) if (!seen.has(i)) results.push({ i, kind: jobFor(i).kind, battles: [], failures: [`[job ${i}] never ran: no worker left`], ms: 0 });
          done(results);
        }
      });
      live++;
      feed();
    };
    for (let k = 0; k < Math.min(WORKERS, ids.length); k++) spawn();
  });
}

/* ── Aggregation and report ────────────────────────────────────────────── */
interface Agg { n: number; you: number; cpu: number; draw: number; none: number; blocksMin: number; blocksMax: number; blocksSum: number; msSum: number }
const agg = (): Agg => ({ n: 0, you: 0, cpu: 0, draw: 0, none: 0, blocksMin: Infinity, blocksMax: 0, blocksSum: 0, msSum: 0 });
function bump(a: Agg, r: Rec) {
  a.n++; a[r.winner]++;
  a.blocksMin = Math.min(a.blocksMin, r.blocks); a.blocksMax = Math.max(a.blocksMax, r.blocks); a.blocksSum += r.blocks; a.msSum += r.ms;
}
function add(map: Map<string, Agg>, key: string, r: Rec) {
  const a = map.get(key) || agg();
  bump(a, r);
  map.set(key, a);
}
const pct = (k: number, n: number) => (n ? Math.round((100 * k) / n) : 0);
const summary = (a: Agg) => ({
  battles: a.n, youWin: pct(a.you, a.n), cpuWin: pct(a.cpu, a.n), draw: pct(a.draw, a.n), unfinished: a.none,
  blocks: { min: a.n ? a.blocksMin : 0, avg: a.n ? Math.round(a.blocksSum / a.n) : 0, max: a.blocksMax }, msPerBattle: a.n ? Math.round(a.msSum / a.n) : 0,
});
function table(title: string, map: Map<string, Agg>) {
  const w = Math.max(title.length, ...[...map.keys()].map((k) => k.length));
  console.log(`\n${title.padEnd(w)}  battles  you%  cpu%  draw%  blocks min/avg/max  ms/battle`);
  for (const [k, a] of map) {
    const s = summary(a);
    console.log(`${k.padEnd(w)}  ${String(s.battles).padStart(7)}  ${String(s.youWin).padStart(4)}  ${String(s.cpuWin).padStart(4)}  ${String(s.draw).padStart(5)}  ${`${s.blocks.min}/${s.blocks.avg}/${s.blocks.max}`.padStart(18)}  ${String(s.msPerBattle).padStart(9)}`);
  }
}
const sorted = (map: Map<string, Agg>, order: string[]) => new Map([...map].sort(([a], [b]) => {
  const ia = order.findIndex((o) => a.startsWith(o)), ib = order.findIndex((o) => b.startsWith(o));
  return ia - ib || (a < b ? -1 : a > b ? 1 : 0);
}));

async function main() {
  const t0 = performance.now();
  const ids = ONLY || Array.from({ length: N }, (_, i) => i);
  console.log(`soak: ${ids.length} jobs · seed "${BASE}" · ${WORKERS} worker${WORKERS > 1 ? 's' : ''} · determinism re-fight every ${RERUN === 1 ? 'job' : RERUN + 'th job'} · cap ${BLOCK_CAP} blocks`);
  const results = (await runAll(ids)).sort((a, b) => a.i - b.i);
  const wallMs = performance.now() - t0;
  const recs = results.flatMap((r) => r.battles);
  const failures = results.flatMap((r) => r.failures);

  const scenarioOrder = ['preset:easy', 'preset:difficult', 'preset:hard', 'preset:random', 'daily', 'gauntlet', 'mirror', 'fuzz', 'chaos'];
  const matchOrder = DIFFS.flatMap((c) => [...DIFFS, 'monkey'].map((y) => `${c} vs ${y}`));
  const all = agg(), byScenario = new Map<string, Agg>(), byMatchup = new Map<string, Agg>(), byCell = new Map<string, Agg>(), byTwist = new Map<string, Agg>();
  const failedTx: Record<string, number> = {}, okTx: Record<string, number> = {}, stalemates: Record<string, number> = {}, onTime: Record<string, number> = {};
  for (const r of recs) {
    bump(all, r);
    add(byScenario, r.scenario, r);
    add(byMatchup, `${r.cpu} vs ${r.you}`, r);
    add(byCell, `${r.scenario} · ${r.cpu} vs ${r.you}`, r);
    if (r.scenario === 'daily') add(byTwist, r.variant || '?', r);
    for (const [k, v] of Object.entries(r.failedTx)) failedTx[k] = (failedTx[k] || 0) + v;
    for (const [k, v] of Object.entries(r.okTx)) okTx[k] = (okTx[k] || 0) + v;
    if (r.winner === 'draw') { const k = r.stalemate || 'mutual kill'; stalemates[k] = (stalemates[k] || 0) + 1; }
    if (r.stalemate) onTime[r.stalemate + ':' + r.winner] = (onTime[r.stalemate + ':' + r.winner] || 0) + 1;
  }
  const gauntletRuns = results.filter((r) => r.gauntletWon != null).map((r) => r.gauntletWon!);
  const gauntletWon: Record<string, number> = {};
  for (const g of gauntletRuns) gauntletWon[g] = (gauntletWon[g] || 0) + 1;

  // Balance: warnings, never failures.
  const warnings: string[] = [];
  const lean = (label: string, a: Agg, min: number) => {
    if (a.n < min || label.includes('chaos') || label.includes('monkey')) return;   // the monkey is meant to lose
    if (a.you / a.n > 0.9) warnings.push(`${label}: autopilot side wins ${pct(a.you, a.n)}% of ${a.n}`);
    if (a.cpu / a.n > 0.9) warnings.push(`${label}: computer side wins ${pct(a.cpu, a.n)}% of ${a.n}`);
    if (a.draw / a.n > 0.4) warnings.push(`${label}: ${pct(a.draw, a.n)}% of ${a.n} end in a draw`);
  };
  for (const [k, a] of byScenario) lean(k, a, 10);
  for (const [k, a] of byMatchup) lean(k, a, 10);
  const cellWarnings: string[] = [];
  for (const [k, a] of sorted(byCell, scenarioOrder)) {
    const before = warnings.length;
    lean(k, a, 8);
    cellWarnings.push(...warnings.splice(before));
  }
  const broke = (failedTx['computer:insufficient_charge'] || 0) + (failedTx['autopilot:insufficient_charge'] || 0);
  if (broke) warnings.push(`the computer AI sent ${broke} orders it could not afford`);
  const budget = BUDGET_MS * Math.max(1, ids.length / 400);   // ~60 s at the default 400 jobs
  if (wallMs > budget && !ONLY) warnings.push(`took ${(wallMs / 1000).toFixed(1)} s, over the ${(budget / 1000).toFixed(0)} s budget for ${ids.length} jobs`);

  const s = summary(all);
  console.log(`\n${recs.length} battles in ${results.length} jobs · ${(wallMs / 1000).toFixed(1)} s wall · ${s.msPerBattle} ms/battle (per worker) · blocks/battle ${s.blocks.min}/${s.blocks.avg}/${s.blocks.max} · autopilot ${s.youWin}% · computer ${s.cpuWin}% · draw ${s.draw}%`);
  table('scenario', sorted(byScenario, scenarioOrder));
  table('computer vs autopilot', sorted(byMatchup, matchOrder));
  if (byTwist.size) console.log(`\ndaily twists: ${[...byTwist].map(([k, a]) => `${k} ${a.n}`).join(' · ')}`);
  if (gauntletRuns.length) console.log(`gauntlet runs: ${gauntletRuns.length} · rounds won ${Object.entries(gauntletWon).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  const list = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none';
  console.log(`draws: ${list(stalemates)}`);
  console.log(`decided on hull (time at ${DECIDE_AT} turns, or a standoff): ${list(onTime)}`);
  console.log(`executed orders: ${list(okTx)}`);
  console.log(`reverted orders: ${list(failedTx)}`);

  if (warnings.length || cellWarnings.length) {
    console.log(`\nWARN balance / budget (${warnings.length + cellWarnings.length}, not failures):`);
    for (const w of warnings) console.log('  ' + w);
    for (const w of cellWarnings.slice(0, 12)) console.log('  ' + w);
    if (cellWarnings.length > 12) console.log(`  … ${cellWarnings.length - 12} more lopsided preset/difficulty cells in the report`);
  }

  const toObj = (m: Map<string, Agg>) => Object.fromEntries([...m].map(([k, a]) => [k, summary(a)]));
  // A SOAK_ONLY repro run leaves the last full report alone.
  if (!ONLY) mkdirSync(dirname(REPORT), { recursive: true });
  if (!ONLY) writeFileSync(REPORT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: { jobs: ids.length, seed: BASE, workers: WORKERS, rerunEvery: RERUN, blockCap: BLOCK_CAP, frameMs: FRAME_MS, charge: CHARGE },
    wallMs: Math.round(wallMs),
    totals: { ...summary(all), jobs: results.length, failures: failures.length, warnings: warnings.length + cellWarnings.length },
    byScenario: toObj(sorted(byScenario, scenarioOrder)),
    byMatchup: toObj(sorted(byMatchup, matchOrder)),
    byCell: toObj(sorted(byCell, scenarioOrder)),
    dailyTwists: toObj(byTwist),
    gauntlet: { runs: gauntletRuns.length, roundsWon: gauntletWon },
    draws: stalemates,
    decidedOnHull: onTime,
    executedTxs: okTx,
    revertedTxs: failedTx,
    warnings: [...warnings, ...cellWarnings],
    failures,
  }, null, 2) + '\n');
  if (!ONLY) console.log(`\nreport: ${relative(process.cwd(), REPORT) || REPORT}`);

  if (failures.length) {
    console.error(`\nFAIL ${failures.length} invariant failure(s):`);
    for (const f of failures.slice(0, 40)) console.error('  ' + f);
    if (failures.length > 40) console.error(`  … ${failures.length - 40} more in the report`);
    const jobs = [...new Set(results.filter((r) => r.failures.length).map((r) => r.i))];
    console.error(`repro: SOAK_SEED=${BASE} SOAK_ONLY=${jobs.slice(0, 10).join(',')} npx tsx scripts/studio/soak.test.ts`);
    process.exit(1);
  }
  console.log('ok');
}
