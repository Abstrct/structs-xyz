/* Game verbs: every struct, fleet and planet action as one call that checks what it can,
 * names itself, prices its charge and queues the transaction. UIs (the Command Deck, the
 * planet map, the palette, replicants) all act through here. */
import { txq, type TxJob } from '../wallet/queue';
import { wallet } from '../wallet/wallet';
import { empire, type OwnedStruct, type PlayerState } from './empire';
import { typeOf, type StructType, type WeaponSystem } from '../data/catalogue';

const M = (name: string, value: Record<string, unknown>) => ({ typeUrl: `/structs.structs.${name}`, value });

export interface Verb { id: string; label: string; cost: number; hint: string; danger?: boolean; run: () => TxJob }

function q(p: PlayerState, name: string, value: Record<string, unknown>, label: string, cost?: number, source = 'you'): TxJob {
  return txq.enqueue(M(name, value), {
    account: p.account, playerId: p.playerId, label, source,
    lane: cost != null ? 'action' : 'immediate', chargeCost: cost,
  });
}

export const act = {
  build(p: PlayerState, t: StructType, ambit: string, slot: number, source?: string) {
    return q(p, 'MsgStructBuildInitiate', { playerId: p.playerId, structTypeId: t.id, operatingAmbit: ambit, slot }, `Build ${t.type} · ${ambit} ${slot + 1}`, t.buildCharge, source);
  },
  cancelBuild: (p: PlayerState, s: OwnedStruct) => q(p, 'MsgStructBuildCancel', { structId: s.id }, `Cancel ${name(s)}`),
  activate: (p: PlayerState, s: OwnedStruct, source?: string) => q(p, 'MsgStructActivate', { structId: s.id }, `Power up ${name(s)}`, s.type?.activateCharge ?? 0, source),
  deactivate: (p: PlayerState, s: OwnedStruct) => q(p, 'MsgStructDeactivate', { structId: s.id }, `Power down ${name(s)}`),
  stealthOn: (p: PlayerState, s: OwnedStruct) => q(p, 'MsgStructStealthActivate', { structId: s.id }, `Stealth ${name(s)}`, s.type?.stealthActivateCharge ?? 0),
  stealthOff: (p: PlayerState, s: OwnedStruct) => q(p, 'MsgStructStealthDeactivate', { structId: s.id }, `Unstealth ${name(s)}`, s.type?.stealthActivateCharge ?? 0),
  defend: (p: PlayerState, s: OwnedStruct, protectedId: string, source?: string) => q(p, 'MsgStructDefenseSet', { defenderStructId: s.id, protectedStructId: protectedId }, `${name(s)} guards ${protectedId}`, s.type?.defendChangeCharge ?? 0, source),
  clearDefense: (p: PlayerState, s: OwnedStruct) => q(p, 'MsgStructDefenseClear', { defenderStructId: s.id }, `${name(s)} stands down`, s.type?.defendChangeCharge ?? 0),
  move: (p: PlayerState, s: OwnedStruct, locationType: 'planet' | 'fleet', ambit: string, slot: number) =>
    q(p, 'MsgStructMove', { structId: s.id, locationType, ambit, slot }, `Move ${name(s)} → ${locationType} ${ambit} ${slot + 1}`, s.type?.moveCharge ?? 0),
  attack(p: PlayerState, s: OwnedStruct, targets: string[], weapon: WeaponSystem, source?: string) {
    const t = s.type!;
    const cost = weapon === 'primaryWeapon' ? t.primaryWeaponCharge : t.secondaryWeaponCharge;
    return q(p, 'MsgStructAttack', { operatingStructId: s.id, targetStructId: targets, weaponSystem: weapon }, `${name(s)} fires on ${targets.join(', ')}`, cost, source);
  },
  infuseGenerator: (p: PlayerState, s: OwnedStruct, ualpha: bigint) => q(p, 'MsgStructGeneratorInfuse', { structId: s.id, infuseAmount: `${ualpha}ualpha` }, `Burn ${Number(ualpha) / 1e6} alpha in ${name(s)}`),
  trash: (p: PlayerState, s: OwnedStruct) => q(p, 'MsgStructTrash', { structId: s.id }, `Scrap ${name(s)}`, s.type?.buildCharge ?? 8),
  fleetMove: (p: PlayerState, destination: string, source?: string) => q(p, 'MsgFleetMove', { fleetId: p.fleetId, destinationLocationId: destination }, destination === p.planetId ? 'Fleet returns home' : `Fleet sails for ${destination}`, undefined, source),
  explore: (p: PlayerState, source?: string) => q(p, 'MsgPlanetExplore', { playerId: p.playerId }, 'Explore a new planet', undefined, source),
  renamePlanet: (p: PlayerState, nm: string) => q(p, 'MsgPlanetUpdateName', { planetId: p.planetId, name: nm }, `Name planet “${nm}”`),
  renamePlayer: (p: PlayerState, nm: string) => q(p, 'MsgPlayerUpdateName', { playerId: p.playerId, name: nm }, `Rename to “${nm}”`),
  setPortrait: (p: PlayerState, attrs: Record<string, number>, source?: string) => q(p, 'MsgPlayerUpdatePfpClientRenderAttributes', { playerId: p.playerId, pfpClientRenderAttributes: JSON.stringify(attrs) }, 'New portrait', undefined, source),
  send: (p: PlayerState, to: string, ualpha: bigint, source?: string) => q(p, 'MsgPlayerSend', { from_address: p.address, to_address: to, amount: [{ denom: 'ualpha', amount: ualpha.toString() }] }, `Send ${Number(ualpha) / 1e6} alpha`, undefined, source),
};

