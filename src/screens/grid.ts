/* The Grid: Structs' energy economy, live from the LCD. Players infuse
 * Alpha into reactors (validators) and gain capacity; allocations route
 * capacity into substations; every connected player draws an equal share.
 * Substations are machined hex platforms on a ring, their connected worlds
 * strewn around them; reactors hang above as caged miniature stars in their
 * guild's colour; allocations are conduits with packets of light running at
 * their load, and infusions are streams of fuel spiralling up to a reactor.
 * A holographic hex plane underneath gives the network its floor. */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Engine, Screen } from '../core/engine';
import { LOOK, PIXEL_RATIO } from '../core/engine';
import { h, hideTooltip, showTooltip, toast } from '../core/dom';
import { audio } from '../core/audio';
import { clamp, damp, easeInOutCubic, formatAlpha, formatInt, formatPower, hash32, idIndex, idType, mulberry } from '../core/util';
import { lcd, big, gridRecord, type Grid, type RawAllocation, type RawInfusion, type RawProvider, type RawReactor, type RawSubstation } from '../chain/lcd';
import { store } from '../chain/store';
import { live } from '../chain/live';
import { commander } from '../chain/commander';
import { NOISE_GLSL, createNebulaSky, createStarfield, tickSpace } from '../gfx/space';
import { icon } from '../ui/icons';
import '../styles/dc-watch.css';

/** An icon as a node (its meaning goes in the parent's title). */
const ico = (name: string, size = 16, cls = '') => h('span', { class: 'dw-ico' + (cls ? ' ' + cls : ''), html: icon(name, size) });
/** The grid's own colours, the same in the legend, the tiles and the 3D: power flows amber, rented
 * power cyan, fuel violet. */
const K_FLOW = '#ebaa49', K_RENT = '#66d7eb', K_FUEL = '#c77dff';

interface Node { id: string; kind: 'reactor' | 'substation' | 'player'; pos: THREE.Vector3; grid: Grid; mesh?: THREE.Mesh; color: number; label?: HTMLElement; /** Visual radius (reticles). */ size?: number }
interface Flow { a: THREE.Vector3; b: THREE.Vector3; power: number; color: number; kind: 'allocation' | 'infusion'; id: string; mesh?: THREE.Mesh; label: string; /** Read when shown: live EventGrid records change allocation power in place. */ detail: () => string; curve?: THREE.QuadraticBezierCurve3 }
type Uni<T> = { value: T };
/** A node's own uniforms, shared by all of its materials (each kind reads the ones it needs). */
interface ArtUniforms { uBoost: Uni<number>; uFlare: Uni<number>; uFlareAng: Uni<number>; uHeat: Uni<number>; uDormant: Uni<number>; uLoad: Uni<number>; uLevel: Uni<number>; uGemLevel: Uni<number>; uState: Uni<THREE.Color>; uGem: Uni<THREE.Color> }
/** What a node looks like beyond its pick proxy: shared uniforms and moving parts. */
interface NodeArt {
  kind: 'reactor' | 'substation'; size: number; boost: number; seed: number;
  u: ArtUniforms;
  spin?: THREE.Object3D; crystal?: THREE.Object3D; baseY?: number;
  deck?: THREE.MeshStandardMaterial[]; glow?: number;
  flare?: { t: number; next: number }; dormant?: boolean;
  /** Its first deck light in the glint buffer and its floor decal, restyled when live records land. */
  glint?: number; decal?: number;
}

const SUB_R = 40, REACTOR_R = 64, REACTOR_Y = 18, GROUND_Y = -6;
/** The corona billboard reaches this many star radii. */
const CORONA_EXT = 6;
const C_ONLINE = 0x43cdb6, C_IDLE = 0xebaa49, C_OFFLINE = 0xee6c58;
const WHITE = new THREE.Color(1, 1, 1);
const artUniforms = (): ArtUniforms => ({
  uBoost: { value: 0 }, uFlare: { value: 0 }, uFlareAng: { value: 0 }, uHeat: { value: 0.5 }, uDormant: { value: 0 },
  uLoad: { value: 0 }, uLevel: { value: 1 }, uGemLevel: { value: 1 }, uState: { value: new THREE.Color() }, uGem: { value: new THREE.Color() },
});

/** A substation's look from its grid record. One never read keeps the plain guild look; capacity 0 is offline. */
function stationLook(g: Grid, guild: number) {
  if (g.capacity == null) return { light: guild, mode: 3, level: 0.8, glow: 1.2, gem: 0.8, strain: 0 };
  const cap = big(g.capacity), load = big(g.load), conns = Number(g.connectionCount || 0);
  const strain = cap > 0n ? clamp(Number((load * 1000n) / cap) / 1000, 0, 1) : 0;
  const offline = cap <= 0n;
  return {
    light: offline || strain > 0.9 ? C_OFFLINE : strain > 0.7 ? C_IDLE : conns > 0 ? C_ONLINE : C_IDLE,
    mode: offline ? 2 : conns > 0 ? 1 : 3, level: offline ? 0.3 : conns > 0 ? 1 : 0.7,
    glow: offline ? 0.35 : 1.6, gem: offline ? 0.3 : 1, strain,
  };
}
function styleStation(u: ArtUniforms, k: ReturnType<typeof stationLook>) {
  u.uLoad.value = k.strain; u.uLevel.value = k.level; u.uGemLevel.value = k.gem;
  u.uState.value.setHex(k.light); u.uGem.value.setHex(k.light);
}
/** A reactor's look: heat from its fuel; a cinder only when its capacity is known to be 0. */
function reactorLook(g: Grid) {
  const dormant = g.capacity != null && big(g.capacity) <= 0n;
  const heat = dormant ? 0.15 : g.fuel == null ? 0.5 : clamp(Math.log10(1 + Number(big(g.fuel)) / 1e6) / 3.4, 0.22, 1);
  return { heat, dormant, level: dormant ? 0.35 : 0.5 + heat * 0.7 };
}

/* Rebuilds (Refresh, a roster reload, a return visit) would otherwise free every shader program
 * and recompile them all on the next frame. One drawn material per program is held back from
 * disposal for the screen's life, so the new materials find their programs already compiled. */
function programKey(m: THREE.Material): string | null {
  const sm = m as THREE.ShaderMaterial, st = m as THREE.MeshStandardMaterial;
  if (sm.isShaderMaterial) return sm.vertexShader + '\n//fs\n' + sm.fragmentShader;
  if (st.isMeshStandardMaterial) return `standard|${!!st.map}|${!!st.emissiveMap}`;
  return null;
}
/** onBeforeRender for everything built here: a material that has drawn holds a compiled program. */
function markDrawn(_r: THREE.WebGLRenderer, _s: THREE.Scene, _c: THREE.Camera, _g: THREE.BufferGeometry, m: THREE.Material) { m.userData.drawn = true; }

/** Up to `n` LCD reads at once. */
async function pooled<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]); } }));
  return out;
}

/* ── Shaders ──────────────────────────────────────────────────────────── */
/* Depth fade: whatever lies beyond the orbit's focus sinks toward the dark,
 * so the network reads in layers. Near/far follow the camera each frame. */
const FOG_GLSL = /* glsl */ `
  uniform float uFogNear, uFogFar;
  float fogK(float d) { return 1.0 - 0.8 * smoothstep(uFogNear, uFogFar, d); }
`;
/* Hex lattice: distance to the nearest cell edge, and an anti-aliased line
 * that fades out before it can moiré at grazing angles. */
