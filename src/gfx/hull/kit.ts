/* Struct hulls: each struct as a faceted low-poly model drawn in code, in the Dreamcast-era style of
 * the droids and the Concourse (the droid kit's GeoBuilder writes the triangles).
 *
 * The family look: cream-white hull panels over dark slate, a bold faction band on every unit,
 * cyan light strips, orange weapons, violet for Alpha Matter. Space ships are long lofted hulls with
 * ring engines, aircraft have big wings and canopies, land units hover, walk or roll, ships carry a
 * glowing waterline, and planet buildings stand on hex plinths.
 *
 * Colour: plain paint is the vertex colour on a white texel. Faction trim, faction glow and the
 * lamps point at swatches in one small shared atlas, so a faction is just a material: every faction
 * shares one geometry per struct. Lamps glow through the atlas's emissive twin.
 *
 * Axes: nose along +x, up +y, the near side +z. */
import * as THREE from 'three';
import { GeoBuilder, type Paint, type V3 } from '../droid/kit';

export type Faction = 'player' | 'enemy' | 'neutral';

/** The struct palette. */
export const C = {
  white: '#E8EBF0',
  pearl: '#C9D1DD',
  grey: '#98A3B5',
  slate: '#5A6578',
  deep: '#343C4C',
  black: '#1B2029',
  orange: '#F08A2C',
  gold: '#E8B84A',
  water: '#2C66BD',
  foam: '#A8DCFF',
  ore: '#C9973A',
  cable: '#B8403F',
} as const;

/** Swatches in the shared atlas (16 × 1 texels). */
export const SW = { plain: 0, trim: 1, glow: 2, cyan: 3, amber: 4, violet: 5, magenta: 6, glass: 7, white: 8, red: 9, green: 10, orange: 11, trimDark: 12 } as const;
export type Swatch = keyof typeof SW;
const ATLAS_W = 16;
const uvOf = (i: number): [number, number] => [(i + 0.5) / ATLAS_W, 0.5];

const FACTION: Record<Faction, { trim: string; glow: string; dark: string }> = {
  player: { trim: '#2FC2B8', glow: '#62F4E7', dark: '#16615C' },
  enemy: { trim: '#DE3F48', glow: '#FF6B5E', dark: '#6E1F27' },
  neutral: { trim: '#C9B48E', glow: '#FFD27A', dark: '#6A5A40' },
};

/** A part's paint from a hex (with an optional edge colour). */
export const paint = (c: string, trim?: string): Paint => ({ color: new THREE.Color(c), trim: trim ? new THREE.Color(trim) : undefined });
/** A part that takes its colour from a swatch (white vertex colour: the texel is the colour). */
export const ink = (s: Swatch): Paint => ({ color: new THREE.Color(1, 1, 1), trim: new THREE.Color(0.82, 0.82, 0.82), all: { kind: 'swatch', uv: uvOf(SW[s]) } });
const swOf = (p: Paint): [number, number] | undefined => p.all?.kind === 'swatch' ? p.all.uv : undefined;
const trimOf = (p: Paint) => p.trim ?? p.color.clone().multiplyScalar(0.62);

/** Outline points in a plane, (a, b): for a 'y' slab that's (x, z); 'z' is (x, y); 'x' is (z, y). */
export type Outline = [number, number][];

export interface SlabOpts {
  /** The top edge's chamfer (the top face is inset by this much). */
  bevel?: number;
  /** The bottom face's size relative to the outline (a ship's hull narrows to the keel). */
  taperBottom?: number;
  /** Which axis the slab is raised along: 'y' (default, a deck), 'z' (a fin), 'x' (a bulkhead). */
  axis?: 'x' | 'y' | 'z';
  /** Turn the finished slab (about its outline's centre, at the start of its rise). */
  rot?: V3;
}

/** One cross-section of a loft, across the x axis. */
export interface Section {
  x: number;
  /** Half-width (z) and half-height above (h) and below (hb) the centre line. */
  w: number;
  h: number;
  hb?: number;
  /** Centre line offset. */
  y?: number;
  z?: number;
  /** Paint from this section to the next (default: the loft's). */
  p?: Paint;
}

