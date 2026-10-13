/* The struct recipes: every struct type's hull, designed fresh in the family look (kit.ts).
 * Nose along +x, near side +z; ships run about 2–2.7 units nose to tail, buildings stand on a
 * plinth about 1.7 across. Each one shows what it does: what it fires, where it fights. */
import * as THREE from 'three';
import { Hull, C, paint, ink, type Section } from './kit';
import type { V3 } from '../droid/kit';

type Recipe = (h: Hull) => void;

const P = {
  white: paint(C.white, C.pearl), pearl: paint(C.pearl, C.grey), grey: paint(C.grey, C.slate), slate: paint(C.slate, C.deep),
  deep: paint(C.deep, C.black), black: paint(C.black), orange: paint(C.orange, '#B5611C'), gold: paint(C.gold, '#A87E28'),
  water: paint(C.water, '#1F4C91'), foam: paint(C.foam), ore: paint(C.ore, '#8A6420'), cable: paint(C.cable),
};
const T = ink('trim'), G = ink('glow');

/** Calm water round a ship: a flat ellipse, its edge a little lighter. */
function water(h: Hull, rx: number, rz: number, x = 0, top = 0) {
  if (!h.scenery) return;
  const ell = (k: number): [number, number][] => Array.from({ length: 18 }, (_, i) => {
    const a = (i / 18) * Math.PI * 2;
    return [x + Math.cos(a) * rx * k, Math.sin(a) * rz * k];
  });
  h.slab(ell(1.06), top - 0.05, top - 0.012, P.foam);
  h.slab(ell(1), top - 0.05, top, P.water);
}

/** A strut from b to a (a box whose long axis joins two points), for legs, pylons and braces. */
function strut(h: Hull, a: V3, b: V3, t: number, p: ReturnType<typeof paint>, depth = t) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = A.clone().sub(B), len = d.length();
  const mid = A.clone().add(B).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  const e = new THREE.Euler().setFromQuaternion(q);
  h.box([mid.x, mid.y, mid.z], [t, len, depth], p, { rot: [e.x, e.y, e.z] });
}

/* ── Fleet: space ─────────────────────────────────────────────────────── */

/** 1 · Command Ship "Spearpoint": a spear of a flagship, gold-crested, two outrigger engines and a
 * faction core between them. It fights everywhere, so it carries a little of everything. */
const commandShip: Recipe = (h) => {
  h.loft([
    { x: -1.15, w: 0.3, h: 0.2, hb: 0.16 },
    { x: -0.72, w: 0.42, h: 0.28, hb: 0.2, p: T },
    { x: -0.52, w: 0.44, h: 0.3, hb: 0.2 },
    { x: 0.1, w: 0.36, h: 0.24, hb: 0.16 },
    { x: 0.72, w: 0.17, h: 0.13, hb: 0.1 },
    { x: 1.32, w: 0.015, h: 0.015, hb: 0.015 },
  ], 10, P.white, { round: 2.6 });
  h.slab([[-1.0, -0.2], [0.55, -0.12], [0.55, 0.12], [-1.0, 0.2]], -0.24, -0.14, P.slate);
  h.tube([1.4, 0, 0], 0.025, 0.2, 6, P.gold, 0.004);
  // The bridge, sloping forward, with its window band.
  h.loft([
    { x: -0.62, w: 0.14, h: 0.02, y: 0.27 },
    { x: -0.48, w: 0.17, h: 0.2, y: 0.27 },
    { x: -0.12, w: 0.13, h: 0.15, y: 0.25 },
    { x: 0.08, w: 0.04, h: 0.02, y: 0.22 },
  ], 8, P.pearl, { round: 3 });
  h.lamp([-0.1, 0.39, 0], [0.12, 0.04, 0.2], 'glass', [0, 0, -0.5]);
  h.fin([[-0.7, 0.42], [-0.4, 0.42], [-0.58, 0.82], [-0.74, 0.78]], 0, 0.04, P.gold);
  // Outriggers on swept pylons, each an engine with a missile pod forward.
  h.pair((s) => {
    h.slab([[-0.9, s * 0.25], [-0.45, s * 0.25], [-0.52, s * 0.7], [-0.95, s * 0.7]], -0.03, 0.03, P.pearl, { bevel: 0.015 });
    h.loft([
      { x: -1.05, w: 0.13, h: 0.13, z: s * 0.74 },
      { x: -0.75, w: 0.16, h: 0.16, z: s * 0.74, p: T },
      { x: -0.62, w: 0.16, h: 0.16, z: s * 0.74 },
      { x: -0.2, w: 0.12, h: 0.12, z: s * 0.74 },
      { x: -0.05, w: 0.05, h: 0.05, z: s * 0.74 },
    ], 8, P.white, { round: 2 });
    h.engine([-1.05, 0, s * 0.74], 0.12, 0.12);
    h.tube([-0.12, -0.12, s * 0.74], 0.04, 0.22, 6, P.slate);
    h.tube([0.02, -0.12, s * 0.74], 0.04, 0.06, 6, P.orange, 0.01);
    h.lamp([-0.1, 0.0, s * 0.44], [0.9, 0.02, 0.02], 'cyan');
  });
  h.gem([-1.2, 0.02, 0], 0.13, G);
};

/** 2 · Battleship "Cataclysm": an angular heavy in stepped tiers, a big twin gun forward and a
 * second aft, missile cells, armoured sponsons and three engines. */
