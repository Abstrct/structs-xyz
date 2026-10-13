/* The battle board in 3D: one extruded pixel model per struct, standing in
 * its battleground slot, and an animation queue that replays each block's
 * chain events — the shot rows exactly as structsd emits them — as
 * missiles, shells, blocks, evasions, counter-fire and destruction. */
import * as THREE from 'three';
import { h } from '../../core/dom';
import { audio } from '../../core/audio';
import { LOOK } from '../../core/engine';
import { easeInOutCubic, easeOutBack, easeOutCubic } from '../../core/util';
import { type Ambit, AMBIT_COLOR, COMMAND_SHIP_ID, TYPES_BY_ID } from '../../data/catalogue';
import { Effects } from '../../gfx/fx';
import { getHullModel, hullFxMaterial, hullOutline, setOutline, type HullModel, type HullUniforms } from '../../gfx/hull/model';
import { BattleSet, compactBoost, FIELD, type SetOptions, slotStagger, slotX } from './env';
import type { AttackDetail, Block, Chain, ChainEvent, ShotRow, SimStruct } from '../../sim/chain';

export type SideV = 'player' | 'enemy';
/** The battle deck's own slots (the planet and archive screens lay theirs out differently). */
const fieldX = (side: SideV, slot: number, command: boolean) => slotX(side, slot, command);
const TEAM: Record<SideV, number> = { player: 0x43cdb6, enemy: 0xee7d69 };
const UNIT_SCALE = 0.82;
/** Light each battleground bounces up into the hulls above it (linear). */
const BOUNCE: Record<Ambit, THREE.Color> = {
  space: new THREE.Color(0.08, 0.12, 0.28),
  air: new THREE.Color(0.32, 0.34, 0.42),
  land: new THREE.Color(0.46, 0.3, 0.14),
  water: new THREE.Color(0.05, 0.22, 0.5),
};

/* The pad under a hull, one quad: a contact shadow (alpha darkens what is
 * below), a segmented team ring and halo (colour adds), a light pool under
 * hovering hulls, foam where a hull sits in the sea, selection brackets and
 * a target reticle. Premultiplied blending does both in one draw. */
function padMaterial(color: number) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uSpin: { value: 0 }, uOpacity: { value: 0.5 },
      uShadow: { value: 0 }, uPool: { value: 0 }, uFoam: { value: 0 }, uSel: { value: 0 }, uTarget: { value: 0 }, uAspect: { value: 1 },
    },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uTime, uSpin, uOpacity, uShadow, uPool, uFoam, uSel, uTarget, uAspect;
      varying vec2 vUv;
      float band(float r, float at, float w, float px) { return 1.0 - smoothstep(0.0, max(px * 1.4, 0.004), abs(r - at) - w); }
      float h21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p), px = fwidth(r);
        float ang = atan(p.y, p.x) / 6.2831853 + 0.5;
        // Contact shadow and the light pool under hovering hulls.
        float shadow = exp(-r * r * 3.0) * uShadow;
        float pool = exp(-r * r * 4.5) * uPool;
        // Segmented ring with a soft halo, a thin inner ring.
        float seg = step(0.18, fract(ang * 16.0 + uSpin));
        float ring = band(r, 0.8, 0.018, px) * seg;
        float halo = exp(-abs(r - 0.8) * 10.0) * 0.28;
        float inner = band(r, 0.66, 0.004, px) * 0.45;
        // Selection: an outer ring of four brackets turning the other way.
        float brk = band(r, 0.93, 0.014, px) * step(0.62, fract(ang * 4.0 - uSpin * 0.5)) * uSel;
        // Target: four ticks closing in, pulsing.
        float pulse = 0.5 + 0.5 * sin(uTime * 7.0);
        float tgtR = 0.95 - pulse * 0.07;
        float tick = band(r, tgtR, 0.02, px) * step(0.85, fract(ang * 4.0 + 0.125 + 0.075)) * uTarget;
        // Foam: a broken white collar where the hull meets the sea.
        float fn = h21(floor(vec2(ang * 48.0 + uTime * 0.6, 0.0)));
        float foam = band(r, 0.5 + fn * 0.06, 0.05 + 0.03 * sin(uTime * 2.0 + ang * 40.0), px) * (0.4 + 0.6 * fn) * uFoam;
        foam += exp(-abs(r - 0.52) * 7.0) * 0.18 * uFoam;
        vec3 c = uColor * ((ring * 1.25 + halo + inner + brk * 1.4 + tick * 1.6) * uOpacity + pool * 0.6);
        c += vec3(0.85, 0.93, 1.0) * foam;
        gl_FragColor = vec4(c, shadow * 0.62);
      }`,
  });
}

/* A target mark: four corner brackets that breathe, facing the camera, over every ship the armed
 * weapon can hit. The red floor ring alone read as a 2 px smear seen edge-on; this reads from any
 * angle. A dark keyline under the red keeps it legible over sky, cloud, rock and sea. */
function markMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; varying vec2 vUv;
      float bracket(vec2 q, float at, float w, float len) {
        float bx = step(abs(q.x - at), w) * step(at - len, q.y) * step(q.y, at + w);
        float by = step(abs(q.y - at), w) * step(at - len, q.x) * step(q.x, at + w);
        return min(bx + by, 1.0);
      }
      void main() {
        vec2 q = abs((vUv - 0.5) * 2.0);
        float breathe = 0.5 + 0.5 * sin(uTime * 6.0);
        float at = 0.84 - 0.08 * breathe;
        float core = bracket(q, at, 0.045, 0.34);
        float line = bracket(q, at, 0.09, 0.38);
        if (line < 0.5) discard;
        // Linear light: these come out as the kit's hot red (#FF3D2E) breathing toward orange.
        vec3 red = mix(vec3(1.0, 0.046, 0.027), vec3(1.0, 0.25, 0.06), breathe * 0.6);
        gl_FragColor = vec4(mix(vec3(0.05, 0.02, 0.12), red, core), core > 0.5 ? 1.0 : 0.7);
      }`,
  });
}

/* The lock-on reticle: a turning segmented ring, four brackets closing in, a pip at the heart. */
function reticleMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(1.5, 0.3, 0.22) } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
      float band(float r, float at, float w, float px) { return 1.0 - smoothstep(0.0, max(px * 1.4, 0.004), abs(r - at) - w); }
      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p), px = fwidth(r);
        float ang = atan(p.y, p.x) / 6.2831853 + 0.5;
        float ring = band(r, 0.62, 0.012, px) * step(0.3, fract(ang * 12.0 + uTime * 0.35));
        float close = 0.86 - 0.08 * (0.5 + 0.5 * sin(uTime * 10.0));
        vec2 q = abs(p);
        float brk = (step(abs(q.x - close), 0.025) * step(close - 0.22, q.y) * step(q.y, close)
                   + step(abs(q.y - close), 0.025) * step(close - 0.22, q.x) * step(q.x, close));
        float pip = smoothstep(0.07, 0.03, r);
        float cross = (step(q.x, 0.012) + step(q.y, 0.012)) * step(0.3, r) * step(r, 0.45);
        float glow = exp(-abs(r - 0.62) * 14.0) * 0.25;
        float a = ring + min(brk, 1.0) * 1.2 + pip + cross * 0.8 + glow;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
  });
}

/** Depth only, drawn just before a see-through hull's colour (same queue, same object). */
const PREPASS = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true });

/* ── Tweens on the view clock (pauses and time-scales with the board) ───── */
interface Tween { t: number; dur: number; fn: (k: number) => void; ease: (k: number) => number; resolve: () => void }

