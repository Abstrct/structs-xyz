/* The Concourse, offline: the chat model keeps the lobby's own room state (where each droid last
 * stood) and reads stamps; outgoing stamps carry their field and a readable body; the plaza's plan
 * gives everyone a stable home spot clear of the stations, and nobody walks through a wall. */
import * as THREE from 'three';
import { applySync, emptyState } from '../src/chat/model';
import { messageContent } from '../src/chat/format';
import { STATIONS, COLLIDERS, WALK_R, SPAWN, INSTRUCTOR, ACADEMY, homeSpot, clampWalk } from '../src/screens/lobby/layout';
import { HUBS } from '../src/data/learn';

let fails = 0;
const ok = (cond: unknown, msg: string) => { if (!cond) { fails++; console.error('FAIL', msg); } };

const ME = '@1-7:matrix.test';
const ROOM = '!deck:matrix.test';
const spot = (who: string, x: number, z: number, t: number) => ({ type: 'xyz.structs.lobby.spot', state_key: who, sender: who, origin_server_ts: t, content: { x, z, yaw: 1, t } });

// Room state: the lobby's spots are kept per user, newest wins, and never become timeline rows.
const st = emptyState(ME);
applySync(st, { rooms: { join: { [ROOM]: {
  state: { events: [spot('@1-8:matrix.test', 3, 4, 100), { type: 'xyz.other.thing', state_key: '', content: {} }, { type: 'm.room.member', state_key: '@1-8:matrix.test', content: { membership: 'join' } }] },
  timeline: { events: [
    { type: 'm.room.message', event_id: '$a', sender: '@1-8:matrix.test', origin_server_ts: 200, content: { msgtype: 'm.emote', body: 'waves', 'xyz.structs.stamp': 'hi' } },
    { type: 'm.room.message', event_id: '$b', sender: '@1-8:matrix.test', origin_server_ts: 210, content: { msgtype: 'm.text', body: 'hello', 'xyz.structs.stamp': '<script>' } },
    spot('@1-8:matrix.test', 5, 6, 300),
  ] },
} } } }, true);
const r = st.rooms.get(ROOM)!;
ok(r, 'the room joined');
const spots = r.custom.get('xyz.structs.lobby.spot');
ok(spots?.get('@1-8:matrix.test')?.content.x === 5 && spots?.get('@1-8:matrix.test')?.content.z === 6, 'the newest spot (from the timeline) wins');
ok(!r.custom.has('xyz.other.thing'), 'only xyz.structs.* state is kept');
ok(r.timeline.every((m) => m.kind !== 'system' || !String(m.body).includes('spot')), 'spots never show as rows');
ok(r.byId.get('$a')?.stamp === 'hi', 'a stamp is read');
ok(r.byId.get('$b')?.stamp === undefined, 'a malformed stamp is dropped');

// A stripped state event with no type (invite state can carry one) must not wedge the sync.
{
  const st2 = emptyState(ME);
  let threw = false;
  try { applySync(st2, { rooms: { join: { '!x:matrix.test': { state: { events: [{ state_key: '', content: {} }] }, timeline: { events: [] } } } } } as never, true); } catch { threw = true; }
  ok(!threw, 'a state event without a type is skipped, not thrown on');
}

// Outgoing: a stamp rides as a field; the body stays plain for other clients.
const c = messageContent({ msgtype: 'm.emote', body: 'waves', stamp: 'hi' });
ok(c['xyz.structs.stamp'] === 'hi' && c.body === 'waves' && c.msgtype === 'm.emote', 'stamps go out with a readable body');
ok(!('xyz.structs.stamp' in messageContent({ msgtype: 'm.text', body: 'hi' })), 'plain text carries no stamp');

// The plan: a kiosk per hub, everything inside the rim.
ok(HUBS.every((h) => STATIONS.some((s) => s.kind === 'kiosk' && s.hub === h.id)), 'every hub has a kiosk');
ok(STATIONS.every((s) => Math.hypot(s.at.x, s.at.z) < WALK_R), 'every station stands on the plaza');
ok(Math.hypot(SPAWN.x, SPAWN.z) < WALK_R && COLLIDERS.every((k) => Math.hypot(k.x - SPAWN.x, k.z - SPAWN.z) > k.r), 'the spawn is clear');
for (const s of STATIONS.filter((x) => x.kind === 'kiosk')) {
  // Each kiosk can be reached: a point within its reach that's walkable.
  const toward = new THREE.Vector3(-s.at.x, 0, -s.at.z).normalize().multiplyScalar(2.2).add(s.at);
  const p = clampWalk(toward.clone());
  ok(p.distanceTo(s.at) < s.reach, `${s.id}: you can stand within reach`);
}

// Home spots: stable, on the ring, clear of stations and colliders.
for (let i = 0; i < 300; i++) {
  const id = `@1-${i}:matrix.test`;
  const a = homeSpot(id), b = homeSpot(id);
  ok(a.equals(b), `${id}: same spot twice`);
  const d = Math.hypot(a.x, a.z);
  ok(d > 3 && d < WALK_R, `${id}: on the plaza (r=${d.toFixed(1)})`);
  ok(COLLIDERS.every((k) => Math.hypot(k.x - a.x, k.z - a.z) > k.r), `${id}: not inside anything`);
}

// Walls: anything pushed out stays on the floor and outside every collider.
let inside = 0, through = 0;
for (let i = 0; i < 40000; i++) {
  // Half anywhere, half crowded round the stations (where things sit close together).
  const s = STATIONS[i % STATIONS.length].at;
  const p = i % 2 ? new THREE.Vector3((Math.random() - 0.5) * 60, 0, (Math.random() - 0.5) * 60) : new THREE.Vector3(s.x + (Math.random() - 0.5) * 6, 0, s.z + (Math.random() - 0.5) * 6);
  clampWalk(p);
  if (Math.hypot(p.x, p.z) > 19.7 - 0.45 + 1e-6) through++;
  if (COLLIDERS.some((k) => Math.hypot(k.x - p.x, k.z - p.z) < k.r - 1e-6)) inside++;
}
ok(!through, `never through the wall (${through})`);
ok(!inside, `never inside anything (${inside} of 40000)`);
ok(Math.hypot(INSTRUCTOR.x - ACADEMY.x, INSTRUCTOR.z - ACADEMY.z) > 0.6 + 0.75 + 0.9, 'a droid fits between the Instructor and the Academy podium');
const inBeacon = clampWalk(new THREE.Vector3(0.2, 0, 0.1));
ok(Math.hypot(inBeacon.x, inBeacon.z) >= COLLIDERS[0].r, 'pushed out of the beacon');

if (fails) { console.error(`lobby: ${fails} failure(s)`); process.exit(1); }
console.log('lobby: all checks passed');
