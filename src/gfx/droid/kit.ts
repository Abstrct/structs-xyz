/* The droid kit: faceted low-poly primitives (chamfered boxes, prisms, gems) written straight into
 * one flat-shaded buffer. Every vertex carries the bone it rides on, so a whole droid is a single
 * rigidly skinned mesh: one draw call, and the parts still swing.
 *
 * Colour comes from two places: the vertex colour (a part's palette colour) times the atlas texel
 * its UV points at. Plain faces point at a white texel; a decal face (the head's front, the
 * chest, the shoulder pads) points into the PFP layer itself; glowing parts point at a swatch
 * whose emissive mask is lit. No custom shader. */
import * as THREE from 'three';

export type V3 = [number, number, number];

/** Where a face's UVs land in the atlas. */
export type Ink =
  | { kind: 'plain' }
  | { kind: 'swatch'; uv: [number, number] }
  | { kind: 'decal'; rect: [number, number, number, number] };   // u0, v0, u1, v1

export interface Paint {
  color: THREE.Color;
  /** Bevels and corners: darker by default, so plates read as plates. */
  trim?: THREE.Color;
  /** Front (+z) face only. */
  front?: Ink;
  /** Every face (overrides plain). */
  all?: Ink;
}

export interface BoxOpts {
  chamfer?: number;
  /** Width scale at the top and bottom (1 = straight); applied to depth too when taperDepth. */
  taperTop?: number;
  taperBottom?: number;
  taperDepth?: boolean;
  rot?: V3;
}

const WHITE_UV: [number, number] = [0.5, 0.5];