export class UnitView {
  readonly root = new THREE.Group();
  readonly pivot = new THREE.Group();
  readonly typeId: number;
  readonly command: boolean;
  mesh!: THREE.Mesh;
  material!: THREE.MeshStandardMaterial;
  base!: HullModel;
  dmg!: HullModel;
  /** The pad under the hull: shadow, team ring, selection and target marks. */
  ring!: THREE.Mesh;
  ringMat!: THREE.ShaderMaterial;
  private px!: HullUniforms;
  private cloak = 0;
  private holo = 0;
  /** False until the first frame: stealth and construction start at their state instead of easing in. */
  private primed = false;
  /** The sea's swell, when the board has one (hulls in the water ride it). */
  sea: ((x: number, z: number, t: number) => number) | null = null;
  pick!: THREE.Mesh;
  tag!: HTMLDivElement;
  pips!: HTMLDivElement;
  badges!: HTMLSpanElement;
  health: number;
  maxHealth: number;
  hidden = false;
  online = true;
  destroyed = false;
  ambit: Ambit;
  slot: number;
  hover = 0; selected = false; targetable = false; dimmed = false;
  /** Which column the struct stands in: a fleet slot or a planetary slot. */
  column: 'fleet' | 'planet' = 'fleet';
  /** Under construction: drawn as a hologram. */
  building = false;
  exhaust = Math.random() * 0.1;
  flash = 0;
  private bobSeed = Math.random() * 100;
  private damagedShown = false;
  /** The dark keyline round the hull (a child of `mesh`: it hides with it, and never takes a pick). */
  private outline: THREE.Mesh | null = null;

  constructor(readonly id: string, readonly side: SideV, s: SimStruct) {
    this.typeId = s.typeId;
    this.command = s.typeId === COMMAND_SHIP_ID;
    this.ambit = s.ambit;
    this.slot = s.slot;
    this.health = s.health;
    this.maxHealth = TYPES_BY_ID[s.typeId].maxHealth;
    this.root.add(this.pivot);
  }

  async load() {
    const faction = this.side === 'player' ? 'player' : 'enemy';
    this.base = getHullModel(this.typeId, faction, 'base');
    this.dmg = getHullModel(this.typeId, faction, 'dmg');
    this.material = hullFxMaterial(this.base);
    this.px = this.material.userData.hull as HullUniforms;
    this.px.uBounce.value.copy(BOUNCE[this.ambit]);
    this.bounceNow.copy(BOUNCE[this.ambit]);
    this.mesh = new THREE.Mesh(this.base.geometry, this.material);
    this.k = (this.command ? UNIT_SCALE * 1.15 : UNIT_SCALE) * this.boost;
    const k = this.k;
    this.mesh.scale.setScalar(k);
    if (this.side === 'enemy') this.mesh.scale.x *= -1;
    this.pivot.add(this.mesh);
    this.outline = hullOutline(this.base);
    this.outline.raycast = () => {};
    this.mesh.add(this.outline);
    // The pad under the hull, sized to its footprint.
    this.ringMat = padMaterial(TEAM[this.side]);
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = -this.base.height * k * 0.5 - 0.05;
    this.padSize = Math.max(2.9, this.base.padWidth * k * 1.2);
    this.ring.scale.set(this.padSize, 2.4, 1);
    this.root.add(this.ring);
    // Generous pick volume.
    this.pick = new THREE.Mesh(new THREE.BoxGeometry(this.base.width * k + 0.4, this.base.height * k + 0.6, 2.4), new THREE.MeshBasicMaterial({ visible: false }));
    this.pick.userData.unit = this;
    this.pivot.add(this.pick);
    // DOM tag: health pips.
    this.pips = h('div', { class: 'pips' });
    this.badges = h('span', { class: 'badges' });
    this.tag = h('div', { class: 'unit-tag ' + this.side, style: 'visibility:hidden' }, this.badges, this.pips);
    // Hulls that start wounded (gauntlet carry-over, live planets) wear their damage art.
    this.setHealth(this.health);
  }

  /** Hull size, fixed when the hull is made. On the compact deck (an upright phone, env.ts FIELD) every
   * hull draws a little bigger: BattleView.build raises the boost for the hulls it makes, then puts it
   * back, so the archive's and the planet's own hulls never inherit it. */
  static boost = 1;
  private readonly boost = UnitView.boost;
  private k = UNIT_SCALE;
  get scale() { return this.k; }
  get halfHeight() { return this.base.height * this.scale * 0.5; }
  get halfWidth() { return this.base.width * this.scale * 0.5; }
  get facing() { return this.side === 'player' ? 1 : -1; }

  renderPips() {
    this.pips.replaceChildren(...Array.from({ length: this.maxHealth }, (_, i) => h('i', { class: i < this.health ? '' : 'lost' })));
    this.tag.classList.toggle('hidden-unit', this.hidden);
    this.tag.classList.toggle('cmd', this.command);
  }

  setHealth(hp: number) {
    this.health = Math.max(0, hp);
    const damaged = this.health > 0 && this.health < this.maxHealth;
    if (damaged !== this.damagedShown && this.mesh) {
      this.damagedShown = damaged;
      const m = damaged ? this.dmg : this.base;
      this.mesh.geometry = m.geometry;
      this.material.map = m.map;
      this.material.emissiveMap = m.emissiveMap;
      this.material.needsUpdate = true;
    }
    this.renderPips();
  }

  setHidden(on: boolean) { this.hidden = on; this.renderPips(); }

  /** ◆ this hull guards an ally; +N this hull is guarded by N. */
  setBadges(guarding: boolean, guardedBy: number) {
    const key = `${guarding}|${guardedBy}`;
    if (this.badges.dataset.k === key) return;
    this.badges.dataset.k = key;
    this.badges.replaceChildren(
      ...(guarding ? [h('i', { class: 'b-guard', title: 'Guarding an ally' }, '◆')] : []),
      ...(guardedBy ? [h('i', { class: 'b-shield', title: `Guarded by ${guardedBy}` }, '+' + guardedBy)] : []),
    );
  }

  dispose() {
    this.tag.remove();
    (this.outline?.material as THREE.Material | undefined)?.dispose();
    this.material?.dispose();
    this.ring?.geometry.dispose(); this.ringMat?.dispose();
    if (this.pick) { this.pick.geometry.dispose(); (this.pick.material as THREE.Material).dispose(); }
  }

  /** World position of the hull's centre. */
  center(out = new THREE.Vector3()) { return this.mesh.getWorldPosition(out); }
  muzzle(out = new THREE.Vector3()) {
    this.center(out);
    out.x += this.facing * this.halfWidth * 0.85;
    out.y += this.halfHeight * 0.15;
    return out;
  }

  private padSize = 3;
  private bounceNow = new THREE.Color();

