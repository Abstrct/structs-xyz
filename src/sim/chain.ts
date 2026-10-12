/* A local structsd: the struct combat messages executed the way the chain
 * executes them, block by block. A TypeScript port of structs-universe's
 * simulator-chain.js, which is itself a transcription of structsd's keeper
 * (x/structs). Each rule names the chain function it came from.
 *
 * Two fleets meet AWAY from both home planets, so there is no planetary
 * struct, no planetary defense cannon and no jamming-satellite interception,
 * and a destroyed Command Ship always defeats its fleet
 * (StructCache.CanTriggerRaidDefeatByDestruction: "not at home").
 *
 * Transactions queue in a mempool and run at the next block in the order they
 * were sent. A message that fails reverts entirely, as a Cosmos tx does. */
import { hash32, mulberry } from '../core/util';
import { AMBIT_FLAG, AMBITS, type Ambit, type StructType, type WeaponSystem, weaponField, canTargetAmbit } from '../data/catalogue';

export const STATUS = { MATERIALIZED: 1, BUILT: 2, ONLINE: 4, STORED: 8, HIDDEN: 16, DESTROYED: 32, LOCKED: 64 } as const;
export const STRUCT_SWEEP_DELAY = 5;          // types/keys.go StructSweepDelay
const COMMAND_STRUCT = 'Command Ship';         // types.CommandStruct

export class ChainError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export interface SimPlayer { id: string; name: string; fleetId: string; nonce: number; lastAction: number; capacity: number; load: number }
export interface SimFleet { id: string; owner: string; atBattle: boolean; commandStruct: string | null; home: string | null }
export interface SimStruct {
  id: string; typeId: number; owner: string; locationType: 'fleet'; locationId: string;
  ambit: Ambit; slot: number; health: number; status: number; protectedStructId: string | null; destroyedAt: number | null;
}

export type Msg =
  | { '@type': '/structs.structs.MsgStructAttack'; operatingStructId: string; targetStructId: string[]; weaponSystem: WeaponSystem }
  | { '@type': '/structs.structs.MsgStructDefenseSet'; defenderStructId: string; protectedStructId: string }
  | { '@type': '/structs.structs.MsgStructDefenseClear'; defenderStructId: string }
  | { '@type': '/structs.structs.MsgStructMove'; structId: string; locationType: 'fleet'; ambit: Ambit; slot: number }
  | { '@type': '/structs.structs.MsgStructStealthActivate'; structId: string }
  | { '@type': '/structs.structs.MsgStructStealthDeactivate'; structId: string }
  | { '@type': '/structs.structs.MsgStructActivate'; structId: string }
  | { '@type': '/structs.structs.MsgStructDeactivate'; structId: string };

export interface ChainEvent { category: string; subject?: string; detail: any }
export interface TxResult { hash: string; signer: string; type: string; ok: boolean; error: string | null; code?: string; events: ChainEvent[]; msg: Msg }
export interface Block { height: number; txs: TxResult[]; events: ChainEvent[] }

export interface ShotRow {
  targetStructId: string; targetStructTypeId: number; targetStructType: string; targetStructOperatingAmbit: Ambit; targetStructSlot: number;
  targetPlayerId: string; targetHealthBefore: number; targetHealthAfter: number; targetDestroyed: boolean; targetHealthMax: number;
  eventAttackDefenderCounterDetail: CounterRow[] | null;
  evaded?: boolean; evadedCause?: string;
  blocked?: boolean; blockedByStructId?: string; blockedByStructType?: string; blockerHealthBefore?: number; blockerHealthAfter?: number; blockerDestroyed?: boolean; blockerHealthMax?: number;
  damageDealt?: number; damage?: number; damageReduction?: number; damageReductionCause?: string; armourPiercing?: boolean;
  targetCountered?: boolean; targetCounteredDamage?: number; targetCounterDestroyedAttacker?: boolean;
  postDestructionDamageToAttacker?: boolean; postDestructionDamage?: number; postDestructionDamageDestroyedAttacker?: boolean;
  [k: string]: unknown;
}
export interface CounterRow { counterByStructId: string; counterDamage: number; counterDestroyedAttacker: boolean; counterByStructType: string; counterByStructOperatingAmbit: Ambit; [k: string]: unknown }
export interface AttackDetail {
  attackerPlayerId: string; attackerStructId: string; attackerStructTypeId: number; attackerStructType: string;
  attackerStructOperatingAmbit: Ambit; attackerStructSlot: number; weaponSystem: WeaponSystem; weaponControl: string;
  attackerStructLocationType?: string; attackerStructLocationId?: string;
  activeWeaponry: string; attackerHealthBefore: number; attackerHealthMax: number; attackerHealthAfter?: number;
  eventAttackShotDetail: ShotRow[]; recoilDamageToAttacker?: boolean; recoilDamage?: number; recoilDamageDestroyedAttacker?: boolean;
}

interface Ctx { tx: { hash: string; signer: string; msg: Msg }; typed: ChainEvent[]; before: Record<string, { health: number; status: number; ambit: Ambit; slot: number }>; order: string[]; counterSpent: Record<string, boolean>; blockSeed: number }

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export interface ChainSetup {
  types: StructType[]; seed?: string; height?: number; planetId?: string;
  players: { id: string; name?: string; fleetId: string; charge?: number; homePlanetId?: string }[];
  structs: { id: string; typeId: number; owner: string; ambit: Ambit; slot: number; protects?: string | null; health?: number }[];
}

