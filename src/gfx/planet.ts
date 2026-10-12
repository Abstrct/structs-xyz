/* A world seen from orbit. Its surface — domain-warped continents, ridged
 * ranges, shelves and shallows, ice caps — and a data layer (ocean mask,
 * city lights or lava, cloud cover) are painted once per world into two
 * cube maps by heavy bake shaders. The per-frame shaders only sample them:
 * relief lighting from the baked height, a sun glint on the seas, cloud
 * shadows, lights on the night side, haze at the limb, a separate cloud
 * shell for parallax, and a single-scattering atmosphere whose blue day
 * side burns orange along the terminator. A spent world is basalt split
 * by glowing fissures under a thin brown haze. */
import * as THREE from 'three';
import { NOISE_GLSL, bakeEpoch, bakeScale } from './space';
import { LOOK, softwareGL } from '../core/engine';

export interface PlanetOptions {
  radius: number;
  /** Sea, lowland, highland. */
  palette: [number, number, number];
  seed: number;
  spent?: boolean;
  /** World-space direction toward the sun. */
  sun?: THREE.Vector3;
  /** Atmosphere colour (the day-side scattering tint). */
  atmosphere?: THREE.ColorRepresentation;
  /** Axial tilt (x, z radians): which latitudes face the viewer. */
  tilt?: [number, number];
  /** Surface cube face size in texels (default 1024; the data cube is ¾ of it). Small or dim planets need less. */
  detail?: number;
}

const BAKE_COMMON = /* glsl */ `
  ${NOISE_GLSL}
  uniform float uSeed, uSpent;
  uniform vec3 uSea, uLow, uHigh;
  varying vec3 vDir;
  float fbm7(vec3 p) { float f = 0.0, a = 0.5; for (int i = 0; i < 7; i++) { f += a * snoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return f; }
  float ridged(vec3 p) {
    float f = 0.0, a = 0.6, w = 1.0;
    for (int i = 0; i < 6; i++) { float n = 1.0 - abs(snoise(p)); n *= n * w; w = clamp(n * 1.8, 0.0, 1.0); f += a * n; p = p * 2.1 + vec3(4.1, 1.3, 7.7); a *= 0.5; }
    return f;
  }
  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  // The terrain both bakes agree on: x = elevation (sea level 0), y = moisture, z = mountain ridge.
  vec3 terrain(vec3 d) {
    vec3 s = vec3(uSeed * 1.31, uSeed * 0.77 + 2.0, uSeed * 1.93 - 1.0);
    vec3 q = d * 1.25 + s;
    vec3 w = vec3(fbm(q), fbm(q + vec3(5.2, 1.3, 2.8)), fbm(q + vec3(1.7, 9.2, 3.4)));
    float cont = fbm7(d * 1.9 + w * 0.7 + s) + 0.08;
    float ridge = ridged(d * 4.2 + w * 1.4 + s);
    float detail = fbm7(d * 11.0 + w + s);
    float land = smoothstep(-0.02, 0.25, cont);
    float h = cont + ridge * 0.34 * land + detail * 0.07;
    float moist = fbm(d * 3.1 - s + w * 0.8);
    return vec3(h, moist, ridge * land);
  }
`;

