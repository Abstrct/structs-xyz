/* Replicants: more players from the same recovery phrase (HD index N ≥ 1), born into the
 * commander's guild and run by standing orders. Each block the order engine looks at every
 * player it manages and queues at most one move for it — build the loadout, power up what's
 * built, claim a fresh planet when the old one is spent, send surplus alpha home. Proofs are
 * the proof engine's job; it already grinds whatever any of your players owe.
 *
 * Roles (after structs-desktop):  productive — mine, refine, sweep alpha to the commander;
 * bait — mine and let ore pile up as a lure; raider — a fleet arm that sails where you rally. */
import { wallet } from '../wallet/wallet';
import { txq } from '../wallet/queue';
import { live } from '../chain/live';
import { empire, type PlayerState } from './empire';
import { act, buildBlock, reservedSlots } from './actions';
import { explore, joinGuild, planetSpent } from './onboard';
import { typeOf, type StructType } from '../data/catalogue';
import { safeEach } from '../core/util';
import { leader } from '../core/leader';
import { num } from '../chain/lcd';

export type Role = 'productive' | 'bait' | 'raider';

export interface Doctrine {
  /** Run standing orders for replicants. */
  enabled: boolean;
  /** Also fly the commander on autopilot (power, explore when spent). */
  commanderAutopilot: boolean;
  /** Alpha above this (in alpha) is swept to the commander by productive replicants. */
  sweepAbove: number;
  /** Where raiders rally (planet id), or '' to hold at home. */
  rally: string;
  /** Grant the commander full permissions on each newborn (lets other tools act for it). */
  delegate: boolean;
}

/** What each role builds, in priority order: [type id, ambit preference]. */
export const LOADOUTS: Record<Role, [number, string[]][]> = {
  productive: [[14, ['land', 'water']], [15, ['land', 'water']], [20, ['land', 'water']]],
  bait: [[14, ['land', 'water']]],
  raider: [[3, ['space']], [5, ['air']], [9, ['land']], [12, ['water']]],
};

const CALLSIGNS = ['Vesper', 'Kestrel', 'Onyx', 'Halcyon', 'Rook', 'Tamsin', 'Cinder', 'Juno', 'Quill', 'Sable', 'Orrin', 'Wren', 'Lyra', 'Basalt', 'Ember', 'Nyx', 'Corvid', 'Talon', 'Mica', 'Ion'];

const KEY = 'structs.doctrine';
type Fn = () => void;

export interface Birth { index: number; name: string; role: Role; steps: string[]; error?: string; done?: boolean; startedAt: number }

class Replicants {
  doctrine: Doctrine = { enabled: true, commanderAutopilot: false, sweepAbove: 2, rally: '', delegate: true };
  births: Birth[] = [];
  /** Last thing the engine decided per player — shown in the UI so it never feels like a black box. */
  intents = new Map<string, string>();
  private listeners = new Set<Fn>();
  private lastRun = 0;
  private benched = new Map<number, number>();