const battleship: Recipe = (h) => {
  h.loft([
    { x: -1.3, w: 0.44, h: 0.2, hb: 0.22 },
    { x: -0.9, w: 0.52, h: 0.26, hb: 0.26 },
    { x: 0.5, w: 0.46, h: 0.24, hb: 0.24 },
    { x: 1.1, w: 0.2, h: 0.18, hb: 0.14 },
    { x: 1.4, w: 0.02, h: 0.15, hb: 0.02 },
  ], 8, P.white, { round: 1.8 });
  h.slab([[-1.2, -0.36], [0.62, -0.34], [0.98, 0], [0.62, 0.34], [-1.2, 0.36]], 0.18, 0.3, P.pearl, { bevel: 0.04 });
  h.slab([[-1.15, -0.3], [0.8, -0.2], [0.8, 0.2], [-1.15, 0.3]], -0.3, -0.2, P.deep);
  h.pair((s) => {
    h.box([-0.25, -0.02, s * 0.56], [1.25, 0.26, 0.18], P.grey, { chamfer: 0.04 });
    h.box([-0.25, 0.04, s * 0.655], [1.1, 0.07, 0.02], T);
    for (let i = 0; i < 4; i++) h.lamp([-0.7 + i * 0.3, -0.08, s * 0.655], [0.1, 0.03, 0.02], 'cyan');
    h.stripe(0.305, 0.66, s * 0.3, 0.96, s * 0.03, 0.06);
  });
  // Stepped superstructure: two tiers, the bridge, a mast.
  h.box([-0.42, 0.42, 0], [0.66, 0.24, 0.46], P.white, { chamfer: 0.04, taperTop: 0.86 });
  h.box([-0.48, 0.6, 0], [0.42, 0.16, 0.32], P.white, { chamfer: 0.03, taperTop: 0.8 });
  h.lamp([-0.26, 0.62, 0], [0.04, 0.05, 0.24], 'glass', [0, 0, -0.4]);
  h.box([-0.48, 0.7, 0], [0.24, 0.04, 0.22], T);
  h.cyl([-0.56, 0.9, 0], 0.012, 0.025, 0.36, 4, P.slate);
  h.box([-0.56, 0.98, 0], [0.03, 0.03, 0.24], P.slate);
  h.lamp([-0.56, 1.08, 0], [0.04, 0.04, 0.04], 'red');
  // The guns: the big pair forward, a smaller pair aft.
  const turret = (x: number, scale: number, dir: 1 | -1) => {
    h.cyl([x, 0.36, 0], 0.24 * scale, 0.27 * scale, 0.1, 10, P.grey);
    h.box([x + dir * 0.04, 0.46, 0], [0.4 * scale, 0.15 * scale, 0.36 * scale], P.pearl, { chamfer: 0.04, taperTop: 0.82 });
    h.pair((s) => {
      h.tube([x + dir * (0.18 + 0.4 * scale), 0.47, s * 0.085 * scale], 0.042 * scale, 0.8 * scale, 6, P.slate);
      h.tube([x + dir * (0.22 + 0.8 * scale), 0.47, s * 0.085 * scale], 0.058 * scale, 0.08, 6, P.orange);
    });
  };
  turret(0.42, 1, 1);
  turret(-1.0, 0.7, -1);
  h.box([0.08, 0.33, 0], [0.24, 0.06, 0.3], P.deep, { chamfer: 0.015 });
  for (const x of [0.02, 0.14]) for (const z of [-0.07, 0.07]) h.box([x, 0.365, z], [0.07, 0.01, 0.08], P.orange);
  for (const z of [-0.28, 0, 0.28]) h.engine([-1.28, 0, z], 0.15, 0.16);
};

/** 3 · Starfighter "Gambit": a cockpit pod on forward-swept wings between two engine booms, made for
 * the attack run. */
const starfighter: Recipe = (h) => {
  h.loft([
    { x: -0.6, w: 0.14, h: 0.14 },
    { x: -0.3, w: 0.2, h: 0.2, p: T },
    { x: -0.18, w: 0.2, h: 0.2 },
    { x: 0.25, w: 0.16, h: 0.15 },
    { x: 0.72, w: 0.025, h: 0.025 },
  ], 10, P.white, { round: 2.4 });
  h.pod([0.2, 0.13, 0], 0.5, 0.1, 0.08, 8, ink('glass'));
  h.engine([-0.6, 0, 0], 0.1, 0.1);
  h.pair((s) => {
    h.slab([[-0.32, s * 0.14], [0.06, s * 0.14], [0.26, s * 0.62], [0.0, s * 0.62]], -0.025, 0.035, P.pearl, { bevel: 0.015 });
    h.loft([
      { x: -0.55, w: 0.075, h: 0.075, z: s * 0.66 },
      { x: -0.2, w: 0.09, h: 0.09, z: s * 0.66 },
      { x: 0.32, w: 0.08, h: 0.08, z: s * 0.66, p: T },
      { x: 0.46, w: 0.06, h: 0.06, z: s * 0.66 },
      { x: 0.6, w: 0.01, h: 0.01, z: s * 0.66 },
    ], 8, P.white, { round: 2 });
    h.engine([-0.55, 0, s * 0.66], 0.075, 0.08);
    h.tube([0.05, -0.07, s * 0.4], 0.028, 0.34, 6, P.slate);
    h.tube([0.24, -0.07, s * 0.4], 0.028, 0.05, 6, P.orange, 0.006);
  });
};

/** 4 · Frigate "Skylight": an escort under a big sensor dome, missile pods either side and a keel
 * fin, watching space and the sky. */
const frigate: Recipe = (h) => {
  h.loft([
    { x: -1.0, w: 0.3, h: 0.22, hb: 0.18 },
    { x: -0.62, w: 0.36, h: 0.26, hb: 0.2, p: T },
    { x: -0.46, w: 0.36, h: 0.26, hb: 0.2 },
    { x: 0.3, w: 0.3, h: 0.22, hb: 0.16 },
    { x: 0.85, w: 0.14, h: 0.12, hb: 0.1 },
    { x: 1.12, w: 0.02, h: 0.02, hb: 0.02 },
  ], 10, P.white, { round: 2.6 });
  h.cyl([-0.08, 0.27, 0], 0.22, 0.25, 0.06, 10, P.pearl);
  h.dome([-0.08, 0.3, 0], 0.2, 0.17, 10, P.pearl, 3, [ink('glass'), P.pearl, P.pearl]);
  h.gem([-0.08, 0.47, 0], 0.035, ink('cyan'));
  h.ring(5, (a) => h.lamp([-0.08 + Math.cos(a) * 0.235, 0.27, Math.sin(a) * 0.235], [0.04, 0.03, 0.04], 'cyan'));
  h.fin([[-0.72, -0.16], [0.08, -0.16], [-0.22, -0.42], [-0.62, -0.42]], 0, 0.05, P.slate);
  h.fin([[-0.95, 0.18], [-0.6, 0.18], [-0.82, 0.48], [-0.98, 0.46]], 0, 0.04, P.pearl);
  h.pair((s) => {
    h.box([0.1, 0.0, s * 0.42], [0.62, 0.16, 0.16], P.pearl, { chamfer: 0.04 });
    h.box([0.1, 0.085, s * 0.42], [0.5, 0.02, 0.1], T);
    for (const y of [-0.04, 0.04]) h.box([0.42, y, s * 0.42], [0.03, 0.05, 0.06], P.orange);
    h.engine([-1.0, -0.02, s * 0.15], 0.11, 0.12);
  });
};

