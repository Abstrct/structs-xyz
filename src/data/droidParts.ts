/* Droids are built from a player's PFP: the five portrait layers (background, body, arms, neck,
 * head) each pick a part family, and the family picks the 3D shape. Variants inside a family share
 * a mesh and keep their own pixels and colours. Ranges come from the layer contact sheets; a test
 * (scripts/droid.test.ts) checks every index lands in exactly one family. */

export const PFP_PARTS = ['background', 'body', 'arms', 'neck', 'head'] as const;
export type PfpPart = typeof PFP_PARTS[number];
export const PFP_MAX: Record<PfpPart, number> = { background: 6, body: 57, arms: 34, neck: 10, head: 87 };
export type PfpAttrs = Record<PfpPart, number>;

export type HeadFamily = 'helm' | 'screen' | 'goggle' | 'cowl' | 'slit' | 'band' | 'vee' | 'skull';
export type BodyFamily = 'bulwark' | 'spire' | 'core' | 'twin' | 'vee' | 'seam';
export type ArmsFamily = 'slab' | 'cap' | 'block' | 'crown' | 'fin';
export type NeckFamily = 'collar' | 'gem' | 'piston';
export type Aura = 'star' | 'ember' | 'dusk' | 'nebula' | 'fog' | 'tide';
/** What carries the torso: four families walk, two hover. */
export type Gait = 'heavy' | 'hover' | 'legs' | 'pods' | 'reverse' | 'long';

type Ranges<F extends string> = [F, number[]][];
const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export const HEAD_FAMILIES: Ranges<HeadFamily> = [
  ['helm', span(1, 9)], ['screen', span(10, 16)], ['goggle', span(17, 31)], ['cowl', span(32, 37)],
  ['slit', span(38, 48)], ['band', span(49, 63)], ['vee', span(64, 77)], ['skull', span(78, 87)],
];
export const BODY_FAMILIES: Ranges<BodyFamily> = [
  ['bulwark', [...span(1, 6), ...span(25, 32)]], ['spire', span(7, 12)], ['core', span(13, 24)],
  ['twin', span(33, 39)], ['vee', span(40, 47)], ['seam', span(48, 57)],
];
export const ARMS_FAMILIES: Ranges<ArmsFamily> = [
  ['slab', span(1, 6)], ['cap', span(7, 12)], ['block', span(13, 18)], ['crown', span(19, 30)], ['fin', span(31, 34)],
];
export const NECK_FAMILIES: Ranges<NeckFamily> = [['collar', [1, 2, 3, 5, 10]], ['gem', [4]], ['piston', span(6, 9)]];
export const AURAS: Aura[] = ['star', 'ember', 'dusk', 'nebula', 'fog', 'tide'];

export const GAIT: Record<BodyFamily, Gait> = { bulwark: 'heavy', spire: 'hover', core: 'legs', twin: 'pods', vee: 'reverse', seam: 'long' };
export const HOVERS = (g: Gait) => g === 'hover' || g === 'pods';

/** Each sky's aura colour: the ring under the feet, the nameplate dot, the balloon edge. */
export const AURA_COLOR: Record<Aura, string> = {
  star: '#CFE6FF', ember: '#FF7A59', dusk: '#B48FD9', nebula: '#D98FB8', fog: '#4FB3A6', tide: '#5B7BE0',
};

function lookup<F extends string>(table: Ranges<F>, i: number): F {
  for (const [f, ids] of table) if (ids.includes(i)) return f;
  return table[0][0];
}
export const headFamily = (i: number) => lookup(HEAD_FAMILIES, i);
export const bodyFamily = (i: number) => lookup(BODY_FAMILIES, i);
export const armsFamily = (i: number) => lookup(ARMS_FAMILIES, i);
export const neckFamily = (i: number) => lookup(NECK_FAMILIES, i);
export const auraOf = (i: number): Aura => AURAS[Math.max(1, Math.min(6, i)) - 1];

/** A player's portrait attributes, read the way the 2D portrait reads them: player-set JSON that
 * isn't a plain object counts as none, and none is derived from the seed (the player or Matrix id)
 * so the same commander always gets the same face. Every index is clamped into its layer's range. */
export function pfpAttrs(attrs: string | Record<string, unknown> | null | undefined, seed = ''): PfpAttrs {
  let a: Record<string, unknown> = {};
  try { const v = typeof attrs === 'string' ? JSON.parse(attrs || '{}') : attrs; a = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {}; } catch { a = {}; }
  if (!Object.keys(a).length) {
    let n = 2166136261;
    for (const c of seed || 'anon') n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0;
    for (const p of PFP_PARTS) { a[p] = 1 + (n % PFP_MAX[p]); n = Math.imul(n ^ (n >>> 13), 2654435761) >>> 0; }
  }
  const out = {} as PfpAttrs;
  for (const p of PFP_PARTS) out[p] = Math.max(1, Math.min(PFP_MAX[p], Math.round(Number(a[p])) || 1));
  return out;
}

export interface DroidSpec {
  attrs: PfpAttrs;
  head: HeadFamily; body: BodyFamily; arms: ArmsFamily; neck: NeckFamily;
  aura: Aura; gait: Gait;
  /** A stable key: the same attributes always build the same droid. */
  key: string;
}

export function droidSpec(attrs: PfpAttrs): DroidSpec {
  const body = bodyFamily(attrs.body);
  return {
    attrs,
    head: headFamily(attrs.head), body, arms: armsFamily(attrs.arms), neck: neckFamily(attrs.neck),
    aura: auraOf(attrs.background), gait: GAIT[body],
    key: PFP_PARTS.map((p) => attrs[p]).join('-'),
  };
}

/** A fresh random roll (the builder's Roll button). */
export function rollAttrs(rand: () => number = Math.random): PfpAttrs {
  const out = {} as PfpAttrs;
  for (const p of PFP_PARTS) out[p] = 1 + Math.floor(rand() * PFP_MAX[p]);
  return out;
}

/** One layer's image, as the 2D portrait loads it (root-relative; callers add the base). */
export const layerUrl = (p: PfpPart, i: number) => `/img/pfp/${p}/pfp_${p}_${i}.webp`;

export const FAMILY_LABEL: Record<string, string> = {
  helm: 'Helm', screen: 'Screen', goggle: 'Goggle', cowl: 'Cowl', slit: 'Slit', band: 'Band', vee: 'Vee', skull: 'Skull',
  bulwark: 'Bulwark', spire: 'Spire', core: 'Core', twin: 'Twin', seam: 'Seam',
  slab: 'Slab', cap: 'Cap', block: 'Block', crown: 'Crown', fin: 'Fin',
  collar: 'Collar', gem: 'Gem', piston: 'Piston',
  star: 'Star', ember: 'Ember', dusk: 'Dusk', nebula: 'Nebula', fog: 'Fog', tide: 'Tide',
};

/** The family name for one layer at one index (the builder's labels). */
export function familyName(p: PfpPart, i: number): string {
  const f = p === 'head' ? headFamily(i) : p === 'body' ? bodyFamily(i) : p === 'arms' ? armsFamily(i) : p === 'neck' ? neckFamily(i) : auraOf(i);
  return FAMILY_LABEL[f];
}
