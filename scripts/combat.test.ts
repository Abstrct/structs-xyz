/* The combat archive parses a real attack transaction (fixture from the
 * testnet: one shot, blocked by a guard, two defenders counter-firing) and
 * stages it on the simulator's chain types. */
import { readFileSync } from 'node:fs';
import { chainSort, recordsOf, summarize, type TxResponse } from '../src/chain/combat';
import { gridRecord } from '../src/chain/lcd';

let failures = 0;
const check = (cond: unknown, msg: string) => { if (!cond) { failures++; console.error('FAIL', msg); } };

const tx = JSON.parse(readFileSync(new URL('./fixtures/attack-tx.json', import.meta.url), 'utf8')) as TxResponse;
const recs = recordsOf(tx);
check(recs.length === 1, 'one attack in the fixture tx');
const r = recs[0];
check(r && r.hash === tx.txhash && r.height === Number(tx.height), 'record keeps hash and height');
check(r && r.signer.startsWith('structs1'), 'signer is the message sender');
const shot = r.attack.eventAttackShotDetail[0];
check(shot.blocked && !!shot.blockedByStructId, 'shot was blocked by a guard');
check(shot.eventAttackDefenderCounterDetail.length === 2, 'two defenders counter-fired');
const s = summarize(r.attack, (id) => 'P' + id);
check(s.title.includes('P' + r.attack.attackerPlayerId) && s.title.includes(shot.targetStructType), `summary names attacker and target: ${s.title}`);
check(s.result.includes('blocked'), `summary says blocked: ${s.result}`);
check(recordsOf({ ...tx, code: 5 }).length === 0, 'a failed tx holds no attacks');
check(recordsOf({ ...tx, events: [{ type: 'structs.structs.EventAttack', attributes: [{ key: 'eventAttackDetail', value: '{not json' }] }] }).length === 0, 'malformed detail is skipped');

// Same-block order. Block 10 ran A (two attacks), then B; C is in block 9. Queries list them
// in whatever order they like; the block's own transaction order decides.
const atk = tx.events.filter((e) => e.type === 'structs.structs.EventAttack');
const mk = (hash: string, height: string, n = 1): TxResponse => ({ ...tx, txhash: hash, height, events: [...tx.events.filter((e) => e.type !== 'structs.structs.EventAttack'), ...Array.from({ length: n }, () => atk[0])] });
const listed = [mk('B', '10'), mk('A', '10', 2), mk('C', '9')].flatMap(recordsOf);
check(listed.filter((x) => x.hash === 'A').map((x) => x.evt).join() === '0,1', 'attacks in one transaction are numbered in order');
const tag = (rs: typeof listed) => rs.map((x) => x.hash + x.evt).join(' ');
check(tag(chainSort(listed, new Map([[10, ['X', 'A', 'B']]]))) === 'C0 A0 A1 B0', `block order decides: ${tag(chainSort(listed, new Map([[10, ['X', 'A', 'B']]])))}`);
check(tag(chainSort([...listed].reverse(), new Map([[10, ['A', 'B']]]))) === 'C0 A0 A1 B0', 'whatever order the query gave');

// EventGrid records (as the live feed parses them) → the object, field and value they touch.
const g1 = gridRecord({ gridRecord: { attributeId: '2-4-1', value: '50000000000' } });
check(g1 && g1.objectId === '4-1' && g1.objectType === 4 && g1.field === 'capacity' && g1.value === '50000000000', 'substation capacity record');
check(gridRecord({ attributeId: '5-6-12', value: '999000000' })?.field === 'power', 'bare allocation power record');
check(gridRecord({ gridRecord: { attributeId: '11-1-2136', value: '2982759' } })?.objectId === '1-2136', 'player lastAction record');
check(gridRecord({ gridRecord: { attributeId: '99-4-1', value: '1' } }) === null && gridRecord({ gridRecord: { attributeId: '2-4-1', value: '<b>' } }) === null && gridRecord(null) === null && gridRecord('x') === null, 'unknown or malformed records are ignored');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('combat ok', s.title, '·', s.result);
