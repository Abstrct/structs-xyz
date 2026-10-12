/* Planet-map battlefield rules against structsd's: CanAttack (destroyed, unbuilt, ambit reach,
 * stealth, isReachable down the planet's queue), IsProtecting for guards, MoveReadiness for moves,
 * and the empty slots the map offers to build in. A defended world under a two-fleet raid. */
import type { RawFleet, RawPlanet, StructFull } from '../src/chain/lcd';
import {
  addPick, asOwned, attackBlock, attackTargets, buildBlock, emptySlots, type Field, guardBlock, headFleet, headroom, idsInMsg, intentBlock, moveDestinations,
  readyBlock, slotOfMsg, viewerRaids,
} from '../src/screens/planetActions';

let fails = 0;
const ok = (c: unknown, m: string) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const four = (...ids: string[]) => [...ids, '', '', '', ''].slice(0, 4);

const planet = {
  id: '2-1', owner: '1-1', status: 'active', locationListStart: '9-2',
  space: four(), air: four(), land: four('5-1', '5-2'), water: four(), spaceSlots: '4', airSlots: '4', landSlots: '4', waterSlots: '4',
} as unknown as RawPlanet;
const fleet = (id: string, owner: string, status: string, fw: string, bw: string, cmd: string, slots: Partial<Record<'space' | 'air' | 'land' | 'water', string[]>>) =>
  ({ id, owner, status, locationType: 'planet', locationId: '2-1', locationListForward: fw, locationListBackward: bw, commandStruct: cmd,
    space: four(...(slots.space || [])), air: four(...(slots.air || [])), land: four(...(slots.land || [])), water: four(...(slots.water || [])) }) as unknown as RawFleet;
const home = fleet('9-1', '1-1', 'onStation', '', '', '5-10', { space: ['5-11', '5-12'], air: ['5-13'], land: ['5-14'] });
const head = fleet('9-2', '1-2', 'away', '', '9-3', '5-20', { land: ['5-21'], air: ['5-22', '5-25'], space: ['5-23'] });
const queued = fleet('9-3', '1-3', 'away', '9-2', '', '', { space: ['5-30'], land: ['5-31'] });

const S = (id: string, type: number, owner: string, locationType: string, locationId: string, ambit: string, slot: number, o: { built?: boolean; hidden?: boolean; destroyed?: boolean } = {}): StructFull => {
  const built = o.built ?? true;
  const status = 1 | (built ? 2 | 4 : 0) | (o.hidden ? 16 : 0) | (o.destroyed ? 32 : 0);
  return { Struct: { id, type: String(type), owner, locationType, locationId, operatingAmbit: ambit, slot: String(slot) } as unknown as StructFull['Struct'],
    structAttributes: { health: '3', status: String(status), isBuilt: built, isOnline: built, isHidden: !!o.hidden, isDestroyed: !!o.destroyed } };
};
const structs = new Map([
  S('5-1', 14, '1-1', 'planet', '2-1', 'land', 0), S('5-2', 19, '1-1', 'planet', '2-1', 'land', 1),
  S('5-10', 1, '1-1', 'fleet', '9-1', 'land', 0), S('5-11', 2, '1-1', 'fleet', '9-1', 'space', 0), S('5-12', 2, '1-1', 'fleet', '9-1', 'space', 1, { destroyed: true }),
  S('5-13', 7, '1-1', 'fleet', '9-1', 'air', 0), S('5-14', 10, '1-1', 'fleet', '9-1', 'land', 0),
  S('5-20', 1, '1-2', 'fleet', '9-2', 'land', 0), S('5-21', 9, '1-2', 'fleet', '9-2', 'land', 0), S('5-22', 6, '1-2', 'fleet', '9-2', 'air', 0, { hidden: true }),
  S('5-25', 5, '1-2', 'fleet', '9-2', 'air', 1), S('5-23', 3, '1-2', 'fleet', '9-2', 'space', 0, { built: false }),
  S('5-30', 4, '1-3', 'fleet', '9-3', 'space', 0), S('5-31', 9, '1-3', 'fleet', '9-3', 'land', 0),
].map((s) => [s.Struct.id, s]));
const f: Field = { planet, fleets: [home, head, queued], structs };
const has = (r: string | null, word: string) => !!r && r.includes(word);