  update(dt: number, t: number) {
    if (!this.mesh) return;
    // Idle motion by battleground: drift in orbit, bank in the air, ride the swell at sea.
    const s = this.bobSeed, p = this.pivot;
    if (this.ambit === 'space') {
      p.position.y = Math.sin(t * 0.7 + s) * 0.12;
      p.rotation.set(0, Math.sin(t * 0.23 + s) * 0.07, Math.sin(t * 0.4 + s) * 0.03);
    } else if (this.ambit === 'air') {
      p.position.y = Math.sin(t * 1.3 + s) * 0.18;
      p.rotation.set(Math.cos(t * 1.3 + s) * 0.025, Math.sin(t * 0.31 + s) * 0.06, Math.sin(t * 0.9 + s) * 0.05);
    } else if (this.ambit === 'water') {
      const x = this.root.position.x, z = this.root.position.z;
      if (this.sea) {
        const h = this.sea(x, z, t), slope = (this.sea(x + 0.6, z, t) - this.sea(x - 0.6, z, t)) / 1.2;
        p.position.y = h * 0.85;
        p.rotation.set(0, 0, Math.atan(slope) * 0.6 + Math.sin(t * 0.8 + s) * 0.012);
      } else {
        p.position.y = Math.sin(t * 1.1 + s) * 0.06;
        p.rotation.set(0, 0, Math.sin(t * 0.8 + s) * 0.035);
      }
    } else { p.position.y = 0; p.rotation.set(0, 0, 0); }

    this.flash = Math.max(0, this.flash - dt * 3.5);
    const m = this.material, u = this.px;
    // Lights: hover warms them, selection breathes, an offline hull's go dim.
    m.emissiveIntensity = (this.online ? 1.6 : 0.3) + this.hover * 0.6 + (this.selected ? 0.4 + Math.sin(t * 6) * 0.3 : 0);
    u.uFlash.value = this.flash;
    u.uRimStrength.value = (this.dimmed ? 0.35 : 1) * (1 + this.hover * 0.6 + (this.selected ? 0.5 : 0));
    this.bounceNow.lerp(BOUNCE[this.ambit], Math.min(1, dt * 4));
    u.uBounce.value.copy(this.bounceNow);
    // Stealth and construction are shader states that ease in and out.
    const k = this.primed ? Math.min(1, dt * 5) : 1;
    this.primed = true;
    this.cloak += ((this.hidden ? 1 : 0) - this.cloak) * k;
    this.holo += ((this.building ? 1 : 0) - this.holo) * k;
    u.uCloak.value = this.cloak; u.uHolo.value = this.holo;
    const a = (this.dimmed ? 0.4 : 1) * (this.online ? 1 : 0.85);
    const transparent = a < 0.99 || this.cloak > 0.01 || this.holo > 0.01;
    // OPAQUE is compiled into the program: switching it needs a (cached) program swap. A see-through
    // hull lays down its depth first (the geometry's first group), so only its nearest surface
    // shows: wings never show through the fuselage.
    if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; this.mesh.material = transparent ? [PREPASS, m] : m; }
    // The keyline fades with the hull, and goes while it's cloaked or a hologram.
    if (this.outline) setOutline(this.outline, a * (1 - this.cloak) * (1 - this.holo));
    m.opacity = a;
    // Opacity scales alpha before the alpha test; scale the test with it.
    m.alphaTest = Math.min(0.5, a * 0.5);
    m.color.setScalar(this.online ? 1 : 0.55);

    // The pad: where the hull meets its battleground.
    const hh = this.halfHeight, ring = this.ring, pu = this.ringMat.uniforms;
    const water = this.ambit === 'water', land = this.ambit === 'land', aloft = !water && !land;
    ring.position.y = land ? -hh + 0.03 : water ? -hh * 0.55 + 0.02 + (this.sea ? this.sea(this.root.position.x, this.root.position.z, t) * 0.85 : 0) : -hh - 0.3 + p.position.y * 0.4;
    ring.renderOrder = water ? 3 : 0;
    const veil = 1 - this.cloak * 0.75;
    pu.uShadow.value = (land ? 0.9 : water ? 0.35 : 0) * veil * (this.dimmed ? 0.5 : 1);
    pu.uPool.value = aloft ? (0.35 + this.hover * 0.4) * veil : 0;
    pu.uFoam.value = water && !this.hidden ? 0.85 : 0;
    pu.uTime.value = t;
    // Ring: team colour; selected brightens; targetable pulses red.
    pu.uSel.value = this.selected ? 1 : 0;
    pu.uTarget.value = this.targetable ? 1 : 0;
    const col = pu.uColor.value as THREE.Color;
    if (this.targetable) { col.set(0xff5a4a); pu.uOpacity.value = 0.75 + 0.25 * Math.sin(t * 7); }
    else if (this.selected) { col.set(0x9ff5e6); pu.uOpacity.value = 1.2; }
    else { col.set(TEAM[this.side]); pu.uOpacity.value = ((this.dimmed ? 0.18 : 0.5) + this.hover * 0.6) * veil; }
    pu.uSpin.value += dt * (this.selected ? 0.5 : 0.08);
    ring.scale.set(this.padSize * (this.targetable ? 1.08 : 1), 2.4, 1);
  }
}

/* ── Floaters (DOM numbers and words over the board) ────────────────────── */
/** A floater's centre x, kept so the whole word stays on screen (8 px from either edge). */
const clampX = (x: number, half: number) => Math.min(window.innerWidth - half - 8, Math.max(half + 8, x));
interface Floater { el: HTMLElement; pos: THREE.Vector3; age: number; life: number; rise: number; half?: number; halfH?: number; under?: Floater; minY?: number }

export class BattleView {
  readonly group = new THREE.Group();
  readonly set: BattleSet;
  readonly fx = new Effects();
  /** Column x for a unit; the planet view swaps in its wider map. */
  xFor: (side: SideV, slot: number, command: boolean, column: 'fleet' | 'planet') => number = fieldX;
  units = new Map<string, UnitView>();
  private tweens: Tween[] = [];
  private floaters: Floater[] = [];
  /** Screen y the floating words keep below (the battle screen's HUD cards; 0: none). */
  floorY = 0;
  /** Screen y the floating words keep above (the action bar's top; 0: none). */
  ceilY = 0;
  private queue: (() => Promise<void>)[] = [];
  private running = false;
  private tethers = new Map<string, { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; from: string; to: string; t: number; dying: boolean }>();
  private fading = new Set<{ mesh: THREE.Mesh; mat: THREE.ShaderMaterial }>();
  timeScale = 1;
  paused = false;
  private tmp = new THREE.Vector3();
  /** Called with a world point the camera might lean toward. */
  onFocus: (p: THREE.Vector3, weight: number) => void = () => {};
  onShake: (amount: number) => void = () => {};
  onFlash: (amount: number, color: number) => void = () => {};
  onCommandDestroyed: (side: SideV) => void = () => {};
  /** A moment worth the camera's full attention (flagship kills). */
  onCinematic: (p: THREE.Vector3) => void = () => {};
  private slowmo = 0;
  /** Smouldering wrecks: a destroyed struct holds its slot for the chain's 5-block sweep. */
  private wrecks: { pos: THREE.Vector3; left: number; acc: number; big: boolean }[] = [];
  reduceMotion = false;

  constructor(private camera: THREE.PerspectiveCamera, private layer: HTMLElement, setOpts?: SetOptions) {
    this.set = new BattleSet(setOpts);
    this.group.add(this.set.group);
    this.fx.scale = 1.45;
    this.group.add(this.fx.group);
  }

  get busy() { return this.running || this.queue.length > 0; }

  private seaAt = (x: number, z: number, t: number) => this.set.waveAt(x, z, t);

  sideOf(owner: string, you: string): SideV { return owner === you ? 'player' : 'enemy'; }

  slotPosition(side: SideV, ambit: Ambit, slot: number, command: boolean, halfHeight: number, column: 'fleet' | 'planet' = 'fleet') {
    const x = this.xFor(side, slot, command, column);
    const T = this.set.tiers;
    let y = T[ambit] - 0.2;
    if (ambit === 'land') y = T.land - 1.85 + halfHeight;
    if (ambit === 'water') y = T.water - 1.75 + halfHeight * 0.55;
    // The compact deck's staggered line (env.ts): every other slot a step back and up. When the decks
    // stand further apart (a phone's fight), the step aloft grows with them, a rank to each half-deck.
    const [lift0, depth] = this.xFor === fieldX ? slotStagger(slot, command, ambit) : [0, 0];
    const k = Math.min(this.set.stretch, 1.7);
    const lift = ambit === 'space' || ambit === 'air' ? lift0 * k * k : lift0;
    // Command Ships sit a little back so they read as the flagship.
    return new THREE.Vector3(x, y + lift, (command ? -0.6 : 0) + depth);
  }

