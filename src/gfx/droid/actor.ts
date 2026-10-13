/* A droid in the world: built once per PFP (shared geometry and textures), posed every frame.
 * Walkers swing their legs in a gait their body family picks; hover bodies bob and bank. Talking
 * nods the head and pulses the lit parts; stamps play an emote. Until the layer images arrive (and
 * on software GL, or far away) the droid is its flat PFP bust on a sprite. */
import * as THREE from 'three';
import { droidSpec, pfpAttrs, HOVERS, AURA_COLOR, type DroidSpec, type PfpAttrs } from '../../data/droidParts';
import { buildDroidGeometry, skinnedDroid, type DroidRig, type BoneName } from './droid';
import { loadSkin, type LoadedSkin } from './skin';

export type Emote = 'wave' | 'bow' | 'cheer' | 'shrug' | 'point' | 'sit' | 'yes' | 'no';
export const EMOTES: Emote[] = ['wave', 'bow', 'cheer', 'shrug', 'point', 'sit', 'yes', 'no'];
const EMOTE_TIME: Record<Emote, number> = { wave: 2.2, bow: 1.8, cheer: 2.2, shrug: 1.8, point: 2.2, sit: 6, yes: 1.6, no: 1.6 };

interface Built { geometry: THREE.BufferGeometry; skin: LoadedSkin; frame: ReturnType<typeof buildDroidGeometry>['frame'] }
const built = new Map<string, Promise<Built>>();

/** Shared per PFP: the same droid twice builds once. */
export function buildFor(spec: DroidSpec): Promise<Built> {
  let p = built.get(spec.key);
  if (!p) {
    p = loadSkin(spec).then((skin) => {
      const dg = buildDroidGeometry(spec, skin.skin);
      return { geometry: dg.geometry, skin, frame: dg.frame };
    });
    built.set(spec.key, p);
  }
  return p;
}

const ringGeo = new THREE.RingGeometry(0.36, 0.46, 24);
ringGeo.rotateX(-Math.PI / 2);
const discGeo = new THREE.CircleGeometry(0.36, 24);
discGeo.rotateX(-Math.PI / 2);

export interface ActorOpts {
  /** Far-away/low-end: never build the 3D droid, keep the sprite. */
  lite?: boolean;
  seed?: string;
}

export class DroidActor {
  readonly group = new THREE.Group();
  spec: DroidSpec;
  mesh: THREE.SkinnedMesh | null = null;
  rig: DroidRig | null = null;
  private material: THREE.MeshStandardMaterial | null = null;
  private sprite: THREE.Sprite | null = null;
  private ring: THREE.Mesh;
  private disc: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private discMat: THREE.MeshBasicMaterial;
  private disposed = false;
  private token = 0;

  /** Ground speed this frame (m/s); the owner sets it. */
  speed = 0;
  /** How hard it is turning (rad/s), for hover banking. */
  turn = 0;
  /** 0..1, decays: set to 1 when a line is spoken. */
  talk = 0;
  /** Head yaw toward someone (radians, relative to the body), or null to idle. */
  look: number | null = null;
  dim = false;
  private emote: { name: Emote; t: number } | null = null;
  private phase = 0;
  private headYaw = 0;
  private readonly seedT: number;

  constructor(attrs: PfpAttrs | string | null | undefined, private opts: ActorOpts = {}) {
    this.spec = droidSpec(typeof attrs === 'object' && attrs && 'head' in attrs ? attrs as PfpAttrs : pfpAttrs(attrs as string, opts.seed));
    this.seedT = [...(opts.seed || this.spec.key)].reduce((a, c) => a + c.charCodeAt(0), 0) % 100;
    const aura = new THREE.Color(AURA_COLOR[this.spec.aura]);
    this.ringMat = new THREE.MeshBasicMaterial({ color: aura, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false });
    this.discMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
    this.ring = new THREE.Mesh(ringGeo, this.ringMat);
    this.disc = new THREE.Mesh(discGeo, this.discMat);
    this.ring.position.y = 0.012; this.disc.position.y = 0.01;
    this.ring.renderOrder = 1;
    this.group.add(this.disc, this.ring);
    void this.load();
  }