/* ── Fleet: air ───────────────────────────────────────────────────────── */

/** 5 · Pursuit Fighter "Squall": a delta-winged dogfighter with canards, a bubble canopy and twin
 * canted fins. */
const pursuitFighter: Recipe = (h) => {
  h.loft([
    { x: -0.95, w: 0.11, h: 0.11 },
    { x: -0.5, w: 0.16, h: 0.15, hb: 0.12 },
    { x: 0.2, w: 0.14, h: 0.13, hb: 0.1 },
    { x: 0.7, w: 0.07, h: 0.07, hb: 0.06 },
    { x: 1.05, w: 0.01, h: 0.01, hb: 0.01 },
  ], 10, P.white, { round: 2.4 });
  h.pod([0.3, 0.11, 0], 0.55, 0.085, 0.085, 8, ink('glass'));
  h.pair((s) => {
    h.box([-0.1, -0.04, s * 0.15], [0.5, 0.12, 0.08], P.slate, { chamfer: 0.02 });
    h.slab([[0.15, s * 0.12], [-0.6, s * 0.78], [-0.75, s * 0.78], [-0.75, s * 0.12]], -0.02, 0.03, P.pearl, { bevel: 0.012 });
    h.slab([[-0.42, s * 0.56], [-0.6, s * 0.78], [-0.75, s * 0.78], [-0.75, s * 0.56]], 0.03, 0.045, T);
    h.slab([[0.58, s * 0.07], [0.42, s * 0.26], [0.32, s * 0.26], [0.34, s * 0.07]], 0.0, 0.03, P.white);
    h.fin([[-0.88, 0.06], [-0.5, 0.06], [-0.76, 0.42], [-0.9, 0.42]], s * 0.1, 0.03, P.white, [s * 0.32, 0, 0]);
    h.tube([-0.32, -0.07, s * 0.45], 0.034, 0.38, 6, P.slate);
    h.tube([-0.1, -0.07, s * 0.45], 0.034, 0.06, 6, P.orange, 0.005);
    h.engine([-0.95, 0, s * 0.07], 0.07, 0.08);
  });
};

/** 6 · Stealth Bomber "Rolling Thunder": a dark flying wing, its leading edges in faction colour,
 * nav lights on the tips and ordnance slung low. */
const stealthBomber: Recipe = (h) => {
  h.pair((s) => {
    h.slab([[0.82, 0], [0.02, s * 0.95], [-0.42, s * 0.95], [-0.32, 0]], -0.05, 0.05, P.slate, { bevel: 0.03 });
    h.stripe(0.052, 0.76, s * 0.05, 0.06, s * 0.88, 0.06);
    h.lamp([-0.2, 0.0, s * 0.95], [0.08, 0.04, 0.03], s > 0 ? 'green' : 'red');
    h.tube([0.0, -0.09, s * 0.4], 0.05, 0.42, 6, P.deep);
    h.tube([0.24, -0.09, s * 0.4], 0.05, 0.07, 6, P.orange, 0.01);
    h.lamp([-0.5, 0.03, s * 0.1], [0.02, 0.05, 0.12], 'cyan');
  });
  h.loft([
    { x: -0.5, w: 0.22, h: 0.1, hb: 0.06 },
    { x: 0.0, w: 0.3, h: 0.16, hb: 0.08 },
    { x: 0.5, w: 0.16, h: 0.1, hb: 0.06 },
    { x: 0.86, w: 0.015, h: 0.015, hb: 0.015 },
  ], 10, P.white, { round: 2.2 });
  h.lamp([0.42, 0.11, 0], [0.18, 0.025, 0.16], 'glass', [0, 0, -0.3]);
  h.box([-0.1, 0.17, 0], [0.4, 0.02, 0.14], T, { chamfer: 0.005 });
};

/** 7 · High Altitude Interceptor "Skimmer": a needle with long straight wings and two big engine
 * nacelles, built to climb into space. */
const interceptor: Recipe = (h) => {
  h.loft([
    { x: -0.9, w: 0.1, h: 0.1 },
    { x: -0.3, w: 0.13, h: 0.12 },
    { x: 0.4, w: 0.1, h: 0.09 },
    { x: 1.2, w: 0.008, h: 0.008 },
  ], 10, P.white, { round: 2.2 });
  h.pod([0.36, 0.075, 0], 0.42, 0.06, 0.06, 8, ink('glass'));
  h.fin([[-0.9, 0.07], [-0.55, 0.07], [-0.8, 0.46], [-0.93, 0.46]], 0, 0.03, P.white);
  h.fin([[-0.82, 0.38], [-0.93, 0.38], [-0.93, 0.46], [-0.8, 0.46]], 0, 0.035, T);
  h.pair((s) => {
    h.slab([[-0.05, s * 0.1], [-0.25, s * 1.05], [-0.42, s * 1.05], [-0.36, s * 0.1]], -0.01, 0.03, P.pearl, { bevel: 0.012 });
    h.slab([[-0.21, s * 0.88], [-0.25, s * 1.05], [-0.42, s * 1.05], [-0.39, s * 0.88]], 0.03, 0.045, T);
    h.loft([
      { x: -0.58, w: 0.08, h: 0.08, z: s * 0.42 },
      { x: -0.2, w: 0.1, h: 0.1, z: s * 0.42 },
      { x: 0.12, w: 0.09, h: 0.09, z: s * 0.42, p: P.slate },
      { x: 0.16, w: 0.09, h: 0.09, z: s * 0.42 },
    ], 8, P.white, { round: 2 });
    h.tube([0.17, 0, s * 0.42], 0.06, 0.02, 8, ink('orange'));
    h.engine([-0.58, 0, s * 0.42], 0.08, 0.1);
  });
};

