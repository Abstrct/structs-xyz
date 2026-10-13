/* Effects: pooled billboard particles cut from one baked sprite atlas (velocity-stretched sparks,
 * fire on a blackbody ramp, lit smoke that cools from orange to grey), pixel-shatter debris that
 * glows hot and throws sparks where it lands, shockwave rings, energy beams, hex-cell shields,
 * flash lights, and projectiles that fly a curve and call back on arrival. */
import * as THREE from 'three';
import { PX, type HullModel } from './hull/model';
import { PIXEL_RATIO } from '../core/engine';

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
const tmpC = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0: number, e1: number, x: number) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
/** A random unit vector into `out`. */
const randDir = (out: THREE.Vector3) => {
  const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  return out.set(Math.cos(a) * r, Math.sin(a) * r, z);
};

/* ── Shared GLSL ────────────────────────────────────────────────────────── */

/** Temperature → emission: soot, deep red, orange, yellow, white-hot. HDR, so the hottest blooms. */
const FIRE_GLSL = /* glsl */ `
  vec3 fxFire(float T) {
    T = clamp(T, 0.0, 1.6);
    vec3 c = mix(vec3(0.0), vec3(0.62, 0.07, 0.015), smoothstep(0.03, 0.2, T));
    c = mix(c, vec3(1.0, 0.3, 0.05), smoothstep(0.16, 0.42, T));
    c = mix(c, vec3(1.0, 0.6, 0.17), smoothstep(0.38, 0.66, T));
    c = mix(c, vec3(1.0, 0.86, 0.55), smoothstep(0.62, 0.92, T));
    c = mix(c, vec3(1.0, 0.97, 0.92), smoothstep(0.92, 1.3, T));
    return c * (0.2 + T * T * 2.4);
  }
`;

/* ── Sprite atlas: baked once on the CPU, shared by every particle system ─ */

const CELL = 256, GRID = 4, ATLAS = CELL * GRID, PUFFS = 6;
/** Cells of the baked sprite atlas ('puff' picks one of six smoke/fire puffs). */
export const SPRITES = { glow: 0, spark: 1, flare: 2, streak: 3, bubble: 4, glint: 5, ring: 6, puff: 8 } as const;
export type SpriteName = keyof typeof SPRITES;

/* Value noise on a random lattice (a table read is far cheaper than hashing every corner). */
const LAT = 256;
let lattice: Float32Array | null = null;
function vnoise(x: number, y: number) {
  const L = lattice!;
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = xi & (LAT - 1), y0 = (yi & (LAT - 1)) * LAT, x1 = (xi + 1) & (LAT - 1), y1 = ((yi + 1) & (LAT - 1)) * LAT;
  const a = L[y0 + x0], b = L[y0 + x1], c = L[y1 + x0], d = L[y1 + x1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number, oct: number) {
  let f = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < oct; i++) { f += amp * vnoise(x, y); norm += amp; x = x * 2.03 + 17.7; y = y * 2.03 - 31.9; amp *= 0.5; }
  return f / norm;
}
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** One band of rows [j0, j1) of an emissive mask cell: white, the mask in alpha (stored as sqrt
 * for precision in the faint tails). */
function paintMask(data: Uint8Array, cell: number, f: (u: number, v: number, r: number) => number, j0: number, j1: number) {
  const ox = (cell % GRID) * CELL, oy = Math.floor(cell / GRID) * CELL;
  for (let j = j0; j < j1; j++) for (let i = 0; i < CELL; i++) {
    const u = ((i + 0.5) / CELL) * 2 - 1, v = ((j + 0.5) / CELL) * 2 - 1;
    const o = ((oy + j) * ATLAS + ox + i) * 4;
    data[o] = data[o + 1] = data[o + 2] = 255;
    data[o + 3] = Math.round(Math.sqrt(clamp01(f(u, v, Math.sqrt(u * u + v * v)))) * 255);
  }
}
/** A mask cell as jobs of 32 rows each. */
function maskJobs(data: Uint8Array, cell: number, f: (u: number, v: number, r: number) => number) {
  const jobs: (() => void)[] = [];
  for (let j = 0; j < CELL; j += 32) jobs.push(() => paintMask(data, cell, f, j, j + 32));
  return jobs;
}

/** A volumetric puff: billowing lobes eroded by noise. RG = a normal from the blurred density (so
 * the shader can light it), B = how deep inside the body (fire burns hottest there), A = density.
 * Returned as jobs of a millisecond or few each (lobes, noise in row bands, blur, normals in bands). */
function puffJobs(data: Uint8Array, cell: number, seed: number): (() => void)[] {
  const N = CELL, R = 4, K = 9;
  const sum = new Float32Array(N * N), dens = new Float32Array(N * N), core = new Float32Array(N * N);
  const blur = new Float32Array(N * N), tmp = new Float32Array(N * N);
  const jobs: (() => void)[] = [];
  // Lobes accumulate over their own bounding boxes only.
  jobs.push(() => {
    const rnd = mulberry(seed * 7919 + 13), toPx = (x: number) => ((x + 1) / 2) * N - 0.5;
    for (let b = 0, nb = 9 + ((rnd() * 6) | 0); b < nb; b++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 0.42;
      const bx = Math.cos(a) * d, by = Math.sin(a) * d, rr = 0.17 + rnd() * 0.24 * (1.15 - d), ir2 = 1 / (rr * rr);
      const i0 = Math.max(0, Math.floor(toPx(bx - rr))), i1 = Math.min(N - 1, Math.ceil(toPx(bx + rr)));
      const j0 = Math.max(0, Math.floor(toPx(by - rr))), j1 = Math.min(N - 1, Math.ceil(toPx(by + rr)));
      for (let j = j0; j <= j1; j++) {
        const dy = ((j + 0.5) / N) * 2 - 1 - by;
        for (let i = i0; i <= i1; i++) {
          const dx = ((i + 0.5) / N) * 2 - 1 - bx;
          const q = 1 - (dx * dx + dy * dy) * ir2;
          if (q > 0) sum[j * N + i] += q * q;
        }
      }
    }
  });
  for (let j0 = 0; j0 < N; j0 += 16) jobs.push(() => {
    for (let j = j0; j < j0 + 16; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (sum[k] <= 0) continue;
      const u = ((i + 0.5) / N) * 2 - 1, v = ((j + 0.5) / N) * 2 - 1, r = Math.sqrt(u * u + v * v);
      const body = 1 - Math.exp(-sum[k] * 2.2);
      // Low octaves erode the silhouette into wisps; a finer layer breaks up the inside.
      const n1 = fbm(u * 2.1 + seed * 41.3, v * 2.1 - seed * 23.7, 5);
      const n2 = fbm(u * 4.4 - seed * 13.1, v * 4.4 + seed * 7.9, 3);
      const cover = clamp01((body + (n1 - 0.5) * 1.3 - 0.3) * 1.5) * smooth(1, 0.72, r);
      dens[k] = cover * (0.45 + 0.55 * smooth(0.22, 0.72, n2));
      // Temperature: hottest in the thick middle, streaked by the fine noise.
      core[k] = clamp01((body * 1.2 - r * 0.6) * (0.2 + 1.05 * smooth(0.28, 0.72, n1 * 0.65 + n2 * 0.35)));
    }
  });
  // Normals from a softened copy, so lobes shade as round volumes and not as noise.
  jobs.push(() => { for (let j = 0; j < N; j++) { let acc = 0; for (let i = -R; i <= R; i++) acc += dens[j * N + Math.min(N - 1, Math.max(0, i))]; for (let i = 0; i < N; i++) { tmp[j * N + i] = acc / (2 * R + 1); acc += dens[j * N + Math.min(N - 1, i + R + 1)] - dens[j * N + Math.max(0, i - R)]; } } });
  jobs.push(() => { for (let i = 0; i < N; i++) { let acc = 0; for (let j = -R; j <= R; j++) acc += tmp[Math.min(N - 1, Math.max(0, j)) * N + i]; for (let j = 0; j < N; j++) { blur[j * N + i] = acc / (2 * R + 1); acc += tmp[Math.min(N - 1, j + R + 1) * N + i] - tmp[Math.max(0, j - R) * N + i]; } } });
  const ox = (cell % GRID) * CELL, oy = Math.floor(cell / GRID) * CELL;
  const B = (x: number, y: number) => blur[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))];
  for (let j0 = 0; j0 < N; j0 += 32) jobs.push(() => {
    for (let j = j0; j < j0 + 32; j++) for (let i = 0; i < N; i++) {
      let nx = (B(i - 2, j) - B(i + 2, j)) * K, ny = (B(i, j - 2) - B(i, j + 2)) * K;
      const l = Math.sqrt(nx * nx + ny * ny + 1);
      nx /= l; ny /= l;
      const o = ((oy + j) * ATLAS + ox + i) * 4;
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round(core[j * N + i] * 255);
      data[o + 3] = Math.round(Math.sqrt(dens[j * N + i]) * 255);
    }
  });
  return jobs;
}

/** The bake as small jobs: run a few per slice so the first screen never stalls on it. `flush`
 * uploads what has landed (after the masks, which most effects use, and at the end). */
