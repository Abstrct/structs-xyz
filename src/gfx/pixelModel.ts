/* Pixel extrusion: turns the game's 128×128 struct sprites into chunky 3D
 * models. The front and back are single alpha-tested quads carrying the
 * sprite; every silhouette edge gets a wall whose UVs sample that pixel's
 * centre, so the sides wear the art's own colours. One geometry, one
 * material, one draw call per struct. The pixel list it returns drives the
 * "shatter" destruction effect.
 *
 * The look is baked beside the geometry: a per-pixel bevel normal map (the
 * silhouette's outer pixels lean outward, dark panel lines sink in), an
 * occlusion term on every wall (walls inside notches and holes sit in
 * shadow) and a graded emissive mask. The material lights all of it: hulls
 * catch the key light along bevelled edges, wall lips read as chamfers, a
 * fresnel rim in the faction colour outlines the extrusion, the battleground
 * below bounces its colour up into the belly, and a procedural sky gives
 * metal its sheen. Panel lights breathe and blink. */
import * as THREE from 'three';
import { ART, artLayers } from '../data/catalogue';
import { drawFallbackArt } from './fallbackArt';

export const SPRITE = 128;
/** World units per art pixel. */
export const PX = 1 / 16;

export interface PixelModel {
  geometry: THREE.BufferGeometry;
  map: THREE.CanvasTexture;
  emissiveMap: THREE.CanvasTexture;
  /** Per-pixel bevel normals for the front and back faces (linear, object axes). */
  normalMap: THREE.CanvasTexture;
  faction: Faction;
  /** Opaque pixels in model space (for shatter), with sRGB colours. */
  pixels: { x: number; y: number; r: number; g: number; b: number }[];
  width: number;
  height: number;
  depth: number;
  canvas: HTMLCanvasElement;
}

export type Faction = 'player' | 'enemy' | 'neutral';

const imageCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = imageCache.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      // A failed load is not remembered: the next request tries the network again.
      img.onerror = () => { imageCache.delete(url); resolve(null); };
      img.src = url;
    });
    imageCache.set(url, p);
  }
  return p;
}

/** Composite the sprite layers (bottom → hull → top) on a 128² canvas. */
export async function compositeSprite(typeId: number, variant: 'base' | 'dmg' = 'base'): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  if (!ART[typeId]) {
    drawFallbackArt(ctx, typeId, variant);
    return c;
  }
  const imgs = await Promise.all(artLayers(typeId, variant).map(loadImage));
  for (const img of imgs) if (img) ctx.drawImage(img, 0, 0);
  // Missing layers mark the result as provisional, so caches built on it retry later.
  if (imgs.some((img) => !img)) c.dataset.partial = '1';
  return c;
}

/* Lights in the art are a family of SUI teals (#43cdb6 and its highlight and
 * shade). Each faction rotates the whole family to its own hue, keeping the
 * art's highlight-to-shade ramp, so identical hulls read as ours or theirs. */
const TEAL_HSV = { h: 170, s: 0.67, v: 0.8 };
const FACTION_HSV: Record<Faction, { h: number; s: number; v: number } | null> = {
  player: null,
  enemy: { h: 7, s: 0.66, v: 0.95 },
  neutral: { h: 37, s: 0.72, v: 0.93 },
};
/** Rim light per faction, linear HDR: hot enough to bloom along the extrusion. */
const FACTION_RIM: Record<Faction, [number, number, number]> = {
  player: [0.16, 1.05, 0.82],
  enemy: [1.25, 0.26, 0.15],
  neutral: [1.1, 0.6, 0.12],
};

function rgbToHsv(r: number, g: number, b: number) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max / 255 };
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const modelCache = new Map<string, Promise<PixelModel>>();

export function getPixelModel(typeId: number, faction: Faction, variant: 'base' | 'dmg' = 'base', depthPx = 10): Promise<PixelModel> {
  const key = `${typeId}:${faction}:${variant}:${depthPx}`;
  let p = modelCache.get(key);
  if (!p) {
    // Both variants are centred on the union of their art, so swapping to damaged art never shifts the hull.
    const other: 'base' | 'dmg' = variant === 'base' ? 'dmg' : 'base';
    const entry: Promise<PixelModel> = Promise.all([compositeSprite(typeId, variant), compositeSprite(typeId, other)]).then(([canvas, alt]) => {
      if ((canvas.dataset.partial || alt.dataset.partial) && modelCache.get(key) === entry) modelCache.delete(key);
      return buildPixelModel(canvas, faction, depthPx, opaqueBox(alt));
    });
    p = entry;
    modelCache.set(key, p);
  }
  return p;
}

