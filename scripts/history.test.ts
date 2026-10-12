/* The chain-at-a-past-block decoder, against real abci_query replies captured from the public
 * testnet at block 2,215,158: planet 2-395 under raid, the raiding fleet 9-2617, and that
 * fleet's Command Ship, which hull 5-139214 was guarding. */
import { readFileSync } from 'node:fs';
import { decodeFleet, decodePlanet, decodeStruct, fields, idRequest } from '../src/chain/history';

let failures = 0;
const check = (cond: unknown, msg: string) => { if (!cond) { failures++; console.error('FAIL', msg); } };

const fx = JSON.parse(readFileSync(new URL('./fixtures/abci-history.json', import.meta.url), 'utf8')) as Record<string, { value: string }>;
const bytes = (k: string) => new Uint8Array(Buffer.from(fx[k].value, 'base64'));

check(Buffer.from(idRequest('2-395')).toString('hex') === '0a05' + Buffer.from('2-395').toString('hex'), 'a Get request is field 1, length-delimited');
check(idRequest('x'.repeat(200))[1] === 0xc8 && idRequest('x'.repeat(200))[2] === 0x01, 'long ids get a multi-byte length');

const planet = decodePlanet(bytes('planet'));
check(planet.id === '2-395' && planet.owner === '1-411', `planet id and owner: ${planet.id} ${planet.owner}`);
check(planet.structs.length === 6 && planet.structs.includes('5-4598'), `six planetary structs: ${planet.structs.join(',')}`);

const fleet = decodeFleet(bytes('fleet'));
check(fleet.id === '9-2617' && fleet.owner === '1-2617', 'fleet id and owner');
check(fleet.locationId === '2-395' && fleet.away, 'the raider is away, at the planet it raids');
check(fleet.commandStruct === '5-139817' && fleet.structs.length === 6, `command ship and six hulls: ${fleet.commandStruct} ${fleet.structs.length}`);

const ship = decodeStruct(bytes('struct'));
check(ship.id === '5-139817' && ship.typeId === 1 && ship.owner === '1-2617', 'the Command Ship by id, type and owner');
check(ship.locationType === 'fleet' && ship.locationId === '9-2617' && ship.ambit === 'land' && ship.slot === 0, `where it stands: ${ship.locationType} ${ship.locationId} ${ship.ambit} ${ship.slot}`);
check(ship.health === 6 && ship.status === 7 && !ship.hidden && !ship.destroyed, `health and status bits: ${ship.health} ${ship.status}`);
check(ship.defenders.length === 1 && ship.defenders[0] === '5-139214', `its guard: ${ship.defenders.join(',')}`);

let threw = false;
try { fields(bytes('struct').subarray(0, 40)); } catch { threw = true; }
check(threw, 'a truncated reply is an error, not a half-read struct');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('history ok', planet.id, fleet.id, ship.id);
