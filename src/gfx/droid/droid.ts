/* Assembling a droid from its spec: each PFP family has a recipe of kit parts, each part rides a
 * bone, and the whole thing is one rigidly skinned mesh. The geometry is pure (no DOM, no images):
 * colours come from a DroidSkin, which skin.ts reads from the layer pixels in the browser, and
 * defaultSkin() supplies for tests and before the images arrive. */
import * as THREE from 'three';
import { GeoBuilder, type Paint, type V3, type Ink } from './kit';
import { HOVERS, type DroidSpec, type Gait } from '../../data/droidParts';

export const BONES = ['root', 'torso', 'head', 'armL', 'foreL', 'armR', 'foreR', 'thighL', 'shinL', 'thighR', 'shinR'] as const;
export type BoneName = typeof BONES[number];
const B = Object.fromEntries(BONES.map((b, i) => [b, i])) as Record<BoneName, number>;

export interface Palette { main: THREE.Color; second: THREE.Color; dark: THREE.Color }
export interface DroidSkin {
  head: Palette; body: Palette; arms: Palette; neck: Palette;
  /** Atlas UVs: the white texel and the lit swatches. */
  white: [number, number];
  swatch: { aura: [number, number]; glow: [number, number]; core: [number, number]; thrust: [number, number] };
  /** Decal rectangles (u0, v0, u1, v1) into the atlas, when the layer images were read. */
  decal: { head?: [number, number, number, number]; body?: [number, number, number, number]; padL?: [number, number, number, number]; padR?: [number, number, number, number] };
}

const col = (hex: string) => new THREE.Color(hex);
const pal = (main: string, second: string, dark: string): Palette => ({ main: col(main), second: col(second), dark: col(dark) });

/** Colours before (or without) the layer pixels: the PFP's grey, tan and orange. */
export function defaultSkin(): DroidSkin {
  return {
    head: pal('#8C97A8', '#E0902E', '#2A3446'),
    body: pal('#8C97A8', '#C9B48E', '#2A3446'),
    arms: pal('#E0902E', '#8C97A8', '#2A3446'),
    neck: pal('#5B6880', '#8C97A8', '#1A2335'),
    white: [0.5, 0.5],
    swatch: { aura: [0.5, 0.5], glow: [0.5, 0.5], core: [0.5, 0.5], thrust: [0.5, 0.5] },
    decal: {},
  };
}

/** Rest positions of the bones (relative to their parents), per gait. */
export interface Frame {
  hipY: number;         // root height above the floor
  legs: { thigh: number; shin: number; foot: V3; width: number; spread: number } | null;
  bones: Record<BoneName, V3>;
  parent: Record<BoneName, BoneName | null>;
  height: number;
}

export function frameFor(gait: Gait): Frame {
  const leg = gait === 'heavy' ? { thigh: 0.30, shin: 0.32, foot: [0.22, 0.09, 0.30] as V3, width: 0.19, spread: 0.13 }
    : gait === 'long' ? { thigh: 0.38, shin: 0.40, foot: [0.15, 0.07, 0.25] as V3, width: 0.13, spread: 0.10 }
    : gait === 'reverse' ? { thigh: 0.32, shin: 0.38, foot: [0.17, 0.07, 0.28] as V3, width: 0.14, spread: 0.11 }
    : gait === 'legs' ? { thigh: 0.32, shin: 0.35, foot: [0.17, 0.08, 0.27] as V3, width: 0.15, spread: 0.11 }
    : null;
  const hipY = leg ? leg.foot[1] + leg.shin + leg.thigh : 0.72;
  const torsoH = 0.46;
  return {
    hipY,
    legs: leg,
    height: hipY + 0.06 + torsoH + 0.1 + 0.32,
    parent: { root: null, torso: 'root', head: 'torso', armL: 'torso', foreL: 'armL', armR: 'torso', foreR: 'armR', thighL: 'root', shinL: 'thighL', thighR: 'root', shinR: 'thighR' },
    bones: {
      root: [0, hipY, 0],
      torso: [0, 0.06, 0],
      head: [0, torsoH + 0.1, 0],
      armL: [0.31, torsoH - 0.12, 0], foreL: [0, -0.27, 0],
      armR: [-0.31, torsoH - 0.12, 0], foreR: [0, -0.27, 0],
      thighL: [leg?.spread ?? 0.1, -0.02, 0], shinL: [0, -(leg?.thigh ?? 0.3), 0],
      thighR: [-(leg?.spread ?? 0.1), -0.02, 0], shinR: [0, -(leg?.thigh ?? 0.3), 0],
    },
  };
}