// The raid's head reaches the whole world it raids, in its weapon's battlegrounds.
ok(attackBlock(f, '5-21', '5-1', 'primaryWeapon') === null, 'raider tank hits a planetary struct on land');
ok(attackBlock(f, '5-21', '5-10', 'primaryWeapon') === null, 'raider tank hits the home fleet’s command ship on land');
ok(has(attackBlock(f, '5-21', '5-11', 'primaryWeapon'), 'out of range'), 'tank cannot reach space');
ok(has(attackBlock(f, '5-21', '5-20', 'primaryWeapon'), 'your own'), 'no firing on your own fleet');
ok(has(attackBlock(f, '5-21', '5-12', 'primaryWeapon'), 'destroyed'), 'a wreck is no target');
// The defender reaches whatever heads the planet's queue, and nothing behind it.
ok(attackBlock(f, '5-11', '5-21', 'primaryWeapon') === null, 'home battleship shells the head raider on land');
ok(has(attackBlock(f, '5-11', '5-23', 'secondaryWeapon'), 'construction'), 'an unbuilt hull cannot be targeted');
ok(has(attackBlock(f, '5-11', '5-30', 'secondaryWeapon'), 'out of reach'), 'the defender cannot reach a fleet queued behind the head');
// Stealth: only the target's own battleground sees it.
ok(attackBlock(f, '5-13', '5-22', 'primaryWeapon') === null, 'an interceptor in the air sees the stealthed bomber');
ok(has(attackBlock(f, '5-14', '5-22', 'primaryWeapon'), 'stealthed'), 'a SAM on land cannot see the stealthed bomber in the air');
// A queued raider reaches its neighbours in the queue, not the world.
ok(attackBlock(f, '5-30', '5-25', 'primaryWeapon') === null, 'queued frigate fires on the raider ahead of it');
ok(has(attackBlock(f, '5-30', '5-11', 'primaryWeapon'), 'out of reach'), 'queued frigate cannot reach the defenders');
ok([...attackTargets(f, '5-21', 'primaryWeapon')].sort().join() === '5-1,5-10,5-14,5-2,5-31', 'raider tank’s full target list: everything on land in this orbit but its own');
ok(headFleet({ ...f, planet: { ...planet, locationListStart: '' } }) === '9-2', 'queue head falls back to the fleet with nothing ahead');

// Guards share a location, or sit in a fleet docked at the ward's planet.
ok(guardBlock(f, '5-11', '5-10') === null, 'a battleship guards its own command ship');
ok(guardBlock(f, '5-11', '5-1') === null, 'a home fleet docked here guards a planetary struct');
ok(has(guardBlock(f, '5-11', '5-21'), 'not one of yours'), 'no guarding the enemy');
ok(has(guardBlock(f, '5-11', '5-11'), 'itself'), 'no guarding itself');
ok(has(guardBlock(f, '5-21', '5-1'), 'not one of yours'), 'raiders cannot guard the defender’s world');

// Slots to build in and to move to.
ok(emptySlots(f, 'planet', '2-1').length === 14, 'planet offers its 14 empty slots');
ok(emptySlots(f, 'planet', '2-1').every((x) => x.side === 'player' && x.owner === '1-1'), 'planet slots sit on the defender’s half');
ok(emptySlots(f, 'fleet', '9-2').every((x) => x.side === 'enemy') && emptySlots(f, 'fleet', '9-2').length === 12, 'raider fleet slots sit on the raiders’ half');
const cmdMoves = moveDestinations(f, '5-10');
ok(cmdMoves.length === 3 && cmdMoves.every((x) => x.command && x.ambit !== 'land'), 'a command ship moves to its other three battlegrounds');
ok(moveDestinations(f, '5-11').length === 0, 'a battleship is not movable');

ok(idsInMsg({ creator: 'structs1x', operatingStructId: '5-21', targetStructId: ['5-1'], weaponSystem: 'primaryWeapon' }).join() === '5-21,5-1', 'a queued attack names its shooter first, then targets');
const o = asOwned(structs.get('5-23')!);
ok(!o.built && !o.online && o.type?.id === 3, 'map read becomes the empire’s struct shape');

// GetPlanetId is where a struct stands (its fleet's location), not its owner's home: the raid's
// head reaches every fleet in this orbit, the queue behind it included; the home fleet only the head.
ok(attackBlock(f, '5-21', '5-31', 'primaryWeapon') === null, 'the raid’s head reaches a raider queued behind it');
ok(has(attackBlock(f, '5-11', '5-31', 'primaryWeapon'), 'out of reach'), 'the home fleet reaches only the head of the queue');
ok(attackBlock(f, '5-31', '5-21', 'primaryWeapon') === null, 'a queued tank fires on the head ahead of it');

// Guard posts: no paying twice for the same post.
const guarded: Field = { ...f, structs: new Map(f.structs) };
guarded.structs.set('5-10', { ...structs.get('5-10')!, structDefenders: ['5-11'] });
ok(has(guardBlock(guarded, '5-11', '5-10'), 'already'), 'a struct already guarding its ward is not offered it again');