/* Cube A: rgb = albedo (sqrt-encoded), a = elevation (0.5 = sea level). */
const BAKE_SURFACE = /* glsl */ `
  ${BAKE_COMMON}
  void main() {
    vec3 d = normalize(vDir);
    vec3 t = terrain(d);
    float h = t.x, moist = t.y;
    float lat = abs(d.y);
    vec3 col;
    if (uSpent > 0.5) {
      // Basalt plains, ash fields and scorched highlands.
      vec3 ash = vec3(0.045, 0.040, 0.038), basalt = vec3(0.020, 0.018, 0.018), rust = vec3(0.10, 0.045, 0.025);
      col = mix(basalt, ash, smoothstep(-0.3, 0.4, h));
      col = mix(col, rust, smoothstep(0.1, 0.6, moist) * 0.6);
      col *= 0.75 + 0.5 * fbm(d * 30.0 + uSeed);
    } else {
      vec3 low = uLow * 2.1, high = uHigh * 1.55;
      // Lowlands drift between the palette's two land tones with moisture; ridges bare their rock.
      vec3 wet = mix(low, low * vec3(0.75, 1.05, 0.8), 0.5);
      vec3 landCol = mix(wet, low * 1.25, smoothstep(-0.4, 0.5, moist));
      landCol = mix(landCol, high, smoothstep(0.12, 0.55, h));
      landCol = mix(landCol, high * 0.62 + vec3(0.02), smoothstep(0.35, 0.8, t.z) * 0.7);
      // Beaches and pale coastal flats.
      landCol = mix(landCol, mix(high, vec3(0.62, 0.55, 0.42), 0.35), smoothstep(0.045, 0.0, h) * 0.6);
      landCol *= 0.82 + 0.36 * fbm(d * 24.0 + uSeed);
      // Seas: turquoise shelves over the continental margin, deep water beyond.
      float depth = clamp(-h, 0.0, 1.0);
      vec3 shelf = mix(uSea * 1.6, vec3(0.06, 0.26, 0.30), 0.45);
      vec3 sea = mix(shelf, uSea * 0.55, smoothstep(0.0, 0.22, depth));
      col = h > 0.0 ? landCol : sea;
      // Ice: polar caps with ragged edges, and snow on the highest peaks.
      float cap = smoothstep(0.80, 0.86, lat + 0.06 * fbm(d * 9.0 + uSeed));
      float snow = smoothstep(0.55, 0.75, h) * step(0.0, h);
      col = mix(col, vec3(0.80, 0.84, 0.88), max(cap, snow * 0.85));
    }
    gl_FragColor = vec4(sqrt(clamp(col, 0.0, 1.0)), clamp(h * 0.5 + 0.5, 0.0, 1.0));
  }
`;

/* Cube B: r = ocean, g = city lights (lava on a spent world), b = cloud cover. */
const BAKE_DATA = /* glsl */ `
  ${BAKE_COMMON}
  void main() {
    vec3 d = normalize(vDir);
    vec3 t = terrain(d);
    float h = t.x;
    float lat = abs(d.y);
    float ocean = uSpent > 0.5 ? 0.0 : smoothstep(0.004, -0.004, h);
    float lights;
    float cloud;
    if (uSpent > 0.5) {
      // Fissures: thin glowing seams where the crust split, brightest in the lowlands.
      float crack = 1.0 - abs(snoise(d * 7.0 + vec3(uSeed)) + 0.35 * snoise(d * 19.0 - vec3(uSeed)));
      lights = pow(smoothstep(0.86, 1.0, crack), 2.0) * smoothstep(0.4, -0.2, h);
      lights += pow(smoothstep(0.93, 1.0, 1.0 - abs(snoise(d * 23.0 + vec3(uSeed * 2.0)))), 3.0) * 0.4;
      cloud = smoothstep(0.35, 0.9, fbm(d * 2.5 + vec3(uSeed))) * 0.25;
    } else {
      // Settlements crowd temperate coasts and river lowlands, never ice or high peaks.
      float coast = smoothstep(0.16, 0.0, h) * step(0.0, h);
      float pop = smoothstep(0.25, 0.7, fbm(d * 5.0 + vec3(uSeed * 3.0)) + coast * 0.35 - smoothstep(0.3, 0.6, h) * 0.5);
      lights = clamp(pop * (0.25 + coast * 0.9), 0.0, 1.0) * step(0.0, h) * smoothstep(0.78, 0.7, lat);
      // Clouds: warped fbm with banded latitudes and a few spiralling storms.
      vec3 s = vec3(uSeed * 0.9 + 11.0);
      vec3 q = d * 2.2 + s;
      vec3 w = vec3(fbm(q), fbm(q + 4.3), fbm(q + 8.1));
      float c = fbm7(d * vec3(2.4, 4.6, 2.4) + w * 1.25 + s);
      float bands = 0.1 * sin(d.y * 14.0 + w.x * 3.0);
      // Cumulus masses with soft shoulders, then thin cirrus streaks combed along the latitudes.
      float cum = smoothstep(-0.22, 0.75, c + bands + 0.14 * fbm(d * 16.0 + s));
      float cirrus = smoothstep(0.0, 0.7, fbm(d * vec3(2.0, 11.0, 2.0) + w * 2.0 - s)) * 0.45;
      cloud = max(cum * 0.95, cirrus * (1.0 - cum * 0.5));
      cloud *= 0.6 + 0.4 * smoothstep(0.15, 0.7, lat + 0.25);
    }
    gl_FragColor = vec4(ocean, lights, clamp(cloud, 0.0, 1.0), 1.0);
  }
`;

