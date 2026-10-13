/* A droid in the world: built once per PFP (shared geometry and textures, freed when nobody has
 * worn that PFP for a while), posed every frame. Walkers swing their legs in a gait their body
 * family picks, and whichever foot is lower stays on the floor; hover bodies bob and bank. Talking
 * nods the head and pulses the lit parts; stamps play an emote that blends in and out. On software
 * GL, far away, or past a crowd's full-detail count, the droid is its flat PFP bust on a sprite. */
import * as THREE from 'three';
import { droidSpec, pfpAttrs, HOVERS, AURA_COLOR, type DroidSpec, type PfpAttrs } from '../../data/droidParts';
import { buildDroidGeometry, skinnedDroid, type DroidRig, type BoneName } from './droid';
import { loadSkin, type LoadedSkin } from './skin';

export type Emote = 'wave' | 'bow' | 'cheer' | 'shrug' | 'point' | 'sit' | 'yes' | 'no';
export const EMOTES: Emote[] = ['wave', 'bow', 'cheer', 'shrug', 'point', 'sit', 'yes', 'no'];
const EMOTE_TIME: Record<Emote, number> = { wave: 2.2, bow: 1.8, cheer: 2.2, shrug: 1.8, point: 2.2, sit: 6, yes: 1.6, no: 1.6 };
const FADE_OUT = 0.35;

/* ── The shared builds: one per PFP, counted, the unused ones freed oldest first ── */

interface Built { geometry: THREE.BufferGeometry; skin: LoadedSkin; frame: ReturnType<typeof buildDroidGeometry>['frame']; bustTex: THREE.CanvasTexture }
interface Entry { p: Promise<Built>; refs: number }
const cache = new Map<string, Entry>();
const idle: string[] = [];
/** Builds kept with nobody wearing them (a Mirror session or a deck switch comes back to them). */
const KEEP_IDLE = 24;

function acquire(spec: DroidSpec): Promise<Built> {
  const key = spec.key;
  let e = cache.get(key);
  if (!e) {
    const entry: Entry = { refs: 0, p: loadSkin(spec).then((skin) => {
      const dg = buildDroidGeometry(spec, skin.skin);
      const bustTex = new THREE.CanvasTexture(skin.bust);
      bustTex.magFilter = THREE.NearestFilter; bustTex.minFilter = THREE.NearestFilter; bustTex.generateMipmaps = false;
      bustTex.colorSpace = THREE.SRGBColorSpace;
      return { geometry: dg.geometry, skin, frame: dg.frame, bustTex };
    }) };
    // A failure isn't kept: the next droid in this PFP tries again.
    entry.p.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
    cache.set(key, entry);
    e = entry;
  }
  e.refs++;
  const i = idle.indexOf(key);
  if (i >= 0) idle.splice(i, 1);
  return e.p;
}

