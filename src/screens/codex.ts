/* The Codex: every struct type on chain, as an extruded pixel model on a
 * holographic pedestal, with its full mechanics and computed matchups —
 * what it can hit, what can hit it, and what it shrugs off. */
import '../styles/dc-lab.css';
import { termByKey } from '../data/learn';
import { icon } from '../ui/icons';
import { term } from '../ui/guide';
import { keepFocus } from '../ui/keepFocus';
import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PIXEL_RATIO, softwareGL, type Engine, type Screen } from '../core/engine';
import { h, hideTooltip, showTooltip } from '../core/dom';
import { audio } from '../core/audio';
import { clamp, damp, formatPower, humanize } from '../core/util';
import {
  AMBIT_COLOR, AMBIT_FLAG, AMBIT_NAME, AMBITS, type Ambit, CATALOGUE_HEIGHT, COMMAND_SHIP_ID, controlName, DEFENSE_HINT, DEFENSE_NAME, PASSIVE_NAME,
  reachLabel, roleOf, STRUCT_TYPES, type StructType, TYPES_BY_ID, type WeaponSystem, ambitsOf, canTargetAmbit, hasWeapon, weaponField, weaponLabel,
} from '../data/catalogue';
import { getHullModel, hullFxMaterial, type Faction, type HullModel } from '../gfx/hull/model';
import { structPortrait } from '../gfx/hull/portrait';
import { latestAttacks } from '../chain/combat';
import { currentRoute, replaceRoute, setPageMeta } from '../core/nav';
import { bakeEpoch, createNebulaSky, createStarfield, tickSpace } from '../gfx/space';
import { encodeBattle, fits, layout, unitId } from '../sim/fleets';
import { STRUCT_LORE } from '../data/lore';
import { Effects } from '../gfx/fx';

/** The turntable's front: nose to the right, turned a little toward you (as the portraits are). */
const FRONT = -0.35;
const TAU = Math.PI * 2;
/** The front heading nearest `a`. */
const frontOf = (a: number) => Math.round((a - FRONT) / TAU) * TAU + FRONT;