export interface LoftOpts {
  /** Corner roundness: 2 an ellipse, 4+ a rounded box. */
  round?: number;
  /** Paint for the end caps (default: the edge colour). */
  cap?: Paint;
}

const uniq = (pts: THREE.Vector3[]) => pts.filter((q, i) => pts.findIndex((r) => r.distanceToSquared(q) < 1e-10) === i);

/** The hull builder: the droid kit plus the shapes structs need. */
export class Hull {
  readonly g = new GeoBuilder();

  /** `scenery`: draw what a hull stands in (a ship's patch of water) for portraits and the codex;
   * the boards have their own sea. */
  constructor(readonly scenery = true) { this.g.white = uvOf(SW.plain); }

  box(at: V3, size: V3, p: Paint, o: Parameters<GeoBuilder['box']>[4] = {}) { this.g.box(0, at, size, p, o); return this; }
  cyl(at: V3, rTop: number, rBot: number, h: number, seg: number, p: Paint, rot?: V3) { this.g.cyl(0, at, rTop, rBot, h, seg, p, rot); return this; }
  /** A cylinder lying along x (engines, barrels): `rEnd` is the radius at its +x end. */
  tube(at: V3, r: number, len: number, seg: number, p: Paint, rEnd = r) { return this.cyl(at, rEnd, r, len, seg, p, [0, 0, -Math.PI / 2]); }
  /** A cylinder lying along z (wheels). */
  wheel(at: V3, r: number, w: number, seg: number, p: Paint) { return this.cyl(at, r, r, w, seg, p, [Math.PI / 2, 0, 0]); }
  gem(at: V3, r: number, p: Paint) { this.g.gem(0, at, r, p); return this; }

  /** A box in a swatch's colour: a lamp, a stripe, a window. */
  lamp(at: V3, size: V3, s: Swatch = 'cyan', rot?: V3) { return this.box(at, size, ink(s), rot ? { rot } : {}); }

  /** Build twice, once on each side (z mirrored). */
  pair(fn: (s: 1 | -1) => void) { fn(1); fn(-1); return this; }
  /** Build n times round the y axis (`a` is the angle). */
  ring(n: number, fn: (a: number, i: number) => void, phase = 0) { for (let i = 0; i < n; i++) fn(phase + (i / n) * Math.PI * 2, i); return this; }

