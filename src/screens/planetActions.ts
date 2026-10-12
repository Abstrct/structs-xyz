/* The planet map as a battlefield. Two halves:
 *   rules    who can hit whom from where (structsd's CanAttack, isReachable and IsProtecting,
 *            read off the map's own planet, fleets and structs), which empty slots a struct may
 *            move into or a build may take. Pure, so scripts/planetActions.test.ts runs them.
 *   overlay  the 3D layer that shows an armed order: reticles over everything a weapon reaches
 *            (or every ward a guard may take), slot frames to build or move into, queued landings. */
import * as THREE from 'three';
import type { RawFleet, RawPlanet, StructFull } from '../chain/lcd';
import type { OwnedStruct } from '../game/empire';
import { type Ambit, AMBITS, AMBIT_FLAG, AMBIT_NAME, canTargetAmbit, COMMAND_SHIP_ID, reachLabel, typeOf, type WeaponSystem } from '../data/catalogue';
import type { UnitView, SideV } from './battle/view';

/* ── Rules ───────────────────────────────────────────────────────────────── */

/** What the map knows: the world, the fleets in its orbit (home fleet and raiders), every struct read. */
export interface Field { planet: RawPlanet; fleets: RawFleet[]; structs: Map<string, StructFull> }

export type Arm =
  | { kind: 'attack'; struct: string; weapon: WeaponSystem; picks: string[] }
  | { kind: 'defend'; struct: string }
  | { kind: 'move'; struct: string };

/** An empty slot drawn on the map. `where` is the container kind; `side` the map half it sits on. */
export interface Slot { where: 'planet' | 'fleet'; containerId: string; owner: string; side: SideV; ambit: Ambit; slot: number; command?: boolean }
export const slotKey = (s: { where: string; ambit: string; slot: number; command?: boolean }) => `${s.where}:${s.ambit}:${s.slot}${s.command ? ':cmd' : ''}`;
/** A slot on this map: the same slot key can exist in the home fleet and a raider's. */
export const tileKey = (s: Slot) => slotKey(s) + '@' + s.containerId;

const fleetById = (f: Field, id: string) => f.fleets.find((x) => x.id === id) ?? null;
const flags = (s: StructFull) => s.structAttributes || {};
export const isDestroyed = (s: StructFull) => !!flags(s).isDestroyed;
/** Built, online and standing: the chain's ReadinessCheck for anything that acts. */
export const canAct = (s: StructFull) => !!flags(s).isBuilt && !!flags(s).isOnline && !isDestroyed(s);

/** GetPlanetId: the planet a struct stands on, or the one its fleet is at (not its owner's home:
 * every fleet in this orbit — the home fleet and each raider — is "at" this planet). */
function planetOf(f: Field, s: StructFull): string {
  const st = s.Struct;
  if (st.locationType === 'planet') return st.locationId;
  return fleetById(f, st.locationId)?.locationId || '';
}

/** The fleet at the head of this planet's queue (locationListStart, else the one with nothing ahead). */
export function headFleet(f: Field): string {
  return f.planet.locationListStart || f.fleets.find((x) => x.status === 'away' && x.locationId === f.planet.id && !x.locationListForward)?.id || '';
}

/** isReachable, from the shooter's side of the location list. */
function reachable(f: Field, shooter: StructFull, target: StructFull): boolean {
  const st = shooter.Struct;
  const targetLoc = target.Struct.locationId;
  // Planetary structs, and a fleet on station, reach whatever heads their planet's queue.
  if (st.locationType === 'planet') return st.locationId === f.planet.id && headFleet(f) === targetLoc;
  const fleet = fleetById(f, st.locationId);
  if (!fleet) return false;
  if (fleet.status !== 'away') return fleet.locationId === f.planet.id && headFleet(f) === targetLoc;
  // Away: the head of the queue reaches the whole world it raids; anyone queued reaches its neighbours.
  if (!fleet.locationListForward && fleet.locationId === f.planet.id && planetOf(f, target) === f.planet.id) return true;
  return !!targetLoc && (fleet.locationListForward === targetLoc || fleet.locationListBackward === targetLoc);
}

