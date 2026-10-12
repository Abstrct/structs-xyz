/* Shared deep-space backdrop. The nebula is painted once per (seed, tint) into
 * an HDR-encoded cube map by a heavy shader — domain-warped emission clouds,
 * filaments, dark dust lanes, a Milky-Way band of unresolved stars, distant
 * galaxies — then shown by a one-tap shader, so the sky costs nothing per
 * frame. The starfield on top is a magnitude-graded point cloud with
 * colour temperature and diffraction spikes on the brightest stars. */
import * as THREE from 'three';
import { mulberry } from '../core/util';
import { LOOK, PIXEL_RATIO, softwareGL } from '../core/engine';

export const NOISE_GLSL = /* glsl */ `
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }
  float fbm(vec3 p) {
    float f = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { f += a * snoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
    return f;
  }
`;

/** The galactic plane's normal in sky space: the nebula band and the star density agree on it. */
export const GALACTIC_NORMAL = new THREE.Vector3(0.16, 1, 0.1).normalize();
/** Brightest value the 8-bit sky can hold; texels store sqrt(colour / SKY_RANGE). */
const SKY_RANGE = 6;

const BAKE_FRAG = /* glsl */ `
  ${NOISE_GLSL}
  uniform float uSeed;
  uniform vec3 uTint, uGal;
  varying vec3 vDir;
  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  vec3 hash33(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453123);
  }
  float fbm7(vec3 p) {
    float f = 0.0, a = 0.5;
    for (int i = 0; i < 7; i++) { f += a * snoise(p); p = p * 2.02 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
    return f;
  }
  // Ridged multifractal: bright creased filaments where the noise crosses zero.
  float ridged(vec3 p) {
    float f = 0.0, a = 0.55, w = 1.0;
    for (int i = 0; i < 6; i++) {
      float n = 1.0 - abs(snoise(p));
      n *= n * w;
      w = clamp(n * 1.6, 0.0, 1.0);
      f += a * n; p = p * 2.07 + vec3(4.1, 1.3, 7.7); a *= 0.5;
    }
    return f;
  }
  vec3 starColour(float t) {
    // O/B blue-white → A white → G yellow → K orange → M red
    vec3 c = mix(vec3(0.62, 0.74, 1.0), vec3(1.0, 0.98, 0.95), smoothstep(0.0, 0.35, t));
    c = mix(c, vec3(1.0, 0.86, 0.66), smoothstep(0.45, 0.75, t));
    return mix(c, vec3(1.0, 0.62, 0.42), smoothstep(0.82, 1.0, t));
  }
  // Unresolved stars at roughly one texel each, denser toward the band.
  vec3 starDust(vec3 d, float band, float scale, float density) {
    vec3 cell = floor(d * scale);
    float h = hash13(cell + uSeed * 17.0);
    float thresh = 1.0 - density * (0.25 + 1.6 * band);
    if (h < thresh) return vec3(0.0);
    vec3 r = hash33(cell);
    vec3 c = (cell + 0.2 + r * 0.6) / scale;
    float dist = length(d - normalize(c)) * scale;
    float m = pow((h - thresh) / (1.0 - thresh), 3.0);
    return starColour(r.z) * exp(-dist * dist * 3.0) * (0.05 + 1.4 * m);
  }
  // Faraway galaxies: tilted ellipses with a bright nucleus, sparse.
  vec3 galaxies(vec3 d) {
    float scale = 26.0;
    vec3 cell = floor(d * scale);
    vec3 r = hash33(cell + uSeed * 3.0);
    if (r.x > 0.16) return vec3(0.0);
    vec3 c = normalize((cell + 0.25 + 0.5 * hash33(cell + 7.0)) / scale);
    vec3 diff = d - c;
    vec3 ax = normalize(cross(c, normalize(hash33(cell + 11.0) - 0.5)));
    vec3 ay = cross(c, ax);
    float size = mix(0.0016, 0.0055, r.y * r.y);
    vec2 q = vec2(dot(diff, ax), dot(diff, ay)) / size;
    q.y /= mix(0.18, 0.9, r.z);
    float e = dot(q, q);
    float disk = exp(-e * 1.6), nucleus = exp(-e * 14.0);
    vec3 tone = mix(vec3(1.0, 0.86, 0.7), vec3(0.75, 0.82, 1.0), hash13(cell + 5.0));
    return tone * (disk * 0.22 + nucleus * 0.55);
  }
  void main() {
    vec3 d = normalize(vDir);
    vec3 s = vec3(uSeed * 1.37, uSeed * 2.11 + 3.0, uSeed * 0.73 - 5.0);
    float lat = dot(d, uGal);

    // Domain warp: the clouds fold and curl instead of reading as plain noise.
    vec3 q = d * 1.35 + s;
    vec3 w = vec3(fbm(q), fbm(q + vec3(5.2, 1.3, 2.8)), fbm(q + vec3(1.7, 9.2, 3.4)));
    vec3 p = d * 3.1 + w * 1.3 + s;

    float region = smoothstep(-0.05, 0.6, fbm(d * 0.9 - s * 0.4));       // where the nebulae gather
    float bandW = 2.7 + 0.8 * w.y;
    float bq = lat * bandW + 0.3 * w.x;
    float band = exp(-bq * bq);                                                // the Milky-Way-like plane
    float body = fbm7(p);
    float fil = ridged(p * 1.6 + w * 0.6);
    float oiii = fbm7(p * 1.25 + vec3(9.1, 2.7, 4.4));
    float dust = fbm7(p * 1.15 + vec3(3.1, 7.7, 1.9) + w * 0.5);
    float wisps = ridged(p * 3.1 - w);

    // Base: near-black navy, lifted a touch along the band.
    vec3 col = mix(vec3(0.0045, 0.006, 0.011), vec3(0.008, 0.010, 0.018), d.y * 0.5 + 0.5);

    // Band glow: the summed light of stars too faint to resolve, warm at its spine.
    float bandLight = band * (0.55 + 0.45 * smoothstep(-0.3, 0.6, body));
    col += vec3(0.036, 0.034, 0.038) * bandLight + vec3(0.07, 0.05, 0.035) * pow(band, 5.0) * smoothstep(0.0, 0.7, body);

    // Emission clouds: hydrogen crimson-magenta, ionised-oxygen teal (the tint), plum veils.
    float m = clamp(region * (0.45 + 0.75 * band) + band * 0.18, 0.0, 1.0);
    float ha = pow(smoothstep(0.0, 0.8, body), 2.4);
    float o3 = pow(smoothstep(0.05, 0.75, oiii), 2.6);
    col += vec3(0.26, 0.045, 0.12) * ha * m;
    col += vec3(0.075, 0.035, 0.14) * smoothstep(-0.2, 0.6, body) * m * 0.55;
    col += uTint * o3 * m * (0.08 + 0.2 * band);
    col += mix(vec3(0.55, 0.16, 0.38), uTint * 1.1, smoothstep(-0.2, 0.4, oiii - body)) * pow(fil, 3.2) * m * ha * 0.55;
    col += vec3(0.40, 0.30, 0.55) * pow(wisps, 6.0) * m * 0.12;

    // Bright cores: compact hot knots that bloom.
    float knot = smoothstep(0.42, 0.85, body * 0.7 + fil * 0.5) * region;
    col += mix(vec3(1.0, 0.55, 0.75), vec3(0.75, 0.95, 1.0), o3) * pow(knot, 3.0) * 1.6;

    // Dark nebulae: dust that eats the band and silhouettes the clouds.
    float absorb = smoothstep(-0.05, 0.4, dust) * (0.45 + 0.55 * band) * smoothstep(-0.2, 0.3, region + band);
    col *= 1.0 - 0.92 * absorb;

    // Unresolved stars at two scales, dimmed by the same dust.
    vec3 st = starDust(d, band, 620.0, 0.0045) * 0.55 + starDust(d, band, 300.0, 0.0018) * 0.7;
    col += st * (1.0 - 0.8 * absorb);
    col += galaxies(d) * (1.0 - absorb);

    gl_FragColor = vec4(sqrt(clamp(col / ${SKY_RANGE.toFixed(1)}, 0.0, 1.0)), 1.0);
  }
`;

