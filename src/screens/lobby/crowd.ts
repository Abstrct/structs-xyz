/* Who is on the deck, and where they stand.
 *
 * Players only: a Matrix user shows up as a droid when their id is a commander's (@1-…), they're in
 * the room, and they're around (online, or spoke in the last 15 minutes). Each has a home spot on
 * the ring, seeded from their id (Phase 1: no server needed). When the deck room carries their
 * last stop (`xyz.structs.lobby.spot`, keyed by their Matrix id: Phase 2) they walk there instead.
 * Idle droids wander a little round their spot; a speaker turns to whoever they're answering. */
import * as THREE from 'three';
import { comms } from '../../chat/matrix';
import { playerOfUser } from '../../chat/format';
import { store } from '../../chain/store';
import { pfpAttrs, type PfpAttrs } from '../../data/droidParts';
import { DroidActor } from '../../gfx/droid/actor';
import { homeSpot, clampWalk } from './layout';
export { homeSpot, clampWalk };
import type { Msg, Room } from '../../chat/model';

export const SPOT_TYPE = 'xyz.structs.lobby.spot';
const AROUND_MS = 15 * 60_000;
const SPOT_FRESH_MS = 3 * 3600_000;
const MAX = 64;
/** Full 3D droids per deck; past that, the flat PFP sprite (fewer on a phone). */
const FULL = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 16 : 32;

/* People you've muted (no balloons, a dim droid) or blocked (no droid): local to this browser. */
const listKey = (k: string) => `structs.lobby.${k}`;
function readList(k: string): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(listKey(k)) || '[]')); } catch { return new Set(); } }
function writeList(k: string, s: Set<string>) { try { localStorage.setItem(listKey(k), JSON.stringify([...s])); } catch { /* private window */ } }
export const lists = {
  muted: readList('muted'), blocked: readList('blocked'),
  toggle(k: 'muted' | 'blocked', id: string) { const s = this[k]; if (s.has(id)) s.delete(id); else s.add(id); writeList(k, s); return s.has(id); },
};

/** Is this Matrix user a commander we can show? */
export function isPlayer(userId: string): string | null {
  const pid = playerOfUser(userId);
  if (!pid) return null;
  if (store.coreLoaded && !store.players.has(pid)) return null;
  return pid;
}

export function attrsOf(userId: string): PfpAttrs {
  const pid = playerOfUser(userId);
  return pfpAttrs(pid ? store.players.get(pid)?.pfpClientRenderAttributes : null, userId);
}

export interface Person {
  userId: string;
  pid: string;
  actor: DroidActor;
  home: THREE.Vector3;
  target: THREE.Vector3;
  yaw: number;
  faceTo: number | null;
  nextWander: number;
  lastSpoke: number;
  /** Phase 2: when their last stop was written. */
  spotTs: number;
  away: boolean;
  typing: boolean;
}

export class Crowd {
  readonly people = new Map<string, Person>();
  readonly group = new THREE.Group();
  private spoke = new Map<string, number>();
  private lite: boolean;

  constructor(lite: boolean) { this.lite = lite; this.group.name = 'crowd'; }

  /** Note who just spoke (keeps them around), from the timeline. */
  heard(m: Msg) { if (m.sender && m.ts) this.spoke.set(m.sender, Math.max(this.spoke.get(m.sender) ?? 0, m.ts)); }

  /** Re-read the room: who's here, where they stand, what they look like. */
  sync(room: Room | null, now = Date.now()) {
    const me = comms.me;
    const want: { userId: string; pid: string; recent: number }[] = [];
    if (room) {
      for (const m of room.timeline) if (m.kind !== 'system' && m.kind !== 'local') this.heard(m);
      for (const [userId, mem] of room.members) {
        if (mem.membership !== 'join' || userId === me || lists.blocked.has(userId)) continue;
        const pid = isPlayer(userId);
        if (!pid) continue;
        const pres = comms.chat?.presence.get(userId);
        const presAt = pres ? (pres.currentlyActive ? now : pres.at - (pres.lastActiveAgo ?? 0)) : 0;
        const online = pres?.presence === 'online' || pres?.currentlyActive;
        const spot = room.custom.get(SPOT_TYPE)?.get(userId);
        const spotTs = Number(spot?.content?.t) || spot?.ts || 0;
        const recent = Math.max(this.spoke.get(userId) ?? 0, online ? now : presAt, now - spotTs < SPOT_FRESH_MS ? spotTs : 0);
        if (now - recent < AROUND_MS || online) want.push({ userId, pid, recent });
      }
    }
    want.sort((a, b) => b.recent - a.recent);
    const keep = new Set(want.slice(0, MAX).map((w) => w.userId));
    for (const [id, p] of this.people) if (!keep.has(id)) { p.actor.dispose(); this.people.delete(id); }
    want.slice(0, MAX).forEach((w, i) => {
      let p = this.people.get(w.userId);
      if (!p) {
        const home = homeSpot(w.userId);
        const actor = new DroidActor(attrsOf(w.userId), { lite: this.lite || i >= FULL, seed: w.userId });
        actor.group.position.copy(home);
        const yaw = Math.atan2(-home.x, -home.z);
        actor.group.rotation.y = yaw;
        this.group.add(actor.group);
        p = { userId: w.userId, pid: w.pid, actor, home, target: home.clone(), yaw, faceTo: null, nextWander: 4 + Math.random() * 8, lastSpoke: 0, spotTs: 0, away: false, typing: false };
        this.people.set(w.userId, p);
      } else p.actor.setAttrs(attrsOf(w.userId));
      // Phase 2: a fresh last stop wins over the seeded home.
      const spot = room?.custom.get(SPOT_TYPE)?.get(w.userId);
      const c = spot?.content;
      const ts = Number(c?.t) || spot?.ts || 0;
      if (c && ts > p.spotTs && Date.now() - ts < SPOT_FRESH_MS && Number.isFinite(c.x) && Number.isFinite(c.z)) {
        p.spotTs = ts;
        p.home = clampWalk(new THREE.Vector3(Number(c.x), 0, Number(c.z)));
        p.target.copy(p.home);
        if (Number.isFinite(c.yaw)) p.faceTo = Number(c.yaw);
      }
      const pres = comms.chat?.presence.get(w.userId);
      p.away = pres?.presence === 'unavailable' || pres?.presence === 'offline';
      p.typing = !!room?.typing.includes(w.userId);
      p.actor.dim = p.away || lists.muted.has(w.userId);
    });
  }