  get height() { return this.rig?.frame.height ?? 1.7; }
  get hovers() { return HOVERS(this.spec.gait); }

  /** Change the PFP (the builder, or a portrait update on chain). */
  setAttrs(attrs: PfpAttrs) {
    const spec = droidSpec(attrs);
    if (spec.key === this.spec.key) return;
    this.spec = spec;
    this.ringMat.color.set(AURA_COLOR[spec.aura]);
    void this.load();
  }

  play(e: Emote) { this.emote = { name: e, t: 0 }; }
  get emoting() { return this.emote?.name ?? null; }

  private async load() {
    const my = ++this.token;
    const b = await buildFor(this.spec).catch(() => null);
    if (this.disposed || my !== this.token || !b) return;
    this.setSprite(b.skin.bust);
    if (this.opts.lite) return;
    this.mesh?.removeFromParent();
    this.material?.dispose();
    this.material = new THREE.MeshStandardMaterial({
      map: b.skin.map, emissiveMap: b.skin.emissive, emissive: 0xffffff, emissiveIntensity: 1.3,
      vertexColors: true, roughness: 0.5, metalness: 0.28,
    });
    const { mesh, rig } = skinnedDroid({ geometry: b.geometry, frame: b.frame, triangles: 0 }, this.material, this.spec.gait);
    this.mesh = mesh; this.rig = rig;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    if (this.sprite) this.sprite.visible = false;
  }

  private setSprite(bust: HTMLCanvasElement) {
    if (!this.sprite) {
      const tex = new THREE.CanvasTexture(bust);
      tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
      this.sprite.scale.set(1.1, 1.1, 1);
      this.sprite.position.y = 1.15;
      this.group.add(this.sprite);
    } else {
      const m = this.sprite.material as THREE.SpriteMaterial;
      (m.map as THREE.CanvasTexture).image = bust;
      m.map!.needsUpdate = true;
    }
    this.sprite.visible = !this.mesh;
  }

  /** Far droids (or a crowd on a weak device) show the sprite instead of the mesh. */
  setFar(far: boolean) {
    if (!this.mesh) return;
    this.mesh.visible = !far;
    if (this.sprite) this.sprite.visible = far;
  }