  private buildGen = 0;
  /** Build the board from a chain. A newer build supersedes an older one
   * still loading; the loser's units are disposed, never shown. */
  async build(chain: Chain, you: string) {
    const g = ++this.buildGen;
    this.clear();
    const list = Object.values(chain.structs);
    // The compact deck (an upright phone) draws its hulls a little bigger too: its slots have the room.
    const compact = this.xFor === fieldX && FIELD.compact;
    const views = list.map((s) => { UnitView.boost = compact ? compactBoost(s.ambit) : 1; return new UnitView(s.id, this.sideOf(s.owner, you), s); });
    UnitView.boost = 1;
    await Promise.all(views.map((v) => v.load()));
    if (g !== this.buildGen) { views.forEach((v) => v.dispose()); return false; }
    for (const v of views) {
      this.units.set(v.id, v);
      v.sea = this.seaAt;
      v.root.position.copy(this.slotPosition(v.side, v.ambit, v.slot, v.command, v.halfHeight, v.column));
      this.group.add(v.root);
      this.layer.appendChild(v.tag);
    }
    this.syncTethers(chain);
    return true;
  }

  /* ── Sensors: an order seen in the mempool, drawn until its block lands ─ */
  private intent: { line: THREE.Line; reticle: THREE.Mesh; mat: THREE.LineDashedMaterial; rmat: THREE.ShaderMaterial } | null = null;
  /** Target marks over the ships the armed weapon can hit (one shared material and quad). */
  private marks = new Map<string, THREE.Mesh>();
  private markMat: THREE.ShaderMaterial | null = null;
  private markGeo: THREE.PlaneGeometry | null = null;
  showIntent(attackerId: string, targetId: string) {
    this.clearIntent();
    const a = this.units.get(attackerId), b = this.units.get(targetId);
    if (!a || !b || a.destroyed || b.destroyed) return;
    const from = a.muzzle(), to = b.center();
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const mat = new THREE.LineDashedMaterial({ color: new THREE.Color(1.6, 0.42, 0.32), dashSize: 0.5, gapSize: 0.35, transparent: true, opacity: 0.9, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    const rmat = reticleMaterial();
    const reticle = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), rmat);
    reticle.position.copy(to);
    this.group.add(line, reticle);
    this.intent = { line, reticle, mat, rmat };
    this.floater(this.above(b), 'LOCK-ON', 'warn');
  }
  clearIntent() {
    if (!this.intent) return;
    this.group.remove(this.intent.line, this.intent.reticle);
    this.intent.line.geometry.dispose(); this.intent.mat.dispose();
    this.intent.reticle.geometry.dispose(); this.intent.rmat.dispose();
    this.intent = null;
  }

  /** Place prepared units (the planet view builds these from LCD data). */
  async addUnits(views: UnitView[]) {
    const g = this.buildGen;
    await Promise.all(views.map((v) => v.load()));
    if (g !== this.buildGen) { views.forEach((v) => v.dispose()); return; }
    for (const v of views) {
      if (this.units.has(v.id)) { v.dispose(); continue; }
      this.units.set(v.id, v);
      v.sea = this.seaAt;
      v.root.position.copy(this.slotPosition(v.side, v.ambit, v.slot, v.command, v.halfHeight, v.column));
      this.group.add(v.root);
      this.layer.appendChild(v.tag);
    }
  }

  /** Tethers from explicit pairs (defender → protected). */
  setTethers(pairs: { from: string; to: string }[]) {
    for (const k of [...this.tethers.keys()]) this.removeTether(k, true);
    for (const p of pairs) this.addTether(p.from, p.to, false);
  }

  /** Play a chain EventAttack (numbers may arrive as strings). */
  playChainAttack(d: AttackDetail) { this.enqueue(() => this.playAttack(d)); }

  /** Release everything: the view is not used again. */
  dispose() {
    this.buildGen++;
    this.clear();
    this.markMat?.dispose(); this.markGeo?.dispose();
    this.markMat = null; this.markGeo = null;
    this.set.dispose();
    this.fx.dispose();
  }

  clear() {
    this.clearIntent();
    for (const m of this.marks.values()) this.group.remove(m);
    this.marks.clear();
    this.wrecks = [];
    for (const u of this.units.values()) { this.group.remove(u.root); u.dispose(); }
    this.units.clear();
    for (const t of [...this.tethers.values(), ...this.fading]) { this.group.remove(t.mesh); t.mat.dispose(); t.mesh.geometry.dispose(); }
    this.tethers.clear();
    this.fading.clear();
    for (const f of this.floaters) f.el.remove();
    this.floaters = [];
    this.queue = [];
    this.tweens = [];
    this.gen++;
    this.running = false;
    this.slowmo = 0;
    this.fx.clear();
  }

  /** The decks moved under the board (a phone turned mid-fight): every standing hull steps back onto
   * its slot at the new heights, and the guard tethers follow. Animations keep playing. */
  restand() {
    for (const u of this.units.values()) if (!u.destroyed) u.root.position.copy(this.slotPosition(u.side, u.ambit, u.slot, u.command, u.halfHeight, u.column));
    for (const from of [...this.tethers.keys()]) this.rebuildTethersFor(from);
  }

  /** Stop whatever is playing but keep the board: queued and running animations are dropped, and
   * every standing unit goes back to its slot (a lunge or sidestep may have been cut short). */
  halt() {
    this.clearIntent();
    this.queue = [];
    this.tweens = [];
    this.gen++;
    this.running = false;
    this.slowmo = 0;
    for (const f of this.floaters) f.el.remove();
    this.floaters = [];
    this.fx.clear();
    for (const u of this.units.values()) if (!u.destroyed) u.root.position.copy(this.slotPosition(u.side, u.ambit, u.slot, u.command, u.halfHeight, u.column));
    for (const from of [...this.tethers.keys()]) this.rebuildTethersFor(from);
  }

  /** Take a unit off the board without ceremony: it left, or the board has moved past its wreck. */
  removeUnit(id: string) {
    const u = this.units.get(id);
    if (!u) return;
    for (const [k, t] of [...this.tethers]) if (t.from === id || t.to === id) this.removeTether(k, true);
    this.group.remove(u.root);
    u.tag.remove();
    u.dispose();
    this.units.delete(id);
    this.refreshBadges();
  }

  /** Slide a standing unit to another slot; its tethers follow once it arrives. */
  moveUnit(u: UnitView, ambit: Ambit, slot: number) {
    if (u.ambit === ambit && u.slot === slot) return;
    u.ambit = ambit;
    u.slot = slot;
    const from = u.root.position.clone(), to = this.slotPosition(u.side, ambit, slot, u.command, u.halfHeight, u.column);
    const g = this.gen;
    void this.tween(0.45, (k) => u.root.position.lerpVectors(from, to, k), (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2)).then(() => { if (g === this.gen) this.rebuildTethersFor(u.id); });
  }

  pickables() { return [...this.units.values()].filter((u) => !u.destroyed && u.pick).map((u) => u.pick); }

  /* ── Clock-driven helpers ─────────────────────────────────────────────── */
  tween(dur: number, fn: (k: number) => void, ease: (k: number) => number = (k) => k): Promise<void> {
    return new Promise((resolve) => this.tweens.push({ t: 0, dur: Math.max(0.001, dur), fn, ease, resolve }));
  }
  wait(sec: number) { return this.tween(sec, () => {}); }

  /** Where a unit sits on screen, in CSS pixels (for a forecast opened from the keyboard or a pad). */
  screenOf(id: string): { x: number; y: number } | null {
    const u = this.units.get(id);
    if (!u) return null;
    const v = u.root.position.clone().project(this.camera);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
  }