const HEX_GLSL = /* glsl */ `
  float hexEdge(vec2 p) {
    const vec2 s = vec2(1.0, 1.7320508);
    vec2 a = mod(p, s) - s * 0.5;
    vec2 b = mod(p - s * 0.5, s) - s * 0.5;
    vec2 g = abs(dot(a, a) < dot(b, b) ? a : b);
    return 0.5 - max(dot(g, s * 0.5), g.x);
  }
  float gridLine(float e, float w) {
    float fw = max(fwidth(e), 1e-5);
    return (1.0 - smoothstep(w * fw, (w + 1.0) * fw, e)) * (1.0 - smoothstep(0.05, 0.22, fw));
  }
`;
/* Camera-facing quad of half-size uSize around the object's origin. */
const BILLBOARD_VS = /* glsl */ `
  uniform float uSize;
  varying vec2 vP; varying float vDepth;
  void main() {
    vP = position.xy;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * uSize;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/* Reactor photosphere: boiling granulation (wandering Worley cells), slow
 * active regions and spots, differential rotation, limb darkening and a hot
 * chromosphere rim. A dormant reactor is a cooled cinder veined with embers. */
const STAR_VS = /* glsl */ `
  varying vec3 vObj, vN, vV; varying float vDepth;
  void main() {
    vObj = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = -mv.xyz;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const STAR_FS = /* glsl */ `
  ${NOISE_GLSL}
  ${FOG_GLSL}
  uniform float uTime, uSeed, uHeat, uDormant, uFlare, uBoost; uniform vec3 uColor;
  varying vec3 vObj, vN, vV; varying float vDepth;
  vec3 hash3(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453);
  }
  // Nearest and second-nearest wandering cell centre, and the nearest cell's own brightness.
  vec3 cells(vec3 p, float t) {
    vec3 i = floor(p), f = fract(p);
    float d1 = 9.0, d2 = 9.0, id = 0.0;
    for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
      vec3 g = vec3(float(x), float(y), float(z));
      vec3 hh = hash3(i + g);
      vec3 o = 0.5 + 0.42 * sin(t * (0.7 + 0.6 * hh.yzx) + 6.2831 * hh);
      vec3 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; id = hh.x; } else if (d < d2) d2 = d;
    }
    return vec3(sqrt(d1), sqrt(d2), id);
  }
  // Granules: bright domed cells of varied brightness parted by dark lanes.
  float granules(vec3 c) { return (0.6 + 0.4 * c.z) * smoothstep(0.0, 0.45, c.y - c.x) * (1.2 - 0.6 * c.x); }
  void main() {
    vec3 p = normalize(vObj);
    float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
    // The equator runs ahead of the poles.
    float spin = uTime * (0.05 + 0.04 * (1.0 - p.y * p.y)) + uSeed;
    float cs = cos(spin), sn = sin(spin);
    vec3 q = vec3(cs * p.x - sn * p.z, p.y, sn * p.x + cs * p.z);
    // Each scale of granules fades to its mean before it is small enough to shimmer.
    float px = length(fwidth(q));
    float lod1 = 1.0 - smoothstep(0.25, 0.6, px * 15.0), lod2 = 1.0 - smoothstep(0.25, 0.6, px * 32.0);
    // Cells only where they resolve (a distant star skips the search); fine grain is cheap noise.
    // Warped, so granules come out irregular rather than as a polygon web.
    vec3 w = lod1 > 0.0 ? cells(q * 15.0 + uSeed + snoise(q * 5.0 + uSeed) * 0.45, uTime * 0.5) : vec3(0.3, 0.7, 0.5);
    float lane = w.y - w.x;
    float fine = lod2 > 0.0 ? smoothstep(0.0, 0.45, abs(snoise(q * 34.0 + vec3(0.0, uTime * 0.12, uSeed)))) : 0.6;
    float gran = mix(0.45, granules(w), lod1 * 0.85) * 0.78 + mix(0.45, fine * 0.75, lod2) * 0.22;
    float meso = snoise(q * 6.0 + vec3(uTime * 0.02, uSeed, 0.0));
    float big = snoise(q * 1.7 + vec3(uSeed, uTime * 0.015, 0.0));
    float act = snoise(q * 3.6 + vec3(0.0, -uTime * 0.03, uSeed));
    // Spots: a flattened, cooler penumbra round a dark umbra.
    float pen = smoothstep(-0.58, -0.76, big), umbra = smoothstep(-0.72, -0.86, big);
    float fac = smoothstep(0.35, 0.85, act) * (0.4 + 0.8 * (1.0 - mu));
    float T = 0.6 + 0.5 * (gran - 0.45) + 0.08 * meso + 0.28 * fac + uFlare * 0.25;
    T = mix(T, 0.32, pen * 0.75);
    float limb = 0.28 + 0.72 * pow(mu, 0.55);
    vec3 hot = vec3(1.0, 0.94, 0.84);
    vec3 col = mix(uColor * 0.3, uColor * 1.1, smoothstep(0.15, 0.7, T));
    col = mix(col, hot * 1.5, smoothstep(0.7, 1.15, T * limb) * 0.55);
    col *= limb * (0.42 + uHeat * 0.6) * (1.0 + uBoost * 0.15) * (1.0 - umbra * 0.65);
    col += uColor * pow(1.0 - mu, 3.0) * (0.5 + uHeat * 0.7);
    // Cinder: dark crust, glowing lanes.
    float vein = (1.0 - smoothstep(0.0, 0.12, lane)) * mix(0.5, 1.0, lod1);
    float ember = 0.55 + 0.45 * sin(uTime * 0.9 + q.x * 5.0 + q.y * 3.0);
    vec3 cinder = vec3(0.045, 0.035, 0.03) * (0.4 + mu) + vec3(1.0, 0.36, 0.12) * vein * ember * 0.9 + mix(uColor, vec3(1.0, 0.4, 0.15), 0.6) * pow(1.0 - mu, 3.0) * 0.5;
    col = mix(col, cinder * (1.0 + uBoost * 0.6), uDormant);
    gl_FragColor = vec4(col * fogK(vDepth), 1.0);
  }
`;
/* Corona: a halo, slow-turning streamers, prominence loops off the limb and
 * the occasional flare plume, all in star radii on a camera-facing quad. */
const CORONA_FS = /* glsl */ `
  ${NOISE_GLSL}
  ${FOG_GLSL}
  uniform float uTime, uSeed, uHeat, uDormant, uFlare, uFlareAng, uBoost; uniform vec3 uColor;
  varying vec2 vP; varying float vDepth;
  float loop(float r, float th, float a0, float w, float hgt, float t) {
    float u = atan(sin(th - a0), cos(th - a0)) / w;
    if (abs(u) > 1.0 || r < 1.0) return 0.0;
    float arc = 1.0 + hgt * sqrt(1.0 - u * u);
    float d = abs(r - arc);
    float flow = 0.55 + 0.45 * sin(u * 8.0 - t * 1.6);
    return (exp(-d * 34.0) + 0.3 * exp(-d * 9.0)) * flow * smoothstep(1.0, 0.6, abs(u));
  }
  void main() {
    vec2 c = vP * ${CORONA_EXT.toFixed(1)};
    float r = length(c), th = atan(c.y, c.x);
    vec2 dir = c / max(r, 1e-4);
    float d = max(r - 1.0, 0.0);
    float t = uTime;
    float n1 = max(snoise(vec3(dir * 1.6, t * 0.04 + uSeed)) * 0.5 + 0.5, 0.0);
    float n2 = max(snoise(vec3(dir * 4.2, t * 0.07 + uSeed * 1.7)) * 0.5 + 0.5, 0.0);
    float n3 = max(snoise(vec3(c * 0.9, t * 0.12 + uSeed)) * 0.5 + 0.5, 0.0);
    float streak = pow(n1, 2.6) * 0.75 + pow(n2, 5.0) * 0.9;
    float rays = streak * exp(-d * mix(2.6, 0.75, streak)) * (0.7 + 0.6 * n3);
    float halo = exp(-d * 3.4) + exp(-d * 0.85) * 0.16;
    float da = atan(sin(th - uFlareAng), cos(th - uFlareAng));
    float fil = max(snoise(vec3(dir * 14.0, t * 0.3 + uSeed)) * 0.5 + 0.5, 0.0);
    float plume = uFlare * exp(-da * da * 16.0 / (0.2 + d * 0.35)) * exp(-d * 0.8) * (0.35 + 0.8 * n3) * (0.45 + 0.9 * fil * fil);
    float prom = loop(r, th, uSeed * 2.1, 0.32, 0.42, t) + loop(r, th, uSeed * 3.7 + 2.5, 0.2, 0.28, t * 1.3) * 0.8;
    vec3 hot = vec3(1.0, 0.92, 0.8);
    vec3 col = uColor * (halo * 0.6 + rays * 1.0) * (0.3 + uHeat * 0.8)
             + mix(uColor, hot, 0.5) * exp(-d * 9.0) * (0.15 + uHeat * 0.45)
             + mix(uColor, hot, 0.4) * (plume * 1.8 + prom * 1.2 * uHeat);
    vec3 ember = vec3(1.0, 0.38, 0.14) * exp(-d * 4.0) * 0.35;
    col = mix(col, ember, uDormant);
    col *= smoothstep(${CORONA_EXT.toFixed(1)}, ${(CORONA_EXT * 0.6).toFixed(1)}, r) * (1.0 + uBoost * 0.25);
    gl_FragColor = vec4(col * fogK(vDepth), 1.0);
  }
`;
/* Containment gimbal: two dashed orbit rings, each with a comet of light
 * running round it. */
const GIMBAL_VS = /* glsl */ `
  attribute float aU, aDir;
  varying float vU, vDir, vDepth;
  void main() { vU = aU; vDir = aDir; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }
`;
const GIMBAL_FS = /* glsl */ `
  ${FOG_GLSL}
  uniform float uTime, uHeat, uBoost, uDormant; uniform vec3 uColor;
  varying float vU, vDir, vDepth;
  void main() {
    float u = vDir > 0.0 ? vU : 1.0 - vU;
    float f = fract(u - uTime * 0.09);
    float head = pow(f, 18.0);
    float dash = step(0.4, fract(vU * 72.0));
    float v = (0.1 + 0.24 * dash) * (1.0 + uBoost * 2.0) + head * 2.6 * (1.0 - uDormant * 0.8);
    gl_FragColor = vec4(mix(uColor, vec3(1.0), head * 0.5) * v * (0.45 + uHeat * 0.55) * fogK(vDepth), 1.0);
  }
`;

/* Substation core: a faceted crystal lit from inside, its edges burning hot. */
const CRYSTAL_VS = /* glsl */ `
  varying vec3 vVp, vObj; varying float vDepth;
  void main() { vObj = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vVp = mv.xyz; vDepth = -mv.z; gl_Position = projectionMatrix * mv; }
`;
const CRYSTAL_FS = /* glsl */ `
  ${FOG_GLSL}
  uniform float uBoost, uLevel; uniform vec3 uColor;
  varying vec3 vVp, vObj; varying float vDepth;
  void main() {
    vec3 n = normalize(cross(dFdx(vVp), dFdy(vVp)));
    float f = abs(dot(n, normalize(-vVp)));
    float lit = 0.3 + 0.9 * max(dot(n, normalize(vec3(0.35, 0.8, 0.5))), 0.0);
    // An octahedron's edges are where one coordinate vanishes.
    vec3 a = abs(vObj);
    float m = min(min(a.x, a.y), a.z) / (a.x + a.y + a.z);
    float edge = 1.0 - smoothstep(0.0, 0.035 + fwidth(m) * 1.5, m);
    vec3 col = uColor * (lit * 0.7 + 1.1 * pow(max(1.0 - f, 0.0), 2.0)) + mix(uColor, vec3(1.0), 0.55) * edge * 1.5;
    gl_FragColor = vec4(col * uLevel * (1.0 + uBoost * 0.8) * fogK(vDepth), 1.0);
  }
`;
/* Station halo: a ring of turning arc segments, a tick scale and a load
 * gauge (amber over its faint track), flat around the hull. */
const HALO_VS = /* glsl */ `
  varying vec2 vP; varying float vDepth;
  void main() { vP = uv * 2.0 - 1.0; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }
`;
const HALO_FS = /* glsl */ `
  ${FOG_GLSL}
  uniform float uTime, uBoost, uLoad, uSeed, uLevel; uniform vec3 uColor, uState;
  varying vec2 vP; varying float vDepth;
  float band(float r, float R, float w) { float fw = fwidth(r); return 1.0 - smoothstep(w * fw, (w + 1.2) * fw, abs(r - R)); }
  void main() {
    float r = length(vP);
    if (r > 1.0) discard;
    float a = atan(vP.y, vP.x) / 6.2831853 + 0.5;
    float fw = fwidth(r);
    float arcs = band(r, 0.78, 1.1) * step(0.14, fract(a * 3.0 + uTime * 0.025 + uSeed));
    float fine = band(r, 0.72, 0.4) * step(0.5, fract(a * 96.0 - uTime * 0.4));
    float thin = band(r, 0.9, 0.35);
    float tw = fw / max(r, 1e-3) / 6.2831853 * 60.0;
    float ta = fract(a * 60.0);
    float ticks = (1.0 - smoothstep(tw * 0.5, tw * 1.5, min(ta, 1.0 - ta))) * step(0.835, r) * step(r, mod(floor(a * 60.0 + 0.5), 5.0) < 0.5 ? 0.885 : 0.86);
    float gauge = band(r, 0.955, 2.4) * step(fract(a + 0.25), uLoad);
    float track = band(r, 0.955, 0.6);
    float hr = (r - 0.78) * 11.0;
    float halo = exp(-hr * hr) * 0.1;
    vec3 col = uColor * (arcs * 0.85 + fine * 0.35 + thin * 0.3 + ticks * 0.45 + track * 0.12 + halo) * uLevel * (1.0 + uBoost * 1.4)
             + uState * gauge * 1.8;
    gl_FragColor = vec4(col * fogK(vDepth), 1.0);
  }
`;

/* Energy conduit: a glass sheath (bright walls), a hot core filament and
 * packets of light spaced along it in world units, running at its load.
 * An infusion keeps only a faint trail; its fuel flies as particles. */
const FLOW_VS = /* glsl */ `
  varying vec2 vUv; varying vec3 vN, vV; varying float vDepth;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal); vV = -mv.xyz; vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const FLOW_FS = /* glsl */ `
  ${FOG_GLSL}
  uniform float uTime, uSpeed, uGlow, uFocus, uLen, uLoad, uKind; uniform vec3 uColor;
  varying vec2 vUv; varying vec3 vN, vV; varying float vDepth;
  void main() {
    float f = min(abs(dot(normalize(vN), normalize(vV))), 1.0);
    float s = vUv.x * uLen;
    float core = pow(f, 14.0), body = pow(f, 2.0), wall = pow(1.0 - f, 2.5);
    float ends = smoothstep(0.0, 0.03, vUv.x) * smoothstep(1.0, 0.9, vUv.x);
    vec3 hot = mix(uColor, vec3(1.0, 0.96, 0.88), 0.65);
    vec3 col;
    if (uKind < 0.5) {
      float ph = fract(s / 7.0 - uTime * uSpeed / 7.0);
      float pa = (ph - 0.8) * 14.0, pb = (ph - 0.8) * 4.0;
      float pk = exp(-pa * pa) + exp(-pb * pb) * 0.25 * step(ph, 0.8);
      float ribs = smoothstep(0.8, 1.0, sin(s * 2.4) * 0.5 + 0.5);
      col = uColor * (body * 0.2 + wall * 0.42 * (1.0 + ribs)) + mix(uColor, hot, 0.4) * core * 0.75
          + mix(uColor, hot, 0.5) * pk * (0.35 + 1.6 * core) * (0.5 + uLoad * 0.6);
    } else {
      float ph = fract(s / 3.0 - uTime * 0.8);
      col = uColor * (body * 0.22 + core * 0.4) * (0.7 + 0.3 * ph);
    }
    gl_FragColor = vec4(col * uGlow * uFocus * ends * fogK(vDepth), 1.0);
  }
`;

/* Pulse flare: a shockwave ring off a node touched by a live transaction. */
const SHOCK_VS = /* glsl */ `
  varying vec2 vP;
  void main() { vP = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const SHOCK_FS = /* glsl */ `
  uniform float uK, uCalm; uniform vec3 uColor;
  varying vec2 vP;
  void main() {
    float r = length(vP);
    float R = 0.12 + 0.86 * (1.0 - pow(max(1.0 - uK, 0.0), 3.0));
    float w = 0.02 + 0.07 * uK;
    float e = (r - R) / w;
    float ring = exp(-e * e);
    // The centre flash is skipped under reduced motion.
    float flash = exp(-r * r * 40.0) * (1.0 - uK) * 2.0 * (1.0 - uCalm);
    float trail = smoothstep(R, R * 0.4, r) * step(r, R) * 0.12;
    gl_FragColor = vec4(uColor * (ring * 1.6 + flash + trail) * (1.0 - uK), 1.0);
  }
`;

/* HUD reticle: corner brackets, a turning segmented ring, a tick scale and
 * a radar sweep; lines stay pixel-thin at any zoom. Hover shows brackets only. */
const RETICLE_FS = /* glsl */ `
  uniform float uTime, uAppear, uMode, uCalm; uniform vec3 uColor;
  varying vec2 vP;
  float ln(float d, float w) { float fw = fwidth(d); return 1.0 - smoothstep(w * fw, (w + 1.0) * fw, abs(d)); }
  void main() {
    float k = uAppear;
    float e = 1.0 - pow(max(1.0 - k, 0.0), 3.0);
    vec2 p = vP / mix(1.25, 1.0, e);
    float r = length(p), a = atan(p.y, p.x) / 6.2831853 + 0.5;
    vec2 q = abs(p);
    float bx = max(q.x, q.y);
    float brackets = ln(bx - 0.8, 0.9) * step(0.58, min(q.x, q.y));
    float ring = ln(r - 0.64, 0.8) * step(0.1, fract(a * 4.0 + uTime * 0.07));
    float inner = ln(r - 0.56, 0.35) * step(0.45, fract(a * 64.0 - uTime * 0.2));
    float tw = fwidth(r) / max(r, 1e-3) / 6.2831853 * 36.0;
    float ta = fract(a * 36.0);
    float ticks = (1.0 - smoothstep(tw * 0.5, tw * 1.5, min(ta, 1.0 - ta))) * step(0.68, r) * step(r, 0.73);
    float sw = fract(a - uTime * 0.18);
    float sweep = pow(sw, 10.0) * smoothstep(0.62, 0.5, r) * smoothstep(0.15, 0.3, r) * 0.22;
    float cross = ln(p.x, 0.6) * step(0.84, q.y) * step(q.y, 0.95) + ln(p.y, 0.6) * step(0.84, q.x) * step(q.x, 0.95);
    float v = uMode > 0.5 ? brackets * 1.2 + ring + inner * 0.6 + ticks * 0.7 + sweep + cross * 0.8 : brackets * 0.9 + inner * 0.45;
    // A lock-on flicker as it appears, held steady under reduced motion.
    float flick = mix(step(0.5, fract(uTime * 30.0)) * 0.6 + 0.4, 1.0, max(smoothstep(0.35, 0.7, k), uCalm));
    gl_FragColor = vec4(uColor * v * smoothstep(0.0, 0.25, k) * flick, 1.0);
  }
`;

/* ── Painted once ─────────────────────────────────────────────────────── */
/* Machined plating for the substation decks, shared by all of them:
 * a spun-metal hex top with panel seams, vents and hazard flashes, a side
 * band with a window strip, and emissive layers that glow in the owner's colour. */
let deckTex: { top: THREE.Texture; topGlow: THREE.Texture; side: THREE.Texture; sideGlow: THREE.Texture } | null = null;
function deckTextures(renderer: THREE.WebGLRenderer) {
  if (deckTex) return deckTex;
  const S = 512, C = S / 2, R = C - 3;
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const paint = (w: number, hh: number, f: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas'); c.width = w; c.height = hh;
    f(c.getContext('2d')!);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    return t;
  };
  const hex = (g: CanvasRenderingContext2D, r: number) => {
    g.beginPath();
    for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 3, x = C + Math.cos(a) * r, y = C + Math.sin(a) * r; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.closePath();
  };
  const circle = (g: CanvasRenderingContext2D, r: number) => { g.beginPath(); g.arc(C, C, r, 0, Math.PI * 2); };
  const rnd = mulberry(4242);
  const top = paint(S, S, (g) => {
    g.fillStyle = '#0c1015'; g.fillRect(0, 0, S, S);
    const grd = g.createRadialGradient(C, C, 0, C, C, R);
    grd.addColorStop(0, '#36414c'); grd.addColorStop(0.6, '#28313a'); grd.addColorStop(1, '#1c242c');
    hex(g, R); g.fillStyle = grd; g.fill();
    g.save(); hex(g, R); g.clip();
    // Spun metal: fine concentric tool marks.
    for (let r = 3; r < R * 1.2; r += 1.25) { g.strokeStyle = rnd() < 0.5 ? `rgba(255,255,255,${0.015 + rnd() * 0.035})` : `rgba(0,0,0,${0.03 + rnd() * 0.06})`; g.lineWidth = 1; circle(g, r); g.stroke(); }
    // Six panels: seams from the inner ring out to the corners.
    g.strokeStyle = '#090c10'; g.lineWidth = 3;
    for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 3; g.beginPath(); g.moveTo(C + Math.cos(a) * R * 0.47, C + Math.sin(a) * R * 0.47); g.lineTo(C + Math.cos(a) * R * 0.92, C + Math.sin(a) * R * 0.92); g.stroke(); }
    // Panel furniture: vent slots, rivets, hazard flashes on alternate panels.
    for (let i = 0; i < 6; i++) {
      const a = ((i + 0.5) * Math.PI) / 3;
      g.save(); g.translate(C + Math.cos(a) * R * 0.66, C + Math.sin(a) * R * 0.66); g.rotate(a + Math.PI / 2);
      g.fillStyle = '#0a0e12'; for (let k = -3; k <= 3; k++) g.fillRect(k * 9 - 2.5, -8, 5, 17);
      g.fillStyle = 'rgba(255,255,255,0.1)'; for (let k = -3; k <= 3; k++) g.fillRect(k * 9 - 2.5, 9, 5, 1);
      if (i % 2 === 0) {
        g.save(); g.beginPath(); g.rect(-36, -31, 72, 9); g.clip();
        for (let k = -6; k < 8; k++) { g.fillStyle = k % 2 ? '#15171a' : '#c48d31'; g.beginPath(); g.moveTo(k * 8, -31); g.lineTo(k * 8 + 8, -31); g.lineTo(k * 8 - 1, -22); g.lineTo(k * 8 - 9, -22); g.closePath(); g.fill(); }
        g.restore();
      } else {
        g.fillStyle = '#11161b'; g.fillRect(-30, -30, 60, 7); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(-30, -23, 60, 1);
      }
      g.fillStyle = '#5c6873'; for (const x of [-42, 42]) { g.beginPath(); g.arc(x, 19, 2.3, 0, Math.PI * 2); g.fill(); }
      g.restore();
    }
    // Rim: a raised machined band, a bright chamfer, a dark seam inside.
    g.lineWidth = 16; g.strokeStyle = '#3c4753'; hex(g, R - 9); g.stroke();
    g.lineWidth = 2; g.strokeStyle = '#6a7884'; hex(g, R - 2); g.stroke();
    g.lineWidth = 3; g.strokeStyle = '#06080b'; hex(g, R - 19); g.stroke();
    // Inner track and the collar the core floats over.
    g.lineWidth = 12; g.strokeStyle = '#12181e'; circle(g, R * 0.46); g.stroke();
    g.lineWidth = 2; g.strokeStyle = '#55626e'; circle(g, R * 0.395); g.stroke();
    const hub = g.createRadialGradient(C, C, 0, C, C, R * 0.37);
    hub.addColorStop(0, '#161b21'); hub.addColorStop(0.7, '#222a33'); hub.addColorStop(1, '#333e49');
    g.fillStyle = hub; circle(g, R * 0.37); g.fill();
    g.strokeStyle = '#0b0f13'; g.lineWidth = 2;
    for (let i = 0; i < 24; i++) { const a = (i * Math.PI) / 12; g.beginPath(); g.moveTo(C + Math.cos(a) * R * 0.27, C + Math.sin(a) * R * 0.27); g.lineTo(C + Math.cos(a) * R * 0.36, C + Math.sin(a) * R * 0.36); g.stroke(); }
    g.restore();
  });
  const topGlow = paint(S, S, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
    g.strokeStyle = '#fff'; g.lineWidth = 2.5; hex(g, R - 27); g.stroke();
    g.lineWidth = 3.5;
    for (let i = 0; i < 24; i++) { if (i % 4 === 3) continue; g.beginPath(); g.arc(C, C, R * 0.43, (i * Math.PI) / 12 + 0.05, ((i + 1) * Math.PI) / 12 - 0.05); g.stroke(); }
    g.lineWidth = 4; circle(g, R * 0.21); g.stroke();
    const core = g.createRadialGradient(C, C, 0, C, C, R * 0.17);
    core.addColorStop(0, 'rgba(255,255,255,1)'); core.addColorStop(0.5, 'rgba(255,255,255,0.35)'); core.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = core; circle(g, R * 0.17); g.fill();
    // Channel lights running out along each seam.
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      for (let k = 0; k < 4; k++) { const d = R * (0.53 + k * 0.085); g.fillStyle = `rgba(255,255,255,${0.95 - k * 0.2})`; g.beginPath(); g.arc(C + Math.cos(a) * d, C + Math.sin(a) * d, 2.8, 0, Math.PI * 2); g.fill(); }
    }
  });
  const side = paint(256, 64, (g) => {
    g.fillStyle = '#1d252d'; g.fillRect(0, 0, 256, 64);
    for (let y = 0; y < 64; y++) { g.fillStyle = `rgba(255,255,255,${rnd() * 0.035})`; g.fillRect(0, y, 256, 1); }
    g.fillStyle = '#5a6773'; g.fillRect(0, 0, 256, 3);
    g.fillStyle = '#080b0e'; g.fillRect(0, 3, 256, 2); g.fillRect(0, 58, 256, 6); g.fillRect(0, 0, 3, 64); g.fillRect(253, 0, 3, 64);
    g.fillStyle = '#0a0d11'; g.fillRect(22, 28, 212, 14);
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(22, 42, 212, 1);
  });
  const sideGlow = paint(256, 64, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 256, 64);
    for (let k = 0; k < 8; k++) { g.fillStyle = k % 3 === 1 ? 'rgba(255,255,255,0.3)' : '#fff'; g.fillRect(27 + k * 25.6, 32, 17, 6); }
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(0, 55, 256, 1);
  });
  for (const t of [side, sideGlow]) { t.wrapS = THREE.RepeatWrapping; t.repeat.set(6, 1); }
  deckTex = { top, topGlow, side, sideGlow };
  return deckTex;
}