/* ── Fleet: land ──────────────────────────────────────────────────────── */

/** 8 · Mobile Artillery "Archer": a four-legged walker with a long gun laid along its back. */
const mobileArtillery: Recipe = (h) => {
  h.loft([
    { x: -0.48, w: 0.28, h: 0.16, y: 0.76 },
    { x: -0.2, w: 0.36, h: 0.24, y: 0.76, p: T },
    { x: -0.06, w: 0.36, h: 0.24, y: 0.76 },
    { x: 0.28, w: 0.3, h: 0.2, y: 0.76 },
    { x: 0.48, w: 0.18, h: 0.11, y: 0.74 },
  ], 10, P.white, { round: 3 });
  h.lamp([0.49, 0.76, 0], [0.02, 0.05, 0.18], 'cyan');
  for (const sx of [-0.3, 0.28]) h.pair((s) => {
    const hip: V3 = [sx, 0.7, s * 0.3], knee: V3 = [sx + 0.08 * Math.sign(sx), 0.5, s * 0.58], foot: V3 = [sx + 0.12 * Math.sign(sx), 0.06, s * 0.64];
    h.cyl(hip, 0.08, 0.08, 0.12, 8, P.slate, [Math.PI / 2, 0, 0]);
    strut(h, knee, hip, 0.11, P.pearl, 0.1);
    h.gem(knee, 0.07, P.slate);
    strut(h, foot, knee, 0.09, P.slate, 0.09);
    h.box([foot[0], 0.035, foot[2]], [0.24, 0.07, 0.18], P.deep, { chamfer: 0.02 });
  });
  // The gun: a long barrel raised a little, an orange brake at its mouth.
  h.box([0.0, 0.99, 0], [0.42, 0.16, 0.3], P.grey, { chamfer: 0.04 });
  const tilt = 0.26, dir = new THREE.Vector3(Math.cos(tilt), Math.sin(tilt), 0);
  const mid = new THREE.Vector3(0.6, 1.08, 0);
  h.cyl([mid.x, mid.y, 0], 0.055, 0.075, 1.25, 8, P.slate, [0, 0, -Math.PI / 2 + tilt]);
  const end = mid.clone().addScaledVector(dir, 0.66);
  h.cyl([end.x, end.y, 0], 0.08, 0.08, 0.14, 8, P.orange, [0, 0, -Math.PI / 2 + tilt]);
  const sleeve = mid.clone().addScaledVector(dir, -0.4);
  h.cyl([sleeve.x, sleeve.y, 0], 0.1, 0.1, 0.24, 8, P.white, [0, 0, -Math.PI / 2 + tilt]);
};

/** 9 · Tank "Breakaway": a hover tank on a glowing skirt, one big gun in a low turret. */
const tank: Recipe = (h) => {
  const plan: [number, number][] = [[0.86, -0.3], [0.86, 0.3], [0.62, 0.5], [-0.76, 0.5], [-0.86, 0.36], [-0.86, -0.36], [-0.76, -0.5], [0.62, -0.5]];
  const inset = (k: number) => plan.map(([x, z]) => [x * k, z * k] as [number, number]);
  h.slab(inset(0.9), 0.04, 0.12, ink('cyan'));
  h.slab(inset(0.97), 0.1, 0.16, P.deep);
  h.slab(plan, 0.14, 0.42, P.white, { bevel: 0.08, taperBottom: 0.86 });
  h.pair((s) => h.stripe(0.425, -0.62, s * 0.36, 0.5, s * 0.36, 0.07));
  h.box([0.73, 0.33, 0], [0.3, 0.04, 0.7], P.pearl, { rot: [0, 0, -0.5] });
  h.pair((s) => h.lamp([-0.87, 0.3, s * 0.2], [0.02, 0.08, 0.16], 'cyan'));
  h.loft([
    { x: -0.46, w: 0.3, h: 0.13, hb: 0.03, y: 0.5 },
    { x: -0.2, w: 0.35, h: 0.17, hb: 0.03, y: 0.5 },
    { x: 0.24, w: 0.28, h: 0.13, hb: 0.03, y: 0.5 },
    { x: 0.38, w: 0.18, h: 0.08, hb: 0.03, y: 0.5 },
  ], 10, P.grey, { round: 3 });
  h.lamp([0.37, 0.57, 0.1], [0.02, 0.04, 0.08], 'cyan');
  h.tube([0.45, 0.57, 0], 0.09, 0.16, 8, P.white);
  h.tube([0.86, 0.57, 0], 0.055, 0.7, 8, P.slate);
  h.tube([1.26, 0.57, 0], 0.075, 0.12, 8, P.orange);
  h.cyl([-0.22, 0.69, -0.12], 0.08, 0.09, 0.05, 8, P.slate);
};

/** 10 · SAM Launcher "Longshot": a six-wheeled carrier, its missile box raised at the sky and a
 * tracking dish behind the cab. */
const samLauncher: Recipe = (h) => {
  h.box([-0.05, 0.3, 0], [1.6, 0.18, 0.62], P.slate, { chamfer: 0.05 });
  h.pair((s) => {
    for (const x of [-0.55, -0.05, 0.5]) {
      h.wheel([x, 0.17, s * 0.36], 0.17, 0.14, 10, P.black);
      h.wheel([x, 0.17, s * 0.44], 0.075, 0.03, 8, P.pearl);
    }
    h.box([-0.05, 0.36, s * 0.315], [1.4, 0.05, 0.02], T);
  });
  h.box([0.58, 0.55, 0], [0.42, 0.34, 0.6], P.white, { chamfer: 0.06, taperTop: 0.8 });
  h.lamp([0.78, 0.6, 0], [0.04, 0.1, 0.44], 'glass', [0, 0, 0.2]);
  h.pair((s) => h.lamp([0.8, 0.42, s * 0.24], [0.02, 0.04, 0.08], 'amber'));
  // The launcher, raised 20°.
  const r = 0.35, c = new THREE.Vector3(-0.32, 0.74, 0);
  h.box([c.x, c.y, 0], [0.88, 0.36, 0.56], P.white, { chamfer: 0.05, rot: [0, 0, r] });
  h.pair((s) => h.box([c.x, c.y, s * 0.285], [0.76, 0.08, 0.02], T, { rot: [0, 0, r] }));
  const fx = Math.cos(r) * 0.445, fy = Math.sin(r) * 0.445;
  for (const ly of [-0.08, 0.08]) for (const z of [-0.17, 0, 0.17]) {
    h.box([c.x + fx - Math.sin(r) * ly, c.y + fy + Math.cos(r) * ly, z], [0.03, 0.12, 0.12], P.orange, { rot: [0, 0, r] });
  }
  h.box([-0.32, 0.47, 0], [0.3, 0.12, 0.3], P.deep);
  h.cyl([0.3, 0.86, 0], 0.025, 0.025, 0.28, 6, P.slate);
  h.cyl([0.3, 1.02, 0], 0.22, 0.05, 0.08, 10, P.pearl, [0, 0, 0.5]);
  h.lamp([0.33, 1.06, 0], [0.04, 0.04, 0.04], 'red');
};