const skyCache = new Map<string, THREE.WebGLCubeRenderTarget>();
let skyRig: { mat: THREE.ShaderMaterial; scene: THREE.Scene } | null = null;

/* How large to bake procedural textures: full size on a desktop GPU, half on phones and tablets
 * (shared, scarce VRAM), a quarter on a software rasteriser (SwiftShader, llvmpipe), where a
 * full-size bake would hold the main thread for seconds. */
let bakeK: number | null = null;
export function bakeScale(renderer: THREE.WebGLRenderer): number {
  if (bakeK === null) {
    const soft = softwareGL(renderer);
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    bakeK = soft ? 0.25 : coarse ? 0.5 : 1;
  }
  return bakeK;
}

/* Baked textures die with the GL context. A restored context bumps the epoch,
 * and anything baked here or in planet.ts repaints at its next draw. */
let epoch = 0;
let watched: HTMLCanvasElement | null = null;
export function bakeEpoch(renderer: THREE.WebGLRenderer): number {
  if (watched !== renderer.domElement) {
    watched = renderer.domElement;
    watched.addEventListener('webglcontextrestored', () => { epoch++; skyCache.clear(); });
  }
  return epoch;
}

/** Paint (or reuse) the sky cube for a seed and tint. Needs the live renderer, so it runs at first draw. */
function bakeSky(renderer: THREE.WebGLRenderer, seed: number, tint: THREE.Color): THREE.CubeTexture {
  const key = `${seed}|${tint.getHexString()}`;
  let rt = skyCache.get(key);
  if (!rt) {
    // Soft nebulae survive a smaller bake; see bakeScale.
    const size = Math.min(1024 * bakeScale(renderer), renderer.capabilities.maxCubemapSize);
    rt = new THREE.WebGLCubeRenderTarget(size, { generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    // One bake rig for the session: later skies re-render six faces without recompiling the program.
    if (!skyRig) {
      const mat = new THREE.ShaderMaterial({
        side: THREE.BackSide, depthTest: false, depthWrite: false,
        uniforms: { uSeed: { value: 0 }, uTint: { value: new THREE.Color() }, uGal: { value: GALACTIC_NORMAL } },
        vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: BAKE_FRAG,
      });
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat));
      skyRig = { mat, scene };
    }
    skyRig.mat.uniforms.uSeed.value = seed;
    (skyRig.mat.uniforms.uTint.value as THREE.Color).copy(tint);
    const cam = new THREE.CubeCamera(0.1, 10, rt);
    const autoClear = renderer.autoClear;
    renderer.autoClear = true;
    cam.update(renderer, skyRig.scene);
    renderer.autoClear = autoClear;
    skyCache.set(key, rt);
  }
  return rt.texture;
}