/* A small studio of space light for the decks' metal to reflect: navy
 * above, a warm band of reactor glow round the horizon, teal bounce below. */
function gridEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, LOOK.dc ? 24 : 48, LOOK.dc ? 12 : 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: /* glsl */ `varying vec3 vD; void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec3 vD;
      void main() {
        vec3 d = normalize(vD);
        float az = atan(d.z, d.x);
        vec3 col = mix(vec3(0.012, 0.016, 0.028), vec3(0.09, 0.13, 0.2), smoothstep(-0.1, 0.8, d.y));
        float band = (d.y - 0.22) * 5.0;
        col += vec3(1.0, 0.62, 0.26) * exp(-band * band) * (0.35 + 0.3 * sin(az * 3.0)) * 0.9;
        col += vec3(0.2, 0.75, 0.68) * smoothstep(0.0, -0.7, d.y) * 0.22;
        col += vec3(0.85, 0.9, 1.0) * smoothstep(0.97, 0.995, dot(d, normalize(vec3(0.4, 0.75, 0.5)))) * 3.0;
        col += vec3(0.4, 0.95, 0.85) * smoothstep(0.985, 0.998, dot(d, normalize(vec3(-0.7, 0.3, -0.6)))) * 2.0;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(geo, mat));
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.03);
  pm.dispose(); geo.dispose(); mat.dispose();
  return rt.texture;
}

/** Two tilted orbit rings around a reactor, as line segments (aU runs 0..1 round each). */
function gimbalGeometry(size: number, seed: number) {
  const N = 144, pos: number[] = [], us: number[] = [], dirs: number[] = [];
  const v = new THREE.Vector3(), m = new THREE.Matrix4();
  const rings: [THREE.Euler, number][] = [[new THREE.Euler(1.15 + seed * 0.01, 0.2, 0.15), size * 1.6], [new THREE.Euler(-0.45, 0.1, 1.0), size * 1.95]];
  rings.forEach(([e, rad], k) => {
    m.makeRotationFromEuler(e);
    for (let i = 0; i < N; i++) for (const j of [i, i + 1]) {
      const a = (j / N) * Math.PI * 2;
      v.set(Math.cos(a) * rad, 0, Math.sin(a) * rad).applyMatrix4(m);
      pos.push(v.x, v.y, v.z); us.push(j / N); dirs.push(k ? -1 : 1);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aU', new THREE.Float32BufferAttribute(us, 1));
  g.setAttribute('aDir', new THREE.Float32BufferAttribute(dirs, 1));
  return g;
}

export class GridScreen implements Screen {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 4000);
  readonly bloom = { strength: 0.95, radius: 0.6, threshold: 0.55 };
  private sky: THREE.Object3D[];
  private controls: OrbitControls;
  private root!: HTMLElement;
  private group = new THREE.Group();
  private nodes = new Map<string, Node>();
  private flows: Flow[] = [];
  private dust: THREE.Points | null = null;
  private dustMat: THREE.ShaderMaterial | null = null;
  private playerPos = new Map<string, THREE.Vector3>();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(9, 9);
  private pointerPx = { x: 0, y: 0 };
  private hovered: string | null = null;
  private selected: string | null = null;
  private els: Record<string, HTMLElement> = {};
  private unsub: (() => void)[] = [];
  private token = 0;
  private data: { reactors: RawReactor[]; subs: RawSubstation[]; allocs: RawAllocation[]; providers: RawProvider[]; infusions: RawInfusion[]; grids: Map<string, Grid> } | null = null;
  private intro = 0;
  private idle = 0;
  private fly: { from: THREE.Vector3; to: THREE.Vector3; camFrom: THREE.Vector3; camTo: THREE.Vector3; t: number } | null = null;
  /** Uniforms every material here shares: one write a frame. */
  private U = { uTime: { value: 0 }, uFogNear: { value: 100 }, uFogFar: { value: 300 }, uCalm: { value: 0 }, uPixelRatio: PIXEL_RATIO };
  private fog = new THREE.Fog(0x04060a, 100, 400);
  private art = new Map<string, NodeArt>();
  private flares: THREE.Mesh[] = [];
  /** Fuel particles: each infusion's run of particles (start, count) glows with its beam (hover, focus). */
  private fuel: { geo: THREE.BufferGeometry; flows: Flow[]; ranges: number[]; last: Float32Array } | null = null;
  private glintGeo: THREE.BufferGeometry | null = null;
  private decalGeo: THREE.BufferGeometry | null = null;
  private flowIds = new Set<string>();
  /** One material per shader program, never disposed (see programKey). */
  private pinned = new Map<string, THREE.Material>();
  /** A load is in flight: a roster reload meanwhile waits for it rather than rebuilding twice. */
  private loading = false;
  private coreStale = false;
  private reticles: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; id: string | null; appear: number }[] = [];

  constructor(private engine: Engine, private navigate: (h: string) => void) {
    this.scene.background = new THREE.Color(0x04060a);
    this.scene.fog = this.fog;
    this.scene.environment = gridEnvironment(engine.renderer);
    this.sky = [createNebulaSky({ seed: 12.9, intensity: 0.5, radius: 1800, tint: 0xebaa49 }), createStarfield(6000, 1400, 19)];
    for (const s of this.sky) this.scene.add(s);
    this.scene.add(new THREE.HemisphereLight(0xa9c4ff, 0x1a1420, 0.7));
    const key = new THREE.DirectionalLight(0xfff0dc, 1.8);
    key.position.set(20, 40, 30);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fd8ff, 0.7);
    rim.position.set(-30, 12, -40);
    this.scene.add(rim);
    this.scene.add(this.group);
    this.buildStage();
    this.camera.position.set(0, 70, 120);
    this.controls = new OrbitControls(this.camera, engine.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 400;
    this.controls.maxPolarAngle = Math.PI * 0.49 + 0.5;
    this.controls.rotateSpeed = 0.5;
    this.controls.enabled = false;
    this.controls.target.set(0, 4, 0);
  }

  /** What stays for the screen's life: the holographic floor, drifting motes and the two HUD reticles. */
  private buildStage() {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { ...this.U },
      vertexShader: /* glsl */ `
        varying vec3 vW; varying float vDepth;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mv = viewMatrix * w; vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        ${FOG_GLSL}
        ${HEX_GLSL}
        uniform float uTime;
        varying vec3 vW; varying float vDepth;
        float ring(float r, float R, float w) { float fw = fwidth(r); return 1.0 - smoothstep(w * fw, (w + 1.2) * fw, abs(r - R)); }
        void main() {
          vec2 xz = vW.xz;
          float r = length(xz);
          float a = atan(xz.y, xz.x) / 6.2831853 + 0.5;
          float minor = gridLine(hexEdge(xz / 3.2), 0.45);
          float major = gridLine(hexEdge(xz / 16.0), 0.8);
          // A slow scan rolling out from the hub lights the lattice as it passes.
          float wave = fract(r / 60.0 - uTime * 0.035);
          float scan = smoothstep(0.8, 0.985, wave) * (1.0 - smoothstep(0.985, 1.0, wave));
          // Range rings: the substation ring (dashed) and the reactor orbit with its scale.
          float rings = ring(r, ${SUB_R.toFixed(1)}, 0.5) * step(0.35, fract(a * 120.0)) + ring(r, ${REACTOR_R.toFixed(1)}, 0.5) * 0.8;
          float tw = fwidth(r) / max(r, 1.0) / 6.2831853 * 72.0;
          float ta = fract(a * 72.0);
          float major12 = step(abs(fract(a * 12.0 + 0.5) - 0.5), 0.004);
          float ticks = (1.0 - smoothstep(tw * 0.5, tw * 1.5, min(ta, 1.0 - ta))) * step(${(REACTOR_R + 1).toFixed(1)}, r) * step(r, ${(REACTOR_R + 2.5).toFixed(1)} + major12 * 3.0);
          float spokes = (1.0 - smoothstep(tw * 0.4, tw * 1.4, min(fract(a * 12.0), 1.0 - fract(a * 12.0)) * 6.0)) * smoothstep(8.0, 20.0, r) * smoothstep(${(REACTOR_R + 10).toFixed(1)}, ${SUB_R.toFixed(1)}, r) * 0.25;
          float fade = (1.0 - smoothstep(90.0, 300.0, r)) * fogK(vDepth);
          minor *= 1.0 - smoothstep(55.0, 150.0, r);
          major *= 1.0 - smoothstep(80.0, 220.0, r);
          vec3 teal = vec3(0.24, 0.6, 0.68), amber = vec3(0.95, 0.66, 0.28);
          vec3 col = teal * (minor * 0.026 + major * 0.042) * (1.0 + scan * 7.0) + teal * scan * 0.006
                   + amber * (rings * 0.12 + ticks * 0.16 + spokes * 0.08)
                   + vec3(0.95, 0.62, 0.3) * exp(-r * r / 700.0) * 0.035;
          gl_FragColor = vec4(col * fade, 1.0);
        }`,
    }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GROUND_Y;
    ground.renderOrder = -2;
    this.scene.add(ground);

    // Motes: faint dust rising through the network, for depth and parallax.
    const n = 700, rnd = mulberry(91);
    const mp = new Float32Array(n * 3), ms = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(rnd()) * 120, a = rnd() * Math.PI * 2;
      mp.set([Math.cos(a) * r, rnd() * 50, Math.sin(a) * r], i * 3);
      ms.set([rnd(), 0.15 + rnd() * 0.5, 0.6 + rnd() * 1.4, rnd()], i * 4);
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    mg.setAttribute('aSeed', new THREE.BufferAttribute(ms, 4));
    const motes = new THREE.Points(mg, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { ...this.U },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed; uniform float uTime, uPixelRatio; varying float vA, vDepth;
        void main() {
          vec3 p = position;
          p.y = mod(position.y + uTime * aSeed.y, 50.0) + ${(GROUND_Y + 1).toFixed(1)};
          p.x += sin(uTime * 0.07 + aSeed.x * 6.28) * 3.0;
          p.z += cos(uTime * 0.05 + aSeed.w * 6.28) * 3.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          vDepth = -mv.z;
          float y = p.y - ${GROUND_Y.toFixed(1)};
          vA = (0.55 + 0.45 * sin(uTime * 1.3 + aSeed.w * 40.0)) * smoothstep(0.0, 6.0, y) * smoothstep(51.0, 38.0, y);
          gl_PointSize = clamp(aSeed.z * uPixelRatio * (70.0 / -mv.z), 1.0, 5.0 * uPixelRatio);
        }`,
      fragmentShader: /* glsl */ `
        ${FOG_GLSL}
        varying float vA, vDepth;
        void main() { float d = length(gl_PointCoord - 0.5) * 2.0; gl_FragColor = vec4(vec3(0.75, 0.82, 0.95) * exp(-d * d * 4.0) * vA * 0.22 * fogK(vDepth), 1.0); }`,
    }));
    motes.frustumCulled = false;
    this.scene.add(motes);

    for (const mode of [1, 0]) {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uTime: this.U.uTime, uCalm: this.U.uCalm, uSize: { value: 1 }, uAppear: { value: 0 }, uMode: { value: mode }, uColor: { value: new THREE.Color() } },
        vertexShader: BILLBOARD_VS, fragmentShader: RETICLE_FS,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      mesh.frustumCulled = false; mesh.renderOrder = 20; mesh.visible = false;
      this.scene.add(mesh);
      this.reticles.push({ mesh, mat, id: null, appear: 0 });
    }
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */
  enter() {
    audio.setIntensity(0.2);
    this.root = h('div', { class: 'screen grid' });
    document.getElementById('ui')!.appendChild(this.root);
    this.buildUi();
    // Each visit starts over the whole grid: no selection, no pending flight.
    this.selected = null; this.hovered = null; this.fly = null; this.idle = 0;
    this.controls.target.set(0, 4, 0);
    this.controls.enabled = true;
    this.bindInput();
    // Reduced motion skips the descent and starts where it would end.
    this.intro = this.engine.reduceMotion ? 1 : 0;
    if (this.intro >= 1) this.camera.position.set(Math.sin(0.6) * 14, 62, 112).multiplyScalar(this.reach());
    else this.camera.position.set(0, 150, 230);
    this.resize();
    this.unsub.push(store.onCore(() => {
      if (!this.data) return;
      if (this.loading) { this.coreStale = true; return; }
      this.buildScene(); this.renderSummary();
    }));
    // Live: grid records for reactors (3-), substations (4-) and allocations (6-) update the numbers and pulse the node.
    let summaryTimer = 0;
    this.unsub.push(live.onTx((tx) => {
      const d = this.data;
      if (!d) return;
      let touched = false;
      for (const e of tx.events) {
        if (e.type !== 'EventGrid') continue;
        const rec = gridRecord(e.data);
        if (!rec || ![3, 4, 6].includes(rec.objectType)) continue;
        const id = rec.objectId;
        const g = d.grids.get(id);
        if (!g) continue;
        g[rec.field] = rec.value;
        touched = true;
        this.pulse(id);
      }
      if (touched && !summaryTimer) summaryTimer = window.setTimeout(() => { summaryTimer = 0; if (this.data) { this.renderSummary(); if (this.selected) this.renderCard(this.selected); this.refreshArt(); } }, 600);
    }));
    this.unsub.push(() => clearTimeout(summaryTimer));
    void store.loadCore().catch(() => { /* names fall back to ids; main announces the outage */ });
    // Load in the background: the screen (and its loading line) shows at once.
    void this.load();
  }

  exit() {
    audio.setIntensity(0.3);
    this.token++;
    this.loading = false;
    this.controls.enabled = false;
    this.unsub.forEach((f) => f());
    this.unsub = [];
    this.clearScene();
    hideTooltip();
    this.root.remove();
    this.engine.canvas.style.cursor = 'default';
  }

  /** How much further back the camera sits on a narrow (portrait) screen. */
  private reach() { const a = window.innerWidth / Math.max(1, window.innerHeight); return a < 1 ? clamp(1.25 / a, 1, 2.3) : 1; }

  /** Centre the grid in the space the side panel leaves. */
  resize() {
    const w = window.innerWidth, hgt = window.innerHeight;
    const left = w > 760 ? 330 : 0;
    // Phones: the panel sits at the bottom, so the grid moves up into the space above it.
    if (left) this.camera.setViewOffset(w, hgt, -left / 2, 0, w, hgt);
    else this.camera.setViewOffset(w, hgt, 0, hgt * 0.17, w, hgt);
    this.camera.updateProjectionMatrix();
    this.panelRects = [];
  }

  /* ── Data ─────────────────────────────────────────────────────────────── */
  private async load() {
    // Refresh after an outage brings the roster too (names, connected players); onCore redraws.
    if (!store.coreLoaded) void store.loadCore().catch(() => {});
    const token = ++this.token;
    this.loading = true; this.coreStale = false;
    this.els.status.textContent = 'Loading…';
    try {
      const [reactors, subs, allocs, providers, infusions] = await Promise.all([
        lcd.list<RawReactor>('reactor', 'Reactor'), lcd.list<RawSubstation>('substation', 'Substation'),
        lcd.list<RawAllocation>('allocation', 'Allocation'), lcd.list<RawProvider>('provider', 'Provider'),
        lcd.list<RawInfusion>('infusion', 'Infusion'),
      ]);
      if (token !== this.token) return;
      // Grid attributes (capacity, load, connections, fuel, power) come one entity at a time.
      const grids = new Map<string, Grid>();
      const ids = [...reactors.map((r) => ['reactor', r.id]), ...subs.map((s) => ['substation', s.id]), ...allocs.map((a) => ['allocation', a.id])];
      await pooled(ids, 8, async ([kind, id]) => {
        try { const r = await lcd.entity<{ gridAttributes?: Grid }>(kind, id); grids.set(id, r.gridAttributes || {}); } catch { grids.set(id, {}); }
      });
      if (token !== this.token) return;
      this.data = { reactors, subs, allocs, providers, infusions, grids };
      this.buildScene();
      this.renderSummary();
      this.els.status.textContent = '';
    } catch {
      if (token === this.token) {
        this.els.status.textContent = 'Grid could not be read'; toast('Could not read the energy grid', 'warn');
        // A roster that arrived meanwhile still redraws the grid we have.
        if (this.coreStale && this.data) { this.buildScene(); this.renderSummary(); }
      }
    } finally {
      if (token === this.token) this.loading = false;
    }
  }

  /* ── Scene ────────────────────────────────────────────────────────────── */
  private clearScene() {
    for (const n of this.nodes.values()) n.label?.remove();
    // Everything drawn lives under one group: free each geometry and material once.
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => this.release(x)); else if (mat) this.release(mat);
    });
    this.group.clear();
    this.nodes.clear();
    this.art.clear();
    this.flows = []; this.hoveredFlow = null; this.fan.clear(); this.flowIds.clear();
    this.flares = []; this.fuel = null; this.glintGeo = null; this.decalGeo = null;
    this.dust = null; this.dustMat = null;
    this.playerPos.clear();
    this.panelRects = [];
    for (const r of this.reticles) { r.id = null; r.mesh.visible = false; }
  }

  /** Dispose a material, unless it is the first drawn one of its program: that one is kept, so the program stays compiled. */
  private release(m: THREE.Material) {
    const key = programKey(m);
    if (key && this.pinned.get(key) === m) return;
    if (key && !this.pinned.has(key) && m.userData.drawn) { this.pinned.set(key, m); return; }
    m.dispose();
  }

  private buildScene() {
    const d = this.data;
    if (!d) return;
    this.clearScene();
    const subs = d.subs.slice().sort((a, b) => idIndex(a.id) - idIndex(b.id));
    const reactors = d.reactors.slice().sort((a, b) => idIndex(a.id) - idIndex(b.id));
    // Status glints (deck lights, allocation ports, you), tethers and floor decals gather here, one draw each.
    const glints: number[] = [], glintCol: number[] = [], glintP: number[] = [];
    const glint = (p: THREE.Vector3, c: number, size: number, phase: number, mode: number) => { const col = new THREE.Color(c); glints.push(p.x, p.y, p.z); glintCol.push(col.r, col.g, col.b); glintP.push(size, phase, mode, 0); };
    const tethers: number[] = [], tetherCol: number[] = [], tetherH: number[] = [];
    const tether = (x: number, y: number, z: number, c: number) => { const col = new THREE.Color(c); tethers.push(x, y, z, x, GROUND_Y, z); tetherCol.push(col.r, col.g, col.b, col.r, col.g, col.b); tetherH.push(1, 0); };
    const decals: { at: THREE.Vector3; color: number; radius: number; mark: number; level: number; kind: number }[] = [];

    // Who is connected where (from the roster).
    const members = new Map<string, string[]>();
    for (const p of store.players.values()) if (p.substationId) { const l = members.get(p.substationId) || []; l.push(p.id); members.set(p.substationId, l); }

    // Substations on a ring; one that serves most of the galaxy takes the centre.
    let total = 0;
    for (const l of members.values()) total += l.length;
    const hub = [...members.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const hubId = hub && hub[1].length > total * 0.4 ? hub[0] : null;
    const onRing = subs.filter((s) => s.id !== hubId);
    subs.forEach((s) => {
      const i = onRing.indexOf(s);
      const a = (i / Math.max(1, onRing.length)) * Math.PI * 2 - Math.PI / 2;
      const g = d.grids.get(s.id) || {};
      const cap = Number(big(g.capacity)) / 1e6;     // mW → kW
      const size = 1.1 + clamp(Math.log10(1 + cap) * 0.35, 0, 2.2);
      const pos = s.id === hubId ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(Math.cos(a) * SUB_R, 0, Math.sin(a) * SUB_R);
      const color = store.guildColor(store.players.get(s.owner)?.guildId || '');
      // The pick proxy keeps the old hit shape; the station itself is drawn around it.
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(size, size, size * 0.7, 6), new THREE.MeshBasicMaterial());
      mesh.visible = false;
      mesh.position.copy(pos);
      mesh.userData.node = s.id;
      this.group.add(mesh);
      const st = this.addSubstationArt(s.id, pos, size, color, g);
      const art = this.art.get(s.id)!;
      // Deck lights at the six corners chase (online), breathe (idle) or blink (offline).
      art.glint = glints.length / 3;
      for (let k = 0; k < 6; k++) { const th = (k / 6) * Math.PI * 2; glint(new THREE.Vector3(pos.x + Math.sin(th) * size * 0.97, pos.y + size * 0.2, pos.z + Math.cos(th) * size * 0.97), st.light, 1.3 + size * 0.2, k / 6, st.mode); }
      tether(pos.x, pos.y - size * 0.8, pos.z, color);
      art.decal = decals.length;
      decals.push({ at: pos, color, radius: size * 5.5, mark: size * 1.15, level: st.level, kind: 1 });
      const node: Node = { id: s.id, kind: 'substation', pos, grid: g, mesh, color, size };
      node.label = h('div', { class: 'grid-label sub' }, h('span', { class: 't-label' }, s.name || s.id), h('span', { class: 't-tiny dw-gl' }, ico('team', 11), formatInt(Number(g.connectionCount || 0))));
      this.root.appendChild(node.label);
      this.nodes.set(s.id, node);
    });

    // Reactors above, in their guild's colour, sized by the fuel infused.
    reactors.forEach((r, i) => {
      const a = (i / reactors.length) * Math.PI * 2 - Math.PI / 2 + Math.PI / reactors.length;
      const g = d.grids.get(r.id) || {};
      const fuel = Number(big(g.fuel)) / 1e6;        // ualpha → grams
      const size = 1.2 + clamp(Math.log10(1 + fuel) * 0.55, 0, 2.8);
      const pos = new THREE.Vector3(Math.cos(a) * REACTOR_R, REACTOR_Y + Math.sin(i * 1.7) * 3, Math.sin(a) * REACTOR_R);
      const color = store.guildColor(r.guildId);
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 1), new THREE.MeshBasicMaterial());
      mesh.visible = false;
      mesh.position.copy(pos);
      mesh.userData.node = r.id;
      this.group.add(mesh);
      const look = this.addReactorArt(r.id, pos, size, color, g);
      tether(pos.x, pos.y - size * 1.1, pos.z, color);
      this.art.get(r.id)!.decal = decals.length;
      decals.push({ at: pos, color, radius: size * 3.6, mark: size * 0.9, level: look.level, kind: 0 });
      const node: Node = { id: r.id, kind: 'reactor', pos, grid: g, mesh, color, size };
      // A reactor's label: a star and its id, its guild as a dot in the guild's colour (the name is in its readout).
      node.label = h('div', { class: 'grid-label reactor' }, h('span', { class: 't-label dw-gl' }, ico('star', 12), r.id), h('i', { class: 'dw-gdot', style: `background:#${new THREE.Color(color).getHexString()}` }));
      this.root.appendChild(node.label);
      this.nodes.set(r.id, node);
    });

    // Connected players: a disc around each substation (golden-angle spiral), coloured by guild.
    // Each is a tiny world lit by its substation, tied to it by a faint thread energy ripples along.
    const pts: number[] = [], cols: number[] = [], sizes: number[] = [], suns: number[] = [];
    const thr: number[] = [], thrCol: number[] = [], thrT: number[] = [], thrLen: number[] = [];
    const tmp = new THREE.Color();
    const me = commander.id;
    for (const [sid, list] of members) {
      const sub = this.nodes.get(sid);
      if (!sub) continue;
      const rnd = mulberry(hash32(sid));
      const spread = Math.sqrt(list.length) * 0.24;
      list.forEach((pid, k) => {
        const r = 2.8 + spread * Math.sqrt((k + 0.5) / list.length);
        const th = k * 2.39996 + rnd() * 0.2;
        const p = new THREE.Vector3(sub.pos.x + Math.cos(th) * r, -1.2 + (rnd() - 0.5) * 0.8, sub.pos.z + Math.sin(th) * r);
        this.playerPos.set(pid, p);
        pts.push(p.x, p.y, p.z);
        tmp.setHex(pid === me ? 0xffffff : store.guildColor(store.players.get(pid)?.guildId || ''));
        cols.push(tmp.r, tmp.g, tmp.b);
        sizes.push(pid === me ? 5 : 1.2 + (hash32(pid) % 100) / 100 * 0.8);
        suns.push(sub.pos.x, sub.pos.y + 1.5, sub.pos.z);
        thr.push(sub.pos.x, sub.pos.y - 0.4, sub.pos.z, p.x, p.y, p.z);
        thrCol.push(tmp.r, tmp.g, tmp.b, tmp.r, tmp.g, tmp.b);
        thrT.push(0, 1);
        const len = Math.hypot(p.x - sub.pos.x, p.z - sub.pos.z);
        thrLen.push(len, len);
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
    geo.setAttribute('aSun', new THREE.Float32BufferAttribute(suns, 3));
    this.dustMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { ...this.U },
      vertexShader: /* glsl */ `
        attribute float size; attribute vec3 color, aSun; uniform float uTime, uPixelRatio;
        varying vec3 vColor, vL; varying float vPx, vDepth;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vL = normalize((modelViewMatrix * vec4(aSun, 1.0)).xyz - mv.xyz);
          gl_Position = projectionMatrix * mv;
          vDepth = -mv.z;
          vPx = size * uPixelRatio * (120.0 / -mv.z);
          gl_PointSize = clamp(vPx, 1.5, 22.0 * uPixelRatio);
        }`,
      fragmentShader: /* glsl */ `
        ${FOG_GLSL}
        varying vec3 vColor, vL; varying float vPx, vDepth;
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0; p.y = -p.y;
          float r2 = dot(p, p);
          if (r2 > 1.0) discard;
          float fog = fogK(vDepth);
          // Too small to resolve: a lit speck.
          float speck = smoothstep(1.0, 0.0, r2);
          // Large enough: a world with a day side, a terminator and an atmosphere rim.
          vec3 n = vec3(p, sqrt(1.0 - r2));
          float lam = max(dot(n, vL), 0.0);
          float term = smoothstep(-0.15, 0.3, dot(n, vL));
          float rim = pow(1.0 - n.z, 2.5);
          vec3 world = vColor * (0.04 + 1.25 * lam) + mix(vColor, vec3(0.8, 0.92, 1.0), 0.45) * rim * (0.15 + 1.3 * term);
          world *= 1.0 - smoothstep(1.0 - 2.5 / max(vPx, 2.5), 1.0, sqrt(r2));
          vec3 col = mix(vColor * speck * 0.95, world, smoothstep(3.0, 6.0, vPx));
          gl_FragColor = vec4(col * fog, 1.0);
        }`,
    });
    this.dust = new THREE.Points(geo, this.dustMat);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
    if (thr.length) {
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.Float32BufferAttribute(thr, 3));
      tg.setAttribute('aColor', new THREE.Float32BufferAttribute(thrCol, 3));
      tg.setAttribute('aT', new THREE.Float32BufferAttribute(thrT, 1));
      tg.setAttribute('aLen', new THREE.Float32BufferAttribute(thrLen, 1));
      const threads = new THREE.LineSegments(tg, new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { ...this.U },
        vertexShader: /* glsl */ `
          attribute vec3 aColor; attribute float aT, aLen; varying vec3 vCol; varying float vT, vLen, vDepth;
          void main() { vCol = aColor; vT = aT; vLen = aLen; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
        fragmentShader: /* glsl */ `
          ${FOG_GLSL}
          uniform float uTime; varying vec3 vCol; varying float vT, vLen, vDepth;
          void main() {
            float s = vT * vLen;
            float wave = fract(s / 9.0 - uTime * 0.45);
            float pulse = smoothstep(0.7, 0.97, wave) * (1.0 - smoothstep(0.97, 1.0, wave));
            float a = (0.022 + pulse * 0.09) * (1.0 - vT * 0.55);
            gl_FragColor = vec4(vCol * a * fogK(vDepth), 1.0);
          }`,
      }));
      threads.frustumCulled = false;
      this.group.add(threads);
    }
    // The pinned commander, labelled where they draw their power.
    const mePos = me ? this.playerPos.get(me) : undefined;
    if (me && mePos) {
      const sub = store.players.get(me)?.substationId || '';
      const label = h('div', { class: 'grid-label me' }, h('span', { class: 't-label' }, 'You'), h('span', { class: 't-tiny' }, `${store.playerName(me)} · ${sub}`));
      this.root.appendChild(label);
      this.nodes.set('me:' + me, { id: 'me:' + me, kind: 'player', pos: mePos, grid: {}, color: 0xffffff, label });
      glint(mePos, 0xffffff, 3.2, 0, 0);
    }

    // Allocations: source → substation. Infusions: player → reactor.
    const where = (id: string): THREE.Vector3 | null => {
      const n = this.nodes.get(id);
      if (n) return n.pos;
      if (idType(id) === 1) return this.playerPos.get(id) || null;
      if (idType(id) === 5) return null;
      return null;
    };
    for (const a of d.allocs) {
      const to = this.nodes.get(a.destinationId);
      if (!to) continue;
      let from = where(a.sourceObjectId);
      // An allocating player with no connection of their own: drawn just outside the substation.
      if (!from) { const ang = hash32(a.sourceObjectId) % 628 / 100; from = to.pos.clone().add(new THREE.Vector3(Math.cos(ang) * 9, 6, Math.sin(ang) * 9)); }
      const power = Number(big(d.grids.get(a.id)?.power)) / 1e6;
      const src = idType(a.sourceObjectId) === 1 ? store.playerName(a.sourceObjectId) : a.sourceObjectId;
      const color = a.type === 'providerAgreement' ? 0x66d7eb : 0xebaa49;
      this.addFlow({ a: from, b: to.pos, power, color, kind: 'allocation', id: a.id,
        label: a.type === 'providerAgreement' ? `Rented power · ${a.id}` : `Power flow · ${a.id}`, detail: () => `${src} → substation ${a.destinationId} · ${formatPower(d.grids.get(a.id)?.power)}` });
      // The port the conduit leaves from, unless it starts inside another node.
      if (!this.nodes.has(a.sourceObjectId)) glint(from, color, 2.4, (hash32(a.id) % 100) / 100, 0);
    }
    const fuelFlows: Flow[] = [];
    for (const f of d.infusions) {
      if (f.destinationType !== 'reactor') continue;
      const to = this.nodes.get(f.destinationId);
      const from = this.playerPos.get(f.playerId);
      if (!to || !from) continue;
      fuelFlows.push(this.addFlow({ a: from, b: to.pos, power: Number(big(f.fuel)) / 1e6, color: 0xc77dff, kind: 'infusion', id: f.playerId + '>' + f.destinationId,
        label: 'Fuel (alpha in)', detail: () => `${store.playerName(f.playerId)} → reactor ${f.destinationId} · ${formatAlpha(f.fuel)} fuel` }));
    }
    this.buildFuel(fuelFlows);
    this.buildGlints(glints, glintCol, glintP);
    this.buildTethers(tethers, tetherCol, tetherH);
    this.buildDecals(decals);
    for (const o of this.group.children) o.onBeforeRender = markDrawn;
    this.layoutLabels();
  }

  /** Live grid records change capacity, load, connections and fuel in place: restyle each node from its record, no rebuild. */
  private refreshArt() {
    const gl = this.glintGeo, dc = this.decalGeo, c = new THREE.Color();
    const gCol = gl?.getAttribute('aColor') as THREE.BufferAttribute | undefined, gP = gl?.getAttribute('aP') as THREE.BufferAttribute | undefined;
    const dPar = dc?.getAttribute('aParam') as THREE.BufferAttribute | undefined;
    for (const [id, a] of this.art) {
      const n = this.nodes.get(id);
      if (!n) continue;
      let level: number;
      if (a.kind === 'reactor') {
        const k = reactorLook(n.grid);
        a.u.uHeat.value = k.heat; a.u.uDormant.value = k.dormant ? 1 : 0;
        if (k.dormant && !a.dormant) { a.flare!.t = -1; a.u.uFlare.value = 0; }
        a.dormant = k.dormant; level = k.level;
      } else {
        const k = stationLook(n.grid, n.color);
        styleStation(a.u, k);
        a.glow = k.glow; level = k.level;
        if (gCol && gP && a.glint != null) { c.setHex(k.light); for (let j = 0; j < 6; j++) { gCol.setXYZ(a.glint + j, c.r, c.g, c.b); gP.setZ(a.glint + j, k.mode); } }
      }
      if (dPar && a.decal != null) for (let v = 0; v < 4; v++) dPar.setZ(a.decal * 4 + v, level);
    }
    if (gCol && gP) { gCol.needsUpdate = true; gP.needsUpdate = true; }
    if (dPar) dPar.needsUpdate = true;
  }

  /** A reactor: a caged miniature star. Returns its look. */
  private addReactorArt(id: string, pos: THREE.Vector3, size: number, color: number, g: Grid) {
    const seed = (hash32(id) % 1000) / 61;
    const look = reactorLook(g);
    const u = artUniforms();
    u.uHeat.value = look.heat; u.uDormant.value = look.dormant ? 1 : 0;
    const uni = { ...this.U, uBoost: u.uBoost, uFlare: u.uFlare, uFlareAng: u.uFlareAng, uHeat: u.uHeat, uDormant: u.uDormant, uColor: { value: new THREE.Color(color) }, uSeed: { value: seed } };
    // A star a few pixels across: the Dreamcast look draws it with a console's handful of facets.
    const core = new THREE.Mesh(new THREE.SphereGeometry(size, LOOK.dc ? 24 : 64, LOOK.dc ? 12 : 32), new THREE.ShaderMaterial({ uniforms: uni, vertexShader: STAR_VS, fragmentShader: STAR_FS }));
    core.position.copy(pos);
    const corona = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { ...uni, uSize: { value: size * CORONA_EXT } }, vertexShader: BILLBOARD_VS, fragmentShader: CORONA_FS,
    }));
    corona.position.copy(pos);
    corona.frustumCulled = false;
    corona.renderOrder = 2;
    const gimbal = new THREE.LineSegments(gimbalGeometry(size, seed), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: uni, vertexShader: GIMBAL_VS, fragmentShader: GIMBAL_FS,
    }));
    gimbal.position.copy(pos);
    gimbal.rotation.y = seed;
    this.group.add(core, corona, gimbal);
    const rnd = mulberry(hash32(id));
    this.art.set(id, { kind: 'reactor', size, boost: 0, seed, u, spin: gimbal, dormant: look.dormant, flare: { t: -1, next: 2 + rnd() * 12 } });
    return look;
  }

  /** A substation: a machined hex deck over a tapered hull, a floating core crystal and a halo ring with its load gauge. */
  private addSubstationArt(id: string, pos: THREE.Vector3, size: number, color: number, g: Grid) {
    const tex = deckTextures(this.engine.renderer);
    const look = stationLook(g, color), glow = look.glow;
    const u = artUniforms();
    styleStation(u, look);
    // The plating is painted dark; a colour above one lifts it into the key light without losing the paint.
    const top = new THREE.MeshStandardMaterial({ map: tex.top, emissiveMap: tex.topGlow, emissive: color, emissiveIntensity: glow, metalness: 0.5, roughness: 0.42, color: new THREE.Color(2.4, 2.4, 2.4) });
    const side = new THREE.MeshStandardMaterial({ map: tex.side, emissiveMap: tex.sideGlow, emissive: color, emissiveIntensity: glow, metalness: 0.55, roughness: 0.42, color: new THREE.Color(2, 2, 2) });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2c3540, metalness: 0.65, roughness: 0.5 });
    const deckH = size * 0.3;
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(size, size * 0.95, deckH, 6), [side, top, dark]);
    deck.position.copy(pos);
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.86, size * 0.32, size * 0.5, 6), [side, dark, dark]);
    hull.position.set(pos.x, pos.y - deckH / 2 - size * 0.25, pos.z);
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(size * 0.24, 0), new THREE.ShaderMaterial({
      uniforms: { ...this.U, uBoost: u.uBoost, uLevel: u.uGemLevel, uColor: u.uGem },
      vertexShader: CRYSTAL_VS, fragmentShader: CRYSTAL_FS,
    }));
    crystal.scale.y = 1.7;
    const baseY = pos.y + deckH / 2 + size * 0.55;
    crystal.position.set(pos.x, baseY, pos.z);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { ...this.U, uBoost: u.uBoost, uLoad: u.uLoad, uSeed: { value: (hash32(id) % 100) / 100 }, uLevel: u.uLevel, uColor: { value: new THREE.Color(color) }, uState: u.uState },
      vertexShader: HALO_VS, fragmentShader: HALO_FS,
    }));
    halo.rotation.x = -Math.PI / 2;
    halo.scale.setScalar(size * 2.25);
    halo.position.set(pos.x, pos.y - deckH * 0.5, pos.z);
    this.group.add(deck, hull, crystal, halo);
    this.art.set(id, { kind: 'substation', size, boost: 0, seed: (hash32(id) % 628) / 100, u, crystal, baseY, deck: [top, side], glow });
    return look;
  }

  /** Conduits already drawn between the same two points: the next one fans out beside them. */
  private fan = new Map<string, number>();
  private addFlow(f: Flow) {
    const mid = f.a.clone().lerp(f.b, 0.5);
    mid.y += 6 + f.a.distanceTo(f.b) * 0.18;
    const key = `${f.a.toArray().map((v) => v.toFixed(1))}>${f.b.toArray().map((v) => v.toFixed(1))}`;
    const k = this.fan.get(key) || 0;
    this.fan.set(key, k + 1);
    if (k) {
      const side = new THREE.Vector3().subVectors(f.b, f.a).cross(new THREE.Vector3(0, 1, 0));
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      mid.addScaledVector(side.normalize(), (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 1.8);
    }
    const curve = new THREE.QuadraticBezierCurve3(f.a.clone(), mid, f.b.clone());
    const w = f.kind === 'infusion' ? 0.1 : clamp(0.22 + Math.log10(1 + f.power) * 0.07, 0.22, 0.7);
    const geo = new THREE.TubeGeometry(curve, 64, w, 8, false);
    // Packets run faster (and brighter) the more power the conduit carries.
    const load = clamp(Math.log10(1 + f.power) / 4, 0, 1);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { ...this.U, uSpeed: { value: 3 + load * 9 }, uGlow: { value: f.kind === 'infusion' ? 0.6 : 1 }, uFocus: { value: 1 }, uLen: { value: curve.getLength() }, uLoad: { value: load }, uKind: { value: f.kind === 'infusion' ? 1 : 0 }, uColor: { value: new THREE.Color(f.color) } },
      vertexShader: FLOW_VS, fragmentShader: FLOW_FS,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.flow = f;
    this.group.add(mesh);
    f.mesh = mesh;
    f.curve = curve;
    this.flows.push(f);
    this.flowIds.add(f.id);
    return f;
  }

  /** Fuel: particles spiralling up each infusion's arc, whitening as they near the reactor. */
  private buildFuel(flows: Flow[]) {
    if (!flows.length) return;
    const A: number[] = [], Cc: number[] = [], B: number[] = [], seed: number[] = [], ranges: number[] = [];
    const rnd = mulberry(7);
    for (const f of flows) {
      const c = f.curve!;
      const n = Math.round(clamp(14 + Math.log10(1 + f.power) * 14, 14, 64));
      ranges.push(A.length / 3, n);
      for (let i = 0; i < n; i++) {
        A.push(c.v0.x, c.v0.y, c.v0.z); Cc.push(c.v1.x, c.v1.y, c.v1.z); B.push(c.v2.x, c.v2.y, c.v2.z);
        seed.push(i / n + rnd() * 0.04, 0.06 + rnd() * 0.02, rnd() * 6.28, 0.6 + rnd() * 0.9);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(A, 3));
    geo.setAttribute('aC', new THREE.Float32BufferAttribute(Cc, 3));
    geo.setAttribute('aB', new THREE.Float32BufferAttribute(B, 3));
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 4));
    geo.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(A.length / 3).fill(1), 1));
    const pts = new THREE.Points(geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { ...this.U, uColor: { value: new THREE.Color(0xc77dff) } },
      vertexShader: /* glsl */ `
        attribute vec3 aC, aB; attribute vec4 aSeed; attribute float aGlow;
        uniform float uTime, uPixelRatio;
        varying float vA, vT, vDepth;
        void main() {
          float t = fract(aSeed.x + uTime * aSeed.y);
          vec3 a = position;
          vec3 p = mix(mix(a, aC, t), mix(aC, aB, t), t);
          vec3 tg = normalize(mix(aC - a, aB - aC, t) + vec3(0.0, 1e-4, 0.0));
          vec3 sd = normalize(cross(tg, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
          vec3 up = cross(sd, tg);
          float sw = aSeed.z + uTime * 1.6 + t * 14.0;
          p += (sd * cos(sw) + up * sin(sw)) * 0.32 * sin(t * 3.14159);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          vDepth = -mv.z;
          vT = t;
          vA = sin(t * 3.14159) * aGlow;
          gl_PointSize = clamp(aSeed.w * uPixelRatio * (150.0 / -mv.z) * (0.7 + 0.5 * aGlow), 1.8 * uPixelRatio, 16.0 * uPixelRatio);
        }`,
      fragmentShader: /* glsl */ `
        ${FOG_GLSL}
        uniform vec3 uColor; varying float vA, vT, vDepth;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = exp(-d * d * 6.0) * 0.8 + exp(-d * d * 40.0) * 1.2;
          vec3 col = mix(uColor, vec3(1.0, 0.93, 1.0), smoothstep(0.5, 1.0, vT) * 0.7);
          gl_FragColor = vec4(col * a * vA * 1.3 * fogK(vDepth), 1.0);
        }`,
    }));
    pts.frustumCulled = false;
    this.group.add(pts);
    this.fuel = { geo, flows, ranges, last: new Float32Array(flows.length).fill(1) };
  }

  /** Status glints: deck corner lights, allocation ports and the commander's beacon. */
  private buildGlints(pos: number[], col: number[], p: number[]) {
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('aP', new THREE.Float32BufferAttribute(p, 4));
    this.glintGeo = geo;
    const pts = new THREE.Points(geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { ...this.U },
      vertexShader: /* glsl */ `
        attribute vec3 aColor; attribute vec4 aP; uniform float uTime, uPixelRatio, uCalm;
        varying vec3 vCol; varying float vA, vDepth;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          vDepth = -mv.z;
          float m = aP.z, ph = aP.y, b;
          if (m < 0.5) b = 0.6 + 0.4 * sin(uTime * 2.2 + ph * 6.2831);
          else if (m < 1.5) b = 0.25 + 0.75 * pow(max(0.5 + 0.5 * sin(uTime * 3.0 - ph * 6.2831), 0.0), 6.0);
          else if (m < 2.5) b = uCalm > 0.5 ? 0.35 + 0.25 * sin(uTime * 1.2 + ph * 6.2831) : 0.1 + 0.9 * step(0.8, fract(uTime * 0.6 + ph * 0.17));
          else b = 0.55 + 0.35 * sin(uTime * 1.1 + ph * 6.2831);
          vA = b; vCol = aColor;
          gl_PointSize = clamp(aP.x * uPixelRatio * (110.0 / -mv.z), 1.5, 26.0 * uPixelRatio);
        }`,
      fragmentShader: /* glsl */ `
        ${FOG_GLSL}
        varying vec3 vCol; varying float vA, vDepth;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = exp(-d * d * 4.0) * 0.5 + exp(-d * d * 22.0) * 2.0;
          gl_FragColor = vec4(mix(vCol, vec3(1.0), exp(-d * d * 40.0) * 0.5) * a * vA * fogK(vDepth), 1.0);
        }`,
    }));
    pts.frustumCulled = false;
    this.group.add(pts);
  }

  /** Altitude tethers: dashed drops from each node to the floor, Homeworld-style. */
  private buildTethers(pos: number[], col: number[], hgt: number[]) {
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('aH', new THREE.Float32BufferAttribute(hgt, 1));
    const lines = new THREE.LineSegments(geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { ...this.U },
      vertexShader: /* glsl */ `
        attribute vec3 aColor; attribute float aH; varying vec3 vCol; varying float vH, vY, vDepth;
        void main() { vCol = aColor; vH = aH; vY = position.y; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        ${FOG_GLSL}
        uniform float uTime; varying vec3 vCol; varying float vH, vY, vDepth;
        void main() {
          float dash = step(0.45, fract(vY * 0.8 + uTime * 0.3));
          gl_FragColor = vec4(vCol * mix(0.32, 0.06, vH) * (0.3 + 0.7 * dash) * fogK(vDepth), 1.0);
        }`,
    }));
    lines.frustumCulled = false;
    this.group.add(lines);
  }

  /** Floor decals: each node's light pooled on the lattice, with its footprint marked (ring under a reactor, hex under a station). */
  private buildDecals(list: { at: THREE.Vector3; color: number; radius: number; mark: number; level: number; kind: number }[]) {
    if (!list.length) return;
    const pos: number[] = [], ctr: number[] = [], col: number[] = [], par: number[] = [], index: number[] = [];
    const c = new THREE.Color();
    list.forEach((d, i) => {
      c.setHex(d.color);
      for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        pos.push(x, 0, z); ctr.push(d.at.x, GROUND_Y + 0.02, d.at.z); col.push(c.r, c.g, c.b); par.push(d.radius, d.mark, d.level, d.kind);
      }
      const b = i * 4;
      index.push(b, b + 2, b + 1, b, b + 3, b + 2);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aCenter', new THREE.Float32BufferAttribute(ctr, 3));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('aParam', new THREE.Float32BufferAttribute(par, 4));
    geo.setIndex(index);
    this.decalGeo = geo;
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { ...this.U },
      vertexShader: /* glsl */ `
        attribute vec3 aCenter, aColor; attribute vec4 aParam;
        varying vec2 vP; varying vec3 vW, vCol; varying vec4 vParam; varying float vDepth;
        void main() {
          vP = position.xz;
          vec3 w = aCenter + vec3(position.x, 0.0, position.z) * aParam.x;
          vW = w; vCol = aColor; vParam = aParam;
          vec4 mv = modelViewMatrix * vec4(w, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        ${FOG_GLSL}
        ${HEX_GLSL}
        uniform float uTime;
        varying vec2 vP; varying vec3 vW, vCol; varying vec4 vParam; varying float vDepth;
        void main() {
          float r = length(vP);
          if (r > 1.0) discard;
          vec2 lp = vP * vParam.x;
          float rw = length(lp);
          float pool = exp(-r * r * 5.0);
          float lit = gridLine(hexEdge(vW.xz / 3.2), 0.8) * exp(-r * r * 3.5);
          float m = vParam.y, mark;
          if (vParam.w < 0.5) {
            float fw = fwidth(rw);
            float a = atan(lp.y, lp.x) / 6.2831853;
            mark = (1.0 - smoothstep(fw * 0.6, fw * 1.8, abs(rw - m)))
                 + (1.0 - smoothstep(fw * 0.6, fw * 1.8, abs(rw - m * 1.5))) * step(0.5, fract(a * 18.0 + uTime * 0.04)) * 0.6
                 + (1.0 - smoothstep(fw * 0.6, fw * 1.8, rw - m * 0.12)) * 0.8;
          } else {
            vec2 q = abs(lp.yx);
            float hd = max(q.x, dot(q, vec2(0.5, 0.8660254)));
            float hw = fwidth(hd);
            mark = (1.0 - smoothstep(hw * 0.6, hw * 1.8, abs(hd - m))) + (1.0 - smoothstep(hw * 0.6, hw * 1.8, abs(hd - m * 1.22))) * 0.35;
          }
          vec3 col = vCol * (pool * 0.06 + lit * 0.22 + mark * 0.3) * vParam.z;
          gl_FragColor = vec4(col * fogK(vDepth), 1.0);
        }`,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    this.group.add(mesh);
  }

  /* ── UI ───────────────────────────────────────────────────────────────── */
  private buildUi() {
    const summary = h('div', { class: 'col', style: 'gap:8px' });
    const status = h('div', { class: 't-tiny c-hint' }, 'Loading…');
    // The legend: each colour as it runs through the grid, with a picture of what it carries (the words are titles).
    const sw = (color: string, pic: string, label: string, cls = '') => h('span', { class: 'dw-sw ' + cls, title: label, role: 'img', 'aria-label': label },
      h('i', { class: 'lg dw-line', style: `background:${color}; box-shadow:0 0 6px ${color}` }), ico(pic, 14));
    const left = h('div', { class: 'grid-left panel neutral' },
      h('div', { class: 'panel-head', title: 'Reactors (the big glowing stars) turn alpha into power. The power flows down to substations, and each substation shares it out to the players connected to it. Use more power than you get and you go offline.' },
        h('span', { class: 'dw-head' }, ico('grid', 20), h('span', { class: 't-label' }, 'Power Grid')),
        h('button', { class: 'btn ghost mini dw-ibtn', title: 'Read the grid again', 'aria-label': 'Refresh', onclick: () => { audio.play('select'); void this.load(); } }, ico('refresh', 15))),
      h('div', { class: 'panel-body col scroll' },
        h('div', { class: 't-tiny c-hint x-only' }, 'Players infuse Alpha into reactors and gain capacity. Allocations route capacity into substations, and every player connected to a substation draws an equal share. Overload a struct’s grid and it goes offline.'),
        status, summary,
        h('div', { class: 'divider' }),
        h('div', { class: 'grid-legend' },
          sw(K_FLOW, 'charge', 'Power flow (an allocation)'), sw(K_RENT, 'market', 'Rented power (a provider agreement)'),
          sw(K_FUEL, 'fuel', 'Fuel: alpha infused into a reactor'),
          h('span', { class: 'dw-sw', title: 'A player, connected to a substation', role: 'img', 'aria-label': 'A player' }, h('i', { class: 'lg lg-home' }), ico('team', 14)),
          h('span', { class: 'dw-sw legend-hint', title: 'Drag to orbit · wheel to zoom · click a substation or reactor', role: 'img', 'aria-label': 'Drag to orbit, wheel to zoom, click a substation or reactor' }, ico('mouse', 15), h('span', { class: 'dw-sw-k' }, '↻ ±')))));
    const card = h('div', { class: 'grid-card panel neutral' });
    this.root.append(left, card);
    this.els = { summary, status, card, left };
  }

  private renderSummary() {
    const d = this.data;
    if (!d) return;
    let cap = 0n, load = 0n, fuel = 0n, conns = 0;
    for (const s of d.subs) { const g = d.grids.get(s.id) || {}; cap += big(g.capacity); load += big(g.load); conns += Number(g.connectionCount || 0); }
    for (const r of d.reactors) fuel += big(d.grids.get(r.id)?.fuel);
    // A tile: a picture and a number; the picture's name is the tile's title (and its accessible label).
    const tile = (pic: string, label: string, value: string, color = '', box = '') => h('div', { class: 'dw-tile ' + box, title: label },
      h('span', { class: 'dw-ico', role: 'img', 'aria-label': label, style: color ? `color:${color}` : undefined, html: icon(pic, 18) }), h('b', { class: 'num' }, value));
    const providers = d.providers.map((p) => h('div', { class: 'guild-row static' },
      h('i', { class: 'swatch', style: `background:${K_RENT}` }),
      h('span', { class: 'grow', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, `${store.playerName(p.owner)} · ${p.substationId}`),
      h('span', { class: 'num c-hint', title: `${p.accessPolicy}; ${p.capacityMinimum}–${p.capacityMaximum} mW for ${p.durationMinimum}–${p.durationMaximum} blocks` }, `${p.rate.amount} ${p.rate.denom.replace(/^u/, '')}/blk`)));
    // Guild power: the reactors a guild runs and the fuel staked in them.
    const guilds = new Map<string, { reactors: number; fuel: bigint }>();
    for (const r of d.reactors) {
      const g = guilds.get(r.guildId) || { reactors: 0, fuel: 0n };
      g.reactors++; g.fuel += big(d.grids.get(r.id)?.fuel);
      guilds.set(r.guildId, g);
    }
    const guildRows = [...guilds.entries()].sort((a, b) => (b[1].fuel > a[1].fuel ? 1 : b[1].fuel < a[1].fuel ? -1 : 0)).map(([gid, g]) => h('div', { class: 'guild-row static', title: `${store.guildName(gid)} · ${store.members(gid)} members · ${g.reactors} reactor${g.reactors === 1 ? '' : 's'} · ${formatAlpha(g.fuel.toString())} fuel` },
      h('i', { class: 'swatch', style: `background:#${new THREE.Color(store.guildColor(gid)).getHexString()}` }),
      h('span', { class: 'grow', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, store.guildName(gid)),
      h('span', { class: 'num dw-num' }, ico('star', 12, 'c-neutral'), String(g.reactors)),
      h('span', { class: 'num dw-num dw-fuel' }, ico('fuel', 12), formatAlpha(g.fuel.toString()))));
    const sec = (pic: string, word: string, title: string) => h('div', { class: 'dw-sec', title }, ico(pic, 16), h('span', { class: 't-label' }, word));
    this.els.summary.replaceChildren(
      h('div', { class: 'dw-tiles' },
        tile('star', 'Reactors', String(d.reactors.length), 'var(--text-neutral-primary)'), tile('fuel', 'Fuel infused', formatAlpha(fuel.toString()), K_FUEL),
        tile('station', 'Substations', String(d.subs.length), 'var(--accent-primary)'), tile('team', 'Connections', formatInt(conns), 'var(--accent-primary)'),
        tile('charge', 'Capacity: the power the grid can give', formatPower(cap), K_FLOW), tile('gauge', 'Load: the power in use', formatPower(load)),
        tile('send', 'Allocations', String(d.allocs.length), K_FLOW, 'x-only'), tile('alpha', 'Infusions', String(d.infusions.length), K_FUEL, 'x-only')),
      h('div', { class: 'divider' }),
      sec('team', 'Guilds', 'Guild power: the reactors each guild runs and the fuel staked in them'),
      h('div', { class: 'col', style: 'gap:2px' }, guildRows),
      // The raw provider rates are an expert's view; everyone else gets the market itself, one press away.
      h('div', { class: 'divider' }),
      h('div', { class: 'x-only col', style: 'gap:4px' }, sec('market', 'Market', 'Energy market: who sells power, at what rate'),
        providers.length ? h('div', { class: 'col', style: 'gap:2px' }, providers) : h('div', { class: 't-tiny c-hint' }, 'No providers listed.')),
      h('a', { class: 'btn ghost mini s-only dw-market', href: '/economy/market', title: `Energy market: compare ${providers.length} sellers` }, ico('market', 15), 'Market', h('b', null, String(providers.length)), '▸'));
  }

  private renderCard(id: string | null) {
    const el = this.els.card, d = this.data;
    if (!id || !d) { el.replaceChildren(); el.classList.remove('open'); return; }
    const n = this.nodes.get(id);
    if (!n) return;
    const g = n.grid;
    // Facts as pictures and numbers; each picture's word is its title.
    const fact = (pic: string, label: string, v: string | HTMLElement, color = '') => [
      h('span', { class: 'dw-k', title: label, role: 'img', 'aria-label': label, style: color ? `color:${color}` : undefined, html: icon(pic, 15) }),
      typeof v === 'string' ? h('span', { class: 'num', title: label }, v) : v];
    const link = (pid: string) => h('button', { class: 'linkish dw-name c-player', title: 'Open their world', onclick: () => this.navigate('/player/' + pid) }, store.playerName(pid));
    let body: HTMLElement;
    if (n.kind === 'substation') {
      const s = d.subs.find((x) => x.id === id)!;
      const conns = Number(g.connectionCount || 0);
      const inflow = d.allocs.filter((a) => a.destinationId === id);
      const sells = d.providers.filter((p) => p.substationId === id);
      body = h('div', { class: 'panel-body col', style: 'gap:8px' },
        h('div', { class: 't-display c-player' }, s.name || 'Substation ' + s.id),
        h('div', { class: 'dw-who', title: 'Owner' }, ico('base', 15, 'c-hint'), link(s.owner)),
        h('div', { class: 'kv dw-kv' },
          ...fact('charge', 'Power', formatPower(g.capacity), K_FLOW), ...fact('gauge', 'In use', formatPower(g.load)), ...fact('team', 'Players', formatInt(conns), 'var(--accent-primary)'),
          ...fact('market', 'Sellers', String(sells.length), K_RENT), ...fact('send', 'Power flows in', String(inflow.length), K_FLOW)),
        // Each player's share as the sum it is: power ÷ players = each.
        h('div', { class: 'dw-share', title: 'Each connected player draws the same share: capacity ÷ connections. More connections dilute it.' },
          ico('charge', 14), formatPower(g.capacity), h('span', { class: 'c-hint' }, '÷'), ico('team', 14), formatInt(conns), h('span', { class: 'c-hint' }, '='), h('b', null, formatPower(g.connectionCapacity))),
        inflow.length ? h('div', { class: 'col', style: 'gap:2px' }, h('div', { class: 'dw-sec', title: 'Fed by: the power flowing in' }, ico('send', 15), h('span', { class: 't-label' }, 'Fed by')),
          ...inflow.map((a) => h('div', { class: 'spread t-tiny', title: a.type }, h('span', { class: 'row', style: 'gap:6px; min-width:0' }, h('i', { class: 'swatch', style: `background:${a.type === 'providerAgreement' ? K_RENT : K_FLOW}` }), h('span', { class: 'dw-ell' }, a.sourceObjectId.startsWith('1-') ? store.playerName(a.sourceObjectId) : a.sourceObjectId)), h('span', { class: 'num c-neutral' }, formatPower(d.grids.get(a.id)?.power))))) : null);
    } else {
      const r = d.reactors.find((x) => x.id === id)!;
      const inf = d.infusions.filter((f) => f.destinationId === id);
      body = h('div', { class: 'panel-body col', style: 'gap:8px' },
        h('div', { class: 't-display c-neutral' }, 'Reactor ' + r.id),
        h('div', { class: 'dw-who', title: 'Guild' }, h('i', { class: 'swatch', style: `background:#${new THREE.Color(store.guildColor(r.guildId)).getHexString()}` }), h('span', null, store.guildName(r.guildId)), h('span', { class: 'x-only c-hint' }, ` · validator ${r.validator.slice(0, 18)}…`)),
        h('div', { class: 'kv dw-kv', title: 'Alpha infused here is staked with the validator; the infuser gains capacity, minus the commission.' },
          ...fact('fuel', 'Fuel', formatAlpha(g.fuel), K_FUEL), ...fact('charge', 'Power made', formatPower(g.capacity), K_FLOW),
          ...fact('bank', 'Reactor keeps (commission)', (Number(r.defaultCommission) * 100).toFixed(1) + '%'), ...fact('team', 'Players fuelling it', String(inf.length), 'var(--accent-primary)')),
        inf.length ? h('div', { class: 'col scroll', style: 'gap:2px; max-height:160px' }, h('div', { class: 'dw-sec', title: 'Infused by: who fuels this reactor' }, ico('fuel', 15), h('span', { class: 't-label' }, 'Fuelled by')),
          ...inf.sort((a, b) => Number(big(b.fuel) - big(a.fuel))).slice(0, 20).map((f) => h('div', { class: 'spread t-tiny' }, link(f.playerId), h('span', { class: 'num c-neutral' }, formatAlpha(f.fuel))))) : null);
    }
    el.replaceChildren(h('div', { class: 'panel-head' }, h('span', { class: 'dw-head' }, ico(n.kind === 'substation' ? 'station' : 'star', 20), h('span', { class: 't-label' }, n.kind === 'substation' ? 'Substation' : 'Reactor')), h('button', { class: 'btn ghost icon', 'aria-label': 'Close', onclick: () => this.select(null) }, '×')), body);
    el.classList.add('open');
  }

  /** Live activity on a node or beam: a brief flare. */
  private pulses = new Map<string, number>();
  private pulse(id: string) {
    this.pulses.set(id, 1);
    const n = this.nodes.get(id);
    if (n) this.flare(n.pos, n.color, n.size || 2);
    // A reactor answers with a flare off its limb.
    const a = this.art.get(id);
    if (a?.flare && !a.dormant && a.flare.t < 0) a.flare.t = 0;
  }
  private flare(p: THREE.Vector3, color: number, size: number) {
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uK: { value: 0 }, uCalm: this.U.uCalm, uColor: { value: new THREE.Color(color).multiplyScalar(1.6) } }, vertexShader: SHOCK_VS, fragmentShader: SHOCK_FS,
    }));
    ring.onBeforeRender = markDrawn;
    ring.position.copy(p);
    ring.rotation.x = -Math.PI / 2;
    ring.scale.setScalar(4 + size * 2.4);
    ring.userData.flare = 0;
    this.group.add(ring);
    this.flares.push(ring);
  }

  private select(id: string | null) {
    this.selected = id;
    this.renderCard(id);
    if (!id) return;
    const n = this.nodes.get(id);
    if (!n) return;
    audio.play('select');
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.fly = { from: this.controls.target.clone(), to: n.pos.clone(), camFrom: this.camera.position.clone(), camTo: n.pos.clone().add(dir.multiplyScalar(n.kind === 'substation' ? 34 : 26)).add(new THREE.Vector3(0, 8, 0)), t: 0 };
  }

  private labelTick = 0;
  private panelRects: DOMRect[] = [];
  /** Labels follow their nodes; nearer and more important ones win when two would overlap. */
  private layoutLabels() {
    const w = window.innerWidth, hh = window.innerHeight;
    const v = new THREE.Vector3();
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const order = [...this.nodes.values()].filter((n) => n.label).map((n) => {
      v.copy(n.pos); v.y += n.kind === 'reactor' ? 4.5 : n.kind === 'player' ? 1.2 : 3.2;
      const d = this.camera.position.distanceTo(v);
      v.project(this.camera);
      const pri = (n.id === this.selected ? 0 : n.id === this.hovered ? 1 : 2) * 1000 + (n.kind === 'player' ? -300 : n.kind === 'substation' ? 0 : 200) + d;
      return { n, x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * hh, on: v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05, pri };
    }).sort((a, b) => a.pri - b.pri);
    // Measuring is costly: refresh label sizes (and where the panels are) every few frames.
    const measure = this.labelTick++ % 10 === 0;
    if (measure || !this.panelRects.length) {
      this.panelRects = [this.els.left, this.els.card].filter((e) => e && e.offsetParent).map((e) => e.getBoundingClientRect());
    }
    for (const o of order) {
      const el = o.n.label!;
      if (measure || !el.dataset.w) { el.dataset.w = String(el.offsetWidth || 90); el.dataset.h = String(el.offsetHeight || 30); }
      const lw = Number(el.dataset.w), lh = Number(el.dataset.h);
      const r = { x0: o.x - lw / 2, y0: o.y - lh, x1: o.x + lw / 2, y1: o.y };
      const clash = placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0);
      // Never under the side panel (desktop) or off the top bar.
      const covered = r.y0 < 46 || r.x1 > w - 6 || r.x0 < 6 || this.panelRects.some((p) => r.x0 < p.right && r.x1 > p.left && r.y0 < p.bottom && r.y1 > p.top);
      const show = o.on && !covered && (!clash || o.n.id === this.selected);
      el.style.visibility = show ? 'visible' : 'hidden';
      if (o.on) el.style.transform = `translate(${o.x}px, ${o.y}px) translate(-50%, -100%)`;
      if (show) placed.push(r);
    }
  }

  /* ── Input ────────────────────────────────────────────────────────────── */
  private bindInput() {
    const canvas = this.engine.canvas;
    let down: { x: number; y: number } | null = null;
    const move = (e: PointerEvent) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.pointerPx = { x: e.clientX, y: e.clientY };
      this.idle = 0;
    };
    // The next touch replaces a held beam readout (a tap elsewhere, or a drag).
    const dropHeld = () => { if (!this.tipTimer) return; clearTimeout(this.tipTimer); this.tipTimer = 0; hideTooltip(); this.setHoverFlow(null); };
    const pdown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; this.fly = null; if (e.pointerType !== 'mouse') dropHeld(); };
    const up = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
      down = null;
      move(e);
      // During the descent the camera is on rails; picks start once it lands.
      if (this.intro < 1) return;
      const id = this.pick();
      // Touch has no hover: a tap on a beam holds its readout for a moment instead of deselecting.
      const flow = !id && e.pointerType !== 'mouse' ? this.pickFlow() : null;
      if (flow) {
        this.setHoverFlow(flow);
        this.flowTip(flow, e.clientX, e.clientY);
        clearTimeout(this.tipTimer);
        this.tipTimer = window.setTimeout(() => { this.tipTimer = 0; hideTooltip(); this.setHoverFlow(null); }, 3200);
        return;
      }
      this.select(id);
    };
    // A held tap readout outlives the finger lifting (touch pointers "leave" on release).
    const leave = () => { this.pointer.set(9, 9); this.hovered = null; if (!this.tipTimer) { hideTooltip(); this.setHoverFlow(null); } };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') this.select(null); };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerdown', pdown);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointerleave', leave);
    window.addEventListener('keydown', key);
    this.unsub.push(() => {
      canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerdown', pdown);
      canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointerleave', leave);
      window.removeEventListener('keydown', key);
      clearTimeout(this.tipTimer); this.tipTimer = 0;
    });
  }

  private pick(): string | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = [...this.nodes.values()].map((n) => n.mesh!).filter(Boolean);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return (hit?.object.userData.node as string) || null;
  }

  /** The energy beam under the pointer, if no node is. */
  private pickFlow(): Flow | null {
    const hit = this.raycaster.intersectObjects(this.flows.map((f) => f.mesh!).filter(Boolean), false)[0];
    return (hit?.object.userData.flow as Flow) || null;
  }

  private hoveredFlow: Flow | null = null;
  private tipTimer = 0;
  /** The hovered beam glows; the last one returns to its resting glow. */
  private setHoverFlow(flow: Flow | null) {
    if (flow === this.hoveredFlow) return;
    const rest = (f: Flow) => (f.kind === 'infusion' ? 0.6 : 1);
    if (this.hoveredFlow?.mesh && !this.pulses.has(this.hoveredFlow.id)) (this.hoveredFlow.mesh.material as THREE.ShaderMaterial).uniforms.uGlow.value = rest(this.hoveredFlow);
    if (flow?.mesh) (flow.mesh.material as THREE.ShaderMaterial).uniforms.uGlow.value = rest(flow) * 2.2;
    this.hoveredFlow = flow;
  }
  private flowTip(flow: Flow, x: number, y: number) {
    showTooltip(x, y, h('div', null,
      h('div', { class: 't-label dw-tt ' + (flow.kind === 'infusion' ? 'c-secondary' : 'c-neutral') }, ico(flow.kind === 'infusion' ? 'fuel' : 'charge', 14), flow.label),
      h('div', { class: 't-tiny c-hint' }, flow.detail())), flow.kind === 'infusion' ? 'player' : 'neutral');
  }
  private updateHover() {
    const id = this.pick();
    const flow = id ? null : this.pickFlow();
    this.setHoverFlow(flow);
    if (id !== this.hovered) {
      this.hovered = id;
      if (id) audio.play('hover');
    }
    this.engine.canvas.style.cursor = id ? 'pointer' : flow ? 'help' : 'default';
    if (!id && flow) { this.flowTip(flow, this.pointerPx.x, this.pointerPx.y); return; }
    if (!id) { hideTooltip(); return; }
    const n = this.nodes.get(id)!;
    // The readout: the node's picture and id, then its numbers behind their pictures (a reactor also names its guild).
    const r = n.kind === 'reactor' ? this.data?.reactors.find((x) => x.id === id) : undefined;
    showTooltip(this.pointerPx.x, this.pointerPx.y, h('div', null,
      h('div', { class: 't-label dw-tt ' + (n.kind === 'reactor' ? 'c-neutral' : 'c-player') }, ico(n.kind === 'reactor' ? 'star' : n.kind === 'player' ? 'team' : 'station', 14), n.kind === 'player' ? 'You' : id),
      n.kind === 'reactor'
        ? h('div', { class: 'dw-tt-row' }, ico('fuel', 13, 'dw-fuel'), formatAlpha(n.grid.fuel), ico('charge', 13, 'c-neutral'), formatPower(n.grid.capacity), r ? h('span', { class: 'c-hint' }, store.guildName(r.guildId)) : null)
        : h('div', { class: 'dw-tt-row' }, ico('charge', 13, 'c-neutral'), formatPower(n.grid.capacity), ico('team', 13, 'c-player'), formatInt(Number(n.grid.connectionCount || 0)))), n.kind === 'reactor' ? 'neutral' : 'player');
  }

  /* ── Frame ────────────────────────────────────────────────────────────── */
  update(dt: number, t: number) {
    tickSpace(this.sky, t);
    this.U.uTime.value = t;
    this.U.uCalm.value = this.engine.reduceMotion ? 1 : 0;
    // Depth fade follows the orbit: what lies beyond the focus sinks into the dark.
    const focus = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(focus * 0.9, 70), far = near + Math.max(focus * 1.6, 150);
    this.U.uFogNear.value = near; this.U.uFogFar.value = far;
    this.fog.near = near; this.fog.far = far * 1.4;
    // Shockwaves expand and fade; pulsed beams glow brighter for a moment.
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const o = this.flares[i];
      o.userData.flare += dt;
      const k = o.userData.flare / 1.6;
      (o.material as THREE.ShaderMaterial).uniforms.uK.value = Math.min(1, k);
      if (k >= 1) { this.group.remove(o); o.geometry.dispose(); this.release(o.material as THREE.Material); this.flares.splice(i, 1); }
    }
    for (const f of this.flows) {
      const p = this.pulses.get(f.id);
      if (p == null) continue;
      const mat = f.mesh!.material as THREE.ShaderMaterial;
      // A hovered (or tap-held) beam settles back to its hover glow, not its resting one.
      const base = (f.kind === 'infusion' ? 0.6 : 1) * (f === this.hoveredFlow ? 2.2 : 1);
      mat.uniforms.uGlow.value = base * (1 + p * 1.5);
      const np = p - dt * 0.8;
      if (np <= 0) { this.pulses.delete(f.id); mat.uniforms.uGlow.value = base; } else this.pulses.set(f.id, np);
    }
    // A selection pulls its own conduits forward and lets the rest recede.
    const sel = this.selected ? this.nodes.get(this.selected) : undefined;
    const hov = !sel && this.hovered ? this.nodes.get(this.hovered) : undefined;
    for (const f of this.flows) {
      const u = (f.mesh!.material as THREE.ShaderMaterial).uniforms.uFocus;
      const target = sel ? (f.a === sel.pos || f.b === sel.pos ? 1.8 : 0.28) : hov && (f.a === hov.pos || f.b === hov.pos) ? 1.5 : 1;
      u.value = damp(u.value, target, 6, dt);
    }
    // Fuel particles take their infusion's glow; uploaded only when one changes.
    if (this.fuel) {
      const { flows, ranges, last, geo } = this.fuel;
      const attr = geo.getAttribute('aGlow') as THREE.BufferAttribute, arr = attr.array as Float32Array;
      let dirty = false;
      for (let k = 0; k < flows.length; k++) {
        const m = (flows[k].mesh!.material as THREE.ShaderMaterial).uniforms;
        const v = (m.uGlow.value / 0.6) * m.uFocus.value;
        if (Math.abs(v - last[k]) > 0.01) { last[k] = v; arr.fill(v, ranges[k * 2], ranges[k * 2] + ranges[k * 2 + 1]); dirty = true; }
      }
      if (dirty) attr.needsUpdate = true;
    }
    // Stars boil and flare; stations spin their cores; both brighten under the pointer or a live pulse.
    for (const [id, a] of this.art) {
      const want = (id === this.selected ? 1 : id === this.hovered ? 0.6 : 0) + (this.pulses.get(id) || 0);
      a.boost = damp(a.boost, want, 8, dt);
      a.u.uBoost.value = a.boost;
      if (a.kind === 'reactor') {
        a.spin!.rotation.y += dt * 0.22;
        const f = a.flare!;
        if (a.dormant) continue;
        // Unprompted flares only with motion allowed; a live transaction still sets one off.
        if (f.t < 0 && !this.engine.reduceMotion) { f.next -= dt; if (f.next <= 0) { f.t = 0; f.next = 8 + Math.random() * 14; } }
        if (f.t >= 0) {
          if (f.t === 0) a.u.uFlareAng.value = Math.random() * Math.PI * 2;
          f.t += dt;
          a.u.uFlare.value = f.t < 0.9 ? Math.sin((f.t / 0.9) * Math.PI * 0.5) : Math.exp(-(f.t - 0.9) * 0.9);
          if (f.t > 6) { f.t = -1; a.u.uFlare.value = 0; }
        }
      } else {
        a.crystal!.rotation.y += dt * 0.9;
        a.crystal!.position.y = a.baseY! + Math.sin(t * 1.4 + a.seed) * a.size * 0.05;
        for (const m of a.deck!) m.emissiveIntensity = a.glow! * (1 + a.boost * 0.9);
      }
    }
    // Node pulses decay once their art has read them.
    for (const [id, p] of this.pulses) if (!this.flowIds.has(id)) { const np = p - dt; if (np <= 0) this.pulses.delete(id); else this.pulses.set(id, np); }
    this.placeReticle(0, this.selected, dt);
    this.placeReticle(1, this.hovered !== this.selected ? this.hovered : null, dt);
    if (this.intro < 1) {
      // Descend onto the grid.
      this.intro = Math.min(1, this.intro + dt / 2.4);
      const k = easeInOutCubic(this.intro);
      this.camera.position.set(Math.sin(k * 0.6) * 14, 150 - 88 * k, 230 - 118 * k).multiplyScalar(k > 0.5 ? 1 + (this.reach() - 1) * (k - 0.5) * 2 : 1);
    } else if (this.fly) {
      this.fly.t = Math.min(1, this.fly.t + dt / 1.2);
      const k = easeInOutCubic(this.fly.t);
      this.controls.target.lerpVectors(this.fly.from, this.fly.to, k);
      this.camera.position.lerpVectors(this.fly.camFrom, this.fly.camTo, k);
      if (this.fly.t >= 1) this.fly = null;
    } else {
      this.idle += dt;
      if (this.idle > 6 && !this.selected) {
        const off = this.camera.position.clone().sub(this.controls.target);
        off.applyAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.04 * Math.min(1, (this.idle - 6) / 3));
        this.camera.position.copy(this.controls.target).add(off);
      }
    }
    this.controls.update();
    if (this.pointer.x < 2 && this.intro >= 1) this.updateHover();
    this.layoutLabels();
  }

  /** HUD reticles: the selection (0) gets the full lock-on, a hovered node (1) just its brackets. */
  private placeReticle(i: number, id: string | null, dt: number) {
    const r = this.reticles[i];
    const n = id ? this.nodes.get(id) : undefined;
    if (!n || n.kind === 'player') { r.id = null; r.mesh.visible = false; return; }
    if (r.id !== n.id) { r.id = n.id; r.appear = 0; }
    r.appear = Math.min(1, r.appear + dt * 2.6);
    r.mesh.visible = true;
    r.mesh.position.copy(n.pos);
    r.mat.uniforms.uAppear.value = r.appear;
    r.mat.uniforms.uSize.value = (n.size || 2) * (n.kind === 'reactor' ? 2.6 : 2.3) + 1.2;
    (r.mat.uniforms.uColor.value as THREE.Color).setHex(n.color).lerp(WHITE, 0.35).multiplyScalar(i === 0 ? 1.5 : 1);
  }
}
