/* The diorama's decks, tier by tier, built low-poly and flat-shaded like the hulls and the
 * Concourse: a cross-section of the world the battle is fought over, in the order altitude stacks
 * it. Water at the bottom: a faceted sea strip riding the swell, cut away at the front to show its
 * column. Land above it: a proving ground of sand under the hulls, hills rising behind, mesas on the
 * skyline, the deck's front cut away to show its strata. The cloud layer above that, three banks
 * deep and drifting. Orbit at the top: a station rail the space hulls hold station along, rubble
 * tumbling behind. Down the middle, the barrier between the fleets.
 *
 * Kept low in contrast behind the hulls (their keylines and the board's marks read on top), nothing
 * tall at a deck's front edge (a back-rank hull and its pips stand at z −1.5..3), and nothing here
 * takes a pick. Built from plain geometry in a few milliseconds (BattleSet rebuilds it whenever an
 * upright phone stretches the tiers): no bakes. */
import * as THREE from 'three';
import { AMBIT_COLOR, type Ambit } from '../../data/catalogue';
import { LOOK } from '../../core/engine';

/* The swell, shared by the sea's shader and the hulls riding it. */
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

/** The colours of a world (linear albedo) from its palette: sea, lowland, highland. Every world
 * keeps its hues at fixed brightness, so a pale desert and a dark jungle read the same behind hulls;
 * a spent world is dark and dry. */
function tones(palette: [number, number, number], spent: boolean) {
  const L = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const norm = (c: THREE.Color, l: number) => c.multiplyScalar(l / Math.max(1e-4, L(c)));
  if (spent) {
    const ash = new THREE.Color(0x3a3330);
    return { sand: norm(ash.clone(), 0.07), rock: norm(new THREE.Color(0x3a2a26), 0.04), dark: norm(new THREE.Color(0x201819), 0.015),
      shallow: norm(new THREE.Color(0x2a2a30), 0.03), deep: norm(new THREE.Color(0x15151a), 0.012), foam: norm(ash.clone(), 0.05) };
  }
  const [sea, low, high] = palette.map((c) => new THREE.Color(c));
  return {
    // Leaned well toward ochre: the board's lights are cool, and sand must still read as sand.
    sand: norm(high.clone().lerp(new THREE.Color(0.62, 0.38, 0.16), 0.55), 0.34),
    rock: norm(low.clone().lerp(high, 0.4).lerp(new THREE.Color(0.34, 0.14, 0.06), 0.5), 0.13),
    dark: norm(low.clone().lerp(new THREE.Color(0.08, 0.04, 0.025), 0.45), 0.035),
    shallow: norm(sea.clone().lerp(new THREE.Color(0.05, 0.42, 0.55), 0.55), 0.13),
    deep: norm(sea.clone().lerp(new THREE.Color(0.01, 0.04, 0.12), 0.35), 0.03),
    foam: new THREE.Color(0.55, 0.7, 0.8),
  };
}
type Tones = ReturnType<typeof tones>;

/** The far back of every deck melts into the night (aerial perspective, without scene fog). */
const DUSK = new THREE.Color(0x0b1226);

export interface SceneryOptions {
  halfWidth: number;
  tierY: Record<Ambit, number>;
  palette: [number, number, number];
  seed: number;
  spent: boolean;
}

/** Colour weights per face (or per vertex), kept so a new world repaints without rebuilding: k picks
 * along the world's tones, far fades toward the night. */
interface Paintable { attr: THREE.BufferAttribute; tint: Float32Array; far?: Float32Array; pick: (t: Tones, k: number) => THREE.Color }
/** A bit of drifting scenery (a cloud puff, a rock in orbit). */
interface Drifter { p: THREE.Vector3; r: THREE.Euler; w: THREE.Vector3; s: THREE.Vector3; v: number; W: number }