function bakeJobs(data: Uint8Array, flush: () => void): (() => void)[] {
  const e = (r: number, k: number) => Math.exp(-r * r * k);
  const fade = (r: number) => smooth(1, 0.8, r);
  const jobs: (() => void)[] = [];
  // Soft dot with a hot pinpoint.
  jobs.push(...maskJobs(data, SPRITES.glow, (_u, _v, r) => (e(r, 6) * 0.62 + e(r, 34) * 0.38) * fade(r)));
  // Spark: a needle with a bright head at +u (the shader points +u along the motion).
  jobs.push(...maskJobs(data, SPRITES.spark, (u, v) => {
    const along = smooth(-1, 0.25, u) * smooth(1, 0.62, u);
    return e(v, 26) * along * 0.85 + Math.exp(-((u - 0.5) * (u - 0.5) + v * v * 2.56) * 14) * 0.5 * smooth(1, 0.8, Math.sqrt(u * u + v * v));
  }));
  // Star-burst: core, long horizontal and vertical rays, faint diagonals.
  jobs.push(...maskJobs(data, SPRITES.flare, (u, v, r) => {
    const au = Math.abs(u), av = Math.abs(v);
    let a = (e(r, 55) + e(r, 9) * 0.38 + e(r, 2.6) * 0.12) * fade(r);
    if (av < 0.1) a += Math.exp(-av * 110) * Math.pow(1 - au, 2.2);
    if (au < 0.1) a += Math.exp(-au * 120) * Math.pow(1 - av, 2.8) * 0.55;
    const d1 = Math.abs(u + v) * 0.7071, d2 = Math.abs(u - v) * 0.7071;
    if (d1 < 0.05) a += Math.exp(-d1 * 220) * Math.pow(clamp01(1 - d2 * 1.6), 3) * 0.22;
    if (d2 < 0.05) a += Math.exp(-d2 * 220) * Math.pow(clamp01(1 - d1 * 1.6), 3) * 0.22;
    return a;
  }));
  // Anamorphic streak: a thin horizontal line, drawn on a quad stretched by `aspect`.
  jobs.push(...maskJobs(data, SPRITES.streak, (u, v) => (e(v, 900) * 0.9 + e(v, 140) * 0.2) * Math.pow(clamp01(1 - Math.abs(u)), 1.8)));
  // Bubble: a bright meniscus with a glint.
  jobs.push(...maskJobs(data, SPRITES.bubble, (u, v, r) => (e((r - 0.68) / 0.09, 1) * 0.85 + (r < 0.68 ? 0.07 : 0) + Math.exp(-((u + 0.28) * (u + 0.28) + (v - 0.3) * (v - 0.3)) * 70) * 0.9) * fade(r)));
  // Glint: a four-point twinkle.
  jobs.push(...maskJobs(data, SPRITES.glint, (u, v, r) => (Math.exp(-Math.abs(v) * 40) * Math.pow(clamp01(1 - Math.abs(u)), 3) + Math.exp(-Math.abs(u) * 40) * Math.pow(clamp01(1 - Math.abs(v)), 3) + e(r, 40)) * fade(r)));
  // Shock ring: a crisp leading edge with a soft wake inside.
  jobs.push(...maskJobs(data, SPRITES.ring, (_u, _v, r) => (e((r - 0.82) / 0.05, 1) + (r < 0.82 ? Math.exp((r - 0.82) * 6) * 0.3 : 0)) * fade(r * 0.98)));
  jobs.push(flush);
  jobs.push(() => { const rl = mulberry(1234567); lattice = new Float32Array(LAT * LAT); for (let i = 0; i < LAT * LAT; i++) lattice[i] = rl(); });
  for (let p = 0; p < PUFFS; p++) jobs.push(...puffJobs(data, SPRITES.puff + p, p + 1));
  jobs.push(() => { lattice = null; }, flush);
  return jobs;
}

let atlasData: Uint8Array | null = null;
let atlasTex: THREE.DataTexture | null = null;
let atlasRefs = 0;
/** The shared atlas. The CPU bake runs once in ~6 ms slices (sprites stay blank until their cells
 * land); the GPU copy lives while any system holds it. */
function acquireAtlas(): THREE.DataTexture {
  if (!atlasData) {
    const data = (atlasData = new Uint8Array(ATLAS * ATLAS * 4));
    const jobs = bakeJobs(data, () => { if (atlasTex) atlasTex.needsUpdate = true; });
    let next = 0;
    // A message loop, not timers: chained timeouts get throttled hard in background tabs. The
    // first slice is posted too, so constructing an Effects never runs any of the bake inline.
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      const t0 = performance.now();
      while (next < jobs.length && performance.now() - t0 < 5) jobs[next++]();
      if (next < jobs.length) ch.port2.postMessage(0);
      else { jobs.length = 0; ch.port1.close(); }
    };
    ch.port2.postMessage(0);
  }
  if (!atlasTex) {
    const t = new THREE.DataTexture(atlasData, ATLAS, ATLAS, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    atlasTex = t;
  }
  atlasRefs++;
  return atlasTex;
}
function releaseAtlas() {
  atlasRefs = Math.max(0, atlasRefs - 1);
  if (atlasRefs > 0 || !atlasTex) return;
  atlasTex.dispose();
  atlasTex = null;
}

/* ── Particles ──────────────────────────────────────────────────────────── */

export interface ParticleSpec {
  pos: THREE.Vector3; vel?: THREE.Vector3; color?: THREE.ColorRepresentation; size?: number; life?: number;
  drag?: number; gravity?: number; grow?: number; fadeIn?: number;
  /** Atlas sprite (default glow; smoke systems default to a random puff). */
  sprite?: SpriteName;
  /** Seconds of motion added to the quad's length along its screen velocity (sparks, streaks). */
  stretch?: number;
  /** A fixed length:width ratio instead (anamorphic streaks); unused while stretching. */
  aspect?: number;
  /** Screen-space rotation (radians) and spin (radians/s). */
  rot?: number; spin?: number;
  /** Fire: a start temperature (0..1.5); colour then comes from the blackbody ramp and cools.
   * On smoke it is a glow from within that fades the same way. */
  heat?: number;
  /** How fast heat falls over life (exponent on 1 − t). */
  cool?: number;
  /** HDR brightness (> 1 blooms). */
  intensity?: number;
  /** Extra whitening at the sprite's hottest texels (additive). */
  core?: number;
  /** Early-life whitening (additive; default 0.6). */
  hot?: number;
  /** Fade-out curve exponent (1 linear). */
  fade?: number;
  /** Growth curve exponent (1 linear, 2 eases out). */
  growPow?: number;
  /** Billowing swirl strength. */
  turb?: number;
  /** How much a cooling fire particle darkens what is behind it. */
  soot?: number;
  /** Opacity multiplier. */
  opacity?: number;
}

/* Per-particle state, one stride each. */
const S = 32;
const F_VX = 3, F_R = 6, F_SIZE = 9, F_LIFE = 10, F_AGE = 11, F_DRAG = 12, F_GRAV = 13, F_GROW = 14, F_GPOW = 15, F_FIN = 16, F_FADE = 17,
  F_ROT = 18, F_SPIN = 19, F_STR = 20, F_ASP = 21, F_HEAT = 22, F_COOL = 23, F_INT = 24, F_CORE = 25, F_TURB = 26, F_SOOT = 27, F_CELL = 28,
  F_HOT = 29, F_SEED = 30, F_OPA = 31;

const PARTICLE_VERT = /* glsl */ `
  attribute vec4 iPos; attribute vec4 iVel; attribute vec4 iCol; attribute vec4 iMisc;
  uniform float uScale, uPR;
  varying vec2 vUv; varying vec4 vCol; varying vec2 vAxis; varying vec2 vFx;
  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
    float depth = max(0.05, -mv.z);
    float size = iPos.w;
    // Screen-space motion (view-plane units at this depth): sparks stretch along it, head first.
    vec3 vv = mat3(modelViewMatrix) * iVel.xyz;
    vec2 w = vv.xy + mv.xy * vv.z / depth;
    float sp = length(w);
    bool streak = iVel.w > 0.0 && sp > 1e-3;
    float extra = streak ? sp * iVel.w : 0.0;
    // Sub-pixel sprites shimmer: hold them near 1.5 px and pay for the extra area in alpha.
    float px = size * uScale * uPR / depth;
    float lift = max(1.0, 1.5 / max(px, 1e-3));
    float len0 = iVel.w < 0.0 ? size * -iVel.w : size + extra;
    size *= lift;
    float len = iVel.w < 0.0 ? size * -iVel.w : size + extra;
    vCol = vec4(iCol.rgb, iCol.a * (iPos.w * len0) / max(size * len, 1e-8));
    vec2 ax = streak ? w / sp : vec2(cos(iMisc.x), sin(iMisc.x));
    vec2 ay = vec2(-ax.y, ax.x);
    mv.xy += ax * (position.x * len - extra * 0.5) + ay * position.y * size;
    gl_Position = projectionMatrix * mv;
    vec2 cell = vec2(mod(iMisc.y, 4.0), floor(iMisc.y / 4.0));
    vUv = (cell + 0.004 + (position.xy + 0.5) * 0.992) * 0.25;
    vAxis = ax; vFx = iMisc.zw;
  }
`;

const ADDITIVE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv; varying vec4 vCol; varying vec2 vAxis; varying vec2 vFx;
  ${FIRE_GLSL}
  void main() {
    vec4 tx = texture2D(uMap, vUv);
    float m = tx.a * tx.a;
    if (vFx.x > 0.0) {
      // Fire: temperature peaks deep in the puff; cooling edges leave a little soot.
      float T = vFx.x * mix(0.3, 1.2, tx.b);
      vec3 e = fxFire(T) * vCol.rgb * m * vCol.a;
      float soot = m * vFx.y * (1.0 - smoothstep(0.15, 0.75, T)) * vCol.a;
      if (max(e.r, soot) < 0.002) discard;
      gl_FragColor = vec4(e, soot);
    } else {
      vec3 c = vCol.rgb * m * (1.0 + vFx.y * m * m * m) * vCol.a;
      if (max(c.r, max(c.g, c.b)) < 0.002) discard;
      gl_FragColor = vec4(c, 0.0);
    }
  }