  floater(pos: THREE.Vector3, text: string, cls: string, life = 1.3) {
    // Words born on the same spot (COUNTERED, then DESTROYED) stack upward instead of printing over each other.
    pos = pos.clone();
    let under: Floater | undefined;
    for (const f of this.floaters) if (f.age < 0.7 && Math.abs(f.pos.x - pos.x) < 2.6 && Math.abs(f.pos.y - pos.y) < 0.8) { pos.y = f.pos.y + 0.9; under = f; }
    const el = h('div', { class: 'floater ' + cls }, text);
    // Place it now: floaters are often born between frames (after an await) and
    // would otherwise sit in the corner until the next overlay pass.
    const v = pos.clone().project(this.camera);
    this.layer.appendChild(el);
    // Kept whole on screen: a flagship at the deck's edge put "ALPHA DRIFT" half off a phone.
    // And below the HUD's cards: words born at the top of the field print under them, not behind them.
    const half = el.offsetWidth / 2, halfH = el.offsetHeight / 2;
    const f: Floater = { el, pos: pos.clone(), age: 0, life, rise: 1.2, half, halfH, under };
    el.style.transform = `translate(${clampX(((v.x + 1) / 2) * window.innerWidth, half)}px, ${Math.max(this.floorOf(f), ((1 - v.y) / 2) * window.innerHeight)}px) translate(-50%, -50%) scale(0.6)`;
    this.floaters.push(f);
  }

  /* ── Tethers: defender → ward ─────────────────────────────────────────── */
  private tetherCurve(a: UnitView, b: UnitView) {
    const p0 = a.root.position.clone(), p2 = b.root.position.clone();
    p0.y -= a.halfHeight * 0.7; p2.y -= b.halfHeight * 0.7;
    const mid = p0.clone().lerp(p2, 0.5);
    mid.y -= 0.9 + Math.abs(p0.x - p2.x) * 0.06;
    mid.z += 1.4;
    return new THREE.QuadraticBezierCurve3(p0, mid, p2);
  }