/** The opaque pixels' bounding box [x0, y0, x1, y1] (inclusive), or null for an empty sprite. */
function opaqueBox(c: HTMLCanvasElement): [number, number, number, number] | null {
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, SPRITE, SPRITE).data;
  let x0 = SPRITE, y0 = SPRITE, x1 = -1, y1 = -1;
  for (let i = 0; i < SPRITE * SPRITE; i++) {
    if (d[i * 4 + 3] < 128) continue;
    const x = i % SPRITE, y = (i / SPRITE) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}

/** How brightly a pixel of the (recoloured) art glows, 0..1. */
function glowOf(r: number, g: number, b: number, light: boolean): number {
  const { h, s, v } = rgbToHsv(r, g, b);
  if (light) return v > 0.55 ? 1 : v > 0.38 ? 0.3 : 0;
  if (s > 0.7 && v > 0.65 && (h < 10 || h > 345)) return 1;          // red warning lamps
  if (s > 0.45 && v > 0.55 && h > 265 && h < 330) return 0.9;        // violet energy cores
  if (s > 0.45 && v > 0.75 && h > 150 && h < 235) return 0.55;       // cyan screens, blue wake
  return 0;
}

/** `frame` widens the bounding box the model is centred on (so base and damaged art line up). */
export function buildPixelModel(src: HTMLCanvasElement, faction: Faction, depthPx = 10, frame?: [number, number, number, number] | null): PixelModel {
  const ctx = src.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, SPRITE, SPRITE);
  const d = img.data;

  // Recolour lights and build the emissive mask.
  const em = document.createElement('canvas');
  em.width = em.height = SPRITE;
  const ectx = em.getContext('2d')!;
  const eimg = ectx.createImageData(SPRITE, SPRITE);
  const target = FACTION_HSV[faction];
  let x0 = SPRITE, y0 = SPRITE, x1 = 0, y1 = 0;
  for (let i = 0; i < SPRITE * SPRITE; i++) {
    const a = d[i * 4 + 3];
    if (a < 128) { d[i * 4 + 3] = 0; continue; }
    d[i * 4 + 3] = 255;
    const x = i % SPRITE, y = (i / SPRITE) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    const hsv = rgbToHsv(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    const isLight = hsv.h > 150 && hsv.h < 194 && hsv.s > 0.38 && hsv.v > 0.3;
    if (isLight && target) {
      const [r, g, b] = hsvToRgb(target.h + (hsv.h - TEAL_HSV.h) * 0.6, Math.min(1, hsv.s * target.s / TEAL_HSV.s), Math.min(1, hsv.v * target.v / TEAL_HSV.v));
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b;
    }
    const glow = glowOf(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], isLight);
    eimg.data[i * 4] = d[i * 4] * glow; eimg.data[i * 4 + 1] = d[i * 4 + 1] * glow; eimg.data[i * 4 + 2] = d[i * 4 + 2] * glow;
    eimg.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ectx.putImageData(eimg, 0, 0);
  if (frame) { x0 = Math.min(x0, frame[0]); y0 = Math.min(y0, frame[1]); x1 = Math.max(x1, frame[2]); y1 = Math.max(y1, frame[3]); }
  if (x1 < x0) { x0 = y0 = 60; x1 = y1 = 67; }
  x1 += 1; y1 += 1;

  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < SPRITE && y < SPRITE && d[(y * SPRITE + x) * 4 + 3] > 0;

  /* Bevel: height rises over the outer three pixels of the silhouette, and
   * the art's dark panel lines sink a little; normals are its slopes. */
  const dist = new Uint8Array(SPRITE * SPRITE);
  for (let i = 0; i < SPRITE * SPRITE; i++) dist[i] = d[i * 4 + 3] ? 255 : 0;
  for (let pass = 1; pass <= 3; pass++) {
    for (let y = 0; y < SPRITE; y++) for (let x = 0; x < SPRITE; x++) {
      const i = y * SPRITE + x;
      if (dist[i] !== 255) continue;
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        const nd = nx < 0 || ny < 0 || nx >= SPRITE || ny >= SPRITE ? 0 : dist[ny * SPRITE + nx];
        if (nd === pass - 1) { edge = true; break; }
      }
      if (edge) dist[i] = pass;
    }
  }
  const height = new Float32Array(SPRITE * SPRITE);
  for (let i = 0; i < SPRITE * SPRITE; i++) {
    if (!dist[i]) continue;
    const lum = (0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2]) / 255;
    height[i] = Math.min(dist[i], 4) / 4 + Math.min(lum, 0.5) * 0.45;
  }
  const H = (x: number, y: number) => (x < 0 || y < 0 || x >= SPRITE || y >= SPRITE ? 0 : height[y * SPRITE + x]);
  const nm = document.createElement('canvas');
  nm.width = nm.height = SPRITE;
  const nctx = nm.getContext('2d')!;
  const nimg = nctx.createImageData(SPRITE, SPRITE);
  const K = 1.35;
  for (let y = 0; y < SPRITE; y++) for (let x = 0; x < SPRITE; x++) {
    const i = y * SPRITE + x;
    let nx = 0, ny = 0, nz = 1;
    if (dist[i]) {
      nx = (H(x - 1, y) - H(x + 1, y)) * 0.5 * K;
      ny = (H(x, y + 1) - H(x, y - 1)) * 0.5 * K;
      const l = Math.hypot(nx, ny, 1);
      nx /= l; ny /= l; nz = 1 / l;
    }
    nimg.data[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
    nimg.data[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    nimg.data[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    nimg.data[i * 4 + 3] = 255;
  }
  nctx.putImageData(nimg, 0, 0);

  const w = x1 - x0, hgt = y1 - y0;
  const cx = x0 + w / 2, cy = y0 + hgt / 2;
  const depth = depthPx * PX;
  const zf = depth / 2, zb = -depth / 2;
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], occ: number[] = [], idx: number[] = [];
  const X = (px: number) => (px - cx) * PX;
  const Y = (py: number) => (cy - py) * PX;
  const U = (px: number) => px / SPRITE;
  const V = (py: number) => 1 - py / SPRITE;

  const quad = (p: number[][], n: number[], uvs: number[][], o = 0) => {
    const base = pos.length / 3;
    for (let k = 0; k < 4; k++) { pos.push(...p[k]); nor.push(...n); uv.push(...uvs[k]); occ.push(o); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  /* A wall's occlusion: how boxed-in the empty pixel it faces is (a straight
   * outer edge has 3 opaque neighbours there; a notch or hole has more). */
  const occlusion = (ex: number, ey: number) => {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && opaque(ex + dx, ey + dy)) n++;
    return Math.min(0.62, Math.max(0, (n - 3) * 0.13));
  };

  // Front (+z) and back (−z).
  quad([[X(x0), Y(y1), zf], [X(x1), Y(y1), zf], [X(x1), Y(y0), zf], [X(x0), Y(y0), zf]], [0, 0, 1],
    [[U(x0), V(y1)], [U(x1), V(y1)], [U(x1), V(y0)], [U(x0), V(y0)]]);
  quad([[X(x1), Y(y1), zb], [X(x0), Y(y1), zb], [X(x0), Y(y0), zb], [X(x1), Y(y0), zb]], [0, 0, -1],
    [[U(x1), V(y1)], [U(x0), V(y1)], [U(x0), V(y0)], [U(x1), V(y0)]]);

  const pixels: PixelModel['pixels'] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!opaque(x, y)) continue;
      const i = (y * SPRITE + x) * 4;
      pixels.push({ x: X(x + 0.5), y: Y(y + 0.5), r: d[i], g: d[i + 1], b: d[i + 2] });
      const c = [U(x + 0.5), V(y + 0.5)];
      const cc = [c, c, c, c];
      if (!opaque(x - 1, y)) quad([[X(x), Y(y + 1), zb], [X(x), Y(y + 1), zf], [X(x), Y(y), zf], [X(x), Y(y), zb]], [-1, 0, 0], cc, occlusion(x - 1, y));
      if (!opaque(x + 1, y)) quad([[X(x + 1), Y(y + 1), zf], [X(x + 1), Y(y + 1), zb], [X(x + 1), Y(y), zb], [X(x + 1), Y(y), zf]], [1, 0, 0], cc, occlusion(x + 1, y));
      if (!opaque(x, y - 1)) quad([[X(x), Y(y), zf], [X(x + 1), Y(y), zf], [X(x + 1), Y(y), zb], [X(x), Y(y), zb]], [0, 1, 0], cc, occlusion(x, y - 1));
      if (!opaque(x, y + 1)) quad([[X(x), Y(y + 1), zb], [X(x + 1), Y(y + 1), zb], [X(x + 1), Y(y + 1), zf], [X(x), Y(y + 1), zf]], [0, -1, 0], cc, occlusion(x, y + 1));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('occl', new THREE.Float32BufferAttribute(occ, 1));
  geometry.setIndex(idx);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const map = new THREE.CanvasTexture(src);
  const emissiveMap = new THREE.CanvasTexture(em);
  const normalMap = new THREE.CanvasTexture(nm);
  for (const t of [map, emissiveMap, normalMap]) {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.colorSpace = t === normalMap ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  }
  return { geometry, map, emissiveMap, normalMap, faction, pixels, width: w * PX, height: hgt * PX, depth, canvas: src };
}

/* ── Material ──────────────────────────────────────────────────────────── */

/** Per-material knobs the battle view drives (all live uniforms). */
export interface PixelUniforms {
  uTime: { value: number };
  uBevelMap: { value: THREE.Texture };
  uHalfDepth: { value: number };
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
}

const SHARED_TIME = { value: 0 };
const tick = () => { SHARED_TIME.value = (performance.now() / 1000) % 3600; };

const VERT_PARS = /* glsl */ `
  attribute float occl;
  varying vec3 vObjPos; varying vec3 vObjN; varying float vAo;
  varying vec3 vAxX; varying vec3 vAxY; varying vec3 vAxZ; varying vec3 vWPos;
`;
const VERT_MAIN = /* glsl */ `
  vObjPos = position; vObjN = normal; vAo = 1.0 - occl;
  vAxX = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));
  vAxY = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
  vAxZ = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;
const FRAG_PARS = /* glsl */ `
  uniform sampler2D uBevelMap;
  uniform float uHalfDepth, uTime, uFlash, uCloak, uHolo, uRimStrength;
  uniform vec3 uRim, uBounce;
  varying vec3 vObjPos; varying vec3 vObjN; varying float vAo;
  varying vec3 vAxX; varying vec3 vAxY; varying vec3 vAxZ; varying vec3 vWPos;
  float pxHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  /* A stand-in sky for metal to mirror: cool zenith, plum-and-amber horizon,
   * a warm key sun up front-left and a cold rim star behind. */
  vec3 pxSky(vec3 r, float rough) {
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

/** The standard material for a pixel model. Cloned per instance so hit
 * flashes and stealth fades stay local. Its live uniforms are on
 * `material.userData.pixel` ({@link PixelUniforms}). */
export function pixelMaterial(m: PixelModel): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: m.map,
    emissiveMap: m.emissiveMap,
    emissive: new THREE.Color(1, 1, 1),
    emissiveIntensity: 1.6,
    alphaTest: 0.5,
    roughness: 0.52,
    metalness: 0.38,
    transparent: false,
  });
  const rim = FACTION_RIM[m.faction ?? 'player'];
  const u: PixelUniforms = {
    uTime: SHARED_TIME,
    uBevelMap: { value: m.normalMap },
    uHalfDepth: { value: m.depth / 2 },
    uRim: { value: new THREE.Color(rim[0], rim[1], rim[2]) },
    uRimStrength: { value: 1 },
    uBounce: { value: new THREE.Color(0, 0, 0) },
    uFlash: { value: 0 },
    uCloak: { value: 0 },
    uHolo: { value: 0 },
  };
  mat.userData.pixel = u;
  mat.onBeforeRender = tick;
  mat.customProgramCacheKey = () => 'pixel-model-v2';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_MAIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <map_fragment>', /* glsl */ `
        #include <map_fragment>
        float pxWall = 1.0 - step(0.5, abs(vObjN.z));
        float pxTz = clamp(vObjPos.z / uHalfDepth, -1.0, 1.0);
        // Walls darken toward the back and inside notches: the extrusion reads as depth.
        diffuseColor.rgb *= mix(1.0, (0.5 + 0.5 * smoothstep(-0.6, 1.0, pxTz)) * vAo, pxWall);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        #include <normal_fragment_maps>
        if (pxWall < 0.5) {
          vec3 pxB = texture2D(uBevelMap, vMapUv).xyz * 2.0 - 1.0;
          normal = normalize(pxB.x * vAxX + pxB.y * vAxY + pxB.z * sign(vObjN.z) * vAxZ);
        } else {
          // Chamfered lips: the last stretch of each wall turns toward the face it meets.
          float pxLip = smoothstep(0.45, 1.0, abs(pxTz));
          normal = normalize(normal + vAxZ * sign(pxTz) * pxLip * 1.1);
        }
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */ `
        #include <emissivemap_fragment>
        // Panel lights breathe, each cluster on its own clock, and now and then one blinks.
        float pxH = pxHash(floor(vMapUv * 40.0));
        float pxFlick = 0.8 + 0.2 * sin(uTime * (0.9 + pxH * 2.6) + pxH * 40.0);
        pxFlick *= 1.0 - 0.7 * step(0.965, fract(pxH * 13.7 + uTime * (0.07 + pxH * 0.11)));
        totalEmissiveRadiance *= pxFlick * (1.0 + uFlash * 2.5) * mix(1.0, 0.5, pxWall);
      `)
      .replace('#include <lights_fragment_end>', /* glsl */ `
        vec3 pxNW = inverseTransformDirection(normal, viewMatrix);
        // The battleground below lights the belly: ocean blue, desert ochre, cloud white.
        irradiance += uBounce * pow(saturate(0.55 - 0.55 * pxNW.y), 1.6);
        radiance += pxSky(inverseTransformDirection(reflect(-geometryViewDir, normal), viewMatrix), material.roughness);
        #include <lights_fragment_end>
      `)
      .replace('#include <opaque_fragment>', /* glsl */ `
        float pxNdv = saturate(dot(normal, geometryViewDir));
        float pxFres = pow(1.0 - pxNdv, 2.6);
        // Faction rim: a backlight from the sun behind the board (edges facing up, left and away
        // catch it), plus a little all round so a hull still reads as ours or theirs from any side.
        float pxBack = saturate(dot(pxNW, vec3(-0.5, 0.62, -0.6)) + 0.25);
        float pxRimMask = pxFres * (0.28 + 0.9 * pxBack) * mix(0.6, 1.0, pxWall);
        outgoingLight += uRim * pxRimMask * uRimStrength * 0.75;
        if (uFlash > 0.001) outgoingLight += (vec3(2.6, 2.3, 2.0) * (0.25 + 0.5 * diffuseColor.rgb) + uRim * pxFres * 3.0) * uFlash;
        if (uHolo > 0.001) {
          float pxLines = 0.55 + 0.45 * step(0.4, fract(vWPos.y * 11.0 - uTime * 1.6));
          float pxSweep = smoothstep(0.92, 1.0, fract(vWPos.y * 0.45 - uTime * 0.5));
          float pxL = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          vec3 pxCol = mix(vec3(0.3, 1.0, 0.95), uRim, 0.25);
          vec3 pxHolo = pxCol * ((0.18 + pxL * 0.9) * pxLines + pxFres * 1.6 + pxSweep * 1.2) + totalEmissiveRadiance * 0.4;
          outgoingLight = mix(outgoingLight, pxHolo, uHolo);
          diffuseColor.a *= mix(1.0, (0.45 + 0.35 * pxLines + pxFres * 0.4 + pxSweep * 0.3), uHolo);
        }
        if (uCloak > 0.001) {
          float pxScan = 0.5 + 0.5 * sin(vWPos.y * 26.0 - uTime * 5.0 + vWPos.x * 2.0);
          vec3 pxGhost = outgoingLight * 0.22 + mix(uRim, vec3(0.58, 0.64, 0.9), 0.4) * (0.08 + pxFres * 1.8 + pxScan * 0.06);
          outgoingLight = mix(outgoingLight, pxGhost, uCloak);
          diffuseColor.a *= mix(1.0, 0.22 + 0.6 * pxFres + 0.18 * pxScan, uCloak);
        }
        #include <opaque_fragment>
      `);
  };
  return mat;
}

/** A data URL of the composite sprite, for UI portraits. */
const spriteUrlCache = new Map<string, Promise<string>>();
export function spriteDataUrl(typeId: number, variant: 'base' | 'dmg' = 'base'): Promise<string> {
  const key = typeId + variant;
  let p = spriteUrlCache.get(key);
  if (!p) {
    const entry: Promise<string> = compositeSprite(typeId, variant).then((c) => {
      if (c.dataset.partial && spriteUrlCache.get(key) === entry) spriteUrlCache.delete(key);
      return c.toDataURL();
    });
    p = entry;
    spriteUrlCache.set(key, p);
  }
  return p;
}