// Multi-target weapons: distinct targets, exactly as many as the weapon takes.
ok(JSON.stringify(addPick(['5-1'], '5-2', 2)) === '["5-1","5-2"]', 'a second distinct target is added');
ok(typeof addPick(['5-1'], '5-1', 2) === 'string', 'the same target cannot be picked twice');
ok(typeof addPick(['5-1', '5-2'], '5-10', 2) === 'string', 'no more picks than the weapon takes');

// Readiness: built, online, and (for attack and guard) the owner's grid online.
const grid = (online: boolean, load = 0n, capacity = 1000n) => ({ online, load, structsLoad: 0n, capacity, connectionCapacity: 0n });
ok(readyBlock(structs.get('5-11')!, grid(true)) === null, 'a built, online battleship with its grid up is ready');
ok(has(readyBlock(structs.get('5-11')!, grid(false)), 'grid offline'), 'an offline grid stops attacks and guard posts');
ok(has(readyBlock(structs.get('5-23')!, null), 'construction'), 'an unbuilt hull takes no orders');

// Builds: a planet build needs its owner's fleet home with its Command Ship online (BuildInitiateReadiness).
const pslot = { where: 'planet' as const, containerId: '2-1' };
ok(buildBlock(f, pslot, grid(true), home) === null, 'builds go with the fleet home and its flagship online');
ok(has(buildBlock(f, pslot, grid(true), { ...home, status: 'away', locationId: '2-9' } as RawFleet), 'away'), 'no planet build while the home fleet is away');
const cmdOff: Field = { ...f, structs: new Map(f.structs) };
const c = structs.get('5-10')!;
cmdOff.structs.set('5-10', { ...c, structAttributes: { ...c.structAttributes, isOnline: false } });
ok(has(buildBlock(cmdOff, pslot, grid(true), home), 'offline'), 'no build while the Command Ship is offline');
ok(has(buildBlock(f, pslot, grid(false), home), 'grid offline'), 'no build while the grid is offline');
ok(has(buildBlock(f, { where: 'fleet', containerId: '9-2' }, grid(true), null), 'away'), 'a raiding fleet builds nothing');
ok(headroom(grid(true, 600n), 100n) === 300n && headroom(grid(false, 2000n)) === 0n, 'spare power counts queued build draw and never goes negative');

// Board orientation: teal is whoever the viewer commands; spectators see the defender teal.
ok(!viewerRaids('1-1', '1-2', () => false), 'a spectator sees the defender as teal');
ok(viewerRaids('1-1', '1-2', (id) => id === '1-2'), 'the raider’s commander sees their own fleet teal');
ok(!viewerRaids('1-1', '1-2', () => true), 'commanding both sides keeps the defender’s view');
ok(!viewerRaids('1-1', undefined, (id) => id === '1-2'), 'no raider shown, no flip');

// A held order is re-checked against the board when the vault opens.
ok(intentBlock(f, { kind: 'attack', struct: '5-11', weapon: 'primaryWeapon', targets: ['5-21'] }) === null, 'a still-valid attack goes');
ok(has(intentBlock(f, { kind: 'attack', struct: '5-11', weapon: 'primaryWeapon', targets: ['5-21', '5-21'] }), 'twice'), 'a held attack naming a target twice is refused');
ok(has(intentBlock(f, { kind: 'attack', struct: '5-12', weapon: 'primaryWeapon', targets: ['5-21'] }), 'destroyed'), 'a wrecked shooter’s held shot is dropped');
const taken = emptySlots(f, 'planet', '2-1')[0];
const filled: Field = { ...f, planet: { ...planet, [taken.ambit]: four('5-99') } as unknown as RawPlanet };
ok(intentBlock(f, { kind: 'build', typeId: 14, at: taken }) === null && has(intentBlock(filled, { kind: 'build', typeId: 14, at: taken }), 'no longer empty'), 'a held build into a slot since filled is dropped');
ok(intentBlock(f, { kind: 'move', struct: '5-10', to: cmdMoves[0] }) === null, 'a held flagship move still stands');

ok(slotOfMsg('/structs.structs.MsgStructBuildInitiate', { structTypeId: 14, operatingAmbit: 'land', slot: 2 }) === 'planet:land:2', 'a queued build reserves a planet slot');
ok(slotOfMsg('/structs.structs.MsgStructMove', { locationType: 'fleet', ambit: 'air', slot: 1 }) === 'fleet:air:1', 'a queued move reserves a fleet slot');
ok(slotOfMsg('/structs.structs.MsgStructAttack', {}) === null, 'other orders reserve nothing');

if (fails) process.exit(1);
console.log('planetActions: all checks passed');