export class Chain {
  types: Record<number, StructType> = {};
  seed: string;
  height: number;
  planetId: string;
  players: Record<string, SimPlayer> = {};
  fleets: Record<string, SimFleet> = {};
  structs: Record<string, SimStruct> = {};
  defenders: Record<string, Record<string, true>> = {};     // protectedStructId → defenders
  destructionQueue: Record<number, string[]> = {};
  mempool: { hash: string; signer: string; msg: Msg; submittedAt: number }[] = [];
  txSeq = 0;
  private ctx: Ctx | null = null;

  constructor(opts: ChainSetup) {
    for (const t of opts.types) this.types[t.id] = t;
    this.seed = String(opts.seed ?? '');
    this.height = opts.height || 1;
    this.planetId = opts.planetId || '2-1';
    for (const p of opts.players) {
      this.players[p.id] = {
        id: p.id, name: p.name || p.id, fleetId: p.fleetId, nonce: 0,
        // Charge is blocks since the last action (PlayerCache.GetCharge).
        lastAction: this.height - (p.charge == null ? 0 : p.charge),
        capacity: 0, load: 0,
      };
      this.fleets[p.fleetId] = { id: p.fleetId, owner: p.id, atBattle: true, commandStruct: null, home: p.homePlanetId || null };
    }
    for (const s of opts.structs) {
      const t = this.types[s.typeId];
      if (!t) throw new ChainError('unknown_type', 'unknown struct type ' + s.typeId);
      const owner = this.players[s.owner];
      this.structs[s.id] = {
        id: s.id, typeId: t.id, owner: s.owner, locationType: 'fleet', locationId: owner.fleetId,
        ambit: s.ambit, slot: t.type === COMMAND_STRUCT ? 0 : s.slot,
        health: s.health != null ? Math.max(1, Math.min(t.maxHealth, s.health)) : t.maxHealth, status: STATUS.MATERIALIZED | STATUS.BUILT | STATUS.ONLINE,
        protectedStructId: null, destroyedAt: null,
      };
      owner.load += t.passiveDraw || 0;
      if (t.type === COMMAND_STRUCT) this.fleets[owner.fleetId].commandStruct = s.id;
    }
    // Every struct is online, so capacity is what they draw: a deactivated
    // struct can come back (ActivationReadinessCheck → CanSupportLoadAddition).
    for (const pid of Object.keys(this.players)) this.players[pid].capacity = this.players[pid].load;
    for (const s of opts.structs) if (s.protects) this.setDefender(s.protects, s.id);
  }