  /** A convex outline raised from `h0` to `h1` along an axis, its top edge chamfered. */
  slab(outline: Outline, h0: number, h1: number, p: Paint, o: SlabOpts = {}) {
    const sw = swOf(p);
    const bevel = Math.min(o.bevel ?? 0, (h1 - h0) * 0.6);
    const ca = outline.reduce((s, q) => s + q[0], 0) / outline.length, cb = outline.reduce((s, q) => s + q[1], 0) / outline.length;
    const ax = o.axis ?? 'y';
    const rot = o.rot ? new THREE.Euler(...o.rot) : null;
    const map = (a: number, b: number, h: number) => ax === 'y' ? new THREE.Vector3(a, h, b) : ax === 'z' ? new THREE.Vector3(a, b, h) : new THREE.Vector3(h, b, a);
    const pivot = map(ca, cb, h0);
    const place = (a: number, b: number, h: number) => {
      const v = map(a, b, h);
      if (rot) v.sub(pivot).applyEuler(rot).add(pivot);
      return v;
    };
    const tb = o.taperBottom ?? 1;
    const ringAt = (h: number, k: number, inset: number) => outline.map(([a, b]) => {
      const da = a - ca, db = b - cb, d = Math.hypot(da, db) || 1, s = Math.max(0, 1 - inset / d) * k;
      return place(ca + da * s, cb + db * s, h);
    });
    const B = ringAt(h0, tb, 0), M = ringAt(h1 - bevel, 1, 0), T = ringAt(h1, 1, bevel);
    const inside = place(ca, cb, (h0 + h1) / 2);
    const col = p.color, trim = trimOf(p);
    this.g.poly(B, trim, 0, inside, undefined, sw);
    this.g.poly(T, col, 0, inside, undefined, sw);
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length;
      this.g.poly([B[i], B[j], M[j], M[i]], col, 0, inside, undefined, sw);
      if (bevel > 1e-5) this.g.poly([M[i], M[j], T[j], T[i]], trim, 0, inside, undefined, sw);
    }
    return this;
  }

  /** A fin or plate standing in the xy plane (outline in x, y), `t` thick, centred on z. */
  fin(outline: Outline, z: number, t: number, p: Paint, rot?: V3) {
    return this.slab(outline, z - t / 2, z + t / 2, p, { axis: 'z', bevel: t * 0.3, rot });
  }

  /** A hull lofted through cross-sections along x: fuselages, ships, pods. */
  loft(sections: Section[], seg: number, p: Paint, o: LoftOpts = {}) {
    const n = o.round ?? 2.4;
    const e = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 2 / n);
    const ringOf = (s: Section) => Array.from({ length: seg }, (_, i) => {
      const a = (i / seg) * Math.PI * 2 + Math.PI / seg;
      const c = Math.cos(a), si = Math.sin(a);
      const hh = si >= 0 ? s.h : (s.hb ?? s.h);
      return new THREE.Vector3(s.x, (s.y ?? 0) + e(si) * hh, (s.z ?? 0) + e(c) * s.w);
    });
    const rings = sections.map(ringOf);
    const centre = (s: Section) => new THREE.Vector3(s.x, (s.y ?? 0) + (s.h - (s.hb ?? s.h)) / 2, s.z ?? 0);
    for (let k = 0; k + 1 < rings.length; k++) {
      const pk = sections[k].p ?? p, sw = swOf(pk);
      const inside = centre(sections[k]).add(centre(sections[k + 1])).multiplyScalar(0.5);
      const A = rings[k], B = rings[k + 1];
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        // A section of zero size is a point: its quads become triangles.
        const pts = uniq([A[i], A[j], B[j], B[i]]);
        if (pts.length >= 3) this.g.poly(pts, pk.color, 0, inside, undefined, sw);
      }
    }
    for (const k of [0, rings.length - 1]) {
      const s = sections[k];
      if (s.w < 1e-4 || s.h < 1e-4) continue;
      const lp = (k === 0 ? s.p : sections[k - 1].p) ?? p;
      const cap = o.cap ?? { color: trimOf(lp), all: lp.all };
      const inside = centre(s).add(new THREE.Vector3(k === 0 ? 1 : -1, 0, 0));
      this.g.poly(rings[k], cap.color, 0, inside, undefined, swOf(cap));
    }
    return this;
  }

  /** A profile spun round a vertical axis: [radius, y] from bottom to top, with per-band paints. */
  lathe(at: V3, profile: [number, number][], seg: number, p: Paint, bands?: (Paint | undefined)[], phase = 0) {
    const [cx, cy, cz] = at;
    const rings = profile.map(([r, y]) => Array.from({ length: seg }, (_, i) => {
      const a = phase + (i / seg) * Math.PI * 2 + Math.PI / seg;
      return new THREE.Vector3(cx + Math.cos(a) * r, cy + y, cz + Math.sin(a) * r);
    }));
    const band = (k: number) => bands?.[Math.max(0, Math.min(k, profile.length - 2))] ?? p;
    for (let k = 0; k + 1 < rings.length; k++) {
      const pk = band(k), sw = swOf(pk);
      const inside = new THREE.Vector3(cx, cy + (profile[k][1] + profile[k + 1][1]) / 2, cz);
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        const pts = uniq([rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]]);
        if (pts.length >= 3) this.g.poly(pts, pk.color, 0, inside, undefined, sw);
      }
    }
    for (const [k, dir] of [[0, -1], [rings.length - 1, 1]] as const) if (profile[k][0] > 1e-4) {
      const pk = band(k);
      this.g.poly(rings[k], trimOf(pk), 0, new THREE.Vector3(cx, cy + profile[k][1] - dir, cz), undefined, swOf(pk));
    }
    return this;
  }

  /** An ellipsoid pod along x. */
  pod(at: V3, len: number, w: number, h: number, seg: number, p: Paint, steps = 6) {
    const s: Section[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = -1 + (2 * i) / steps, k = Math.sqrt(Math.max(0, 1 - t * t));
      s.push({ x: at[0] + t * len / 2, y: at[1], z: at[2], w: w * k, h: h * k });
    }
    return this.loft(s, seg, p, { round: 2 });
  }

  /** A ring (torus) round the y axis, turned by `rot`: halos, orbits, shield rings. */
  torus(at: V3, R: number, r: number, seg: number, tseg: number, p: Paint, rot?: V3) {
    // Fewer than three sides is a flat strip, whose faces would wind at random.
    tseg = Math.max(3, tseg);
    const e = rot ? new THREE.Euler(...rot) : null, c = new THREE.Vector3(...at), sw = swOf(p);
    const place = (v: THREE.Vector3) => { if (e) v.applyEuler(e); return v.add(c); };
    const pt = (i: number, j: number) => {
      const a = (i / seg) * Math.PI * 2, b = (j / tseg) * Math.PI * 2, k = R + r * Math.cos(b);
      return place(new THREE.Vector3(Math.cos(a) * k, r * Math.sin(b), Math.sin(a) * k));
    };
    for (let i = 0; i < seg; i++) {
      const a = ((i + 0.5) / seg) * Math.PI * 2;
      // Wind each face away from the tube's own centre line, not the ring's axis.
      const inside = place(new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R));
      for (let j = 0; j < tseg; j++) this.g.poly([pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)], p.color, 0, inside, undefined, sw);
    }
    return this;
  }

  /** A dome (a half ellipsoid) standing on y. */
  dome(at: V3, r: number, h: number, seg: number, p: Paint, steps = 4, bands?: (Paint | undefined)[]) {
    const prof: [number, number][] = [];
    for (let i = 0; i <= steps; i++) { const a = (i / steps) * Math.PI / 2; prof.push([Math.cos(a) * r, Math.sin(a) * h]); }
    return this.lathe(at, prof, seg, p, bands);
  }

  /** A slanted stripe on a top surface from (x0, z0) to (x1, z1), in a swatch's colour. */
  stripe(y: number, x0: number, z0: number, x1: number, z1: number, w: number, s: Swatch = 'trim') {
    const len = Math.hypot(x1 - x0, z1 - z0), a = Math.atan2(-(z1 - z0), x1 - x0);
    return this.box([(x0 + x1) / 2, y, (z0 + z1) / 2], [len, 0.025, w], ink(s), { rot: [0, a, 0] });
  }

  /** The planet buildings' plinth: a dark hexagon with the faction band and corner lamps. Returns its top. */
  plinth(r = 0.85, h = 0.22) {
    this.cyl([0, h / 2, 0], r * 0.94, r, h, 6, paint(C.deep, C.black));
    this.cyl([0, h * 0.6, 0], r * 0.985, r * 0.985, 0.06, 6, ink('trim'));
    this.cyl([0, h + 0.03, 0], r * 0.84, r * 0.9, 0.06, 6, paint(C.slate, C.deep));
    this.ring(6, (a) => this.lamp([Math.cos(a) * r * 0.9, h * 0.25, Math.sin(a) * r * 0.9], [0.07, 0.04, 0.07], 'amber'), Math.PI / 6);
    return h + 0.06;
  }

  /** A glowing engine on the -x end of `at`: a dark bell and its lit core. */
  engine(at: V3, r: number, len = r * 1.4, s: Swatch = 'cyan') {
    this.tube([at[0] - len / 2, at[1], at[2]], r, len, 10, paint(C.slate, C.deep), r * 0.9);
    this.tube([at[0] - len - 0.006, at[1], at[2]], r * 0.66, 0.02, 10, ink(s));
    return this;
  }

  get triangles() { return this.g.triangles; }

  build(): THREE.BufferGeometry {
    const geo = this.g.build();
    // Structs never bend: drop the droid kit's skinning attributes.
    geo.deleteAttribute('skinIndex');
    geo.deleteAttribute('skinWeight');
    return geo;
  }
}

