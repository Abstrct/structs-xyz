/* Reading a droid's colours out of its PFP layers (browser only). Each layer image is drawn into one
 * small atlas; its pixels give the part a palette (main, second, dark), its bounding box becomes the
 * decal on the part's front, and its few bright, saturated pixels (eyes, visors, screens) become the
 * emissive mask, so they glow. A column of swatches holds the colours procedural parts glow in. */
import * as THREE from 'three';
import { asset } from '../../core/base';
import { layerUrl, AURA_COLOR, type DroidSpec, type PfpPart } from '../../data/droidParts';
import { defaultSkin, type DroidSkin, type Palette } from './droid';

export const ATLAS_W = 320, ATLAS_H = 72;
const SLOT: Record<'head' | 'body' | 'arms' | 'neck', number> = { head: 0, body: 72, arms: 144, neck: 216 };
const SW_X = 288;
const SWATCH_ROWS = { white: 0, aura: 8, glow: 16, core: 24, thrust: 32 } as const;
const CORE = '#FF6A13', THRUST = '#7FE3FF';

const uvAt = (x: number, y: number): [number, number] => [(x + 0.5) / ATLAS_W, 1 - (y + 0.5) / ATLAS_H];
const swatchUV = (row: number): [number, number] => uvAt(SW_X + 16, row + 4);

const images = new Map<string, Promise<HTMLImageElement | null>>();
export function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = images.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      // A failed image isn't kept: the next droid asks again.
      img.onerror = () => { images.delete(url); resolve(null); };
      img.src = asset(url);
    });
    images.set(url, p);
  }
  return p;
}

interface Px { r: number; g: number; b: number }
const hsv = ({ r, g, b }: Px) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return { s: mx ? (mx - mn) / mx : 0, v: mx / 255 };
};
const lin = (p: Px) => new THREE.Color().setRGB(p.r / 255, p.g / 255, p.b / 255, THREE.SRGBColorSpace);
const dist = (a: Px, b: Px) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

interface Read { palette: Palette; glow: Px | null; glowy: (p: Px) => boolean; bbox: [number, number, number, number] | null; left: [number, number, number, number] | null; right: [number, number, number, number] | null }

/** One layer's pixels → palette, glow colour, and bounding boxes. */
function readLayer(d: ImageData): Read {
  const counts = new Map<number, { n: number; p: Px }>();
  const box = (): [number, number, number, number] => [99, 99, -1, -1];
  const all = box(), left = box(), right = box();
  const grow = (b: number[], x: number, y: number) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); };
  for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
    const i = (y * d.width + x) * 4;
    if (d.data[i + 3] < 160) continue;
    const p = { r: d.data[i], g: d.data[i + 1], b: d.data[i + 2] };
    const k = ((p.r >> 3) << 10) | ((p.g >> 3) << 5) | (p.b >> 3);
    const c = counts.get(k);
    if (c) c.n++; else counts.set(k, { n: 1, p });
    grow(all, x, y);
    grow(x < d.width / 2 ? left : right, x, y);
  }
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n);
  const total = ranked.reduce((s, c) => s + c.n, 0) || 1;
  const lit = ranked.filter((c) => hsv(c.p).v >= 0.2);
  const darks = ranked.filter((c) => hsv(c.p).v < 0.2);
  const main = lit[0]?.p ?? { r: 140, g: 151, b: 168 };
  const second = lit.find((c) => dist(c.p, main) > 48)?.p ?? { r: main.r * 0.8, g: main.g * 0.8, b: main.b * 0.8 };
  const dark = darks[0]?.p ?? { r: 42, g: 52, b: 70 };
  // Armour is common; light is rare. A colour near any of the layer's main shades never glows (armour
  // comes in several shades of one colour), and neither does a colour that covers much of it.
  const shades = ranked.slice(0, 3).map((c) => c.p);
  const share = (p: Px) => ranked.filter((c) => dist(c.p, p) < 36).reduce((s, c) => s + c.n, 0) / total;
  // Decided once per colour (a layer has a few dozen), not once per pixel.
  const known = new Map<number, boolean>();
  const glowy = (p: Px) => {
    const k = ((p.r >> 3) << 10) | ((p.g >> 3) << 5) | (p.b >> 3);
    let g = known.get(k);
    if (g === undefined) {
      const q = hsv(p);
      g = q.s > 0.5 && q.v > 0.68 && dist(p, main) > 70 && dist(p, second) > 70 && share(p) < 0.12 && !shades.some((c) => dist(c, p) < 60);
      known.set(k, g);
    }
    return g;
  };
  const glowC = ranked.find((c) => glowy(c.p))?.p ?? null;
  const ok = (b: number[]) => (b[2] >= b[0] ? b as [number, number, number, number] : null);
  return { palette: { main: lin(main), second: lin(second), dark: lin(dark) }, glow: glowC, glowy, bbox: ok(all), left: ok(left), right: ok(right) };
}

