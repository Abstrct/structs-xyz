/* Your empire: live state of every player this wallet controls — the commander and each
 * replicant. Player + grid, home planet + attributes, fleet, and every struct in their slots.
 * Read from the LCD, refreshed when the chain says something of yours changed (live tx events),
 * after your own transactions land, and every few blocks as a backstop. */
import { lcd, big, num, type PlayerFull, type PlanetFull, type RawFleet, type StructFull } from '../chain/lcd';
import { live } from '../chain/live';
import { wallet } from '../wallet/wallet';
import { txq } from '../wallet/queue';
import { safeEach, sleep } from '../core/util';
import { typeOf, type StructType } from '../data/catalogue';

export interface OwnedStruct {
  id: string; typeId: number; type: StructType | undefined;
  locationType: string; locationId: string; ambit: string; slot: number;
  health: number; status: number;
  built: boolean; online: boolean; hidden: boolean; destroyed: boolean; materialized: boolean; locked: boolean;
  blockStartBuild: number; blockStartOreMine: number; blockStartOreRefine: number;
  defenders: string[];
  protectedStructIndex: number;
  ore: number;
}

export interface PlayerState {
  playerId: string;
  account: number;
  address: string;
  name: string;
  pfp: string;
  guildId: string;
  substationId: string;
  planetId: string;
  fleetId: string;
  alpha: bigint;          // ualpha in the player's wallet (playerInventory)
  ore: number;            // stored ore (raidable)
  load: bigint; structsLoad: bigint; capacity: bigint; connectionCapacity: bigint;
  lastAction: number;
  online: boolean;
  planet: PlanetFull | null;
  fleet: RawFleet | null;
  /** The planet our fleet sits at while away (a raid target), with its raid clock and shield. */
  target: PlanetFull | null;
  structs: Map<string, OwnedStruct>;
  readAt: number;
  readHeight: number;
}

type Fn = () => void;

class Empire {
  players = new Map<string, PlayerState>();
  /** Players followed read-only (another commander's deck); account is -1 for these. */
  private watched = new Map<string, number>();   // player → how many holders (deck, crew…)
  private listeners = new Set<Fn>();
  private dirty = new Set<string>();
  private reading = new Set<string>();
  private lastFull = 0;
  /** Object ids (planets, fleets, structs) → owning player of ours, for event routing. */
  private owner = new Map<string, string>();

  constructor() {
    if (typeof window === 'undefined') return;
    wallet.onChange(() => this.sync());
    live.onBlock((b) => {
      if (b.height - this.lastFull >= 8) { this.lastFull = b.height; for (const id of this.players.keys()) this.dirty.add(id); }
      void this.flush();
    });
    live.onTx((tx) => {
      const mine = new Set(this.players.keys());
      for (const e of tx.events) {
        const ids = touchedIds(e.type, e.data);
        for (const id of ids) {
          const who = mine.has(id) ? id : this.owner.get(id);   // ours and watched alike
          if (who) this.dirty.add(who);
        }
      }
      if (this.dirty.size) void this.flush();
    });
    txq.onSettled((j) => { if (j.playerId && this.players.has(j.playerId)) { this.dirty.add(j.playerId); void this.flush(); } });
    // The queue asks us how charged a player is before it sends a struct action.
    txq.chargeOf = (pid) => { const p = this.players.get(pid); return p ? this.charge(p) : null; };
    this.sync();
  }

  onChange(f: Fn) { this.listeners.add(f); f(); return () => this.listeners.delete(f); }
  private emit() { safeEach(this.listeners, (f) => f()); }

  get commander(): PlayerState | null {
    const a = wallet.active;
    return a?.playerId ? this.players.get(a.playerId) ?? null : null;
  }

  /** Blocks since the player's last action — the battery every struct action draws on. */
  charge(p: PlayerState): number {
    const h = live.height || p.readHeight;
    return Math.max(0, h - p.lastAction);
  }

  /** Re-read the roster of players from the wallet's accounts. */
  sync() {
    const want = new Map(wallet.accounts.filter((a) => a.playerId).map((a) => [a.playerId!, a]));
    let changed = false;
    for (const id of [...this.players.keys()]) if (!want.has(id) && !this.watched.has(id)) { this.players.delete(id); changed = true; }
    for (const id of want.keys()) if (!this.players.has(id)) this.dirty.add(id);
    if (changed) this.emit();
    void this.flush();
  }