/* ── Materials: one per faction (and a scorched one for damage) ──────────── */

export type Variant = 'base' | 'dmg';
//                plain      trim  glow  cyan       amber      violet     magenta    glass      white      red        green      orange     trimDark
const SWATCHES = ['#FFFFFF', '', '', '#7AF0FF', '#FFB54A', '#A65CFF', '#FF4D9A', '#1B2A40', '#FFFFFF', '#FF4D4D', '#7DFF8A', '#FF8A2A', ''];
/** How much each swatch glows (0 = paint only). Glass glows faintly, as lit cockpits do; the faction
 * band glows a little too, so whose a hull is reads at a glance on a small, busy board. */
const LIT = [0, 0.4, 1, 1, 1, 0.85, 1, 0.3, 1, 1, 1, 1, 0];

/** The atlas's swatch colours (sRGB hex) for a faction and variant: the CPU side of the textures. */
export function swatchColors(f: Faction, v: Variant = 'base'): { color: string[]; glow: string[] } {
  const F = FACTION[f];
  const color = SWATCHES.map((c, i) => i === 1 ? F.trim : i === 2 ? F.glow : i === 12 ? F.dark : c);
  // Damage: scorched paint (the white texel tints every plain part), lamps mostly out.
  const scorch = (hex: string, k: number) => '#' + new THREE.Color(hex).lerp(new THREE.Color('#3A2A22'), k).getHexString();
  const paintCol = v === 'dmg' ? color.map((c, i) => scorch(c, i === 0 ? 0.42 : 0.3)) : color;
  const glow = color.map((c, i) => '#' + new THREE.Color(c).multiplyScalar(LIT[i] * (v === 'dmg' ? 0.35 : 1)).getHexString());
  return { color: paintCol, glow };
}