/** Why the chain would refuse a build for this player right now (BuildInitiateReadiness and
 * MsgStructBuildInitiate in v0.21), or null when it would take it. */
export function buildBlock(p: PlayerState, t?: StructType): string | null {
  if (!p.online) return 'Not enough power: you can’t build until your machines use less power than you have';
  const f = p.fleet;
  if (!f || f.status === 'away') return 'Your fleet is away: bring it home to build';
  const cmd = f.commandStruct ? p.structs.get(f.commandStruct) : undefined;
  if (!cmd || cmd.destroyed) return 'You have no Command Ship: building needs one';
  if (!cmd.online) return 'Your Command Ship is switched off: switch it on to build';
  if (t && p.load + p.structsLoad + BigInt(t.buildDraw) > p.capacity + p.connectionCapacity) return `Not enough free power for a ${t.type} (${formatDraw(t.buildDraw)})`;
  return null;
}

/** Why struct actions (attack, guard, move, stealth, activate) would be refused for the player, or null. */
export const actionBlock = (p: PlayerState): string | null => (p.online ? null : 'Not enough power: your machines can’t act until they use less power than you have');

/** Slots a queued build or move is already headed for ("planet:land:0"): don't offer them twice. */
export function reservedSlots(playerId: string): Set<string> {
  const out = new Set<string>();
  for (const j of txq.active) {
    if (j.playerId !== playerId) continue;
    for (const m of j.msgs) {
      const v = m.value as Record<string, unknown>;
      if (m.typeUrl.endsWith('MsgStructBuildInitiate')) out.add(`${typeOf(Number(v.structTypeId))?.category}:${v.operatingAmbit}:${v.slot}`);
      // A Command Ship changes battleground without taking a slot.
      if (m.typeUrl.endsWith('MsgStructMove') && empire.players.get(playerId)?.structs.get(String(v.structId))?.typeId !== 1) out.add(`${v.locationType}:${v.ambit}:${v.slot}`);
    }
  }
  return out;
}

/** Explore abandons the current planet and any ore left in it: confirm when there is some. */
export async function exploreConfirmed(p: PlayerState, source?: string): Promise<TxJob | null> {
  const ore = Number(p.planet?.gridAttributes?.ore || 0);
  if (p.planet && p.planet.Planet.status !== 'complete' && ore > 0) {
    const { confirmBox } = await import('../core/dom');
    if (!(await confirmBox('Explore a new planet?', `Your planet still holds ${ore} ore. Exploring abandons it for a fresh world.`, 'Explore', 'enemy'))) return null;
  }
  return act.explore(p, source);
}

export const name = (s: OwnedStruct) => `${s.type?.type || 'Struct'} ${s.id}`;

/** What a struct can do right now (and what each costs), for menus and the palette. */
export function verbsFor(p: PlayerState, s: OwnedStruct): Verb[] {
  const t = s.type;
  if (!t || s.destroyed) return [];
  const v: Verb[] = [];
  if (!s.built) {
    v.push({ id: 'cancel', label: 'Cancel build', cost: 0, hint: 'Stop building it (it is lost)', danger: true, run: () => act.cancelBuild(p, s) });
    return v;
  }
  if (s.online) v.push({ id: 'off', label: 'Switch off', cost: 0, hint: 'Saves the power it uses', run: () => act.deactivate(p, s) });
  else v.push({ id: 'on', label: 'Switch on', cost: t.activateCharge, hint: `Uses ${formatDraw(t.passiveDraw)} of your power`, run: () => act.activate(p, s) });
  if (t.stealthSystems) {
    if (s.hidden) v.push({ id: 'unstealth', label: 'Leave stealth', cost: t.stealthActivateCharge, hint: 'Everyone can see it again', run: () => act.stealthOff(p, s) });
    else v.push({ id: 'stealth', label: 'Hide (stealth)', cost: t.stealthActivateCharge, hint: 'Enemies in other layers can’t target it', run: () => act.stealthOn(p, s) });
  }
  if (s.protectedStructIndex) v.push({ id: 'undefend', label: 'Stop guarding', cost: t.defendChangeCharge, hint: 'It stops protecting its friend', run: () => act.clearDefense(p, s) });
  return v;
}

export function formatDraw(mw: number) { return mw >= 1e6 ? `${(mw / 1e6).toFixed(mw % 1e6 ? 1 : 0)} kW` : `${mw / 1e3} W`; }

/** Struct types buildable in a slot of this kind and ambit. */
export function buildable(where: 'planet' | 'fleet', ambit: string): StructType[] {
  const flag: Record<string, number> = { water: 2, land: 4, air: 8, space: 16 };
  const out: StructType[] = [];
  for (let id = 1; id < 64; id++) {
    const t = typeOf(id);
    if (!t || t.category !== where || id === 1) continue;
    if (t.possibleAmbit & (flag[ambit] || 0)) out.push(t);
  }
  return out;
}

/** The account a player belongs to, or null if this wallet can't sign for them. */
export const signerFor = (playerId: string) => wallet.byPlayer(playerId);
export const stateOf = (playerId: string) => empire.players.get(playerId) ?? null;
