/* A base for screens that are mostly panels (comms, intel, ops, forge): deep space behind
 * glass — a slow nebula and starfield, and for most screens a great dim world turning in one
 * corner, lit from off-frame so its night side and a thin bright limb do the talking. The
 * camera drifts a hand's breadth, so the world slides against the stars. A DOM root under
 * #ui, and tidy teardown. Subclasses build `root` in `mount()` and push unsubscribers onto
 * `cleanup`. */
import * as THREE from 'three';
import type { Engine, Screen } from '../core/engine';
import { h } from '../core/dom';
import { createNebulaSky, createStarfield, tickSpace } from '../gfx/space';
import { Planet } from '../gfx/planet';

/** A screen's backdrop world: where its centre sits (as a fraction of the half-frame, so phones
 * and wide screens frame it alike), its radius (in half-frame heights), and its look. */
interface Backdrop {
  at: [number, number];
  size: number;
  palette: [number, number, number];
  seed: number;
  spent?: boolean;
  atmosphere: number;
  /** How far round the sun stands from straight behind the world, toward the frame's middle:
   * 0 is a hairline ring of light, 1 a fat crescent. */
  phase: number;
  tilt?: [number, number];
}

/* One world per screen, each in the screen's own key: the market's dusty ochre desert, intel's
 * ice, comms' amethyst night side strung with city light, the forge's cracked lava world, ops'
 * temperate blue, the guild hall's green. The command deck keeps the sky to its own holo-globe. */
const BACKDROPS: Record<string, Backdrop | null> = {
  economy: { at: [-0.95, -1.05], size: 0.95, palette: [0x13203a, 0x6a5a48, 0xc09a62], seed: 4.7, atmosphere: 0xf5ad3d, phase: 0.75 },
  intel: { at: [1.0, 1.05], size: 0.9, palette: [0x1a2c48, 0x7894a8, 0xd8e4ec], seed: 2.3, atmosphere: 0x94a4e4, phase: 0.6 },
  comms: { at: [1.05, -1.0], size: 0.9, palette: [0x101a30, 0x3e3456, 0x7a6a9a], seed: 8.1, atmosphere: 0x9a7ae4, phase: 0.5 },
  forge: { at: [-1.0, -1.0], size: 0.9, palette: [0x1a0d12, 0x4a1e18, 0x8a3a20], seed: 6.6, spent: true, atmosphere: 0xee7d69, phase: 0.7 },
  ops: { at: [1.0, -1.05], size: 0.95, palette: [0x0d2140, 0x332b21, 0x6b5c47], seed: 1.4, atmosphere: 0x4f8fff, phase: 0.65 },
  guild: { at: [-1.05, -1.0], size: 0.9, palette: [0x062a3a, 0x1d4a3a, 0x5d7e5a], seed: 3.9, atmosphere: 0x43cdb6, phase: 0.6 },
  // The Academy's world is a bright, friendly one: sunlit gold over blue seas.
  academy: { at: [1.0, 1.0], size: 0.85, palette: [0x10294a, 0x3f6a8a, 0xe8c27a], seed: 5.2, atmosphere: 0xf3c878, phase: 0.75 },
  command: null,
};

/** How far the backdrop world sits from the camera. */
const WORLD_DIST = 220;

export abstract class PanelScreen implements Screen {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 3000);
  readonly bloom = { strength: 0.55, radius: 0.5, threshold: 0.5 };
  readonly streaks = 0.12;
  protected root!: HTMLElement;
  protected cleanup: (() => void)[] = [];
  private sky: THREE.Object3D[];
  private world: Planet | null = null;
  private look: Backdrop | null;
  private t = 0;

  constructor(protected engine: Engine, protected navigate: (hash: string) => void, private cls: string, seed = 3.3) {
    this.scene.background = new THREE.Color(0x04060a);
    this.sky = [createNebulaSky({ seed, intensity: 0.5 }), createStarfield(3500, 800, Math.floor(seed * 10))];
    for (const s of this.sky) this.scene.add(s);
    this.camera.position.set(0, 0, 1);
    this.look = BACKDROPS[cls] ?? null;
    if (this.look) {
      const b = this.look;
      this.world = new Planet({
        radius: 1, palette: b.palette, seed: b.seed, spent: b.spent, atmosphere: b.atmosphere,
        tilt: b.tilt ?? [-0.5, 0.35], detail: 512,
      });
      this.scene.add(this.world.group);
      this.placeWorld();
    }
  }

  /** Frame the world by the screen's shape: a corner of the frame, not the middle of it. */
  private placeWorld() {
    if (!this.world || !this.look) return;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const halfH = WORLD_DIST * tanV, halfW = halfH * this.camera.aspect;
    // A portrait phone has little width: keep the world's share of the short side.
    const r = this.look.size * Math.min(halfH, halfW * 1.15);
    const pos = this.world.group.position.set(this.look.at[0] * halfW, this.look.at[1] * halfH, 1 - WORLD_DIST);
    this.world.group.scale.setScalar(r);
    // The sun stands nearly behind the world as seen from here, leaned toward the frame's middle:
    // what shows of it is night side, cities and a bright limb facing in.
    const away = new THREE.Vector3(0, 0, 1).sub(pos).normalize().negate();
    const inward = new THREE.Vector3(-pos.x, -pos.y, 0).normalize();
    this.world.setSun(away.addScaledVector(inward, this.look.phase).add(new THREE.Vector3(0, 0.15, 0)).normalize());
  }

  enter(params: Record<string, string>): void | Promise<void> {
    this.root = h('div', { class: `screen panel-screen ${this.cls}` });
    document.getElementById('ui')!.appendChild(this.root);
    return this.mount(params);
  }

  /** Build the DOM into `this.root`. */
  protected abstract mount(params: Record<string, string>): void | Promise<void>;

  exit() {
    for (const f of this.cleanup.splice(0)) { try { f(); } catch (e) { console.error(e); } }
    this.unmount();
    this.root?.remove();
    // The backdrop's baked cubes go with the screen; the next visit repaints them.
    this.world?.release();
  }

  /** How far the camera drifts (1 = full; a screen with near objects of its own keeps it small). */
  protected drift = 1;

  protected unmount() { /* optional */ }

  update(dt: number, time: number) {
    this.t += dt;
    const c = this.camera;
    if (!this.engine.reduceMotion) {
      // A slow drift: a little travel (so the world slides over the stars) and a little turn.
      const k = this.drift;
      c.position.set(Math.sin(this.t * 0.021) * 4 * k, Math.cos(this.t * 0.016) * 1.6 * k, 1);
      c.rotation.set(Math.cos(this.t * 0.015) * 0.025 * k, Math.sin(this.t * 0.02) * 0.05 * k, 0);
    } else {
      // Reduced motion rests at the composed framing, not wherever the drift happened to be.
      c.position.set(0, 0, 1);
      c.rotation.set(0, 0, 0);
    }
    tickSpace(this.sky, time);
    this.world?.update(this.engine.reduceMotion ? 0 : dt, time);
    this.tick(dt, time);
  }

  protected tick(_dt: number, _time: number) { /* optional */ }

  resize(width: number, height: number) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.placeWorld();
  }
}