  update(dt: number, t: number) {
    this.talk = Math.max(0, this.talk - dt * 0.35);
    const lit = this.dim ? 0.35 : 1;
    this.ringMat.opacity = (0.45 + this.talk * 0.5) * lit;
    if (this.sprite) (this.sprite.material as THREE.SpriteMaterial).opacity = lit;
    if (this.material) {
      this.material.emissiveIntensity = (1.1 + this.talk * 1.3 * (0.5 + 0.5 * Math.sin(t * 14))) * lit;
      this.material.opacity = lit;
      this.material.transparent = lit < 1;
    }
    if (this.sprite?.visible) this.sprite.position.y = 1.15 + (this.hovers ? 0.25 + Math.sin(t * 2.2) * 0.05 : Math.abs(Math.sin(this.phase)) * 0.03);
    const r = this.rig;
    if (!r) { this.phase += dt * this.speed * 6; return; }
    const B = r.bones;
    const reset = (b: BoneName) => { B[b].rotation.set(0, 0, 0); B[b].position.copy(r.rest[b]); };
    for (const b of Object.keys(B) as BoneName[]) reset(b);

    const w = Math.min(1, this.speed / 1.6);
    const g = r.gait;
    const stride = g === 'heavy' ? 0.75 : g === 'long' ? 1.15 : 0.95;
    this.phase += dt * (this.speed / stride) * Math.PI;
    const s = Math.sin(this.phase);

    if (HOVERS(g)) {
      B.root.position.y += 0.05 * Math.sin(t * 2.2 + this.seedT);
      B.torso.rotation.x = 0.14 * w;
      B.root.rotation.z = THREE.MathUtils.clamp(-this.turn * 0.18, -0.3, 0.3);
      B.armL.rotation.x = B.armR.rotation.x = 0.25 * w;
      B.foreL.rotation.x = B.foreR.rotation.x = -0.35;
    } else {
      const amp = g === 'heavy' ? 0.42 : g === 'long' ? 0.62 : 0.52;
      const restT = g === 'reverse' ? 0.38 : 0, restS = g === 'reverse' ? -0.7 : 0;
      B.thighL.rotation.x = restT - s * amp * w;
      B.thighR.rotation.x = restT + s * amp * w;
      B.shinL.rotation.x = restS + Math.max(0, Math.sin(this.phase - 1.3)) * 0.9 * w * (g === 'reverse' ? -1 : 1);
      B.shinR.rotation.x = restS + Math.max(0, -Math.sin(this.phase - 1.3)) * 0.9 * w * (g === 'reverse' ? -1 : 1);
      if (g === 'reverse') {
        const f = r.frame.legs!;
        B.root.position.y -= f.thigh * (1 - Math.cos(restT)) + f.shin * (1 - Math.cos(restT + restS));
      }
      B.root.position.y -= (1 - Math.abs(Math.cos(this.phase))) * (g === 'heavy' ? 0.05 : 0.035) * w;
      B.torso.rotation.y = s * 0.08 * w;
      B.torso.rotation.x = Math.sin(t * 1.3 + this.seedT) * 0.015 + 0.05 * w;
      B.armL.rotation.x = s * 0.5 * w;
      B.armR.rotation.x = -s * 0.5 * w;
      B.foreL.rotation.x = B.foreR.rotation.x = -0.2 - 0.25 * w;
    }
    B.armL.rotation.z = 0.08; B.armR.rotation.z = -0.08;

    // Head: toward whoever we're facing, else a slow look around.
    const want = this.look ?? Math.sin(t * 0.37 + this.seedT) * 0.3 * (1 - w);
    this.headYaw += (THREE.MathUtils.clamp(want, -1, 1) - this.headYaw) * Math.min(1, dt * 5);
    B.head.rotation.y = this.headYaw;
    B.head.rotation.x = Math.sin(t * 11 + this.seedT) * 0.07 * this.talk;

    // Emotes ride on top.
    const e = this.emote;
    if (e) {
      e.t += dt;
      const dur = EMOTE_TIME[e.name];
      if (e.t >= dur || (w > 0.3 && e.name === 'sit')) this.emote = null;
      else {
        const env = Math.min(1, e.t / 0.3, (dur - e.t) / 0.35);
        const k = Math.sin(t * 10);
        switch (e.name) {
          case 'wave': B.armR.rotation.z = -2.5 * env; B.foreR.rotation.z = k * 0.45 * env; break;
          case 'bow': B.torso.rotation.x = 0.55 * env; B.head.rotation.x = 0.35 * env; break;
          case 'cheer': B.armL.rotation.z = 2.6 * env; B.armR.rotation.z = -2.6 * env; B.root.position.y += Math.abs(Math.sin(t * 8)) * 0.08 * env; break;
          case 'shrug': B.armL.rotation.z = 0.5 * env; B.armR.rotation.z = -0.5 * env; B.foreL.rotation.x = B.foreR.rotation.x = -1.2 * env; B.head.rotation.z = 0.25 * env; break;
          case 'point': B.armR.rotation.x = -1.5 * env; B.foreR.rotation.x = 0; break;
          case 'sit':
            if (HOVERS(g)) B.root.position.y -= 0.22 * env;
            else { B.root.position.y -= 0.32 * env; B.thighL.rotation.x = B.thighR.rotation.x = -1.4 * env; B.shinL.rotation.x = B.shinR.rotation.x = 1.4 * env; }
            break;
          case 'yes': B.head.rotation.x = Math.sin(t * 9) * 0.25 * env; break;
          case 'no': B.head.rotation.y = Math.sin(t * 9) * 0.45 * env; break;
        }
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.material?.dispose();
    this.ringMat.dispose(); this.discMat.dispose();
    if (this.sprite) { (this.sprite.material as THREE.SpriteMaterial).map?.dispose(); this.sprite.material.dispose(); }
    this.group.removeFromParent();
  }
}