/** Why `shooterId` cannot fire `ws` at `targetId`, in words, or null when it can (charge aside). */
export function attackBlock(f: Field, shooterId: string, targetId: string, ws: WeaponSystem): string | null {
  const a = f.structs.get(shooterId), b = f.structs.get(targetId);
  if (!a || !b) return 'not on the map';
  const t = typeOf(a.Struct.type);
  if (!t) return 'unknown hull';
  if (b.Struct.owner === a.Struct.owner) return 'one of your own';
  if (isDestroyed(b)) return 'already destroyed';
  if (!flags(b).isBuilt) return 'still under construction — it can’t be targeted yet';
  const from = a.Struct.operatingAmbit as Ambit, to = b.Struct.operatingAmbit as Ambit;
  if (!canTargetAmbit(t, ws, from, to)) return `out of range — reaches ${reachLabel(t, ws)}, it flies in ${AMBIT_NAME[to] || to}`;
  if (flags(b).isHidden && to !== from) return `stealthed — only structs in ${AMBIT_NAME[to] || to} can see it`;
  if (!reachable(f, a, b)) return 'out of reach — not next to this fleet in the planet’s queue';
  return null;
}

export function attackTargets(f: Field, shooterId: string, ws: WeaponSystem): Set<string> {
  const out = new Set<string>();
  for (const id of f.structs.keys()) if (!attackBlock(f, shooterId, id, ws)) out.add(id);
  return out;
}

/** IsProtecting: same location, or a fleet docked at the planet the other stands on. */
function protecting(f: Field, d: StructFull, w: StructFull): boolean {
  const dl = d.Struct, wl = w.Struct;
  if (dl.locationId === wl.locationId) return true;
  if (dl.locationType === 'fleet' && wl.locationType === 'planet') return fleetById(f, dl.locationId)?.locationId === wl.locationId;
  if (dl.locationType === 'planet' && wl.locationType === 'fleet') return fleetById(f, wl.locationId)?.locationId === dl.locationId;
  return false;
}

/** Why `defenderId` cannot guard `wardId`, or null. Wards are the defender's own structs (the
 * chain allows any co-located struct; the map offers yours). */
export function guardBlock(f: Field, defenderId: string, wardId: string): string | null {
  const d = f.structs.get(defenderId), w = f.structs.get(wardId);
  if (!d || !w) return 'not on the map';
  if (defenderId === wardId) return 'it can’t guard itself';
  if (w.Struct.owner !== d.Struct.owner) return 'not one of yours';
  if (isDestroyed(w)) return 'destroyed';
  // The chain would take it, and the charge, for nothing.
  if ((w.structDefenders || []).includes(defenderId)) return 'already guarding it';
  if (!protecting(f, d, w)) return 'too far — a guard must share its location (or its fleet sit at the ward’s planet)';
  return null;
}

export function guardTargets(f: Field, defenderId: string): Set<string> {
  const out = new Set<string>();
  for (const id of f.structs.keys()) if (!guardBlock(f, defenderId, id)) out.add(id);
  return out;
}

/** Slot occupants and count of a planet or fleet in one battleground (chain arrays hold '' for empty). */
export function slotsIn(c: RawPlanet | RawFleet, ambit: Ambit): { count: number; ids: string[] } {
  const r = c as unknown as Record<string, unknown>;
  const ids = (r[ambit] as string[] | undefined) || [];
  return { count: Math.max(Number(r[ambit + 'Slots'] || 0), ids.length), ids };
}

/** Every empty slot of a container on this map. A fleet's Command Ship has no slot of its own. */
export function emptySlots(f: Field, where: 'planet' | 'fleet', containerId: string): Slot[] {
  const c = where === 'planet' ? (containerId === f.planet.id ? f.planet : null) : fleetById(f, containerId);
  if (!c) return [];
  const owner = c.owner;
  const side: SideV = owner === f.planet.owner ? 'player' : 'enemy';
  const out: Slot[] = [];
  for (const ambit of AMBITS) {
    const { count, ids } = slotsIn(c, ambit);
    for (let i = 0; i < count; i++) if (!ids[i]) out.push({ where, containerId, owner, side, ambit, slot: i });
  }
  return out;
}

/** Where a struct may move (MoveReadiness): an empty slot of its own planet or fleet in a battleground
 * its hull can operate in. A Command Ship moves between battlegrounds without a slot. */