  private makeTether(from: UnitView, to: UnitView) {
    const curve = this.tetherCurve(from, to);
    // A thin glowing line: at the Dreamcast's 480 lines, 16×3 reads the same as 40×5 at a quarter of
    // the triangles (a big guarded fleet draws dozens of these).
    const geo = new THREE.TubeGeometry(curve, LOOK.dc ? 16 : 40, 0.035, LOOK.dc ? 3 : 5, false);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(TEAM[from.side]) }, uGrow: { value: 0 }, uAlpha: { value: 1 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uGrow, uAlpha; uniform vec3 uColor; varying vec2 vUv;
        void main() {
          if (vUv.x > uGrow) discard;
          // Packets of charge run from the guard to its ward: a hot head, a fading tail.
          float ph = fract(vUv.x * 14.0 - uTime * 1.6);
          float packet = pow(ph, 6.0);
          float tip = smoothstep(uGrow - 0.04, uGrow, vUv.x) * step(uGrow, 0.999);
          float a = (0.28 + 0.72 * packet + tip) * uAlpha;
          gl_FragColor = vec4(uColor * (0.7 + packet * 2.2 + tip * 2.0), a);
        }
      `,
    });
    const mesh = new THREE.Mesh(geo, mat);
    this.group.add(mesh);
    return { mesh, mat };
  }

  syncTethers(chain: Chain) {
    const want = new Map<string, { from: string; to: string }>();
    for (const s of Object.values(chain.structs)) {
      // The chain keeps a guard's ward id after the ward dies; only living pairs are drawn.
      const ward = s.protectedStructId ? chain.structs[s.protectedStructId] : undefined;
      if (ward && !chain.isDestroyed(s) && !chain.isDestroyed(ward)) want.set(s.id, { from: s.id, to: ward.id });
    }
    for (const [k, t] of this.tethers) {
      const w = want.get(k);
      if (!w || w.to !== t.to) this.removeTether(k);
    }
    for (const [k, w] of want) {
      if (this.tethers.has(k)) continue;
      const a = this.units.get(w.from), b = this.units.get(w.to);
      if (!a || !b) continue;
      const { mesh, mat } = this.makeTether(a, b);
      mat.uniforms.uGrow.value = 1;
      this.tethers.set(k, { mesh, mat, from: w.from, to: w.to, t: 1, dying: false });
    }
  }

  private addTether(from: string, to: string, animate = true) {
    this.removeTether(from, true);
    const a = this.units.get(from), b = this.units.get(to);
    if (!a || !b) return;
    const { mesh, mat } = this.makeTether(a, b);
    this.tethers.set(from, { mesh, mat, from, to, t: 0, dying: false });
    if (!animate) mat.uniforms.uGrow.value = 1;
  }
  private removeTether(from: string, immediate = false) {
    const t = this.tethers.get(from);
    if (!t) return;
    this.tethers.delete(from);
    const drop = () => { this.fading.delete(t); this.group.remove(t.mesh); t.mat.dispose(); t.mesh.geometry.dispose(); };
    if (immediate) { drop(); return; }
    // Fading tethers are tracked so a clear() mid-fade still frees them.
    this.fading.add(t);
    void this.tween(0.4, (k) => { t.mat.uniforms.uAlpha.value = 1 - k; }).then(drop);
  }
  private rebuildTethersFor(unitId: string) {
    for (const [k, t] of [...this.tethers]) {
      if (t.from === unitId || t.to === unitId) { this.removeTether(k, true); this.addTether(t.from, t.to, false); }
    }
  }
  tetherOf(unitId: string) { return this.tethers.get(unitId); }
  private refreshBadges() {
    const guardedBy = new Map<string, number>();
    for (const t of this.tethers.values()) if (!t.dying) guardedBy.set(t.to, (guardedBy.get(t.to) || 0) + 1);
    for (const u of this.units.values()) if (u.badges) u.setBadges(this.tethers.has(u.id), guardedBy.get(u.id) || 0);
  }

  /* ── The queue ────────────────────────────────────────────────────────── */
  /* A clear() abandons in-flight animations: their tweens and projectiles are
   * dropped unresolved and become garbage. The generation lets a fresh pump
   * start instead of waiting on a job that will never finish. */
  private gen = 0;
  enqueue(job: () => Promise<void>) {
    this.queue.push(job);
    if (!this.running) void this.pump();
  }
  private async pump() {
    const gen = this.gen;
    this.running = true;
    while (this.queue.length && gen === this.gen) {
      const job = this.queue.shift()!;
      try { await job(); } catch (e) { console.warn('[battle] animation failed', e); }
    }
    if (gen === this.gen) this.running = false;
  }

  /** Animate one block's results, then settle on the chain's truth. */
  playBlock(block: Block, chain: Chain, you: string) {
    this.enqueue(async () => {
      for (const tx of block.txs) {
        if (!tx.ok) continue;
        for (const e of tx.events) await this.playEvent(e, chain);
      }
    });
    this.enqueue(async () => { if (this.queue.length === 0) this.syncFromChain(chain, you); });
  }

  private async playEvent(e: ChainEvent, chain: Chain) {
    const d = e.detail;
    switch (e.category) {
      case 'struct_attack': return this.playAttack(d as AttackDetail);
      case 'struct_defense_add': {
        const a = this.units.get(d.defender_struct_id), b = this.units.get(d.protected_struct_id);
        if (!a || !b) return;
        audio.play('shield', 0.6);
        this.addTether(a.id, b.id);
        this.floater(this.above(a), 'GUARDING', 'info ' + a.side);
        this.fx.shield(b.center(), TEAM[b.side], 1.6, 0.7);
        await this.wait(0.45);
        return;
      }
      case 'struct_defense_remove': {
        const t = this.tethers.get(d.defender_struct_id);
        if (t) this.removeTether(d.defender_struct_id);
        return;
      }
      case 'struct_move': {
        const u = this.units.get(d.struct_id);
        if (!u) return;
        await this.playMove(u, d.ambit, d.slot);
        return;
      }
      case 'struct_status': {
        const u = this.units.get(d.struct_id);
        if (!u) return;
        const hidden = (d.status & 16) !== 0, wasHidden = (d.status_old & 16) !== 0;
        u.online = (d.status & 4) !== 0;
        if (hidden !== wasHidden) {
          audio.play('stealth');
          this.fx.particles.burst(u.center(), 40, { speed: 3, color: [0x9ab0c8, TEAM[u.side]], size: 0.25, life: 0.8, drag: 2 });
          u.setHidden(hidden);
          this.floater(this.above(u), hidden ? 'STEALTH' : 'REVEALED', 'info ' + u.side);
          await this.wait(0.35);
        }
        return;
      }
      default: void chain; return;
    }
  }

  private above(u: UnitView) { return u.root.position.clone().add(new THREE.Vector3(0, u.halfHeight + 0.6, 0)); }

  private async playMove(u: UnitView, ambit: Ambit, slot: number) {
    const from = u.root.position.clone();
    u.ambit = ambit; u.slot = slot;
    const to = this.slotPosition(u.side, ambit, slot, u.command, u.halfHeight, u.column);
    audio.play('warp');
    this.floater(this.above(u), 'ALPHA DRIFT', 'info ' + u.side);
    this.fx.ring(from, TEAM[u.side], 2.5, 0.5);
    const mid = from.clone().lerp(to, 0.5).add(new THREE.Vector3(-u.facing * 3, 0, 3));
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    await this.tween(1.0, (k) => {
      curve.getPoint(k, u.root.position);
      if (Math.random() < 0.7) this.fx.particles.spawn({ pos: u.root.position.clone(), color: TEAM[u.side], size: 0.5, life: 0.5, drag: 0 });
    }, easeInOutCubic);
    this.fx.ring(to, TEAM[u.side], 2.5, 0.5);
    this.set.pulse(ambit, 0.8);
    this.rebuildTethersFor(u.id);
  }

  /* ── Attack choreography ──────────────────────────────────────────────── */
  private async playAttack(d: AttackDetail) {
    const A = this.units.get(d.attackerStructId);
    if (!A) return;
    const rows = d.eventAttackShotDetail || [];
    const groups: ShotRow[][] = [];
    for (const r of rows) {
      const g = groups[groups.length - 1];
      if (g && g[0].targetStructId === r.targetStructId) g.push(r); else groups.push([r]);
    }
    let attackerHp = d.attackerHealthBefore;
    if (A.hidden) { A.setHidden(false); this.floater(this.above(A), 'REVEALED', 'info ' + A.side); }
    const control = d.weaponControl;
    const multi = rows.length > 1;
    const artillery = A.typeId === 8;

    this.onFocus(A.center(), 0.4);
    // Wind-up: the hull rocks back, the muzzle flares.
    this.set.pulse(A.ambit, 0.6);
    void this.tween(0.25, (k) => { A.mesh.position.x = -A.facing * Math.sin(k * Math.PI) * 0.35; });
    const muzzle = A.muzzle();
    this.fx.flare(muzzle, control === 'guided' ? 0xfff0c8 : 0xffd27a, 2.4, 0.25);
    audio.play(multi ? 'gatling' : control === 'guided' ? 'missile' : artillery ? 'cannon' : 'cannon');
    await this.wait(0.12);

    for (const g of groups) {
      const last = g[g.length - 1];
      const T = this.units.get(last.targetStructId);
      if (!T) continue;
      this.onFocus(T.center(), 0.6);
      const blocker = last.blocked && last.blockedByStructId ? this.units.get(last.blockedByStructId) : undefined;

      // Defender counters react to the launch and reach the attacker first.
      const counterJobs: Promise<void>[] = [];
      for (const c of last.eventAttackDefenderCounterDetail || []) {
        const C = this.units.get(c.counterByStructId);
        if (!C || !c.counterDamage) continue;
        const delay = 0.1 + counterJobs.length * 0.12;
        counterJobs.push(this.wait(delay).then(() => this.counterShot(C, A, c.counterDamage, () => {
          attackerHp = Math.max(0, attackerHp - c.counterDamage);
          A.setHealth(attackerHp);
          if (c.counterDestroyedAttacker) void this.destroyUnit(A);
        })));
      }

      // Blocker lunges between target and attacker.
      let blockerHome: THREE.Vector3 | null = null;
      if (blocker && blocker !== T) {
        blockerHome = blocker.root.position.clone();
        const guardPos = T.root.position.clone().add(new THREE.Vector3(-T.facing * -1 * (T.halfWidth + 0.6), 0.15, 1.6));
        // In front of the whole line, not just of its ward: on the staggered compact deck a ward in the
        // back row would otherwise put its guard in the front row's plane, on top of a neighbour.
        guardPos.z = Math.max(T.root.position.z, 0) + 1.6;
        void this.tween(0.35, (k) => { blocker.root.position.lerpVectors(blockerHome!, guardPos, k); }, easeOutCubic);
        this.floater(this.above(T), 'BLOCK', 'info ' + blocker.side);
      }

      const flights: Promise<void>[] = [];
      g.forEach((row, i) => {
        const isLast = i === g.length - 1;
        const dest = blocker || T;
        const evaded = !!row.evaded;
        const hit = (row.damageDealt ?? 0) > 0 || (isLast && (row.damage ?? 0) > 0);
        const from = A.muzzle().add(new THREE.Vector3(0, (Math.random() - 0.5) * 0.3, 0));
        const to = dest.center().add(new THREE.Vector3((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5, 0));
        if (evaded || (!hit && !isLast)) {
          // Overshoot past the target.
          to.add(new THREE.Vector3(dest.facing * -2.5, (Math.random() < 0.5 ? 1 : -1) * 2.2, 2.5));
        }
        const dist = from.distanceTo(to);
        const kind = multi ? 'tracer' : control === 'guided' ? (A.ambit === 'water' && dest.ambit === 'water' ? 'torpedo' : 'missile') : 'shell';
        const speed = kind === 'tracer' ? 55 : kind === 'shell' ? (artillery ? 22 : 40) : 22;
        const dur = Math.max(0.25, dist / speed) + (kind === 'missile' ? 0.25 : 0);
        const arc = kind === 'missile' ? new THREE.Vector3(0, 2 + Math.random() * 2.5, 3 + Math.random() * 3)
          : artillery ? new THREE.Vector3(0, 9, 1) : kind === 'torpedo' ? new THREE.Vector3(0, -1.2, 1.5) : new THREE.Vector3(0, 0.6, 0.6);
        const color = A.side === 'player' ? (control === 'guided' ? 0x7ff0dc : 0xffd27a) : (control === 'guided' ? 0xff8c78 : 0xffb070);
        flights.push(this.wait(i * (multi ? 0.09 : 0)).then(() => new Promise<void>((resolve) => {
          if (multi) audio.play('gatling', 0.7);
          this.fx.projectile({
            from, to, color, duration: dur, arc, kind, wobble: evaded && control === 'guided' ? 1.4 : 0,
            onArrive: () => {
              if (evaded) {
                this.onEvade(dest, row.evadedCause || '');
              } else if (hit) {
                this.fx.impact(to, color, isLast ? 1.2 : 0.6);
                audio.play('impact', isLast ? 1 : 0.5);
                dest.flash = 1;
                this.onShake(isLast ? 0.25 : 0.08);
                if (isLast) {
                  const dmg = row.damage ?? row.damageDealt ?? 0;
                  this.floater(this.above(dest), '-' + dmg, 'dmg ' + dest.side);
                  if (row.damageReduction) this.floater(this.above(dest).add(new THREE.Vector3(0, 0.5, 0)), 'ARMOUR −' + row.damageReduction, 'info');
                  if (row.armourPiercing) this.floater(this.above(dest).add(new THREE.Vector3(0, 0.5, 0)), 'PIERCING', 'warn');
                  if (blocker) { blocker.setHealth(row.blockerHealthAfter ?? blocker.health); this.fx.shield(blocker.center(), TEAM[blocker.side], 1.7, 0.5); audio.play('shield'); }
                  else T.setHealth(row.targetHealthAfter);
                }
              } else {
                this.fx.particles.burst(to, 6, { speed: 2, color: 0x9aa6b8, size: 0.2, life: 0.4 });
                if (isLast) this.floater(this.above(dest), 'MISS', 'miss');
              }
              resolve();
            },
          });
        })));
      });
      await Promise.all(flights);
      await Promise.all(counterJobs);

      // Destruction from the volley.
      const deaths: Promise<void>[] = [];
      if (blocker && last.blockerDestroyed) deaths.push(this.destroyUnit(blocker));
      if (last.targetDestroyed && !blocker) deaths.push(this.destroyUnit(T));
      if (blocker && blockerHome && !last.blockerDestroyed) {
        const bh = blockerHome;
        void this.wait(0.25).then(() => {
          const from = blocker.root.position.clone();
          return this.tween(0.45, (k) => { blocker.root.position.lerpVectors(from, bh, k); }, easeInOutCubic);
        });
      }
      await Promise.all(deaths);

      // The target answers.
      if (last.targetCountered && last.targetCounteredDamage && !T.destroyed) {
        await this.counterShot(T, A, last.targetCounteredDamage, () => {
          attackerHp = Math.max(0, attackerHp - (last.targetCounteredDamage || 0));
          A.setHealth(attackerHp);
        });
        if (last.targetCounterDestroyedAttacker) await this.destroyUnit(A);
      }
      if (last.postDestructionDamageToAttacker && last.postDestructionDamage) {
        this.floater(this.above(A), '-' + last.postDestructionDamage, 'dmg ' + A.side);
      }
      if (A.destroyed) break;
    }
    if (d.attackerHealthAfter != null && !A.destroyed) A.setHealth(d.attackerHealthAfter);
    if ((d.attackerHealthAfter ?? 1) === 0 && !A.destroyed) await this.destroyUnit(A);
    await this.wait(0.15);
  }

  private onEvade(u: UnitView, cause: string) {
    const word = cause === 'signalJamming' ? 'JAMMED' : cause === 'defensiveManeuver' ? 'EVADED' : 'EVADED';
    this.floater(this.above(u), word, 'miss');
    audio.play('evade');
    if (cause === 'signalJamming') {
      this.fx.shield(u.center(), 0x94a4e4, 1.9, 0.6);
      this.fx.particles.burst(u.center(), 26, { speed: 4, color: [0x94a4e4, 0xffffff], size: 0.12, life: 0.4 });
    } else {
      const home = u.mesh.position.clone();
      void this.tween(0.4, (k) => { u.mesh.position.z = home.z + Math.sin(k * Math.PI) * 1.6; u.mesh.position.y = home.y + Math.sin(k * Math.PI) * 0.4; }, easeInOutCubic);
    }
  }

  private counterShot(C: UnitView, A: UnitView, damage: number, onHit: () => void): Promise<void> {
    return new Promise((resolve) => {
      if (C.destroyed || A.destroyed) { resolve(); return; }
      const from = C.muzzle(), to = A.center();
      const color = C.side === 'player' ? 0x86dfc6 : 0xf4a990;
      this.fx.flare(from, color, 1.6, 0.2);
      audio.play('laser', 0.7);
      this.fx.projectile({
        from, to, color, kind: 'tracer', duration: Math.max(0.2, from.distanceTo(to) / 45), arc: new THREE.Vector3(0, 0.4, 0.4),
        onArrive: () => {
          this.fx.impact(to, color, 0.7);
          A.flash = 1;
          this.floater(this.above(A).add(new THREE.Vector3(0.4, 0.3, 0)), 'COUNTER −' + damage, 'dmg ' + A.side);
          onHit();
          resolve();
        },
      });
    });
  }

  async destroyUnit(u: UnitView) {
    if (u.destroyed) return;
    u.destroyed = true;
    u.setHealth(0);
    const c = u.center();
    const big = u.command ? 2.2 : 1;
    this.fx.explosion(c, big, u.side === 'player' ? 0x43cdb6 : 0xff7a50);
    this.fx.debris.shatter(u.material.map === u.dmg.map ? u.dmg : u.base, u.mesh.matrixWorld, c.clone().add(new THREE.Vector3(0, -0.2, -0.5)), u.command ? 9 : 6, this.set.tiers[u.ambit] - 2.0);
    audio.play('explosion', big);
    this.onShake(u.command ? 1.1 : 0.45);
    this.onFlash(u.command ? 0.35 : 0.08, u.side === 'player' ? 0xee7d69 : 0xffffff);
    u.mesh.visible = false;
    u.ring.visible = false;
    u.tag.remove();
    this.wrecks.push({ pos: c.clone().add(new THREE.Vector3(0, -u.halfHeight * 0.4, 0)), left: 11, acc: 0, big: u.command });
    this.floater(this.above(u), u.command ? (u.side === 'player' ? 'COMMAND SHIP LOST' : 'FLAGSHIP DOWN!') : 'DESTROYED', 'kill ' + u.side, 1.8);
    for (const [k, t] of [...this.tethers]) if (t.from === u.id || t.to === u.id) this.removeTether(k);
    if (u.command) { this.onCommandDestroyed(u.side); if (!this.reduceMotion) this.slowmo = 1.6; this.onCinematic(c); }
    await this.wait(u.command ? 0.9 : 0.4);
  }

  /** Settle every unit on the chain's state (after the queue drains). */
  syncFromChain(chain: Chain, you: string) {
    for (const u of this.units.values()) {
      const s = chain.structs[u.id];
      if (!s || chain.isDestroyed(s)) {
        if (!u.destroyed) { u.destroyed = true; u.mesh.visible = false; u.ring.visible = false; u.tag.remove(); }
        continue;
      }
      if (s.health !== u.health) u.setHealth(s.health);
      if (chain.isHidden(s) !== u.hidden) u.setHidden(chain.isHidden(s));
      u.online = chain.isOnline(s);
      if (s.ambit !== u.ambit || s.slot !== u.slot) {
        u.ambit = s.ambit; u.slot = s.slot;
        u.root.position.copy(this.slotPosition(u.side, s.ambit, s.slot, u.command, u.halfHeight, u.column));
        this.rebuildTethersFor(u.id);
      }
    }
    this.syncTethers(chain);
    void you;
  }

  /** Warp-in: every unit streaks in from its own side. */
  async deploy() {
    const list = [...this.units.values()];
    list.forEach((u) => { u.root.visible = false; u.tag.style.opacity = '0'; });
    audio.play('warp', 1.2);
    const jobs = list.map((u, i) => this.wait(0.08 * i + Math.random() * 0.2).then(() => {
      const home = u.root.position.clone();
      const start = home.clone().add(new THREE.Vector3(-u.facing * 40, 0, -10));
      u.root.visible = true;
      return this.tween(0.75, (k) => {
        u.root.position.lerpVectors(start, home, k);
        if (k < 0.95) this.fx.particles.spawn({ pos: u.root.position.clone(), vel: new THREE.Vector3(-u.facing * 30, 0, 0), color: TEAM[u.side], size: 0.6, life: 0.25, drag: 6 });
      }, easeOutCubic).then(() => {
        this.fx.ring(home.clone().add(new THREE.Vector3(0, -u.halfHeight, 0)), AMBIT_COLOR[u.ambit], 2.4, 0.5, new THREE.Vector3(0, 1, 0));
        this.set.pulse(u.ambit, 0.4);
        u.tag.style.opacity = '';
      });
    }));
    await Promise.all(jobs);
  }

  update(dt: number, t: number) {
    // Hurry when blocks are piling up behind the animation; crawl for a flagship kill.
    this.timeScale = this.queue.length > 3 ? 2.2 : this.queue.length > 1 ? 1.5 : 1;
    if (this.slowmo > 0) { this.slowmo -= dt; this.timeScale = 0.3; }
    const sdt = this.paused ? 0 : dt * this.timeScale;
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      tw.t += sdt;
      const k = Math.min(1, tw.t / tw.dur);
      tw.fn(tw.ease(k));
      if (k >= 1) { this.tweens.splice(i, 1); tw.resolve(); }
    }
    for (const u of this.units.values()) {
      u.update(sdt, t);
      // Idle life: engine exhaust aloft, wakes on the water.
      if (u.destroyed || !u.mesh || !u.root.visible || u.building || u.column === 'planet' || sdt === 0) continue;
      u.exhaust += sdt;
      const rate = u.ambit === 'space' || u.ambit === 'air' ? 0.07 : u.ambit === 'water' ? 0.16 : 0;
      if (!rate || u.exhaust < rate) continue;
      u.exhaust = 0;
      const p = u.root.position.clone(); p.y += u.pivot.position.y;
      if (u.ambit === 'water') {
        p.x += (Math.random() - 0.5) * u.halfWidth * 1.6; p.y -= u.halfHeight * 0.45; p.z += 0.6;
        this.fx.particles.spawn({ pos: p, vel: new THREE.Vector3(-u.facing * 0.6, 0.1, 0.3), color: 0xbfe0ff, size: 0.22, life: 0.9, drag: 1.5 });
      } else {
        p.x -= u.facing * u.halfWidth * 0.95; p.y += (Math.random() - 0.5) * u.halfHeight * 0.3;
        this.fx.particles.spawn({ pos: p, vel: new THREE.Vector3(-u.facing * (1.5 + Math.random()), (Math.random() - 0.5) * 0.2, 0), color: u.side === 'player' ? 0x5fe8d0 : 0xff8a6a, size: u.command ? 0.42 : 0.3, life: 0.35, drag: 2 });
      }
    }
    this.refreshBadges();
    for (const tt of this.tethers.values()) {
      tt.mat.uniforms.uTime.value = t;
      if (tt.t < 1) { tt.t = Math.min(1, tt.t + sdt * 2.5); tt.mat.uniforms.uGrow.value = easeOutBack(tt.t); }
    }
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      w.left -= sdt; w.acc += sdt;
      if (w.left <= 0) { this.wrecks.splice(i, 1); continue; }
      const fade = Math.min(1, w.left / 3);
      while (w.acc > 0.06) {
        w.acc -= 0.06;
        const jitter = new THREE.Vector3((Math.random() - 0.5) * 0.8, 0, (Math.random() - 0.5) * 0.6);
        this.fx.smoke.spawn({ pos: w.pos.clone().add(jitter), vel: new THREE.Vector3((Math.random() - 0.5) * 0.3, 1.2 + Math.random() * 0.8, 0), color: 0x5d636e, size: (w.big ? 1.3 : 0.9) * fade, life: 2.2, drag: 0.6, grow: 2.5 });
        if (Math.random() < 0.35) this.fx.particles.spawn({ pos: w.pos.clone().add(jitter), vel: new THREE.Vector3((Math.random() - 0.5) * 1.2, 1.5 + Math.random() * 1.5, 0), color: 0xff8a3a, size: 0.12, life: 0.9, drag: 1.2, gravity: 0.6 });
      }
    }
    this.updateMarks(t);
    if (this.intent) {
      const k = 0.5 + 0.5 * Math.sin(t * 10);
      this.intent.mat.opacity = 0.45 + k * 0.5;
      this.intent.rmat.uniforms.uTime.value = t;
      this.intent.reticle.scale.setScalar(1.05 - k * 0.08);
      this.intent.reticle.quaternion.copy(this.camera.quaternion);
    }
    this.set.update(sdt, t);
    this.fx.update(sdt);
    this.updateOverlay(sdt);
  }

  /** A mark on every ship the armed weapon can hit, facing the camera, sized to the hull. Only on
   * the battle deck (the planet's own field draws its reticles in planetActions), and only on enemy
   * hulls: a guard pick marks friends as targetable too, and they want no red. */
  private updateMarks(t: number) {
    const marking = this.xFor === fieldX;
    for (const u of this.units.values()) {
      const want = marking && u.targetable && u.side === 'enemy' && !u.destroyed && !!u.mesh && u.root.visible;
      let m = this.marks.get(u.id);
      if (!want) { if (m) { this.group.remove(m); this.marks.delete(u.id); } continue; }
      if (!m) {
        this.markMat ||= markMaterial();
        this.markGeo ||= new THREE.PlaneGeometry(1, 1);
        m = new THREE.Mesh(this.markGeo, this.markMat);
        m.renderOrder = 30;
        this.group.add(m);
        this.marks.set(u.id, m);
      }
      m.position.copy(u.root.position);
      m.position.y += u.pivot.position.y;
      m.position.z += 1.2;
      m.quaternion.copy(this.camera.quaternion);
      m.scale.setScalar(Math.max(u.halfWidth, u.halfHeight) * 2.5 + 0.6);
    }
    // Reduced motion: the brackets hold still, half closed.
    if (this.markMat) this.markMat.uniforms.uTime.value = this.reduceMotion ? 0.26 : t;
  }

  /** The highest a floater's centre may sit: under the HUD's cards (floorY; 0, none). */
  private floorOf(f: Floater) {
    return this.floorY ? this.floorY + (f.halfH || 0) : -Infinity;
  }

  private updateOverlay(dt: number) {
    const w = window.innerWidth, hgt = window.innerHeight;
    const v = this.tmp;
    for (const u of this.units.values()) {
      if (u.destroyed || !u.mesh) continue;
      v.copy(u.root.position); v.y += u.halfHeight + 0.35 + u.pivot.position.y;
      v.project(this.camera);
      u.tag.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * hgt}px) translate(-50%, -100%)`;
      if (u.tag.style.visibility) u.tag.style.visibility = '';
    }
    // Words placed this frame, newest first: a word that would print over one already placed (two ships
    // side by side, or both pinned to the HUD's floor) steps down below it, as a stack does.
    const placed: { x: number; y: number; hw: number; hh: number }[] = [];
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.age += dt;
      const k = f.age / f.life;
      if (k >= 1) { f.el.remove(); this.floaters.splice(i, 1); continue; }
      v.copy(f.pos); v.y += easeOutCubic(Math.min(1, k * 1.6)) * f.rise;
      v.project(this.camera);
      // (Newest first: a word stacked on an older one keeps it a full line below, as 0.9 units is under a
      // line on a phone and the HUD's floor can press a stack together. The older word gives way, downward.)
      let y = Math.max(this.floorOf(f), ((1 - v.y) / 2) * hgt, f.minY ?? -Infinity);
      f.minY = undefined;
      const x = clampX(((v.x + 1) / 2) * w, f.half || 0), hw = f.half || 0, hh = f.halfH || 0;
      // (Down first, as a stack reads; where that would slip under the action bar, up above the word in
      // the way instead, short of the HUD's floor.)
      const lo = this.ceilY ? this.ceilY - hh : Infinity, hi = this.floorY ? this.floorY + hh : -Infinity;
      for (let n = 0; n < 6; n++) {
        const o = placed.find((p) => Math.abs(p.x - x) < p.hw + hw && Math.abs(p.y - y) < p.hh + hh);
        if (!o) break;
        const down = o.y + o.hh + hh + 2, up = o.y - o.hh - hh - 2;
        if (down <= lo) y = down;
        else if (up >= hi) y = up;
        else break;
      }
      y = Math.min(y, Math.max(lo, hi));
      placed.push({ x, y, hw, hh });
      const u = f.under;
      if (u?.el.isConnected) u.minY = Math.max(u.minY ?? -Infinity, y + hh + (u.halfH || 0) + 2);
      f.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${k < 0.12 ? 0.6 + k * 4 : 1})`;
      f.el.style.opacity = String(k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1);
    }
  }
}
