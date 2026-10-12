/* Game-layer checks: event routing sees the objects real chain events touch (payloads as the
 * chain emits them — the typed event's single field, unwrapped — and wrapped, as some feeds do). */
import { touchedIds } from '../src/game/empire';
import { buildable } from '../src/game/actions';

let fails = 0;
const ok = (c: unknown, m: string) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const has = (ids: string[], ...want: string[]) => want.every((w) => ids.includes(w));

ok(has(touchedIds('EventGrid', { attributeId: '11-1-2136', value: '2982759' }), '1-2136'), 'grid record (unwrapped) → player');
ok(has(touchedIds('EventGrid', { gridRecord: { attributeId: '0-2-77', value: '4' } }), '2-77'), 'grid record (wrapped) → planet');
ok(has(touchedIds('EventStructAttribute', { attributeId: '0-5-374778', value: '2' }), '5-374778'), 'struct attribute → struct');
ok(has(touchedIds('EventStruct', { id: '5-9', owner: '1-3', locationId: '2-4' }), '5-9', '1-3', '2-4'), 'struct → struct, owner, location');
ok(has(touchedIds('EventAttack', { attackerStructId: '5-1', eventAttackShotDetail: [{ targetStructId: '5-2', targetPlayerId: '1-8' }] }), '5-1', '5-2', '1-8'), 'attack → attacker, target, victim');
ok(has(touchedIds('EventRaid', { fleetId: '9-4', planetId: '2-6', status: 'ongoing' }), '9-4', '2-6'), 'raid → fleet, planet');
ok(has(touchedIds('EventOreMine', { playerId: '1-5', amount: '1' }), '1-5'), 'ore mine → player');
ok(buildable('planet', 'land').some((t) => t.type === 'Ore Extractor') && !buildable('planet', 'space').some((t) => t.type === 'Ore Extractor'), 'buildable respects ambits');
ok(!buildable('fleet', 'space').some((t) => t.id === 1), 'command ship is never offered as a build');
if (fails) process.exit(1);
console.log('game: all checks passed');
