/* The battle diorama's set: four battlegrounds stacked as a vertical slice of
 * a world — space on top, then air, land and water — above a planet's limb,
 * with an energy curtain between the fleets. The dressing of each tier lives
 * in scenery.ts; the world below is the shared planet renderer. */
import * as THREE from 'three';
import { AMBIT_COLOR, AMBITS, type Ambit } from '../../data/catalogue';
import { Planet } from '../../gfx/planet';
import { Scenery } from './scenery';

export const TIER_Y: Record<Ambit, number> = { space: 7.8, air: 2.6, land: -2.6, water: -7.8 };
export const TIER_H = 5.2;
export const HALF_WIDTH = 23;

/** The field's spacing. An upright phone is short of width, not height, and the regular deck
 * (Command Ships at ±19.4) leaves its hulls tiny there: the compact deck packs the same slots closer
 * (Command Ships at ±13.25, in a staggered line) so the camera frames it closer and every hull draws much bigger.
 * Battle sets `compact` from the viewport before each board build; only slotX reads it. */
export const FIELD = { compact: false };
/** A tall narrow view: an upright phone, or a window like one. Not the 640×480 TV. */
export const portraitField = () => window.innerWidth <= 760 && window.innerHeight > window.innerWidth * 1.2;
/** The half-width the camera must show for the deck in use (the flagships whole, with a margin). */
export const fieldHalfWidth = () => (FIELD.compact ? 16.4 : 22.5);

export function slotX(side: 'player' | 'enemy', slot: number, command: boolean): number {
  const x = FIELD.compact ? (command ? 13.25 : 2.4 + slot * 2.55) : command ? 19.4 : 4.4 + slot * 3.75;
  return side === 'player' ? -x : x;
}

/** The compact deck stands in a staggered line, the way a formation does: every other slot a step
 * back and a little higher, so neighbours can stand closer than their hulls are wide and still read
 * as two ships. (The regular deck stands in one line.) Returns [lift, depth]. */
export function slotStagger(slot: number, command: boolean): [number, number] {
  return FIELD.compact && !command && slot % 2 === 1 ? [0.45, -1.5] : [0, 0];
}

/* Each battleground's picture on a 24×24 grid (the DC kit's icons): a star, a cloud, a mountain, waves. */
const AMBIT_GLYPH: Record<Ambit, { d: string; fill: boolean }> = {
  space: { d: 'M12 2 L14.5 9.5 L22 12 L14.5 14.5 L12 22 L9.5 14.5 L2 12 L9.5 9.5 Z', fill: true },
  air: { d: 'M6 18 H18 C22 18 22 12 18 12 C18 7 12 6 11 10 C9 7.5 4.5 8.5 5.5 12 C2 12 2 18 6 18 Z', fill: true },
  land: { d: 'M1.5 20 L9 7 L13 13.5 L16 9.5 L22.5 20 Z', fill: true },
  water: { d: 'M2 9.5 C5 6.5 8 12.5 12 9.5 C16 6.5 19 12.5 22 9.5 M2 16 C5 13 8 19 12 16 C16 13 19 19 22 16', fill: false },
};

/** A battleground's icon as a glowing card in the set, in place of its name. */
export function ambitIconMesh(a: Ambit, color: string, height: number, opacity = 1) {
  const size = 96, c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = AMBIT_GLYPH[a];
  const path = new Path2D(g.d);
  ctx.scale(size / 24 * 0.8, size / 24 * 0.8);
  ctx.translate(3, 3);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 2.6;
  ctx.fillStyle = ctx.strokeStyle = color;
  ctx.shadowColor = color; ctx.shadowBlur = 6;
  if (g.fill) ctx.fill(path); else ctx.stroke(path);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false });
  return new THREE.Mesh(new THREE.PlaneGeometry(height, height), mat);
}

/** Worlds a battle can be fought over: sea, lowland, highland. */
export const WORLD_PALETTES: [number, number, number][] = [
  [0x0d2140, 0x332b21, 0x6b5c47],   // temperate
  [0x062a3a, 0x1d4a3a, 0x5d7e5a],   // jungle
  [0x13203a, 0x6a5a48, 0xb3a38c],   // desert
  [0x1a2c48, 0x7894a8, 0xd8e4ec],   // ice
  [0x1a0d12, 0x4a1e18, 0x8a3a20],   // volcanic
  [0x101a30, 0x3e3456, 0x7a6a9a],   // amethyst
];