/* ── Fleet: water ─────────────────────────────────────────────────────── */

/** 11 · Cruiser "Hydra": a trimaran with three gun heads and glowing outrigger keels. */
const cruiser: Recipe = (h) => {
  water(h, 1.55, 0.85, -0.05);
  h.loft([
    { x: -1.25, w: 0.3, h: 0.24, hb: 0.12, y: 0.12 },
    { x: -0.6, w: 0.36, h: 0.25, hb: 0.13, y: 0.12 },
    { x: 0.5, w: 0.3, h: 0.22, hb: 0.12, y: 0.12 },
    { x: 1.1, w: 0.1, h: 0.18, hb: 0.06, y: 0.12 },
    { x: 1.38, w: 0.01, h: 0.15, hb: 0.01, y: 0.12 },
  ], 10, P.white, { round: 3 });
  h.pair((s) => {
    h.pod([-0.2, 0.05, s * 0.64], 1.45, 0.1, 0.07, 8, P.pearl);
    h.box([-0.2, 0.012, s * 0.64], [1.2, 0.02, 0.17], G);
    h.box([-0.2, 0.15, s * 0.4], [0.5, 0.05, 0.42], P.slate, { chamfer: 0.015 });
    h.stripe(0.37, -1.05, s * 0.26, 0.45, s * 0.24, 0.05);
  });
  h.box([-0.35, 0.5, 0], [0.7, 0.26, 0.42], P.pearl, { chamfer: 0.05, taperTop: 0.85 });
  h.pair((s) => h.lamp([-0.35, 0.54, s * 0.205], [0.56, 0.05, 0.01], 'glass'));
  h.box([-0.25, 0.7, 0], [0.32, 0.14, 0.3], P.white, { chamfer: 0.03 });
  h.lamp([-0.085, 0.71, 0], [0.01, 0.05, 0.22], 'glass');
  h.cyl([-0.4, 0.92, 0], 0.015, 0.03, 0.4, 4, P.slate);
  h.box([-0.4, 1.06, 0], [0.04, 0.03, 0.22], P.slate);
  // Three heads.
  for (const [x, y] of [[0.62, 0.38], [0.3, 0.45], [-0.95, 0.4]] as [number, number][]) {
    h.cyl([x, y, 0], 0.12, 0.14, 0.08, 8, P.grey);
    h.box([x + 0.03, y + 0.07, 0], [0.18, 0.08, 0.16], P.white, { chamfer: 0.02 });
    const dir = x < 0 ? -1 : 1;
    h.pair((s) => {
      h.tube([x + dir * 0.24, y + 0.08, s * 0.045], 0.022, 0.3, 6, P.slate);
      h.tube([x + dir * 0.4, y + 0.08, s * 0.045], 0.03, 0.04, 6, P.orange);
    });
  }
};

/** 12 · Destroyer "Kraken": a low, faceted wave-piercer with a glowing waterline, a missile block
 * forward and torpedo tubes aft. */
const destroyer: Recipe = (h) => {
  water(h, 1.5, 0.62, 0);
  h.loft([
    { x: -1.2, w: 0.26, h: 0.18, hb: 0.08, y: 0.1 },
    { x: -0.4, w: 0.32, h: 0.2, hb: 0.1, y: 0.1 },
    { x: 0.6, w: 0.24, h: 0.16, hb: 0.08, y: 0.1 },
    { x: 1.32, w: 0.01, h: 0.14, hb: 0.02, y: 0.1 },
  ], 8, P.white, { round: 1.6 });
  h.pair((s) => {
    h.box([-0.6, 0.03, s * 0.29], [1.0, 0.025, 0.03], G, { rot: [0, s * 0.02, 0] });
    h.box([0.55, 0.03, s * 0.2], [0.9, 0.025, 0.03], G, { rot: [0, s * 0.17, 0] });
    h.tube([-0.85, 0.27, s * 0.15], 0.04, 0.3, 6, P.slate);
  });
  h.box([0.95, 0.24, 0], [0.12, 0.02, 0.2], T);
  h.box([-0.2, 0.42, 0], [0.75, 0.26, 0.36], P.pearl, { chamfer: 0.03, taperTop: 0.55, taperDepth: true });
  h.lamp([0.07, 0.47, 0], [0.04, 0.05, 0.2], 'glass', [0, 0, -0.5]);
  h.box([-0.2, 0.58, 0], [0.24, 0.05, 0.16], T);
  h.cyl([-0.22, 0.78, 0], 0.015, 0.06, 0.36, 4, P.slate);
  h.lamp([-0.22, 0.97, 0], [0.04, 0.04, 0.04], 'red');
  h.box([0.55, 0.31, 0], [0.32, 0.07, 0.24], P.deep, { chamfer: 0.015 });
  for (const x of [0.46, 0.55, 0.64]) for (const z of [-0.06, 0.06]) h.box([x, 0.348, z], [0.06, 0.01, 0.07], P.orange);
};

/** 13 · Submersible "Leviathan": a dark manta riding just under the surface, its sail and faction
 * eyes showing; it fires missiles up from below. */