`;

const SMOKE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uLight, uAmb, uKey, uRim;
  varying vec2 vUv; varying vec4 vCol; varying vec2 vAxis; varying vec2 vFx;
  ${FIRE_GLSL}
  void main() {
    vec4 tx = texture2D(uMap, vUv);
    float dens = tx.a * tx.a * vCol.a;
    if (dens < 0.003) discard;
    // The baked normal turns with the sprite, so the key light stays put on screen.
    vec2 nl = tx.rg * 2.0 - 1.0;
    vec3 N = normalize(vec3(vAxis * nl.x + vec2(-vAxis.y, vAxis.x) * nl.y, 0.7));
    float lit = clamp(dot(N, uLight) * 0.65 + 0.35, 0.0, 1.0);
    float thin = 1.0 - tx.a;
    // Even soot-black smoke catches some light, so it reads as volume, not a hole in the sky.
    vec3 alb = max(vCol.rgb, vec3(0.085));
    vec3 c = alb * (uAmb + uKey * lit) + uRim * thin * thin * 0.5;
    // Lit from within while hot: the thick core glows, the wisps stay cool.
    if (vFx.x > 0.0) c += fxFire(vFx.x * mix(0.2, 1.05, tx.b)) * (0.45 + 0.55 * tx.b);
    gl_FragColor = vec4(c * dens, dens);
  }
`;

export class Particles {
  /** The drawable (instanced camera-facing quads; the name predates them). */
  readonly points: THREE.Mesh;
  private max: number;
  private next = 0;
  private d: Float32Array;
  private gPos: Float32Array; private gVel: Float32Array; private gCol: Float32Array; private gMisc: Float32Array;
  private attrs: THREE.InstancedBufferAttribute[];
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private live = 0;
  private dirty = false;
  private clock = 0;
  private isSmoke: boolean;
  scaleFor: [number, number] = [0, 0];

  constructor(max = 4000, mode: 'additive' | 'smoke' = 'additive') {
    this.max = max;
    this.isSmoke = mode === 'smoke';
    this.d = new Float32Array(max * S);
    for (let i = 0; i < max; i++) { this.d[i * S + F_AGE] = 1e9; this.d[i * S + F_LIFE] = 1; }
    this.gPos = new Float32Array(max * 4); this.gVel = new Float32Array(max * 4); this.gCol = new Float32Array(max * 4); this.gMisc = new Float32Array(max * 4);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.attrs = [['iPos', this.gPos], ['iVel', this.gVel], ['iCol', this.gCol], ['iMisc', this.gMisc]].map(([name, arr]) => {
      const a = new THREE.InstancedBufferAttribute(arr as Float32Array, 4).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name as string, a);
      return a;
    });
    g.instanceCount = 0;
    this.geo = g;
    const uniforms: Record<string, THREE.IUniform> = { uScale: { value: 400 }, uPR: PIXEL_RATIO, uMap: { value: acquireAtlas() } };
    if (this.isSmoke) Object.assign(uniforms, {
      uLight: { value: new THREE.Vector3(-0.5, 0.72, 0.48).normalize() },
      uAmb: { value: new THREE.Color(0.42, 0.47, 0.6) }, uKey: { value: new THREE.Color(1.05, 0.95, 0.84) }, uRim: { value: new THREE.Color(0.05, 0.07, 0.11) },
    });
    // Premultiplied: rgb adds (glow, fire), alpha occludes (smoke, soot) — one blend for all of it.
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.NormalBlending, premultipliedAlpha: true,
      uniforms, vertexShader: PARTICLE_VERT, fragmentShader: this.isSmoke ? SMOKE_FRAG : ADDITIVE_FRAG,
    });
    this.points = new THREE.Mesh(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = this.isSmoke ? 4 : 5;
  }

  setScale(viewportHeight: number, fovDeg: number) {
    this.scaleFor = [viewportHeight, fovDeg];
    this.mat.uniforms.uScale.value = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  spawn(s: ParticleSpec) {
    this.dirty = true;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    const d = this.d, o = i * S, smoke = this.isSmoke;
    d[o] = s.pos.x; d[o + 1] = s.pos.y; d[o + 2] = s.pos.z;
    const v = s.vel;
    d[o + F_VX] = v ? v.x : 0; d[o + F_VX + 1] = v ? v.y : 0; d[o + F_VX + 2] = v ? v.z : 0;
    tmpC.set(s.color ?? 0xffffff);
    d[o + F_R] = tmpC.r; d[o + F_R + 1] = tmpC.g; d[o + F_R + 2] = tmpC.b;
    d[o + F_SIZE] = s.size ?? 0.3;
    d[o + F_LIFE] = s.life ?? 0.8;
    d[o + F_AGE] = 0;
    d[o + F_DRAG] = s.drag ?? 1.5;
    d[o + F_GRAV] = s.gravity ?? 0;
    d[o + F_GROW] = s.grow ?? 0;
    d[o + F_GPOW] = s.growPow ?? (smoke ? 2 : 1);
    d[o + F_FIN] = Math.min(0.95, s.fadeIn ?? (smoke ? 0.2 : 0.1));
    d[o + F_FADE] = s.fade ?? (smoke ? 1.3 : 1);
    const sprite = s.sprite ?? (smoke ? 'puff' : 'glow');
    d[o + F_CELL] = sprite === 'puff' ? SPRITES.puff + ((Math.random() * PUFFS) | 0) : SPRITES[sprite];
    d[o + F_ROT] = s.rot ?? (sprite === 'puff' ? Math.random() * Math.PI * 2 : 0);
    d[o + F_SPIN] = s.spin ?? (sprite === 'puff' ? (Math.random() - 0.5) * 0.9 : 0);
    // An explicit aspect (anamorphic streaks) wins over the default motion stretch.
    d[o + F_STR] = s.stretch ?? (smoke || (s.aspect ?? 1) !== 1 ? 0 : 0.03);
    d[o + F_ASP] = s.aspect ?? 1;
    d[o + F_HEAT] = s.heat ?? 0;
    d[o + F_COOL] = s.cool ?? 1.5;
    d[o + F_INT] = s.intensity ?? 1;
    d[o + F_CORE] = s.core ?? 1;
    d[o + F_HOT] = s.hot ?? (smoke ? 0 : 0.6);
    d[o + F_TURB] = s.turb ?? (smoke ? 0.5 : 0);
    d[o + F_SOOT] = s.soot ?? 0.45;
    d[o + F_OPA] = s.opacity ?? (smoke ? 0.6 : 1);
    d[o + F_SEED] = Math.random() * 100;
  }

  burst(center: THREE.Vector3, n: number, opts: { speed?: number; color?: THREE.ColorRepresentation | THREE.ColorRepresentation[]; size?: number; life?: number; drag?: number; gravity?: number; grow?: number; spread?: THREE.Vector3 } & Omit<ParticleSpec, 'pos' | 'vel' | 'color' | 'size' | 'life' | 'drag' | 'gravity' | 'grow'>) {
    const colors = Array.isArray(opts.color) ? opts.color : [opts.color ?? 0xffffff];
    const spec: ParticleSpec = { ...opts, pos: tmpV2, vel: tmpV3 } as ParticleSpec;
    for (let k = 0; k < n; k++) {
      const dir = tmpV.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      if (opts.spread) dir.multiply(opts.spread);
      const sp = (opts.speed ?? 4) * (0.3 + Math.random() * 0.9);
      tmpV2.copy(center).addScaledVector(dir, 0.05);
      tmpV3.copy(dir).multiplyScalar(sp);
      spec.color = colors[(Math.random() * colors.length) | 0];
      spec.size = (opts.size ?? 0.3) * (0.6 + Math.random() * 0.8);
      spec.life = (opts.life ?? 0.8) * (0.6 + Math.random() * 0.7);
      spec.drag = opts.drag ?? 2; spec.gravity = opts.gravity ?? 0; spec.grow = opts.grow ?? 0;
      this.spawn(spec);
    }
  }

  update(dt: number) {
    // Idle systems cost nothing: no loop, no upload, no draw.
    if (this.live === 0 && !this.dirty) return;
    this.dirty = false;
    this.clock += dt;
    const d = this.d, gp = this.gPos, gv = this.gVel, gc = this.gCol, gm = this.gMisc, clock = this.clock;
    let n = 0;
    // Oldest first, from the ring's write head: newer puffs layer over older ones, wrap or not.
    for (let k = 0, i = this.next, max = this.max; k < max; k++, i = i + 1 === max ? 0 : i + 1) {
      const o = i * S;
      const life = d[o + F_LIFE];
      if (d[o + F_AGE] >= life) continue;
      const age = (d[o + F_AGE] += dt);
      if (age >= life) continue;
      const t = age / life;
      const dr = Math.exp(-d[o + F_DRAG] * dt);
      let vx = d[o + F_VX] * dr, vy = d[o + F_VX + 1] * dr - d[o + F_GRAV] * dt, vz = d[o + F_VX + 2] * dr;
      const tb = d[o + F_TURB];
      if (tb) {
        // Cheap swirl: crossed sines of position and time read as billowing, curling smoke.
        const ph = d[o + F_SEED] + clock * 0.9;
        vx += Math.sin(d[o + 1] * 1.7 + ph) * tb * dt;
        vy += Math.sin(d[o + 2] * 1.3 + ph * 1.3) * tb * dt * 0.6;
        vz += Math.sin(d[o] * 1.5 + ph * 0.7) * tb * dt;
      }
      d[o + F_VX] = vx; d[o + F_VX + 1] = vy; d[o + F_VX + 2] = vz;
      const x = (d[o] += vx * dt), y = (d[o + 1] += vy * dt), z = (d[o + 2] += vz * dt);
      const rot = (d[o + F_ROT] += d[o + F_SPIN] * dt);
      const fi = d[o + F_FIN];
      const a = (t < fi ? t / fi : Math.pow(Math.max(0, 1 - (t - fi) / (1 - fi)), d[o + F_FADE])) * d[o + F_OPA];
      const gpw = d[o + F_GPOW];
      const size = d[o + F_SIZE] * Math.max(0.02, 1 + d[o + F_GROW] * (gpw === 1 ? t : 1 - Math.pow(1 - t, gpw)));
      const h0 = d[o + F_HEAT];
      const heat = h0 > 0 ? Math.max(1e-3, h0 * Math.pow(1 - t, d[o + F_COOL])) : 0;
      const hw = d[o + F_HOT] * Math.max(0, 1 - t * 3), k = d[o + F_INT];
      const r = d[o + F_R], g = d[o + F_R + 1], b = d[o + F_R + 2];
      const q = n * 4;
      gp[q] = x; gp[q + 1] = y; gp[q + 2] = z; gp[q + 3] = size;
      const st = d[o + F_STR], asp = d[o + F_ASP];
      gv[q] = vx; gv[q + 1] = vy; gv[q + 2] = vz; gv[q + 3] = st > 0 ? st : asp !== 1 ? -asp : 0;
      gc[q] = (r + (1 - r) * hw) * k; gc[q + 1] = (g + (1 - g) * hw) * k; gc[q + 2] = (b + (1 - b) * hw) * k; gc[q + 3] = a;
      gm[q] = rot; gm[q + 1] = d[o + F_CELL]; gm[q + 2] = heat; gm[q + 3] = heat > 0 ? d[o + F_SOOT] : d[o + F_CORE];
      n++;
    }
    this.live = n;
    this.geo.instanceCount = n;
    if (n) for (const at of this.attrs) { at.clearUpdateRanges(); at.addUpdateRange(0, n * 4); at.needsUpdate = true; }
  }
  get count() { return this.live; }

  /** Expire every particle; the next update hides them and the system rests. */
  reset() { for (let i = 0; i < this.max; i++) this.d[i * S + F_AGE] = 1e9; this.live = 0; this.dirty = true; }

  private disposed = false;
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.geo.dispose();
    this.mat.dispose();
    releaseAtlas();
  }
}