export interface SetOptions {
  halfWidth?: number;
  /** Colours of the world below: sea, lowland, highland. */
  palette?: [number, number, number];
  seed?: number;
  /** A spent world: no oceans, cracked and dark. */
  spent?: boolean;
}

/** Where the sun is (world direction toward it): behind the board, up and to the left. The planet's
 * terminator, the sea's glint and the screens' backlight all agree on it. */
export const SUN_DIR = new THREE.Vector3(-0.55, 0.45, -0.7).normalize();

/** The shared light rig for the diorama screens: a warm key from the front left so the hulls'
 * faces read, the sun behind them as a hot rim, a cool fill from the right, and a dim sky. */
export function addBattleLights(scene: THREE.Scene) {
  scene.background = new THREE.Color(0x05070b);
  scene.add(new THREE.HemisphereLight(0x8ea4d6, 0x2b1f1c, 0.85));
  const key = new THREE.DirectionalLight(0xffe2c4, 2.1);
  key.position.set(-14, 18, 30);
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
  sun.position.copy(SUN_DIR).multiplyScalar(40);
  const fill = new THREE.DirectionalLight(0x6f8dff, 1.1);
  fill.position.set(18, 3, -12);
  scene.add(key, sun, fill);
}

export class BattleSet {
  readonly group = new THREE.Group();
  readonly halfWidth: number;
  private scenery: Scenery;
  private world: Planet;
  private pulses: Record<Ambit, number> = { space: 0, air: 0, land: 0, water: 0 };

  constructor(opts: SetOptions = {}) {
    const HALF_WIDTH = this.halfWidth = opts.halfWidth ?? 23;
    const palette = opts.palette ?? [0x0d2140, 0x332b21, 0x6b5c47];
    this.scenery = new Scenery({ halfWidth: HALF_WIDTH, tierY: TIER_Y, palette, seed: opts.seed ?? 0, spent: !!opts.spent });
    this.group.add(this.scenery.group);
    // Each battleground's icon at both ends of its deck (its name is the tooltip on its chips).
    for (const a of AMBITS) {
      const hexCol = '#' + new THREE.Color(AMBIT_COLOR[a]).getHexString();
      for (const side of [-1, 1]) {
        const label = ambitIconMesh(a, hexCol, 2.1, 0.95);
        const g = label.geometry as THREE.PlaneGeometry;
        g.translate(-side * g.parameters.width / 2, 0, 0);
        label.position.set(side * (HALF_WIDTH - 0.4), TIER_Y[a] - 1.55, 2.9);
        label.rotation.x = -0.35;
        label.renderOrder = 5;
        this.group.add(label);
      }
    }

    // A planet's limb far below: the battle is fought over someone's world.
    this.world = new Planet({ radius: 260, palette, seed: opts.seed ?? 0, spent: opts.spent, sun: SUN_DIR });
    this.world.group.position.set(0, -335, -270);
    this.group.add(this.world.group);
  }

  dispose() {
    // The planet frees its own (baked) resources; the rest is ours.
    this.group.remove(this.world.group);
    this.world.dispose();
    this.scenery.dispose();
    this.group.remove(this.scenery.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) { const mm = mat as THREE.MeshBasicMaterial; mm.map?.dispose(); mat.dispose(); }
    });
  }

  /** Repaint the world below: palette, terrain seed, spent or alive. */
  setWorld(opts: { palette: [number, number, number]; seed: number; spent?: boolean }) {
    this.world.setWorld(opts);
    this.scenery.paint(opts.palette, !!opts.spent);
  }

  /** The sea's swell at a point (for hulls riding it). */
  waveAt(x: number, z: number, t: number) { return this.scenery.waveAt(x, z, t); }

  pulse(a: Ambit, amount = 1) { this.pulses[a] = Math.min(1.5, this.pulses[a] + amount); }

  update(dt: number, t: number) {
    for (const a of AMBITS) {
      this.pulses[a] *= Math.exp(-dt * 3);
      this.scenery.pulse(a, this.pulses[a]);
    }
    this.scenery.update(dt, t);
    this.world.update(dt, t);
  }
}