  /** Follow any player read-only. */
  watch(playerId: string) {
    if (wallet.byPlayer(playerId)) return;
    this.watched.set(playerId, (this.watched.get(playerId) || 0) + 1);
    this.dirty.add(playerId);
    void this.flush();
  }
  unwatch(playerId: string) {
    const n = this.watched.get(playerId) || 0;
    if (n > 1) { this.watched.set(playerId, n - 1); return; }
    if (!this.watched.delete(playerId) || wallet.byPlayer(playerId)) return;
    this.players.delete(playerId);
    for (const [k, v] of this.owner) if (v === playerId) this.owner.delete(k);
    this.emit();
  }
  /** True when this wallet can sign for the player. */
  commands(playerId: string) { return !!wallet.byPlayer(playerId); }

  refresh(playerId?: string) {
    if (playerId) this.dirty.add(playerId); else { for (const a of wallet.accounts) if (a.playerId) this.dirty.add(a.playerId); for (const w of this.watched.keys()) this.dirty.add(w); }
    return this.flush();
  }

  private flushing = false;
  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.dirty.size) {
        const batch = [...this.dirty].slice(0, 4);
        for (const id of batch) this.dirty.delete(id);
        await Promise.all(batch.map((id) => this.read(id)));
      }
    } finally { this.flushing = false; }
  }

  private async read(playerId: string) {
    if (this.reading.has(playerId)) { this.dirty.add(playerId); return; }
    const acct = wallet.byPlayer(playerId);
    if (!acct && !this.watched.has(playerId)) return;
    this.reading.add(playerId);
    try {
      const pf: PlayerFull = await lcd.player(playerId);
      const P = pf.Player;
      const g = pf.gridAttributes || {};
      const [planet, fleet, sub] = await Promise.all([
        P.planetId ? lcd.planet(P.planetId).catch(() => null) : Promise.resolve(null),
        P.fleetId ? lcd.fleet(P.fleetId).catch(() => null) : Promise.resolve(null),
        // Secondary capacity is the substation's per-connection share, not a grid record of the player.
        P.substationId ? lcd.entity<{ gridAttributes?: { connectionCapacity?: string } }>('substation', P.substationId).catch(() => null) : Promise.resolve(null),
      ]);
      const share = big(sub?.gridAttributes?.connectionCapacity);
      const target = fleet && fleet.status === 'away' && fleet.locationType === 'planet' && fleet.locationId
        ? await lcd.planet(fleet.locationId).catch(() => null) : null;
      const ids = new Set<string>();
      const add = (list?: string[]) => { for (const s of list || []) if (s) ids.add(s); };
      if (planet) { add(planet.Planet.space); add(planet.Planet.air); add(planet.Planet.land); add(planet.Planet.water); }
      if (fleet) { add(fleet.space); add(fleet.air); add(fleet.land); add(fleet.water); if (fleet.commandStruct) ids.add(fleet.commandStruct); }
      const structs = new Map<string, OwnedStruct>();
      const list = [...ids];
      for (let i = 0; i < list.length; i += 8) {
        const chunk = await Promise.all(list.slice(i, i + 8).map((id) => lcd.struct(id).catch(() => null)));
        for (const s of chunk) if (s) { const o = toOwned(s); if (o.typeId) structs.set(o.id, o); }
      }
      const height = live.height || (await lcd.latestHeight().then((r) => r.height).catch(() => 0));
      const st: PlayerState = {
        playerId, account: acct ? acct.index : -1, address: acct ? acct.address : P.primaryAddress,
        name: P.name || playerId, pfp: P.pfpClientRenderAttributes, guildId: P.guildId, substationId: P.substationId,
        planetId: P.planetId, fleetId: P.fleetId,
        alpha: big(pf.playerInventory?.rocks?.amount), ore: num(g.ore),
        load: big(g.load), structsLoad: big(g.structsLoad), capacity: big(g.capacity), connectionCapacity: share,
        lastAction: num(g.lastAction),
        online: big(g.load) + big(g.structsLoad) <= big(g.capacity) + share,
        planet, fleet, target, structs, readAt: Date.now(), readHeight: height,
      };
      this.players.set(playerId, st);
      for (const [k, v] of this.owner) if (v === playerId) this.owner.delete(k);
      if (st.planetId) this.owner.set(st.planetId, playerId);
      if (st.fleetId) this.owner.set(st.fleetId, playerId);
      for (const id of structs.keys()) this.owner.set(id, playerId);
      // Keep the vault's label in step with the chain name.
      if (acct && P.name && acct.label !== P.name && (acct.label === 'Commander' || /^Replicant/.test(acct.label))) wallet.setAccount(acct.index, { label: P.name });
      this.emit();
    } catch (e) {
      console.warn('[empire] read failed', playerId, e);
      await sleep(2000);
    } finally {
      this.reading.delete(playerId);
    }
  }

  /** Every struct across the empire. */
  *allStructs(): Iterable<[PlayerState, OwnedStruct]> {
    for (const p of this.players.values()) for (const s of p.structs.values()) yield [p, s];
  }

  ownerOf(objectId: string): PlayerState | null { const pid = this.owner.get(objectId); return pid ? this.players.get(pid) ?? null : null; }
  /** True when the object belongs to a player this wallet commands (not one we only watch). */
  isMine(objectId: string) { const pid = this.owner.get(objectId) ?? (this.players.has(objectId) ? objectId : undefined); return !!pid && this.commands(pid); }
  /** True for any object we track, watched players included. */
  isTracked(objectId: string) { return this.owner.has(objectId) || this.players.has(objectId); }
}

