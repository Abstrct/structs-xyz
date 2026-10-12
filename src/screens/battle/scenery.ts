/* The diorama's dressing, tier by tier. Space: a holographic deck seen from
 * below, orbital rubble tumbling past. Air: banks of cloud lit from above,
 * three deep, drifting at their own speeds. Land: real ground — a flat
 * proving strip under the hulls, mesas and terraced buttes behind it, rim-lit
 * against space, boulders, blown dust, and the strip's front cut away to
 * show its strata like a museum diorama. Water: an ocean with swell, ripples,
 * fresnel, the nebula in its reflection, a sun glint and foam on the crests,
 * and the same cutaway at the front — a water column with god rays,
 * caustics and bubbles under a bright meniscus. Down the middle, the energy
 * barrier between the fleets.
 *
 * One noise texture is baked once (shared by every board) and everything
 * samples it; nothing runs fbm per pixel per frame. */
import * as THREE from 'three';
import { AMBIT_COLOR, AMBITS, type Ambit } from '../../data/catalogue';
import { LOOK, PIXEL_RATIO } from '../../core/engine';
import { skyTexture } from '../../gfx/space';

/* ── The shared noise bake ─────────────────────────────────────────────── */
/* 256² RGBA, tiling: r = broad fbm, g = mid fbm, b = fine fbm, a = ridged
 * (creases near 1: caustic webs, fissures). */
let noiseTex: THREE.DataTexture | null = null;
function noiseTexture() {
  if (noiseTex) return noiseTex;
  const S = 256;
  let seed = 0x5eed;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const layer = (base: number, octaves: number, ridge = false) => {
    const out = new Float32Array(S * S);
    let amp = 0.5;
    for (let o = 0; o < octaves; o++) {
      const P = base << o;
      const lat = new Float32Array(P * P);
      for (let i = 0; i < P * P; i++) lat[i] = rnd();
      for (let y = 0; y < S; y++) {
        const fy = (y / S) * P, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
        const y0 = (iy % P) * P, y1 = ((iy + 1) % P) * P;
        for (let x = 0; x < S; x++) {
          const fx = (x / S) * P, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
          const x0 = ix % P, x1 = (ix + 1) % P;
          const a = lat[y0 + x0] + (lat[y0 + x1] - lat[y0 + x0]) * sx;
          const b = lat[y1 + x0] + (lat[y1 + x1] - lat[y1 + x0]) * sx;
          let v = a + (b - a) * sy;
          if (ridge) v = 1 - Math.abs(v * 2 - 1);
          out[y * S + x] += v * amp;
        }
      }
      amp *= 0.5;
    }
    let lo = Infinity, hi = -Infinity;
    for (const v of out) { if (v < lo) lo = v; if (v > hi) hi = v; }
    for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / (hi - lo || 1);
    return out;
  };
  const r = layer(4, 5), g = layer(8, 4), b = layer(16, 4), a = layer(6, 4, true);
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = r[i] * 255; data[i * 4 + 1] = g[i] * 255; data[i * 4 + 2] = b[i] * 255; data[i * 4 + 3] = a[i] * 255;
  }
  noiseTex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = THREE.LinearFilter;
  noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
  noiseTex.generateMipmaps = true;
  noiseTex.anisotropy = 4;
  noiseTex.needsUpdate = true;
  return noiseTex;
}