export interface LoadedSkin {
  skin: DroidSkin;
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
  /** The droid as a flat portrait with no sky (for the far-away sprite and the builder card). */
  bust: HTMLCanvasElement;
}

const rect = (ox: number, b: [number, number, number, number] | null): [number, number, number, number] | undefined =>
  b ? [(ox + b[0]) / ATLAS_W, 1 - (b[3] + 1) / ATLAS_H, (ox + b[2] + 1) / ATLAS_W, 1 - b[1] / ATLAS_H] : undefined;

function texture(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Read the layers and paint the atlas. Missing images fall back to the default greys. */
export async function loadSkin(spec: DroidSpec): Promise<LoadedSkin> {
  const parts: ('head' | 'body' | 'arms' | 'neck')[] = ['head', 'body', 'arms', 'neck'];
  const imgs = await Promise.all(parts.map((p) => loadImage(layerUrl(p as PfpPart, spec.attrs[p]))));
  const atlas = document.createElement('canvas');
  atlas.width = ATLAS_W; atlas.height = ATLAS_H;
  const ctx = atlas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  const glowC = document.createElement('canvas');
  glowC.width = ATLAS_W; glowC.height = ATLAS_H;
  const gctx = glowC.getContext('2d')!;
  gctx.fillStyle = '#000'; gctx.fillRect(0, 0, ATLAS_W, ATLAS_H);

  const skin = defaultSkin();
  const reads: Partial<Record<typeof parts[number], Read>> = {};
  parts.forEach((p, i) => {
    const img = imgs[i];
    if (!img) return;
    ctx.drawImage(img, SLOT[p], 0, 72, 72);
    const data = ctx.getImageData(SLOT[p], 0, 72, 72);
    const r = readLayer(data);
    reads[p] = r;
    skin[p] = r.palette;
    // Behind the art, the part's own colour: a decal face shows it where the layer is clear,
    // rather than black.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#' + r.palette.main.getHexString(THREE.SRGBColorSpace);
    ctx.fillRect(SLOT[p], 0, 72, 72);
    ctx.restore();
    // The emissive mask: only the glowing pixels of this layer.
    const out = gctx.createImageData(72, 72);
    for (let k = 0; k < data.data.length; k += 4) {
      if (data.data[k + 3] < 160) continue;
      const px = { r: data.data[k], g: data.data[k + 1], b: data.data[k + 2] };
      if (r.glowy(px)) { out.data[k] = px.r; out.data[k + 1] = px.g; out.data[k + 2] = px.b; out.data[k + 3] = 255; }
      else out.data[k + 3] = 255;
    }
    gctx.putImageData(out, SLOT[p], 0);
  });

  const aura = AURA_COLOR[spec.aura];
  const glowHex = reads.head?.glow ? `rgb(${reads.head.glow.r},${reads.head.glow.g},${reads.head.glow.b})` : aura;
  const swatch = (row: number, color: string, lit: boolean) => {
    ctx.fillStyle = color; ctx.fillRect(SW_X, row, ATLAS_W - SW_X, 8);
    gctx.fillStyle = lit ? color : '#000'; gctx.fillRect(SW_X, row, ATLAS_W - SW_X, 8);
  };
  swatch(SWATCH_ROWS.white, '#fff', false);
  swatch(SWATCH_ROWS.aura, aura, true);
  swatch(SWATCH_ROWS.glow, glowHex, true);
  swatch(SWATCH_ROWS.core, CORE, true);
  swatch(SWATCH_ROWS.thrust, THRUST, true);

  skin.white = swatchUV(SWATCH_ROWS.white);
  skin.swatch = { aura: swatchUV(SWATCH_ROWS.aura), glow: swatchUV(SWATCH_ROWS.glow), core: swatchUV(SWATCH_ROWS.core), thrust: swatchUV(SWATCH_ROWS.thrust) };
  skin.decal = {
    head: rect(SLOT.head, reads.head?.bbox ?? null),
    body: rect(SLOT.body, reads.body?.bbox ?? null),
    padL: rect(SLOT.arms, reads.arms?.right ?? null),
    padR: rect(SLOT.arms, reads.arms?.left ?? null),
  };

  // The flat bust: body, arms, neck, head, no sky.
  const bust = document.createElement('canvas');
  bust.width = 72; bust.height = 72;
  const bctx = bust.getContext('2d')!;
  bctx.imageSmoothingEnabled = false;
  for (const p of ['body', 'arms', 'neck', 'head'] as const) { const img = imgs[parts.indexOf(p)]; if (img) bctx.drawImage(img, 0, 0, 72, 72); }

  return { skin, map: texture(atlas), emissive: texture(glowC), bust };
}