  constructor() {
    try { Object.assign(this.doctrine, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* defaults */ }
    if (typeof window === 'undefined') return;
    // A refused move benches that player for a while, so the same mistake isn't queued every tick.
    txq.onSettled((j) => { if (j.status === 'failed' && (j.source === 'replicant' || j.source === 'autopilot')) this.benched.set(j.account, live.height + 15); });
    live.onBlock((b) => { if (b.height - this.lastRun >= 2) { this.lastRun = b.height; void this.tick(); } });
  }

  onChange(f: Fn) { this.listeners.add(f); f(); return () => this.listeners.delete(f); }
  private emit() { safeEach(this.listeners, (f) => f()); }

  set(patch: Partial<Doctrine>) {
    Object.assign(this.doctrine, patch);
    try { localStorage.setItem(KEY, JSON.stringify(this.doctrine)); } catch { /* ignore */ }
    this.emit();
  }

  get roster() { return wallet.accounts.filter((a) => a.index > 0 && a.role !== 'key'); }

  /** Bring a new replicant into the world. Resolves when its player exists and has a planet queued. */
  async replicate(role: Role, name?: string): Promise<void> {
    if (!wallet.unlocked) throw new Error('Unlock the vault to replicate');
    const cmdr = empire.players.get(wallet.primary?.playerId || '');
    if (!cmdr) throw new Error('Your commander must be a player first (join a guild)');
    const index = wallet.nextIndex();
    const callsign = name || `${CALLSIGNS[(index - 1) % CALLSIGNS.length]}-${index}`;
    const birth: Birth = { index, name: callsign, role, steps: [], startedAt: Date.now() };
    this.births.unshift(birth);
    const step = (s: string) => { birth.steps.push(s); this.emit(); };
    try {
      wallet.addAccount(index, callsign, role);
      step(`Derived key m/44'/118'/0'/0/${index}`);
      const pid = await joinGuild(index, cmdr.guildId, callsign, step);
      step('Claiming a planet');
      explore(index, pid);
      // A face that says what it is: the role picks the backdrop, the rest is chance.
      const roll = (n: number) => 1 + Math.floor(Math.random() * n);
      const pfp = { background: ({ productive: 2, bait: 4, raider: 5 } as Record<Role, number>)[role], body: roll(57), arms: roll(34), neck: roll(10), head: roll(87) };
      txq.enqueue({ typeUrl: '/structs.structs.MsgPlayerUpdatePfpClientRenderAttributes', value: { playerId: pid, pfpClientRenderAttributes: JSON.stringify(pfp) } },
        { account: index, playerId: pid, label: `${callsign} gets a face`, source: 'replicant' });
      if (this.doctrine.delegate) {
        txq.enqueue({ typeUrl: '/structs.structs.MsgPermissionGrantOnObject', value: { objectId: pid, playerId: cmdr.playerId, permissions: 33554431 } },
          { account: index, playerId: pid, label: `${callsign} answers to ${cmdr.name}`, source: 'replicant' });
        step('Delegating to the commander');
      }
      void empire.refresh(pid);
      birth.done = true;
      step('Alive');
    } catch (e) {
      birth.error = (e as Error).message;
      this.emit();
      throw e;
    }
  }

  /** Back to defaults (a new vault doesn't inherit the old one's autopilot or rally point). */
  resetDoctrine() {
    this.doctrine = { enabled: true, commanderAutopilot: false, sweepAbove: 2, rally: '', delegate: true };
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    this.births = [];
    this.intents.clear();
    this.emit();
  }

  setRole(index: number, role: Role) { wallet.setAccount(index, { role }); this.emit(); }

  /* ── Standing orders ─────────────────────────────────────────────── */

  private running = false;
  async tick() {
    // Standing orders run in the one signing tab, while its vault is open.
    if (this.running || !wallet.unlocked || !leader.isLeader) return;
    this.running = true;
    try {
      // The commander (on autopilot) and the replicant roster — never field keys or anything else.
      for (const a of [...wallet.accounts.filter((x) => x.index === 0), ...this.roster]) {
        if (!a.playerId) continue;
        const managed = a.index > 0 ? this.doctrine.enabled : this.doctrine.commanderAutopilot;
        if (!managed) continue;
        const p = empire.players.get(a.playerId);
        if (!p) continue;
        // One move in flight per player: the queue serialises, and the board must catch up first.
        if (txq.active.some((j) => j.account === a.index)) continue;
        if ((this.benched.get(a.index) ?? 0) > live.height) { this.intents.set(a.playerId, 'Benched after a refused move'); continue; }
        const role: Role = a.index > 0 && a.role && a.role in LOADOUTS ? (a.role as Role) : 'productive';
        // One player's trouble must not cost the others their orders.
        try { const intent = await this.decide(p, role, a.index === 0); if (intent) this.intents.set(p.playerId, intent); }
        catch (e) { this.intents.set(p.playerId, 'Orders failed: ' + (e as Error).message); }
      }
      this.emit();
    } catch (e) {
      console.warn('[replicants]', e);
    } finally { this.running = false; }
  }

  /** Queue the one most useful move for this player, and say what it was (or why it waits). */
  private async decide(p: PlayerState, role: Role, isCommander: boolean): Promise<string> {
    const src = isCommander ? 'autopilot' : 'replicant';
    // 1. No planet (or a spent one, with nothing left to refine): claim a new world.
    if (!p.planetId || (p.ore === 0 && await planetSpent(p.planetId))) {
      act.explore(p, src);
      return 'Exploring a fresh planet';
    }
    if (isCommander) return this.power(p, src) || 'Holding';
    // 2. Power up anything built but dark, if the grid can carry it.
    const pw = this.power(p, src);
    if (pw) return pw;
    // 3. Build the loadout.
    const b = this.build(p, role, src);
    if (b) return b;
    // 4. Raiders rally.
    if (role === 'raider' && p.fleet) {
      const rally = this.doctrine.rally;
      if (rally && p.fleet.locationId !== rally && p.fleet.status === 'onStation') { act.fleetMove(p, rally, src); return `Sailing for ${rally}`; }
      if (!rally && p.fleet.status === 'away') { act.fleetMove(p, p.planetId, src); return 'Returning home'; }
      return rally ? `On station at ${rally}` : 'Holding at home';
    }
    // 5. Sweep alpha home.
    const cmdr = wallet.primary;
    const keep = BigInt(Math.round(this.doctrine.sweepAbove * 1e6));
    if (role === 'productive' && cmdr && cmdr.address !== p.address && p.alpha > keep + 100_000n) {
      act.send(p, cmdr.address, p.alpha - keep, src);
      return `Sweeping ${(Number(p.alpha - keep) / 1e6).toFixed(2)} alpha home`;
    }
    const underway = [...p.structs.values()].find((s) => !s.built && !s.destroyed);
    if (underway) return `Building ${underway.type?.type || 'a struct'} (the proof engine is on it)`;
    const mining = [...p.structs.values()].some((s) => s.built && s.online && s.type?.planetaryMining !== 'noPlanetaryMining');
    return mining ? (role === 'bait' ? 'Mining · ore piles up as bait' : 'Mining and refining') : 'Waiting for power';
  }

  private power(p: PlayerState, src: string): string | null {
    const cap = p.capacity + p.connectionCapacity;
    let load = p.load + p.structsLoad;
    for (const s of p.structs.values()) {
      if (!s.built || s.online || s.destroyed || !s.type) continue;
      const draw = BigInt(s.type.passiveDraw);
      if (load + draw > cap) continue;
      act.activate(p, s, src);
      load += draw;
      return `Powering up ${s.type.type}`;
    }
    return null;
  }

  private build(p: PlayerState, role: Role, src: string): string | null {
    const planet = p.planet?.Planet as unknown as Record<string, string[] | string> | undefined;
    const fleet = p.fleet as unknown as Record<string, string[] | string> | null;
    const have = (id: number) => [...p.structs.values()].filter((s) => s.typeId === id && !s.destroyed).length;
    if (buildBlock(p)) return null;
    // Nothing new while something is still under construction: one proof at a time keeps it cheap.
    if ([...p.structs.values()].some((s) => !s.built && !s.destroyed)) return null;
    const cap = p.capacity + p.connectionCapacity, load = p.load + p.structsLoad;
    for (const [typeId, ambits] of LOADOUTS[role]) {
      const t = typeOf(typeId) as StructType;
      if (!t || (t.buildLimit && have(typeId) >= t.buildLimit) || (!t.buildLimit && have(typeId) >= 1)) continue;
      if (load + BigInt(t.buildDraw) > cap) return `Needs ${(t.buildDraw / 1e6).toFixed(1)} kW free to build ${t.type}`;
      const holder = t.category === 'planet' ? planet : fleet;
      if (!holder || (t.category === 'fleet' && p.fleet?.status === 'away')) continue;
      for (const ambit of ambits) {
        const slots = (holder[ambit] as string[]) || [];
        const n = Math.max(num(holder[ambit + 'Slots'] as string), slots.length);
        const held = reservedSlots(p.playerId);
        for (let i = 0; i < n; i++) if (!slots[i] && !held.has(`${t.category}:${ambit}:${i}`)) { act.build(p, t, ambit, i, src); return `Building ${t.type}`; }
      }
    }
    return null;
  }
}

export const replicants = new Replicants();
