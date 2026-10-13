/* Hull models for the boards and the codex: a struct's hull (recipes.ts) framed, sized and lit for
 * the battle view, with the effects the boards drive (faction rim, hit flash, stealth, the
 * construction hologram, light bounced up from the battleground).
 *
 * The boards were laid out round the old pixel art, so a board hull is tipped into the same
 * three-quarter view the portraits use and sized to its struct's old footprint (recipes.ts
 * FOOTPRINT): pads, pick boxes, muzzle points and spacing all still fit. The codex takes the hull
 * upright instead, and turns it on its pedestal. */
import * as THREE from 'three';
import { hullGeometry, FOOTPRINT } from './recipes';
import { hullAtlas, swatchColors, swatchAt, type Faction, type Variant } from './kit';
import { VIEW_TURN, VIEW_UP } from './portrait';

export type { Faction, Variant };

/** World units per old art pixel: the boards' unit of size. */
export const PX = 1 / 16;
/** A solid hull fills less of its box than a sprite filled its footprint: board hulls draw this
 * much bigger, while keeping the footprint's size for pads, picking and muzzles. */
const BOARD_GROW = 1.25;


export interface HullModel {
  /** Framed, centred and sized; shared, never dispose it. */
  geometry: THREE.BufferGeometry;
  map: THREE.Texture;
  emissiveMap: THREE.Texture;
  faction: Faction;
  /** The hull as seen from the front, one point per art pixel on its nearest surface (model space,
   * sRGB colours): what the shatter breaks into and the damaged codex hull smokes from. */
  pixels: { x: number; y: number; z: number; r: number; g: number; b: number }[];
  /** The size as drawn (model units). */
  width: number;
  height: number;
  depth: number;
  /** The old footprint's width: the boards size the pad under a hull by it (pads keep their spacing). */
  padWidth: number;
}

export type Frame = 'board' | 'upright';

const frames = new Map<string, { geometry: THREE.BufferGeometry; width: number; height: number; depth: number; padWidth: number }>();
function framed(typeId: number, frame: Frame) {
  const key = typeId + frame;
  let f = frames.get(key);
  if (!f) {
    const board = frame === 'board';
    const g = (hullGeometry(typeId, !board) ?? hullGeometry(1, !board)!).clone();
    if (board) { g.rotateY(-VIEW_TURN); g.rotateX(VIEW_UP); }
    g.computeBoundingBox();
    const bb = g.boundingBox!, c = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3());
    g.translate(-c.x, -c.y, -c.z);
    // Fill the old footprint (upright: the same size, so the codex shows hulls at the boards' scale).
    const [fw, fh] = FOOTPRINT[typeId] ?? [64, 64];
    const s = Math.min(fw * PX / size.x, fh * PX / size.y);
    const grow = board ? BOARD_GROW : 1, k = s * grow;
    g.scale(k, k, k);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    // Two groups over the whole hull: a see-through hull draws a depth-only pass first, then its
    // colour, so only its nearest surface shows (battle/view.ts).
    const n = g.getAttribute('position').count;
    g.addGroup(0, n, 0);
    g.addGroup(0, n, 1);
    f = { geometry: g, width: size.x * k, height: size.y * k, depth: size.z * k, padWidth: fw * PX };
    frames.set(key, f);
  }
  return f;
}

/** The front view rasterised on a grid of art pixels: each cell keeps the nearest face's colour. */
function rasterPixels(geo: THREE.BufferGeometry, faction: Faction, variant: Variant): HullModel['pixels'] {
  const pos = geo.getAttribute('position'), col = geo.getAttribute('color'), uv = geo.getAttribute('uv'), nor = geo.getAttribute('normal');
  const sw = swatchColors(faction, variant).color.map((h) => new THREE.Color(h));
  const cells = new Map<string, { z: number; c: THREE.Color; x: number; y: number }>();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    if (nor.getZ(i) < 0.05) continue;                      // only what faces the viewer
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    const n = Math.min(60, Math.max(1, Math.round(area / (PX * PX))));
    const tint = sw[swatchAt(uv.getX(i))];
    const colour = new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)).multiply(tint);
    for (let k = 0; k < n; k++) {
      // Spread samples over the triangle (a fixed low-discrepancy pattern, so every build matches).
      let u = ((k * 0.618034) % 1), v = ((k * 0.754878 + 0.31) % 1);
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      p.copy(a).addScaledVector(b.clone().sub(a), u).addScaledVector(c.clone().sub(a), v);
      const key = Math.floor(p.x / PX) + ',' + Math.floor(p.y / PX);
      const prev = cells.get(key);
      if (!prev || p.z > prev.z) cells.set(key, { z: p.z, c: colour, x: (Math.floor(p.x / PX) + 0.5) * PX, y: (Math.floor(p.y / PX) + 0.5) * PX });
    }
  }
  const out: HullModel['pixels'] = [];
  const s = new THREE.Color();
  for (const { c: lin, x, y, z } of cells.values()) {
    s.copy(lin).convertLinearToSRGB();
    out.push({ x, y, z, r: Math.round(s.r * 255), g: Math.round(s.g * 255), b: Math.round(s.b * 255) });
  }
  return out;
}

