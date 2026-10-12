/* The live feed's narration of raw chain events, offline. */
import { store, type FeedItem } from '../src/chain/store';

let failures = 0;
const check = (c: unknown, m: string) => { if (!c) { failures++; console.error('FAIL', m); } };
const items: FeedItem[] = [];
store.onFeed((i) => items.push(i));
const ingest = (events: { type: string; data: unknown }[], extra: Record<string, unknown> = {}) =>
  (store as unknown as { ingest(tx: unknown): void }).ingest({ height: 100, hash: 'H', events, time: Date.now(), ...extra });

// Before the roster loads, nobody counts as a new commander and no world as a discovery.
ingest([{ type: 'EventPlayer', data: { id: '1-7', name: 'Early' } }, { type: 'EventPlanet', data: { id: '2-888888', owner: '1-7', status: 'active' } }]);
check(!items.some((i) => i.kind === 'player' || i.kind === 'explore'), 'no fake arrivals before the roster loads');
store.players.delete('1-7'); store.planets.delete('2-888888'); store.maxPlanetIndex = 0;
store.coreLoaded = true;

// A small world: two commanders, one fleet away raiding the other.
store.players.set('1-1', { id: '1-1', name: 'Alice', planetId: '2-10', guildId: '0-1', primaryAddress: 'structs1alice' } as never);
store.players.set('1-2', { id: '1-2', name: 'Bob', planetId: '2-20', guildId: '0-1', primaryAddress: 'structs1bob' } as never);
store.byAddress.set('structs1alice', '1-1');
store.fleets.set('9-1', { id: '9-1', owner: '1-1', status: 'onStation', locationId: '2-10' } as never);

ingest([{ type: 'EventAttack', data: { eventAttackDetail: { attackerPlayerId: '1-1', attackerStructType: 'Tank', attackerStructLocationId: '9-1', eventAttackShotDetail: [{ targetStructType: 'Cruiser', targetPlayerId: '1-2', damage: '2', targetDestroyed: true }] } } }]);
check(items.at(-1)?.kind === 'attack' && /Alice's Tank fired on Cruiser of Bob: 2 dmg — DESTROYED/.test(items.at(-1)!.text) && items.at(-1)?.planetId === '2-10', 'attack narrated: ' + items.at(-1)?.text);

ingest([{ type: 'EventFleet', data: { id: '9-1', owner: '1-1', status: 'away', locationId: '2-20' } }]);
check(items.at(-1)?.kind === 'fleet' && items.at(-1)?.toPlanetId === '2-20', 'fleet departure narrated');

ingest([{ type: 'EventRaid', data: { eventRaidDetail: { fleetId: '9-1', planetId: '2-20', status: 'raidSuccessful' } } }]);
check(items.at(-1)?.kind === 'raid' && /Alice breached planet 2-20/.test(items.at(-1)!.text), 'raid narrated: ' + items.at(-1)?.text);

ingest([{ type: 'EventPlanet', data: { id: '2-999999', owner: '1-2', status: 'active', space: [], air: [], land: [], water: [], maxOre: '5' } }]);
check(items.at(-1)?.kind === 'explore' && /Bob discovered planet 2-999999/.test(items.at(-1)!.text), 'exploration narrated');

ingest([{ type: 'EventStruct', data: { id: '5-7', type: '14', owner: '1-1', locationType: 'planet', locationId: '2-10', operatingAmbit: 'land' } }], { action: '/structs.structs.MsgStructBuildInitiate' });
check(/Alice began building Ore Extractor \(land\)/.test(items.at(-1)!.text), 'build start narrated');

ingest([{ type: 'EventHashSuccess', data: { eventHashSuccessDetail: { callerAddress: 'structs1alice', category: 'build', objectId: '5-7' } } }], { signer: 'structs1alice' });
check(/Alice completed an Ore Extractor/.test(items.at(-1)!.text), 'build completion names the struct: ' + items.at(-1)?.text);

ingest([{ type: 'EventOreTheft', data: { eventOreTheftDetail: { thiefPlayerId: '1-1', victimPlayerId: '1-2', amount: '3' } } }]);
check(/Alice stole 3 ore from Bob/.test(items.at(-1)!.text) && items.at(-1)?.planetId === '2-20', 'ore theft narrated');

// An exploration commits the player (with the new planetId) before the planet, in one tx.
ingest([{ type: 'EventPlayer', data: { id: '1-2', name: 'Bob', planetId: '2-1000001', guildId: '0-1', primaryAddress: 'structs1bob' } }, { type: 'EventPlanet', data: { id: '2-1000001', owner: '1-2', status: 'active', space: [], air: [], land: [], water: [], maxOre: '5' } }]);
check(items.at(-1)?.kind === 'explore' && /2-1000001/.test(items.at(-1)!.text), 'exploration narrated when the player event comes first');

// History (backfill) neither moves fleets nor invents departures, and lands in block order.
const n0 = items.length;
(store as unknown as { replayAt: number }).replayAt = Date.now() - 60000;
ingest([{ type: 'EventFleet', data: { id: '9-1', owner: '1-1', status: 'onStation', locationId: '2-10' } }], { height: 50 });
ingest([{ type: 'EventOreTheft', data: { eventOreTheftDetail: { thiefPlayerId: '1-2', victimPlayerId: '1-1', amount: '1' } } }], { height: 50 });
(store as unknown as { replayAt: number }).replayAt = 0;
check(store.fleets.get('9-1')?.status === 'away' && !items.slice(n0).some((i) => i.kind === 'fleet'), 'history leaves the live fleet state alone');
check(store.feed.findIndex((i) => i.height === 50) < store.feed.findIndex((i) => i.height === 100), 'history is filed before newer live items');

// Junk never throws.
ingest([{ type: 'EventAttack', data: null }, { type: 'EventRaid', data: 'garbage' }, { type: 'EventUnknown', data: {} }]);

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('store ok', items.length, 'items');