export function moveDestinations(f: Field, structId: string): Slot[] {
  const s = f.structs.get(structId);
  const t = s ? typeOf(s.Struct.type) : undefined;
  if (!s || !t || !t.movable) return [];
  const can = (a: Ambit) => (t.possibleAmbit & AMBIT_FLAG[a]) !== 0;
  if (t.id === COMMAND_SHIP_ID) {
    const fleet = s.Struct.locationType === 'fleet' ? fleetById(f, s.Struct.locationId) : null;
    if (!fleet) return [];
    const side: SideV = fleet.owner === f.planet.owner ? 'player' : 'enemy';
    return AMBITS.filter((a) => can(a) && a !== s.Struct.operatingAmbit).map((ambit) => ({ where: 'fleet', containerId: fleet.id, owner: fleet.owner, side, ambit, slot: 0, command: true }));
  }
  const where = t.category;
  // Its own planet is the only planet it may move to; its own fleet the only fleet.
  const containerId = where === 'planet' ? (f.planet.owner === s.Struct.owner ? f.planet.id : '') : f.fleets.find((x) => x.owner === s.Struct.owner)?.id || '';
  return containerId ? emptySlots(f, where, containerId).filter((x) => can(x.ambit)) : [];
}

/** The empire's view of a struct, from a map read (fresher here than the empire's own copy). */
export function asOwned(s: StructFull): OwnedStruct {
  const a = s.structAttributes || {};
  const st = Number(a.status || 0);
  const x = a as Record<string, unknown>;
  return {
    id: s.Struct.id, typeId: Number(s.Struct.type), type: typeOf(s.Struct.type),
    locationType: s.Struct.locationType, locationId: s.Struct.locationId, ambit: s.Struct.operatingAmbit, slot: Number(s.Struct.slot || 0),
    health: Number(a.health || 0), status: st,
    materialized: !!(st & 1), built: !!a.isBuilt, online: !!a.isOnline, hidden: !!a.isHidden, destroyed: !!a.isDestroyed, locked: !!(st & 64),
    blockStartBuild: Number(a.blockStartBuild || 0), blockStartOreMine: Number(x.blockStartOreMine || 0), blockStartOreRefine: Number(x.blockStartOreRefine || 0),
    defenders: s.structDefenders || [], protectedStructIndex: Number(a.protectedStructIndex || 0), ore: Number(s.gridAttributes?.ore || 0),
  };
}

/** Struct ids a queued transaction is about (actor, targets, ward), for the "order pending" marks. */
export function idsInMsg(value: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (k === 'creator' || k === 'playerId') continue;
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && /^5-\d+$/.test(x)) out.push(x);
  }
  return out;
}

/** The slot a queued build or move is headed for, keyed like `slotKey` (null for other messages). */
export function slotOfMsg(typeUrl: string, value: Record<string, unknown>): string | null {
  if (typeUrl.endsWith('MsgStructBuildInitiate')) {
    const where = typeOf(Number(value.structTypeId))?.category;
    return where ? slotKey({ where, ambit: String(value.operatingAmbit), slot: Number(value.slot) }) : null;
  }
  if (typeUrl.endsWith('MsgStructMove')) return slotKey({ where: String(value.locationType), ambit: String(value.ambit), slot: Number(value.slot) });
  return null;
}

/** A multi-target weapon's picks plus one more, or why not. The chain takes exactly `max` targets
 * and checks each shot in turn: a target named twice is already dead (or no different) by its
 * second shot, so the map never names one twice. */
export function addPick(picks: string[], id: string, max: number): string[] | string {
  if (picks.includes(id)) return 'already targeted — pick another (Backspace takes one back)';
  if (picks.length >= max) return 'every target is picked';
  return [...picks, id];
}

/** The grid half of ReadinessCheck: what an owner's player-level state says about acting at all. */
export interface Power { online: boolean; load: bigint; structsLoad: bigint; capacity: bigint; connectionCapacity: bigint }

/** Why a struct can't take an order now (attack, guard, move all need it built and online, and
 * attack and guard its owner's grid online), or null. `grid` null: the owner isn't read yet. */
export function readyBlock(s: StructFull, grid: Power | null): string | null {
  if (isDestroyed(s)) return 'destroyed';
  if (!flags(s).isBuilt) return 'under construction';
  if (!flags(s).isOnline) return 'offline — power it up first';
  if (grid && !grid.online) return 'grid offline — load exceeds capacity';
  return null;
}