/** Bone origins in model space (the bind pose). */
function origins(f: Frame): Record<BoneName, THREE.Vector3> {
  const out = {} as Record<BoneName, THREE.Vector3>;
  for (const b of BONES) {
    const p = f.parent[b];
    out[b] = new THREE.Vector3(...f.bones[b]).add(p ? out[p] : new THREE.Vector3());
  }
  return out;
}

const add = (a: THREE.Vector3, d: V3): V3 => [a.x + d[0], a.y + d[1], a.z + d[2]];

export interface DroidGeometry { geometry: THREE.BufferGeometry; frame: Frame; triangles: number }

/** Every part of the droid, in model space, wound and skinned. Pure: safe in tests. */
export function buildDroidGeometry(spec: DroidSpec, skin: DroidSkin = defaultSkin()): DroidGeometry {
  const g = new GeoBuilder();
  g.white = skin.white;
  const f = frameFor(spec.gait);
  const o = origins(f);
  const sw = (uv: [number, number]): Ink => ({ kind: 'swatch', uv });
  const decal = (r?: [number, number, number, number]): Ink | undefined => r ? { kind: 'decal', rect: r } : undefined;
  const P = (p: Palette, k: keyof Palette = 'main', front?: Ink): Paint => ({ color: p[k], trim: p.dark.clone().lerp(p[k], 0.35), front });
  const glow = (uv: [number, number]): Paint => ({ color: new THREE.Color(1, 1, 1), all: sw(uv) });
  const H = skin.head, Bd = skin.body, A = skin.arms, N = skin.neck;

  // ── Torso (on the torso bone; its origin is the waist) ──
  const t = o.torso;
  const tb = B.torso;
  const front = decal(skin.decal.body);
  switch (spec.body) {
    case 'bulwark':
      g.box(tb, add(t, [0, 0.24, 0]), [0.58, 0.46, 0.36], P(Bd, 'main', front), { chamfer: 0.06, taperTop: 1.06 });
      g.box(tb, add(t, [0, 0.07, 0.17]), [0.46, 0.14, 0.06], P(Bd, 'second'), { chamfer: 0.02 });
      g.box(tb, add(t, [0, 0.50, -0.12]), [0.44, 0.06, 0.06], P(Bd, 'dark'), { chamfer: 0.015 });
      break;
    case 'spire':
      g.box(tb, add(t, [0, 0.25, 0]), [0.38, 0.52, 0.30], P(Bd, 'main', front), { chamfer: 0.04, taperBottom: 0.8 });
      for (const s of [-1, 1]) g.box(tb, add(t, [s * 0.23, 0.26, 0]), [0.08, 0.58, 0.32], P(Bd, 'second'), { chamfer: 0.02 });
      break;
    case 'core':
      g.box(tb, add(t, [0, 0.25, 0]), [0.52, 0.44, 0.36], P(Bd, 'main', front), { chamfer: 0.1, taperBottom: 0.72, taperDepth: true });
      g.gem(tb, add(t, [0, 0.12, 0.17]), 0.055, glow(skin.swatch.glow));
      break;
    case 'twin':
      for (const s of [-1, 1]) g.cyl(tb, add(t, [s * 0.13, 0.25, 0]), 0.14, 0.13, 0.44, 8, P(Bd, s > 0 ? 'main' : 'second'));
      g.box(tb, add(t, [0, 0.25, 0.04]), [0.16, 0.36, 0.26], P(Bd, 'dark', front), { chamfer: 0.02 });
      break;
    case 'vee':
      g.box(tb, add(t, [0, 0.25, 0]), [0.56, 0.44, 0.34], P(Bd, 'main', front), { chamfer: 0.05, taperBottom: 0.58 });
      g.box(tb, add(t, [0, 0.36, 0.165]), [0.36, 0.12, 0.04], P(Bd, 'second'), { chamfer: 0.015 });
      break;
    case 'seam':
      for (const s of [-1, 1]) g.box(tb, add(t, [s * 0.13, 0.25, 0]), [0.24, 0.46, 0.34], P(Bd, s > 0 ? 'main' : 'second', s > 0 ? front : undefined), { chamfer: 0.05 });
      g.box(tb, add(t, [0, 0.25, 0.02]), [0.05, 0.44, 0.32], P(Bd, 'dark'));
      g.box(tb, add(t, [0, 0.25, 0.188]), [0.03, 0.36, 0.012], glow(skin.swatch.glow));
      break;
  }
  // The Alpha core on every back.
  g.box(tb, add(t, [0, 0.26, -0.22]), [0.18, 0.28, 0.10], P(Bd, 'dark'), { chamfer: 0.03 });
  g.box(tb, add(t, [0, 0.26, -0.272]), [0.07, 0.20, 0.01], glow(skin.swatch.core));

  // ── Neck and head ──
  const hb = B.head, hd = o.head;
  switch (spec.neck) {
    case 'collar':
      g.cyl(tb, add(t, [0, 0.50, 0]), 0.08, 0.09, 0.12, 6, P(N, 'main'));
      g.cyl(tb, add(t, [0, 0.47, 0]), 0.15, 0.17, 0.04, 8, P(N, 'second'));
      break;
    case 'gem':
      g.cyl(tb, add(t, [0, 0.50, 0]), 0.08, 0.09, 0.12, 6, P(N, 'main'));
      g.gem(tb, add(t, [0, 0.49, 0.09]), 0.04, glow(skin.swatch.glow));
      break;
    case 'piston':
      g.cyl(tb, add(t, [0, 0.50, 0]), 0.06, 0.06, 0.13, 6, P(N, 'dark'));
      for (const s of [-1, 1]) g.cyl(tb, add(t, [s * 0.09, 0.50, 0]), 0.025, 0.025, 0.14, 5, P(N, 'second'));
      break;
  }
  const face = decal(skin.decal.head);
  const hc = (dy: number): V3 => add(hd, [0, dy, 0]);
  switch (spec.head) {
    case 'helm':
      g.box(hb, hc(0.16), [0.30, 0.32, 0.30], P(H, 'main', face), { chamfer: 0.06, taperTop: 0.86 });
      break;
    case 'screen':
      g.box(hb, hc(0.15), [0.31, 0.30, 0.28], P(H, 'main', face), { chamfer: 0.025 });
      g.cyl(hb, hc(0.34), 0.012, 0.012, 0.09, 4, P(H, 'dark'));
      break;
    case 'goggle':
      g.box(hb, hc(0.16), [0.30, 0.31, 0.30], P(H, 'main', face), { chamfer: 0.08 });
      for (const s of [-1, 1]) g.cyl(hb, hc(0.17).map((v, i) => v + (i === 0 ? s * 0.07 : i === 2 ? 0.155 : 0)) as V3, 0.05, 0.05, 0.03, 8, glow(skin.swatch.glow), [Math.PI / 2, 0, 0]);
      break;
    case 'cowl':
      g.box(hb, hc(0.18), [0.30, 0.38, 0.32], P(H, 'main', face), { chamfer: 0.07, taperTop: 0.74 });
      break;
    case 'slit':
      g.box(hb, hc(0.17), [0.28, 0.35, 0.30], P(H, 'main', face), { chamfer: 0.05 });
      g.cyl(hb, add(hd, [0.15, 0.30, -0.04]), 0.012, 0.012, 0.22, 4, P(H, 'dark'));
      break;
    case 'band':
      g.box(hb, hc(0.15), [0.31, 0.30, 0.30], P(H, 'main', face), { chamfer: 0.06 });
      g.box(hb, hc(0.15), [0.33, 0.05, 0.32], glow(skin.swatch.glow), { chamfer: 0.012 });
      break;
    case 'vee':
      g.box(hb, hc(0.16), [0.30, 0.31, 0.30], P(H, 'main', face), { chamfer: 0.05, taperBottom: 0.6 });
      break;
    case 'skull':
      g.box(hb, hc(0.19), [0.28, 0.24, 0.28], P(H, 'main', face), { chamfer: 0.08 });
      g.box(hb, hc(0.05), [0.20, 0.08, 0.22], P(H, 'second'), { chamfer: 0.03 });
      break;
  }

  // ── Shoulders, arms, hands ──
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const sh = o[`arm${side}`];
    const pad = decal(side === 'L' ? skin.decal.padL : skin.decal.padR);
    const pa = (d: V3): V3 => add(sh, [d[0] * s, d[1], d[2]]);
    switch (spec.arms) {
      case 'slab': g.box(tb, pa([0.03, 0.06, 0]), [0.16, 0.32, 0.26], P(A, 'main', pad), { chamfer: 0.03 }); break;
      case 'cap':
        g.box(tb, pa([0.03, 0.08, 0]), [0.24, 0.18, 0.27], P(A, 'main', pad), { chamfer: 0.08 });
        g.cyl(tb, pa([0.03, -0.03, 0]), 0.09, 0.08, 0.08, 6, P(A, 'second'));
        break;
      case 'block': g.box(tb, pa([0.04, 0.06, 0]), [0.23, 0.21, 0.25], P(A, 'main', pad), { chamfer: 0.03 }); break;
      case 'crown':
        g.box(tb, pa([0.04, 0.05, 0]), [0.22, 0.24, 0.26], P(A, 'main', pad), { chamfer: 0.04 });
        for (const z of [-0.07, 0, 0.07]) g.box(tb, pa([0.05, 0.19, z]), [0.14, 0.05, 0.035], P(A, 'second'), { chamfer: 0.01 });
        break;
      case 'fin': g.box(tb, pa([0.06, 0.08, 0]), [0.09, 0.32, 0.27], P(A, 'main', pad), { chamfer: 0.025, rot: [0, 0, -0.32 * s] }); break;
    }
    const arm = B[`arm${side}`], fore = B[`fore${side}`];
    g.cyl(arm, add(sh, [0, -0.13, 0]), 0.055, 0.05, 0.24, 6, P(A, 'dark'));
    const fo = o[`fore${side}`];
    g.box(fore, add(fo, [0, -0.11, 0]), [0.14, 0.24, 0.15], P(A, 'main'), { chamfer: 0.035, taperBottom: 0.9 });
    g.box(fore, add(fo, [0, -0.27, 0.01]), [0.11, 0.10, 0.11], P(A, 'second'), { chamfer: 0.025 });
  }

  // ── What carries it ──
  const r = o.root;
  if (!HOVERS(spec.gait) && f.legs) {
    const L = f.legs;
    g.box(B.root, add(r, [0, 0, 0]), [0.36 + (L.width - 0.15), 0.16, 0.26], P(Bd, 'dark'), { chamfer: 0.04, taperBottom: 0.8 });
    for (const side of ['L', 'R'] as const) {
      const th = o[`thigh${side}`], sn = o[`shin${side}`];
      g.box(B[`thigh${side}`], add(th, [0, -L.thigh / 2, 0]), [L.width, L.thigh, L.width + 0.02], P(Bd, 'second'), { chamfer: 0.03, taperBottom: 0.85 });
      g.box(B[`shin${side}`], add(sn, [0, -L.shin / 2, 0]), [L.width + 0.01, L.shin, L.width + 0.03], P(Bd, 'main'), { chamfer: 0.035, taperTop: 1.1 });
      const ft = L.foot;
      // A reverse knee's shin leans back at rest: its foot is cut level for that lean.
      g.box(B[`shin${side}`], add(sn, [0, -L.shin - ft[1] / 2 + 0.01, 0.04]), ft, P(Bd, 'dark'), { chamfer: 0.025, rot: spec.gait === 'reverse' ? [0.32, 0, 0] : undefined });
      if (spec.gait === 'reverse') g.box(B[`shin${side}`], add(sn, [0, -L.shin * 0.45, -0.1]), [0.06, 0.12, 0.06], P(Bd, 'second'), { chamfer: 0.015 });
    }
  } else if (spec.gait === 'hover') {
    g.box(B.root, add(r, [0, 0.02, 0]), [0.34, 0.14, 0.26], P(Bd, 'dark'), { chamfer: 0.04 });
    g.cyl(B.root, add(r, [0, -0.17, 0]), 0.15, 0.07, 0.26, 6, P(Bd, 'second'));
    g.cyl(B.root, add(r, [0, -0.31, 0]), 0.065, 0.065, 0.02, 6, glow(skin.swatch.thrust));
  } else {
    g.box(B.root, add(r, [0, 0.02, 0]), [0.40, 0.14, 0.26], P(Bd, 'dark'), { chamfer: 0.04 });
    for (const s of [-1, 1]) {
      g.cyl(B.root, add(r, [s * 0.15, -0.12, 0]), 0.09, 0.07, 0.22, 6, P(Bd, 'second'));
      g.cyl(B.root, add(r, [s * 0.15, -0.235, 0]), 0.055, 0.055, 0.015, 6, glow(skin.swatch.thrust));
    }
  }

  const geometry = g.build();
  // The real top (an antenna, a crown) is where nameplates and balloons sit.
  f.height = Math.max(f.height, geometry.boundingBox?.max.y ?? f.height);
  return { geometry, frame: f, triangles: g.triangles };
}

/** The rig: bones by name, posed by anim.ts. */
export interface DroidRig { bones: Record<BoneName, THREE.Bone>; rest: Record<BoneName, THREE.Vector3>; frame: Frame; gait: Gait }

/** A skinned droid mesh around a built geometry. */
export function skinnedDroid(dg: DroidGeometry, material: THREE.Material, gait: Gait): { mesh: THREE.SkinnedMesh; rig: DroidRig } {
  const mesh = new THREE.SkinnedMesh(dg.geometry, material);
  const bones = {} as Record<BoneName, THREE.Bone>;
  const rest = {} as Record<BoneName, THREE.Vector3>;
  for (const b of BONES) {
    const bone = new THREE.Bone();
    bone.name = b;
    bone.position.set(...dg.frame.bones[b]);
    rest[b] = bone.position.clone();
    bones[b] = bone;
  }
  for (const b of BONES) { const p = dg.frame.parent[b]; (p ? bones[p] : mesh).add(bones[b]); }
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(BONES.map((b) => bones[b])));
  return { mesh, rig: { bones, rest, frame: dg.frame, gait } };
}