function release(key: string) {
  const e = cache.get(key);
  if (!e) return;
  e.refs = Math.max(0, e.refs - 1);
  if (e.refs) return;
  idle.push(key);
  while (idle.length > KEEP_IDLE) {
    const k = idle.shift()!;
    const old = cache.get(k);
    if (!old || old.refs) continue;
    cache.delete(k);
    old.p.then((b) => { b.geometry.dispose(); b.skin.map.dispose(); b.skin.emissive.dispose(); b.bustTex.dispose(); }).catch(() => { /* never built */ });
  }
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

const mix = (a: number, b: number, k: number) => a + (b - a) * k;

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
  private held: string | null = null;
  private faded = false;

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
    const key = this.spec.key;
    let b: Built | null = null;
    try { b = await acquire(this.spec); } catch { b = null; }
    if (!b) return;
    if (this.disposed || my !== this.token) { release(key); return; }
    if (this.held) release(this.held);
    this.held = key;
    this.setSprite(b.bustTex);
    if (this.opts.lite) return;
    this.dropMesh();
    this.material = new THREE.MeshStandardMaterial({
      map: b.skin.map, emissiveMap: b.skin.emissive, emissive: 0xffffff, emissiveIntensity: 1.3,
      vertexColors: true, roughness: 0.5, metalness: 0.28, transparent: this.faded, opacity: this.faded ? 0.35 : 1,
    });
    const { mesh, rig } = skinnedDroid({ geometry: b.geometry, frame: b.frame, triangles: 0 }, this.material, this.spec.gait);
    this.mesh = mesh; this.rig = rig;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    if (this.sprite) this.sprite.visible = false;
  }

  /** The mesh, its material and its skeleton's bone texture go; the shared geometry stays. */
  private dropMesh() {
    if (this.mesh) { this.mesh.removeFromParent(); this.mesh.skeleton.dispose(); }
    this.material?.dispose();
    this.mesh = null; this.material = null;
  }

  private setSprite(tex: THREE.CanvasTexture) {
    if (!this.sprite) {
      this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
      this.sprite.scale.set(1.1, 1.1, 1);
      this.sprite.position.y = 1.15;
      this.group.add(this.sprite);
    } else (this.sprite.material as THREE.SpriteMaterial).map = tex;
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
      // Opaque and see-through compile differently: switch only when it changes.
      if (this.faded !== lit < 1) { this.faded = lit < 1; this.material.transparent = this.faded; this.material.needsUpdate = true; }
    } else this.faded = lit < 1;
    if (this.sprite?.visible) this.sprite.position.y = 1.15 + (this.hovers ? 0.25 + Math.sin(t * 2.2) * 0.05 : Math.abs(Math.sin(this.phase)) * 0.03);
    const r = this.rig;
    if (!r) { this.phase += dt * this.speed * 6; return; }
    const B = r.bones;
    for (const b of Object.keys(B) as BoneName[]) { B[b].rotation.set(0, 0, 0); B[b].position.copy(r.rest[b]); }

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
      const knee = g === 'reverse' ? -1 : 1;
      B.thighL.rotation.x = restT - s * amp * w;
      B.thighR.rotation.x = restT + s * amp * w;
      B.shinL.rotation.x = restS + Math.max(0, Math.sin(this.phase - 1.3)) * 0.9 * w * knee;
      B.shinR.rotation.x = restS + Math.max(0, -Math.sin(this.phase - 1.3)) * 0.9 * w * knee;
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

    // Emotes blend over the pose: in over 0.3 s, out over FADE_OUT (walking off cuts a sit short).
    const e = this.emote;
    if (e) {
      e.t += dt;
      const dur = EMOTE_TIME[e.name];
      if (e.name === 'sit' && w > 0.3) e.t = Math.max(e.t, dur - FADE_OUT);
      if (e.t >= dur) this.emote = null;
      else {
        const k = Math.min(1, e.t / 0.3, (dur - e.t) / FADE_OUT);
        const wob = Math.sin(t * 10);
        const set = (b: BoneName, axis: 'x' | 'y' | 'z', v: number) => { B[b].rotation[axis] = mix(B[b].rotation[axis], v, k); };
        switch (e.name) {
          case 'wave': set('armR', 'z', -2.5); set('foreR', 'z', wob * 0.45); break;
          case 'bow': set('torso', 'x', 0.55); set('head', 'x', 0.35); break;
          case 'cheer': set('armL', 'z', 2.6); set('armR', 'z', -2.6); B.root.position.y += Math.abs(Math.sin(t * 8)) * 0.08 * k; break;
          case 'shrug': set('armL', 'z', 0.5); set('armR', 'z', -0.5); set('foreL', 'x', -1.2); set('foreR', 'x', -1.2); set('head', 'z', 0.25); break;
          case 'point': set('armR', 'x', -1.5); set('foreR', 'x', 0); break;
          case 'sit':
            if (HOVERS(g)) B.root.position.y -= 0.22 * k;
            else { set('thighL', 'x', -1.4); set('thighR', 'x', -1.4); set('shinL', 'x', 1.4); set('shinR', 'x', 1.4); }
            break;
          case 'yes': set('head', 'x', Math.sin(t * 9) * 0.25); break;
          case 'no': B.head.rotation.y += Math.sin(t * 9) * 0.45 * k; break;
        }
      }
    }

    // Walkers: whichever foot reaches lower stands on the floor (this is the walk's bob, the
    // reverse knee's crouch and the sit's drop, all from the leg angles).
    const L = r.frame.legs;
    if (!HOVERS(g) && L) {
      const reach = (th: number, sh: number) => L.thigh * Math.cos(th) + L.shin * Math.cos(th + sh);
      const low = Math.max(reach(B.thighL.rotation.x, B.shinL.rotation.x), reach(B.thighR.rotation.x, B.shinR.rotation.x));
      B.root.position.y -= (L.thigh + L.shin) - low;
    }
  }

  dispose() {
    this.disposed = true;
    this.dropMesh();
    if (this.held) { release(this.held); this.held = null; }
    this.ringMat.dispose(); this.discMat.dispose();
    this.sprite?.material.dispose();
    this.group.removeFromParent();
  }
}