export function createNebulaSky(opts: { radius?: number; seed?: number; intensity?: number; tint?: THREE.ColorRepresentation } = {}) {
  const radius = opts.radius ?? 900;
  const seed = opts.seed ?? 3.7;
  const tint = new THREE.Color(opts.tint ?? 0x43cdb6);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uCube: { value: null as THREE.CubeTexture | null },
      uIntensity: { value: (opts.intensity ?? 1.0) * 0.9 },
      uLite: { value: 0 },
      uGal: { value: GALACTIC_NORMAL },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform samplerCube uCube;
      uniform float uIntensity, uLite;
      uniform vec3 uGal;
      varying vec3 vDir;
      void main() {
        vec3 col;
        if (uLite > 0.5) {
          // Software rendering: the baked nebula is too costly, so just the galactic band's glow.
          float b = dot(normalize(vDir), uGal) * 3.0;
          col = vec3(0.006, 0.008, 0.014) + vec3(0.03, 0.028, 0.04) * exp(-b * b);
        } else {
          vec3 e = textureCube(uCube, normalize(vDir)).rgb;
          col = e * e * ${SKY_RANGE.toFixed(1)};
        }
        col *= uIntensity;
        // Sub-LSB dither so the 8-bit gradients never band.
        float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        col += (n - 0.5) * (1.0 / 255.0) * (0.3 + col * 2.0);
        gl_FragColor = vec4(max(col, 0.0), 1.0);
      }
    `,
  });
  // Seen from inside and shaded per pixel: a console-sized sphere is enough in the Dreamcast look.
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, LOOK.dc ? 32 : 64, LOOK.dc ? 16 : 32), mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  // The bake needs the renderer, which only the first draw provides; three supports a nested render here.
  let baked = -1;
  mesh.onBeforeRender = (renderer) => {
    const e = bakeEpoch(renderer);
    if (baked === e) return;
    baked = e;
    if (softwareGL(renderer)) { mat.uniforms.uLite.value = 1; return; }
    mat.uniforms.uCube.value = bakeSky(renderer, seed, tint);
  };
  return mesh;
}

/** The baked sky cube behind a mesh from createNebulaSky (null until its first draw), e.g. for reflections. */
export function skyTexture(sky: THREE.Object3D): THREE.CubeTexture | null {
  const m = (sky as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
  return (m?.uniforms?.uCube?.value as THREE.CubeTexture | null) ?? null;
}

export function createStarfield(count = 6000, radius = 700, seed = 7) {
  const rnd = mulberry(seed);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  // A frame whose y axis is the galactic normal, so stars crowd the same band the nebula paints.
  const n = GALACTIC_NORMAL;
  const t1 = new THREE.Vector3(1, 0, 0).cross(n).normalize();
  const t2 = n.clone().cross(t1).normalize();
  const tmp = new THREE.Color();
  const v = new THREE.Vector3();
  const temps = [
    new THREE.Color(0.62, 0.74, 1.0), new THREE.Color(0.82, 0.88, 1.0), new THREE.Color(1.0, 0.98, 0.95),
    new THREE.Color(1.0, 0.9, 0.74), new THREE.Color(1.0, 0.76, 0.52), new THREE.Color(1.0, 0.6, 0.44),
  ];
  for (let i = 0; i < count; i++) {
    const inBand = rnd() < 0.5;
    const u = inBand ? (rnd() + rnd() + rnd() - 1.5) / 1.5 * 0.22 : rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    v.copy(t1).multiplyScalar(Math.cos(th) * s).addScaledVector(t2, Math.sin(th) * s).addScaledVector(n, u).normalize();
    const r = radius * (0.8 + rnd() * 0.2);
    pos[i * 3] = v.x * r; pos[i * 3 + 1] = v.y * r; pos[i * 3 + 2] = v.z * r;
    // Spectral class: most visible stars are white to yellow; a few hot blues and cool reds.
    const k = rnd();
    const ci = k < 0.08 ? 0 : k < 0.24 ? 1 : k < 0.55 ? 2 : k < 0.8 ? 3 : k < 0.94 ? 4 : 5;
    tmp.copy(temps[ci]).lerp(temps[Math.min(5, ci + 1)], rnd() * 0.5);
    // Magnitude: a steep power law — thousands of faint pinpricks, a handful of beacons.
    const mag = Math.pow(rnd(), 9);
    const bright = 0.35 + 0.65 * Math.pow(rnd(), 0.6) + mag * 2.2;
    col[i * 3] = tmp.r * bright; col[i * 3 + 1] = tmp.g * bright; col[i * 3 + 2] = tmp.b * bright;
    size[i] = 0.8 + Math.pow(rnd(), 3) * 1.6 + mag * 13;
    phase[i] = rnd() * Math.PI * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  g.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPixelRatio: PIXEL_RATIO },
    vertexShader: /* glsl */ `
      attribute float size; attribute float phase; attribute vec3 color;
      uniform float uTime, uPixelRatio;
      varying vec3 vColor; varying float vSpike; varying float vSize;
      void main() {
        float tw = 0.86 + 0.14 * sin(uTime * (0.5 + fract(phase) * 1.8) + phase * 7.0);
        vColor = color * tw;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        // Faint stars stay at least a pixel and a half so they never shimmer out between frames.
        vSize = max(size * 1.5, 1.5);
        vSpike = smoothstep(4.0, 12.0, size);
        gl_PointSize = vSize * uPixelRatio;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor; varying float vSpike; varying float vSize;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        // A tight core whose width tracks the sprite, so every star is a point, not a disc.
        float k = mix(28.0, 120.0, vSpike);
        float core = exp(-d * d * k);
        float halo = exp(-d * 9.0) * 0.28 * vSpike;
        // Four-point diffraction spikes on the beacons, plus a faint diagonal pair.
        vec2 a = abs(c);
        float spikes = (exp(-a.y * 90.0) * pow(max(0.0, 1.0 - a.x * 2.0), 3.0) + exp(-a.x * 90.0) * pow(max(0.0, 1.0 - a.y * 2.0), 3.0)) * vSpike;
        vec2 r = vec2(a.x + a.y, abs(a.x - a.y)) * 0.7071;
        spikes += exp(-r.y * 120.0) * pow(max(0.0, 1.0 - r.x * 2.4), 4.0) * vSpike * 0.25;
        float i = core + halo + spikes * 0.55;
        if (i < 0.004) discard;
        gl_FragColor = vec4(vColor * i * 1.25, i);
      }
    `,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -9;
  return pts;
}

/** Advance time uniforms on anything built here. */
export function tickSpace(objects: THREE.Object3D[], time: number) {
  for (const o of objects) {
    const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
    if (m && m.uniforms && m.uniforms.uTime) m.uniforms.uTime.value = time;
  }
}
