/* The plaza's plan, with no DOM and no GPU (tests read it): where the stations stand, what you
 * can't walk through, where you arrive, and where each droid's home spot is. North is -z. */
import * as THREE from 'three';
import { HUBS, type HubId } from '../../data/learn';

export const PLAZA_R = 20;
export const WALK_R = 19.2;

export type StationKind = 'kiosk' | 'warp' | 'notice' | 'academy' | 'lift';
export interface Station {
  id: string;
  kind: StationKind;
  label: string;
  color: string;
  /** Where the object stands. */
  at: THREE.Vector3;
  /** How close a droid must be (to `at`) to use it. */
  reach: number;
  hub?: HubId;
}
export interface Collider { x: number; z: number; r: number }

/** A point on the plaza by compass angle (degrees clockwise from north) and radius. */
export const polar = (deg: number, r: number, y = 0) => {
  const a = THREE.MathUtils.degToRad(deg);
  return new THREE.Vector3(Math.sin(a) * r, y, -Math.cos(a) * r);
};

export const KIOSK_R = 15.6;
export const KIOSK_DEG: Record<HubId, number> = { explore: -55, battle: 55, team: -105, trade: 105, lab: -150, base: 150 };
export const SPAWN = polar(180, 17.4);
export const INSTRUCTOR = polar(171, 11.2);
export const ACADEMY = polar(162, 11.4);
export const NOTICE = polar(0, 12.5);
export const WARP = polar(0, 18.2);

export const STATIONS: Station[] = [
  ...HUBS.map((hb): Station => ({ id: hb.id, kind: 'kiosk', label: hb.label, color: hb.color, at: polar(KIOSK_DEG[hb.id], KIOSK_R), reach: 3.1, hub: hb.id })),
  { id: 'warp', kind: 'warp', label: 'Warp', color: '#79D3F2', at: WARP, reach: 3.4 },
  { id: 'notice', kind: 'notice', label: 'News', color: '#94A4E4', at: NOTICE, reach: 2.8 },
  { id: 'academy', kind: 'academy', label: 'Academy', color: '#F5C518', at: ACADEMY, reach: 2.4 },
  { id: 'lift', kind: 'lift', label: 'Decks', color: '#79D3F2', at: SPAWN, reach: 1.8 },
];

export const COLLIDERS: Collider[] = [
  { x: 0, z: 0, r: 2.75 },
  ...STATIONS.filter((s) => s.kind === 'kiosk').map((s) => ({ x: s.at.x, z: s.at.z, r: 1.55 })),
  { x: ACADEMY.x, z: ACADEMY.z, r: 0.75 },
  { x: INSTRUCTOR.x, z: INSTRUCTOR.z, r: 0.6 },
  { x: NOTICE.x, z: NOTICE.z, r: 0.9 },
  { x: WARP.x - 2.45, z: WARP.z, r: 0.5 }, { x: WARP.x + 2.45, z: WARP.z, r: 0.5 },
];

/** A stable spot on the ring for someone, clear of the stations. */
export function homeSpot(userId: string): THREE.Vector3 {
  let n = 2166136261;
  for (const c of userId) n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0;
  for (let tries = 0; tries < 12; tries++) {
    const a = ((n % 3600) / 3600) * Math.PI * 2;
    const r = 6.5 + ((n >>> 12) % 1000) / 1000 * 6.5;
    const p = new THREE.Vector3(Math.sin(a) * r, 0, -Math.cos(a) * r);
    if (STATIONS.every((s) => s.at.distanceTo(p) > s.reach + 1) && COLLIDERS.every((c) => Math.hypot(c.x - p.x, c.z - p.z) > c.r + 0.8)) return p;
    n = Math.imul(n ^ (n >>> 13), 2654435761) >>> 0;
  }
  return new THREE.Vector3(0, 0, 9);
}

/** Keep a point on the walkable floor: inside the rim, outside every collider. */
export function clampWalk(p: THREE.Vector3, radius = 0.45) {
  const rim = () => { const d = Math.hypot(p.x, p.z); if (d > WALK_R - radius) { const k = (WALK_R - radius) / d; p.x *= k; p.z *= k; } };
  // Twice round: a push out of something by the rim can land past it, and the rim wins last.
  for (let pass = 0; pass < 2; pass++) {
    rim();
    for (const c of COLLIDERS) {
      const dx = p.x - c.x, dz = p.z - c.z, dd = Math.hypot(dx, dz), min = c.r + radius;
      if (dd < min) { if (dd < 1e-4) { p.x += min; continue; } p.x = c.x + dx / dd * min; p.z = c.z + dz / dd * min; }
    }
  }
  rim();
  return p;
}
