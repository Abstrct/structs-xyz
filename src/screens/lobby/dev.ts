/* Dev only (never in a build): `/lobby?plaza` walks into the plaza without a commander, and
 * `&crowd=N` fills a pretend deck with N real commanders from the chain roster (their real PFPs),
 * who chat on a timer. Nothing is sent anywhere: the room exists only in this tab. */
import { comms } from '../../chat/matrix';
import { newRoom, type Msg, type Room } from '../../chat/model';
import { store } from '../../chain/store';

const LINES = [
  'Anyone up for a gauntlet run?', 'how do I refine ore??', 'Trade kiosk, then Refine. I\'ll show you.',
  'gg everyone', 'My fleet is back home, shields up.', 'Who wants to practise at the warp gate?',
  'The Academy lesson on charge finally clicked', 'Daily challenge today is brutal', 'nice droid!',
];
const STAMPS = ['hi', 'thanks', 'gg', 'battle', 'yes'];

export function devRoom(n: number): Room {
  const r = newRoom('!dev:lobby', 'join');
  r.alias = '#dev:lobby';
  const players = [...store.players.values()].filter((p) => p.pfpClientRenderAttributes && p.pfpClientRenderAttributes !== '{}').slice(0, n);
  const fill = players.length < n ? [...store.players.values()].slice(0, n - players.length) : [];
  for (const p of [...players, ...fill]) {
    const id = `@${p.id}:dev`;
    r.members.set(id, { userId: id, membership: 'join', displayName: p.name || p.id });
    comms.chat.presence.set(id, { presence: 'online', currentlyActive: true, at: Date.now() });
  }
  return r;
}

let seq = 0;
export function devLine(r: Room, reply?: Msg): Msg | null {
  const ids = [...r.members.keys()];
  if (!ids.length) return null;
  const sender = ids[Math.floor(Math.random() * ids.length)];
  const stamp = Math.random() < 0.25 ? STAMPS[Math.floor(Math.random() * STAMPS.length)] : undefined;
  const m: Msg = {
    id: `$dev${++seq}`, sender, ts: Date.now(), kind: stamp ? 'emote' : 'text', rev: 0, pills: [],
    body: stamp ? 'waves' : LINES[Math.floor(Math.random() * LINES.length)], stamp,
    replyTo: reply && reply.sender !== sender && Math.random() < 0.4 ? reply.id : undefined,
  };
  r.timeline.push(m); r.byId.set(m.id, m);
  r.typing = Math.random() < 0.5 ? [ids[Math.floor(Math.random() * ids.length)]] : [];
  return m;
}