export class CodexScreen implements Screen {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 2000);
  readonly bloom = { strength: 0.8, radius: 0.55, threshold: 0.55 };
  private sky: THREE.Object3D[];
  private pedestal = new THREE.Group();
  private holder = new THREE.Group();
  /** The turntable's plane, tipped toward you so the hull's deck shows as it turns. */
  private tip = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  /** The hull model behind `mesh` (what comes apart when the next type arrives). */
  private meshModel: HullModel | null = null;
  /** Shared by every stage shader: clock, the display's accent (ambit, or hostile coral), the
   * faction rim, damage, the dial's angle (it turns with the hull), seconds since a hull arrived. */
  private u = {
    uTime: { value: 0 }, uColor: { value: new THREE.Color(0x94a4e4) }, uRim: { value: new THREE.Color(0x43cdb6) },
    uDmg: { value: 0 }, uRot: { value: 0 }, uShow: { value: 99 }, uMotion: { value: 1 },
  };
  /** The hologram skin laid over whichever hull is on the pedestal (raster, scan sweep, interference). */
  private holoMat: THREE.ShaderMaterial;
  private floor: Reflector;
  private rimLight: THREE.SpotLight;
  /** The pedestal's metal and the prefiltered studio it mirrors (a render target: rebaked after a lost context). */
  private metal: THREE.MeshPhysicalMaterial;
  private env: THREE.Texture | null;
  private envEpoch: number;
  /** The hull material's hologram knob (battle view's build scan), run backwards as the arrival. */
  private holoIn: { value: number } | null = null;
  private fx = new Effects();
  private root!: HTMLElement;
  private typeId = 1;
  private faction: Faction = 'player';
  private damaged = false;
  private drag: { x: number; rot: number } | null = null;
  private spin = 0;
  private targetRot = 0;
  /** The turntable's heading (it turns slowly; a drag turns it any way), and the drag's clock. */
  private rest = FRONT;
  private loadToken = 0;
  private cleanup: (() => void)[] = [];
  /** Re-fits the card when its words change size (Expert, Larger text, a font arriving, the record). */
  private fitObs: ResizeObserver | null = null;
  private fitRaf = 0;

  constructor(private engine: Engine, private navigate: (h: string) => void) {
    this.scene.background = new THREE.Color(0x030409);
    this.sky = [createNebulaSky({ seed: 7.7, intensity: 0.42 }), createStarfield(3000, 700, 77)];
    for (const s of this.sky) this.scene.add(s);

    /* Three-point light, museum style: a warm key high left, a cool fill low right, the faction
     * rim from behind to cut the silhouette out of the dark (the emitter's up-light on the belly
     * is the hull material's bounce, set per hull). */
    this.scene.add(new THREE.HemisphereLight(0x9fb4d8, 0x0a0c12, 0.22));
    const key = new THREE.DirectionalLight(0xfff0e0, 2.1);
    key.position.set(-5, 7, 8);
    const fill = new THREE.DirectionalLight(0x7f9cff, 0.45);
    fill.position.set(7, 1.5, 5);
    // Rims are spots held on the hull, so the polished deck never catches them.
    const spot = (color: number, k: number, x: number, y: number, z: number, angle: number, ty = 0.25) => {
      const l = new THREE.SpotLight(color, k, 0, angle, 0.7, 0);
      l.position.set(x, y, z);
      l.target.position.set(0, ty, 0);
      this.scene.add(l, l.target);
      return l;
    };
    this.rimLight = spot(0x43cdb6, 2.4, 3.5, 2.6, -9, 0.21);
    spot(0xbfd2ff, 1.6, -7.5, 1.8, -6, 0.24);
    this.scene.add(key, fill);

    this.env = studioEnvironment(engine.renderer);
    this.envEpoch = bakeEpoch(engine.renderer);
    this.metal = buildPedestal(this.pedestal, this.u, this.env);
    // The key light's shaft, faint in the bay's haze, falling on the hull from high left.
    const shaftGeo = new THREE.CylinderGeometry(0.5, 2.6, 13, 48, 1, true).translate(0, -6.5, 0);
    const shaft = new THREE.Mesh(shaftGeo, stageMaterial(this.u, SHAFT_FRAG, {}, STAGE_VERT, { side: THREE.DoubleSide, polygonOffset: false }));
    shaft.position.set(-5.2, 10.5, -2.5);
    shaft.lookAt(0, 0.2, 0);
    shaft.rotateX(-Math.PI / 2);
    shaft.renderOrder = 1;
    this.scene.add(shaft);
    // Haze banked along the far horizon, so the deck ends in light rather than a hard edge.
    const haze = new THREE.Mesh(new THREE.CylinderGeometry(70, 70, 40, 96, 1, true).translate(0, 17.7, 0),
      stageMaterial(this.u, HAZE_FRAG, {}, STAGE_VERT, { side: THREE.BackSide, polygonOffset: false }));
    haze.renderOrder = -5;
    this.scene.add(haze);

    // A glossy deck that mirrors the stage, blurred a touch and lost in the dark toward the walls.
    this.floor = new Reflector(new THREE.CircleGeometry(36, 96), {
      shader: FLOOR_SHADER, multisample: 0,
      textureWidth: Math.max(256, Math.round(window.innerWidth * PIXEL_RATIO.value * 0.5)),
      textureHeight: Math.max(256, Math.round(window.innerHeight * PIXEL_RATIO.value * 0.5)),
    });
    const fm = this.floor.material as THREE.ShaderMaterial;
    fm.transparent = true;
    Object.assign(fm.uniforms, { uTime: this.u.uTime, uColor: this.u.uColor });
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -2.3;
    this.floor.renderOrder = -1;
    this.scene.add(this.floor);

    this.holoMat = stageMaterial(this.u, HOLO_FRAG, { uMap: { value: null }, uH: { value: 1 } }, HOLO_VERT);
    this.scene.add(this.pedestal);
    this.tip.rotation.x = 0.36;
    this.tip.add(this.holder);
    this.scene.add(this.tip);
    this.scene.add(this.fx.group);
    this.camera.position.set(0, 2.2, 12.4);
    this.camera.lookAt(0, -0.6, 0);
  }

  async enter(params: Record<string, string>) {
    this.root = h('div', { class: 'screen codex' });
    document.getElementById('ui')!.appendChild(this.root);
    if (params.type && TYPES_BY_ID[Number(params.type)]) this.typeId = Number(params.type);
    this.fx.setScale(window.innerHeight, this.camera.fov);
    this.renderList();
    this.bindInput();
    await this.show(this.typeId, false);
  }

  exit() {
    this.closeMatrix();
    this.fitObs?.disconnect(); this.fitObs = null;
    cancelAnimationFrame(this.fitRaf); this.fitRaf = 0;
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
    // Pending test-fire volleys and model loads belong to this visit.
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.loadToken++;
    this.firing = false;
    if (this.dummy) this.dummy.visible = false;
    this.root.remove();
  }

  private timers = new Set<number>();
  private later(ms: number, f: () => void) {
    const t = window.setTimeout(() => { this.timers.delete(t); f(); }, ms);
    this.timers.add(t);
    return t;
  }

  /** How the panels sit: 'wide' (list left, detail right), 'side' (a short landscape screen such as
   * the TV: detail on the right, portraits along the bottom, the model in the corner they leave), or
   * 'stack' (a phone: detail on top, portraits along the bottom). Matches dc-lab.css. */
  private layoutMode(): 'wide' | 'side' | 'stack' {
    const w = window.innerWidth, hgt = window.innerHeight;
    return w > 900 ? 'wide' : hgt <= 560 && w >= 560 ? 'side' : 'stack';
  }

  resize() {
    this.fx.setScale(window.innerHeight, this.camera.fov);
    const w = window.innerWidth, hgt = window.innerHeight;
    // The deck's mirror renders at half resolution: it is blurred anyway.
    this.floor.getRenderTarget().setSize(Math.max(256, Math.round(w * PIXEL_RATIO.value * 0.5)), Math.max(256, Math.round(hgt * PIXEL_RATIO.value * 0.5)));
    const mode = this.layoutMode();
    // The side layout's detail column and portrait strip, margins included (dc-lab.css).
    const SIDE_W = 276, STRIP_H = 148, TOP = 52;
    const left = mode === 'wide' ? 300 : 0, right = mode === 'wide' ? 380 : mode === 'side' ? SIDE_W : 0;
    let dy = 0;
    if (mode === 'wide') this.camera.position.z = 12.5;
    else {
      // Back off until the model fits the gap the panels leave (by height and by width), then centre it there.
      // Stacked: detail (top 34%) over the model over the list (bottom 30%). Side: left of the detail, above the strip.
      const gapH = mode === 'side' ? hgt - TOP - STRIP_H : Math.max(160, hgt * 0.36 - 60);
      const gapW = mode === 'side' ? w - SIDE_W : w;
      this.camera.position.z = 12.5 * clamp(Math.max(0.5 * hgt / gapH, 1.15 * 520 / gapW), 1, 3);
      // Where the model's middle lands unshifted, versus the middle of the gap.
      this.camera.clearViewOffset();
      this.camera.updateMatrixWorld();
      const y0 = ((1 - new THREE.Vector3(0, -0.4, 0).project(this.camera).y) / 2) * hgt;
      dy = -((mode === 'side' ? TOP + gapH / 2 : 22 + hgt * 0.52) - y0);
    }
    this.camera.setViewOffset(w, hgt, (right - left) / 2, dy, w, hgt);
    this.camera.updateProjectionMatrix();
    if (this.root?.isConnected) { this.fitDetail(); this.stripEdges(); }
  }

  /** The card stops at the end of a whole row (a row of stat chips, a weapon, a row of faces), never
   * through the middle of one, and while more is below it a chevron sits on its foot (dc-lab.css).
   * Run whenever the card's words or the room for it change. */
  private fitDetail() {
    const card = this.root.querySelector<HTMLElement>('.codex-detail');
    const body = card?.querySelector<HTMLElement>(':scope > .panel-body');
    if (!card || !body) return;
    // Back to the stylesheet's limit (the wide layout's own limit is inline), then measure the room.
    body.style.setProperty('max-height', this.layoutMode() === 'wide' ? 'calc(var(--vh, 100vh) - 170px)' : '');
    card.classList.remove('snapped');
    const room = body.clientHeight;
    if (body.scrollHeight > room + 2) {
      const top = body.getBoundingClientRect().top - body.scrollTop;
      // Where a row ends: each block, each row of chips or faces. A boxed block (a weapon, a trait)
      // counts whole, so the card never ends inside a box. The foot keeps a band for the chevron.
      const BAND = 18;
      let end = 0;
      for (const el of body.querySelectorAll<HTMLElement>(':scope > *, :scope > .cx-sub > *, :scope > .cx-stats > .cx-stat, :scope > .cx-vs .cx-face, :scope > .field-record > *, :scope > .field-record .cx-stat, :scope > .cx-btns > *')) {
        const r = el.getBoundingClientRect();
        if (!r.height) continue;
        const b = r.bottom - top;
        if (b <= room - BAND && b > end) end = b;
      }
      // Never snap a card down to almost nothing: a short room keeps its plain fade.
      if (end > room * 0.45) {
        body.style.setProperty('max-height', `${Math.ceil(end + 4)}px`, 'important');
        card.classList.add('snapped');
      }
    }
    this.detailEdges();
  }

  /** Watch the card's head, its body and each block in it: any of them changing size (Expert or
   * Larger text switched, a font swapping in, the record arriving, the card's room changing) re-fits
   * the card on the next frame. The fit settles in a frame or two (its own resize reports nothing new). */
  private watchDetail(card: HTMLElement) {
    this.fitObs?.disconnect();
    if (typeof ResizeObserver === 'undefined') return;
    const body = card.querySelector<HTMLElement>(':scope > .panel-body');
    if (!body) return;
    this.fitObs = new ResizeObserver(() => {
      if (this.fitRaf) return;
      this.fitRaf = requestAnimationFrame(() => { this.fitRaf = 0; if (this.root.isConnected) this.fitDetail(); });
    });
    for (const el of [...card.children, ...body.children]) this.fitObs.observe(el);
  }

  /** The card's foot: a chevron while more is below, the fade only once it has been scrolled. */
  private detailEdges() {
    const card = this.root.querySelector<HTMLElement>('.codex-detail');
    const body = card?.querySelector<HTMLElement>(':scope > .panel-body');
    if (!card || !body) return;
    card.classList.toggle('more-below', body.scrollTop + body.clientHeight < body.scrollHeight - 2);
    card.classList.toggle('scrolled', body.scrollTop > 2);
  }

  /** The portrait strip (narrow screens): its edges fade where more units are, and a chevron points
   * on while the strip runs past the right edge. */
  private stripEdges() {
    const list = this.root.querySelector<HTMLElement>('.codex-list');
    const strip = list?.querySelector<HTMLElement>('.codex-scroll');
    if (!list || !strip) return;
    const sideways = strip.scrollWidth > strip.clientWidth + 2;
    list.classList.toggle('more-left', sideways && strip.scrollLeft > 2);
    list.classList.toggle('more-right', sideways && strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2);
  }

  /* ── List ─────────────────────────────────────────────────────────────── */
  /** A character-select grid: every unit's portrait, grouped by where it fights; names on hover
   * (and big in the detail once picked). */
  private renderList() {
    this.root.querySelector('.codex-list')?.remove();
    const groups: { title: string; word: string; ico: string; items: StructType[] }[] = [
      { title: 'Fleet leader', word: 'Leader', ico: 'star', items: STRUCT_TYPES.filter((t) => t.id === 1) },
      ...AMBITS.map((a) => ({ title: `Ships · ${AMBIT_NAME[a]}`, word: AMBIT_NAME[a], ico: a, items: STRUCT_TYPES.filter((t) => t.category === 'fleet' && t.id !== 1 && t.possibleAmbit === AMBIT_FLAG[a]) })),
      { title: 'Planet buildings', word: 'Buildings', ico: 'planet', items: STRUCT_TYPES.filter((t) => t.category === 'planet') },
    ];
    const list = h('div', { class: 'codex-list panel' },
      h('div', { class: 'panel-head' }, h('span', { class: 'cx-title' }, h('span', { html: icon('book', 18) }), h('span', { class: 't-label' }, 'Units')),
        h('button', { class: 'btn ghost mini cx-mx-btn', title: 'Who beats whom: expected damage for every matchup', onclick: () => { audio.play('select'); this.toggleMatrix(); } }, h('span', { html: icon('battle', 14) }), 'Matchups')),
      h('div', { class: 'scroll codex-scroll' }, groups.filter((g) => g.items.length).map((g) => h('div', { class: 'codex-group' },
        h('div', { class: 't-label c-hint codex-gtitle', title: g.title }, h('span', { class: 'cx-gico', html: icon(g.ico, 14) }), g.word),
        h('div', { class: 'codex-grid cx-grid' }, g.items.map((t) => {
          const img = h('img', { alt: '' });
          void structPortrait(t.id).then((u) => { img.src = u; });
          return h('button', { class: 'codex-item cx-item' + (t.id === this.typeId ? ' active' : ''), title: t.type, 'aria-label': t.type, 'data-id': String(t.id), onclick: () => { audio.play('select'); void this.show(t.id, true); } },
            h('div', { class: 'codex-thumb' }, img));
        })),
      ))),
      h('div', { class: 't-tiny c-hint x-only', style: 'padding:8px 10px' }, `Mechanics from the testnet LCD at block ${CATALOGUE_HEIGHT.toLocaleString('en-US')}.`),
    );
    this.root.appendChild(list);
    const strip = list.querySelector<HTMLElement>('.codex-scroll');
    strip?.addEventListener('scroll', () => this.stripEdges(), { passive: true });
    requestAnimationFrame(() => { if (list.isConnected) this.stripEdges(); });
  }

  /** Puts a tapped matrix cell's breakdown away on the next press anywhere but another cell
   * (called bare, it just puts it away). A press on a cell keeps the listener for the next one. */
  private mxDismiss = (ev?: PointerEvent) => {
    if (ev && (ev.target as Element | null)?.closest?.('.mx-cell')) return;
    hideTooltip();
    window.removeEventListener('pointerdown', this.mxDismiss, true);
  };

  /* ── Matrix: expected damage per attack, attacker rows × target columns ─ */
  /** Put the Matchups away: the sheet, its scrim and its keys; the screen beneath comes back to life,
   * and (`back`) the cursor returns to the Matchups button. */
  private mxKeys: ((e: KeyboardEvent) => void) | null = null;
  private closeMatrix(back = false) {
    this.mxDismiss();
    hideTooltip();
    this.root.querySelector('.codex-matrix')?.remove();
    this.root.querySelector('.codex-scrim')?.remove();
    for (const el of this.root.querySelectorAll('.codex-list, .codex-detail')) el.removeAttribute('inert');
    if (this.mxKeys) { window.removeEventListener('keydown', this.mxKeys, true); this.mxKeys = null; }
    if (back) this.root.querySelector<HTMLElement>('.cx-mx-btn')?.focus({ focusVisible: document.body.classList.contains('pad') } as FocusOptions);
  }

  private toggleMatrix() {
    if (this.root.querySelector('.codex-matrix')) { this.closeMatrix(true); return; }
    const fleet = STRUCT_TYPES.filter((t) => t.category === 'fleet');
    const expected = (a: StructType, b: StructType) => {
      let best = 0, how = '';
      for (const ws of ['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]) {
        if (!hasWeapon(a, ws)) continue;
        const reaches = ambitsOf(a.possibleAmbit).some((from) => ambitsOf(b.possibleAmbit).some((to) => canTargetAmbit(a, ws, from, to)));
        if (!reaches) continue;
        const shots = weaponField(a, ws, 'Shots') || 1, dmg = weaponField(a, ws, 'Damage') || 0;
        const num = weaponField(a, ws, 'ShotSuccessRateNumerator') || 0, den = weaponField(a, ws, 'ShotSuccessRateDenominator') || 1;
        const guided = weaponField(a, ws, 'Control') === 'guided';
        const en = guided ? b.guidedDefensiveSuccessRateNumerator : b.unguidedDefensiveSuccessRateNumerator;
        const ed = guided ? b.guidedDefensiveSuccessRateDenominator : b.unguidedDefensiveSuccessRateDenominator;
        const evade = en && ed ? en / ed : 0;
        const reduction = weaponField(a, ws, 'ArmourPiercing') ? 0 : b.attackReduction || 0;
        // The first `GuaranteedShots` always hit (as the sim rolls them); the rest at the hit rate.
        const sure = Math.min(shots, weaponField(a, ws, 'GuaranteedShots') || 0);
        const rolled = dmg * (sure + (shots - sure) * Math.min(1, num / den));
        const net = rolled > 0 ? Math.max(1, rolled - reduction) : 0;
        const e = net * (1 - evade);
        if (e > best) { best = e; how = `${weaponLabel(a, ws)}: ${dmg}${shots > 1 ? '×' + shots : ''}${evade ? `, ${Math.round(evade * 100)}% evaded` : ''}${reduction ? `, −${reduction} armour` : ''}`; }
      }
      return { e: best, how };
    };
    // A tapped cell or tile shows its breakdown beside it (touch has no hover).
    const pin = (e: Event, why: string) => {
      if ((e as PointerEvent).pointerType === 'mouse') return;
      const rc = (e.currentTarget as HTMLElement).getBoundingClientRect();
      showTooltip(rc.right, rc.bottom, h('div', { style: 'white-space:pre-line' }, why));
      // Pinned beside its cell: the next touch anywhere but another cell puts it away.
      window.addEventListener('pointerdown', this.mxDismiss, true); // one shared listener: re-adding it is a no-op
    };
    const whyOf = (a: StructType, b: StructType, r: { e: number; how: string }) => r.e ? `${a.type} → ${b.type}\n${r.how}\nExpected ${r.e.toFixed(2)} HP per attack (of ${b.maxHealth})` : `${a.type} cannot reach ${b.type}`;
    const sprite = (t: StructType, cls: string) => { const img = h('img', { alt: '' }); void structPortrait(t.id).then((u) => { img.src = u; }); return h('span', { class: 'mx-sprite ' + cls }, img); };
    const close = h('button', { class: 'btn ghost icon mx-close', 'aria-label': 'Close', title: 'Close (Esc / B)', onclick: () => this.closeMatrix(true) }, '✕');
    const headEl = h('div', { class: 'panel-head', title: 'Best weapon that can reach, after accuracy, the target’s evasion (jamming vs smart, maneuvers vs ballistic) and armour. Guards, counters and stealth come on top. Hover or tap a cell for the breakdown.' },
      h('span', { class: 'cx-title' }, h('span', { html: icon('battle', 16) }), h('span', { class: 't-label' }, 'Matchups')), h('span', { class: 't-tiny c-hint mx-sub' }, 'damage per attack'), close);
    // Narrow screens (a phone, the TV): no grid of numbers. One row per attacker: its picture and name,
    // then every target as a picture with a tick (in reach, greener the harder it hits) or a cross.
    if (this.layoutMode() !== 'wide') {
      // A target under the cursor (keys, pad) shows its breakdown beside it, as a tap does.
      const peek = (el: HTMLElement, why: string) => { if (!el.matches(':focus-visible')) return; const rc = el.getBoundingClientRect(); showTooltip(rc.right, rc.bottom, h('div', { style: 'white-space:pre-line' }, why)); };
      const rowsEl = fleet.map((a) => h('div', { class: 'mx-line' },
        // The attacker: the sheet steps aside and the guide shows it.
        h('button', { class: 'mx-who', title: `Show ${a.type}`, 'aria-label': `Show ${a.type}`, onclick: () => { this.closeMatrix(); void this.show(a.id, true); } }, sprite(a, 'att'), h('span', { class: 'mx-name' }, a.type)),
        h('div', { class: 'mx-targets' }, ...fleet.map((b) => {
          const r = expected(a, b);
          const k = Math.min(1, r.e / 2);
          const why = whyOf(a, b, r);
          const t: HTMLElement = h('button', { class: 'mx-t' + (r.e ? ' hit' : ' miss'), title: why, 'aria-label': why.split('\n')[0], style: r.e ? `--k:${(0.25 + k * 0.75).toFixed(2)}` : '',
            onclick: (e: Event) => pin(e, why), onfocus: () => peek(t, why), onblur: () => hideTooltip() },
          sprite(b, 'tgt'), h('b', { class: 'mx-mark', 'aria-hidden': 'true' }, r.e ? '✓' : '✕'));
          return t;
        }))));
      const box = h('div', { class: 'codex-matrix panel compact', role: 'dialog', 'aria-label': 'Matchups', onclick: (e: Event) => { if (!(e.target as HTMLElement).closest('.mx-t')) hideTooltip(); } },
        headEl,
        h('div', { class: 'panel-body col mx-list scroll', onscroll: () => hideTooltip() }, ...rowsEl));
      // A tap outside the sheet puts it away, and goes no further (the scrim takes it).
      const scrim = h('div', { class: 'codex-scrim', 'aria-hidden': 'true', onpointerdown: (e: Event) => { e.preventDefault(); e.stopPropagation(); }, onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); this.closeMatrix(true); } });
      this.root.append(scrim, box);
      // What it covers sleeps: no cursor, no taps, no arrow keys reach it.
      for (const el of this.root.querySelectorAll('.codex-list, .codex-detail')) el.setAttribute('inert', '');
      this.mxKeys = (e: KeyboardEvent) => this.matrixKey(e, box);
      window.addEventListener('keydown', this.mxKeys, true);
      requestAnimationFrame(() => box.querySelector<HTMLElement>('.mx-who')?.focus({ focusVisible: document.body.classList.contains('pad') } as FocusOptions));
      return;
    }
    const head = h('tr', null, h('th', { class: 't-label c-hint' }, 'Attacker ▸ target'), fleet.map((t) => h('th', { class: 'mx-col', title: t.type }, h('span', null, t.classAbbreviation || t.type))));
    const rows = fleet.map((a) => h('tr', null,
      h('th', { class: 'mx-row', onclick: () => { void this.show(a.id, true); } }, a.type),
      fleet.map((b) => {
        const r = expected(a, b);
        const k = Math.min(1, r.e / 2);
        const why = whyOf(a, b, r);
        // The title covers hover; a tap (touch has no hover) opens the same breakdown beside the cell.
        return h('td', { class: 'mx-cell' + (r.e ? '' : ' none'), title: why, onclick: (e: Event) => pin(e, why),
          style: r.e ? `background: rgba(67,205,182,${0.12 + k * 0.6}); color: ${k > 0.6 ? '#0b1a20' : 'var(--text-body)'}` : '' }, r.e ? r.e.toFixed(1) : '·');
      })));
    const box = h('div', { class: 'codex-matrix panel', onclick: (e: Event) => { if (!(e.target as HTMLElement).closest('.mx-cell')) hideTooltip(); } },
      headEl,
      h('div', { class: 'panel-body col' },
        h('div', { class: 'scroll', style: 'overflow:auto', onscroll: () => hideTooltip() }, h('table', { class: 'matrix' }, h('thead', null, head), h('tbody', null, rows)))));
    this.root.appendChild(box);
  }

  /** Keys while the compact Matchups sheet is up (captured first, so nothing beneath hears them):
   * Escape (the pad's B) puts it away; the arrows (the d-pad) walk its attackers and targets, even
   * the ones scrolled out of sight, and a cursor outside it is brought in. A window on top of it
   * (a hub menu, More, a dialog) keeps its own keys. */
  private matrixKey(e: KeyboardEvent, box: HTMLElement) {
    if (!box.isConnected || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.modal-back, .hub-menu, .more-menu, .guide-card')) return;
    const a = document.activeElement as HTMLElement | null;
    if (a?.closest('.topbar')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.closeMatrix(true); return; }
    const dir = ({ ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as Record<string, [number, number]>)[e.key];
    if (!dir) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const all = [...box.querySelectorAll<HTMLElement>('button')];
    const go = (el: HTMLElement | undefined) => { if (!el) return; el.focus({ preventScroll: true, focusVisible: true } as FocusOptions); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); audio.play('hover', 0.6); };
    if (!a || !box.contains(a)) { go(box.querySelector<HTMLElement>('.mx-who') || all[0]); return; }
    const from = a.getBoundingClientRect(), cx = from.left + from.width / 2, cy = from.top + from.height / 2;
    let best: HTMLElement | undefined, score = Infinity;
    for (const el of all) {
      if (el === a) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2 - cx, y = r.top + r.height / 2 - cy;
      const along = x * dir[0] + y * dir[1];
      if (along <= 4) continue;
      const sc = along + 2 * Math.abs(x * dir[1] - y * dir[0]);
      if (sc < score) { score = sc; best = el; }
    }
    go(best);
  }

  /* ── Showcase ─────────────────────────────────────────────────────────── */
  private async show(typeId: number, animate: boolean) {
    this.typeId = typeId;
    // Only while the codex is still where the user is going (a quick click away mid-fade must win).
    if (currentRoute().startsWith('/codex')) replaceRoute('/codex/' + typeId);
    this.root.querySelectorAll('.codex-item').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.id === String(typeId)));
    const token = ++this.loadToken;
    const t = TYPES_BY_ID[typeId];
    if (currentRoute().startsWith('/codex')) setPageMeta({ title: `${t.type} · Codex`, description: `${t.type} (${t.defaultCosmeticName} ${t.defaultCosmeticModelNumber}): a Structs ${t.category === 'fleet' ? 'fleet' : t.category} struct, with its weapons, charge costs, build costs, defences and computed matchups.`, path: '/codex/' + typeId });
    const model = getHullModel(typeId, this.faction, this.damaged ? 'dmg' : 'base', 'upright');
    if (token !== this.loadToken) return;
    if (this.mesh) {
      if (animate && this.meshModel) this.derez(this.meshModel, this.mesh.matrixWorld);
      this.holder.remove(this.mesh);
      (this.mesh.material as THREE.Material).dispose();
    }
    const mat = hullFxMaterial(model);
    this.mesh = new THREE.Mesh(model.geometry, mat);
    this.meshModel = model;
    // Sized by its widest turn: length, depth or height.
    const k = 2.7 / Math.max(model.width, model.height, model.depth);
    this.mesh.scale.setScalar(k);
    this.mesh.position.y = 0.2;
    this.holder.add(this.mesh);
    // The hologram skin rides the same geometry (and transform) as a child.
    this.holoMat.uniforms.uMap.value = model.map;
    this.holoMat.uniforms.uH.value = model.height;
    const skin = new THREE.Mesh(model.geometry, this.holoMat);
    skin.renderOrder = 2;
    this.mesh.add(skin);
    const amb = ambitsOf(t.possibleAmbit)[0] || 'space';
    const color = new THREE.Color(this.faction === 'enemy' ? 0xee7d69 : AMBIT_COLOR[amb as Ambit]);
    const rim = new THREE.Color(this.faction === 'enemy' ? 0xee6c58 : 0x43cdb6);
    this.u.uColor.value.copy(color);
    this.u.uRim.value.copy(rim);
    this.u.uDmg.value = this.damaged ? 1 : 0;
    this.u.uMotion.value = this.engine.reduceMotion ? 0 : 1;
    this.u.uShow.value = 0;
    this.rimLight.color.copy(rim);
    // The emitter lights the hull's belly (the hull material's bounce knob), and the hull
    // materialises out of its hologram scan.
    const pu = mat.userData.hull as { uBounce?: { value: THREE.Color }; uHolo?: { value: number }; uShade?: { value: number } } | undefined;
    // The stage blooms from 0.55: white paint would glow.
    if (pu?.uShade) pu.uShade.value = 0.6;
    pu?.uBounce?.value.copy(color).multiplyScalar(0.28);
    this.holoIn = pu?.uHolo ?? null;
    if (this.holoIn) this.holoIn.value = 1;
    if (animate) {
      audio.play('warp', 0.6);
      this.fx.ring(new THREE.Vector3(0, -1.75, 0), color, 2.5, 0.7, new THREE.Vector3(0, 1, 0));
      this.fx.particles.burst(new THREE.Vector3(0, -1.6, 0), 30, { speed: 2.2, color: [color.getHex(), 0xffffff], size: 0.07, life: 0.7, drag: 1.5, spread: new THREE.Vector3(1.2, 0.2, 1.2) });
      this.mesh.scale.setScalar(k * 0.2);
      const start = performance.now();
      const grow = () => {
        if (!this.mesh || token !== this.loadToken) return;
        const p = Math.min(1, (performance.now() - start) / 420);
        this.mesh.scale.setScalar(k * (0.2 + 0.8 * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(grow);
      };
      grow();
    }
    // The panel is rebuilt: the cursor stays on its control (paint, damage), or, when the unit itself
    // changed under it (a Hits portrait), lands on the unit's own tile in the list.
    keepFocus(this.root, () => this.renderDetail(t), () => this.root.querySelector<HTMLElement>('.cx-item.active'));
    this.fitDetail();
  }

  /** The outgoing hull comes apart into light that drains back into the lens. */
  private derez(m: HullModel, world: THREE.Matrix4) {
    const lens = new THREE.Vector3(0, -1.72, 0);
    const accent = this.u.uColor.value;
    const c = new THREE.Color();
    for (let i = 0, n = Math.min(180, m.pixels.length); i < n; i++) {
      const px = m.pixels[(Math.random() * m.pixels.length) | 0];
      const p = new THREE.Vector3(px.x, px.y, px.z - Math.random() * Math.min(m.depth * 0.5, 0.4)).applyMatrix4(world);
      const life = 0.3 + Math.random() * 0.4;
      c.setRGB(px.r / 255, px.g / 255, px.b / 255, THREE.SRGBColorSpace).lerp(accent, 0.5).multiplyScalar(1.6);
      this.fx.particles.spawn({ pos: p, vel: lens.clone().sub(p).multiplyScalar(0.85 / life), color: c.clone(), size: 0.05 + Math.random() * 0.05, life, drag: 0, stretch: 0.05 });
    }
  }

  /** The ? button on the detail: the words behind the pictures (stat names, lore, weapon notes). */
  private why = false;

  private renderDetail(t: StructType) {
    this.root.querySelector('.codex-detail')?.remove();
    const reach = (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).filter((ws) => hasWeapon(t, ws));
    const meaning = (key: string) => termByKey.get(key)?.short || '';
    /* A stat is a picture and a number; its name and what it means are on hover, and its name
     * shows under it while the ? button is pressed. */
    const stat = (ico: string, value: Node | string, label: string, more = '', cls = '', key = '') => h('span', { class: 'cx-stat ' + cls, title: `${label}${more ? ': ' + more : ''}`, role: 'group', 'aria-label': `${label}: ${more || (typeof value === 'string' ? value : value.textContent)}` },
      h('span', { class: 'cx-ico', html: icon(ico, 18) }), typeof value === 'string' ? h('span', { class: 'cx-v' }, value) : value,
      // A glossary word (tap it for its meaning) where the game has one.
      key ? term(key, label, 'cx-k dc-hint') : h('span', { class: 'cx-k dc-hint' }, label));
    const weaponBlock = (ws: WeaponSystem) => {
      const shots = weaponField(t, ws, 'Shots') || 1;
      const num = weaponField(t, ws, 'ShotSuccessRateNumerator') || 0, den = weaponField(t, ws, 'ShotSuccessRateDenominator') || 1;
      const g = Number(weaponField(t, ws, 'GuaranteedShots') || 0);
      const to = AMBITS.filter((a) => ambitsOf(weaponField(t, ws, 'Ambits') || 0).includes(a));
      const blockable = !!weaponField(t, ws, 'Blockable');
      const desc = ws === 'primaryWeapon' ? t.primary_weapon_description : '';
      return h('div', { class: 'weapon-block cx-weapon', title: desc || undefined },
        h('div', { class: 'spread' },
          h('span', { class: 'cx-wname' }, h('span', { class: 'cx-ico', html: icon('target', 16) }), h('span', { class: 't-label c-player' }, weaponLabel(t, ws))),
          h('span', { class: 'row', style: 'gap:4px' },
            h('span', { class: 'chip', title: controlName(weaponField(t, ws, 'Control')) === 'Smart' ? 'Smart: a guided weapon (jamming makes it miss)' : 'Ballistic: an unguided weapon (maneuvers make it miss)' }, controlName(weaponField(t, ws, 'Control'))),
            weaponField(t, ws, 'ArmourPiercing') ? h('span', { class: 'chip warn', title: 'Armour piercing: armour does not soften it' }, 'Piercing') : null,
            h('span', { class: 'cx-ws', title: ws === 'primaryWeapon' ? 'Primary weapon' : 'Secondary weapon' }, ws === 'primaryWeapon' ? '1' : '2'))),
        h('div', { class: 'cx-stats' },
          stat('send', h('span', { class: 'cx-v cx-reach' }, ...(to.length ? to.map((a) => h('span', { class: 'ambit-' + a, title: AMBIT_NAME[a], html: icon(a, 16) })) : [reachLabel(t, ws)])), 'Reach', `${reachLabel(t, ws)}. ${meaning('ambit')}`, '', 'ambit'),
          stat('battle', `${weaponField(t, ws, 'Damage')}${shots > 1 ? `×${shots}` : ''}`, 'Damage', shots > 1 ? `${weaponField(t, ws, 'Damage')} × ${shots} shots` : String(weaponField(t, ws, 'Damage'))),
          stat('target', num >= den ? '✓' : g > 0 ? `${g}+${num}/${den}` : `${num}/${den}`, 'Accuracy', num >= den ? 'Always hits' : g > 0 ? `The first ${g} shot${g > 1 ? 's always hit' : ' always hits'}; each shot after that hits ${num} times in ${den}` : `Hits ${num} in ${den}`),
          stat('charge', String(weaponField(t, ws, 'Charge')), 'Charge', `Charge to fire. ${meaning('charge')}`, 'c-warn', 'charge'),
          stat('shield', blockable ? '✓' : '✕', 'Blockable', `Guards can block it: ${blockable ? 'Yes' : 'No'}. ${meaning('guard')}`, '', 'guard')),
        desc ? h('div', { class: 't-tiny c-hint dc-hint' }, desc) : null);
    };
    // Matchups: who it can hit and who can hit it, by ambit reach.
    const fleet = STRUCT_TYPES.filter((x) => x.category === 'fleet' && x.id !== t.id);
    const canHit = (a: StructType, b: StructType) => ambitsOf(a.possibleAmbit).some((from) => ambitsOf(b.possibleAmbit).some((to) => (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).some((ws) => hasWeapon(a, ws) && canTargetAmbit(a, ws, from, to))));
    const hits = t.category === 'fleet' ? fleet.filter((x) => canHit(t, x)) : [];
    const hitBy = fleet.filter((x) => canHit(x, t));
    // Each unit in a matchup list is its portrait: a press shows it.
    const faces = (list: StructType[], cls: string) => list.length ? h('div', { class: 'cx-faces' }, list.map((x) => {
      const img = h('img', { alt: '' });
      void structPortrait(x.id).then((u) => { img.src = u; });
      return h('button', { class: 'cx-face ' + cls, title: x.type, 'aria-label': x.type, 'data-k': `cx-face-${cls}-${x.id}`, onclick: () => { audio.play('select'); void this.show(x.id, true); } }, img);
    })) : h('span', { class: 'dc-num c-hint', title: 'None' }, '—');
    const lore = STRUCT_LORE[t.id];
    const about = h('button', { class: 'btn ghost mini cx-about' + (this.why ? ' active' : ''), 'data-k': 'cx:about', 'aria-pressed': this.why ? 'true' : 'false', title: 'About: the story and the words behind the pictures',
      onclick: () => { this.why = !this.why; audio.play('select'); detail.classList.toggle('dc-why', this.why); about.classList.toggle('active', this.why); about.setAttribute('aria-pressed', this.why ? 'true' : 'false'); this.fitDetail(); } },
    h('span', { html: icon('help', 14) }), 'About');

    const detail = h('div', { class: 'codex-detail panel ' + (this.faction === 'enemy' ? 'enemy' : 'player') + (this.why ? ' dc-why' : '') },
      h('div', { class: 'panel-head' },
        h('span', { class: 'cx-title' }, h('span', { html: icon(t.category === 'fleet' ? 'ship' : 'planet', 16) }), h('span', { class: 't-label' }, t.category === 'fleet' ? 'Fleet' : 'Building'), h('span', { class: 'x-only t-label' }, ` · type ${t.id}`)),
        h('span', { class: 'chip x-only' }, t.defaultCosmeticModelNumber),
        // Fly sits in the card's head, always in view (the card's body scrolls on small screens).
        t.category === 'fleet' ? h('button', { class: 'btn solid mini cx-fly', title: 'Fly it in a training battle', 'data-k': 'cx:fly', onclick: () => this.flyIt(t.id) }, h('span', { class: 'dc-face a mini' }, 'A'), h('span', { html: icon('play', 14) }), 'Fly') : null,
        about),
      h('div', { class: 'panel-body col scroll', style: 'max-height: calc(var(--vh, 100vh) - 170px)' },
        h('div', { class: 't-display ' + (this.faction === 'enemy' ? 'c-enemy' : 'c-player'), title: roleOf(t) }, t.type),
        h('div', { class: 'row wrap cx-sub' },
          ...ambitsOf(t.possibleAmbit).map((a) => h('span', { class: 'chip cx-chip ambit-' + a, title: `Fights in ${AMBIT_NAME[a]}` }, h('span', { html: icon(a, 12) }), AMBIT_NAME[a])),
          h('span', { class: 't-tiny c-hint', title: 'Its model name' }, `“${t.defaultCosmeticName}”`, h('span', { class: 'x-only' }, ` · ${t.classAbbreviation}`))),
        h('p', { class: 't-body cx-role', style: 'margin:2px 0' }, roleOf(t)),
        lore ? h('p', { class: 'codex-lore dc-hint' }, lore) : null,
        h('div', { class: 'cx-stats' },
          stat('health', h('span', { class: 'pips cx-v', style: 'display:inline-flex' }, Array.from({ length: t.maxHealth }, () => h('i'))), 'Health', `${t.maxHealth} hits`),
          stat('power', formatPower(t.passiveDraw), 'Power use', meaning('power'), '', 'power'),
          stat('charge', String(t.buildCharge), 'Build cost', `${t.buildCharge} charge to build${this.expertNote(` · difficulty ${t.buildDifficulty}`)}. ${meaning('charge')}`, 'c-warn', 'charge'),
          stat('build', t.buildLimit ? String(t.buildLimit) : '∞', 'Build limit', t.buildLimit ? `At most ${t.buildLimit}` : 'Unlimited'),
          t.movable ? stat('ship', `${t.moveCharge}`, 'Drive', `${t.drive_label || 'Move'} · ${t.moveCharge} charge to move`) : null,
          t.attackReduction ? stat('shield', `−${t.attackReduction}`, 'Armour', `−${t.attackReduction} damage per volley`) : null,
          t.planetaryShieldContribution ? stat('shield', '+' + t.planetaryShieldContribution, 'Shield', `Adds ${t.planetaryShieldContribution} to the planet’s shield. ${meaning('shield')}`, '', 'shield') : null,
          t.generatingRate ? stat('power', `${t.generatingRate}`, 'Generates', `${t.generatingRate} kW per gram of alpha`) : null,
          t.counterAttack || t.counterAttackSameAmbit ? stat('counter', `${t.counterAttackSameAmbit}/${t.counterAttack}`, 'Fires back', `Damage it hits back with when attacked: ${t.counterAttackSameAmbit} from its own layer / ${t.counterAttack} from another layer`) : null),
        h('div', { class: 't-tiny c-hint x-only' }, `Build difficulty ${t.buildDifficulty}`),
        reach.map(weaponBlock),
        DEFENSE_NAME[t.unitDefenses] ? h('div', { class: 'weapon-block cx-trait', title: DEFENSE_HINT[t.unitDefenses] || humanize(t.unitDefenses) },
          h('span', { class: 'cx-wname' }, h('span', { class: 'cx-ico', html: icon('shield', 16) }), h('span', { class: 't-label c-secondary' }, DEFENSE_NAME[t.unitDefenses])),
          h('div', { class: 't-tiny c-hint dc-hint' }, DEFENSE_HINT[t.unitDefenses] || humanize(t.unitDefenses))) : null,
        PASSIVE_NAME[t.passiveWeaponry] ? h('div', { class: 'weapon-block cx-trait', title: t.passive_weaponry_description || 'Fires back at attackers in reach, once per attack.' },
          h('span', { class: 'cx-wname' }, h('span', { class: 'cx-ico', html: icon('counter', 16) }), h('span', { class: 't-label c-secondary' }, t.passive_weaponry_label || PASSIVE_NAME[t.passiveWeaponry])),
          h('div', { class: 't-tiny c-hint dc-hint' }, t.passive_weaponry_description || 'Fires back at attackers in reach, once per attack.')) : null,
        t.category === 'fleet' ? h('div', { class: 'cx-vs', title: 'It can hit' }, h('span', { class: 'cx-vs-k c-player', html: icon('target', 18) }), h('span', { class: 'cx-k dc-hint' }, 'Hits'), faces(hits, 'player')) : null,
        h('div', { class: 'cx-vs', title: 'It can be hit by' }, h('span', { class: 'cx-vs-k c-enemy', html: icon('shield', 18) }), h('span', { class: 'cx-k dc-hint' }, 'Hit by'), faces(hitBy, 'enemy')),
        this.fieldRecord(t),
        h('div', { class: 'row wrap cx-btns' },
          h('button', { class: 'btn ghost' + (this.faction === 'enemy' ? ' active' : ''), title: 'Paint: friendly or hostile colours', 'data-k': 'cx:paint', onclick: () => { this.faction = this.faction === 'enemy' ? 'player' : 'enemy'; audio.play('select'); void this.show(this.typeId, true); } }, h('span', { html: icon('flag', 14) }), this.faction === 'enemy' ? 'Hostile' : 'Friendly'),
          h('button', { class: 'btn ghost' + (this.damaged ? ' active' : ''), title: 'Show it damaged or pristine', 'data-k': 'cx:damage', onclick: () => { this.damaged = !this.damaged; audio.play('select'); void this.show(this.typeId, false); } }, h('span', { html: icon('health', 14) }), this.damaged ? 'Damaged' : 'Pristine'),
          reach.length ? h('button', { class: 'btn', title: 'Test fire its weapons at a target drone', 'data-k': 'cx:fire', onclick: () => this.testFire() }, h('span', { html: icon('target', 14) }), 'Fire') : null,
        ),
      ));
    this.root.appendChild(detail);
    this.watchDetail(detail);
    detail.querySelector<HTMLElement>(':scope > .panel-body')?.addEventListener('scroll', () => this.detailEdges(), { passive: true });
  }

  /** Expert detail inside a title (titles can't hold an .x-only span). */
  private expertNote(s: string) { return document.body.classList.contains('expert') ? s : ''; }

  /** How this type has fared in the newest real attacks on the chain (the combat archive). */
  private fieldRecord(t: StructType) {
    const head = () => h('div', { class: 'cx-sec', title: 'Field record: the last 100 real attacks on the testnet' }, h('span', { html: icon('record', 16) }), h('span', { class: 't-label c-hint' }, 'Record'));
    const el = h('div', { class: 'field-record' }, head(), h('div', { class: 't-tiny c-hint', title: 'Reading the combat archive…' }, '…'));
    void latestAttacks().then((recs) => {
      if (!el.isConnected || this.typeId !== t.id) return;
      let fired = 0, kills = 0, hit = 0, lost = 0, evaded = 0;
      let last: string | null = null;
      for (const r of recs) {
        const a = r.attack;
        if (Number(a.attackerStructTypeId) === t.id) {
          fired++; last = last || r.hash;
          kills += (a.eventAttackShotDetail || []).filter((x) => x.targetDestroyed).length;
        }
        for (const s of a.eventAttackShotDetail || []) {
          if (Number(s.targetStructTypeId) !== t.id) continue;
          last = last || r.hash;
          if (s.evaded) evaded++; else hit++;
          if (s.targetDestroyed) lost++;
        }
      }
      const n = (ico: string, v: string, what: string, cls = '') => h('span', { class: 'cx-stat ' + cls, title: what, role: 'img', 'aria-label': what }, h('span', { class: 'cx-ico', html: icon(ico, 16) }), h('span', { class: 'cx-v' }, v), h('span', { class: 'cx-k dc-hint' }, what.split(':')[0]));
      const body = fired || hit || evaded
        ? h('div', { class: 'cx-stats' },
          n('battle', String(fired), `Attacks made: ${fired}`), n('star', String(kills), `Kills: ${kills}`),
          n('shield', String(hit), `Shots taken: ${hit}`), n('explore', String(evaded), `Evaded: ${evaded}`), n('health', String(lost), `Destroyed: ${lost}`, lost ? 'c-enemy' : ''))
        : h('div', { class: 'dc-num c-hint', title: 'Not seen in the last 100 attacks on the testnet.' }, '—');
      el.replaceChildren(head(), body);
      const watch = last;
      if (watch) el.append(h('button', { class: 'btn ghost mini', style: 'align-self:flex-start', title: 'Watch it fight', onclick: () => { audio.play('select'); this.navigate('/combat/' + watch); } }, h('span', { html: icon('play', 12) }), 'Watch'));
      this.fitDetail();
    }).catch(() => el.replaceChildren(head(), h('div', { class: 't-tiny c-hint' }, 'The combat archive could not be read.')));
    return el;
  }

  /* A trial battle with this hull in your fleet (two of them, if it fits twice). */
  private flyIt(typeId: number) {
    const seed = 'trial:' + typeId + ':' + Math.random().toString(36).slice(2, 6);
    const units = layout('difficult', seed);
    if (typeId !== COMMAND_SHIP_ID) {
      let placed = 0;
      for (const u of units) {
        if (placed >= 2 || u.side !== 'player' || u.type === COMMAND_SHIP_ID || !fits(typeId, u.ambit)) continue;
        u.type = typeId; u.id = unitId('player', typeId, u.ambit, u.slot); placed++;
      }
      // Guards pointing at renamed hulls: re-point by slot.
      const ids = new Set(units.map((u) => u.id));
      for (const u of units) if (u.protects && !ids.has(u.protects)) u.protects = null;
    }
    audio.play('confirm');
    this.navigate('/sim/' + encodeBattle({ units, difficulty: 'difficult', blockMs: 2000, title: `Trial: ${TYPES_BY_ID[typeId].type}` }));
  }

  /* ── Test fire: each weapon at a holographic dummy ─────────────────────── */
  private dummy: THREE.Group | null = null;
  private firing = false;
  private testFire() {
    const t = TYPES_BY_ID[this.typeId];
    const systems = (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).filter((ws) => hasWeapon(t, ws));
    if (!systems.length || !this.mesh || this.firing) return;
    this.firing = true;
    // Face front, three-quarters on and nose right, then fire (the turntable holds while it does).
    this.rest = frontOf(this.rest);
    if (!this.dummy) {
      // A holographic target drone: a lattice over a glowing shell, two gimbal rings round it.
      const hot = new THREE.Color(0xee7d69).multiplyScalar(1.6);
      const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
      this.dummy = new THREE.Group();
      const shell = stageMaterial(this.u, DRONE_FRAG, {}, STAGE_VERT, { polygonOffset: false });
      this.dummy.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.52, 3), shell));
      this.dummy.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 1), new THREE.MeshBasicMaterial({ color: hot, wireframe: true, opacity: 0.75, ...add })));
      for (const [rx, rz] of [[1.2, 0.3], [0.2, -1.1]]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.01, 6, 96), new THREE.MeshBasicMaterial({ color: hot, opacity: 0.6, ...add }));
        ring.rotation.set(rx, 0, rz);
        this.dummy.add(ring);
      }
      this.scene.add(this.dummy);
    }
    // Place it in the visible gap between the list and the detail panel, upper right.
    const list = this.root.querySelector('.codex-list')?.getBoundingClientRect();
    const detail = this.root.querySelector('.codex-detail')?.getBoundingClientRect();
    // Narrow screens: aim into the visible gap (under the detail when stacked, left of it on the TV).
    const mode = this.layoutMode();
    const left = list && mode === 'wide' ? list.right : 0, right = detail && mode !== 'stack' ? detail.left : window.innerWidth;
    const gapTop = mode === 'stack' && detail ? detail.bottom : mode === 'side' ? 52 : 0, gapBottom = mode !== 'wide' && list ? list.top : window.innerHeight;
    const sx = left + (right - left) * 0.84, sy = mode === 'wide' ? window.innerHeight * 0.3 : gapTop + (gapBottom - gapTop) * 0.3;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1), this.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 1.2), new THREE.Vector3());
    this.dummy.position.copy(hit || new THREE.Vector3(2.3, 1.7, -1.2));
    this.dummy.visible = true;
    const token = this.loadToken;
    const fire = (ws: WeaponSystem, delay: number) => this.later(delay, () => {
      if (!this.mesh || token !== this.loadToken) return;
      const shots = weaponField(t, ws, 'Shots') || 1;
      const guided = weaponField(t, ws, 'Control') === 'guided';
      const box = new THREE.Box3().setFromObject(this.mesh);
      const from = new THREE.Vector3(box.max.x - 0.2, (box.min.y + box.max.y) / 2 + 0.2, 0.3);
      const to = this.dummy!.position.clone();
      for (let i = 0; i < shots; i++) {
        this.later(i * 110, () => {
          if (token !== this.loadToken) return;
          audio.play(shots > 1 ? 'gatling' : guided ? 'missile' : 'cannon', 0.8);
          this.fx.flare(from, 0xffe0a0, 1.2, 0.2);
          this.fx.projectile({
            from: from.clone(), to: to.clone().add(new THREE.Vector3(0, (Math.random() - 0.5) * 0.4, 0)), color: guided ? 0x7ff0dc : 0xffd27a,
            duration: shots > 1 ? 0.25 : guided ? 0.9 : t.id === 8 ? 0.9 : 0.35, kind: shots > 1 ? 'tracer' : guided ? 'missile' : 'shell',
            arc: guided ? new THREE.Vector3(0, 1.6, 1.4) : t.id === 8 ? new THREE.Vector3(0, 3.5, 0) : new THREE.Vector3(0, 0.2, 0), size: 0.5,
            onArrive: () => { this.fx.impact(to, guided ? 0x7ff0dc : 0xffb070, 0.6); audio.play('impact', 0.6); },
          });
        });
      }
    });
    systems.forEach((ws, i) => fire(ws, 450 + i * 1300));
    this.later(450 + systems.length * 1300 + 900, () => { this.firing = false; if (this.dummy) this.dummy.visible = false; });
  }

  /* ── Input: drag to turn the model ───────────────────────────────────── */
  private bindInput() {
    const c = this.engine.canvas;
    const down = (e: PointerEvent) => { this.drag = { x: e.clientX, rot: this.targetRot }; c.style.cursor = 'grabbing'; };
    const move = (e: PointerEvent) => {
      if (!this.drag) { c.style.cursor = 'grab'; return; }
      this.targetRot = this.drag.rot + (e.clientX - this.drag.x) * 0.01;
    };
    // Let go: the turntable carries on from where the drag left it.
    const up = () => { if (this.drag) this.rest = this.targetRot; this.drag = null; c.style.cursor = 'grab'; };
    /* Arrows step through the units, but only from the stage itself or the unit list: on a button in
     * the detail panel they are the pad's to move between controls, and a window on top (Settings,
     * a confirm) keeps them. The cursor follows the unit to its tile. */
    const key = (e: KeyboardEvent) => {
      if (!/^Arrow(Up|Down|Left|Right)$/.test(e.key) || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      // Matchups is up: the arrows are its own (and the units beneath stay put).
      if (this.root.querySelector('.codex-matrix')) return;
      const a = document.activeElement as HTMLElement | null;
      if (!(!a || a === document.body || a === c || a.classList.contains('cx-item'))) return;
      if (document.querySelector('.modal-back')) return;
      const ids = STRUCT_TYPES.map((t) => t.id);
      const i = ids.indexOf(this.typeId);
      e.preventDefault();
      void this.show(ids[(e.key === 'ArrowDown' || e.key === 'ArrowRight' ? i + 1 : i - 1 + ids.length) % ids.length], true);
      const tile = this.root.querySelector<HTMLElement>('.cx-item.active');
      // The strip brings the cursor's portrait to its middle, clear of the edge fades.
      if (tile) { tile.focus({ preventScroll: true }); tile.scrollIntoView({ block: 'nearest', inline: 'center' }); }
    };
    c.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    this.cleanup.push(() => {
      c.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
      c.style.cursor = 'default';
    });
  }

  update(dt: number, t: number) {
    // A restored WebGL context comes back with the studio's render target empty: bake it again.
    const epoch = bakeEpoch(this.engine.renderer);
    if (epoch !== this.envEpoch) {
      this.envEpoch = epoch;
      this.env?.dispose();
      this.env = this.metal.envMap = studioEnvironment(this.engine.renderer);
      this.metal.needsUpdate = true;
    }
    this.u.uMotion.value = this.engine.reduceMotion ? 0 : 1;
    tickSpace(this.sky, t);
    this.u.uTime.value = t;
    this.u.uShow.value += dt;
    if (this.holoIn) this.holoIn.value = 1 - THREE.MathUtils.smoothstep(this.u.uShow.value, 0.15, 1.1);
    if (!this.drag) {
      // A slow turn on the pedestal: the hulls are solid, every side is worth seeing. It holds
      // front-on, three-quarters, while it test-fires and with reduced motion.
      const still = this.firing || this.engine.reduceMotion;
      if (still) this.rest = damp(this.rest, frontOf(this.rest), 2.5, dt);
      else this.rest += dt * 0.32;
      this.targetRot = this.rest;
    }
    this.spin = damp(this.spin, this.targetRot, 6, dt);
    this.u.uRot.value = this.spin;
    this.holder.rotation.y = this.spin;
    this.holder.position.y = Math.sin(t * 1.2) * 0.08;
    if (this.dummy?.visible) { this.dummy.rotation.y += dt * 1.5; this.dummy.rotation.x += dt * 0.7; }
    // A damaged hull spits the odd spark from its own plating.
    const m = this.meshModel;
    if (this.damaged && this.mesh && m && m.pixels.length && Math.random() < dt * 2.5) {
      const px = m.pixels[(Math.random() * m.pixels.length) | 0];
      const at = new THREE.Vector3(px.x, px.y, px.z).applyMatrix4(this.mesh.matrixWorld);
      this.fx.particles.burst(at, 5, { speed: 1.4, color: [0xffd27a, 0xff8a3a], size: 0.05, life: 0.5, drag: 1.5, gravity: 3 });
    }
    this.fx.update(dt);
  }
}