/* ── Pixel debris ───────────────────────────────────────────────────────── */

export class Debris {
  readonly mesh: THREE.InstancedMesh;
  /** Hooks the owner wires to its particles: sparks off a hard landing, smoke off hot chunks. */
  onBounce?: (p: THREE.Vector3, speed: number, heat: number) => void;
  onTrail?: (p: THREE.Vector3, v: THREE.Vector3, heat: number) => void;
  private max: number;
  private next = 0;
  private p: Float32Array; private v: Float32Array; private r: Float32Array; private w: Float32Array;
  private life: Float32Array; private age: Float32Array; private scale: Float32Array; private floor: Float32Array;
  private heat0: Float32Array; private heat: Float32Array; private trail: Uint8Array;
  private heatAttr: THREE.InstancedBufferAttribute;
  private dummy = new THREE.Object3D();
  private hp = new THREE.Vector3();
  private hv = new THREE.Vector3();

  constructor(max = 6000) {
    this.max = max;
    const geo = new THREE.BoxGeometry(PX, PX, PX);
    this.heat = new Float32Array(max);
    this.heatAttr = new THREE.InstancedBufferAttribute(this.heat, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iHeat', this.heatAttr);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3, emissive: 0x000000 });
    // Hot chunks glow on the same ramp as the fire and cool to bare metal.
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float iHeat;\nvarying float vHeat;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat = iHeat;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vHeat;\n' + FIRE_GLSL)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += fxFire(vHeat) * 0.9;');
    };
    mat.customProgramCacheKey = () => 'fx-debris-heat';
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.frustumCulled = false;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3);
    this.r = new Float32Array(max * 3); this.w = new Float32Array(max * 3);
    this.life = new Float32Array(max); this.age = new Float32Array(max).fill(1e9); this.scale = new Float32Array(max);
    this.floor = new Float32Array(max).fill(-1e9);
    this.heat0 = new Float32Array(max); this.trail = new Uint8Array(max);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < max; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    // Nothing flying: draw nothing (the program still compiles with the scene).
    this.mesh.count = 0;
  }

  /** Break a hull apart from `origin` (world), a cube for every art pixel of it. */
  shatter(model: HullModel, matrixWorld: THREE.Matrix4, origin: THREE.Vector3, power = 6, floorY = -1e9, keep = 1) {
    const step = keep >= 1 ? 1 : Math.round(1 / keep);
    // Each pixel of the hull's nearest surface, and a chunk from a little inside it.
    const inner = Math.min(model.depth * 0.5, PX * 6);
    const dir = new THREE.Vector3(), jit = new THREE.Vector3();
    let hiWritten = this.mesh.count, wrapped = false;
    for (let k = 0; k < model.pixels.length; k += step) {
      const px = model.pixels[k];
      // About one chunk for every two pixels, from the surface or a little inside it (a blast in the
      // air then stays near 10k triangles, beside the board's hulls and their keylines).
      for (const z of [px.z - PX / 2 - Math.random() * inner]) {
        if (Math.random() < 0.45) continue;
        const i = this.next;
        this.next = (this.next + 1) % this.max;
        if (this.next === 0) wrapped = true;
        hiWritten = Math.max(hiWritten, i + 1);
        tmpV.set(px.x, px.y, z).applyMatrix4(matrixWorld);
        this.p[i * 3] = tmpV.x; this.p[i * 3 + 1] = tmpV.y; this.p[i * 3 + 2] = tmpV.z;
        dir.copy(tmpV).sub(origin);
        const dist = Math.max(0.2, dir.length());
        dir.normalize().add(jit.set((Math.random() - 0.5) * 0.9, Math.random() * 0.9, (Math.random() - 0.5) * 0.9));
        const sp = power * (0.4 + Math.random()) / Math.sqrt(dist);
        this.v[i * 3] = dir.x * sp; this.v[i * 3 + 1] = dir.y * sp; this.v[i * 3 + 2] = dir.z * sp;
        this.r[i * 3] = Math.random() * 6; this.r[i * 3 + 1] = Math.random() * 6; this.r[i * 3 + 2] = 0;
        this.w[i * 3] = (Math.random() - 0.5) * 18; this.w[i * 3 + 1] = (Math.random() - 0.5) * 18; this.w[i * 3 + 2] = (Math.random() - 0.5) * 18;
        this.life[i] = 1.6 + Math.random() * 1.6;
        this.age[i] = 0;
        this.alive++;
        this.scale[i] = 1 + Math.random() * 1.2;
        this.floor[i] = floorY;
        // A minority of chunks leave glowing (nearest the blast hottest); the rest are just scorched.
        this.heat0[i] = Math.random() < 0.2 ? Math.min(1, Math.max(0.3, (1.25 - dist * 0.3) * (0.6 + Math.random() * 0.5))) : Math.random() * 0.1;
        this.trail[i] = this.heat0[i] > 0.5 && Math.random() < 0.12 ? 1 : 0;
        tmpC.setRGB(px.r / 255, px.g / 255, px.b / 255, THREE.SRGBColorSpace);
        this.mesh.setColorAt(i, tmpC);
      }
    }
    this.mesh.instanceColor!.needsUpdate = true;
    // Draw only the slots in use: up to the last one written (all of them once the ring wraps).
    if (this.alive > 0) this.mesh.count = wrapped ? this.max : hiWritten;
  }

  private alive = 0;
  update(dt: number) {
    if (this.alive === 0) return;
    const d = this.dummy;
    let alive = 0, bounces = 0, trails = 0, hi = 0;
    for (let i = 0; i < this.mesh.count; i++) {
      if (this.age[i] > this.life[i]) continue;
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t > 1) {
        // Gone this frame: hide it once, then it rests.
        d.scale.setScalar(0); d.updateMatrix(); this.mesh.setMatrixAt(i, d.matrix); this.heat[i] = 0;
        continue;
      }
      alive++;
      hi = i + 1;
      this.v[i * 3 + 1] -= 5.5 * dt;
      const dr = Math.exp(-0.9 * dt);
      this.v[i * 3] *= dr; this.v[i * 3 + 2] *= dr;
      this.p[i * 3] += this.v[i * 3] * dt; this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt; this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      const heat = this.heat0[i] * Math.exp(-this.age[i] * 1.8);
      this.heat[i] = heat;
      if (this.p[i * 3 + 1] < this.floor[i]) {
        const impact = -this.v[i * 3 + 1];
        this.p[i * 3 + 1] = this.floor[i];
        if (impact > 2.2 && bounces < 12 && this.onBounce && Math.random() < 0.35) { bounces++; this.onBounce(this.hp.set(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]), impact, heat); }
        this.v[i * 3 + 1] *= -0.3; this.v[i * 3] *= 0.6; this.v[i * 3 + 2] *= 0.6;
        this.w[i * 3] *= 0.7; this.w[i * 3 + 1] *= 0.7; this.w[i * 3 + 2] *= 0.7;
      }
      if (this.trail[i] && heat > 0.18 && trails < 16 && this.onTrail && Math.random() < dt * 14) {
        trails++;
        this.onTrail(this.hp.set(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]), this.hv.set(this.v[i * 3], this.v[i * 3 + 1], this.v[i * 3 + 2]), heat);
      }
      this.r[i * 3] += this.w[i * 3] * dt; this.r[i * 3 + 1] += this.w[i * 3 + 1] * dt; this.r[i * 3 + 2] += this.w[i * 3 + 2] * dt;
      d.position.set(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]);
      d.rotation.set(this.r[i * 3], this.r[i * 3 + 1], this.r[i * 3 + 2]);
      d.scale.setScalar(this.scale[i] * (t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1));
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }
    this.alive = alive;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.heatAttr.needsUpdate = true;
    // Only as many instances as the last flying chunk needs (each is 12 triangles: a full ring of
    // 6000 is 72k). Once nothing flies the ring starts again at slot 0, so the next blast stays short.
    this.mesh.count = hi;
    if (alive === 0) this.next = 0;
  }

  /** Drop every flying cube at once (a new board starts clean). */
  reset() {
    if (this.alive === 0) return;
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < this.max; i++) if (this.age[i] <= this.life[i]) { this.age[i] = 1e9; this.mesh.setMatrixAt(i, this.dummy.matrix); }
    this.alive = 0;
    this.next = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = 0;
  }

  private disposed = false;
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