const submersible: Recipe = (h) => {
  h.loft([
    { x: -0.95, w: 0.18, h: 0.07, hb: 0.06 },
    { x: -0.4, w: 0.6, h: 0.13, hb: 0.1 },
    { x: 0.3, w: 0.48, h: 0.15, hb: 0.1 },
    { x: 0.8, w: 0.13, h: 0.09, hb: 0.06 },
    { x: 1.02, w: 0.02, h: 0.04, hb: 0.03 },
  ], 10, P.grey, { round: 2 });
  water(h, 1.4, 0.8, 0, 0.0);
  h.pair((s) => h.stripe(0.1, -0.6, s * 0.2, 0.55, s * 0.12, 0.04, 'glow'));
  h.fin([[-0.42, 0.08], [0.1, 0.08], [-0.02, 0.5], [-0.34, 0.5]], 0, 0.15, P.white);
  h.fin([[-0.33, 0.38], [-0.03, 0.38], [-0.02, 0.45], [-0.34, 0.45]], 0, 0.155, T);
  h.lamp([0.0, 0.42, 0], [0.04, 0.04, 0.12], 'glass');
  h.pair((s) => h.lamp([0.72, 0.07, s * 0.1], [0.06, 0.03, 0.05], 'glow'));
  h.cyl([-0.2, 0.6, 0], 0.012, 0.012, 0.22, 4, P.slate);
  h.lamp([-0.2, 0.72, 0], [0.04, 0.03, 0.04], 'orange');
  h.pair((s) => h.box([-0.65, 0.04, s * 0.32], [0.3, 0.02, 0.05], G, { rot: [0, s * 0.3, 0] }));
};

/* ── Planet ───────────────────────────────────────────────────────────── */

/** 14 · Ore Extractor "Lasersword": a derrick over the ore pit, its laser drill burning down. */
const extractor: Recipe = (h) => {
  const top = h.plinth(0.88);
  h.cyl([0, top + 0.012, 0], 0.34, 0.34, 0.024, 10, ink('amber'));
  h.cyl([0, top + 0.03, 0], 0.4, 0.42, 0.04, 10, P.deep);
  h.ring(3, (a) => strut(h, [Math.cos(a) * 0.1, 1.38, Math.sin(a) * 0.1], [Math.cos(a) * 0.66, top, Math.sin(a) * 0.66], 0.08, P.white, 0.08), Math.PI / 6);
  h.ring(3, (a) => h.box([Math.cos(a) * 0.62, top + 0.06, Math.sin(a) * 0.62], [0.16, 0.12, 0.16], P.slate, { chamfer: 0.02 }), Math.PI / 6);
  h.box([0, 1.36, 0], [0.32, 0.24, 0.32], P.white, { chamfer: 0.05 });
  h.box([0, 1.36, 0], [0.33, 0.06, 0.33], T);
  h.cyl([0, 1.18, 0], 0.07, 0.1, 0.14, 8, P.slate);
  h.cyl([0, 0.7, 0], 0.035, 0.035, 0.85, 8, ink('orange'));
  h.cyl([0, 0.7, 0], 0.07, 0.07, 0.85, 8, ink('amber'));
  h.box([0.48, top + 0.2, 0.32], [0.3, 0.32, 0.3], P.pearl, { chamfer: 0.03, taperBottom: 0.7 });
  for (const [x, z] of [[0.43, 0.27], [0.53, 0.36], [0.47, 0.4]] as [number, number][]) h.gem([x, top + 0.38, z], 0.06, P.ore);
};

/** 15 · Ore Refinery "Greybox": a grey works between two Alpha tanks, a violet stack above. */
const refinery: Recipe = (h) => {
  const top = h.plinth(0.92);
  h.box([-0.15, top + 0.3, 0], [0.78, 0.6, 0.72], P.grey, { chamfer: 0.04 });
  h.box([-0.15, top + 0.62, 0], [0.84, 0.06, 0.78], P.white, { chamfer: 0.02 });
  h.box([-0.15, top + 0.48, 0.365], [0.6, 0.06, 0.02], T);
  for (const x of [-0.38, -0.15, 0.08]) h.lamp([x, top + 0.3, 0.365], [0.12, 0.14, 0.02], 'amber');
  h.pair((s) => {
    const at: V3 = [0.45, top, s * 0.34];
    h.lathe(at, [[0.22, 0], [0.22, 0.2], [0.22, 0.3], [0.22, 0.46], [0.17, 0.56], [0.08, 0.61], [0, 0.62]], 10, P.white,
      [P.pearl, ink('violet'), P.white, P.white, P.white, P.white]);
    h.tube([0.18, top + 0.36, s * 0.2], 0.04, 0.22, 6, P.slate);
  });
  h.cyl([-0.4, top + 0.95, -0.2], 0.08, 0.1, 0.6, 8, P.slate);
  h.cyl([-0.4, top + 1.26, -0.2], 0.09, 0.09, 0.03, 8, ink('violet'));
};

/** 16 · Orbital Shield Generator "Shieldwall": a station in orbit, its faction core held in a ring
 * with emitter spires above and below. */
const orbitalShield: Recipe = (h) => {
  const y = 0.75;
  h.gem([0, y, 0], 0.24, G);
  h.ring(4, (a) => h.box([Math.cos(a) * 0.3, y, Math.sin(a) * 0.3], [0.08, 0.36, 0.2], P.white, { chamfer: 0.02, rot: [0, -a, 0] }), Math.PI / 4);
  h.torus([0, y, 0], 0.78, 0.07, 24, 6, P.white, [0.18, 0, 0.12]);
  h.torus([0, y, 0], 0.85, 0.03, 24, 4, T, [0.18, 0, 0.12]);
  h.ring(4, (a) => strut(h, [Math.cos(a) * 0.34, y, Math.sin(a) * 0.34], [Math.cos(a) * 0.74, y + Math.sin(a) * 0.1, Math.sin(a) * 0.74], 0.05, P.slate), Math.PI / 4);
  for (const s of [1, -1]) {
    h.cyl([0, y + s * 0.38, 0], s > 0 ? 0.03 : 0.12, s > 0 ? 0.12 : 0.03, 0.34, 6, P.pearl);
    h.gem([0, y + s * 0.58, 0], 0.05, ink('cyan'));
  }
};