/* ── The display stage ───────────────────────────────────────────────────
 * A machined emitter pedestal (lathed gunmetal with a lacquer coat, a glow channel, a glyph
 * readout round the drum, a calibration dial on the deck and a glass lens with a white-hot
 * core) throwing a cone of light full of slow dust; a polished deck mirrors it all. Every
 * shader reads the screen's shared uniforms, so a new hull recolours the whole stage. */

type StageUniforms = Record<string, THREE.IUniform>;

const STAGE_HEAD = /* glsl */ `
  uniform float uTime, uDmg, uRot, uShow, uK, uMotion;
  uniform vec3 uColor, uRim;
  float hash(float n) { return fract(sin(n * 127.1 + 0.37) * 43758.5453); }
  float ring(float r, float a, float b, float px) { return smoothstep(a - px, a + px, r) * (1.0 - smoothstep(b - px, b + px, r)); }
  /* n lines round the circle, w their half width in line spacings; anti-aliased by the pixel size px at radius r. */
  float spokes(float ang, float n, float w, float r, float px) {
    float t = ang / 6.2831853 * n;
    float aa = px / max(r, 1e-3) / 6.2831853 * n;
    return 1.0 - smoothstep(w - aa, w + aa, abs(fract(t + 0.5) - 0.5));
  }
  /* A damaged display stutters. */
  // A damaged stage stutters — unless the viewer asked for reduced motion.
  float flicker() { return 1.0 - uDmg * uMotion * 0.45 * step(0.82, hash(floor(uTime * 14.0))); }
`;

