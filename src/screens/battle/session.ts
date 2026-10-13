/* One battle's clock and bookkeeping: blocks every `blockMs`, the computer
 * deciding after its reaction delay, one order per block from the player,
 * the simulator's stalemate rules, and the debrief tallies. Driven from the
 * frame loop so pause is just "stop calling update". */
import { Chain, type Block, type Msg } from '../../sim/chain';
import { Ai, type Difficulty } from '../../sim/ai';
import { CPU, YOU } from '../../sim/fleets';

/* The chain never calls a draw; the simulator does, two ways: Command Ships
 * dancing out of reach with no damage landing, or a long stretch where
 * nobody is hurt at all. */
export const QUIET_MOVES = 10;
/** Blocks with nobody hurt before the sim calls it (50: 100 s at 2 s turns; 200 s of nothing read as broken). */
export const QUIET_BLOCKS = 50;

export interface SideStats { attacks: number; damage: number; evaded: number; blocked: number; countered: number; failed: number }
export interface Kill { height: number; structId: string; type: string; owner: string; command: boolean }
export interface Outcome { winner: 'you' | 'cpu' | 'draw'; height: number; stalemate?: 'moves' | 'quiet' }

export class BattleSession {
  readonly chain: Chain;
  readonly ai: Ai;
  readonly startHeight: number;
  blockMs: number;
  running = false;
  finished: Outcome | null = null;
  blockClock = 0;
  private aiClock: number | null = null;
  /** Spectate: the computer also flies your fleet. */
  autopilot: Ai | null = null;
  private autoClock: number | null = null;
  pending: { hash: string; msg: Msg } | null = null;
  stats: Record<string, SideStats> = {};
  kills: Kill[] = [];
  /** Every transaction the chain executed, in order — enough to replay the battle exactly. */
  executed: { height: number; signer: string; msg: Msg }[] = [];
  /** Damage dealt per struct, for the debrief's standout. */
  dealt: Record<string, number> = {};
  fielded: Record<string, number> = {};
  elapsedMs = 0;
  private quietMoves = 0;
  private lastHurt: number;
  onBlock: (b: Block) => void = () => {};
  onFinish: (o: Outcome) => void = () => {};
  onAiOrder: (m: Msg) => void = () => {};
  onAutoOrder: (m: Msg) => void = () => {};

  constructor(chain: Chain, difficulty: Difficulty, seed: string, blockMs: number) {
    this.chain = chain;
    this.ai = new Ai(CPU.id, difficulty, seed);
    this.blockMs = blockMs;
    this.startHeight = chain.height;
    this.lastHurt = chain.height;
    for (const pid of [YOU.id, CPU.id]) this.stats[pid] = { attacks: 0, damage: 0, evaded: 0, blocked: 0, countered: 0, failed: 0 };
    for (const s of Object.values(chain.structs)) this.fielded[s.owner] = (this.fielded[s.owner] || 0) + 1;
  }

  start() { this.running = true; this.scheduleAi(); }
  pause() { this.running = false; }
  resume() { if (!this.finished) this.running = true; }

  /** Charge the player will have when the next block executes. */
  chargeAtNext(pid = YOU.id) { return this.chain.chargeOf(pid, this.chain.height + 1); }
  get nextBlockIn() { return Math.max(0, this.blockMs - this.blockClock); }

  /** Send an order for the next block. One per block: a new order replaces the queued one. */
  submit(msg: Msg): { hash: string; replaced: boolean } {
    let replaced = false;
    if (this.pending) {
      const i = this.chain.mempool.findIndex((t) => t.hash === this.pending!.hash);
      if (i >= 0) { this.chain.mempool.splice(i, 1); replaced = true; }
    }
    const hash = this.chain.submit(YOU.id, msg);
    this.pending = { hash, msg };
    return { hash, replaced };
  }
  cancelPending() {
    if (!this.pending) return;
    const i = this.chain.mempool.findIndex((t) => t.hash === this.pending!.hash);
    if (i >= 0) this.chain.mempool.splice(i, 1);
    this.pending = null;
  }

  update(dtMs: number) {
    if (!this.running || this.finished) return;
    this.elapsedMs += dtMs;
    this.blockClock += dtMs;
    if (this.autopilot && this.autoClock != null) {
      this.autoClock -= dtMs;
      if (this.autoClock <= 0) {
        this.autoClock = null;
        const msg = this.autopilot.decide(this.chain);
        if (msg) { this.chain.submit(YOU.id, msg); this.onAutoOrder(msg); }
      }
    }
    if (this.aiClock != null) {
      this.aiClock -= dtMs;
      if (this.aiClock <= 0) {
        this.aiClock = null;
        const msg = this.ai.decide(this.chain);
        if (msg) { this.chain.submit(CPU.id, msg); this.onAiOrder(msg); }
      }
    }
    if (this.blockClock >= this.blockMs) {
      this.blockClock -= this.blockMs;
      this.block();
    }
  }

  private scheduleAi() {
    // A reaction slower than a block carries over: the computer decides on
    // the chain as it stands when it gets there.
    if (this.autopilot && this.autoClock == null) this.autoClock = this.autopilot.level.reactionMs * (0.75 + this.autopilot.rand() * 0.5);
    if (this.aiClock != null) return;
    this.aiClock = this.ai.level.reactionMs * (0.75 + this.ai.rand() * 0.5);
  }