/** Why the owner can't build in this slot at all (BuildInitiateReadiness and the player checks of
 * MsgStructBuildInitiate), or null. A planet build needs its owner's fleet home with its Command
 * Ship online; a fleet build the same of that fleet. `ownerFleet`: the slot owner's fleet, wherever it is. */
export function buildBlock(f: Field, x: Pick<Slot, 'where' | 'containerId'>, grid: Power | null, ownerFleet: RawFleet | null): string | null {
  const fleet = x.where === 'fleet' ? fleetById(f, x.containerId) : ownerFleet;
  if (!fleet) return 'no fleet — builds need a fleet with a Command Ship';
  if (fleet.status === 'away') return 'your fleet is away — builds need it home';
  const cmd = fleet.commandStruct ? f.structs.get(fleet.commandStruct) : undefined;
  if (!cmd || isDestroyed(cmd)) return 'no Command Ship — builds need one';
  if (!flags(cmd).isOnline) return 'the Command Ship is offline — builds need it online';
  if (grid && !grid.online) return 'grid offline — load exceeds capacity';
  return null;
}

/** Spare capacity for new load (CanSupportLoadAddition), less `queued` draw already on its way. */
export function headroom(g: Power, queued = 0n): bigint {
  const total = g.capacity + g.connectionCapacity, load = g.load + g.structsLoad + queued;
  return load > total ? 0n : total - load;
}

/** Which way the board faces the viewer: true when they command the raider shown and not the
 * world itself — then their ships are the teal ones (spectators and defenders see the defender teal). */
export function viewerRaids(planetOwner: string, raiderOwner: string | undefined, commands: (playerId: string) => boolean): boolean {
  return !!raiderOwner && !commands(planetOwner) && commands(raiderOwner);
}

/** An order given while the vault was locked, kept as what it means (not a closure) so it can be
 * checked again against the board as it stands when the vault opens. */
export type Intent =
  | { kind: 'attack'; struct: string; weapon: WeaponSystem; targets: string[] }
  | { kind: 'defend'; struct: string; ward: string }
  | { kind: 'move'; struct: string; to: Slot }
  | { kind: 'build'; typeId: number; at: Slot }
  | { kind: 'verb'; struct: string; verb: string };

/** Why an intent no longer stands on this board, or null. (Owner, account and charge are the caller's.) */
export function intentBlock(f: Field, i: Intent): string | null {
  if (i.kind === 'build') {
    return emptySlots(f, i.at.where, i.at.containerId).some((x) => tileKey(x) === tileKey(i.at)) ? null : 'that slot is no longer empty';
  }
  const s = f.structs.get(i.struct);
  if (!s) return 'it is no longer on this map';
  if (i.kind === 'verb') return isDestroyed(s) ? 'destroyed' : null;   // power, stealth, cancel: verbsFor re-checks
  const r = readyBlock(s, null);
  if (r) return r;
  if (i.kind === 'attack') {
    if (new Set(i.targets).size !== i.targets.length) return 'a target is named twice';
    for (const id of i.targets) { const why = attackBlock(f, i.struct, id, i.weapon); if (why) return why; }
    return null;
  }
  if (i.kind === 'defend') return guardBlock(f, i.struct, i.ward);
  return moveDestinations(f, i.struct).some((x) => tileKey(x) === tileKey(i.to)) ? null : 'that slot is no longer free';
}

/* ── Overlay ─────────────────────────────────────────────────────────────── */

const TEAL = 0x43cdb6, RED = 0xff5a4a, AMBER = 0xebaa49;
/** Mirror of the board's slot heights (BattleView.slotPosition for a mid-sized hull). */
const TILE_Y: Record<Ambit, number> = { space: 7.6, air: 2.4, land: -3.45, water: -8.8 };

export type TileState = 'build' | 'move' | 'reserved';
export interface TileSpec extends Slot { state: TileState }

interface Tile { spec: TileSpec; group: THREE.Group; frame: THREE.LineBasicMaterial; glyph: THREE.LineBasicMaterial; fill: THREE.MeshBasicMaterial; pick: THREE.Mesh; geos: THREE.BufferGeometry[]; seed: number }
interface Reticle { unit: UnitView; mesh: THREE.Mesh; inner: THREE.Mesh; mat: THREE.MeshBasicMaterial; imat: THREE.MeshBasicMaterial; tone: 'attack' | 'guard'; picks: number }