const STAGE_VERT = /* glsl */ `
  varying vec2 vUv; varying vec3 vP; varying vec3 vW; varying vec3 vN;
  void main() {
    vUv = uv; vP = position;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

/* The calibration dial on the deck: graduations that turn with the hull, a glyph band creeping
 * the other way, dashed arcs and a radar sweep. */
const DIAL_FRAG = /* glsl */ `
  varying vec3 vP;
  void main() {
    float r = length(vP.xz);
    float ang = atan(vP.z, vP.x);
    float px = length(fwidth(vP.xz));
    float c = 0.0;
    float a1 = ang - uRot;
    c += spokes(a1, 144.0, 0.09, r, px) * ring(r, 2.27, 2.36, px) * 0.4;
    c += spokes(a1, 24.0, 0.05, r, px) * ring(r, 2.16, 2.36, px) * 1.3;
    c += ring(r, 2.385, 2.40, px) * 0.6 + ring(r, 2.10, 2.112, px) * 0.35;
    // Glyph band: a readout script, rewritten now and then, read by a travelling head.
    float cells = 40.0;
    float ct = fract((ang + uTime * 0.02) / 6.2831853) * cells;
    float cell = floor(ct);
    float cv = (r - 1.76) / 0.28;
    float on = 0.0;
    if (cv > 0.0 && cv < 1.0 && hash(cell * 3.7) > 0.2) {
      vec2 g = vec2(fract(ct) * 4.0 - 0.5, cv * 3.0);
      vec2 gi = floor(g), gf = fract(g);
      if (gi.x >= 0.0 && gi.x < 3.0) {
        float epoch = floor(uTime * 0.3 + hash(cell) * 9.0);
        vec2 e = min(gf, 1.0 - gf);
        on = step(0.45, hash(cell * 13.1 + gi.x * 3.3 + gi.y * 7.9 + epoch * 1.37)) * step(0.1, min(e.x, e.y));
      }
    }
    float head = fract(cell / cells - uTime * 0.06);
    c += on * (0.22 + 1.2 * exp(-head * 14.0));
    // Dashed arcs and the inner lip.
    c += step(0.3, fract((ang - uTime * 0.12) / 6.2831853 * 12.0)) * ring(r, 1.64, 1.68, px) * 0.75;
    c += ring(r, 1.52, 1.535, px) * 0.5 + ring(r, 1.40, 1.43, px) * 1.1;
    float sweep = fract((ang - uTime * 0.7) / 6.2831853);
    c += exp(-sweep * 9.0) * ring(r, 1.43, 1.64, px) * 0.35;
    gl_FragColor = vec4(uColor * c * uK * flicker(), 1.0);
  }