  private block() {
    const c = this.chain;
    const b = c.produceBlock();
    let hurt = false, cmdMoves = 0;
    for (const tx of b.txs) {
      this.executed.push({ height: b.height, signer: tx.signer, msg: tx.msg });
      if (this.pending && tx.hash === this.pending.hash) this.pending = null;
      if (!tx.ok) { this.stats[tx.signer] && this.stats[tx.signer].failed++; continue; }
      for (const e of tx.events) {
        const d = e.detail || {};
        if (e.category === 'struct_health' && d.health_old != null && d.health < d.health_old) hurt = true;
        if (e.category === 'struct_move') {
          const s = c.structs[d.struct_id];
          if (s && c.isCommand(s)) cmdMoves++;
        }
        if (e.category === 'struct_attack') this.tallyAttack(d);
        if (e.category === 'struct_status') this.tallyKill(d, b.height);
      }
    }
    this.quietMoves = hurt ? 0 : this.quietMoves + cmdMoves;
    if (hurt) this.lastHurt = b.height;
    this.onBlock(b);

    const left = c.fleetsAtBattle();
    if (left.length < 2) {
      this.finish({ winner: left.length === 0 ? 'draw' : left[0] === YOU.fleetId ? 'you' : 'cpu', height: b.height });
      return;
    }
    const stalemate = this.quietMoves >= QUIET_MOVES ? 'moves' : b.height - this.lastHurt >= QUIET_BLOCKS ? 'quiet' : null;
    if (stalemate) { this.finish({ winner: 'draw', height: b.height, stalemate }); return; }
    this.scheduleAi();
  }

  private tallyAttack(d: any) {
    const st = this.stats[d.attackerPlayerId];
    if (!st) return;
    st.attacks++;
    // Multi-shot rows repeat the target's block/evade flags: count once per target.
    const perTarget = new Map<string, { blocked: boolean; evaded: boolean }>();
    for (const r of d.eventAttackShotDetail || []) {
      st.damage += Number(r.damage || 0);
      this.dealt[d.attackerStructId] = (this.dealt[d.attackerStructId] || 0) + Number(r.damage || 0);
      st.countered += Number(r.targetCounteredDamage || 0);
      for (const cd of r.eventAttackDefenderCounterDetail || []) st.countered += Number(cd.counterDamage || 0);
      const t = perTarget.get(r.targetStructId) || { blocked: false, evaded: false };
      t.blocked ||= !!r.blocked; t.evaded ||= !!r.evaded;
      perTarget.set(r.targetStructId, t);
    }
    for (const t of perTarget.values()) { if (t.blocked) st.blocked++; if (t.evaded) st.evaded++; }
  }

  /* Kills come from the status frames, as the host derives them: every
   * struct whose DESTROYED bit flips on, however it died. */
  private tallyKill(d: any, height: number) {
    if (!(d.status & 32) || (d.status_old & 32)) return;
    const s = this.chain.structs[d.struct_id];
    if (!s) return;
    this.kills.push({ height, structId: s.id, type: this.chain.typeOf(s).type, owner: s.owner, command: this.chain.isCommand(s) });
  }

  private finish(o: Outcome) {
    this.finished = o;
    this.running = false;
    this.onFinish(o);
  }

  standing() {
    const out: Record<string, number> = { [YOU.id]: 0, [CPU.id]: 0 };
    for (const s of Object.values(this.chain.structs)) if (!this.chain.isDestroyed(s)) out[s.owner] = (out[s.owner] || 0) + 1;
    return out;
  }
}

/** Fork the chain N times to estimate an attack's outcome: the same rules,
 * the same rolls a block would make — just played ahead. */
export function predictAttack(chain: Chain, msg: Msg, samples = 32) {
  let ok = 0, hits = 0, kills = 0, attackerDies = 0, dmg = 0, counterDmg = 0, blocked = 0, evaded = 0;
  let error: string | null = null;
  const am = msg as Extract<Msg, { '@type': '/structs.structs.MsgStructAttack' }>;
  for (let i = 0; i < samples; i++) {
    const f = chain.fork('predict:' + i);
    f.mempool = [];
    // Assume the charge is there: we are predicting the exchange, not the timing.
    const p = f.players[YOU.id];
    if (p) p.lastAction = Math.min(p.lastAction, f.height - 60);
    f.submit(YOU.id, msg);
    const b = f.produceBlock();
    const tx = b.txs[0];
    if (!tx.ok) { error = tx.error; continue; }
    ok++;
    const atk = tx.events.find((e) => e.category === 'struct_attack')?.detail;
    if (!atk) continue;
    let landed = 0, wasBlocked = false, wasEvaded = false;
    for (const r of atk.eventAttackShotDetail) {
      landed += Number(r.damage || 0);
      if (r.blocked) wasBlocked = true;
      if (r.evaded) wasEvaded = true;
      counterDmg += Number(r.targetCounteredDamage || 0);
      for (const c of r.eventAttackDefenderCounterDetail || []) counterDmg += Number(c.counterDamage || 0);
    }
    if (wasBlocked) blocked++;
    if (wasEvaded) evaded++;
    if (landed > 0) hits++;
    dmg += landed;
    const t = f.structs[am.targetStructId[0]];
    if (t && f.isDestroyed(t)) kills++;
    const a = f.structs[am.operatingStructId];
    if (a && f.isDestroyed(a)) attackerDies++;
  }
  if (!ok) return { error: error || 'not possible' };
  return {
    error: null,
    hit: hits / ok, kill: kills / ok, attackerDies: attackerDies / ok, damage: dmg / ok,
    counter: counterDmg / ok, blocked: blocked / ok, evaded: evaded / ok,
  };
}