const models = new Map<string, HullModel>();
/** A struct's hull model for a faction (board frame unless asked). Built once and shared. */
export function getHullModel(typeId: number, faction: Faction, variant: Variant = 'base', frame: Frame = 'board'): HullModel {
  const key = `${typeId}:${faction}:${variant}:${frame}`;
  let m = models.get(key);
  if (!m) {
    const f = framed(typeId, frame), atlas = hullAtlas(faction, variant);
    m = { geometry: f.geometry, map: atlas.map, emissiveMap: atlas.glow, faction, pixels: rasterPixels(f.geometry, faction, variant), width: f.width, height: f.height, depth: f.depth, padWidth: f.padWidth };
    models.set(key, m);
  }
  return m;
}

/* ── Material ──────────────────────────────────────────────────────────── */

/** Per-material knobs the battle view drives (all live uniforms). */
export interface HullUniforms {
  uTime: { value: number };
  /** Faction rim colour (linear, HDR) and its strength. */
  uRim: { value: THREE.Color };
  uRimStrength: { value: number };
  /** Light bounced up from the battleground below (linear). */
  uBounce: { value: THREE.Color };
  /** Hit flash 0..1: white-hot hull, blazing rim. */
  uFlash: { value: number };
  /** Stealth 0..1: the hull dissolves to a shimmering outline. */
  uCloak: { value: number };
  /** Under construction 0..1: a scanning hologram. */
  uHolo: { value: number };
  /** How bright the paint is: toned down (0.8) for the boards, whose lights were set for the old,
   * darker art; a screen with a low bloom threshold takes it lower still. */
  uShade: { value: number };
}

/** Rim light per faction, linear HDR: hot enough to bloom along the edges. */
const FACTION_RIM: Record<Faction, [number, number, number]> = {
  player: [0.16, 1.05, 0.82],
  enemy: [1.25, 0.26, 0.15],
  neutral: [1.1, 0.6, 0.12],
};

const SHARED_TIME = { value: 0 };
const tick = () => { SHARED_TIME.value = (performance.now() / 1000) % 3600; };

const VERT_PARS = /* glsl */ `varying vec3 vObjPos; varying vec3 vWPos;`;
const VERT_MAIN = /* glsl */ `vObjPos = position; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`;
const FRAG_PARS = /* glsl */ `
  uniform float uTime, uFlash, uCloak, uHolo, uRimStrength, uShade;
  uniform vec3 uRim, uBounce;
  varying vec3 vObjPos; varying vec3 vWPos;
  float hxHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  /* A stand-in sky for the hull to mirror: cool zenith, plum-and-amber horizon, a warm key sun up
   * front-left and a cold rim star behind. */
  vec3 hxSky(vec3 r, float rough) {
    float y = r.y;
    vec3 zen = vec3(0.07, 0.11, 0.24), hor = vec3(0.34, 0.22, 0.30), gnd = vec3(0.06, 0.05, 0.06);
    vec3 c = y > 0.0 ? mix(hor, zen, pow(y, 0.55)) : mix(hor, gnd, pow(-y, 0.45));
    float sharp = mix(60.0, 6.0, rough);
    c += vec3(1.3, 1.05, 0.78) * pow(max(dot(r, normalize(vec3(-0.38, 0.49, 0.78))), 0.0), sharp);
    c += vec3(1.8, 1.55, 1.2) * pow(max(dot(r, normalize(vec3(-0.55, 0.45, -0.7))), 0.0), sharp * 0.8);
    c += vec3(0.45, 0.65, 1.6) * pow(max(dot(r, normalize(vec3(0.82, 0.14, -0.55))), 0.0), sharp * 0.6);
    return c;
  }
`;

/** The board material for a hull: clone-per-unit, so hit flashes and stealth fades stay local. Its
 * live uniforms are on `material.userData.hull` ({@link HullUniforms}). */