function toOwned(s: StructFull): OwnedStruct {
  const a = s.structAttributes || {};
  const st = num(a.status);
  const x = a as Record<string, unknown>;
  return {
    id: s.Struct.id, typeId: Number(s.Struct.type), type: typeOf(s.Struct.type),
    locationType: s.Struct.locationType, locationId: s.Struct.locationId, ambit: s.Struct.operatingAmbit, slot: num(s.Struct.slot),
    health: num(a.health), status: st,
    materialized: !!(st & 1), built: !!(st & 2), online: !!(st & 4), hidden: !!(st & 16), destroyed: !!(st & 32), locked: !!(st & 64),
    blockStartBuild: num(a.blockStartBuild), blockStartOreMine: num(x.blockStartOreMine as string), blockStartOreRefine: num(x.blockStartOreRefine as string),
    defenders: s.structDefenders || [], protectedStructIndex: num(a.protectedStructIndex), ore: num(s.gridAttributes?.ore),
  };
}

/** Object ids an event payload touches. */
export function touchedIds(type: string, d: any): string[] {
  if (!d || typeof d !== 'object') return [];
  const out: string[] = [];
  const push = (v: unknown) => { if (typeof v === 'string' && /^\d+-\d+$/.test(v)) out.push(v); };
  // Each typed event's attribute is its single field, so payloads arrive unwrapped; accept both.
  const u = (k: string) => (d[k] && typeof d[k] === 'object' ? d[k] : d) as any;
  const attrObject = (rec: any) => { const m = /^\d+-(\d+)-(\d+)$/.exec(String(rec?.attributeId ?? '')); if (m) out.push(`${m[1]}-${m[2]}`); };
  switch (type) {
    case 'EventGrid': attrObject(u('gridRecord')); break;
    case 'EventStructAttribute': attrObject(u('structAttributeRecord')); break;
    case 'EventPlanetAttribute': attrObject(u('planetAttributeRecord')); break;
    case 'EventStruct': { const x = u('structure'); push(x.id); push(x.owner); push(x.locationId); break; }
    case 'EventPlanet': { const x = u('planet'); push(x.id); push(x.owner); break; }
    case 'EventFleet': { const x = u('fleet'); push(x.id); push(x.owner); push(x.locationId); break; }
    case 'EventPlayer': push(u('player').id); break;
    case 'EventStructDefender': { const x = u('structDefender'); push(x.protectedStructId); push(x.defendingStructId); break; }
    case 'EventAttack': { const a = u('eventAttackDetail'); push(a.attackerStructId); for (const s of a.eventAttackShotDetail || []) { push(s.targetStructId); push(s.targetPlayerId); } break; }
    case 'EventRaid': { const r = u('eventRaidDetail'); push(r.planetId); push(r.fleetId); break; }
    case 'EventOreMine': case 'EventAlphaRefine': case 'EventOreTheft': {
      const x = u(type === 'EventOreMine' ? 'eventOreMineDetail' : type === 'EventAlphaRefine' ? 'eventAlphaRefineDetail' : 'eventOreTheftDetail');
      push(x.playerId); push(x.victimPlayerId); push(x.thiefPlayerId); break;
    }
    case 'EventHashSuccess': { const x = u('eventHashSuccessDetail'); push(x.objectId); push(x.planetId); break; }
    default:
      for (const v of Object.values(d)) { push(v); if (v && typeof v === 'object') for (const w of Object.values(v as object)) push(w); }
  }
  return out;
}

export const empire = new Empire();