/** 17 · Jamming Satellite "Observer": a body on two solar wings, a dish on top and three violet
 * emitters jamming anything aimed at the planet. */
const jammingSat: Recipe = (h) => {
  const y = 0.72;
  h.box([0, y, 0], [0.42, 0.44, 0.42], P.white, { chamfer: 0.05 });
  h.box([0, y + 0.05, 0], [0.43, 0.07, 0.43], T);
  h.lamp([0.215, y - 0.08, 0], [0.01, 0.06, 0.18], 'cyan');
  h.pair((s) => {
    h.box([0, y, s * 0.3], [0.05, 0.05, 0.2], P.slate);
    h.box([0, y, s * 0.75], [0.52, 0.03, 0.72], ink('glass'));
    h.box([0, y, s * 0.75], [0.56, 0.02, 0.76], P.slate);
    for (const z of [0.55, 0.75, 0.95]) h.box([0, y + 0.017, s * z], [0.52, 0.005, 0.01], P.slate);
  });
  h.cyl([0, y + 0.3, 0], 0.03, 0.03, 0.18, 6, P.slate);
  h.cyl([0.04, y + 0.42, 0], 0.32, 0.06, 0.1, 12, P.pearl, [0, 0, -0.35]);
  h.cyl([0.12, y + 0.56, 0], 0.012, 0.012, 0.22, 4, P.slate, [0, 0, -0.35]);
  h.gem([0.16, y + 0.67, 0], 0.035, ink('magenta'));
  h.ring(3, (a) => {
    strut(h, [Math.cos(a) * 0.32, y - 0.45, Math.sin(a) * 0.32], [Math.cos(a) * 0.12, y - 0.22, Math.sin(a) * 0.12], 0.04, P.slate);
    h.gem([Math.cos(a) * 0.34, y - 0.48, Math.sin(a) * 0.34], 0.05, ink('violet'));
  });
};

/** 18 · Ore Bunker "Hardshell": a ribbed armoured dome over the ore, a blast door facing out. */
const oreBunker: Recipe = (h) => {
  const top = h.plinth(0.92, 0.18);
  h.dome([0, top, 0], 0.76, 0.52, 12, P.white, 4, [P.pearl, T, P.white, P.white]);
  h.ring(6, (a) => {
    const r = 0.62, tilt = 0.75;
    h.box([Math.cos(a) * r, top + 0.26, Math.sin(a) * r], [0.09, 0.5, 0.1], P.slate, { rot: [0, -a, tilt] });
  }, 0);
  const da = -0.62;
  h.box([Math.cos(da) * 0.66, top + 0.2, -Math.sin(da) * 0.66], [0.16, 0.38, 0.4], P.slate, { chamfer: 0.03, rot: [0, da, 0] });
  h.box([Math.cos(da) * 0.75, top + 0.2, -Math.sin(da) * 0.75], [0.02, 0.28, 0.06], ink('amber'), { rot: [0, da, 0] });
  h.cyl([0, top + 0.53, 0], 0.16, 0.2, 0.06, 8, P.slate);
  h.lamp([0, top + 0.59, 0], [0.06, 0.04, 0.06], 'red');
};

/** 19 · Planetary Defense Cannon "Lookout": a turret on a drum, two long barrels laid on the sky. */
const pdc: Recipe = (h) => {
  const top = h.plinth(0.86);
  h.lathe([0, top, 0], [[0.52, 0], [0.55, 0.14], [0.5, 0.36], [0.42, 0.42]], 10, P.white, [P.pearl, T, P.white]);
  const y = top + 0.56;
  h.box([0, y, 0], [0.62, 0.3, 0.52], P.white, { chamfer: 0.07, taperTop: 0.8 });
  h.pair((s) => h.box([-0.05, y, s * 0.27], [0.5, 0.22, 0.04], P.slate, { chamfer: 0.015 }));
  h.lamp([0.28, y + 0.04, 0], [0.04, 0.05, 0.22], 'cyan', [0, 0, -0.4]);
  const tilt = 0.45, dir = new THREE.Vector3(Math.cos(tilt), Math.sin(tilt), 0);
  h.pair((s) => {
    const m = new THREE.Vector3(0.55, y + 0.22, s * 0.12);
    h.cyl([m.x, m.y, m.z], 0.04, 0.055, 0.9, 8, P.slate, [0, 0, -Math.PI / 2 + tilt]);
    const e = m.clone().addScaledVector(dir, 0.48);
    h.cyl([e.x, e.y, e.z], 0.065, 0.065, 0.1, 8, P.orange, [0, 0, -Math.PI / 2 + tilt]);
    const b = m.clone().addScaledVector(dir, -0.3);
    h.cyl([b.x, b.y, b.z], 0.08, 0.08, 0.2, 8, P.grey, [0, 0, -Math.PI / 2 + tilt]);
  });
  h.cyl([-0.22, y + 0.3, -0.12], 0.012, 0.012, 0.3, 4, P.slate);
  h.lamp([-0.22, y + 0.46, -0.12], [0.04, 0.04, 0.04], 'red');
};

/** 20 · Field Generator "Magenta": a magenta crystal hung between three pylons, haloed, burning
 * Alpha Matter for power. */
const fieldGenerator: Recipe = (h) => {
  const top = h.plinth(0.86);
  h.lathe([0, top, 0], [[0.5, 0], [0.46, 0.12], [0.38, 0.16]], 10, P.pearl);
  h.cyl([0, top + 0.17, 0], 0.3, 0.3, 0.02, 10, ink('violet'));
  h.ring(3, (a) => {
    h.box([Math.cos(a) * 0.44, top + 0.62, Math.sin(a) * 0.44], [0.1, 1.0, 0.16], P.white, { chamfer: 0.03, rot: [0, -a, 0] });
    h.box([Math.cos(a) * 0.495, top + 0.62, Math.sin(a) * 0.495], [0.01, 0.8, 0.06], T, { rot: [0, -a, 0] });
    h.box([Math.cos(a) * 0.385, top + 0.62, Math.sin(a) * 0.385], [0.01, 0.7, 0.04], ink('violet'), { rot: [0, -a, 0] });
  }, Math.PI / 6);
  const cy = top + 0.62;
  h.cyl([0, cy + 0.14, 0], 0, 0.17, 0.32, 4, ink('magenta'));
  h.cyl([0, cy - 0.1, 0], 0.17, 0, 0.18, 4, ink('magenta'));
  h.torus([0, cy, 0], 0.27, 0.018, 18, 4, ink('magenta'), [0.35, 0, 0.2]);
  h.torus([0, cy + 0.05, 0], 0.3, 0.015, 18, 4, ink('violet'), [-0.3, 0, -0.25]);
  h.lathe([0, top + 1.12, 0], [[0.5, 0], [0.54, 0.06], [0.42, 0.16], [0.16, 0.21], [0, 0.22]], 10, P.white, [P.white, P.white, P.pearl, P.pearl]);
  h.gem([0, top + 1.37, 0], 0.05, ink('cyan'));
};