export class Scenery {
  readonly group = new THREE.Group();
  readonly halfWidth: number;
  /** Ground level of the land tier and the sea surface (where hulls stand and float). */
  readonly groundY: number;
  readonly seaY: number;
  private mats: THREE.Material[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private paintables: Paintable[] = [];
  private toned: { mat: THREE.MeshStandardMaterial; pick: (t: Tones) => THREE.Color; dusk: number }[] = [];
  private pulseMats: Record<Ambit, { mat: THREE.MeshBasicMaterial; base: THREE.Color; k: number }[]> = { space: [], air: [], land: [], water: [] };
  private drift: { mesh: THREE.InstancedMesh; items: Drifter[] }[] = [];
  private seaU = { uTime: { value: 0 }, uCalm: { value: 1 }, uShallow: { value: new THREE.Color() }, uDeep: { value: new THREE.Color() }, uFoam: { value: new THREE.Color() } };
  private wet: THREE.Object3D[] = [];
  private dry: THREE.Object3D[] = [];
  private barrierU = { uTime: { value: 0 } };
  private dummy = new THREE.Object3D();
  private rnd: () => number;

  constructor(private o: SceneryOptions) {
    this.halfWidth = o.halfWidth;
    this.groundY = o.tierY.land - 1.85;
    this.seaY = o.tierY.water - 1.75;
    let s = (o.seed * 9301 + 49297) % 233280 || 7;
    this.rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    this.orbit();
    this.clouds();
    this.land();
    this.sea();
    this.barrier();
    this.shade();
    this.paint(o.palette, o.spent);
    // Scenery never takes a pick: the board's hit tests see hulls only.
    this.group.traverse((m) => { m.raycast = () => {}; });
  }

  /* ── Helpers ─────────────────────────────────────────────────────────── */

  private geo<G extends THREE.BufferGeometry>(g: G): G { this.geos.push(g); return g; }
  private mat<M extends THREE.Material>(m: M): M { this.mats.push(m); return m; }
  private flat(o: THREE.MeshStandardMaterialParameters = {}) { return this.mat(new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9, metalness: 0.04, ...o })); }
  /** A material whose colour comes from the world's tones (repainted by paint()). */
  private tonedMat(pick: (t: Tones) => THREE.Color, dusk = 0, o: THREE.MeshStandardMaterialParameters = {}) {
    const m = this.flat(o);
    this.toned.push({ mat: m, pick, dusk });
    return m;
  }
  /** A thin lit strip in a battleground's colour that flares when that battleground fires. */
  private strip(a: Ambit, w: number, h: number, d: number, at: [number, number, number], k = 0.35) {
    const base = new THREE.Color(AMBIT_COLOR[a]);
    const m = this.mat(new THREE.MeshBasicMaterial({ color: base.clone().multiplyScalar(k), toneMapped: false }));
    this.pulseMats[a].push({ mat: m, base, k });
    const mesh = new THREE.Mesh(this.geo(new THREE.BoxGeometry(w, h, d)), m);
    mesh.position.set(...at);
    this.group.add(mesh);
    return mesh;
  }
  /** Non-indexed copy (flat faces each get their own colour). */
  private faceted(g: THREE.BufferGeometry) {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    return this.geo(n);
  }
  /** Give a faceted geometry per-face colours chosen by `pick(tones, k)` with a per-face weight k. */
  private paintable(g: THREE.BufferGeometry, weight: (cx: number, cy: number, cz: number) => [number, number], pick: Paintable['pick']) {
    const p = g.getAttribute('position');
    const tint = new Float32Array(p.count / 3), far = new Float32Array(p.count / 3);
    for (let f = 0; f < tint.length; f++) {
      const i = f * 3;
      [tint[f], far[f]] = weight((p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3, (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3, (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3);
    }
    const attr = new THREE.Float32BufferAttribute(new Float32Array(p.count * 3), 3);
    g.setAttribute('color', attr);
    this.paintables.push({ attr, tint, far, pick });
  }

  /* ── Orbit: the station rail ─────────────────────────────────────────── */
  private orbit() {
    const HW = this.halfWidth, y = this.o.tierY.space - 1.9;
    const hull = this.flat({ color: new THREE.Color(0x8d97ab), roughness: 0.55, metalness: 0.45 });
    // Two rails, the front one low enough that no hull's pips hide behind it.
    for (const [z, t] of [[2.4, 0.14], [-3.4, 0.2]] as const) {
      const r = new THREE.Mesh(this.geo(new THREE.BoxGeometry(HW * 2.6, t, t)), hull);
      r.position.set(0, y - 0.15, z);
      this.group.add(r);
    }
    const ties = new THREE.InstancedMesh(this.geo(new THREE.BoxGeometry(0.1, 0.1, 5.8)), hull, 40);
    for (let i = 0; i < 40; i++) {
      this.dummy.position.set(-HW * 1.3 + i * (HW * 2.6 / 39), y - 0.15, -0.5);
      this.dummy.rotation.set(0, 0, 0); this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      ties.setMatrixAt(i, this.dummy.matrix);
    }
    this.group.add(ties);
    this.strip('space', HW * 2.6, 0.035, 0.035, [0, y - 0.06, 2.4]);
    // Rubble drifting along behind the rail.
    this.driftField(this.geo(new THREE.IcosahedronGeometry(1, 0)), this.flat({ color: new THREE.Color(0x4a4650), roughness: 1 }), 46, (it) => {
      it.p.set((this.rnd() - 0.5) * HW * 3, y + (this.rnd() - 0.3) * 4.5, -6 - this.rnd() * 14);
      const k = 0.08 + Math.pow(this.rnd(), 3) * 0.45;
      it.s.set(k * (0.7 + this.rnd() * 0.6), k * (0.6 + this.rnd() * 0.5), k);
      it.v = 0.05 + this.rnd() * 0.25; it.W = HW * 1.6;
      it.w.set((this.rnd() - 0.5) * 0.8, (this.rnd() - 0.5) * 0.8, (this.rnd() - 0.5) * 0.8);
    });
  }

  /* ── The cloud layer: three banks, drifting ──────────────────────────── */
  private clouds() {
    const HW = this.halfWidth, base = this.o.tierY.air - 2.6;
    const puff = this.geo(new THREE.IcosahedronGeometry(1, LOOK.dc ? 0 : 1));
    const mat = this.flat({ color: new THREE.Color(0xd8dcef), emissive: new THREE.Color(0x3a4370), emissiveIntensity: 0.5, roughness: 1 });
    const bank = (n: number, z0: number, z1: number, k0: number, k1: number, speed: number, top: number) => this.driftField(puff, mat, n, (it) => {
      const z = z0 + (z1 - z0) * this.rnd(), k = k0 + (k1 - k0) * this.rnd();
      it.s.set(k * (1.4 + this.rnd()), k * (0.42 + this.rnd() * 0.2), k * (1 + this.rnd() * 0.5));
      // Tops stay under `top`: never up among the hulls.
      it.p.set((this.rnd() - 0.5) * HW * 3.2, Math.min(top - it.s.y, base + (this.rnd() - 0.5) * 0.8), z);
      it.r.set(0, this.rnd() * 3, 0);
      it.v = speed * (0.7 + this.rnd() * 0.6); it.W = HW * 1.6 + -z * 0.6;
    });
    bank(70, -18, -11, 1.6, 3.2, 0.08, base + 1.2);
    bank(60, -10, -4.5, 1.1, 2.2, 0.16, base + 0.7);
    // The front bank stays small and low: back-rank hulls stand just above it.
    bank(22, 1.2, 3.2, 0.45, 0.9, 0.3, base + 0.1);
    this.strip('air', HW * 2.6, 0.03, 0.03, [0, this.o.tierY.air - 1.9, 2.9], 0.22);
  }

  /** Instanced bits that drift along x and wrap (clouds, rubble). */
  private driftField(g: THREE.BufferGeometry, m: THREE.Material, n: number, init: (it: Drifter) => void) {
    const mesh = new THREE.InstancedMesh(g, m, n);
    const items = Array.from({ length: n }, () => {
      const it: Drifter = { p: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), s: new THREE.Vector3(1, 1, 1), v: 0, W: this.halfWidth * 1.6 };
      init(it);
      return it;
    });
    this.drift.push({ mesh, items });
    this.place(mesh, items);
    this.group.add(mesh);
  }
  private place(mesh: THREE.InstancedMesh, items: Drifter[]) {
    items.forEach((it, i) => {
      this.dummy.position.copy(it.p); this.dummy.rotation.copy(it.r); this.dummy.scale.copy(it.s);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }

  /* ── Land: the proving ground, the hills, the skyline ───────────────── */
  private land() {
    const HW = this.halfWidth, y = this.groundY, front = 3.4;
    const W = HW * 1.75, D = 30;
    const g = new THREE.PlaneGeometry(W * 2, D, LOOK.dc ? 36 : 56, LOOK.dc ? 12 : 18);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, front - D / 2);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      // Flat where the hulls stand (z > −3); rising behind into rolling hills.
      const back = Math.max(0, -z - 3) / 9;
      const n = Math.sin(x * 0.29 + z * 0.17 + this.o.seed) * 0.55 + Math.sin(x * 0.12 - z * 0.33) * 0.75 + Math.sin(x * 0.7 + z * 0.5) * 0.15;
      p.setY(i, y + back * back * 2.2 + n * Math.min(1, back) * 1.1);
    }
    const top = this.faceted(g);
    top.computeVertexNormals();
    // Sand where the hulls stand, rock up the hills, dark on the tops; the back fades into the night.
    this.paintable(top, (_cx, cy, cz) => [Math.min(1, Math.max(0, (cy - y) / 3.2)), Math.min(0.7, Math.max(0, -cz - 12) / 16)],
      (t, h) => h < 0.45 ? t.sand.clone().lerp(t.rock, h / 0.45) : t.rock.clone().lerp(t.dark, (h - 0.45) / 0.55));
    this.group.add(new THREE.Mesh(top, this.flat({ vertexColors: true })));
    // The deck's front, cut away: strata, then a ragged underside. Nothing taller than the ground.
    const strata: [number, (t: Tones) => THREE.Color][] = [[0.35, (t) => t.sand.clone().multiplyScalar(0.8)], [0.6, (t) => t.rock], [0.8, (t) => t.dark.clone().multiplyScalar(1.6)]];
    let yy = y;
    for (const [h, pick] of strata) {
      const m = new THREE.Mesh(this.geo(new THREE.BoxGeometry(W * 2, h, 1.6)), this.tonedMat(pick));
      m.position.set(0, yy - h / 2, front - 0.8);
      this.group.add(m);
      yy -= h;
    }
    const under = this.faceted(new THREE.ConeGeometry(0.9, 1.6, 5));
    const crags = new THREE.InstancedMesh(under, this.tonedMat((t) => t.dark.clone().multiplyScalar(1.3)), 26);
    for (let i = 0; i < 26; i++) {
      this.dummy.position.set(-W + (i + this.rnd()) * (W * 2 / 26), yy - 0.35, front - 0.3 - this.rnd() * 1.2);
      this.dummy.rotation.set(Math.PI, this.rnd() * 3, 0);
      // Short: the sea's hulls and their pips are not far below.
      const k = 0.35 + this.rnd() * 0.3;
      this.dummy.scale.set(k * 1.4, k * (0.7 + this.rnd() * 0.5), k * 1.4);
      this.dummy.updateMatrix();
      crags.setMatrixAt(i, this.dummy.matrix);
    }
    this.group.add(crags);
    this.strip('land', W * 2, 0.04, 0.04, [0, y + 0.01, front + 0.01], 0.22);
    // Mesas and buttes on the skyline, fading into the night with distance.
    for (let i = 0; i < 11; i++) {
      // Tops stay under the cloud layer at any stretch of the tiers.
      const hMax = this.o.tierY.air - 2.9 - y - 1.2;
      const z = -20 - this.rnd() * 26, h = Math.min(hMax, 2.5 + this.rnd() * 6), r = 2 + this.rnd() * 3.5, seg = 6 + Math.floor(this.rnd() * 3);
      const far = Math.min(0.75, (-z - 18) / 34);
      const body = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(r * (0.7 + this.rnd() * 0.15), r, h, seg)), this.tonedMat((t) => t.rock.clone().lerp(t.dark, 0.3), far));
      const x = (i / 10 - 0.5) * HW * 4.6 + (this.rnd() - 0.5) * 8;
      body.position.set(x, y + 1.2 + h / 2, z);
      this.group.add(body);
      const cap = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(r * 0.72, r * 0.74, 0.35, seg)), this.tonedMat((t) => t.sand, far));
      cap.position.set(x, y + 1.2 + h + 0.17, z);
      this.group.add(cap);
    }
    // A few boulders behind the hulls' line (never in front of it).
    const rock = new THREE.InstancedMesh(this.geo(new THREE.IcosahedronGeometry(1, 0)), this.tonedMat((t) => t.rock), 18);
    for (let i = 0; i < 18; i++) {
      const k = 0.2 + this.rnd() * 0.5;
      this.dummy.position.set((this.rnd() - 0.5) * W * 1.8, y + k * 0.4, -4 - this.rnd() * 9);
      this.dummy.rotation.set(this.rnd() * 3, this.rnd() * 3, 0);
      this.dummy.scale.set(k * 1.3, k * 0.8, k);
      this.dummy.updateMatrix();
      rock.setMatrixAt(i, this.dummy.matrix);
    }
    this.group.add(rock);
  }

  /* ── Water: the sea strip and its column ─────────────────────────────── */
  private sea() {
    const HW = this.halfWidth, y = this.seaY, front = 3.4, W = HW * 1.75, D = 34;
    const g = new THREE.PlaneGeometry(W * 2, D, LOOK.dc ? 48 : 80, LOOK.dc ? 14 : 22);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, front - D / 2);
    const water = this.flat({ roughness: 0.28, metalness: 0.15, color: new THREE.Color(1, 1, 1) });
    water.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.seaU);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime, uCalm;\nvarying float vWave;\nvarying float vZ;\n' + WAVE_GLSL)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWave = wave(wp.xz, uTime) * uCalm;\ntransformed.y += vWave;\nvZ = wp.z;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uShallow, uDeep, uFoam;\nvarying float vWave;\nvarying float vZ;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          // Shallow at the front, deep toward the back; foam on the crests.
          diffuseColor.rgb = mix(uDeep, uShallow, smoothstep(-26.0, 2.5, vZ));
          diffuseColor.rgb = mix(diffuseColor.rgb, uFoam, smoothstep(0.09, 0.15, vWave));`);
    };
    water.customProgramCacheKey = () => 'scenery-sea-v1';
    const sea = new THREE.Mesh(this.geo(g), water);
    sea.position.y = y;
    this.group.add(sea);
    this.wet.push(sea);
    // The column under the cutaway: bright under the surface, dark below.
    const col = new THREE.PlaneGeometry(W * 2, 3.2, 1, 6);
    const cp = col.getAttribute('position');
    const cc = new Float32Array(cp.count * 3);
    col.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    const column = new THREE.Mesh(this.geo(col), this.mat(new THREE.MeshBasicMaterial({ vertexColors: true })));
    column.position.set(0, y - 1.6, front);
    this.group.add(column);
    this.wet.push(column);
    this.paintables.push({ attr: col.getAttribute('color') as THREE.BufferAttribute, tint: new Float32Array(Array.from({ length: cp.count }, (_, i) => (cp.getY(i) + 1.6) / 3.2)), pick: (t, k) => t.deep.clone().multiplyScalar(0.6).lerp(t.shallow.clone().multiplyScalar(0.7), k * k * k) });
    this.strip('water', W * 2, 0.04, 0.04, [0, y + 0.02, front + 0.01], 0.25);
    // A spent world: no sea, only a cracked bed of the same size.
    const bed = this.faceted(new THREE.PlaneGeometry(W * 2, D, 40, 12));
    bed.rotateX(-Math.PI / 2);
    bed.translate(0, 0, front - D / 2);
    const bp = bed.getAttribute('position');
    for (let i = 0; i < bp.count; i++) bp.setY(i, (this.rnd() - 0.5) * 0.25);
    bed.computeVertexNormals();
    const dryBed = new THREE.Mesh(bed, this.tonedMat((t) => t.rock));
    dryBed.position.y = y - 0.4;
    this.group.add(dryBed);
    this.dry.push(dryBed);
  }

  /* ── A dark band behind orbit and the sky ───────────────────────────── */
  /** The nebula dimmed behind the space and air decks, so pale hulls stand out from it. Far back,
   * behind every deck's dressing; it never covers a hull. */
  private shade() {
    const T = this.o.tierY, lo = T.land + 0.5, hi = T.space + 4.5;
    const mat = this.mat(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uLo: { value: lo }, uHi: { value: hi }, uAir: { value: T.air }, uSpace: { value: T.space } },
      vertexShader: /* glsl */ `varying float vY; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vY = w.y; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uLo, uHi, uAir, uSpace; varying float vY;
        void main() {
          float band = smoothstep(uLo, uLo + 3.0, vY) * smoothstep(uHi, uHi - 3.0, vY);
          // Darkest right behind each deck's hulls.
          float rows = exp(-pow((vY - uAir) / 2.6, 2.0)) + exp(-pow((vY - uSpace) / 2.6, 2.0));
          gl_FragColor = vec4(0.01, 0.015, 0.04, band * (0.28 + 0.3 * min(1.0, rows)));
        }`,
    }));
    const m = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(this.halfWidth * 9, hi - lo + 40)), mat);
    m.position.set(0, (lo + hi) / 2, -70);
    m.renderOrder = -1;
    this.group.add(m);
  }

  /* ── The barrier between the fleets ─────────────────────────────────── */
  private barrier() {
    const T = this.o.tierY, H = T.space - T.water + 9, yc = (T.space + T.water) / 2;
    const mat = this.mat(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: this.barrierU,
      vertexShader: /* glsl */ `varying vec2 vUv; varying float vY; void main(){ vUv = uv; vY = (modelMatrix * vec4(position, 1.0)).y; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; varying vec2 vUv; varying float vY;
        void main() {
          float x = (vUv.x - 0.5) * 2.0;
          float core = exp(-abs(x) * 26.0), glow = exp(-abs(x) * 5.0);
          float packets = pow(0.5 + 0.5 * sin(vY * 0.9 - uTime * 3.0), 14.0);
          vec3 side = mix(vec3(0.26, 0.80, 0.71), vec3(0.93, 0.42, 0.35), step(0.0, x));
          vec3 c = mix(vec3(1.0), side, 0.45) * core * (0.45 + packets * 0.6) + side * glow * (0.05 + packets * 0.12);
          float fade = smoothstep(0.0, 0.06, vUv.y) * smoothstep(1.0, 0.94, vUv.y);
          gl_FragColor = vec4(c * fade, 1.0);
        }`,
    }));
    const m = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(1.6, H)), mat);
    m.position.set(0, yc, 0.6);
    m.renderOrder = 4;
    this.group.add(m);
  }

  /* ── The API BattleSet drives ───────────────────────────────────────── */

  /** Recolour ground and sea for another world. */
  paint(palette: [number, number, number], spent: boolean) {
    const t = tones(palette, spent);
    for (const { attr, tint, far, pick } of this.paintables) {
      const per = attr.count === tint.length ? 1 : 3;
      for (let f = 0; f < tint.length; f++) {
        const c = pick(t, tint[f]);
        if (far) c.lerp(DUSK, far[f]);
        for (let j = 0; j < per; j++) attr.setXYZ(f * per + j, c.r, c.g, c.b);
      }
      attr.needsUpdate = true;
    }
    for (const { mat, pick, dusk } of this.toned) mat.color.copy(pick(t)).lerp(DUSK, dusk);
    this.seaU.uShallow.value.copy(t.shallow);
    this.seaU.uDeep.value.copy(t.deep);
    this.seaU.uFoam.value.copy(t.foam);
    this.seaU.uCalm.value = spent ? 0 : 1;
    for (const o of this.wet) o.visible = !spent;
    for (const o of this.dry) o.visible = spent;
  }

  /** The sea's height offset at a point (0 on a dead, dry world). */
  waveAt(x: number, z: number, t: number) { return waveHeight(x, z, t) * this.seaU.uCalm.value; }

  /** A battleground's strip flares when it fires (v from 0 to 1.5). */
  pulse(a: Ambit, v: number) {
    for (const { mat, base, k } of this.pulseMats[a]) mat.color.copy(base).multiplyScalar(k + v * 1.6);
  }

  update(dt: number, t: number) {
    this.seaU.uTime.value = t;
    this.barrierU.uTime.value = t;
    if (dt <= 0) return;
    for (const { mesh, items } of this.drift) {
      for (const it of items) {
        it.p.x += it.v * dt;
        if (it.p.x > it.W) it.p.x -= it.W * 2;
        it.r.x += it.w.x * dt; it.r.y += it.w.y * dt; it.r.z += it.w.z * dt;
      }
      this.place(mesh, items);
    }
  }

  dispose() {
    this.group.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.geos = []; this.mats = []; this.paintables = []; this.toned = []; this.drift = [];
  }
}