  /** Someone spoke: they turn to whoever they're answering (or toward the beacon) and talk. */
  speak(userId: string, m: Msg, room: Room | null, meAt: THREE.Vector3 | null) {
    const p = this.people.get(userId);
    this.spoke.set(userId, Date.now());
    if (!p) return;
    p.actor.talk = 1;
    p.lastSpoke = Date.now();
    const to = m.replyTo ? room?.byId.get(m.replyTo)?.sender : null;
    const at = to ? (to === comms.me ? meAt : this.people.get(to)?.actor.group.position) : null;
    const pos = p.actor.group.position;
    const look = at ?? new THREE.Vector3(0, 0, 0);
    p.faceTo = Math.atan2(look.x - pos.x, look.z - pos.z);
    if (to && to !== comms.me) {
      const q = this.people.get(to);
      if (q) q.faceTo = Math.atan2(pos.x - q.actor.group.position.x, pos.z - q.actor.group.position.z);
    }
  }

  update(dt: number, t: number, meAt: THREE.Vector3 | null, camera: THREE.Camera) {
    for (const p of this.people.values()) {
      const pos = p.actor.group.position;
      // Wander: now and then a step or two round the home spot.
      p.nextWander -= dt;
      if (p.nextWander <= 0) {
        p.nextWander = 6 + Math.random() * 9;
        if (!p.actor.emoting && Math.random() < 0.6) {
          const a = Math.random() * Math.PI * 2, r = Math.random() * 1.8;
          p.target.set(p.home.x + Math.cos(a) * r, 0, p.home.z + Math.sin(a) * r);
          clampWalk(p.target);
        }
      }
      const dx = p.target.x - pos.x, dz = p.target.z - pos.z;
      const dist = Math.hypot(dx, dz);
      let speed = 0;
      if (dist > 0.08) {
        speed = Math.min(dist > 3 ? 3 : 1.3, dist * 3);
        const step = Math.min(dist, speed * dt);
        pos.x += dx / dist * step; pos.z += dz / dist * step;
        // Personal space: nobody walks through you.
        if (meAt) {
          const mx = pos.x - meAt.x, mz = pos.z - meAt.z, md = Math.hypot(mx, mz);
          if (md < 1 && md > 1e-4) { pos.x = meAt.x + mx / md; pos.z = meAt.z + mz / md; }
        }
        clampWalk(pos);
        p.yaw = turnToward(p.yaw, Math.atan2(dx, dz), dt * 6);
        p.faceTo = null;
      } else if (p.faceTo !== null) p.yaw = turnToward(p.yaw, p.faceTo, dt * 4);
      const prevYaw = p.actor.group.rotation.y;
      p.actor.group.rotation.y = p.yaw;
      p.actor.speed = speed;
      p.actor.turn = (p.yaw - prevYaw) / Math.max(dt, 1e-3);
      // Look at me when I'm close and they're idle.
      if (meAt && !speed) {
        const d = Math.hypot(meAt.x - pos.x, meAt.z - pos.z);
        p.actor.look = d < 4 ? wrap(Math.atan2(meAt.x - pos.x, meAt.z - pos.z) - p.yaw) : null;
      } else p.actor.look = null;
      p.actor.setFar(camera.position.distanceTo(pos) > 30);
      p.actor.update(dt, t);
    }
  }

  dispose() { for (const p of this.people.values()) p.actor.dispose(); this.people.clear(); }
}

export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
export function turnToward(cur: number, want: number, k: number) { return cur + wrap(want - cur) * Math.min(1, k); }

/* ── Phase 2: telling the room where I stopped ─────────────────────────── */

const refused = new Set<string>();
let lastSent = { at: 0, x: NaN, z: NaN };

/** Write my last stop to the deck room (at most every 6 s, only when I moved). A room that refuses
 * (its power levels don't allow the event yet) isn't asked again this visit. */
export async function sendSpot(roomId: string, x: number, z: number, yaw: number) {
  if (!comms.me || refused.has(roomId) || comms.state !== 'live') return;
  const now = Date.now();
  if (now - lastSent.at < 6000 || Math.hypot(x - lastSent.x, z - lastSent.z) < 0.8) return;
  lastSent = { at: now, x, z };
  const body = { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, yaw: Math.round(yaw * 100) / 100, t: now };
  try {
    await comms.api('PUT', `/v3/rooms/${encodeURIComponent(roomId)}/state/${SPOT_TYPE}/${encodeURIComponent(comms.me)}`, { body });
  } catch (e) {
    const code = (e as { errcode?: string; status?: number }).errcode ?? '';
    if (code === 'M_FORBIDDEN' || (e as { status?: number }).status === 403) refused.add(roomId);
  }
}