const BAKE_VERT = /* glsl */ `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/* One bake rig for every planet: the box, its scene and one material per bake shader live for
 * the session, so repainting a world re-renders twelve faces but never recompiles a program. */
const BAKE_UNIFORMS = {
  uSeed: { value: 0 }, uSpent: { value: 0 },
  uSea: { value: new THREE.Color() }, uLow: { value: new THREE.Color() }, uHigh: { value: new THREE.Color() },
};
const bakeMats = new Map<string, THREE.ShaderMaterial>();
let bakeRig: { box: THREE.Mesh; scene: THREE.Scene } | null = null;

function bakeCube(renderer: THREE.WebGLRenderer, size: number, frag: string, target?: THREE.WebGLCubeRenderTarget) {
  const rt = target ?? new THREE.WebGLCubeRenderTarget(Math.min(Math.round(size * bakeScale(renderer)), renderer.capabilities.maxCubemapSize), {
    generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
  });
  let mat = bakeMats.get(frag);
  if (!mat) {
    mat = new THREE.ShaderMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false, uniforms: BAKE_UNIFORMS, vertexShader: BAKE_VERT, fragmentShader: frag });
    bakeMats.set(frag, mat);
  }
  if (!bakeRig) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
    const scene = new THREE.Scene();
    scene.add(box);
    bakeRig = { box, scene };
  }
  bakeRig.box.material = mat;
  const cam = new THREE.CubeCamera(0.1, 10, rt);
  const autoClear = renderer.autoClear;
  renderer.autoClear = true;
  cam.update(renderer, bakeRig.scene);
  renderer.autoClear = autoClear;
  return rt;
}

const SURFACE_VERT = /* glsl */ `
  varying vec3 vObjN; varying vec3 vN; varying vec3 vWorld;
  void main() {
    vObjN = normal;
    vN = normalize(mat3(modelMatrix) * normal);
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const SURFACE_FRAG = /* glsl */ `
  ${NOISE_GLSL}
  uniform samplerCube uA, uB;
  uniform vec3 uSun, uSunObj, uAtmo, uSea;
  uniform float uSpent, uCloudRot, uTime, uTexel, uReady, uLite;
  uniform mat3 uRot;
  uniform vec3 uLand;
  varying vec3 vObjN; varying vec3 vN; varying vec3 vWorld;
  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
  void main() {
    vec3 n = normalize(vObjN);
    if (uLite > 0.5) {
      // Software rendering: no baked terrain — sea and land bands, lit, with a hazy limb.
      vec3 Nw = normalize(vN), V = normalize(cameraPosition - vWorld);
      float land = step(0.15, sin(n.x * 5.0 + sin(n.y * 4.0) * 1.6) * cos(n.z * 4.0 - n.y * 2.0));
      vec3 alb = mix(uSea * 1.3, uLand * 1.6, land);
      if (uSpent > 0.5) alb = vec3(0.05, 0.045, 0.04);
      vec3 c = alb * max(dot(Nw, normalize(uSun)), 0.0) * 1.2 + alb * vec3(0.012, 0.016, 0.03);
      float rim = pow(clamp(1.0 - dot(Nw, V), 0.0, 1.0), 3.0);
      c = mix(c, uAtmo * 0.3, rim * 0.5);
      gl_FragColor = vec4(c, 1.0);
      return;
    }
    vec4 A = textureCube(uA, n);
    vec4 B = textureCube(uB, n);
    vec3 albedo = A.rgb * A.rgb;
    float ocean = B.r;

    // Relief: the baked elevation's slope, plus a pinch of fine noise on land.
    vec3 t1 = normalize(cross(abs(n.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0), n));
    vec3 t2 = cross(n, t1);
    // A three-texel step: wide enough that 8-bit height steps don't print as contour terraces.
    float e = uTexel * 3.0;
    float h0 = A.a;
    float hx = textureCube(uA, normalize(n + t1 * e)).a, hy = textureCube(uA, normalize(n + t2 * e)).a;
    float landK = 1.0 - ocean;
    vec2 grad = vec2(hx - h0, hy - h0) / e * 0.017 * landK;
    vec3 Nw = normalize(vN);
    // The tangents in world space, from the same per-fragment frame the height was sampled in.
    vec3 T1 = normalize(uRot * t1), T2 = normalize(uRot * t2);
    vec3 Nb = normalize(Nw - (T1 * grad.x + T2 * grad.y));

    vec3 L = normalize(uSun);
    vec3 V = normalize(cameraPosition - vWorld);
    float ndlGeo = dot(Nw, L);
    float ndl = max(dot(Nb, L), 0.0);
    // A soft terminator: twilight wraps a little past the geometric edge.
    float day = smoothstep(-0.12, 0.22, ndlGeo);

    // Clouds cast their shadows a hair toward the night side.
    vec3 cloudDir = rotY(n, -uCloudRot);
    float cs = textureCube(uB, normalize(cloudDir - uSunObj * 0.012)).b;
    float cloudHere = textureCube(uB, cloudDir).b;

    vec3 sunCol = vec3(1.0, 0.96, 0.9) * 1.25;
    vec3 col = albedo * sunCol * ndl * (1.0 - 0.55 * cs) * mix(0.6, 1.0, day);
    // Twilight: the terminator band is warmed by light bent through the atmosphere.
    float dusk = smoothstep(-0.18, 0.0, ndlGeo) * smoothstep(0.25, 0.0, ndlGeo);
    col += albedo * vec3(1.0, 0.45, 0.2) * dusk * 0.25;
    // Seas: a tight sun glint inside a broad sheen, rippled by fine noise, and sky colour at grazing angles.
    if (ocean > 0.01) {
      vec3 Nr = normalize(Nw + (T1 * snoise(n * 800.0 + uTime * 0.05) + T2 * snoise(n * 800.0 + 13.0 - uTime * 0.05)) * 0.02);
      vec3 H = normalize(L + V);
      float nh = max(dot(Nr, H), 0.0);
      float fres = pow(clamp(1.0 - dot(Nw, V), 0.0, 1.0), 5.0);
      float spec = pow(nh, 700.0) * 14.0 + pow(nh, 60.0) * 0.5;
      col += (sunCol * spec * (1.0 - cs * 0.85) + uAtmo * fres * 0.6) * ocean * day;
    }
    // Ambient: starlight and planetshine keep the night side from going flat black.
    col += albedo * vec3(0.012, 0.016, 0.03);

    // Night lights: sodium amber with a few teal arcologies; lava glows day and night on a spent world.
    float night = 1.0 - smoothstep(-0.2, 0.06, ndlGeo);
    // Settlements resolve into points at whatever scale keeps them about two pixels wide.
    float K = exp2(floor(log2(0.45 / max(length(fwidth(n)), 1e-6))));
    float g1 = hash13(floor(n * K)), g2 = hash13(floor(n * K * 0.5) + 17.0);
    float dens = B.g;
    float sparkle = step(1.0 - dens * 0.55, g1) * (0.5 + g1) + step(1.0 - dens * 0.3, g2) * 0.6 + smoothstep(0.5, 1.0, dens) * 0.15;
    if (uSpent > 0.5) {
      float lava = B.g;
      col += vec3(1.0, 0.28, 0.06) * lava * (1.2 + 3.5 * night) * (0.85 + 0.15 * sin(uTime * 1.3 + n.x * 40.0));
    } else {
      vec3 cityCol = mix(vec3(1.0, 0.58, 0.24), vec3(0.4, 1.0, 0.9), step(0.93, hash13(floor(n * 310.0))));
      col += cityCol * sparkle * night * (1.0 - cloudHere * 0.8) * 1.6;
    }
    // Aerial haze toward the limb on the day side.
    float rim = pow(clamp(1.0 - dot(Nw, V), 0.0, 1.0), 3.0);
    col = mix(col, uAtmo * (0.04 + day * 0.45), clamp(rim * (0.1 + 0.45 * day), 0.0, 0.6));
    gl_FragColor = vec4(col * uReady, 1.0);
  }
`;

const CLOUD_FRAG = /* glsl */ `
  ${NOISE_GLSL}
  uniform samplerCube uB;
  uniform vec3 uSun, uAtmo;
  uniform float uSpent, uTime;
  varying vec3 vObjN; varying vec3 vN; varying vec3 vWorld;
  void main() {
    vec3 n = normalize(vObjN);
    float c = textureCube(uB, n).b;
    // Wispy edges: fine noise eats into the thin parts only.
    float wisp = snoise(n * 160.0 + vec3(uTime * 0.01)) * 0.5 + snoise(n * 420.0) * 0.25;
    c = smoothstep(0.08, 0.85, c + wisp * 0.22 * (1.0 - c));
    if (c < 0.01) discard;
    vec3 Nw = normalize(vN);
    vec3 L = normalize(uSun);
    vec3 V = normalize(cameraPosition - vWorld);
    float ndl = dot(Nw, L);
    float day = smoothstep(-0.14, 0.3, ndl);
    float dusk = smoothstep(-0.2, 0.0, ndl) * smoothstep(0.3, 0.0, ndl);
    vec3 lit = vec3(1.0, 0.97, 0.94) * (0.06 + 0.95 * max(ndl, 0.0)) * day;
    lit += vec3(1.0, 0.42, 0.18) * dusk * 0.45;
    // Silver lining: forward scattering when the sun is behind the limb.
    lit += vec3(1.0, 0.9, 0.8) * pow(max(dot(-V, L), 0.0), 6.0) * day * 0.3;
    lit += vec3(0.012, 0.016, 0.03);
    vec3 col = uSpent > 0.5 ? lit * vec3(0.32, 0.22, 0.16) : lit * 0.9;
    float rim = pow(clamp(1.0 - dot(Nw, V), 0.0, 1.0), 3.0);
    col = mix(col, uAtmo * day, rim * 0.5);
    gl_FragColor = vec4(col * c, c * (uSpent > 0.5 ? 0.6 : 0.92));
  }
`;

const ATMO_VERT = /* glsl */ `varying vec3 vWorld; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

const ATMO_FRAG = /* glsl */ `
  uniform vec3 uCenter, uSun, uAtmo;
  uniform float uRp, uRa, uDensity;
  varying vec3 vWorld;
  vec2 hitSphere(vec3 o, vec3 d, float r) {
    float b = dot(o, d), c = dot(o, o) - r * r, disc = b * b - c;
    if (disc < 0.0) return vec2(1e9, -1e9);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
  }
  void main() {
    vec3 o = cameraPosition - uCenter;
    vec3 d = normalize(vWorld - cameraPosition);
    vec2 a = hitSphere(o, d, uRa);
    if (a.y < 0.0) discard;
    float t0 = max(a.x, 0.0), t1 = a.y;
    vec2 p = hitSphere(o, d, uRp);
    float overDisc = 0.0;
    if (p.x > 0.0) { t1 = min(t1, p.x); overDisc = 1.0; }
    float seg = max(t1 - t0, 0.0);
    vec3 L = normalize(uSun);
    vec3 sum = vec3(0.0);
    float thick = uRa - uRp;
    const int N = 12;
    for (int i = 0; i < N; i++) {
      vec3 x = o + d * (t0 + seg * (float(i) + 0.5) / float(N));
      float r = length(x);
      float hgt = clamp((r - uRp) / thick, 0.0, 1.0);
      float dens = exp(-hgt * 4.2);
      float mu = dot(x / r, L);
      float lightAmt = smoothstep(-0.22, 0.25, mu);
      vec3 tint = mix(vec3(1.0, 0.38, 0.12), uAtmo, smoothstep(-0.05, 0.4, mu));
      sum += tint * dens * lightAmt;
    }
    sum *= seg / float(N) / thick;
    // Forward scattering: the limb flares when you look toward the sun past it.
    float g = max(dot(d, L), 0.0);
    vec3 mie = vec3(1.0, 0.85, 0.65) * pow(g, 12.0) * 0.8;
    vec3 col = (1.0 - exp(-(sum * 0.32 + mie * sum.b * 0.4))) * 0.95 * uDensity * (1.0 - 0.5 * overDisc);
    gl_FragColor = vec4(col, 1.0);
  }
`;

let planetCount = 0;
const SPENT_HAZE = new THREE.Color(0x8a5a3a);
const TMP_Q = new THREE.Quaternion(), TMP_M = new THREE.Matrix4(), TMP_V = new THREE.Vector3();

export class Planet {
  readonly group = new THREE.Group();
  readonly radius: number;
  /** Tilted frame the surface and clouds spin in. */
  private axis = new THREE.Group();
  private surface: THREE.Mesh;
  private clouds: THREE.Mesh;
  private atmo: THREE.Mesh;
  private surfMat: THREE.ShaderMaterial;
  private cloudMat: THREE.ShaderMaterial;
  private atmoMat: THREE.ShaderMaterial;
  private rtA: THREE.WebGLCubeRenderTarget | null = null;
  private atmoBase: THREE.Color;
  private detail: number;
  private rtB: THREE.WebGLCubeRenderTarget | null = null;
  private world: { palette: [number, number, number]; seed: number; spent: boolean };
  private dirty = true;
  private baked = -1;
  private sun: THREE.Vector3;
  private spin = 0;
  private cloudSpin = 0;
  readonly id = ++planetCount;

  constructor(opts: PlanetOptions) {
    this.radius = opts.radius;
    this.world = { palette: opts.palette, seed: opts.seed, spent: !!opts.spent };
    this.sun = (opts.sun ?? new THREE.Vector3(-0.55, 0.45, -0.7)).clone().normalize();
    const atmo = new THREE.Color(opts.atmosphere ?? 0x4f8fff);
    this.atmoBase = atmo.clone();
    this.detail = opts.detail ?? 1024;
    const R = opts.radius;
    // Shading is per pixel from the baked cube, so the mesh only draws the outline: the Dreamcast
    // look keeps it to a console's budget (an 80-sided limb at ~480 lines still reads as round).
    const seg = LOOK.dc ? 64 : 160;

    this.surfMat = new THREE.ShaderMaterial({
      uniforms: {
        uA: { value: null }, uB: { value: null }, uSun: { value: this.sun }, uSunObj: { value: new THREE.Vector3() },
        uAtmo: { value: atmo }, uSea: { value: new THREE.Color(opts.palette[0]) }, uSpent: { value: 0 }, uCloudRot: { value: 0 },
        uTime: { value: 0 }, uTexel: { value: 1 / 1024 }, uReady: { value: 0 }, uRot: { value: new THREE.Matrix3() },
        uLite: { value: 0 }, uLand: { value: new THREE.Color(opts.palette[1]) },
      },
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
    });
    this.surface = new THREE.Mesh(new THREE.SphereGeometry(R, seg, seg / 2), this.surfMat);
    this.surface.onBeforeRender = (renderer) => {
      // A software rasteriser can't afford the bakes: the surface shades from the palette and the clouds stay off.
      if (softwareGL(renderer)) { this.surfMat.uniforms.uLite.value = 1; this.clouds.visible = false; return; }
      if (this.dirty || this.baked !== bakeEpoch(renderer)) this.bake(renderer);
    };
    const tilt = opts.tilt ?? [-0.8, 0.28];
    this.axis.rotation.set(tilt[0], 0, tilt[1]);
    this.group.add(this.axis);
    this.axis.add(this.surface);

    this.cloudMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uB: { value: null }, uSun: { value: this.sun }, uAtmo: { value: atmo }, uSpent: { value: 0 }, uTime: { value: 0 } },
      vertexShader: SURFACE_VERT,
      fragmentShader: CLOUD_FRAG,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(R * 1.006, seg, seg / 2), this.cloudMat);
    this.clouds.renderOrder = 1;
    this.axis.add(this.clouds);

    this.atmoMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uCenter: { value: new THREE.Vector3() }, uSun: { value: this.sun }, uAtmo: { value: atmo }, uRp: { value: R }, uRa: { value: R * 1.045 }, uDensity: { value: 1 } },
      vertexShader: ATMO_VERT,
      fragmentShader: ATMO_FRAG,
    });
    this.atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.045, LOOK.dc ? 48 : 128, LOOK.dc ? 24 : 64), this.atmoMat);
    this.atmo.renderOrder = 2;
    this.group.add(this.atmo);
    this.applyWorldUniforms();
  }

  /** Repaint for another world: palette, terrain seed, spent or alive (rebaked at the next draw). */
  setWorld(opts: { palette: [number, number, number]; seed: number; spent?: boolean }) {
    const same = opts.seed === this.world.seed && !!opts.spent === this.world.spent && opts.palette.every((c, i) => c === this.world.palette[i]);
    if (same) return;
    this.world = { palette: opts.palette, seed: opts.seed, spent: !!opts.spent };
    this.applyWorldUniforms();
    this.dirty = true;
  }

  private applyWorldUniforms() {
    const spent = this.world.spent ? 1 : 0;
    this.surfMat.uniforms.uSpent.value = spent;
    this.cloudMat.uniforms.uSpent.value = spent;
    (this.surfMat.uniforms.uSea.value as THREE.Color).set(this.world.palette[0]);
    (this.surfMat.uniforms.uLand.value as THREE.Color).set(this.world.palette[1]);
    // A dead world keeps only a thin, dusty brown haze.
    this.atmoMat.uniforms.uDensity.value = spent ? 0.45 : 1;
    (this.atmoMat.uniforms.uAtmo.value as THREE.Color).copy(spent ? SPENT_HAZE : this.atmoBase);
  }

  private bake(renderer: THREE.WebGLRenderer) {
    this.dirty = false;
    this.baked = bakeEpoch(renderer);
    const u = BAKE_UNIFORMS;
    u.uSeed.value = this.world.seed;
    u.uSpent.value = this.world.spent ? 1 : 0;
    u.uSea.value.set(this.world.palette[0]); u.uLow.value.set(this.world.palette[1]); u.uHigh.value.set(this.world.palette[2]);
    this.rtA = bakeCube(renderer, this.detail, BAKE_SURFACE, this.rtA ?? undefined);
    this.rtB = bakeCube(renderer, Math.round(this.detail * 0.75), BAKE_DATA, this.rtB ?? undefined);
    this.surfMat.uniforms.uA.value = this.rtA.texture;
    this.surfMat.uniforms.uB.value = this.rtB.texture;
    this.surfMat.uniforms.uTexel.value = 1 / this.rtA.width;
    this.surfMat.uniforms.uReady.value = 1;
    this.cloudMat.uniforms.uB.value = this.rtB.texture;
  }

  /** Point the sun (world space). */
  setSun(dir: THREE.Vector3) { this.sun.copy(dir).normalize(); }

  update(dt: number, t: number) {
    this.spin += dt * 0.004;
    this.cloudSpin += dt * 0.0062;
    this.surface.rotation.y = this.spin;
    this.clouds.rotation.y = this.cloudSpin;
    const su = this.surfMat.uniforms;
    su.uTime.value = t;
    su.uCloudRot.value = this.cloudSpin - this.spin;
    this.cloudMat.uniforms.uTime.value = t;
    // The surface's world rotation (for its tangent frame) and the sun in its own frame (cloud shadows).
    this.surface.getWorldQuaternion(TMP_Q);
    (su.uRot.value as THREE.Matrix3).setFromMatrix4(TMP_M.makeRotationFromQuaternion(TMP_Q));
    (su.uSunObj.value as THREE.Vector3).copy(this.sun).applyQuaternion(TMP_Q.invert());
    this.group.getWorldPosition(this.atmoMat.uniforms.uCenter.value as THREE.Vector3);
    const s = this.group.getWorldScale(TMP_V).x;
    this.atmoMat.uniforms.uRp.value = this.radius * s;
    this.atmoMat.uniforms.uRa.value = this.radius * 1.045 * s;
  }

  /** Free the baked cubes (screens call this on exit); the next draw repaints them. */
  release() {
    this.rtA?.dispose(); this.rtB?.dispose();
    this.rtA = this.rtB = null;
    this.surfMat.uniforms.uA.value = this.surfMat.uniforms.uB.value = this.cloudMat.uniforms.uB.value = null;
    this.surfMat.uniforms.uReady.value = 0;
    this.dirty = true;
  }

  dispose() {
    for (const m of [this.surface, this.clouds, this.atmo]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.release();
  }
}