/* ── Small helpers ─────────────────────────────────────────────────────── */
function hash2(i: number, j: number, s: number) {
  let n = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1442695041)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, s: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number, s: number, oct = 4) {
  let f = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) { f += a * vnoise(x, y, s + i * 17); n += a; x = x * 2.03 + 1.7; y = y * 2.03 + 9.2; a *= 0.5; }
  return f / n;
}
const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** A grid mesh over explicit x and z stations, y from `h`. */
function gridGeometry(xs: number[], zs: number[], h: (x: number, z: number) => number) {
  const pos = new Float32Array(xs.length * zs.length * 3);
  let k = 0;
  for (const z of zs) for (const x of xs) { pos[k++] = x; pos[k++] = h(x, z); pos[k++] = z; }
  const idx: number[] = [];
  const W = xs.length;
  for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < W - 1; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    // Counter-clockwise seen from above (+y), so the face is up and the board camera sees it.
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
const stations = (a: number, b: number, n: number, bias = 1) => Array.from({ length: n + 1 }, (_, i) => a + (b - a) * Math.pow(i / n, bias));

const lin = (hex: number, k = 1) => new THREE.Color(hex).multiplyScalar(k);

const PLAIN_VERT = /* glsl */ `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

/* The swell, shared by the ocean shader and the hulls riding it. */
const WAVE_GLSL = /* glsl */ `
  float wave(vec2 p, float t) {
    return 0.07 * sin(p.x * 0.55 + t * 1.1) + 0.05 * sin(p.x * 1.3 - p.y * 0.9 + t * 1.7)
         + 0.03 * sin(p.x * 2.7 + p.y * 2.1 + t * 2.6) + 0.022 * sin(-p.x * 1.9 + p.y * 3.3 + t * 2.1);
  }
`;
export function waveHeight(x: number, z: number, t: number) {
  return 0.07 * Math.sin(x * 0.55 + t * 1.1) + 0.05 * Math.sin(x * 1.3 - z * 0.9 + t * 1.7)
    + 0.03 * Math.sin(x * 2.7 + z * 2.1 + t * 2.6) + 0.022 * Math.sin(-x * 1.9 + z * 3.3 + t * 2.1);
}

/* World tones (linear) derived from a palette: sea, lowland, highland. */
function tones(palette: [number, number, number], spent: boolean) {
  const [sea, low, high] = palette.map((c) => new THREE.Color(c));
  if (spent) {
    return {
      sand: new THREE.Color(0.11, 0.095, 0.09), rock: new THREE.Color(0.06, 0.05, 0.05), dark: new THREE.Color(0.02, 0.018, 0.02),
      deep: new THREE.Color(0.012, 0.012, 0.016), shallow: new THREE.Color(0.05, 0.045, 0.05),
    };
  }
  // Each world keeps its hues, leaned a little toward ochre, at fixed brightness: a pale desert and a
  // dark jungle expose the same.
  const norm = (c: THREE.Color, L: number) => c.multiplyScalar(L / Math.max(1e-4, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b));
  const sand = norm(high.clone().lerp(new THREE.Color(0.6, 0.4, 0.2), 0.3), 0.2);
  const rock = norm(low.clone().lerp(high, 0.4).lerp(new THREE.Color(0.32, 0.17, 0.08), 0.3), 0.11);
  const dark = norm(low.clone().lerp(new THREE.Color(0.08, 0.04, 0.025), 0.4), 0.022);
  const deep = norm(sea.clone().lerp(new THREE.Color(0.01, 0.04, 0.09), 0.3), 0.012);
  const shallow = norm(sea.clone().lerp(new THREE.Color(0.05, 0.42, 0.52), 0.55), 0.09);
  return { sand, rock, dark, deep, shallow };
}

export interface SceneryOptions {
  halfWidth: number;
  tierY: Record<Ambit, number>;
  palette: [number, number, number];
  seed: number;
  spent: boolean;
}

export class Scenery {
  readonly group = new THREE.Group();
  private mats: THREE.Material[] = [];
  private clocks = new Set<{ value: number }>();
  private pulseU: Record<Ambit, { value: number }[]> = { space: [], air: [], land: [], water: [] };
  private debris: { mesh: THREE.InstancedMesh; items: { p: THREE.Vector3; r: THREE.Euler; w: THREE.Vector3; s: THREE.Vector3; v: number }[] } | null = null;
  private world: { [k: string]: { value: THREE.Color } } = {};
  private spentU = { value: 0 };
  private calm = 1;
  private dummy = new THREE.Object3D();
  readonly halfWidth: number;
  /** Ground level of the land tier and the sea surface (where hulls stand and float). */
  readonly groundY: number;
  readonly seaY: number;

  constructor(private o: SceneryOptions) {
    this.halfWidth = o.halfWidth;
    this.groundY = o.tierY.land - 1.85;
    this.seaY = o.tierY.water - 1.75;
    const t = tones(o.palette, o.spent);
    for (const k of Object.keys(t) as (keyof typeof t)[]) this.world[k] = { value: t[k] };
    this.spentU.value = o.spent ? 1 : 0;
    this.calm = o.spent ? 0 : 1;
    for (const a of ['space', 'air'] as const) this.deck(a);
    this.clouds();
    this.debrisField();
    this.land();
    this.ocean();
    this.curtain();
  }

  private track<T extends THREE.Material>(m: T): T {
    this.mats.push(m);
    const u = (m as unknown as THREE.ShaderMaterial).uniforms;
    if (u?.uTime) this.clocks.add(u.uTime);
    return m;
  }

  /** Recolour ground and sea for another world. */
  paint(palette: [number, number, number], spent: boolean) {
    const t = tones(palette, spent);
    for (const k of Object.keys(t) as (keyof typeof t)[]) this.world[k].value.copy(t[k]);
    this.spentU.value = spent ? 1 : 0;
    this.calm = spent ? 0 : 1;
    for (const m of this.mats) { const u = (m as THREE.ShaderMaterial).uniforms; if (u?.uCalm) u.uCalm.value = this.calm; }
  }

  /** The sea's height offset at a point (0 on a dead, dry world). */
  waveAt(x: number, z: number, t: number) { return waveHeight(x, z, t) * this.calm; }

  pulse(a: Ambit, v: number) { for (const u of this.pulseU[a]) u.value = v; }

  update(dt: number, t: number) {
    for (const c of this.clocks) c.value = t;
    const d = this.debris;
    if (d && dt > 0) {
      const W = this.halfWidth * 1.25;
      d.items.forEach((it, i) => {
        it.p.x += it.v * dt;
        if (it.p.x > W) it.p.x -= W * 2;
        it.r.x += it.w.x * dt; it.r.y += it.w.y * dt; it.r.z += it.w.z * dt;
        this.dummy.position.copy(it.p); this.dummy.rotation.copy(it.r); this.dummy.scale.copy(it.s);
        this.dummy.updateMatrix();
        d.mesh.setMatrixAt(i, this.dummy.matrix);
      });
      d.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    });
    for (const m of this.mats) m.dispose();
    this.mats = []; this.clocks.clear();
  }

  /* ── Holographic decks (space, air) ──────────────────────────────────── */
  private deck(a: Ambit) {
    const HW = this.halfWidth, y = this.o.tierY[a] - 1.9;
    const col = lin(AMBIT_COLOR[a]);
    const pulse = { value: 0 };
    this.pulseU[a].push(pulse);
    // The deck: crisp grid lines that fade before they alias, a scan sweep, a hot front edge.
    const deck = this.track(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: col }, uTime: { value: 0 }, uPulse: pulse, uHalfW: { value: HW } },
      vertexShader: PLAIN_VERT,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uTime, uPulse, uHalfW; varying vec2 vUv; varying vec3 vW;
        float gridLine(vec2 p, float w) {
          vec2 d = fwidth(p);
          vec2 g = abs(fract(p - 0.5) - 0.5) / max(d, vec2(1e-4));
          float l = 1.0 - min(min(g.x, g.y) / w, 1.0);
          return l * (1.0 - smoothstep(0.12, 0.4, max(d.x, d.y)));
        }
        void main() {
          vec2 p = vW.xz;
          float minor = gridLine(p, 1.0), major = gridLine(p / 4.0, 1.3);
          float back = clamp((3.0 - vW.z) / 6.0, 0.0, 1.0);
          float fadeX = smoothstep(uHalfW, uHalfW - 5.0, abs(vW.x));
          float ping = fract(uTime * 0.11);
          float sweep = smoothstep(0.06, 0.0, abs(abs(vW.x) / uHalfW - ping)) * (1.0 - ping);
          float lip = smoothstep(0.35, 0.0, 3.0 - vW.z);
          float a = (minor * 0.18 + major * 0.42) * mix(1.0, 0.25, back) + lip * 0.5 + sweep * 0.35 * (1.0 - back * 0.6);
          a += uPulse * 0.3 * (1.0 - back);
          gl_FragColor = vec4(uColor * a * fadeX * (0.7 + uPulse), 1.0);
        }`,
    }));
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, 6, 1, 1), deck);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(0, y, 0);
    plane.renderOrder = 1;
    this.group.add(plane);
    this.rail(y, 3.0, col, pulse);
    this.uplight(y, -2.9, col, 0.16, 3.2);
  }

  /** The deck's front edge: a crisp energy line with ticks, power flowing out from the barrier. */
  private rail(y: number, z: number, col: THREE.Color, pulse: { value: number }) {
    const HW = this.halfWidth;
    const mat = this.track(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: col }, uTime: { value: 0 }, uPulse: pulse, uHalfW: { value: HW }, uY: { value: y } },
      vertexShader: PLAIN_VERT,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uTime, uPulse, uHalfW, uY; varying vec2 vUv; varying vec3 vW;
        void main() {
          float dy = vW.y - uY;
          float px = fwidth(vW.y);
          float core = 1.0 - smoothstep(0.0, max(px * 1.2, 0.012), abs(dy));
          float halo = exp(-abs(dy) * 14.0) * 0.35;
          float ax = abs(vW.x);
          float tick = step(fract(ax + 0.03), 0.06) * step(-0.09, dy) * step(dy, 0.0) * 0.6;
          float major = step(fract(ax / 4.0 + 0.008), 0.016) * step(-0.17, dy) * step(dy, 0.0);
          float flow = pow(0.5 + 0.5 * sin(ax * 0.9 - uTime * 3.2), 10.0);
          float fadeX = smoothstep(uHalfW, uHalfW - 4.0, ax) * smoothstep(0.4, 1.4, ax);
          vec3 c = uColor * (core * (0.38 + flow * 0.6 + uPulse * 2.0) + halo * (0.24 + flow * 0.36) + (tick + major) * 0.5);
          gl_FragColor = vec4(c * fadeX, 1.0);
        }`,
    }));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, 0.5), mat);
    m.position.set(0, y, z);
    m.renderOrder = 3;
    this.group.add(m);
  }

  /** Soft light rising off a deck behind the hulls: a lit stage, never a wall. */
  private uplight(y: number, z: number, col: THREE.Color, strength: number, height: number) {
    const HW = this.halfWidth;
    const mat = this.track(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: col }, uTime: { value: 0 }, uHalfW: { value: HW }, uK: { value: strength }, uNoise: { value: noiseTexture() } },
      vertexShader: PLAIN_VERT,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uTime, uHalfW, uK; uniform sampler2D uNoise; varying vec2 vUv; varying vec3 vW;
        void main() {
          float h = vUv.y;
          float shafts = texture2D(uNoise, vec2(vW.x * 0.025 + uTime * 0.003, 0.5)).g;
          shafts = 0.55 + 0.9 * smoothstep(0.35, 0.8, shafts);
          float fall = exp(-h * 4.0) * (1.0 - h);
          float fadeX = smoothstep(uHalfW, uHalfW - 7.0, abs(vW.x));
          gl_FragColor = vec4(uColor * fall * shafts * uK * fadeX, 1.0);
        }`,
    }));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, height), mat);
    m.position.set(0, y + height / 2, z);
    this.group.add(m);
  }

  /* ── Air: cloud banks ─────────────────────────────────────────────────── */
  private clouds() {
    const HW = this.halfWidth, base = this.o.tierY.air - 2.6;
    const layers = [
      { z: -9.5, y0: base - 0.9, h: 3.8, speed: 0.0035, scale: 0.055, cover: 0.04, haze: 0.45, alpha: 0.9, seed: 0.13 },
      { z: -5.0, y0: base - 0.7, h: 3.0, speed: 0.006, scale: 0.08, cover: 0.0, haze: 0.18, alpha: 0.95, seed: 0.51 },
      { z: 2.4, y0: base - 0.6, h: 1.6, speed: 0.011, scale: 0.12, cover: -0.12, haze: 0.0, alpha: 0.75, seed: 0.77 },
    ];
    for (const L of layers) {
      const mat = this.track(new THREE.ShaderMaterial({
        transparent: true, depthWrite: false,
        uniforms: {
          uNoise: { value: noiseTexture() }, uTime: { value: 0 }, uSpeed: { value: L.speed }, uScale: { value: L.scale }, uCover: { value: L.cover },
          uSeed: { value: L.seed }, uHazeMix: { value: L.haze }, uAlpha: { value: L.alpha }, uHalfW: { value: HW * 1.15 },
          uY0: { value: L.y0 }, uH: { value: L.h },
          uLit: { value: new THREE.Color(0.66, 0.6, 0.54) }, uShade: { value: new THREE.Color(0.05, 0.06, 0.12) }, uHaze: { value: new THREE.Color(0.03, 0.035, 0.07) },
          uSilver: { value: new THREE.Color(0.95, 0.82, 0.66) }, uSpent: this.spentU,
        },
        vertexShader: PLAIN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D uNoise; uniform float uTime, uSpeed, uScale, uCover, uSeed, uHazeMix, uAlpha, uHalfW, uSpent, uY0, uH;
          uniform vec3 uLit, uShade, uHaze, uSilver; varying vec2 vUv; varying vec3 vW;
          float dens(vec2 p) {
            float b = texture2D(uNoise, p).r;
            float m = texture2D(uNoise, p * 2.3 + vec2(0.31, 0.17)).g;
            float d = texture2D(uNoise, p * 5.7 + vec2(0.11, 0.53)).b;
            return clamp((b * 0.6 + m * 0.27 + d * 0.15 - 0.51) * 2.6 + 0.5, 0.0, 1.0);
          }
          // Signed cloud density at a world point: noise minus height, banks with clear sky between.
          float shapeAt(vec2 w) {
            float h = (w.y - uY0) / uH;
            vec2 p = vec2(w.x * uScale + uTime * uSpeed + uSeed, w.y * uScale * 1.7 + uSeed * 3.0);
            float cov = texture2D(uNoise, vec2(w.x * uScale * 0.3 + uTime * uSpeed * 0.6, uSeed * 2.0)).g;
            return dens(p) - h * 1.2 + uCover + (cov - 0.5) * 1.5 + 0.14;
          }
          void main() {
            float h = vUv.y;
            float shape = shapeAt(vW.xy);
            float a = smoothstep(0.0, 0.2, shape);
            // Light from above: march two steps toward the sun; cloud in the way shades this point.
            float s1 = shapeAt(vW.xy + vec2(-0.12, 0.28)), s2 = shapeAt(vW.xy + vec2(-0.3, 0.75));
            float occl = smoothstep(0.0, 0.35, s1) * 0.5 + smoothstep(0.0, 0.35, s2) * 0.5;
            vec3 col = mix(uLit, uShade, occl * 0.9);
            col *= 0.75 + 0.35 * h;
            // Silver lining: thin edges glow with the sun behind them.
            col += uSilver * (1.0 - smoothstep(0.0, 0.16, shape)) * (1.0 - occl) * 0.55;
            col = mix(col, uHaze, uHazeMix);
            col = mix(col, col * vec3(0.55, 0.42, 0.36), uSpent);
            float fadeX = smoothstep(uHalfW, uHalfW - 7.0, abs(vW.x));
            a *= smoothstep(0.0, 0.3, h) * fadeX * uAlpha;
            gl_FragColor = vec4(col, a);
          }`,
      }));
      const m = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2.3, L.h), mat);
      m.position.set(0, L.y0 + L.h / 2, L.z);
      this.group.add(m);
    }
  }

  /* ── Space: tumbling orbital rubble ──────────────────────────────────── */
  private debrisField() {
    const HW = this.halfWidth, yc = this.o.tierY.space;
    let s = (this.o.seed * 1000) | 0;
    const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const n = Math.round(30 + HW * 0.9);
    const geo = new THREE.IcosahedronGeometry(1, 0);
    // Rough up the rocks so they aren't perfect d20s.
    const p = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) { const k = 0.75 + hash2(Math.round(p.getX(i) * 9), Math.round(p.getY(i) * 9 + p.getZ(i) * 5), 3) * 0.5; p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k); }
    geo.computeVertexNormals();
    const mat = this.track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0.1, flatShading: true }));
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const items: NonNullable<Scenery['debris']>['items'] = [];
    const tint = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const front = rnd() < 0.18;
      const z = front ? 3.5 + rnd() * 3 : -3.5 - rnd() * 8;
      let y = yc - 2.4 + rnd() * 5.2;
      if (front && y > yc - 1.4 && y < yc + 1.4) y = rnd() < 0.5 ? yc - 1.6 - rnd() * 0.9 : yc + 1.6 + rnd() * 0.9;
      const k = (front ? 0.04 + rnd() * 0.1 : 0.06 + Math.pow(rnd(), 2.2) * 0.42);
      items.push({
        p: new THREE.Vector3((rnd() * 2 - 1) * HW * 1.25, y, z),
        r: new THREE.Euler(rnd() * 6, rnd() * 6, rnd() * 6),
        w: new THREE.Vector3((rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.4),
        s: new THREE.Vector3(k * (0.8 + rnd() * 0.6), k * (0.6 + rnd() * 0.5), k * (0.8 + rnd() * 0.5)),
        v: 0.05 + rnd() * 0.18,
      });
      tint.setRGB(0.32, 0.29, 0.27).multiplyScalar(0.6 + rnd() * 0.7);
      if (rnd() < 0.25) tint.lerp(new THREE.Color(0.3, 0.33, 0.4), 0.6);
      mesh.setColorAt(i, tint);
    }
    this.debris = { mesh, items };
    this.update(0.0001, 0);
    this.group.add(mesh);
  }

  /* ── Land: proving ground, mesas, strata ─────────────────────────────── */
  private land() {
    const HW = this.halfWidth, G = this.groundY, seed = Math.floor(this.o.seed * 97) % 1000;
    const front = 3.0;
    // Height above ground level: flat where hulls stand, dunes behind, terraced mesas beyond.
    // Buttes and mesas standing apart: rounded-rectangle footprints with eroded rims, sheer sides
    // and a ledge part way up, scattered through the middle distance.
    const buttes: { x: number; z: number; w: number; d: number; h: number }[] = [];
    {
      const n = Math.round(HW * 0.42);
      for (let i = 0; i < n; i++) {
        const r = (k: number) => hash2(i, k, seed + 101);
        buttes.push({ x: (-1 + (i + 0.2 + r(1) * 0.6) / n * 2) * HW * 1.1, z: -5.2 - r(2) * 3.2, w: 1.2 + r(3) * 3.8, d: 0.9 + r(4) * 1.3, h: 1.1 + r(5) * 2.3 });
      }
    }
    const height = (x: number, z: number) => {
      const near = 0.025 * (vnoise(x * 0.7, z * 0.7, seed) - 0.5) - 0.03 * sstep(1.6, 3.0, z);
      const back = sstep(-1.8, -4.2, z);
      const dunes = back * (0.15 + 0.45 * fbm(x * 0.16, z * 0.3, seed + 5, 3));
      let mesa = 0;
      const erode = (fbm(x * 0.6, z * 0.6, seed + 11, 3) - 0.5) * 0.35;
      for (const b of buttes) {
        const dx = Math.abs(x - b.x) / b.w, dz = Math.abs(z - b.z) / b.d;
        if (dx > 1.4 || dz > 1.4) continue;
        const dd = Math.pow(Math.pow(dx, 4) + Math.pow(dz, 4), 0.25) + erode;
        mesa = Math.max(mesa, b.h * (0.42 * sstep(1.0, 0.9, dd) + 0.58 * sstep(0.78, 0.7, dd)) + 0.2 * sstep(1.25, 0.95, dd));
      }
      const rf = fbm(x * 0.07, 7.7, seed + 31, 3);
      const ridge = sstep(-8.0, -12.0, z) * (0.2 + 1.7 * rf * rf);
      const ends = sstep(HW * 1.15, HW * 0.85, Math.abs(x));
      return near + (dunes + Math.max(mesa, ridge)) * ends;
    };
    // The Dreamcast look builds the ground at a console's density (~8k triangles, not ~31k).
    const xs = stations(-HW * 1.2, HW * 1.2, Math.round(HW * (LOOK.dc ? 4.5 : 9.5)));
    const zs = stations(front, -12.5, LOOK.dc ? 40 : 72, 1.25);
    const geo = gridGeometry(xs, zs, height);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const terr = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      terr[i * 3] = Math.min(1, Math.max(0, y * 0.55 + (fbm(x * 0.3, z * 0.3, seed + 41, 2) - 0.5) * 0.5));
      terr[i * 3 + 1] = y;
      terr[i * 3 + 2] = hash2(Math.round(x * 3), Math.round(z * 3), seed);
    }
    geo.setAttribute('terr', new THREE.BufferAttribute(terr, 3));
    geo.translate(0, G, 0);
    geo.computeVertexNormals();
    const pulse = { value: 0 };
    this.pulseU.land.push(pulse);
    const W = this.world;
    const groundU = {
      uTime: { value: 0 }, uNoise: { value: noiseTexture() }, uSand: W.sand, uRock: W.rock, uDark: W.dark, uSpent: this.spentU,
      uHalfW: { value: HW }, uGrid: { value: lin(AMBIT_COLOR.land) }, uPulse: pulse,
      uRimCol: { value: new THREE.Color(0.95, 0.62, 0.42) }, uHaze: { value: new THREE.Color(0.035, 0.04, 0.075) },
    };
    const ground = this.track(new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0, flatShading: true, transparent: true }));
    ground.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, groundU);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 terr; varying vec3 vTerr; varying vec3 vTW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerr = terr; vTW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', /* glsl */ `#include <common>
          uniform sampler2D uNoise; uniform vec3 uSand, uRock, uDark, uGrid, uRimCol, uHaze; uniform float uTime, uSpent, uHalfW, uPulse;
          varying vec3 vTerr; varying vec3 vTW;`)
        .replace('#include <color_fragment>', /* glsl */ `
          float gN = texture2D(uNoise, vTW.xz * 0.45).b, gB = texture2D(uNoise, vTW.xz * 0.06).r;
          float strata = 0.5 + 0.5 * sin(vTerr.y * 9.0 + gB * 5.0);
          float rk = clamp(vTerr.x + (gB - 0.5) * 0.6, 0.0, 1.0);
          vec3 gC = mix(uSand, uRock, rk * (0.35 + 0.65 * strata));
          gC *= mix(1.0, 0.78 + 0.34 * strata, rk);
          gC = mix(gC, uDark, smoothstep(0.62, 0.95, vTerr.z) * 0.35);
          gC *= 0.8 + 0.4 * gN;
          diffuseColor.rgb *= gC;
          diffuseColor.a *= smoothstep(uHalfW * 1.16, uHalfW * 0.94, abs(vTW.x));`)
        .replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
          // The tactical overlay on the strip the hulls stand on, and a sweep now and then.
          vec2 gP = vTW.xz; vec2 gD = fwidth(gP);
          vec2 gG = abs(fract(gP - 0.5) - 0.5) / max(gD, vec2(1e-4));
          float gL = (1.0 - min(min(gG.x, gG.y) / 1.2, 1.0)) * (1.0 - smoothstep(0.1, 0.35, max(gD.x, gD.y)));
          float gMask = smoothstep(-3.4, -2.2, vTW.z) * smoothstep(3.0, 2.0, vTW.z) * smoothstep(uHalfW, uHalfW - 4.0, abs(vTW.x));
          float gPing = fract(uTime * 0.11 + 0.5);
          float gSweep = smoothstep(0.05, 0.0, abs(abs(vTW.x) / uHalfW - gPing)) * (1.0 - gPing);
          totalEmissiveRadiance += uGrid * (gL * 0.07 + gSweep * 0.18 + uPulse * 0.12) * gMask;
          // Dead worlds: fissures glowing through the ash.
          float gF = pow(texture2D(uNoise, vTW.xz * 0.11).a, 14.0);
          totalEmissiveRadiance += vec3(1.6, 0.42, 0.08) * gF * uSpent * (0.7 + 0.3 * sin(uTime * 1.3 + vTW.x));`)
        .replace('#include <opaque_fragment>', /* glsl */ `
          // Rim: ridgelines against space catch the backlight.
          vec3 gNW = inverseTransformDirection(normal, viewMatrix);
          float gRim = pow(1.0 - saturate(dot(normal, geometryViewDir)), 4.0) * saturate(gNW.y);
          outgoingLight += uRimCol * gRim * 0.9 * smoothstep(-2.0, -5.0, vTW.z);
          // Aerial perspective: distant mesas sink into the haze.
          outgoingLight = mix(outgoingLight, uHaze, smoothstep(-5.0, -12.5, vTW.z) * 0.38);
          #include <opaque_fragment>`);
    };
    ground.customProgramCacheKey = () => 'battle-ground-v1';
    this.clocks.add(groundU.uTime);
    const mesh = new THREE.Mesh(geo, ground);
    mesh.renderOrder = -1;
    this.group.add(mesh);

    // The cutaway: the strip's front face, its strata exposed, broken off underneath in a ragged
    // keel of rock, so the land tier reads as a slab of the world lifted out for display.
    const cx = stations(-HW * 1.2, HW * 1.2, Math.round(HW * (LOOK.dc ? 4.5 : 9.5)));
    const cpos: number[] = [], top: number[] = [], bot: number[] = [], cidx: number[] = [];
    const bottom = G - 1.2;
    cx.forEach((x, i) => {
      const yt = G + height(x, front);
      const j = fbm(x * 0.32, 4.4, seed + 61, 3);
      const spike = Math.pow(vnoise(x * 1.1, 2.7, seed + 67), 6) * 1.1;
      const yb = bottom - (Math.pow(Math.max(0, j - 0.22) * 1.7, 1.6) * 1.7 + spike + vnoise(x * 2.6, 1.1, seed + 63) * 0.22) * sstep(HW * 1.15, HW * 0.8, Math.abs(x));
      cpos.push(x, yt, front, x, yb, front);
      top.push(yt, yt); bot.push(yt - yb, yt - yb);
      if (i) { const a = (i - 1) * 2; cidx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
    });
    const cgeo = new THREE.BufferGeometry();
    cgeo.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3));
    cgeo.setAttribute('top', new THREE.Float32BufferAttribute(top, 1));
    cgeo.setAttribute('bot', new THREE.Float32BufferAttribute(bot, 1));
    cgeo.setIndex(cidx);
    const cut = this.track(new THREE.ShaderMaterial({
      transparent: true, depthWrite: true,
      uniforms: { ...groundU, uRail: { value: lin(AMBIT_COLOR.land) }, uDepth: { value: G - bottom } },
      vertexShader: /* glsl */ `attribute float top; attribute float bot; varying float vTop; varying float vBot; varying vec3 vW; void main(){ vTop = top; vBot = bot; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uNoise; uniform vec3 uSand, uRock, uDark, uRail; uniform float uTime, uSpent, uHalfW, uPulse, uDepth;
        varying float vTop; varying float vBot; varying vec3 vW;
        void main() {
          float d = vTop - vW.y;
          float warp = texture2D(uNoise, vec2(vW.x * 0.018, 0.31)).r * 0.6 + texture2D(uNoise, vec2(vW.x * 0.07, 0.73)).b * 0.2;
          // Beds of uneven thickness, each finely laminated, seams between them.
          float L = d * 2.6 + warp * 1.2 + vW.x * 0.012 + sin(d * 4.0 + warp * 3.0) * 0.25;
          float id = floor(L), f = fract(L);
          float hid = fract(sin(id * 12.9898 + 4.1) * 43758.5453);
          vec3 c = hid < 0.4 ? mix(uSand, uSand * 1.2, hid * 2.5) : hid < 0.75 ? uRock : hid < 0.9 ? mix(uRock, uDark, 0.5) : uDark;
          c *= 0.55 + 0.45 * smoothstep(0.0, 0.07, f);
          // Rock texture: blotchy at two scales, a little cross-bedding inside thick beds.
          float grain = texture2D(uNoise, vW.xy * 0.9).b * 0.6 + texture2D(uNoise, vW.xy * 2.7 + 0.4).g * 0.4;
          c *= 0.7 + 0.6 * grain;
          c *= 0.92 + 0.08 * step(0.5, fract((d + vW.x * 0.12 + warp) * 9.0)) * step(0.5, hid);
          // Joints: dark fissures running down through the beds.
          float joint = smoothstep(0.9, 0.97, texture2D(uNoise, vec2(vW.x * 0.35, d * 0.05 + 0.2)).a);
          c *= 1.0 - joint * 0.55;
          // Pebbles and voids in the rock.
          float peb = smoothstep(0.78, 0.84, texture2D(uNoise, vW.xy * vec2(1.4, 2.8) + 0.3).g);
          c = mix(c, uDark * 0.7, peb * 0.6);
          // Topsoil crust, then depth: the cut darkens and dissolves downward.
          c = mix(c, uRock * 0.6, smoothstep(0.1, 0.02, d));
          c *= mix(1.1, 0.2, smoothstep(0.05, uDepth * 1.6, d));
          // The broken underside catches a little cool light from the sea below.
          c += vec3(0.02, 0.04, 0.07) * smoothstep(vBot - 0.5, vBot, d) * (1.0 - uSpent);
          // Key light grazes the face from the left.
          c *= 0.85 + 0.15 * smoothstep(-uHalfW, uHalfW, -vW.x);
          // Dead worlds: magma veins in the strata.
          float vein = pow(texture2D(uNoise, vW.xy * vec2(0.08, 0.35)).a, 18.0);
          c += vec3(1.8, 0.5, 0.1) * vein * uSpent * smoothstep(0.1, 0.5, d);
          // The lip: lit edge and the land tier's rail riding it.
          float px = fwidth(vW.y);
          float lip = 1.0 - smoothstep(0.0, max(px * 1.5, 0.015), d);
          float ping = fract(uTime * 0.11 + 0.5);
          float sweep = smoothstep(0.05, 0.0, abs(abs(vW.x) / uHalfW - ping)) * (1.0 - ping);
          float tick = step(fract(abs(vW.x) + 0.03), 0.06) * step(d, 0.08) * 0.5;
          c += uRail * (lip * (0.9 + uPulse * 2.0 + sweep * 2.0) + exp(-d * 30.0) * 0.12 + tick * 0.25);
          float fadeX = smoothstep(uHalfW * 1.16, uHalfW * 0.94, abs(vW.x));
          float a = fadeX * smoothstep(vBot + 0.01, vBot - 0.12, d);
          gl_FragColor = vec4(c, a);
        }`,
    }));
    const cutMesh = new THREE.Mesh(cgeo, cut);
    this.group.add(cutMesh);

    // Boulders: behind the line and a few small ones in front.
    let s = seed * 7 + 3;
    const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const n = Math.round(HW * 3.2);
    const rgeo = new THREE.DodecahedronGeometry(1, 0);
    const rmat = this.track(new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true, color: 0xffffff }));
    const rockU = { uRock: W.rock, uDark: W.dark };
    rmat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, rockU);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uRock, uDark;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(uDark, uRock, 0.65) * 1.6;');
    };
    rmat.customProgramCacheKey = () => 'battle-rock-v1';
    const rocks = new THREE.InstancedMesh(rgeo, rmat, n);
    const d = this.dummy, tint = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const frontRow = rnd() < 0.3;
      const z = frontRow ? 1.7 + rnd() * 1.1 : -1.9 - rnd() * 2.2;
      const x = (rnd() * 2 - 1) * HW * 1.05;
      const k = frontRow ? 0.04 + rnd() * 0.09 : 0.06 + Math.pow(rnd(), 2) * 0.32;
      d.position.set(x, G + height(x, z) + k * 0.25, z);
      d.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      d.scale.set(k * (1 + rnd() * 0.6), k * (0.55 + rnd() * 0.4), k * (1 + rnd() * 0.5));
      d.updateMatrix();
      rocks.setMatrixAt(i, d.matrix);
      rocks.setColorAt(i, tint.setScalar(0.7 + rnd() * 0.5));
    }
    this.group.add(rocks);

    // Dust blowing along the ground.
    this.motes(G + 0.05, 0.9, -3.2, 2.8, Math.round(HW * 5), new THREE.Color(1.0, 0.78, 0.55), 0.55, 0.35);
    this.uplight(G + 0.4, -3.8, lin(AMBIT_COLOR.land), 0.07, 2.6);
    this.horizon(G - 0.3, -12.6, 4.6, W.sand, new THREE.Color(0.55, 0.3, 0.15), 0.5);
  }

  /** Dust or sea haze glowing along a tier's horizon, so its far edge stands against light, not void. */
  private horizon(y: number, z: number, height: number, tint: { value: THREE.Color }, warm: THREE.Color, k: number) {
    const HW = this.halfWidth;
    const mat = this.track(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTint: tint, uWarm: { value: warm }, uK: { value: k }, uHalfW: { value: HW }, uTime: { value: 0 }, uNoise: { value: noiseTexture() }, uSpent: this.spentU },
      vertexShader: PLAIN_VERT,
      fragmentShader: /* glsl */ `
        uniform vec3 uTint, uWarm; uniform float uK, uHalfW, uTime, uSpent; uniform sampler2D uNoise; varying vec2 vUv; varying vec3 vW;
        void main() {
          float h = vUv.y;
          float n = texture2D(uNoise, vec2(vW.x * 0.012 + uTime * 0.002, h * 0.3 + 0.1)).r;
          vec3 c = mix(uTint * 1.6, uWarm, 0.55) * (exp(-h * 3.2) * 0.9 + exp(-h * 9.0) * 0.6) * (0.6 + 0.8 * n);
          c = mix(c, vec3(0.5, 0.12, 0.03) * exp(-h * 2.5), uSpent * 0.7);
          float fadeX = smoothstep(uHalfW * 1.15, uHalfW * 0.6, abs(vW.x));
          gl_FragColor = vec4(c * uK * fadeX * smoothstep(0.0, 0.06, h), 1.0);
        }`,
    }));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2.5, height), mat);
    m.position.set(0, y + height / 2, z);
    this.group.add(m);
  }

  /** Drifting motes, animated entirely on the GPU. */
  private motes(y: number, h: number, z0: number, z1: number, n: number, col: THREE.Color, speed: number, size: number) {
    const HW = this.halfWidth;
    const pos = new Float32Array(n * 3), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (hash2(i, 1, 7) * 2 - 1) * HW * 1.1;
      pos[i * 3 + 1] = y + Math.pow(hash2(i, 2, 7), 2) * h;
      pos[i * 3 + 2] = z0 + hash2(i, 3, 7) * (z1 - z0);
      seed[i] = hash2(i, 4, 7);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const mat = this.track(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColor: { value: col }, uSpeed: { value: speed }, uSize: { value: size }, uHalfW: { value: HW * 1.1 }, uPR: PIXEL_RATIO },
      vertexShader: /* glsl */ `
        attribute float seed; uniform float uTime, uSpeed, uSize, uHalfW, uPR; varying float vA;
        void main() {
          vec3 p = position;
          float span = uHalfW * 2.0;
          p.x = mod(p.x + uHalfW + uTime * uSpeed * (0.5 + seed), span) - uHalfW;
          p.y += sin(uTime * (0.6 + seed) + seed * 30.0) * 0.12;
          p.z += cos(uTime * 0.4 + seed * 20.0) * 0.15;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * uPR * (40.0 / -mv.z) * (0.5 + seed);
          vA = smoothstep(uHalfW, uHalfW * 0.8, abs(p.x)) * (0.35 + 0.65 * fract(seed * 7.3));
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying float vA;
        void main() { float r = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, r); gl_FragColor = vec4(uColor * a * a * vA * 0.5, 1.0); }`,
    }));
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    this.group.add(pts);
  }

  /* ── Water: the ocean and its cutaway column ─────────────────────────── */
  private ocean() {
    const HW = this.halfWidth, S = this.seaY, front = 3.2;
    const pulse = { value: 0 };
    this.pulseU.water.push(pulse);
    const W = this.world;
    const u = {
      uTime: { value: 0 }, uNoise: { value: noiseTexture() }, uSky: { value: null as THREE.CubeTexture | null }, uHasSky: { value: 0 },
      uDeep: W.deep, uShallow: W.shallow, uSpent: this.spentU, uCalm: { value: this.calm }, uHalfW: { value: HW }, uPulse: pulse,
      // The glint comes off a sun low behind the board (the slice's own light), so its path lands on this strip.
      uSun: { value: new THREE.Vector3(-0.3, 0.17, -0.94).normalize() }, uSunCol: { value: new THREE.Color(1.0, 0.86, 0.66) },
      uSea: { value: S }, uFront: { value: front }, uRail: { value: lin(AMBIT_COLOR.water) },
    };
    const surface = this.track(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: u,
      vertexShader: /* glsl */ `
        uniform float uTime, uCalm; varying vec3 vW; varying vec3 vN; varying float vH;
        ${WAVE_GLSL}
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          float e = 0.08;
          float h = wave(w.xz, uTime) * uCalm;
          float hx = wave(w.xz + vec2(e, 0.0), uTime) * uCalm, hz = wave(w.xz + vec2(0.0, e), uTime) * uCalm;
          vN = normalize(vec3(-(hx - h) / e, 1.0, -(hz - h) / e));
          w.y += h; vH = h; vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uNoise; uniform samplerCube uSky; uniform float uHasSky, uTime, uSpent, uHalfW, uPulse, uCalm;
        uniform vec3 uDeep, uShallow, uSun, uSunCol, uRail; varying vec3 vW; varying vec3 vN; varying float vH;
        vec3 skyCol(vec3 r) {
          // Horizon mist low, the nebula above it.
          vec3 c = mix(vec3(0.07, 0.09, 0.14), vec3(0.018, 0.03, 0.07), smoothstep(0.0, 0.35, r.y));
          if (uHasSky > 0.5) { vec3 e = textureCube(uSky, r).rgb; c += e * e * 2.6 * smoothstep(0.02, 0.2, r.y); }
          return c;
        }
        void main() {
          vec2 p = vW.xz;
          // Ripples: two noise layers drifting across each other; normals from their slopes.
          vec2 q1 = p * vec2(0.08, 0.2) + vec2(uTime * 0.011, uTime * 0.004);
          vec2 q2 = p * vec2(0.15, 0.34) - vec2(uTime * 0.008, -uTime * 0.006);
          float e = 1.0 / 256.0;
          float a0 = texture2D(uNoise, q1).b, ax = texture2D(uNoise, q1 + vec2(e, 0.0)).b, az = texture2D(uNoise, q1 + vec2(0.0, e)).b;
          float b0 = texture2D(uNoise, q2).g, bx = texture2D(uNoise, q2 + vec2(e, 0.0)).g, bz = texture2D(uNoise, q2 + vec2(0.0, e)).g;
          vec2 slope = vec2(ax - a0 + bx - b0, az - a0 + bz - b0) * 14.0 * uCalm;
          vec3 N = normalize(vN + vec3(-slope.x, 0.0, -slope.y));
          vec3 V = normalize(cameraPosition - vW);
          float ndv = max(dot(N, V), 0.0);
          float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
          vec3 R = reflect(-V, N);
          R.y = abs(R.y);
          vec3 refl = skyCol(R);
          float sd = max(dot(R, uSun), 0.0);
          // The board is seen at a grazing angle, so only a tight glint: broad lobes would sheet the whole sea white.
          vec3 glint = uSunCol * (pow(sd, 900.0) * 10.0 + pow(sd, 160.0) * 0.3 + pow(sd, 30.0) * 0.025);
          float crest = clamp(vH * 5.5 + 0.5, 0.0, 1.0);
          vec3 body = mix(uDeep, uShallow, crest * 0.75 + 0.1);
          body += vec3(0.03, 0.3, 0.32) * pow(crest, 3.0) * 0.5 * uCalm;
          vec3 col = mix(body, refl, F) + glint * uCalm;
          // Foam on the crests, broken up and drifting.
          float fn = texture2D(uNoise, p * vec2(0.22, 0.55) + vec2(uTime * 0.018, 0.0)).r;
          float foam = smoothstep(0.08, 0.135, vH + (fn - 0.5) * 0.13) * smoothstep(0.35, 0.72, texture2D(uNoise, p * 0.65 - uTime * 0.025).b);
          col = mix(col, vec3(0.8, 0.9, 1.0), foam * 0.75 * uCalm);
          // A faint tactical wash and the pulse when a hull lands.
          col += uRail * uPulse * 0.25 * smoothstep(-3.0, 2.0, vW.z);
          // Dead seabed: cracked, with embers in the cracks.
          float crack = pow(texture2D(uNoise, p * 0.12).a, 12.0);
          col += vec3(1.4, 0.35, 0.06) * crack * uSpent;
          float fadeX = smoothstep(uHalfW * 1.16, uHalfW * 0.94, abs(vW.x));
          float fadeBack = smoothstep(-5.3, -3.6, vW.z);
          float a = mix(0.86, 0.98, F) * fadeX * fadeBack;
          gl_FragColor = vec4(col, mix(a, fadeX * fadeBack, uSpent));
        }`,
    }));
    const xs = stations(-HW * 1.2, HW * 1.2, Math.round(HW * (LOOK.dc ? 4 : 8)));
    const zs = stations(front, -5.4, LOOK.dc ? 18 : 30);
    const sgeo = gridGeometry(xs, zs, () => 0);
    const sea = new THREE.Mesh(sgeo, surface);
    sea.position.y = S;
    sea.renderOrder = 2;
    // The nebula behind the board, mirrored: borrow the screen's baked sky once it exists.
    // Checked every draw (a handful of children): a restored GL context re-bakes the sky into a new cube.
    sea.onBeforeRender = (_r, scene) => {
      for (const c of scene.children) {
        const tex = skyTexture(c);
        if (tex) { if (u.uSky.value !== tex) { u.uSky.value = tex; u.uHasSky.value = 1; } break; }
      }
    };
    this.group.add(sea);

    // The cutaway water column under a bright meniscus.
    const cpos: number[] = [], edge: number[] = [], cidx: number[] = [];
    const bottom = S - 1.9;
    xs.forEach((x, i) => {
      cpos.push(x, S, front, x, bottom, front);
      edge.push(1, 0);
      if (i) { const a = (i - 1) * 2; cidx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
    });
    const cgeo = new THREE.BufferGeometry();
    cgeo.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3));
    cgeo.setAttribute('edge', new THREE.Float32BufferAttribute(edge, 1));
    cgeo.setIndex(cidx);
    const column = this.track(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { ...u, uDepth: { value: S - bottom } },
      vertexShader: /* glsl */ `
        attribute float edge; uniform float uTime, uCalm, uSea, uFront; varying vec3 vW; varying float vD;
        ${WAVE_GLSL}
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          float top = uSea + wave(vec2(w.x, uFront), uTime) * uCalm;
          if (edge > 0.5) w.y = top;
          vD = top - w.y; vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uNoise; uniform float uTime, uSpent, uHalfW, uPulse, uDepth, uCalm; uniform vec3 uDeep, uShallow, uRail;
        varying vec3 vW; varying float vD;
        void main() {
          float d = max(vD, 0.0);
          vec3 c = mix(uShallow * 0.3, uDeep * 0.18, smoothstep(0.0, uDepth * 0.6, d));
          // God rays slanting down from the surface.
          float sh = texture2D(uNoise, vec2(vW.x * 0.03 + d * 0.035 + uTime * 0.004, 0.37)).g;
          sh = pow(smoothstep(0.45, 0.85, sh), 2.0);
          c += vec3(0.12, 0.38, 0.5) * sh * exp(-d * 1.3) * 0.45 * uCalm;
          // Caustic web near the top.
          vec2 q = vec2(vW.x * 0.09, d * 0.25);
          float ca = min(texture2D(uNoise, q + vec2(uTime * 0.012, 0.0)).a, texture2D(uNoise, q * 1.3 - vec2(uTime * 0.009, 0.31)).a);
          c += vec3(0.3, 0.65, 0.8) * pow(ca, 7.0) * exp(-d * 2.6) * 0.5 * uCalm;
          // Bubbles rising.
          vec2 cell = vec2(vW.x * 3.0, d * 3.0 + uTime * 0.5);
          vec2 id = floor(cell), f = fract(cell) - 0.5;
          float h = fract(sin(dot(id, vec2(41.3, 289.1))) * 43758.5);
          float bub = step(0.93, h) * smoothstep(0.12, 0.06, length(f + vec2(sin(uTime * 2.0 + h * 30.0) * 0.15, 0.0)));
          c += vec3(0.6, 0.9, 1.0) * bub * 0.35 * smoothstep(uDepth, 0.2, d) * uCalm;
          // Meniscus: the surface seen edge-on, bright.
          float px = fwidth(vW.y);
          float men = 1.0 - smoothstep(0.0, max(px * 1.5, 0.014), d);
          c += (vec3(0.55, 0.8, 0.95) * 0.75 + uRail * uPulse * 2.0) * men * uCalm;
          c += uRail * exp(-d * 18.0) * 0.12;
          // Dead seabed in section: dry rock with a glowing seam.
          vec3 dry = mix(vec3(0.07, 0.06, 0.06), vec3(0.02), smoothstep(0.0, uDepth, d)) + vec3(1.5, 0.4, 0.08) * pow(texture2D(uNoise, vW.xy * vec2(0.08, 0.4)).a, 16.0);
          c = mix(c, dry, uSpent);
          float fadeX = smoothstep(uHalfW * 1.16, uHalfW * 0.94, abs(vW.x));
          float a = fadeX * mix(0.92, 0.0, smoothstep(uDepth * 0.3, uDepth, d));
          gl_FragColor = vec4(c, a);
        }`,
    }));
    const col = new THREE.Mesh(cgeo, column);
    col.renderOrder = 2;
    col.frustumCulled = false;
    this.group.add(col);

    // Sea mist hiding the far edge, and a cool uplight over the swell.
    this.uplight(S - 0.1, -5.1, new THREE.Color(0.35, 0.55, 0.85), 0.2, 2.6);
    this.horizon(S - 0.2, -5.4, 3.2, W.shallow, new THREE.Color(0.28, 0.42, 0.62), 0.6);
  }

  /* ── The barrier between the fleets ──────────────────────────────────── */
  private curtain() {
    const H = (this.o.tierY.space - this.o.tierY.water) + 5.2 + 2;
    const yc = (this.o.tierY.space + this.o.tierY.water) / 2;
    const decks = AMBITS.map((a) => this.o.tierY[a] - 1.9);
    const mat = this.track(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uDecks: { value: new THREE.Vector4(decks[0], decks[1], decks[2], decks[3]) }, uH: { value: H }, uYc: { value: yc } },
      vertexShader: PLAIN_VERT,
      fragmentShader: /* glsl */ `
        uniform float uTime, uH, uYc; uniform vec4 uDecks; varying vec2 vUv; varying vec3 vW;
        float hexEdge(vec2 p) {
          p.y *= 1.1547; p.x += mod(floor(p.y), 2.0) * 0.5;
          vec2 f = abs(fract(p) - 0.5);
          return smoothstep(0.38, 0.5, max(f.y * 1.5 + f.x, f.x * 2.0));
        }
        void main() {
          float x = (vUv.x - 0.5) * 3.2;
          float y = vW.y;
          float px = fwidth(x);
          float core = 1.0 - smoothstep(0.0, max(px * 1.4, 0.012), abs(x));
          float glow = exp(-abs(x) * 3.2);
          float hex = hexEdge(vec2(x * 2.4, y * 2.4 - uTime * 0.25)) * exp(-abs(x) * 1.6);
          float shimmer = 0.5 + 0.5 * sin(y * 0.8 - uTime * 1.3 + sin(y * 2.3 + uTime) * 0.8);
          float packets = pow(0.5 + 0.5 * sin(y * 0.9 - uTime * 3.0), 16.0) + pow(0.5 + 0.5 * sin(-y * 0.6 - uTime * 2.1 + 1.7), 20.0);
          vec4 dd = abs(vec4(y) - uDecks);
          float nodes = dot(exp(-dd * dd * 40.0), vec4(1.0)) * exp(-abs(x) * 6.0);
          vec3 side = mix(vec3(0.26, 0.80, 0.71), vec3(0.93, 0.42, 0.35), step(0.0, x));
          vec3 c = side * (glow * (0.035 + 0.05 * shimmer) + hex * 0.07 * shimmer + packets * glow * 0.2 + nodes * 0.5);
          c += mix(vec3(1.0), side, 0.5) * core * (0.3 + packets * 0.55 + 0.1 * shimmer);
          float fade = smoothstep(0.0, 0.07, vUv.y) * smoothstep(1.0, 0.93, vUv.y);
          gl_FragColor = vec4(c * fade, 1.0);
        }`,
    }));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3.2, H), mat);
    m.position.set(0, yc, 0);
    m.renderOrder = 4;
    this.group.add(m);
    // The barrier itself, running back into the board: seen edge-on from the middle, a shimmering
    // wall once the camera moves off to one side.
    const wall = this.track(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: PLAIN_VERT,
      fragmentShader: /* glsl */ `
        uniform float uTime; varying vec2 vUv; varying vec3 vW;
        float hexEdge(vec2 p) {
          p.y *= 1.1547; p.x += mod(floor(p.y), 2.0) * 0.5;
          vec2 f = abs(fract(p) - 0.5);
          return smoothstep(0.4, 0.5, max(f.y * 1.5 + f.x, f.x * 2.0));
        }
        void main() {
          float hex = hexEdge(vec2(vW.z * 1.6, vW.y * 1.6 - uTime * 0.2));
          float wave = 0.5 + 0.5 * sin(vW.y * 0.7 - uTime * 1.6 + vW.z * 0.9);
          float fade = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x) * smoothstep(0.0, 0.06, vUv.y) * smoothstep(1.0, 0.94, vUv.y);
          vec3 c = vec3(0.45, 0.62, 0.95) * (0.025 + hex * 0.07 * wave + pow(wave, 8.0) * 0.05);
          gl_FragColor = vec4(c * fade, 1.0);
        }`,
    }));
    const w = new THREE.Mesh(new THREE.PlaneGeometry(7, H), wall);
    w.rotation.y = Math.PI / 2;
    w.position.set(0, yc, 0);
    w.renderOrder = 4;
    this.group.add(w);
  }
}