  /* ── Reads ───────────────────────────────────────────────────────────── */
  typeOf(s: SimStruct) { return this.types[s.typeId]; }
  get(id: string) { return this.structs[id] || null; }
  isDestroyed(s: SimStruct) { return (s.status & STATUS.DESTROYED) !== 0; }
  isOnline(s: SimStruct) { return (s.status & STATUS.ONLINE) !== 0; }
  isBuilt(s: SimStruct) { return (s.status & STATUS.BUILT) !== 0; }
  isHidden(s: SimStruct) { return (s.status & STATUS.HIDDEN) !== 0; }
  isCommand(s: SimStruct) { return this.typeOf(s).type === COMMAND_STRUCT; }
  /** PlayerCache.GetCharge at the block being executed. */
  chargeOf(pid: string, atHeight?: number) {
    const p = this.players[pid];
    return p ? (atHeight == null ? this.height : atHeight) - p.lastAction : 0;
  }
  /** GetAllStructDefender: defender ids under the protected struct's prefix, in key order. */
  defendersOf(protectedId: string) { return Object.keys(this.defenders[protectedId] || {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); }

  /* ── Transactions ────────────────────────────────────────────────────── */

  /** Queue a message for the next block. Returns the tx hash. */
  submit(signer: string, msg: Msg) {
    this.txSeq++;
    const hash = (hash32(this.seed + '|' + this.height + '|' + this.txSeq).toString(16).padStart(8, '0')
      + hash32(signer + '|' + this.txSeq + '|' + JSON.stringify(msg)).toString(16).padStart(8, '0')
      + this.txSeq.toString(16).padStart(8, '0')).toUpperCase();
    this.mempool.push({ hash, signer, msg, submittedAt: this.height });
    return hash;
  }

  /** Produce the next block: BeginBlock (sweep), then every queued tx in order. */
  produceBlock(): Block {
    this.height++;
    const block: Block = { height: this.height, txs: [], events: [] };
    this.sweepDestroyed(block);
    const txs = this.mempool.splice(0);
    for (const tx of txs) block.txs.push(this.deliver(tx, block));
    return block;
  }

  /* keeper/struct.go StructSweepDestroyed: structs destroyed
   * STRUCT_SWEEP_DELAY blocks ago leave their slot and the store. */
  private sweepDestroyed(block: Block) {
    const due = this.height - STRUCT_SWEEP_DELAY;
    const ids = (this.destructionQueue[due] || []).slice().sort();
    delete this.destructionQueue[due];
    for (const id of ids) {
      const s = this.structs[id];
      if (!s) continue;
      if (this.isCommand(s)) {
        const f = this.fleets[s.locationId];
        if (f && f.commandStruct === s.id) f.commandStruct = null;
      }
      delete this.structs[id];
      block.events.push({ category: 'struct_sweep', detail: { struct_id: id } });
    }
  }

  private deliver(tx: { hash: string; signer: string; msg: Msg }, block: Block): TxResult {
    const saved = clone({ players: this.players, fleets: this.fleets, structs: this.structs, defenders: this.defenders, destructionQueue: this.destructionQueue });
    const ctx: Ctx = { tx, typed: [], before: {}, order: [], counterSpent: {}, blockSeed: hash32(this.seed + '#' + this.height) };
    this.ctx = ctx;
    const result: TxResult = { hash: tx.hash, signer: tx.signer, type: tx.msg['@type'], ok: true, error: null, events: [], msg: tx.msg };
    try {
      this.route(tx.signer, tx.msg);
      result.events = ctx.typed.concat(this.commitFrames(ctx));
    } catch (e) {
      Object.assign(this, saved);
      result.ok = false;
      result.error = String((e as Error)?.message || e);
      result.code = (e as ChainError)?.code || 'error';
    }
    this.ctx = null;
    block.events = block.events.concat(result.events);
    return result;
  }

  private route(signer: string, msg: Msg) {
    switch (msg['@type']) {
      case '/structs.structs.MsgStructAttack': return this.structAttack(signer, msg);
      case '/structs.structs.MsgStructDefenseSet': return this.structDefenseSet(signer, msg);
      case '/structs.structs.MsgStructDefenseClear': return this.structDefenseClear(signer, msg);
      case '/structs.structs.MsgStructMove': return this.structMove(signer, msg);
      case '/structs.structs.MsgStructStealthActivate': return this.structStealth(signer, msg.structId, true);
      case '/structs.structs.MsgStructStealthDeactivate': return this.structStealth(signer, msg.structId, false);
      case '/structs.structs.MsgStructActivate': return this.structActivate(signer, msg.structId);
      case '/structs.structs.MsgStructDeactivate': return this.structDeactivate(signer, msg.structId);
      default: throw new ChainError('unknown_msg', 'unsupported message');
    }
  }

  /* Attribute writes go through here so the commit can report each struct's
   * net change once, as the indexer does from the attribute store. */
  private touch(s: SimStruct) {
    const ctx = this.ctx;
    if (!ctx || ctx.before[s.id]) return;
    ctx.before[s.id] = { health: s.health, status: s.status, ambit: s.ambit, slot: s.slot };
    ctx.order.push(s.id);
  }
  private commitFrames(ctx: Ctx): ChainEvent[] {
    const out: ChainEvent[] = [];
    for (const id of ctx.order) {
      const s = this.structs[id], was = ctx.before[id];
      if (!s) continue;
      const subject = 'structs.planet.' + this.planetId + '.' + s.owner;
      if (was.ambit !== s.ambit || was.slot !== s.slot) out.push({ category: 'struct_move', subject, detail: { struct_id: id, ambit: s.ambit, slot: s.slot, location_type: s.locationType, location_id: s.locationId } });
      if (was.health !== s.health) out.push({ category: 'struct_health', subject, detail: { struct_id: id, health: s.health, health_old: was.health } });
      if (was.status !== s.status) out.push({ category: 'struct_status', subject, detail: { struct_id: id, status: s.status, status_old: was.status } });
    }
    return out;
  }
  private emit(category: string, detail: unknown, subjectOwner?: string) {
    this.ctx!.typed.push({ category, subject: 'structs.planet.' + this.planetId + (subjectOwner ? '.' + subjectOwner : ''), detail });
  }

  /* Status setters (StructCache.StatusAdd… / StatusRemove…). */
  private setStatus(s: SimStruct, bit: number, on: boolean) { this.touch(s); s.status = on ? (s.status | bit) : (s.status & ~bit); }
  /* CurrentContext.SetStructAttributeDecrement: saturates at zero. */
  private decrementHealth(s: SimStruct, amount: number) { this.touch(s); s.health = amount < s.health ? s.health - amount : 0; return s.health; }
  /* PlayerCache.Discharge: lastAction becomes this block. */
  private discharge(pid: string) { this.players[pid].lastAction = this.height; }

  /* StructCache.IsSuccessful: a source seeded with the block seed plus the
   * owner's incremented nonce, then Intn(den) + 1 <= num. */
  private isSuccessful(s: SimStruct, num: number, den: number) {
    if (!den) throw new ChainError('fraction', 'invalid success rate ' + num + '/' + den);
    const owner = this.players[s.owner];
    owner.nonce += 1;
    const draw = Math.floor(mulberry((this.ctx!.blockSeed + owner.nonce) >>> 0)() * den) + 1;
    return draw <= num;
  }

  /* ── Struct predicates (keeper/struct_cache.go) ──────────────────────── */
  private mustLoad(id: string) { const s = this.structs[id]; if (!s) throw new ChainError('not_found', 'struct ' + id + ' not found'); return s; }
  private canBePlayedBy(s: SimStruct | undefined, signer: string): asserts s is SimStruct {
    if (!s || s.owner !== signer) throw new ChainError('permission', 'player ' + signer + ' cannot play struct ' + (s ? s.id : '?'));
  }
  private readinessCheck(s: SimStruct) {
    if (this.isDestroyed(s)) throw new ChainError('struct_state', s.id + ' is destroyed');
    if (!this.isOnline(s)) throw new ChainError('struct_state', s.id + ' is offline');
  }
  fleetOf(s: SimStruct) { return s.locationType === 'fleet' ? this.fleets[s.locationId] : null; }
  /** isReachable: both fleets are away on the same location list. A defeated fleet has gone home. */
  isReachable(from: SimStruct, to: SimStruct) { const a = this.fleetOf(from), b = this.fleetOf(to); return !!(a && b && a.atBattle && b.atBattle); }
  /** IsProtecting: defender and target share a location. */
  isProtecting(defender: SimStruct, target: SimStruct) { return defender.locationId === target.locationId; }
  canDefend(s: SimStruct) { return !!this.typeOf(s).canDefend; }

  /** Why `attacker` cannot hit `target` with `ws`, or null if it can. */
  canAttack(attacker: SimStruct, target: SimStruct, ws: WeaponSystem): string | null {
    const at = this.typeOf(attacker);
    if (this.isDestroyed(target)) return 'destroyed';
    if (!this.isBuilt(target)) return 'unbuilt';
    if (!canTargetAmbit(at, ws, attacker.ambit, target.ambit)) return 'out_of_range';
    if (this.isHidden(target) && target.ambit !== attacker.ambit) return 'hidden';
    if (!this.isReachable(attacker, target)) return 'unreachable';
    return null;
  }
  canCounterAttack(counter: SimStruct, attacker: SimStruct): string | null {
    if (this.isDestroyed(counter) || !this.isOnline(counter)) return 'readiness';
    if (this.ctx?.counterSpent[counter.id]) return 'spent';
    if (this.isDestroyed(attacker) || this.isDestroyed(counter)) return 'destroyed';
    if (!canCounterTargetAmbit(this.typeOf(counter), counter.ambit, attacker.ambit)) return 'out_of_range';
    if (!this.isReachable(counter, attacker)) return 'unreachable';
    return null;
  }

  /** DestroyAndCommit — idempotent. */
  private destroy(s: SimStruct) {
    if (this.isDestroyed(s)) return;
    const t = this.typeOf(s);
    this.goOffline(s);
    this.destroyStructDefender(s.id);
    this.setStatus(s, STATUS.DESTROYED, true);
    s.destroyedAt = this.height;
    // CanTriggerRaidDefeatByDestruction: a Command Ship away from home.
    if (t.triggerRaidDefeatByDestruction) {
      const fleet = this.fleetOf(s);
      if (fleet && fleet.atBattle) {
        this.emit('raid_status', { status: 'attackerDefeated', fleet_id: fleet.id, planet_id: this.planetId }, s.owner);
        fleet.atBattle = false;
      }
    }
    (this.destructionQueue[this.height] = this.destructionQueue[this.height] || []).push(s.id);
  }
  private goOffline(s: SimStruct) {
    if (!this.isOnline(s)) return;
    this.players[s.owner].load -= this.typeOf(s).passiveDraw || 0;
    this.setStatus(s, STATUS.ONLINE, false);
  }
  private goOnline(s: SimStruct) {
    this.players[s.owner].load += this.typeOf(s).passiveDraw || 0;
    this.setStatus(s, STATUS.ONLINE, true);
  }

  /* keeper/struct_defender.go */
  private setDefender(protectedId: string, defenderId: string) {
    const d = this.structs[defenderId];
    if (d.protectedStructId && d.protectedStructId !== protectedId) this.removeDefender(d.protectedStructId, defenderId);
    (this.defenders[protectedId] = this.defenders[protectedId] || {})[defenderId] = true;
    d.protectedStructId = protectedId;
    if (this.ctx) this.emit('struct_defense_add', { defender_struct_id: defenderId, protected_struct_id: protectedId }, d.owner);
  }
  private removeDefender(protectedId: string, defenderId: string) {
    if (this.defenders[protectedId]) {
      delete this.defenders[protectedId][defenderId];
      if (!Object.keys(this.defenders[protectedId]).length) delete this.defenders[protectedId];
    }
    if (this.ctx) this.emit('struct_defense_remove', { defender_struct_id: defenderId, protected_struct_id: protectedId }, this.structs[defenderId]?.owner);
  }
  private clearDefender(protectedId: string, defenderId: string) {
    this.removeDefender(protectedId, defenderId);
    const d = this.structs[defenderId];
    if (d) d.protectedStructId = null;
  }
  /* DestroyStructDefender: clears only the destroyed struct's own posture. */
  private destroyStructDefender(defenderId: string) {
    const d = this.structs[defenderId];
    if (d && d.protectedStructId) this.clearDefender(d.protectedStructId, defenderId);
  }

  /* ── MsgStructAttack (msg_server_struct_attack.go + attack_context.go) ─ */
  private structAttack(signer: string, msg: Extract<Msg, { '@type': '/structs.structs.MsgStructAttack' }>) {
    const attacker = this.structs[msg.operatingStructId];
    this.canBePlayedBy(attacker, signer);
    this.readinessCheck(attacker);
    const ws = msg.weaponSystem;
    if (ws !== 'primaryWeapon' && ws !== 'secondaryWeapon') throw new ChainError('parameter', 'weapon_system invalid');
    const at = this.typeOf(attacker);
    if (weaponField(at, ws, '') === 'noActiveWeaponry') throw new ChainError('capability', 'struct_type_' + at.id + ' has no ' + ws);
    const cost = weaponField(at, ws, 'Charge') || 0;
    const charge = this.chargeOf(signer);
    if (charge < cost) throw new ChainError('insufficient_charge', 'insufficient charge for attack: ' + charge + ' < ' + cost);
    this.setStatus(attacker, STATUS.HIDDEN, false);                 // StatusRemoveHidden
    const targets = msg.targetStructId || [];
    if (targets.length !== (weaponField(at, ws, 'Targets') || 0)) throw new ChainError('combat_targeting', 'incomplete_targeting');

    const detail: AttackDetail = {
      attackerPlayerId: attacker.owner, attackerStructId: attacker.id, attackerStructTypeId: at.id,
      attackerStructType: at.type, attackerStructLocationType: attacker.locationType, attackerStructLocationId: attacker.locationId,
      attackerStructOperatingAmbit: attacker.ambit, attackerStructSlot: attacker.slot,
      weaponSystem: ws, weaponControl: weaponField(at, ws, 'Control'), activeWeaponry: weaponField(at, ws, ''),
      attackerHealthBefore: attacker.health, attackerHealthMax: at.maxHealth, eventAttackShotDetail: [],
    };
    for (const tid of targets) {
      const target = this.structs[tid];
      if (!target) throw new ChainError('not_found', 'struct ' + tid + ' not found');
      detail.eventAttackShotDetail = detail.eventAttackShotDetail.concat(this.shotAgainst(attacker, at, ws, target));
      if (this.isDestroyed(attacker)) break;
    }
    // ResolveRecoil
    let recoil = 0, recoilKilled = false;
    if (!this.isDestroyed(attacker)) {
      recoil = weaponField(at, ws, 'RecoilDamage') || 0;
      if (recoil) {
        if (this.decrementHealth(attacker, recoil) === 0) this.destroy(attacker);
        recoilKilled = this.isDestroyed(attacker);
      }
    }
    detail.attackerHealthAfter = attacker.health;
    if (recoil > 0) { detail.recoilDamageToAttacker = true; detail.recoilDamage = recoil; detail.recoilDamageDestroyedAttacker = recoilKilled; }
    this.emit('struct_attack', detail, attacker.owner);
    this.discharge(signer);
  }

  /* One target: BeginShot … EndShot. */
  private shotAgainst(attacker: SimStruct, at: StructType, ws: WeaponSystem, target: SimStruct): ShotRow[] {
    const tt = this.typeOf(target);
    const healthBefore = target.health;
    const why = this.canAttack(attacker, target, ws);
    if (why) throw new ChainError('combat_targeting', attacker.id + ' cannot attack ' + target.id + ': ' + why);
    // resolveEvasion: one roll per target, on the target owner's nonce.
    const control = weaponField(at, ws, 'Control');
    const num = control === 'guided' ? tt.guidedDefensiveSuccessRateNumerator : tt.unguidedDefensiveSuccessRateNumerator;
    const den = control === 'guided' ? tt.guidedDefensiveSuccessRateDenominator : tt.unguidedDefensiveSuccessRateDenominator;
    let evaded = false;
    if (num && den) evaded = this.isSuccessful(target, num, den);
    const r: ShotResolution = { evaded, counters: [], block: null, volley: null, targetCounter: null };
    this.resolveDefenders(attacker, at, ws, target, evaded, r);
    if (!evaded && !(r.block && r.block.blocked) && this.isOnline(attacker)) r.volley = this.volleyOn(attacker, at, ws, target, false);
    // ResolveTargetCounter
    if (at.attackCounterable && weaponField(at, ws, 'Counterable')) {
      if (!this.canCounterAttack(target, attacker)) r.targetCounter = this.counterDamage(attacker, target);
    }
    return this.endShot(target, tt, healthBefore, r);
  }

  private resolveDefenders(attacker: SimStruct, at: StructType, ws: WeaponSystem, target: SimStruct, skipBlock: boolean, r: ShotResolution) {
    const blockable = !!weaponField(at, ws, 'Blockable');
    const counterable = !!(at.attackCounterable && weaponField(at, ws, 'Counterable'));
    if (!blockable && !counterable) return;
    const wantBlock = blockable && !skipBlock;
    let blocker: SimStruct | null = null;
    for (const did of this.defendersOf(target.id)) {
      const d = this.structs[did];
      if (!d) continue;
      if (d.id === target.id || d.id === attacker.id) continue;
      if (this.isDestroyed(d) || !this.isOnline(d)) continue;
      if (!this.isProtecting(d, target)) continue;
      if (!this.canDefend(d)) continue;
      if (counterable && !this.canCounterAttack(d, attacker)) r.counters.push(this.counterDamage(attacker, d));
      if (wantBlock && !blocker && d.ambit === target.ambit) blocker = d;
      if (this.isDestroyed(attacker)) break;
    }
    if (this.isDestroyed(attacker)) return;
    if (blocker) {
      if (this.isDestroyed(blocker) || !this.isOnline(blocker)) return;
      if (this.isDestroyed(attacker) || !this.isOnline(attacker)) return;
      if (blocker.ambit !== target.ambit) return;
      r.block = { blocked: true, blocker, healthBefore: blocker.health, healthMax: this.typeOf(blocker).maxHealth };
      r.volley = this.volleyOn(attacker, at, ws, blocker, true);
    }
  }

  /* resolveCounterDamage: `counter` hits the attacker. */
  private counterDamage(attacker: SimStruct, counter: SimStruct): CounterResult {
    const ct = this.typeOf(counter);
    const res: CounterResult = { counter, damage: 0, attackerDestroyed: false, postDestruction: null };
    if (this.isDestroyed(attacker)) return res;
    const damage = attacker.ambit === counter.ambit ? ct.counterAttackSameAmbit : ct.counterAttack;
    res.damage = damage || 0;
    if (damage) {
      this.ctx!.counterSpent[counter.id] = true;
      if (this.decrementHealth(attacker, damage) === 0) {
        if (this.typeOf(attacker).postDestructionDamage > 0) res.postDestruction = this.postDestruction(counter, attacker);
        this.destroy(attacker);
      }
    }
    res.attackerDestroyed = this.isDestroyed(attacker);
    res.weaponSystem = counterWeaponSystem(ct, counter.ambit, attacker.ambit);
    res.weaponControl = weaponField(ct, res.weaponSystem, 'Control');
    res.activeWeaponry = weaponField(ct, res.weaponSystem, '');
    res.passiveWeaponry = ct.passiveWeaponry;
    return res;
  }

  /* applyPostDestructionDamageCore: `victim` explodes onto `survivor`. */
  private postDestruction(survivor: SimStruct, victim: SimStruct) {
    if (this.isDestroyed(survivor)) return { damage: 0, attackerDestroyed: false, passive: 'noPassiveWeaponry' };
    const vt = this.typeOf(victim);
    const damage = vt.postDestructionDamage || 0;
    if (damage && this.decrementHealth(survivor, damage) === 0) this.destroy(survivor);
    return { damage, attackerDestroyed: this.isDestroyed(survivor), passive: vt.passiveWeaponry };
  }

  /* resolveVolleyDamageOn */
  private volleyOn(attacker: SimStruct, at: StructType, ws: WeaponSystem, victim: SimStruct, isBlocker: boolean): Volley {
    if (this.isDestroyed(attacker)) return { isBlocker, healthAfter: victim.health, shots: [], rolled: 0, reduction: 0, net: 0, piercing: false, destroyed: false, postDestruction: null, unitDefenses: '' };
    if (this.isDestroyed(victim)) return { isBlocker, healthAfter: 0, shots: [], rolled: 0, reduction: 0, net: 0, piercing: false, destroyed: false, postDestruction: null, unitDefenses: '' };
    const n = weaponField(at, ws, 'Shots') || 0;
    const vt = this.typeOf(victim);
    if (!n) return { isBlocker, healthAfter: victim.health, shots: [], rolled: 0, reduction: 0, net: 0, piercing: false, destroyed: false, postDestruction: null, unitDefenses: vt.unitDefenses };
    const shots: { hit: boolean; damage: number }[] = [];
    let rolled = 0;
    const guaranteed = weaponField(at, ws, 'GuaranteedShots') || 0;
    for (let i = 0; i < n; i++) {
      const hit = i < guaranteed || this.isSuccessful(attacker, weaponField(at, ws, 'ShotSuccessRateNumerator'), weaponField(at, ws, 'ShotSuccessRateDenominator'));
      const d = hit ? weaponField(at, ws, 'Damage') : 0;
      shots.push({ hit, damage: d });
      rolled += d;
    }
    let net = rolled, reduction = vt.attackReduction || 0;
    const piercing = reduction > 0 && !!weaponField(at, ws, 'ArmourPiercing');
    if (piercing) reduction = 0;
    if (rolled !== 0 && reduction > 0) net = reduction >= rolled ? 1 : rolled - reduction;
    const vr: Volley = { shots, rolled, reduction, unitDefenses: vt.unitDefenses, piercing, net, isBlocker, destroyed: false, postDestruction: null, healthAfter: victim.health };
    if (net !== 0 && this.decrementHealth(victim, net) === 0) {
      vr.destroyed = true;
      if (vt.postDestructionDamage > 0) vr.postDestruction = this.postDestruction(attacker, victim);
      this.destroy(victim);
    }
    vr.healthAfter = victim.health;
    return vr;
  }

  /* EndShot: the rows for one target, exactly as the chain builds them. */
  private endShot(target: SimStruct, tt: StructType, healthBefore: number, r: ShotResolution): ShotRow[] {
    const base: ShotRow = {
      targetStructId: target.id, targetStructTypeId: tt.id, targetStructType: tt.type,
      targetStructLocationType: target.locationType, targetStructLocationId: target.locationId,
      targetStructOperatingAmbit: target.ambit, targetStructSlot: target.slot, targetPlayerId: target.owner,
      targetHealthBefore: healthBefore, targetHealthAfter: target.health, targetDestroyed: this.isDestroyed(target),
      targetHealthMax: tt.maxHealth, eventAttackDefenderCounterDetail: [],
    };
    if (r.evaded) { base.evaded = true; base.evadedCause = tt.unitDefenses; }
    if (r.block && r.block.blocked) {
      const b = r.block.blocker, bt = this.typeOf(b);
      Object.assign(base, {
        blocked: true, blockedByStructId: b.id, blockedByStructTypeId: bt.id, blockedByStructType: bt.type,
        blockedByStructLocationType: b.locationType, blockedByStructLocationId: b.locationId, blockedByStructOperatingAmbit: b.ambit, blockedByStructSlot: b.slot,
        blockerHealthBefore: r.block.healthBefore, blockerHealthMax: r.block.healthMax,
      });
    }
    for (const c of r.counters) {
      const cs = c.counter, ct = this.typeOf(cs);
      base.eventAttackDefenderCounterDetail!.push({
        counterByStructId: cs.id, counterDamage: c.damage, counterDestroyedAttacker: c.attackerDestroyed,
        counterByStructTypeId: ct.id, counterByStructType: ct.type, counterByStructLocationType: cs.locationType,
        counterByStructLocationId: cs.locationId, counterByStructOperatingAmbit: cs.ambit, counterByStructSlot: cs.slot,
        counterByStructWeaponSystem: c.weaponSystem, counterByStructWeaponControl: c.weaponControl, counterByStructActiveWeaponry: c.activeWeaponry,
      });
    }
    if (r.targetCounter && r.targetCounter.damage > 0) {
      Object.assign(base, {
        targetCountered: true, targetCounteredDamage: r.targetCounter.damage,
        targetCounterDestroyedAttacker: r.targetCounter.attackerDestroyed,
        targetCounterPassiveWeaponry: r.targetCounter.passiveWeaponry,
        targetCounterWeaponSystem: r.targetCounter.weaponSystem,
        targetCounterWeaponControl: r.targetCounter.weaponControl,
        targetCounterActiveWeaponry: r.targetCounter.activeWeaponry,
      });
    }
    const vr = r.volley;
    if (!vr) return [base];
    const aggregate = (row: ShotRow) => {
      if (vr.rolled !== 0 && vr.reduction > 0) { row.damageReduction = vr.reduction; row.damageReductionCause = vr.unitDefenses; }
      if (vr.piercing) { row.armourPiercing = true; row.damageReductionCause = vr.unitDefenses; }
      row.damage = vr.net || 0;
      if (vr.isBlocker) row.blockerHealthAfter = vr.healthAfter;
      if (vr.isBlocker && vr.destroyed) row.blockerDestroyed = true;
      if (vr.postDestruction) {
        row.postDestructionDamageToAttacker = true;
        row.postDestructionDamage = vr.postDestruction.damage;
        row.postDestructionDamageDestroyedAttacker = vr.postDestruction.attackerDestroyed;
        row.postDestructionDamagePassiveWeaponry = vr.postDestruction.passive;
      }
    };
    const n = vr.shots.length;
    if (n <= 1) {
      if (n === 1) base.damageDealt = vr.shots[0].damage;
      aggregate(base);
      return [base];
    }
    // Multi-shot: n-1 projectile rows with outcomes zeroed, then the last row
    // carrying the volley aggregate (newProjectileRow).
    const projectile = (): ShotRow => {
      const row = clone(base);
      row.eventAttackDefenderCounterDetail = null;
      for (const k of ['damageDealt', 'damageReduction', 'damage', 'targetCounteredDamage', 'postDestructionDamage', 'targetHealthAfter', 'blockerHealthAfter']) row[k] = 0;
      for (const k of ['armourPiercing', 'blockerDestroyed', 'targetDestroyed', 'targetCountered', 'targetCounterDestroyedAttacker', 'postDestructionDamageToAttacker', 'postDestructionDamageDestroyedAttacker']) row[k] = false;
      for (const k of ['damageReductionCause', 'targetCounterPassiveWeaponry', 'targetCounterWeaponSystem', 'targetCounterWeaponControl', 'targetCounterActiveWeaponry', 'postDestructionDamagePassiveWeaponry']) delete row[k];
      return row;
    };
    const rows: ShotRow[] = [];
    for (let i = 0; i < n - 1; i++) {
      const row = projectile();
      row.damageDealt = vr.shots[i].damage;
      row.targetHealthAfter = base.targetHealthBefore;
      if (vr.isBlocker) row.blockerHealthAfter = base.blockerHealthBefore;
      rows.push(row);
    }
    const last = projectile();
    last.damageDealt = vr.shots[n - 1].damage;
    aggregate(last);
    last.targetHealthAfter = base.targetHealthAfter;
    last.targetDestroyed = base.targetDestroyed;
    last.eventAttackDefenderCounterDetail = base.eventAttackDefenderCounterDetail;
    for (const k of ['targetCountered', 'targetCounteredDamage', 'targetCounterDestroyedAttacker', 'targetCounterPassiveWeaponry', 'targetCounterWeaponSystem', 'targetCounterWeaponControl', 'targetCounterActiveWeaponry']) {
      if (base[k] !== undefined) last[k] = base[k];
    }
    rows.push(last);
    return rows;
  }

  /* ── MsgStructDefenseSet / MsgStructDefenseClear ─────────────────────── */
  private structDefenseSet(signer: string, msg: Extract<Msg, { '@type': '/structs.structs.MsgStructDefenseSet' }>) {
    const s0 = this.structs[msg.defenderStructId];
    this.canBePlayedBy(s0, signer);
    const s = this.mustLoad(msg.defenderStructId);
    if (this.isDestroyed(s)) throw new ChainError('struct_state', s.id + ' is destroyed');
    if (!this.isOnline(s)) throw new ChainError('struct_state', s.id + ' is offline');
    if (!this.canDefend(s)) throw new ChainError('cannot_defend', s.id + ' cannot defend');
    const cost = this.typeOf(s).defendChangeCharge || 0;
    const charge = this.chargeOf(signer);
    if (charge < cost) throw new ChainError('insufficient_charge', 'insufficient charge for defend: ' + charge + ' < ' + cost);
    if (msg.defenderStructId === msg.protectedStructId) throw new ChainError('struct_location', 'self_defense');
    const ward = this.mustLoad(msg.protectedStructId);
    if (!this.isProtecting(s, ward)) throw new ChainError('struct_location', 'not_in_range');
    this.setDefender(ward.id, s.id);
    this.discharge(signer);
  }

  private structDefenseClear(signer: string, msg: Extract<Msg, { '@type': '/structs.structs.MsgStructDefenseClear' }>) {
    const s0 = this.structs[msg.defenderStructId];
    this.canBePlayedBy(s0, signer);
    const s = this.mustLoad(msg.defenderStructId);
    if (this.isDestroyed(s)) throw new ChainError('struct_state', s.id + ' is destroyed');
    if (!this.isOnline(s)) throw new ChainError('struct_state', s.id + ' is offline');
    const cost = this.typeOf(s).defendChangeCharge || 0;
    const charge = this.chargeOf(signer);
    if (charge < cost) throw new ChainError('insufficient_charge', 'insufficient charge for defend: ' + charge + ' < ' + cost);
    if (!s.protectedStructId) throw new ChainError('struct_state', s.id + ' is not defending');
    this.clearDefender(s.protectedStructId, s.id);
    this.discharge(signer);
  }

  /* ── MsgStructMove (AttemptMove + FleetCache.MoveReadiness) ──────────── */
  private structMove(signer: string, msg: Extract<Msg, { '@type': '/structs.structs.MsgStructMove' }>) {
    const s0 = this.structs[msg.structId];
    this.canBePlayedBy(s0, signer);
    const s = this.mustLoad(msg.structId);
    if (this.isDestroyed(s)) throw new ChainError('struct_state', s.id + ' is destroyed');
    const t = this.typeOf(s);
    const cost = t.moveCharge || 0;
    const charge = this.chargeOf(signer);
    if (charge < cost) throw new ChainError('insufficient_charge', 'insufficient charge for move: ' + charge + ' < ' + cost);
    if (!this.isOnline(s)) throw new ChainError('struct_state', s.id + ' is offline');
    if (!t.movable) throw new ChainError('struct_location', 'immovable');
    const ambit = String(msg.ambit || '').toLowerCase() as Ambit;
    if (msg.locationType !== 'fleet') throw new ChainError('struct_location', 'fleet is away: no planet to move to');
    if (t.category !== 'fleet') throw new ChainError('struct_location', 'outside_planet');
    if (!AMBIT_FLAG[ambit] || (ambit as string) === 'local' || (AMBIT_FLAG[ambit] & t.possibleAmbit) === 0) throw new ChainError('struct_location', 'invalid_ambit');
    if (t.type !== COMMAND_STRUCT) {
      const slot = Number(msg.slot);
      if (!(slot >= 0 && slot < 4)) throw new ChainError('struct_build', 'slot_unavailable');
      const taken = Object.values(this.structs).some((o) => o.id !== s.id && o.locationId === s.locationId && o.ambit === ambit && o.slot === slot && this.typeOf(o).type !== COMMAND_STRUCT);
      if (taken) throw new ChainError('struct_build', 'slot_occupied');
      this.touch(s);
      s.ambit = ambit; s.slot = slot;
    } else {
      // A Command Ship changes only its operating ambit.
      this.touch(s);
      s.ambit = ambit;
    }
    this.discharge(signer);
  }

  /* ── Stealth, activation ─────────────────────────────────────────────── */
  private structStealth(signer: string, id: string, activate: boolean) {
    const s = this.structs[id];
    this.canBePlayedBy(s, signer);
    this.readinessCheck(s);
    if (activate && this.isHidden(s)) throw new ChainError('struct_state', s.id + ' is hidden');
    if (!activate && !this.isHidden(s)) throw new ChainError('struct_state', s.id + ' is visible');
    const t = this.typeOf(s);
    if (t.unitDefenses !== 'stealthMode') throw new ChainError('capability', s.id + ' has no stealth');
    const cost = t.stealthActivateCharge || 0;
    const charge = this.chargeOf(signer);
    if (charge < cost) throw new ChainError('insufficient_charge', 'insufficient charge for stealth: ' + charge + ' < ' + cost);
    this.discharge(signer);
    this.setStatus(s, STATUS.HIDDEN, activate);
  }

  private structActivate(signer: string, id: string) {
    const s = this.structs[id];
    this.canBePlayedBy(s, signer);
    if (this.isDestroyed(s)) throw new ChainError('struct_state', s.id + ' is destroyed');
    if (!this.isBuilt(s)) throw new ChainError('struct_state', s.id + ' is building');
    if (this.isOnline(s)) throw new ChainError('struct_state', s.id + ' is online');
    const p = this.players[signer], t = this.typeOf(s);
    if (p.load + (t.passiveDraw || 0) > p.capacity) throw new ChainError('player_power', 'capacity_exceeded');
    const cost = t.activateCharge || 0;
    const charge = this.chargeOf(signer);
    if (charge < cost) throw new ChainError('insufficient_charge', 'insufficient charge for activate: ' + charge + ' < ' + cost);
    this.discharge(signer);
    this.goOnline(s);
  }

  private structDeactivate(signer: string, id: string) {
    const s = this.structs[id];
    if (!s) throw new ChainError('not_found', 'struct not found');
    this.canBePlayedBy(s, signer);
    if (!this.isBuilt(s)) throw new ChainError('struct_state', s.id + ' is building');
    if (!this.isOnline(s)) throw new ChainError('struct_state', s.id + ' is offline');
    // MsgStructDeactivate neither checks nor spends charge.
    this.goOffline(s);
  }

  /** An independent copy with a different randomness seed: the computer
   * player plays candidate moves forward on these, never on the battle. */
  fork(salt: string): Chain {
    const f = Object.create(Chain.prototype) as Chain;
    f.types = this.types;
    f.seed = this.seed + '/' + salt;
    f.height = this.height;
    f.planetId = this.planetId;
    const copy = clone({ players: this.players, fleets: this.fleets, structs: this.structs, defenders: this.defenders, destructionQueue: this.destructionQueue });
    f.players = copy.players; f.fleets = copy.fleets; f.structs = copy.structs;
    f.defenders = copy.defenders; f.destructionQueue = copy.destructionQueue;
    f.mempool = clone(this.mempool);
    f.txSeq = this.txSeq;
    f.ctx = null;
    return f;
  }

  /** Fleets still at the battle. One left (or none) ends it. */
  fleetsAtBattle() { return Object.keys(this.fleets).filter((id) => this.fleets[id].atBattle); }
}

interface ShotResolution {
  evaded: boolean;
  counters: CounterResult[];
  block: { blocked: true; blocker: SimStruct; healthBefore: number; healthMax: number } | null;
  volley: Volley | null;
  targetCounter: CounterResult | null;
}
interface CounterResult {
  counter: SimStruct; damage: number; attackerDestroyed: boolean;
  postDestruction: { damage: number; attackerDestroyed: boolean; passive: string } | null;
  weaponSystem?: WeaponSystem; weaponControl?: string; activeWeaponry?: string; passiveWeaponry?: string;
}
interface Volley {
  shots: { hit: boolean; damage: number }[]; rolled: number; reduction: number; unitDefenses: string; piercing: boolean;
  net: number; isBlocker: boolean; destroyed: boolean; postDestruction: { damage: number; attackerDestroyed: boolean; passive: string } | null; healthAfter: number;
}

function canCounterTargetAmbit(t: StructType, from: Ambit, to: Ambit) {
  let all = (t.primaryWeaponAmbits || 0) | (t.secondaryWeaponAmbits || 0);
  if (all & AMBIT_FLAG.local) all |= AMBIT_FLAG[from];
  return (all & AMBIT_FLAG[to]) !== 0;
}
function counterWeaponSystem(t: StructType, from: Ambit, to: Ambit): WeaponSystem {
  return canTargetAmbit(t, 'primaryWeapon', from, to) ? 'primaryWeapon' : 'secondaryWeapon';
}

export { AMBITS };