`;

/* The emitter lens: dark glass with fresnel grooves, a seven-bladed iris and a white-hot core. */
const LENS_FRAG = /* glsl */ `
  varying vec3 vP;
  void main() {
    float R = 1.17;
    float rr = length(vP.xz), r = rr / R;
    float ang = atan(vP.z, vP.x);
    float px = length(fwidth(vP.xz)), pr = px / R;
    vec3 e = vec3(0.0);
    e += uColor * (0.5 + 0.5 * cos(r * 110.0)) * 0.035 * smoothstep(0.3, 0.95, r);
    float sp = ang * 7.0 / 6.2831853 + r * 1.6 - uTime * 0.04;
    float aaS = pr * (7.0 / 6.2831853 / max(r, 0.05) + 1.6);
    e += uColor * (1.0 - smoothstep(0.03 - aaS, 0.03 + aaS, abs(fract(sp) - 0.5))) * ring(r, 0.36, 0.86, pr) * 0.4;
    e += uColor * (ring(r, 0.30, 0.325, pr) * 1.8 + ring(r, 0.885, 0.9, pr) * 0.8 + ring(r, 0.965, 0.985, pr) * 1.2);
    e += uColor * spokes(ang - uTime * 0.1, 36.0, 0.07, rr, px) * ring(r, 0.91, 0.95, pr) * 0.8;
    float pulse = 0.9 + 0.1 * sin(uTime * 2.3) + exp(-uShow * 4.0) * 2.5;
    e += mix(uColor, vec3(1.0), 0.6) * exp(-r * r * 160.0) * 2.4 * pulse;
    e += uColor * exp(-r * r * 14.0) * 0.45 * pulse;
    gl_FragColor = vec4(vec3(0.006, 0.009, 0.015) + e * uK * flicker(), 1.0);
  }