/** 21 · Continental Power Plant "Homestead": two cooling towers breathing violet and a reactor dome. */
const powerPlant: Recipe = (h) => {
  const top = h.plinth(1.0);
  for (const [x, z, k] of [[-0.42, -0.28, 1], [0.05, -0.48, 0.85]] as [number, number, number][]) {
    h.lathe([x, top, z], [[0.3 * k, 0], [0.24 * k, 0.3], [0.2 * k, 0.55 * k + 0.1], [0.24 * k, 0.8 * k + 0.1]], 12, P.white, [T, P.white, P.white]);
    h.cyl([x, top + 0.8 * k + 0.09, z], 0.2 * k, 0.2 * k, 0.02, 12, ink('violet'));
  }
  h.dome([0.32, top, 0.28], 0.42, 0.4, 12, P.white, 4, [P.pearl, ink('violet'), P.white, P.white]);
  h.cyl([0.32, top + 0.42, 0.28], 0.08, 0.1, 0.06, 8, P.slate);
  h.box([-0.2, top + 0.15, 0.25], [0.5, 0.3, 0.3], P.grey, { chamfer: 0.03 });
  h.box([-0.2, top + 0.24, 0.405], [0.4, 0.05, 0.02], T);
  h.tube([-0.06, top + 0.22, 0.0], 0.04, 0.4, 6, P.slate);
};

/** 22 · World Engine "Constellation": a violet star held up by three great pylons, ringed, with
 * small lights in orbit round it. */
const worldEngine: Recipe = (h) => {
  const top = h.plinth(1.05, 0.24);
  h.cyl([0, top + 0.05, 0], 0.62, 0.72, 0.1, 6, P.pearl);
  const cy = top + 1.0;
  h.ring(3, (a) => {
    const base: V3 = [Math.cos(a) * 0.62, top + 0.1, Math.sin(a) * 0.62];
    const knee: V3 = [Math.cos(a) * 0.7, top + 0.75, Math.sin(a) * 0.7];
    const tip: V3 = [Math.cos(a) * 0.36, top + 1.45, Math.sin(a) * 0.36];
    strut(h, knee, base, 0.16, P.white, 0.2);
    strut(h, tip, knee, 0.12, P.white, 0.16);
    h.gem(knee, 0.11, P.slate);
    h.box([Math.cos(a) * 0.73, top + 0.42, Math.sin(a) * 0.73], [0.02, 0.36, 0.08], T, { rot: [0, -a, 0] });
  }, Math.PI / 6);
  h.gem([0, cy, 0], 0.34, ink('violet'));
  h.gem([0, cy, 0], 0.22, ink('magenta'));
  h.torus([0, cy, 0], 0.56, 0.035, 28, 4, P.white, [0.3, 0, 0.15]);
  h.torus([0, cy, 0], 0.6, 0.012, 28, 3, ink('cyan'), [0.3, 0, 0.15]);
  h.torus([0, cy, 0], 0.48, 0.02, 24, 3, P.pearl, [-0.5, 0, -0.35]);
  for (const [a, r, dy] of [[0.4, 0.82, 0.2], [1.6, 0.9, -0.15], [2.7, 0.78, 0.32], [3.8, 0.88, -0.28], [5.0, 0.84, 0.05]]) {
    h.gem([Math.cos(a) * r, cy + dy, Math.sin(a) * r], 0.045, ink('cyan'));
  }
};

export const RECIPES: Record<number, Recipe> = {
  1: commandShip, 2: battleship, 3: starfighter, 4: frigate,
  5: pursuitFighter, 6: stealthBomber, 7: interceptor,
  8: mobileArtillery, 9: tank, 10: samLauncher,
  11: cruiser, 12: destroyer, 13: submersible,
  14: extractor, 15: refinery, 16: orbitalShield, 17: jammingSat, 18: oreBunker, 19: pdc, 20: fieldGenerator, 21: powerPlant, 22: worldEngine,
};

/** Each struct's footprint on the boards and in the UI, in the old 128 px art's pixels (width,
 * height as drawn). The new hulls fill the same footprint, so the boards' pads, pick boxes, muzzle
 * points and spacing, and the UI's thumbnail crops, all stay as they were laid out. */
export const FOOTPRINT: Record<number, [number, number]> = {
  1: [59, 52], 2: [62, 48], 3: [42, 64], 4: [64, 51], 5: [63, 49], 6: [53, 64], 7: [62, 58], 8: [51, 64], 9: [62, 50],
  10: [63, 64], 11: [76, 48], 12: [87, 45], 13: [76, 37], 14: [72, 64], 15: [64, 64], 16: [64, 63], 17: [59, 64],
  18: [64, 61], 19: [57, 62], 20: [46, 64], 21: [70, 66], 22: [70, 72],
};

const geoCache = new Map<string, THREE.BufferGeometry>();
/** A struct type's hull geometry (shared: never dispose it), or null for an unknown type. Without
 * `scenery` a ship comes without its patch of water (the boards have a sea). */
export function hullGeometry(typeId: number, scenery = true): THREE.BufferGeometry | null {
  const r = RECIPES[typeId];
  if (!r) return null;
  const key = typeId + (scenery ? 's' : '');
  let g = geoCache.get(key);
  if (!g) {
    const h = new Hull(scenery);
    r(h);
    g = h.build();
    geoCache.set(key, g);
  }
  return g;
}

export type { Section };