const atlases = new Map<string, { map: THREE.CanvasTexture; glow: THREE.CanvasTexture }>();
/** The shared atlas textures for a faction and variant (never dispose them). */
export function hullAtlas(f: Faction, v: Variant = 'base') {
  const key = f + v;
  let a = atlases.get(key);
  if (!a) {
    const sw = swatchColors(f, v);
    const mk = (fill: string[]) => {
      const c = document.createElement('canvas');
      c.width = ATLAS_W; c.height = 1;
      const g = c.getContext('2d')!;
      g.fillStyle = '#000'; g.fillRect(0, 0, ATLAS_W, 1);
      fill.forEach((col, i) => { g.fillStyle = col; g.fillRect(i, 0, 1, 1); });
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      return t;
    };
    a = { map: mk(sw.color), glow: mk(sw.glow) };
    atlases.set(key, a);
  }
  return a;
}

/** Which swatch a UV points at (for reading colours back on the CPU). */
export const swatchAt = (u: number) => Math.min(ATLAS_W - 1, Math.max(0, Math.floor(u * ATLAS_W)));

const materials = new Map<string, THREE.MeshStandardMaterial>();
/** A plain shared hull material (portraits, the lab). The boards use model.ts's, with effects. */
export function hullMaterial(f: Faction, v: Variant = 'base'): THREE.MeshStandardMaterial {
  let m = materials.get(f + v);
  if (!m) {
    const a = hullAtlas(f, v);
    m = new THREE.MeshStandardMaterial({
      vertexColors: true, map: a.map, emissiveMap: a.glow, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 1.8,
      roughness: 0.45, metalness: 0.3,
    });
    materials.set(f + v, m);
  }
  return m;
}