`;

/* The light cone: brightest through its heart, rays turning slowly, scan rings climbing. */
const CONE_FRAG = /* glsl */ `
  varying vec2 vUv; varying vec3 vW; varying vec3 vN;
  void main() {
    vec3 V = normalize(cameraPosition - vW);
    float facing = clamp(abs(dot(normalize(vN), V)), 0.0, 1.0);
    float h = clamp(vUv.y, 0.0, 1.0);   // pow() of a negative is NaN, and NaN pixels go black
    float fade = smoothstep(0.0, 0.05, h) * pow(1.0 - h, 1.8);
    float x = vUv.x * 6.2831853;
    float rays = 0.75 + 0.25 * sin(x * 5.0 + uTime * 0.21 + sin(x * 3.0 - uTime * 0.13) * 2.0) * sin(x * 9.0 - uTime * 0.17 + h * 3.0);
    float rise = fract(h * 2.2 - uTime * 0.22);
    float scan = smoothstep(0.0, 0.012, rise) * (1.0 - smoothstep(0.012, 0.06, rise));
    float k = pow(facing, 1.4) * fade * (0.06 + 0.06 * rays + 0.08 * scan) * (1.0 + 1.5 * exp(-h * 9.0)) + exp(-uShow * 3.0) * fade * 0.3 * facing;
    // The bright core rising straight off the lens.
    k += pow(facing, 16.0) * pow(1.0 - h, 2.5) * smoothstep(0.0, 0.03, h) * 0.16;
    gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.2) * k * uK * flicker(), 1.0);
  }