/** A gunsight: four corner brackets around the unit square, as one mesh. */
function bracketGeometry(len = 0.42, w = 0.09): THREE.BufferGeometry {
  const pos: number[] = [];
  const quad = (x0: number, y0: number, x1: number, y1: number) => pos.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    quad(Math.min(sx, sx * (1 - len)), sy - (sy > 0 ? w : 0), Math.max(sx, sx * (1 - len)), sy + (sy < 0 ? w : 0));
    quad(sx - (sx > 0 ? w : 0), Math.min(sy, sy * (1 - len)), sx + (sx < 0 ? w : 0), Math.max(sy, sy * (1 - len)));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/* Slot frames, reticles: owned by the planet screen, parented to the board group. */
export class FieldOverlay {
  readonly group = new THREE.Group();
  private tiles = new Map<string, Tile>();
  private reticles = new Map<string, Reticle>();
  private ringGeo = { attack: bracketGeometry(), guard: new THREE.RingGeometry(1.0, 1.06, 6, 1) };
  private innerGeo = new THREE.RingGeometry(0.0, 0.26, 4, 1, Math.PI / 4);
  hoverTile: string | null = null;
  hoverUnit: string | null = null;
  private tmp = new THREE.Vector3();
  private pickList: THREE.Object3D[] = [];

  constructor(private xFor: (side: SideV, slot: number, command: boolean, column: 'fleet' | 'planet') => number, private camera: THREE.Camera) {
    this.group.renderOrder = 8;
  }

  /** Show exactly these tiles (by key); unchanged ones keep their meshes. */
  setTiles(specs: TileSpec[]) {
    const want = new Map(specs.map((s) => [tileKey(s), s]));
    for (const [k, t] of this.tiles) if (!want.has(k) || want.get(k)!.state !== t.spec.state) { this.dropTile(t); this.tiles.delete(k); }
    for (const [k, s] of want) if (!this.tiles.has(k)) this.tiles.set(k, this.makeTile(s));
    this.pickList = [...this.tiles.values()].map((t) => t.pick);
  }

  private makeTile(spec: TileSpec): Tile {
    const color = spec.state === 'reserved' ? AMBER : TEAL;
    const w = spec.command ? 3.4 : 2.6, hgt = spec.command ? 2.4 : 2.0;
    const group = new THREE.Group();
    const box = new THREE.BoxGeometry(w, hgt, 1.2);
    const frameGeo = new THREE.EdgesGeometry(box);
    box.dispose();
    const frame = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false });
    group.add(new THREE.LineSegments(frameGeo, frame));
    // A plus to build or land on; a diamond (an order on its way) for a queued slot.
    const g = spec.state === 'reserved'
      ? [0, 0.42, 0, 0.42, 0, 0, 0.42, 0, 0, 0, -0.42, 0, 0, -0.42, 0, -0.42, 0, 0, -0.42, 0, 0, 0, 0.42, 0]
      : [-0.38, 0, 0, 0.38, 0, 0, 0, -0.38, 0, 0, 0.38, 0];
    const glyphGeo = new THREE.BufferGeometry();
    glyphGeo.setAttribute('position', new THREE.Float32BufferAttribute(g, 3));
    const glyph = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4, depthWrite: false });
    const glyphLines = new THREE.LineSegments(glyphGeo, glyph);
    glyphLines.position.z = 0.61;
    group.add(glyphLines);
    const fillGeo = new THREE.PlaneGeometry(w, hgt);
    const fill = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const plate = new THREE.Mesh(fillGeo, fill);
    plate.position.z = 0.6;
    group.add(plate);
    const pickGeo = new THREE.BoxGeometry(w + 0.2, hgt + 0.2, 1.4);
    const pick = new THREE.Mesh(pickGeo, new THREE.MeshBasicMaterial({ visible: false }));
    pick.userData.tile = spec;
    group.add(pick);
    group.position.set(this.xFor(spec.side, spec.slot, !!spec.command, spec.where === 'planet' ? 'planet' : 'fleet'), TILE_Y[spec.ambit], spec.command ? -0.6 : 0);
    this.group.add(group);
    return { spec, group, frame, glyph, fill, pick, geos: [frameGeo, glyphGeo, fillGeo, pickGeo], seed: Math.random() * 6 };
  }

  private dropTile(t: Tile) {
    this.group.remove(t.group);
    t.geos.forEach((g) => g.dispose());
    t.frame.dispose(); t.glyph.dispose(); t.fill.dispose();
    (t.pick.material as THREE.Material).dispose();
  }

  pickTile(ray: THREE.Raycaster): TileSpec | null {
    if (!this.pickList.length) return null;
    const hits = ray.intersectObjects(this.pickList, false);
    return hits.length ? (hits[0].object.userData.tile as TileSpec) : null;
  }

  /** Reticles over these units; `picks` counts how often a multi-target weapon chose each. */
  setReticles(list: { unit: UnitView; tone: 'attack' | 'guard'; picks: number }[]) {
    const want = new Map(list.map((r) => [r.unit.id, r]));
    for (const [id, r] of this.reticles) if (!want.has(id) || want.get(id)!.tone !== r.tone || want.get(id)!.unit !== r.unit) { this.dropReticle(r); this.reticles.delete(id); }
    for (const [id, w] of want) {
      const have = this.reticles.get(id);
      if (have) { have.picks = w.picks; continue; }
      const color = w.tone === 'attack' ? RED : TEAL;
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const imat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(this.ringGeo[w.tone], mat);
      const inner = new THREE.Mesh(this.innerGeo, imat);
      mesh.renderOrder = inner.renderOrder = 9;
      this.group.add(mesh, inner);
      this.reticles.set(id, { unit: w.unit, mesh, inner, mat, imat, tone: w.tone, picks: w.picks });
    }
  }

  private dropReticle(r: Reticle) { this.group.remove(r.mesh, r.inner); r.mat.dispose(); r.imat.dispose(); }

  update(t: number, reduceMotion: boolean) {
    const pulse = reduceMotion ? 0.6 : 0.5 + 0.5 * Math.sin(t * 6);
    for (const [k, tile] of this.tiles) {
      const hot = this.hoverTile === k;
      const s = tile.spec.state;
      const wave = reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(t * 3 + tile.seed);
      tile.frame.opacity = s === 'move' ? 0.55 + pulse * 0.4 : s === 'reserved' ? 0.45 + wave * 0.35 : hot ? 0.75 : 0.11 + wave * 0.05;
      tile.glyph.opacity = s === 'build' && !hot ? 0.2 : 0.9;
      tile.fill.opacity = hot ? 0.16 : s === 'move' ? 0.05 + pulse * 0.07 : s === 'reserved' ? 0.04 + wave * 0.05 : 0;
      if (s === 'reserved' && !reduceMotion) tile.group.children[1].rotation.z = t * 1.2;
    }
    const v = this.tmp;
    for (const [id, r] of this.reticles) {
      const u = r.unit;
      if (u.destroyed || !u.mesh) { r.mesh.visible = r.inner.visible = false; continue; }
      u.center(v);
      const size = Math.max(u.halfWidth, u.halfHeight) * 1.3 + 0.35;
      const hot = this.hoverUnit === id;
      const locked = r.picks > 0;
      r.mesh.visible = r.inner.visible = true;
      r.mesh.position.copy(v); r.inner.position.copy(v);
      // Face the camera; spin while searching, hold still once locked.
      r.mesh.quaternion.copy(this.camera.quaternion);
      r.inner.quaternion.copy(this.camera.quaternion);
      // Brackets breathe and close in on the hovered target; the guard's hexagon turns slowly.
      if (r.tone === 'guard' && !reduceMotion) r.mesh.rotateZ(t * 0.5);
      const k = locked ? 0.8 : hot ? 0.88 : 1.1 - pulse * 0.12;
      r.mesh.scale.setScalar(size * k);
      r.mat.opacity = locked ? 1 : hot ? 1 : 0.45 + pulse * 0.45;
      r.imat.opacity = locked ? 0.9 : hot ? 0.6 : 0;
      r.inner.scale.setScalar(locked ? 1 + 0.25 * (r.picks - 1) : 0.8);
    }
  }

  dispose() {
    for (const t of this.tiles.values()) this.dropTile(t);
    for (const r of this.reticles.values()) this.dropReticle(r);
    this.tiles.clear(); this.reticles.clear(); this.pickList = [];
    this.ringGeo.attack.dispose(); this.ringGeo.guard.dispose(); this.innerGeo.dispose();
    this.group.removeFromParent();
  }
}