/* ── Rings, beams, shields: pooled meshes on shared geometry ────────────── */

interface Timed { obj: THREE.Object3D; age: number; life: number; tick: (t: number, dt: number) => void; dispose?: () => void; done?: () => void }

export function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.12, 'rgba(255,255,255,0.75)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* Shock ring on a quad: a crisp, hot leading edge, a fading wake, a little angular breakup. */
function ringMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color() }, uR: { value: 1 }, uBill: { value: 0 }, uFront: { value: 0.5 }, uWidth: { value: 0.05 }, uOp: { value: 0 }, uSeed: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uR, uBill;
      varying vec2 vP;
      void main() {
        vP = position.xy;
        vec4 mv = uBill > 0.5 ? modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0) + vec4(position.xy * uR, 0.0, 0.0)
                              : modelViewMatrix * vec4(position.xy * uR, 0.0, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uFront, uWidth, uOp, uSeed;
      varying vec2 vP;
      void main() {
        float r = length(vP);
        if (r > 1.0) discard;
        float a = atan(vP.y, vP.x);
        float n = 0.6 + 0.4 * sin(a * 5.0 + uSeed) * sin(a * 11.0 - uSeed * 1.7 + r * 9.0) * sin(a * 3.0 + uSeed * 0.6);
        float dd = (r - uFront) / uWidth;
        float edge = exp(-dd * dd);
        float wake = r < uFront ? exp((r - uFront) / (uWidth * 5.0)) * 0.32 : 0.0;
        float k = (edge + wake) * n * uOp * (1.0 - smoothstep(0.94, 1.0, r));
        gl_FragColor = vec4(uColor * k * 1.7 + vec3(1.0) * edge * edge * edge * uOp * 0.5, 1.0);
      }
    `,
  });
}

/* A camera-facing ribbon between two points. Style 0: energy beam (white-hot core, coloured
 * sheath, ripples racing down it). Style 1: a round in flight (hot nose at B, cooling tail). */
function ribbonMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: {
      uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3(0, 0.001, 0) }, uW: { value: 0.01 }, uColor: { value: new THREE.Color() },
      uTime: { value: 0 }, uReach: { value: 1 }, uOp: { value: 0 }, uStyle: { value: 0 }, uCore: { value: 1 },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uA, uB; uniform float uW;
      varying vec2 vQ; varying float vL;
      void main() {
        vec3 a = (modelMatrix * vec4(uA, 1.0)).xyz, b = (modelMatrix * vec4(uB, 1.0)).xyz;
        vec3 ax = b - a; float L = length(ax);
        vec3 dir = L > 1e-5 ? ax / L : vec3(1.0, 0.0, 0.0);
        float s = uv.x * (L + 2.0 * uW) - uW;
        vec3 p = a + dir * s;
        vec3 side = cross(dir, normalize(cameraPosition - p));
        float sl = length(side);
        side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
        p += side * position.y * uW;
        vQ = vec2(s, position.y); vL = L;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uW, uTime, uReach, uOp, uStyle, uCore;
      varying vec2 vQ; varying float vL;
      void main() {
        float s = vQ.x, y = vQ.y;
        vec3 col;
        if (uStyle < 0.5) {
          float reach = uReach * vL;
          float dx = s < 0.0 ? -s / uW : s > reach ? (s - reach) / uW : 0.0;
          float d = sqrt(dx * dx + y * y);
          if (d >= 1.0) discard;
          float rip = 0.62 + 0.38 * sin(s * 5.5 - uTime * 48.0 + y * 2.0) * sin(s * 1.7 - uTime * 15.0);
          float c0 = max(0.05, 0.16 * uCore);
          float core = exp(-(d * d) / (c0 * c0));
          float sheath = exp(-d * 5.5) * rip;
          float halo = (1.0 - d) * (1.0 - d) * 0.22;
          col = vec3(1.0) * core * 3.5 + uColor * (core * 2.0 + sheath * 2.4 + halo);
        } else {
          float k = clamp(s / max(vL, 1e-4), 0.0, 1.0);
          float dn = length(vec2((s - vL) / uW, y));
          float nose = exp(-dn * dn * 5.0);
          float yy = y / (0.25 + 0.75 * k);
          float body = exp(-yy * yy * 9.0) * k * k * step(0.0, s) * step(s, vL);
          float hot = exp(-yy * yy * 55.0) * k * k * k * step(s, vL);
          col = uColor * (body * 1.7 + nose * 2.2) + vec3(1.0) * (hot * 2.4 + nose * nose * 3.2);
        }
        gl_FragColor = vec4(col * uOp, 1.0);
      }
    `,
  });
}

/* Hex-cell energy dome: a stereographic hex lattice (cells keep their shape), a fresnel rim, an
 * activation wave racing out from the hit, then cells dropping out at random. */
function shieldMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color() }, uHit: { value: new THREE.Vector3(0, 0, 1) }, uT: { value: 0 }, uSeed: { value: 0 }, uOp: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform vec3 uHit;
      varying vec3 vN; varying vec3 vV; varying vec3 vH;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * position);
        vV = -mv.xyz;
        vH = normalize((viewMatrix * modelMatrix * vec4(uHit, 0.0)).xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uT, uSeed, uOp;
      varying vec3 vN; varying vec3 vV; varying vec3 vH;
      float hexD(vec2 p) { p = abs(p); return max(dot(p, vec2(0.5, 0.8660254)), p.x); }
      void main() {
        vec3 N = normalize(vN), V = normalize(vV);
        float fres = pow(max(0.0, 1.0 - abs(dot(N, V))), 2.2);
        vec3 Ns = gl_FrontFacing ? N : vec3(N.xy, -N.z);
        vec2 q = Ns.xy / (1.0 + max(Ns.z, -0.5)) * 4.6;
        vec2 rr = vec2(1.0, 1.7320508), hh = rr * 0.5;
        vec2 ga = mod(q, rr) - hh, gb = mod(q - hh, rr) - hh;
        vec2 g = dot(ga, ga) < dot(gb, gb) ? ga : gb;
        vec2 id = q - g;
        float edge = 0.5 - hexD(g);
        float line = 1.0 - smoothstep(0.0, 0.075, edge);
        float rnd = fract(sin(dot(id, vec2(12.9898, 78.233)) + uSeed) * 43758.5453);
        float ang = acos(clamp(dot(N, vH), -1.0, 1.0));
        float front = smoothstep(0.0, 0.42, uT) * 3.5;
        float dw = (ang - front) * 3.2;
        float wave = exp(-dw * dw);
        float on = 1.0 - smoothstep(front - 0.3, front + 0.05, ang);
        float alive = step(smoothstep(0.38, 1.0, uT), rnd);
        float fill = (0.05 + 0.2 * rnd * rnd + 0.45 * wave) * on * alive;
        float lines = line * (0.45 * on + 2.4 * wave) * alive;
        float hit = exp(-ang * ang * 20.0) * (1.0 - smoothstep(0.0, 0.55, uT));
        float rim = fres * mix(0.25, 1.0, on) * (1.0 - uT * 0.75) * (1.0 + wave);
        float k = lines + fill + rim + hit * 2.5;
        if (!gl_FrontFacing) k *= 0.3;
        vec3 c = uColor * k * 1.5 + vec3(1.0) * (lines * wave * 0.8 + hit * hit * 2.0);
        gl_FragColor = vec4(c * uOp, 1.0);
      }
    `,
  });
}

type PoolKind = 'ring' | 'ribbon' | 'shield';
interface Flash { light: THREE.PointLight; age: number; life: number; peak: number }

export class Effects {
  readonly group = new THREE.Group();
  /** World-size multiplier for projectiles and blasts (views far from the action raise it). */
  scale = 1;
  readonly particles = new Particles(5000);
  readonly smoke = new Particles(2000, 'smoke');
  readonly debris = new Debris(7000);
  private timed: Timed[] = [];
  private timers: { t: number; fn: () => void }[] = [];
  private quad = new THREE.PlaneGeometry(2, 2);
  private sphere = new THREE.IcosahedronGeometry(1, 6);
  private pools: Record<PoolKind, THREE.Mesh[]> = { ring: [], ribbon: [], shield: [] };
  private warm: { m: THREE.Mesh; kind: PoolKind }[] = [];
  private warmed = false;
  private flashes: Flash[] = [];
  /** The camera, in group space, as of the last render (lights lean toward it). */
  private eye = new THREE.Vector3(0, 0, 1e4);

  /** `lights`: point lights that flash with blasts and hits (0 for none). */
  constructor(opts: { lights?: number } = {}) {
    this.group.add(this.smoke.points);
    this.group.add(this.particles.points);
    this.group.add(this.debris.mesh);
    for (let i = 0; i < (opts.lights ?? 2); i++) {
      const light = new THREE.PointLight(0xffffff, 0, 10, 2);
      this.group.add(light);
      this.flashes.push({ light, age: 0, life: 0, peak: 0 });
    }
    this.particles.points.onBeforeRender = (_r, _s, cam) => { this.eye.setFromMatrixPosition(cam.matrixWorld); this.group.worldToLocal(this.eye); };
    this.debris.onBounce = (p, speed, heat) => {
      const hotChunk = heat > 0.3;
      for (let k = 0, n = hotChunk ? 3 : 1; k < n; k++) {
        this.particles.spawn({
          pos: p, vel: tmpV.set(rand(-0.6, 0.6) * speed, rand(0.35, 0.8) * speed, rand(-0.6, 0.6) * speed), sprite: 'spark',
          color: hotChunk ? 0xffa850 : 0xfff0d0, size: 0.05, stretch: 0.05, life: rand(0.2, 0.45), drag: 2, gravity: 9, intensity: 2.2, hot: 0.7,
        });
      }
      if (hotChunk && Math.random() < 0.25) this.smoke.spawn({ pos: p, vel: tmpV.set(0, 0.5, 0), color: 0x4c5058, size: 0.28, grow: 2.2, life: rand(0.7, 1.1), heat: heat * 0.7, cool: 3 });
    };
    this.debris.onTrail = (p, v, heat) => {
      this.smoke.spawn({ pos: p, vel: tmpV.copy(v).multiplyScalar(0.08), color: 0x3a3e46, size: 0.16, grow: 2.8, life: rand(0.6, 1.1), heat: heat * 0.9, cool: 3, turb: 1, opacity: 0.75 });
      if (Math.random() < 0.6) this.particles.spawn({ pos: p, vel: tmpV.copy(v).multiplyScalar(0.25), color: 0xff8a3a, size: 0.07, life: rand(0.25, 0.5), gravity: 3, intensity: 2, hot: 0.5 });
    };
    // Compile the pooled shaders with the screen, not mid-battle: one invisible draw of each.
    for (const kind of ['ring', 'ribbon', 'shield'] as PoolKind[]) {
      const m = this.take(kind);
      m.scale.setScalar(1e-3);
      m.onAfterRender = () => { this.warmed = true; };
      this.warm.push({ m, kind });
      this.group.add(m);
    }
  }

  setScale(viewportHeight: number, fovDeg: number) {
    this.particles.setScale(viewportHeight, fovDeg);
    this.smoke.setScale(viewportHeight, fovDeg);
  }

  private add(t: Timed) { this.group.add(t.obj); this.timed.push(t); }

  private take(kind: PoolKind): THREE.Mesh {
    const m = this.pools[kind].pop();
    if (m) return m;
    const mesh = new THREE.Mesh(kind === 'shield' ? this.sphere : this.quad, kind === 'ring' ? ringMaterial() : kind === 'ribbon' ? ribbonMaterial() : shieldMaterial());
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    return mesh;
  }

  private give(kind: PoolKind, m: THREE.Mesh) {
    (m.material as THREE.ShaderMaterial).uniforms.uOp.value = 0;
    if (this.pools[kind].length >= 24) { (m.material as THREE.Material).dispose(); return; }
    m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.setScalar(1);
    this.pools[kind].push(m);
  }

  /** Run `fn` after `delay` seconds of effect time (dropped by clear()). */
  private later(delay: number, fn: () => void) { this.timers.push({ t: delay, fn }); }

  /** A brief point light at `pos`, leaning toward the camera so lit hull faces catch it. */
  private flash(pos: THREE.Vector3, color: THREE.ColorRepresentation, peak: number, life: number, range: number) {
    if (!this.flashes.length) return;
    let best = this.flashes[0], bestI = Infinity;
    for (const f of this.flashes) {
      const k = f.life > 0 ? f.peak * (1 - f.age / f.life) : 0;
      if (k < bestI) { bestI = k; best = f; }
    }
    if (bestI > peak) return;
    const lean = tmpV.copy(this.eye).sub(pos);
    const dist = lean.length();
    best.light.position.copy(pos).addScaledVector(lean, dist > 1e-3 ? Math.min(0.18 * range, dist * 0.5) / dist : 0);
    best.light.color.set(color);
    best.light.distance = range;
    best.peak = peak; best.age = 0; best.life = life;
  }

  ring(pos: THREE.Vector3, color: THREE.ColorRepresentation, radius = 2, life = 0.6, normal = new THREE.Vector3(0, 0, 1),
    opts: { billboard?: boolean; width?: number; intensity?: number } = {}) {
    const m = this.take('ring');
    const u = (m.material as THREE.ShaderMaterial).uniforms;
    const R = radius * 1.06 + 0.15;
    u.uR.value = R; u.uBill.value = opts.billboard ? 1 : 0; u.uSeed.value = Math.random() * 6.28;
    (u.uColor.value as THREE.Color).set(color);
    m.position.copy(pos);
    if (!opts.billboard) m.lookAt(tmpV.copy(pos).add(normal));
    const w = opts.width ?? 1, k = opts.intensity ?? 1;
    const tick = (t: number) => {
      const front = (0.1 + radius * (1 - Math.pow(1 - t, 3))) / R;
      u.uFront.value = front;
      u.uWidth.value = Math.max(0.012, front * 0.075 * w * (1 - t * 0.5));
      u.uOp.value = (1 - t) * 1.2 * k;
    };
    tick(0);
    this.add({ obj: m, age: 0, life, tick, dispose: () => this.give('ring', m) });
  }

  flare(pos: THREE.Vector3, color: THREE.ColorRepresentation, size = 3, life = 0.35) {
    // Star-burst core with rays, plus a faint anamorphic streak across it.
    this.particles.spawn({ pos, color, sprite: 'flare', size: size * 0.42, grow: 2.1, life, fadeIn: 0, fade: 2, intensity: 1.7, core: 2.5, hot: 0.35, stretch: 0 });
    this.particles.spawn({ pos, color, sprite: 'streak', size: size * 0.16, aspect: 9, grow: 1.4, life: life * 0.85, fadeIn: 0, fade: 2.4, intensity: 0.9, core: 1, hot: 0.5 });
  }

  /** An energy beam from a to b: it lances out, ripples, thins and flickers out, with a muzzle
   * flare at a and a splash where it lands. */
  beam(a: THREE.Vector3, b: THREE.Vector3, color: THREE.ColorRepresentation, width = 0.12, life = 0.3) {
    const m = this.take('ribbon');
    const u = (m.material as THREE.ShaderMaterial).uniforms;
    u.uA.value.copy(a); u.uB.value.copy(b); u.uW.value = width * 3.2; u.uStyle.value = 0;
    (u.uColor.value as THREE.Color).set(color);
    const len = a.distanceTo(b), reachT = Math.min(0.08, life * 0.3);
    let age = 0;
    const tick = (t: number, dt: number) => {
      age += dt;
      u.uTime.value += dt;
      u.uReach.value = Math.min(1, age / reachT);
      u.uCore.value = 1 - t * 0.7;
      u.uOp.value = Math.pow(1 - t, 0.7) * (0.82 + Math.random() * 0.36);
    };
    tick(0, 0);
    this.add({ obj: m, age: 0, life, tick, dispose: () => this.give('ribbon', m) });
    this.flare(a, color, width * 22, Math.min(0.3, life));
    const hit = b.clone();
    this.later(reachT * Math.min(1, len / 6), () => {
      this.flare(hit, color, width * 26, 0.3);
      this.particles.burst(hit, 14, { speed: 7, color: [color, 0xffffff], size: 0.07, life: 0.4, drag: 2.5, gravity: 5, sprite: 'spark', stretch: 0.05, intensity: 2.2 });
      this.smoke.burst(hit, 4, { speed: 1, color: 0x4a515c, size: 0.4, life: 1.1, drag: 1.5, grow: 2 });
      this.flash(hit, color, 22, life + 0.1, 8);
    });
  }

  /** Fly a glowing projectile along a quadratic curve; `onArrive` at the end. */
  projectile(opts: {
    from: THREE.Vector3; to: THREE.Vector3; color: THREE.ColorRepresentation; duration: number; arc?: THREE.Vector3;
    kind: 'missile' | 'shell' | 'tracer' | 'torpedo'; onArrive?: () => void; wobble?: number; size?: number; fizzle?: boolean;
  }) {
    const kind = opts.kind, k = this.scale;
    const ctrl = opts.from.clone().lerp(opts.to, 0.5).add(opts.arc ?? new THREE.Vector3());
    const curve = new THREE.QuadraticBezierCurve3(opts.from.clone(), ctrl, opts.to.clone());
    const size = (opts.size ?? (kind === 'shell' ? 0.7 : kind === 'tracer' ? 0.45 : 0.9)) * k;
    const col = new THREE.Color(opts.color);
    // The round itself: a camera-facing streak from just behind it to its hot nose.
    const m = this.take('ribbon');
    const u = (m.material as THREE.ShaderMaterial).uniforms;
    u.uStyle.value = 1; u.uOp.value = 1;
    u.uW.value = size * (kind === 'tracer' ? 0.3 : kind === 'shell' ? 0.36 : 0.32);
    (u.uColor.value as THREE.Color).copy(col);
    const tail = size * (kind === 'tracer' ? 4.2 : kind === 'shell' ? 2.4 : 1.1);
    u.uA.value.copy(opts.from); u.uB.value.copy(opts.from);
    const pos = opts.from.clone(), prev = opts.from.clone(), dir = opts.to.clone().sub(opts.from).normalize();
    const side1 = new THREE.Vector3(), side2 = new THREE.Vector3();
    const wob = opts.wobble ?? 0;
    const seed = Math.random() * 10;
    const gap = (kind === 'missile' ? 0.1 : kind === 'torpedo' ? 0.13 : kind === 'shell' ? 0.22 : 0.3) * k;
    let travelled = 0, acc = 0, n = 0;
    const smokeCol = kind === 'torpedo' ? 0xcfe6f2 : 0xa9afba;
    this.add({
      obj: m, age: 0, life: opts.duration,
      tick: (t, dt) => {
        const e = kind === 'missile' || kind === 'torpedo' ? t * t * (2.2 - 1.2 * t) : t;
        curve.getPoint(Math.min(1, e), tmpV);
        if (wob) {
          const w = Math.sin(t * Math.PI) * wob;
          tmpV.x += Math.sin(t * 24 + seed) * w * 0.3; tmpV.y += Math.cos(t * 19 + seed) * w;
        }
        prev.copy(pos);
        pos.copy(tmpV);
        const step = prev.distanceTo(pos);
        if (step > 1e-5) dir.subVectors(pos, prev).divideScalar(step);
        travelled += step;
        u.uB.value.copy(pos);
        u.uA.value.copy(pos).addScaledVector(dir, -Math.min(tail, travelled + size * 0.2));
        if (dt <= 0) return;
        // Exhaust: a short hot flame licking back from the nozzle.
        if (kind === 'missile') {
          for (let i = 0; i < 2; i++) {
            this.particles.spawn({
              pos: tmpV2.copy(pos).addScaledVector(dir, -size * 0.3), vel: tmpV3.copy(dir).multiplyScalar(-rand(3, 6) * k).add(randDir(tmpV).multiplyScalar(0.6 * k)),
              sprite: 'puff', heat: rand(1.2, 1.5), cool: 1.8, size: size * rand(0.45, 0.7), grow: -0.5, life: rand(0.07, 0.13), drag: 3, stretch: 0.04, soot: 0, hot: 0, fadeIn: 0.05, intensity: 0.8,
            });
          }
          this.particles.spawn({ pos, color: col, sprite: 'glow', size: size * 0.6, life: 0.06, intensity: 1.8, fadeIn: 0, hot: 0.5, stretch: 0 });
        } else if (kind === 'torpedo') {
          this.particles.spawn({ pos, color: col, sprite: 'glow', size: size * 0.8, life: 0.06, intensity: 1.4, fadeIn: 0, hot: 0.3, stretch: 0 });
        }
        // Trail, laid at even spacing whatever the frame rate.
        acc += step;
        // A long frame spreads its samples out rather than queueing a backlog behind the nose.
        const g = Math.max(gap, acc / 12);
        while (acc >= g) {
          acc -= g; n++;
          const q = tmpV2.copy(pos).addScaledVector(dir, -acc);
          if (kind === 'missile') {
            // Smoke that corkscrews off the flight line and curls as it spreads.
            side1.set(0, 1, 0).cross(dir);
            if (side1.lengthSq() < 1e-4) side1.set(1, 0, 0);
            side1.normalize(); side2.copy(dir).cross(side1);
            const ph = seed + travelled * 2.4;
            tmpV3.copy(side1).multiplyScalar(Math.cos(ph) * 0.7 * k).addScaledVector(side2, Math.sin(ph) * 0.7 * k).addScaledVector(dir, -0.5 * k);
            this.smoke.spawn({ pos: q, vel: tmpV3, color: smokeCol, size: size * 0.5, grow: 2.8, life: rand(1.2, 1.9), drag: 1.6, heat: 0.6, cool: 7, turb: 1.4, fadeIn: 0.1, opacity: 0.32 });
            if (n % 3 === 0) this.particles.spawn({ pos: q, vel: randDir(tmpV3).multiplyScalar(0.8 * k), color: 0xffb060, size: 0.06 * k, life: rand(0.25, 0.5), drag: 2, gravity: 1.5, intensity: 1.8 });
          } else if (kind === 'torpedo') {
            this.particles.spawn({ pos: q, vel: randDir(tmpV3).multiplyScalar(0.35 * k).add(tmpV.set(0, 0.5 * k, 0)), sprite: 'bubble', color: 0xbfe6ff, size: rand(0.07, 0.17) * k, life: rand(0.6, 1.3), drag: 2.5, turb: 2.5, intensity: 0.9, hot: 0, stretch: 0 });
            this.particles.spawn({ pos: q, color: col, size: size * 0.4, life: 0.3, drag: 0, intensity: 1.1, hot: 0.2 });
            if (n % 2 === 0) this.smoke.spawn({ pos: q, vel: tmpV3.set(0, 0.25 * k, 0), color: smokeCol, size: size * 0.3, grow: 2.4, life: rand(0.8, 1.2), drag: 1.5, turb: 1.2, opacity: 0.35 });
          } else if (kind === 'shell') {
            this.particles.spawn({ pos: q, vel: tmpV3.copy(dir).multiplyScalar(0.5), stretch: gap * 2.6, color: col, size: size * 0.24, life: 0.22, drag: 0, intensity: 1.1, hot: 0.5 });
            if (n % 3 === 0) this.smoke.spawn({ pos: q, vel: randDir(tmpV3).multiplyScalar(0.2 * k), color: 0x8a919c, size: size * 0.18, grow: 3, life: rand(0.6, 0.9), drag: 1.5, turb: 0.8, opacity: 0.5 });
          } else {
            this.particles.spawn({ pos: q, vel: tmpV3.copy(dir).multiplyScalar(0.5), stretch: gap * 2.6, color: col, size: size * 0.22, life: 0.13, drag: 0, intensity: 1.1, hot: 0.5 });
          }
        }
      },
      dispose: () => this.give('ribbon', m),
      done: () => opts.onArrive?.(),
    });
  }

  /** Big hot explosion in stages: a white flash and light, a billowing fireball that cools to soot,
   * sparks and embers under gravity, shock rings, lingering smoke lit from within, secondary pops. */
  explosion(pos: THREE.Vector3, scale0 = 1, color: THREE.ColorRepresentation = 0xffa040) {
    const s = scale0 * this.scale, c = pos.clone();
    const team = new THREE.Color(color);
    const cnt = (base: number, cap: number) => Math.min(cap, Math.round(base * Math.pow(s, 0.75)));
    const rs = Math.sqrt(s);
    // 1 · Flash: a compact white-hot burst, a light, a team-tinted afterglow, an anamorphic streak.
    this.flash(c, 0xffb070, 11 * s, 0.9, 12 * s);
    // (The flash grows slower than the blast: bloom already spreads it.)
    const fs = Math.pow(s, 0.6) * 1.25;
    this.particles.spawn({ pos: c, color: 0xffffff, sprite: 'glow', size: 1.4 * fs, grow: 1.2, life: 0.12, fadeIn: 0, fade: 2, intensity: 1.8, core: 2, hot: 0 });
    this.particles.spawn({ pos: c, color: 0xfff0d6, sprite: 'flare', size: 2.3 * fs, grow: 1.2, life: 0.3, fadeIn: 0, fade: 2, intensity: 1.0, core: 2.5, hot: 0 });
    this.particles.spawn({ pos: c, color: team, sprite: 'glow', size: 3.2 * fs, grow: 0.7, life: 0.55, fadeIn: 0.02, fade: 1.8, intensity: 0.4, core: 0.3, hot: 0 });
    this.particles.spawn({ pos: c, color: tmpC.copy(team).lerp(WHITE, 0.55), sprite: 'streak', size: 1 * fs, aspect: 9, grow: 1, life: 0.35, fadeIn: 0, fade: 2.2, intensity: 1, hot: 0 });
    // 2 · Fireball: puffs on the blackbody ramp, white → yellow → orange → red → soot.
    for (let i = 0, n = cnt(30, 80); i < n; i++) {
      const dir = randDir(tmpV);
      this.particles.spawn({
        pos: tmpV2.copy(c).addScaledVector(dir, rand(0, 0.5) * s), vel: tmpV3.copy(dir).multiplyScalar(rand(1.2, 5.2) * s),
        sprite: 'puff', heat: rand(0.85, 1.15), cool: rand(1.6, 2.4), size: rand(0.6, 1.1) * s, grow: 2.2, growPow: 2.5, life: rand(0.75, 1.4),
        drag: 3, soot: 0.3, fadeIn: 0.07, fade: 1.8, hot: 0, stretch: 0, spin: rand(-1.6, 1.6), intensity: 0.32,
      });
    }
    for (let i = 0; i < 5; i++) {
      this.particles.spawn({ pos: tmpV2.copy(c).addScaledVector(randDir(tmpV), 0.25 * s), vel: randDir(tmpV3).multiplyScalar(0.8 * s), sprite: 'puff', heat: 1.3, cool: 1.5, size: rand(1.2, 1.7) * s, grow: 0.9, growPow: 2, life: rand(0.3, 0.45), drag: 5, soot: 0.3, fadeIn: 0.02, hot: 0, stretch: 0, intensity: 0.4 });
    }
    // 3 · Sparks thrown hard, embers drifting down.
    const sparkCols = [0xffe6b0, 0xffb060, 0xff8a3a, team.getHex()];
    for (let i = 0, n = cnt(48, 130); i < n; i++) {
      this.particles.spawn({
        pos: c, vel: randDir(tmpV).multiplyScalar(rand(7, 21) * rs), sprite: 'spark', color: sparkCols[(Math.random() * 4) | 0],
        size: rand(0.06, 0.11) * rs, stretch: 0.05, life: rand(0.45, 1.25), drag: 1.1, gravity: 7, intensity: 2.6, core: 1.5, hot: 0.8,
      });
    }
    for (let i = 0, n = cnt(18, 50); i < n; i++) {
      this.particles.spawn({
        pos: tmpV2.copy(c).addScaledVector(randDir(tmpV), rand(0, 0.8) * s), vel: randDir(tmpV3).multiplyScalar(rand(1.5, 6) * rs).add(tmpV.set(0, 1.2, 0)),
        color: Math.random() < 0.5 ? 0xff9a40 : 0xffc070, size: rand(0.08, 0.15) * rs, life: rand(1.2, 2.4), drag: 1.4, gravity: 2, intensity: 2, turb: 2.5, hot: 0.3, stretch: 0.02,
      });
    }
    // 4 · Shock: a team-tinted wave racing out, facing the camera.
    this.ring(c, tmpC.copy(team).lerp(WHITE, 0.3), 3.2 * s, 0.45, undefined, { billboard: true, width: 0.7, intensity: 0.3 });
    // 5 · Smoke: lit orange from inside at first, cooling to grey as it rises and spreads.
    const smokeCols = [0x7c818a, 0x8a847b, 0x6c727e];
    for (let i = 0, n = cnt(16, 42); i < n; i++) {
      const dir = randDir(tmpV);
      this.smoke.spawn({
        pos: tmpV2.copy(c).addScaledVector(dir, rand(0, 0.8) * s), vel: tmpV3.copy(dir).multiplyScalar(rand(1, 2.8) * s).add(tmpV.set(0, 0.45 * s, 0)),
        color: smokeCols[i % 3], size: rand(1.3, 2.2) * s, grow: 2, life: rand(2.8, 4.4), drag: 1.3, gravity: -0.3 * rs,
        heat: rand(0.9, 1.15), cool: 5, turb: 0.9, fadeIn: 0.06, fade: 1.2, opacity: 1,
      });
    }
    // 6 · Secondary detonations ripple out over the next few tenths of a second.
    for (let i = 0, n = s > 1.8 ? 3 : 2; i < n; i++) {
      const at = c.clone().add(randDir(tmpV).multiplyScalar(rand(0.7, 1.5) * s));
      this.later(rand(0.08, 0.36), () => this.pop(at, s * rand(0.35, 0.55), team));
    }
  }

  /** A small secondary blast. */
  private pop(pos: THREE.Vector3, s: number, team: THREE.Color) {
    this.flash(pos, 0xffa860, 25 * s, 0.4, 9 * s);
    this.particles.spawn({ pos, color: 0xfff2dc, sprite: 'flare', size: 2.4 * s, grow: 1.2, life: 0.25, fadeIn: 0, fade: 2, intensity: 1.5, core: 2, hot: 0 });
    for (let i = 0; i < 9; i++) {
      const dir = randDir(tmpV);
      this.particles.spawn({ pos: tmpV2.copy(pos).addScaledVector(dir, 0.2 * s), vel: tmpV3.copy(dir).multiplyScalar(rand(1.5, 4.5) * s), sprite: 'puff', heat: rand(1.0, 1.3), cool: 1.7, size: rand(0.6, 1.1) * s, grow: 1.6, growPow: 2, life: rand(0.35, 0.65), drag: 4, soot: 0.25, fade: 1.8, fadeIn: 0.05, hot: 0, stretch: 0, intensity: 0.4 });
    }
    for (let i = 0; i < 12; i++) this.particles.spawn({ pos, vel: randDir(tmpV).multiplyScalar(rand(6, 14) * Math.sqrt(s)), sprite: 'spark', color: i % 4 ? 0xffc070 : team, size: 0.07, stretch: 0.05, life: rand(0.3, 0.8), drag: 1.3, gravity: 7, intensity: 2.4, hot: 0.8 });
    for (let i = 0; i < 4; i++) this.smoke.spawn({ pos: tmpV2.copy(pos).addScaledVector(randDir(tmpV), 0.3 * s), vel: randDir(tmpV3).multiplyScalar(1.2 * s), color: 0x4a4f58, size: rand(0.9, 1.4) * s, grow: 2, life: rand(1.8, 2.8), drag: 1.4, gravity: -0.25, heat: 0.9, cool: 2.8, turb: 0.9 });
  }

  /** Small impact: hot pinpoint and flare, sparks sprayed back off the hull, a fire puff, smoke. */
  impact(pos: THREE.Vector3, color: THREE.ColorRepresentation, scale0 = 1) {
    const s = scale0 * this.scale, rs = Math.sqrt(s);
    this.flash(pos, color, 16 * s, 0.3, 7 * s);
    this.flare(pos, color, 2 * s, 0.28);
    this.particles.spawn({ pos, color: 0xffffff, sprite: 'glow', size: 0.8 * s, life: 0.09, intensity: 2.4, fadeIn: 0, fade: 1.5, hot: 0, stretch: 0 });
    this.particles.spawn({ pos, color, sprite: 'ring', size: 0.5 * s, grow: 4, growPow: 2, life: 0.24, fadeIn: 0, fade: 1.5, intensity: 1.4, hot: 0.3, stretch: 0 });
    // Sprayed back toward the viewer and up: the half that would fly into the hull is hidden anyway.
    const cols = [color, 0xffd27a, 0xffffff];
    for (let i = 0, n = Math.min(60, Math.round(18 * s)); i < n; i++) {
      const dir = randDir(tmpV).add(tmpV2.set(0, 0.35, 0.6)).normalize();
      this.particles.spawn({
        pos, vel: dir.multiplyScalar(rand(4, 11) * rs), sprite: 'spark', color: cols[i % 3], size: rand(0.045, 0.08) * rs,
        stretch: 0.045, life: rand(0.25, 0.6), drag: 2.2, gravity: 6, intensity: 2.4, core: 1.5, hot: 0.8,
      });
    }
    for (let i = 0, n = Math.max(2, Math.round(4 * s)); i < n; i++) {
      this.particles.spawn({ pos: tmpV2.copy(pos).addScaledVector(randDir(tmpV), 0.15 * s), vel: randDir(tmpV3).multiplyScalar(1.4 * s), sprite: 'puff', heat: rand(0.95, 1.25), cool: 1.6, size: rand(0.35, 0.6) * s, grow: 1.1, growPow: 2, life: rand(0.22, 0.4), drag: 4, soot: 0.3, hot: 0, stretch: 0, intensity: 0.8 });
    }
    for (let i = 0, n = Math.round(6 * s); i < n; i++) {
      this.smoke.spawn({ pos: tmpV2.copy(pos).addScaledVector(randDir(tmpV), 0.15 * s), vel: randDir(tmpV3).multiplyScalar(rand(0.5, 1.5) * rs).add(tmpV.set(0, 0.4, 0.2)), color: 0x59606b, size: rand(0.35, 0.55) * s, grow: 2.2, life: rand(0.9, 1.6), drag: 1.8, heat: 0.6, cool: 4, turb: 0.8 });
    }
  }

  /** A hex-cell energy dome flaring around `pos` (blocks, jams). The wave starts where the hit
   * landed: toward `from` if given, else on the face toward the viewer. */
  shield(pos: THREE.Vector3, color: THREE.ColorRepresentation, radius = 1.6, life = 0.6, from?: THREE.Vector3) {
    const m = this.take('shield');
    const u = (m.material as THREE.ShaderMaterial).uniforms;
    (u.uColor.value as THREE.Color).set(color);
    u.uSeed.value = Math.random() * 50;
    const hit = u.uHit.value as THREE.Vector3;
    if (from) hit.copy(from).sub(pos);
    else hit.copy(this.eye).sub(pos).normalize().add(tmpV.set(rand(-0.5, 0.5), rand(-0.3, 0.5), 0));
    if (hit.lengthSq() < 1e-6) hit.set(0, 0, 1);
    hit.normalize();
    m.position.copy(pos);
    const tick = (t: number) => {
      u.uT.value = t;
      u.uOp.value = 1 - smooth(0.75, 1, t);
      m.scale.setScalar(radius * (0.9 + 0.14 * (1 - Math.pow(1 - t, 3))));
    };
    tick(0);
    this.add({ obj: m, age: 0, life, tick, dispose: () => this.give('shield', m) });
    const hp = pos.clone().addScaledVector(hit, radius * 0.92);
    this.flare(hp, color, radius * 1.3, 0.3);
    this.flash(hp, color, 14 * this.scale, life * 0.7, 6 * radius);
    // Deflected sparks skate off along the surface.
    for (let i = 0; i < 10; i++) {
      tmpV.copy(randDir(tmpV2)).addScaledVector(hit, -tmpV2.dot(hit)).normalize().multiplyScalar(rand(3, 7)).addScaledVector(hit, rand(0.5, 2));
      this.particles.spawn({ pos: hp, vel: tmpV, sprite: 'spark', color: i % 3 ? color : 0xffffff, size: 0.05, stretch: 0.05, life: rand(0.2, 0.45), drag: 3, intensity: 2.2, hot: 0.6 });
    }
  }

  update(dt: number) {
    if (this.warmed && this.warm.length) {
      for (const { m, kind } of this.warm) { this.group.remove(m); m.onAfterRender = () => {}; this.give(kind, m); }
      this.warm = [];
    }
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const tm = this.timers[i];
      tm.t -= dt;
      if (tm.t <= 0) { this.timers.splice(i, 1); tm.fn(); }
    }
    for (let i = this.timed.length - 1; i >= 0; i--) {
      const e = this.timed[i];
      e.age += dt;
      const t = Math.min(1, e.age / e.life);
      e.tick(t, dt);
      if (e.age >= e.life) {
        this.group.remove(e.obj);
        this.timed.splice(i, 1);
        e.dispose?.();
        e.done?.();
      }
    }
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.age += dt;
      const k = f.age / f.life;
      if (k >= 1) { f.life = 0; f.light.intensity = 0; continue; }
      f.light.intensity = f.peak * (k < 0.05 ? k / 0.05 : (1 - k) * (1 - k)) * (0.88 + Math.random() * 0.24);
    }
    this.particles.update(dt);
    this.smoke.update(dt);
    this.debris.update(dt);
  }

  private disposed = false;
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    for (const { m } of this.warm) { this.group.remove(m); (m.material as THREE.Material).dispose(); }
    this.warm = [];
    for (const kind of ['ring', 'ribbon', 'shield'] as PoolKind[]) { for (const m of this.pools[kind]) (m.material as THREE.Material).dispose(); this.pools[kind] = []; }
    this.quad.dispose();
    this.sphere.dispose();
    this.particles.dispose();
    this.smoke.dispose();
    this.debris.dispose();
    for (const f of this.flashes) { this.group.remove(f.light); f.light.dispose(); }
    this.flashes = [];
  }

  /** Drop every running effect (arrival callbacks do not fire). */
  clear() {
    for (const e of this.timed) { this.group.remove(e.obj); e.dispose?.(); }
    this.timed = [];
    this.timers = [];
    for (const f of this.flashes) { f.life = 0; f.light.intensity = 0; }
    this.particles.reset();
    this.smoke.reset();
    this.debris.reset();
  }
}