`;

/* A shaft of the key light in the haze: soft across, fading toward the floor and the lamp. */
const SHAFT_FRAG = /* glsl */ `
  varying vec2 vUv; varying vec3 vW; varying vec3 vN;
  void main() {
    vec3 V = normalize(cameraPosition - vW);
    float facing = clamp(abs(dot(normalize(vN), V)), 0.0, 1.0);
    float h = clamp(vUv.y, 0.0, 1.0);
    float drift = 0.8 + 0.2 * sin(vUv.x * 6.2831853 * 3.0 + uTime * 0.07 + h * 4.0);
    float k = pow(facing, 2.0) * smoothstep(0.0, 0.5, h) * (1.0 - smoothstep(0.75, 1.0, h)) * drift * 0.022;
    gl_FragColor = vec4(vec3(1.0, 0.93, 0.84) * k, 1.0);
  }
`;

/* The horizon haze: navy and a breath of plum, warmed by the display's accent behind the stage. */
const HAZE_FRAG = /* glsl */ `
  varying vec3 vW;
  void main() {
    float y = vW.y + 2.3;
    float band = exp(-max(y, 0.0) * 0.1) * smoothstep(-1.0, 3.0, y);
    vec3 d = normalize(vW);
    float behind = smoothstep(0.2, -0.9, d.z);
    vec3 c = mix(vec3(0.05, 0.07, 0.13), vec3(0.11, 0.06, 0.15), 0.5 + 0.5 * sin(atan(d.z, d.x) * 2.0 + 1.3));
    c += uColor * 0.06 * behind;
    gl_FragColor = vec4(c * band * 0.38, 1.0);
  }
`;

/* The target drone's shell: hostile coral, hollow-looking, brightest at its edges, pulsing. */
const DRONE_FRAG = /* glsl */ `
  varying vec3 vW; varying vec3 vN;
  void main() {
    vec3 V = normalize(cameraPosition - vW);
    float fres = pow(clamp(1.0 - abs(dot(normalize(vN), V)), 0.0, 1.0), 2.5);
    float pulse = 0.75 + 0.25 * sin(uTime * 6.0);
    gl_FragColor = vec4(vec3(0.93, 0.42, 0.34) * (0.05 + fres * 0.9) * pulse, 1.0);
  }
`;

/* The glow channel round the drum's foot, two pulses chasing each other through it. */
const GROOVE_FRAG = /* glsl */ `
  varying vec3 vP;
  void main() {
    float r = length(vP.xz);
    float px = length(fwidth(vP.xz));
    float t = fract(atan(vP.z, vP.x) / 6.2831853 - uTime * 0.09);
    float chase = exp(-t * 6.0) + exp(-fract(t + 0.5) * 6.0);
    gl_FragColor = vec4(uColor * ring(r, 2.622, 2.658, px) * (0.5 + 1.8 * chase) * uK * flicker(), 1.0);
  }
`;

/* The drum's readout: words in a 3×3 glyph script, status lamps between them (a few amber). */
const DRUM_FRAG = /* glsl */ `
  varying vec2 vUv;
  void main() {
    float s = fract(vUv.x + uTime * 0.003) * 168.0;
    float id = floor(s), f = fract(s);
    float word = step(0.25, hash(floor(id / 5.0) * 1.7 + 0.3));
    vec2 g = vec2(f * 4.0 - 0.5, vUv.y * 4.0 - 0.5);
    vec2 gi = floor(g);
    float on = 0.0;
    if (gi.x >= 0.0 && gi.x < 3.0 && gi.y >= 0.0 && gi.y < 3.0) {
      float epoch = floor(uTime * 0.5 + hash(id * 0.31) * 20.0);
      on = step(0.5, hash(id * 7.13 + gi.x * 1.31 + gi.y * 2.71 + epoch * 0.173)) * word;
    }
    float lamp = (1.0 - word) * step(0.5, hash(id * 3.1)) * step(abs(f - 0.5), 0.22) * step(abs(vUv.y - 0.5), 0.2);
    float blink = step(0.35, fract(uTime * (0.25 + hash(id) * 0.7) + hash(id * 9.0)));
    vec3 lampC = hash(id * 5.3) > 0.7 ? vec3(0.92, 0.6, 0.22) : uColor;
    gl_FragColor = vec4((uColor * on * 0.5 + lampC * lamp * blink * 1.5) * uK * flicker(), 1.0);
  }
`;

/* Marching lamps round the foot of the plinth. */
const SKIRT_FRAG = /* glsl */ `
  varying vec2 vUv;
  void main() {
    float s = vUv.x * 120.0;
    float id = floor(s), f = fract(s);
    float lamp = step(abs(f - 0.5), 0.16) * step(abs(vUv.y - 0.5), 0.3);
    float lit = 0.2 + 0.8 * step(0.6, fract(uTime * 0.25 - id / 15.0));
    gl_FragColor = vec4(uColor * lamp * lit * 0.9 * uK * flicker(), 1.0);
  }
`;

/* Dust in the light: each mote turns slowly round the axis while it climbs the cone. */
const MOTE_VERT = /* glsl */ `
  attribute vec4 seed;
  uniform float uTime, uPR;
  varying float vA;
  void main() {
    float y = fract(seed.z + uTime * (0.012 + 0.02 * seed.w));
    float r = mix(1.0, 1.9, y) * sqrt(seed.y);
    float a = seed.x + uTime * (0.05 + 0.08 * seed.w) + sin(uTime * 0.3 + seed.x * 3.0) * 0.15;
    vec4 mv = modelViewMatrix * vec4(cos(a) * r, -1.72 + y * 3.6, sin(a) * r, 1.0);
    gl_Position = projectionMatrix * mv;
    float tw = 0.5 + 0.5 * sin(uTime * (0.8 + seed.w * 2.5) + seed.x * 10.0);
    vA = smoothstep(0.0, 0.12, y) * (1.0 - smoothstep(0.55, 1.0, y)) * (0.25 + 0.75 * tw * tw);
    gl_PointSize = (1.0 + 2.6 * seed.w * seed.w) * uPR * (12.0 / -mv.z);
  }