export function hullFxMaterial(m: HullModel): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: m.map,
    emissiveMap: m.emissiveMap,
    emissive: new THREE.Color(1, 1, 1),
    emissiveIntensity: 1.6,
    alphaTest: 0.5,
    roughness: 0.45,
    metalness: 0.32,
    transparent: false,
  });
  const rim = FACTION_RIM[m.faction ?? 'player'];
  const u: HullUniforms = {
    uTime: SHARED_TIME,
    uRim: { value: new THREE.Color(rim[0], rim[1], rim[2]) },
    uRimStrength: { value: 1 },
    uBounce: { value: new THREE.Color(0, 0, 0) },
    uFlash: { value: 0 },
    uCloak: { value: 0 },
    uHolo: { value: 0 },
    uShade: { value: 0.8 },
  };
  mat.userData.hull = u;
  mat.onBeforeRender = tick;
  mat.customProgramCacheKey = () => 'hull-fx-v2';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_MAIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= uShade;')
      .replace('#include <emissivemap_fragment>', /* glsl */ `
        #include <emissivemap_fragment>
        // Lamps breathe, each cluster on its own clock, and now and then one blinks.
        float hxH = hxHash(floor(vObjPos * 5.0));
        float hxFlick = 0.82 + 0.18 * sin(uTime * (0.9 + hxH * 2.6) + hxH * 40.0);
        hxFlick *= 1.0 - 0.7 * step(0.97, fract(hxH * 13.7 + uTime * (0.07 + hxH * 0.11)));
        totalEmissiveRadiance *= hxFlick * (1.0 + uFlash * 2.5);
      `)
      .replace('#include <lights_fragment_end>', /* glsl */ `
        vec3 hxNW = inverseTransformDirection(normal, viewMatrix);
        // The battleground below lights the belly: ocean blue, desert ochre, cloud white.
        irradiance += uBounce * pow(saturate(0.55 - 0.55 * hxNW.y), 1.6);
        radiance += hxSky(inverseTransformDirection(reflect(-geometryViewDir, normal), viewMatrix), material.roughness) * 0.35;
        #include <lights_fragment_end>
      `)
      .replace('#include <opaque_fragment>', /* glsl */ `
        float hxNdv = saturate(dot(normal, geometryViewDir));
        float hxFres = pow(1.0 - hxNdv, 2.6);
        // Faction rim: a backlight from behind the board, plus a little all round so a hull still
        // reads as ours or theirs from any side.
        float hxBack = saturate(dot(hxNW, vec3(-0.5, 0.62, -0.6)) + 0.25);
        outgoingLight += uRim * hxFres * (0.28 + 0.9 * hxBack) * uRimStrength * 0.6;
        if (uFlash > 0.001) outgoingLight += (vec3(2.6, 2.3, 2.0) * (0.25 + 0.5 * diffuseColor.rgb) + uRim * hxFres * 3.0) * uFlash;
        if (uHolo > 0.001) {
          float hxLines = 0.55 + 0.45 * step(0.4, fract(vWPos.y * 11.0 - uTime * 1.6));
          float hxSweep = smoothstep(0.92, 1.0, fract(vWPos.y * 0.45 - uTime * 0.5));
          float hxL = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          vec3 hxCol = mix(vec3(0.3, 1.0, 0.95), uRim, 0.25);
          vec3 hxHolo = hxCol * ((0.18 + hxL * 0.9) * hxLines + hxFres * 1.6 + hxSweep * 1.2) + totalEmissiveRadiance * 0.4;
          outgoingLight = mix(outgoingLight, hxHolo, uHolo);
          diffuseColor.a *= mix(1.0, (0.45 + 0.35 * hxLines + hxFres * 0.4 + hxSweep * 0.3), uHolo);
        }
        if (uCloak > 0.001) {
          float hxScan = 0.5 + 0.5 * sin(vWPos.y * 26.0 - uTime * 5.0 + vWPos.x * 2.0);
          vec3 hxGhost = outgoingLight * 0.22 + mix(uRim, vec3(0.58, 0.64, 0.9), 0.4) * (0.08 + hxFres * 1.8 + hxScan * 0.06);
          outgoingLight = mix(outgoingLight, hxGhost, uCloak);
          diffuseColor.a *= mix(1.0, 0.22 + 0.6 * hxFres + 0.18 * hxScan, uCloak);
        }
        #include <opaque_fragment>
      `);
  };
  return mat;
}