export class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private uvs: number[] = [];
  private bones: number[] = [];
  /** The plain white texel (set by the atlas layout). */
  white: [number, number] = WHITE_UV;

  get triangles() { return this.pos.length / 9; }

  /** One triangle, flat-shaded, wound so its normal faces away from `inside`. */
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, bone: number,
    uv: [[number, number], [number, number], [number, number]] | null, inside: THREE.Vector3) {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.lengthSq() < 1e-14) return;
    const mid = new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3);
    if (n.dot(mid.sub(inside)) < 0) { [b, c] = [c, b]; if (uv) uv = [uv[0], uv[2], uv[1]]; n.negate(); }
    n.normalize();
    for (const [i, p] of [a, b, c].entries()) {
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(n.x, n.y, n.z);
      this.col.push(color.r, color.g, color.b);
      const t = uv ? uv[i] : this.white;
      this.uvs.push(t[0], t[1]);
      this.bones.push(bone);
    }
  }

  /** A convex polygon (fan), with optional per-vertex UVs. */
  poly(pts: THREE.Vector3[], color: THREE.Color, bone: number, inside: THREE.Vector3, uv?: [number, number][], swatch?: [number, number]) {
    for (let i = 1; i + 1 < pts.length; i++) {
      const u = uv ? [uv[0], uv[i], uv[i + 1]] as [[number, number], [number, number], [number, number]]
        : swatch ? [swatch, swatch, swatch] as [[number, number], [number, number], [number, number]] : null;
      this.tri(pts[0].clone(), pts[i].clone(), pts[i + 1].clone(), color, bone, u, inside);
    }
  }

  /** A chamfered (or sharp) box centred on `at`. */
  box(bone: number, at: V3, size: V3, paint: Paint, o: BoxOpts = {}) {
    const [hw, hh, hd] = [size[0] / 2, size[1] / 2, size[2] / 2];
    const c = Math.min(o.chamfer ?? 0, hw * 0.45, hh * 0.45, hd * 0.45);
    const tt = o.taperTop ?? 1, tb = o.taperBottom ?? 1;
    const rot = o.rot ? new THREE.Euler(...o.rot) : null;
    const centre = new THREE.Vector3(...at);
    const place = (x: number, y: number, z: number) => {
      const t = (y + hh) / (2 * hh);
      const s = tb + (tt - tb) * t;
      const v = new THREE.Vector3(x * s, y, o.taperDepth ? z * s : z);
      if (rot) v.applyEuler(rot);
      return v.add(centre);
    };
    const trim = paint.trim ?? paint.color.clone().multiplyScalar(0.62);
    const ink = (i: Ink | undefined): [number, number] | null => i?.kind === 'swatch' ? i.uv : null;
    const allSw = ink(paint.all);

    // Front-face UVs for a decal: local x/y across the face → the decal rectangle.
    const decalUV = (x: number, y: number, fx: number, fy: number): [number, number] => {
      const r = (paint.front as { rect: [number, number, number, number] }).rect;
      return [r[0] + (r[2] - r[0]) * (x / fx * 0.5 + 0.5), r[1] + (r[3] - r[1]) * (y / fy * 0.5 + 0.5)];
    };
    // A decal face in horizontal strips: on a tapered face each row then maps across its own
    // width, so the pixel art doesn't bend along a diagonal.
    const decalFace = (fx: number, fy: number, z: number) => {
      const N = 4, white = new THREE.Color(1, 1, 1);
      for (let k = 0; k < N; k++) {
        const y0 = -fy + (2 * fy * k) / N, y1 = -fy + (2 * fy * (k + 1)) / N;
        const loc: V3[] = [[-fx, y0, z], [fx, y0, z], [fx, y1, z], [-fx, y1, z]];
        this.poly(loc.map((p) => place(...p)), white, bone, centre, loc.map((p) => decalUV(p[0], p[1], fx, fy)));
      }
    };

    if (c <= 1e-6) {
      const faces: [V3, V3, V3, V3, string][] = [];
      for (const s of [-1, 1]) {
        faces.push([[s * hw, -hh, -hd], [s * hw, hh, -hd], [s * hw, hh, hd], [s * hw, -hh, hd], 'x']);
        faces.push([[-hw, s * hh, -hd], [hw, s * hh, -hd], [hw, s * hh, hd], [-hw, s * hh, hd], 'y']);
        faces.push([[-hw, -hh, s * hd], [hw, -hh, s * hd], [hw, hh, s * hd], [-hw, hh, s * hd], s > 0 ? 'pz' : 'z']);
      }
      for (const [a, b, cc, d, tag] of faces) {
        const pts = [a, b, cc, d].map((p) => place(...p));
        if (tag === 'pz' && paint.front?.kind === 'decal') decalFace(hw, hh, hd);
        else this.poly(pts, paint.color, bone, centre, undefined, tag === 'pz' ? ink(paint.front) ?? allSw ?? undefined : allSw ?? undefined);
      }
      return;
    }

    const vx = (sx: number, sy: number, sz: number): V3 => [sx * hw, sy * (hh - c), sz * (hd - c)];
    const vy = (sx: number, sy: number, sz: number): V3 => [sx * (hw - c), sy * hh, sz * (hd - c)];
    const vz = (sx: number, sy: number, sz: number): V3 => [sx * (hw - c), sy * (hh - c), sz * hd];
    const S = [-1, 1];
    const P = (v: V3) => place(...v);
    for (const s of S) {
      this.poly([vx(s, -1, -1), vx(s, 1, -1), vx(s, 1, 1), vx(s, -1, 1)].map(P), paint.color, bone, centre, undefined, allSw ?? undefined);
      this.poly([vy(-1, s, -1), vy(1, s, -1), vy(1, s, 1), vy(-1, s, 1)].map(P), paint.color, bone, centre, undefined, allSw ?? undefined);
      const zq: V3[] = [vz(-1, -1, s), vz(1, -1, s), vz(1, 1, s), vz(-1, 1, s)];
      if (s > 0 && paint.front?.kind === 'decal') decalFace(hw - c, hh - c, hd);
      else this.poly(zq.map(P), paint.color, bone, centre, undefined, (s > 0 ? ink(paint.front) : null) ?? allSw ?? undefined);
    }
    for (const a of S) for (const b of S) {
      this.poly([vy(-1, a, b), vy(1, a, b), vz(1, a, b), vz(-1, a, b)].map(P), trim, bone, centre, undefined, allSw ?? undefined);
      this.poly([vx(a, -1, b), vx(a, 1, b), vz(a, 1, b), vz(a, -1, b)].map(P), trim, bone, centre, undefined, allSw ?? undefined);
      this.poly([vx(a, b, -1), vx(a, b, 1), vy(a, b, 1), vy(a, b, -1)].map(P), trim, bone, centre, undefined, allSw ?? undefined);
    }
    for (const sx of S) for (const sy of S) for (const sz of S) {
      this.poly([vx(sx, sy, sz), vy(sx, sy, sz), vz(sx, sy, sz)].map(P), trim, bone, centre, undefined, allSw ?? undefined);
    }
  }

  /** A prism / cone frustum along +y (rotate it with `rot`), `seg` sides, flat caps. */
  cyl(bone: number, at: V3, rTop: number, rBot: number, h: number, seg: number, paint: Paint, rot?: V3) {
    const centre = new THREE.Vector3(...at);
    const e = rot ? new THREE.Euler(...rot) : null;
    const place = (x: number, y: number, z: number) => { const v = new THREE.Vector3(x, y, z); if (e) v.applyEuler(e); return v.add(centre); };
    const top: THREE.Vector3[] = [], bot: THREE.Vector3[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2 + Math.PI / seg;
      top.push(place(Math.cos(a) * rTop, h / 2, Math.sin(a) * rTop));
      bot.push(place(Math.cos(a) * rBot, -h / 2, Math.sin(a) * rBot));
    }
    const sw = paint.all?.kind === 'swatch' ? paint.all.uv : undefined;
    const trim = paint.trim ?? paint.color.clone().multiplyScalar(0.62);
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      this.poly([bot[i], bot[j], top[j], top[i]], paint.color, bone, centre, undefined, sw);
    }
    if (rTop > 1e-4) this.poly(top, trim, bone, centre, undefined, sw);
    if (rBot > 1e-4) this.poly(bot, trim, bone, centre, undefined, sw);
  }

  /** A faceted gem (icosahedron). */
  gem(bone: number, at: V3, r: number, paint: Paint) {
    const ico = new THREE.IcosahedronGeometry(r, 0);
    const g = ico.index ? ico.toNonIndexed() : ico;
    const p = g.getAttribute('position');
    const centre = new THREE.Vector3(...at);
    const sw = paint.all?.kind === 'swatch' ? paint.all.uv : undefined;
    for (let i = 0; i < p.count; i += 3) {
      const v = [0, 1, 2].map((k) => new THREE.Vector3(p.getX(i + k), p.getY(i + k), p.getZ(i + k)).add(centre));
      this.tri(v[0], v[1], v[2], paint.color, bone, sw ? [sw, sw, sw] : null, centre);
    }
    g.dispose();
    ico.dispose();
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    const n = this.bones.length;
    const idx = new Uint16Array(n * 4), w = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { idx[i * 4] = this.bones[i]; w[i * 4] = 1; }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}