`;
const MOTE_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uK;
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.55) * a * a * vA * 1.2 * uK, 1.0);
  }
`;

/* The hologram skin over the hull: fine raster in world height, a calibration sweep climbing
 * it every few seconds, an arrival sweep, the faction rim on its edges, and interference. */
const HOLO_VERT = /* glsl */ `
  uniform float uH;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying float vH; varying float vY;
  void main() {
    vUv = uv; vH = position.y / max(uH, 1e-3) + 0.5;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vY = w.y;
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - w.xyz);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const HOLO_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying float vH; varying float vY;
  void main() {
    vec4 tex = texture2D(uMap, vUv);
    if (tex.a < 0.5) discard;
    float lum = dot(tex.rgb, vec3(0.3, 0.59, 0.11));
    float lines = pow(max(0.5 + 0.5 * sin(vY * 150.0 - uTime * 2.5), 0.0), 8.0);
    float s = fract(uTime * 0.15) * 1.6 - 0.3;
    float d = vH - s;
    float front = exp(-d * d * 3000.0);
    float wake = d < 0.0 ? exp(d * 9.0) : 0.0;
    float m = clamp(uShow / 0.75, 0.0, 1.0);
    float dm = vH - m * 1.25 + 0.1;
    float arrive = (1.0 - m) * (exp(-dm * dm * 600.0) * 3.0 + (dm < 0.0 ? exp(dm * 5.0) * 0.8 : 0.0));
    float fres = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 3.0);
    float slot = floor(uTime * 7.0);
    float glitch = step(0.94 - uDmg * 0.3, hash(slot)) * step(abs(vH - hash(slot + 3.1)), 0.03 + 0.06 * hash(slot + 7.7)) * uMotion;
    vec3 c = uColor * ((0.03 + lines * 0.1 + front * 1.4 + wake * 0.08 + glitch * 0.5) * (0.3 + lum) + arrive) + uRim * fres * 0.2;
    gl_FragColor = vec4(c * flicker(), 1.0);
  }
`;

/* The polished deck: plates with fine seams, the stage mirrored (blurred a touch, stronger at a
 * glance), light pooling round the plinth, bay markings, and the dark swallowing it far off. */
const FLOOR_SHADER = {
  name: 'CodexDeck',
  uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, uTime: { value: 0 }, uColor: { value: new THREE.Color() } },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vR; varying vec3 vW;
    void main() {
      vR = textureMatrix * vec4(position, 1.0);
      vW = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec3 uColor; uniform float uTime;
    varying vec4 vR; varying vec3 vW;
    float hash2(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
    float ring(float r, float a, float b, float px) { return smoothstep(a - px, a + px, r) * (1.0 - smoothstep(b - px, b + px, r)); }
    void main() {
      vec2 xz = vW.xz;
      float r = length(xz), ang = atan(xz.y, xz.x);
      float px = length(fwidth(xz));
      vec2 q = xz / 2.4;
      vec2 f = abs(fract(q) - 0.5) * 2.4;
      float seam = 1.0 - smoothstep(0.0, 0.012 + px * 1.5, 1.2 - max(f.x, f.y));
      float plate = hash2(floor(q));
      vec2 uv = vR.xy / vR.w + (plate - 0.5) * 0.0015;
      float b = 0.002 + 0.006 * smoothstep(2.0, 14.0, r);
      vec3 refl = texture2D(tDiffuse, uv).rgb * 0.32
        + (texture2D(tDiffuse, uv + vec2(b, 0.0)).rgb + texture2D(tDiffuse, uv - vec2(b, 0.0)).rgb
         + texture2D(tDiffuse, uv + vec2(0.0, b * 1.6)).rgb + texture2D(tDiffuse, uv - vec2(0.0, b * 1.6)).rgb) * 0.17;
      vec3 V = normalize(cameraPosition - vW);
      float fres = 0.05 + 0.95 * pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
      vec3 col = vec3(0.009, 0.012, 0.019) * (0.8 + 0.4 * plate);
      col += refl * mix(0.16, 0.6, fres);
      col *= 1.0 - seam * 0.75;
      col += uColor * 0.06 * exp(-max(r - 3.0, 0.0) * 0.9);
      col *= mix(0.4, 1.0, smoothstep(3.0, 3.5, r));
      float mark = ring(r, 3.42, 3.45, px) * step(0.35, fract(ang / 6.2831853 * 48.0 + uTime * 0.01));
      mark += ring(r, 3.55, 3.75, px) * step(0.86, fract(ang / 6.2831853 * 72.0)) * 0.6;
      mark += ring(r, 5.9, 5.92, px) * 0.35;
      col += uColor * mark * 0.22;
      float alpha = 1.0 - smoothstep(16.0, 34.0, r);
      gl_FragColor = vec4(col, alpha);
    }
  `,
};

function stageMaterial(u: StageUniforms, frag: string, extra: Record<string, THREE.IUniform> = {}, vert = STAGE_VERT, opts: THREE.ShaderMaterialParameters = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uK: { value: 1 }, ...extra },
    vertexShader: vert, fragmentShader: STAGE_HEAD + frag,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    ...opts,
  });
}

/* The pedestal's geometry, lathed once: each profile segment its own band so the chamfers
 * stay crisp. */
let pedestalGeo: { body: THREE.BufferGeometry; dial: THREE.BufferGeometry; lens: THREE.BufferGeometry; cone: THREE.BufferGeometry; groove: THREE.BufferGeometry; drum: THREE.BufferGeometry; skirt: THREE.BufferGeometry; motes: THREE.BufferGeometry } | null = null;
function pedestalGeometry() {
  if (pedestalGeo) return pedestalGeo;
  const P: [number, number][] = [
    [3.0, -2.3], [3.0, -2.26], [2.94, -2.2], [2.94, -2.06], [2.88, -2.01],
    [2.7, -2.01], [2.7, -2.045], [2.58, -2.045], [2.58, -2.01],
    [2.52, -2.01], [2.52, -1.86], [2.45, -1.79], [1.38, -1.79],
    [1.31, -1.73], [1.23, -1.71], [1.17, -1.745], [1.17, -1.76],
  ];
  const bands = P.slice(1).map((p, i) => new THREE.LatheGeometry([new THREE.Vector2(...P[i]), new THREE.Vector2(...p)], 128));
  const body = mergeGeometries(bands)!;
  bands.forEach((b) => b.dispose());
  const flat = (g: THREE.BufferGeometry, y: number) => g.rotateX(-Math.PI / 2).translate(0, y, 0);
  const n = 320;
  const seed = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) seed[i] = Math.random() * (i % 4 === 0 ? Math.PI * 2 : 1);
  const motes = new THREE.BufferGeometry();
  motes.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  motes.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
  pedestalGeo = {
    body,
    dial: flat(new THREE.RingGeometry(1.36, 2.42, 192, 1), -1.787),
    lens: flat(new THREE.CircleGeometry(1.17, 96), -1.752),
    cone: new THREE.CylinderGeometry(2.0, 1.1, 3.7, 72, 1, true).translate(0, -1.75 + 1.85, 0),
    groove: flat(new THREE.RingGeometry(2.6, 2.68, 160, 1), -2.04),
    drum: new THREE.CylinderGeometry(2.523, 2.523, 0.1, 256, 1, true).translate(0, -1.935, 0),
    skirt: new THREE.CylinderGeometry(2.943, 2.943, 0.05, 240, 1, true).translate(0, -2.13, 0),
    motes,
  };
  return pedestalGeo;
}

/** Builds the pedestal into `into`; returns its metal (whose envMap is the studio). */
function buildPedestal(into: THREE.Group, uni: StageUniforms, env: THREE.Texture | null): THREE.MeshPhysicalMaterial {
  const g = pedestalGeometry();
  const metal = new THREE.MeshPhysicalMaterial({ color: 0x1c2330, metalness: 0.88, roughness: 0.34, envMap: env, envMapIntensity: 0.9, clearcoat: 0.35, clearcoatRoughness: 0.16 });
  into.add(new THREE.Mesh(g.body, metal));
  const lens = stageMaterial(uni, LENS_FRAG, {}, STAGE_VERT, { transparent: false, depthWrite: true, blending: THREE.NormalBlending, polygonOffset: false });
  const parts: [THREE.BufferGeometry, THREE.ShaderMaterial][] = [
    [g.lens, lens],
    [g.dial, stageMaterial(uni, DIAL_FRAG)],
    [g.groove, stageMaterial(uni, GROOVE_FRAG)],
    [g.drum, stageMaterial(uni, DRUM_FRAG)],
    [g.skirt, stageMaterial(uni, SKIRT_FRAG)],
    [g.cone, stageMaterial(uni, CONE_FRAG, {}, STAGE_VERT, { side: THREE.DoubleSide, polygonOffset: false })],
  ];
  for (const [geo, mat] of parts) {
    const m = new THREE.Mesh(geo, mat);
    if (geo === g.cone) m.renderOrder = 1;
    into.add(m);
  }
  const motes = new THREE.Points(g.motes, new THREE.ShaderMaterial({
    uniforms: { uTime: uni.uTime, uColor: uni.uColor, uK: { value: 1 }, uPR: PIXEL_RATIO },
    vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  motes.frustumCulled = false;
  motes.renderOrder = 1;
  into.add(motes);
  return metal;
}

/* A dark studio for the metal to reflect: a long overhead softbox (it runs round the bevels as
 * a highlight), two tall strips, a cool line behind and the deck's bounce. Prefiltered once. */
function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture | null {
  // A software rasteriser skips the studio and its prefilter (a dozen render passes): plain lit metal.
  if (softwareGL(renderer)) return null;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020306);
  const geo = new THREE.PlaneGeometry(1, 1);
  const panel = (color: number, k: number, pos: [number, number, number], w: number, hgt: number) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.scale.set(w, hgt, 1);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  panel(0xfff1e2, 2.6, [0, 9, 4], 26, 1.6);
  panel(0xfff1e2, 1.6, [-3, 8, -2], 6, 2);
  panel(0xc4d6ff, 2.2, [-10, 3, 4], 1.2, 8);
  panel(0xc4d6ff, 1.4, [10, 3, 3], 1.2, 8);
  panel(0x7fe0d0, 0.35, [5, 5, -9], 6, 0.5);
  panel(0x10161f, 1, [0, -7, 0], 40, 40);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(scene, 0.03).texture;
  pm.dispose();
  scene.traverse((o) => { if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose(); });
  geo.dispose();
  return tex;
}
