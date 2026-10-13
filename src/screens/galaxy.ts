/* The live galaxy: every planet ever discovered on the Structs testnet,
 * streamed from the LCD and laid out by discovery order; every commander's
 * home world lit in its guild's colour; fleets away on raids drawn as arcs;
 * and the chain's live events flaring where they happen. */
import { academy } from '../game/academy';
import { term } from '../ui/guide';
import { tip } from '../ui/dcbase';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PIXEL_RATIO, type Engine, type Screen } from '../core/engine';
import { copyText, h, hideTooltip, holdNotices, portrait, showTooltip, toast } from '../core/dom';
import { audio } from '../core/audio';
import { wallet } from '../wallet/wallet';
import { openVault } from '../ui/vault';
import { ago, clamp, damp, easeInOutCubic, formatInt, hash32, idIndex, mulberry } from '../core/util';
import { store, type FeedItem, type PlanetLite } from '../chain/store';
import { live } from '../chain/live';
import { lcd } from '../chain/lcd';
const AMBITS_LIST = ['space', 'air', 'land', 'water'] as const;
import { bakeEpoch, bakeScale, createNebulaSky, createStarfield, tickSpace } from '../gfx/space';
import { Effects } from '../gfx/fx';
import type { Planet } from '../gfx/planet';
import { GALAXY_RADIUS, planetPosition } from './galaxyLayout';
import { dailyScenario } from '../sim/fleets';
import { RANKS, record as service, xpFor } from '../game/record';
import { dailyBest, dailyStreak, loadRecord } from './battle/record';
import { latestAttacks, summarize, type CombatRecord } from '../chain/combat';
import { commander } from '../chain/commander';
import { enlisting } from '../game/enlist';
import { startInLobby } from '../core/settings';
import { redirectTo } from '../core/nav';
import { icon, MARK } from '../ui/icons';
import { touchScreen, touchWords } from '../core/touch';
import '../styles/dc-watch.css';

const CAPACITY = 80000;
/** World radius of the selected world when it materializes up close. */
const HERO_R = 1.0;
/** Scratch vectors for per-frame maths (no allocations in the frame loop). */
const S1 = new THREE.Vector3(), S2 = new THREE.Vector3(), S3 = new THREE.Vector3();
const TONE_COLOR: Record<FeedItem['tone'], number> = { player: 0x43cdb6, enemy: 0xee7d69, neutral: 0xebaa49, warn: 0xf3c878, hint: 0x94a4e4 };
const KIND_LABEL: Record<string, string> = { attack: 'Battle', raid: 'Raid', build: 'Build', mine: 'Mine', refine: 'Refine', explore: 'New planet', fleet: 'Fleet', player: 'New player', theft: 'Theft', infuse: 'Fuel', guild: 'Guild', other: 'News' };
/** Each kind of event is a picture in the feed; its word is the row's title. */
const KIND_ICON: Record<string, string> = { attack: 'battle', raid: 'ship', build: 'build', mine: 'ore', refine: 'alpha', explore: 'planet', fleet: 'ship', player: 'star', theft: 'ore', infuse: 'fuel', guild: 'team', other: 'news' };
/** A raid's status as one call. */
const RAID_CALL: Record<string, string> = { 'began a raid on': 'RAID', 'is raiding': 'RAID', breached: 'BREACHED', 'was repelled from': 'REPELLED', demilitarized: 'DEMILITARIZED', 'retreated from': 'RETREAT', 'broke the shields of': 'SHIELDS DOWN' };
/** An icon as a node (its meaning goes in the parent's title). */
const ico = (name: string, size = 16, cls = '') => h('span', { class: 'dw-ico' + (cls ? ' ' + cls : ''), html: icon(name, size) });

/** A feed line cut down to who, what and how much: names and numbers, ▸ between two parties, a
 * call for the result. The store's sentence stays the row's title; one this doesn't recognise
 * is shown as it was said. */
function terse(item: FeedItem): (string | HTMLElement | null)[] {
  const t = item.text;
  const who = (s: string) => h('b', { class: 'fw-who' }, s);
  const to = () => h('span', { class: 'fw-to' }, '▸');
  const n = (v: string, cls = '') => h('b', { class: 'fw-n ' + cls }, v);
  const pic = (name: string, cls = '') => ico(name, 13, 'fw-i ' + cls);
  const said = (w: string, cls = '') => h('span', { class: 'fw-call ' + cls }, w);
  const amb = (a: string) => (AMBITS_LIST as readonly string[]).includes(a) ? pic(a) : a;
  let m: RegExpMatchArray | null;
  switch (item.kind) {
    case 'mine': if ((m = t.match(/^(.+) mined (\d+) ore$/))) return [who(m[1]), n('+' + m[2], 'ore'), pic('ore', 'ore')]; break;
    case 'refine': if ((m = t.match(/^(.+) refined Alpha Matter$/))) return [who(m[1]), n('+', 'alpha'), pic('alpha', 'alpha')]; break;
    case 'infuse': if ((m = t.match(/^(.+) infused Alpha into a generator$/))) return [who(m[1]), pic('alpha', 'alpha'), to(), pic('power')]; break;
    case 'theft': if ((m = t.match(/^(.+) stole (\d+) ore from (.+)$/))) return [who(m[1]), to(), m[3], n('-' + m[2], 'bad'), pic('ore', 'ore')]; break;
    case 'build':
      if ((m = t.match(/^(.+) began building (.+) \((\w+)\)$/))) return [who(m[1]), m[2], amb(m[3]), n('…')];
      if ((m = t.match(/^(.+) completed an? (.+)$/))) return [who(m[1]), m[2], n('✓', 'good')];
      break;
    case 'fleet':
      if ((m = t.match(/^(.+)'s fleet jumped to (.+)$/))) return [who(m[1]), pic('ship'), to(), m[2]];
      if ((m = t.match(/^(.+)'s fleet returned home$/))) return [who(m[1]), pic('ship'), to(), pic('base')];
      if ((m = t.match(/^(.+) moved (.+) to (\w+)$/))) return [who(m[1]), m[2], to(), amb(m[3])];
      break;
    case 'attack':
      if ((m = t.match(/^(.+?)'s .+ fired on .+ of (.+?)(?:: (\d+) dmg)?(, evaded)?(, blocked)?( — DESTROYED)?$/)))
        return [who(m[1]), to(), m[2], m[3] ? n('-' + m[3], 'bad') : null, m[6] ? said('DESTROYED', 'kill') : m[5] ? said('BLOCKED', 'block') : m[4] ? said('EVADED') : null];
      break;
    case 'raid':
      if ((m = t.match(/^(.+) (began a raid on|is raiding|breached|was repelled from|demilitarized|retreated from|broke the shields of) planet (.+)$/)))
        return [who(m[1]), to(), m[3], said(RAID_CALL[m[2]], item.tone === 'player' ? 'good' : 'kill')];
      break;
    case 'explore': if ((m = t.match(/^(.+) discovered planet (.+)$/))) return [who(m[1]), n('+'), m[2]]; break;
    case 'player': if ((m = t.match(/^New commander (.+) came online$/))) return [who(m[1]), said('NEW', 'good')]; break;
    case 'other': if ((m = t.match(/^Planet (.+) is spent/))) return [m[1], said('SPENT')]; break;
    case 'guild':
      if ((m = t.match(/^A new guild is founded: (.+)$/))) return [said('NEW', 'good'), who(m[1])];
      if ((m = t.match(/^Guild (.*) minted tokens/))) return [who(m[1] || '?'), n('+'), pic('bank')];
      break;
  }
  return [t];
}

export class GalaxyScreen implements Screen {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 4000);
  readonly bloom = { strength: 0.85, radius: 0.55, threshold: 0.5 };
  readonly streaks = 0.14;
  private controls: OrbitControls;
  private sky: THREE.Object3D[];
  private dust: THREE.Points;
  private dustColor: Float32Array;
  private dustSize: Float32Array;
  private dustPos: Float32Array;
  private beacons: THREE.Points | null = null;
  private beaconIds: string[] = [];
  private beaconIndex = new Map<string, number>();
  /** Recent activity per home world, decaying over a few minutes. */
  private heat = new Map<string, number>();
  private beaconBase: { size: number; color: THREE.Color }[] = [];
  /** The diffuse galaxy: baked disk sheets, dust, bulge and halo, field stars. */
  private galaxy: Galaxy;
  private fx = new Effects();
  /** One spark layout shared by every fleet's comet (positions come from the shader). */
  private cometGeo = cometGeometry();
  /** The selected world, rendered for real by the shared planet renderer once the camera closes in. */
  private hero: Planet | null = null;
  private heroId: string | null = null;
  private heroK = 0;
  /** Where the hero world sits (cached when the selection changes). */
  private heroPos = new THREE.Vector3();
  private heroBall = new THREE.Sphere();
  /** Seconds the hero has sat hidden; past a while its baked cubes are released. */
  private heroIdle = 0;
  /** The pinned commander's world position, cached by id. */
  private mePos = { id: '', p: new THREE.Vector3() };
  private tint = new THREE.Color();
  private arcs = new THREE.Group();
  private arcMats: THREE.ShaderMaterial[] = [];
  private hoverRing: THREE.Mesh;
  private meRing: THREE.Mesh;
  private meLabel!: HTMLElement;
  private selectRing: THREE.Mesh;
  private root!: HTMLElement;
  private feedEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private guildEl!: HTMLElement;
  private basesEl!: HTMLElement;
  private hotEl!: HTMLElement;
  private combatEl!: HTMLElement;
  private combatAt = 0;
  private combatRecs: CombatRecord[] = [];
  private combatState: 'loading' | 'ok' | 'error' = 'loading';
  /** Battle sites: worlds where the newest attacks were fought, drawn as pulsing red reticles. */
  private sites: THREE.Points | null = null;
  private siteData: { planetId: string; count: number; kills: number; last: CombatRecord }[] = [];
  private hoveredSite: number | null = null;
  private hotTimer = 0;
  private ships: { u: Raid; t: number; speed: number }[] = [];
  private cardEl: HTMLElement | null = null;
  private chartEl!: HTMLElement;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(9, 9);
  private pointerPx = { x: 0, y: 0 };
  private hovered: string | null = null;
  private selected: string | null = null;
  private guildFilter: string | null = null;
  private fly: { from: THREE.Vector3; to: THREE.Vector3; camFrom: THREE.Vector3; camTo: THREE.Vector3; t: number } | null = null;
  private idleT = 0;
  private unsub: (() => void)[] = [];
  private entered = false;
  private retryTimer = 0;
  private combatRetry = 0;
  /** The last roster or survey read failed; cleared when one succeeds. */
  private offline = false;
  private focusTimer = 0;
  private titleShown = false;
  /** The title is up: the HUD waits and the galaxy slides right of the title column. */
  private titleUp = false;
  private titleShift = 0;
  /** Takes the title down (listeners and all), if it is up. */
  private closeTitle: (() => void) | null = null;
  private corePulse = 0;
  private downAt = { x: 0, y: 0 };
  private diveTimer = 0;
  private replay: { t: number; dur: number } | null = null;
  private nameLayer!: HTMLElement;
  private nameTimer = 0;
  private namePool: HTMLElement[] = [];
  private replayEl!: HTMLElement;

  constructor(private engine: Engine, private navigate: (h: string) => void) {
    this.scene.background = new THREE.Color(0x05070b);
    this.sky = [createNebulaSky({ seed: 4.2, intensity: 0.55, radius: 2000 }), createStarfield(7000, 1600, 5)];
    for (const s of this.sky) this.scene.add(s);
    this.camera.position.copy(this.homeView(new THREE.Vector3(0, 120, 210)));
    this.controls = new OrbitControls(this.camera, engine.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 520;
    this.controls.maxPolarAngle = Math.PI * 0.49 + 0.6;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.9;
    this.controls.enabled = false;

    // Precompute every slot's position: positions are a function of index only.
    this.dustPos = new Float32Array(CAPACITY * 3);
    this.dustColor = new Float32Array(CAPACITY * 3);
    this.dustSize = new Float32Array(CAPACITY);
    const v = new THREE.Vector3();
    for (let i = 0; i < CAPACITY; i++) {
      planetPosition(i + 1, v);
      this.dustPos[i * 3] = v.x; this.dustPos[i * 3 + 1] = v.y; this.dustPos[i * 3 + 2] = v.z;
    }
    const g = new THREE.BufferGeometry();
    const order = new Float32Array(CAPACITY);
    for (let i = 0; i < CAPACITY; i++) order[i] = i + 1;
    g.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.dustColor, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.dustSize, 1));
    g.setAttribute('order', new THREE.BufferAttribute(order, 1));
    this.dust = new THREE.Points(g, worldMaterial());
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);

    this.galaxy = buildGalaxy();
    this.scene.add(this.galaxy.group);
    this.scene.add(this.arcs);
    this.scene.add(this.fx.group);

    this.hoverRing = markerMesh(0, 0xd8fff6, 0.95);
    this.hoverRing.visible = false;
    this.scene.add(this.hoverRing);
    this.selectRing = markerMesh(1, 0x43cdb6, 1.6);
    this.selectRing.visible = false;
    this.scene.add(this.selectRing);
    this.meRing = markerMesh(2, 0xebaa49, 1.5);
    this.meRing.visible = false;
    this.scene.add(this.meRing);
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */
  async enter(params: Record<string, string>) {
    this.root = h('div', { class: 'screen galaxy' });
    document.getElementById('ui')!.appendChild(this.root);
    this.buildUi();
    this.controls.enabled = true;
    this.bindInput();
    this.fx.setScale(window.innerHeight, this.camera.fov);

    // However the roster arrives (this screen's retry, a search, a reconnect), a failed archive read retries with it.
    this.unsub.push(store.onCore(() => { this.rebuildBeacons(); this.rebuildArcs(); this.renderStats(); this.renderCombat(); this.buildSites(); if (this.combatState === 'error') void this.loadCombat(); }));
    void this.loadCombat();
    // A live attack refreshes the list.
    // A live attack refreshes the list and the battle sites (after a moment, so the LCD has indexed it).
    let combatTimer = 0;
    this.unsub.push(store.onFeed((item) => {
      if (item.kind !== 'attack' || item.replay || combatTimer) return;
      combatTimer = window.setTimeout(() => { combatTimer = 0; if (this.root.isConnected) { this.combatAt = 0; void this.loadCombat(true); } }, 4000);
    }));
    this.unsub.push(() => clearTimeout(combatTimer));
    this.unsub.push(store.onPlanets((rows) => this.applyPlanets(rows)));
    this.unsub.push(store.onFeed((item) => this.onFeed(item)));
    let beaconTimer = 0;
    this.unsub.push(store.onChange((c) => {
      if (c.kind === 'fleet') this.rebuildArcs();
      // Players change often (every action): batch beacon rebuilds.
      if (c.kind === 'player' && !beaconTimer) beaconTimer = window.setTimeout(() => { beaconTimer = 0; if (this.root.isConnected) this.rebuildBeacons(); }, 3000);
    }));
    this.unsub.push(() => clearTimeout(beaconTimer));
    this.unsub.push(live.onBlock(() => { this.corePulse = 1; this.renderStats(); }));

    const first = !this.entered;
    this.entered = true;
    this.loadData(first);
    if (!first) {
      // Re-entering: paint what is already known.
      this.applyPlanets([...store.planets.values()]);
      if (store.coreLoaded) { this.rebuildBeacons(); this.rebuildArcs(); }
    }
    for (const item of store.feed.slice(-40)) this.addFeedRow(item, false);
    this.renderStats();
    if (params.focus) this.focusTimer = window.setTimeout(() => { if (this.root.isConnected) this.focusPlanet(params.focus, true); }, 400);
    // The title shows once a visit, and again when a screen sends you back to the menu (a battle's
    // Leave sets the flag): you land on the doors, not on the bare map.
    let toMenu = false;
    try { toMenu = sessionStorage.getItem('structs.menu') === '1'; sessionStorage.removeItem('structs.menu'); } catch { /* storage blocked */ }
    // A commander's menu is the Concourse lobby now (unless Settings keeps the doors).
    if (toMenu && wallet.active?.playerId && startInLobby()) { this.titleShown = true; redirectTo('/lobby'); return; }
    // "Watch" from the Concourse: the live galaxy itself, no title in the way (once).
    let watch = false;
    try { watch = sessionStorage.getItem('structs.watch') === '1'; sessionStorage.removeItem('structs.watch'); } catch { /* storage blocked */ }
    if (watch && !toMenu) { this.titleShown = true; return; }
    if ((!this.titleShown || toMenu) && !this.titleUp) { this.titleShown = true; if (!params.focus) this.showTitle(); }
  }

  /** Roster and planets; a failure retries every 15 s while the galaxy is on screen. */
  private loadData(announce: boolean) {
    clearTimeout(this.retryTimer);
    // One pending retry at most: both reads may fail, and a slow failure may land after a newer attempt.
    const retry = () => { clearTimeout(this.retryTimer); this.retryTimer = window.setTimeout(() => { if (!this.root?.isConnected) return; this.loadData(false); if (this.combatState === 'error') void this.loadCombat(); }, 15000); };
    // Recent history replays once per session, whichever screen loaded the roster first.
    if (!store.coreLoaded) void store.loadCore().then(() => { this.offline = false; return store.backfill(); }).catch(() => { this.markOffline(); retry(); }); // main already announced the outage
    else void store.backfill();
    if (!store.planetsLoaded) void store.loadPlanets().then(() => { this.offline = false; this.chartEl.textContent = ''; this.renderStats(); if (this.combatState === 'error') void this.loadCombat(); }).catch(() => { if (announce && store.coreLoaded) toast('Planet survey interrupted; retrying', 'warn'); this.markOffline(); retry(); });
  }

  /** Say so where the loading text would otherwise wait forever. */
  private markOffline() {
    if (!this.root?.isConnected) return;
    this.offline = true;
    if (!store.planetsLoaded && this.chartEl) { this.chartEl.textContent = 'Galaxy not answering'; this.chartEl.title = 'The galaxy is not answering right now · trying again every 15 s'; }
    if (!store.planets.size && this.basesEl) this.basesEl.replaceChildren(h('div', { class: 't-tiny c-hint', title: 'Waiting for the testnet' }, 'Waiting…'));
  }

  exit() {
    document.body.classList.remove('press-start');
    holdNotices(false);
    clearTimeout(this.diveTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.combatRetry);
    clearTimeout(this.focusTimer);
    // Leave nothing selected behind (the ring, the paused idle drift).
    this.selected = null;
    this.hovered = null;
    this.hoverRing.visible = false;
    this.selectRing.visible = false;
    // Free the hero's baked cubes while other screens allocate their own (the next draw repaints).
    if (this.hero) { this.hero.group.visible = false; this.hero.release(); }
    this.heroK = 0;
    this.heroIdle = Infinity;
    this.controls.enabled = false;
    this.unsub.forEach((f) => f());
    this.unsub = [];
    hideTooltip();
    this.closeTitle?.();
    this.root.remove();
    this.titleUp = false;
    this.titleShift = 0;
    this.camera.clearViewOffset();
    this.cardEl = null;
    this.engine.canvas.style.cursor = 'default';
  }

  resize(_w: number, hgt: number) { this.fx.setScale(hgt, this.camera.fov); }

  /** A whole-galaxy viewpoint along `dir`, backed off on narrow (portrait) screens so the rim fits. */
  private homeView(dir: THREE.Vector3) {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    const dist = clamp(GALAXY_RADIUS * 0.9 / (t * aspect), dir.length(), 500);
    return dir.clone().setLength(dist);
  }

  /* ── Data → points ────────────────────────────────────────────────────── */
  private applyPlanets(rows: PlanetLite[]) {
    const geo = this.dust.geometry;
    let minI = Infinity, maxI = -1;
    for (const p of rows) {
      const i = p.index - 1;
      if (i < 0 || i >= CAPACITY) continue;
      const c = this.dustTint(p, this.tint);
      this.dustColor[i * 3] = c.r; this.dustColor[i * 3 + 1] = c.g; this.dustColor[i * 3 + 2] = c.b;
      this.dustSize[i] = p.active ? 1.5 : 0.75;
      if (i < minI) minI = i;
      if (i > maxI) maxI = i;
    }
    if (maxI < 0) return;
    (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    if (!store.planetsLoaded && !(this.offline && !store.planetsProgress)) this.chartEl.textContent = `Charting the galaxy · ${formatInt(store.planetsProgress)} worlds`;
    this.renderStats();
    this.renderBases();
  }

  /** A world's dust colour: guild-lit when owned and alive, silver when free, dim when spent;
   * owned worlds outside the guild filter fall back into the dark. */
  private dustTint(p: PlanetLite, out: THREE.Color) {
    if (!p.active) return out.setRGB(0.075, 0.09, 0.13);
    if (!p.owner) return out.setRGB(0.55, 0.6, 0.7);
    const g = store.players.get(p.owner)?.guildId || '';
    out.set(store.guildColor(g)).multiplyScalar(0.55);
    return this.guildFilter && g !== this.guildFilter ? out.multiplyScalar(0.15) : out;
  }

  private rebuildBeacons() {
    if (this.beacons) { this.scene.remove(this.beacons); this.beacons.geometry.dispose(); (this.beacons.material as THREE.Material).dispose(); }
    const ids: string[] = [];
    const pos: number[] = [], col: number[] = [], size: number[] = [], phase: number[] = [];
    const v = new THREE.Vector3();
    this.beaconBase = [];
    for (const p of store.players.values()) {
      if (!p.planetId) continue;
      const idx = idIndex(p.planetId);
      if (!idx) continue;
      planetPosition(idx, v);
      ids.push(p.planetId);
      pos.push(v.x, v.y, v.z);
      const c = new THREE.Color(store.guildColor(p.guildId));
      const lite = store.planets.get(p.planetId);
      const s = 2.4 + Math.min(16, lite?.structs ?? 4) * 0.12;
      col.push(c.r, c.g, c.b);
      size.push(s);
      phase.push(Math.random() * 6.28);
      this.beaconBase.push({ size: s, color: c });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.Float32BufferAttribute(size, 1));
    g.setAttribute('phase', new THREE.Float32BufferAttribute(phase, 1));
    g.setAttribute('heat', new THREE.Float32BufferAttribute(new Float32Array(ids.length), 1).setUsage(THREE.DynamicDrawUsage));
    this.beaconIndex = new Map(ids.map((id, i) => [id, i]));
    this.beacons = new THREE.Points(g, beaconMaterial());
    this.beacons.frustumCulled = false;
    this.beacons.visible = !this.replay;
    this.beaconIds = ids;
    this.scene.add(this.beacons);
    this.applyGuildFilter();
    this.renderGuilds();
  }

  private applyGuildFilter() {
    if (!this.beacons) return;
    const col = this.beacons.geometry.attributes.color as THREE.BufferAttribute;
    const size = this.beacons.geometry.attributes.size as THREE.BufferAttribute;
    this.beaconIds.forEach((pid, i) => {
      const owner = store.homeOf.get(pid);
      const g = owner ? store.players.get(owner)?.guildId : '';
      const on = !this.guildFilter || g === this.guildFilter;
      const b = this.beaconBase[i];
      col.setXYZ(i, b.color.r * (on ? 1 : 0.15), b.color.g * (on ? 1 : 0.15), b.color.b * (on ? 1 : 0.15));
      size.setX(i, b.size * (on ? (this.guildFilter ? 1.3 : 1) : 0.6));
    });
    col.needsUpdate = true; size.needsUpdate = true;
    // The dust under each home world follows suit, or it would draw the same world at full colour.
    for (const p of store.planets.values()) {
      const i = p.index - 1;
      if (!p.owner || !p.active || i < 0 || i >= CAPACITY) continue;
      const c = this.dustTint(p, this.tint);
      this.dustColor[i * 3] = c.r; this.dustColor[i * 3 + 1] = c.g; this.dustColor[i * 3 + 2] = c.b;
    }
    (this.dust.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  private rebuildArcs() {
    // Route lines and trail tubes own their geometry; the comet sparks share this.cometGeo.
    for (const c of [...this.arcs.children]) {
      this.arcs.remove(c);
      if (c instanceof THREE.Mesh || c instanceof THREE.Line) c.geometry.dispose();
    }
    this.ships = [];
    this.arcMats.forEach((m) => m.dispose());
    this.arcMats = [];
    for (const f of store.fleets.values()) {
      if (f.status !== 'away') continue;
      const home = store.playerPlanet(f.owner);
      if (!home || !f.locationId) continue;
      const a = planetPosition(idIndex(home)), b = planetPosition(idIndex(f.locationId));
      const mid = a.clone().lerp(b, 0.5);
      mid.y += 6 + a.distanceTo(b) * 0.25;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const len = Math.max(1, curve.getLength());
      const U = raidUniforms(len);
      const route = routeLine(curve, len, 0xee7d69, U);
      const trail = trailMaterial(0xee7d69, U), comet = cometMaterial(curve, U);
      this.arcMats.push(route.material as THREE.ShaderMaterial, trail, comet);
      route.userData.fleet = f.id;
      this.arcs.add(route);
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(200, 48 + Math.round(len * 1.5)), TRAIL_R, 8, false), trail);
      mesh.frustumCulled = false;
      mesh.userData.fleet = f.id;
      this.arcs.add(mesh);
      this.arcs.visible = !this.replay;
      const head = new THREE.Points(this.cometGeo, comet);
      head.frustumCulled = false;
      head.renderOrder = 1;
      this.arcs.add(head);
      this.ships.push({ u: U, t: Math.random(), speed: 0.12 + Math.random() * 0.06 });
    }
  }

  /* ── Live events on the map ───────────────────────────────────────────── */
  private warm(planetId: string | undefined, amount: number) {
    if (!planetId) return;
    this.heat.set(planetId, Math.min(1.5, (this.heat.get(planetId) || 0) + amount));
  }

  private onFeed(item: FeedItem) {
    // Replayed history warms by recency (a ten-minute half-life of sorts); live events at full strength.
    const recency = item.replay ? Math.exp(-(Date.now() - item.at) / 600000) : 1;
    this.warm(item.planetId, (item.kind === 'attack' || item.kind === 'raid' || item.kind === 'theft' ? 0.9 : 0.35) * recency);
    this.addFeedRow(item, !item.replay);
    if (!item.planetId || item.replay) return;
    const idx = idIndex(item.planetId);
    if (!idx) return;
    const p = planetPosition(idx);
    const color = TONE_COLOR[item.tone];
    const dist = this.camera.position.distanceTo(p);
    const k = Math.max(1, dist / 60);
    switch (item.kind) {
      case 'attack':
        this.fx.flare(p, 0xff6a50, 5 * k, 0.6);
        this.fx.ring(p, 0xff5040, 4 * k, 0.9, new THREE.Vector3(0, 1, 0));
        this.fx.particles.burst(p, 24, { speed: 2 * k, color: [0xff6a50, 0xffd27a], size: 0.4 * k, life: 0.7 });
        if (dist < 160) audio.play('laser', 0.35);
        break;
      case 'raid': case 'theft':
        this.fx.ring(p, 0xee7d69, 7 * k, 1.4, new THREE.Vector3(0, 1, 0));
        this.fx.flare(p, 0xee7d69, 7 * k, 1.0);
        audio.play('alert');
        break;
      case 'explore':
        this.fx.ring(p, 0xebaa49, 6 * k, 1.6, new THREE.Vector3(0, 1, 0));
        this.fx.flare(p, 0xffe0a0, 6 * k, 1.2);
        audio.play('ping', 0.6);
        break;
      default:
        this.fx.ring(p, color, 2.5 * k, 0.8, new THREE.Vector3(0, 1, 0));
        this.fx.flare(p, color, 2.2 * k, 0.5);
    }
    if (item.kind === 'fleet') this.rebuildArcs();
  }

  private addFeedRow(item: FeedItem, animate: boolean) {
    if (!this.feedEl) return;
    const tone = item.tone === 'player' ? 'c-player' : item.tone === 'enemy' ? 'c-enemy' : item.tone === 'neutral' ? 'c-neutral' : item.tone === 'warn' ? 'c-warn' : 'c-secondary';
    const when = h('span', { class: 'when', 'data-at': String(item.at), title: 'block #' + formatInt(item.height) }, ago(Date.now() - item.at));
    // A picture for the kind (its word in the title), then who, what and how much.
    const kind = KIND_LABEL[item.kind] || 'Event';
    const row = h('div', { class: 'feed-row', style: animate ? '' : 'animation:none', title: `${kind}: ${item.text}${item.planetId ? '\nFly to ' + item.planetId : ''}` },
      when,
      h('span', { class: 'fw-kind ' + tone, role: 'img', 'aria-label': kind, html: icon(KIND_ICON[item.kind] || 'news', 16) }),
      // Names hold their width; the words between them give way first on a narrow feed.
      h('div', { class: 'what' }, ...terse(item).map((x) => (typeof x === 'string' ? h('span', { class: 'fw-t' }, x) : x))),
      // Attacks can be watched again, staged from their EventAttack.
      item.kind === 'attack' && item.hash ? h('button', { class: 'feed-watch', title: 'Replay this attack in the combat theatre', 'aria-label': 'Watch this attack', onclick: (e: Event) => { e.stopPropagation(); audio.play('select'); this.navigate('/combat/' + item.hash); } }, ico('play', 12)) : null);
    if (item.planetId) row.addEventListener('click', () => { audio.play('select'); this.focusPlanet(item.planetId!, true); });
    // Newest first: live rows go on top; history slots in below anything newer.
    row.dataset.h = String(item.height);
    const after = item.replay ? [...this.feedEl.children].find((c) => Number((c as HTMLElement).dataset.h) < item.height) : this.feedEl.firstElementChild;
    this.feedEl.insertBefore(row, after || null);
    while (this.feedEl.children.length > 120) this.feedEl.lastElementChild?.remove();
    const empty = this.root.querySelector('.feed-empty');
    if (empty) empty.remove();
  }

  /* ── UI ───────────────────────────────────────────────────────────────── */
  private buildUi() {
    this.statsEl = h('div', { class: 'dw-tiles galaxy-stats' });
    this.guildEl = h('div', { class: 'col', style: 'gap:2px' });
    this.chartEl = h('div', { class: 't-tiny c-hint chart-progress', title: 'Charting the galaxy' }, store.planetsLoaded ? '' : 'Charting…');
    // A section: its picture and one word; what it lists is its title.
    const sec = (ico_: string, word: string, title: string, btn?: HTMLElement) => h('div', { class: 'dw-sec', title }, ico(ico_, 16), h('span', { class: 't-label' }, word), btn || null);
    // On a phone the panel starts folded (the map is the point), unless the player opened it before.
    let leftShut = matchMedia('(max-width: 760px) and (pointer: coarse)').matches;
    try { if (localStorage.getItem('structs.galaxy.left') === '1') leftShut = false; } catch { /* ignore */ }
    const left = h('div', { class: 'galaxy-left panel' + (leftShut ? ' shut' : '') },
      h('div', { class: 'panel-head', title: 'Every planet anyone has found: the oldest in the middle, the newest at the edge. Lit planets are players’ homes, in their guild’s colour. Red lines are fleets out raiding. Click any planet.' },
        h('span', { class: 'dw-head' }, ico('explore', 20), h('span', { class: 't-label' }, h('span', { class: 'x-only' }, 'Testnet'), h('span', { class: 's-only' }, 'Galaxy'))),
        h('span', { class: 'chip player' }, h('span', { class: 'dot pulse' }), 'Live'),
        // Phones only (CSS): the panel folds to its head, so the map has the screen.
        h('button', { type: 'button', class: 'dw-fold', 'aria-label': 'Show or hide the galaxy panel', 'aria-expanded': String(!leftShut), onclick: (e: Event) => {
          const shut = left.classList.toggle('shut');
          (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!shut));
          try { localStorage.setItem('structs.galaxy.left', shut ? '0' : '1'); } catch { /* ignore */ }
          audio.play('select');
        } }, ico('down', 18))),
      this.leftBody = h('div', { class: 'panel-body col', onscroll: () => this.edgeFade() },
        this.statsEl,
        this.chartEl,
        sec('team', 'Guilds', 'Guilds by members: pick one to light up its worlds', h('button', { class: 'btn ghost mini', title: 'Show every guild', onclick: () => { this.guildFilter = null; this.applyGuildFilter(); this.renderGuilds(); } }, 'All')),
        this.guildEl,
        sec('hot', 'Busiest', 'The planets with the most going on right now'),
        this.hotEl = h('div', { class: 'col', style: 'gap:2px' }, h('div', { class: 't-tiny c-hint', title: 'Nothing has happened yet' }, 'Quiet')),
        sec('battle', 'Combat', 'The newest attacks: pick one to watch the fight', h('button', { class: 'btn ghost mini', title: 'Every battle', onclick: () => { audio.play('select'); this.navigate('/combat'); } }, 'All ▸')),
        this.combatEl = h('div', { class: 'col', style: 'gap:2px' }, h('div', { class: 't-tiny c-hint', title: 'Reading the combat archive' }, 'Loading…')),
        sec('base', 'Bases', 'The largest bases, by structs built'),
        this.basesEl = h('div', { class: 'col', style: 'gap:2px' }, h('div', { class: 't-tiny c-hint' }, 'Surveying…')),
      ));
    this.feedEl = h('div', { class: 'feed scroll' });
    // The feed folds to its head by default: events already flare on the map, so the list is one
    // press away (remembered), with a count of what landed while it was shut.
    let feedOpen = false;
    try { feedOpen = localStorage.getItem('structs.galaxy.feed') === '1'; } catch { /* ignore */ }
    const unseen = h('span', { class: 'dw-unseen', hidden: true });
    let fresh = 0;
    // The first seconds are the backfill of recent blocks, not news: only what lands after counts.
    const born = Date.now();
    new MutationObserver((recs) => {
      if (feedOpen || Date.now() - born < 10000) return;
      fresh += recs.reduce((n, r) => n + r.addedNodes.length, 0);
      unseen.hidden = !fresh; unseen.textContent = fresh > 99 ? '99+' : String(fresh);
    }).observe(this.feedEl, { childList: true });
    const toggleFeed = () => {
      feedOpen = !feedOpen; fresh = 0; unseen.hidden = true;
      try { localStorage.setItem('structs.galaxy.feed', feedOpen ? '1' : '0'); } catch { /* ignore */ }
      right.classList.toggle('shut', !feedOpen);
      feedHead.setAttribute('aria-expanded', String(feedOpen));
      audio.play('select');
    };
    const feedHead = h('button', { type: 'button', class: 'panel-head dw-feed-head', 'aria-expanded': String(feedOpen), title: 'Builds, mining, raids and attacks across the galaxy, as blocks land. Click one to fly there.', onclick: toggleFeed },
        h('span', { class: 'dw-head' }, ico('news', 20), h('span', { class: 't-label' }, 'Activity'), unseen),
        h('span', { class: 'chip x-only' }, 'tm.event=Tx'), h('span', { class: 'chip player s-only dw-live', title: 'Live', 'aria-label': 'Live' }, h('span', { class: 'dot pulse' })));
    const right = h('div', { class: 'galaxy-right panel' + (feedOpen ? '' : ' shut') },
      feedHead,
      h('div', { class: 'feed-empty t-tiny c-hint', title: 'Replaying the last few hundred blocks, then listening live: builds, mining, raids and attacks appear here as blocks land.' }, 'Listening…'),
      this.feedEl);
    this.replayEl = h('div', { class: 'replay-label t-label c-neutral' });
    const replayBtn = h('button', { class: 'btn ghost mini', title: 'Watch the galaxy grow, from the very first planet to today (H)', onclick: () => this.startReplay() }, ico('play', 12), 'History');
    // The legend: each mark as it looks on the map, beside a picture of what it means (the words are titles).
    const mark = (cls: string, pic: string, label: string, extra = '') => h('span', { class: 'dw-sw ' + extra, title: label, role: 'img', 'aria-label': label }, h('i', { class: 'lg ' + cls }), ico(pic, 14));
    const legend = h('div', { class: 'galaxy-legend t-tiny c-hint' }, replayBtn,
      mark('lg-home', 'base', 'Player’s home, in their guild’s colour'), mark('lg-dead', 'planet', 'Used-up planet: its ore ran out'),
      mark('lg-raid', 'ship', 'Fleet out raiding'), mark('lg-hot', 'hot', 'Busy right now'), mark('lg-site', 'battle', 'Recent battle: click it to watch'),
      h('span', { class: 'legend-hint dw-sw', title: touchWords('Drag to spin · wheel to zoom · click a planet'), role: 'img', 'aria-label': touchWords('Drag to spin, wheel to zoom, click a planet') }, ico(touchScreen() ? 'refresh' : 'mouse', 15), h('span', { class: 'dw-sw-k' }, '↻ ±')));
    this.meLabel = h('button', { class: 'me-label t-label', onclick: () => { const p = commander.state?.planetId; if (p) { audio.play('select'); this.focusPlanet(p, true); } } }, 'You');
    this.nameLayer = h('div', { class: 'name-layer' });
    this.root.append(this.nameLayer, left, right, legend, this.replayEl, this.meLabel);
    this.namePool = [];
  }

  /** The left panel's list scrolls: its bottom edge fades while there is more below. */
  private leftBody!: HTMLElement;
  private edgeFade() {
    const b = this.leftBody;
    if (b) b.classList.toggle('more-below', b.scrollHeight - b.scrollTop - b.clientHeight > 4);
  }

  /** The stat tiles, made once per visit; each block only changes their numbers (so a tile in focus,
   * or with its meaning up, stays put). */
  private stats: Record<string, { el: HTMLElement; n: HTMLElement; pic: HTMLElement; name: (v: string) => string }> = {};
  private renderStats() {
    if (!this.statsEl) return;
    let active = 0;
    for (const p of store.planets.values()) if (p.active) active++;
    let away = 0;
    for (const f of store.fleets.values()) if (f.status === 'away') away++;
    if (!this.statsEl.firstChild) {
      this.stats = {};
      // A tile: a picture and a number. Pointing at it, tapping it or giving it focus (a pad, the
      // keyboard) shows its name and what it means; a screen reader reads both.
      // On the TV and phones (no hover) each tile also carries its word, small, under the number.
      const cap = (word: string) => h('span', { class: 'dw-cap', 'aria-hidden': 'true' }, word);
      const tile = (key: string, pic: string, label: string, hint: string, word: string, box = '') => {
        const p = h('span', { class: 'dw-ico', html: icon(pic, 18) }), n = h('b', { class: 'num' }, '…');
        const el = tip(h('div', { class: 'dw-tile ' + box, tabindex: 0 }, p, n, cap(word)), label, hint);
        this.stats[key] = { el, n, pic: p, name: (v) => `${label} ${v}` };
        return el;
      };
      // A tile that is also a glossary word: the glossary's own tip explains it.
      const word = (key: string, pic: string, label: string, short: string, box = '') => {
        const el = term(key, label, 'dw-tile ' + box);
        const said = el.getAttribute('aria-label') || label;
        const p = h('span', { class: 'dw-ico', html: icon(pic, 18) }), n = h('b', { class: 'num' }, '…');
        el.replaceChildren(p, n, cap(short));
        this.stats[key] = { el, n, pic: p, name: (v) => `${v} · ${said}` };
        return el;
      };
      this.statsEl.replaceChildren(
        tile('players', 'team', 'Commanders', 'Every player in the galaxy', 'Players'),
        tile('worlds', 'planet', 'Worlds discovered', 'Every planet anyone has found', 'Worlds'),
        tile('active', 'base', 'Worlds in use', 'Planets still in play: their ore isn’t used up', 'Active'),
        word('raid', 'ship', 'Fleets raiding now', 'Raiding'),
        word('block', 'clock', 'Block', 'Block', 'x-only'),
        tile('blockTime', 'gauge', 'Block time', 'Seconds between blocks', 'Pace', 'x-only'));
    }
    const set = (key: string, value: string, cls = '') => {
      const t = this.stats[key];
      if (!t) return;
      // Still on its way from the chain: a signal meter where the number will land (dc-polish.css).
      if (value === '…') {
        if (!t.n.querySelector('.dcp-bars')) t.n.replaceChildren(h('span', { class: 'dcp-bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')));
        t.el.setAttribute('aria-label', t.name('loading'));
        return;
      }
      t.n.textContent = value;
      t.n.className = 'num ' + cls;
      t.pic.className = 'dw-ico ' + cls;
      t.el.setAttribute('aria-label', t.name(value));
    };
    set('players', store.coreLoaded ? formatInt(store.players.size) : '…', 'c-player');
    set('worlds', store.maxPlanetIndex ? formatInt(store.maxPlanetIndex) : '…', 'c-neutral');
    set('active', store.planetsLoaded ? formatInt(active) : '…');
    set('raid', store.coreLoaded ? String(away) : '…', away ? 'c-enemy' : '');
    set('block', live.height ? formatInt(live.height) : '…');
    set('blockTime', live.lastBlockAt ? live.blockTime.toFixed(1) + ' s' : '…');
  }

  private renderGuilds() {
    if (!this.guildEl) return;
    const rows: HTMLElement[] = [...store.guilds.values()].sort((a, b) => store.members(b.id) - store.members(a.id)).map((g) => {
      const c = '#' + new THREE.Color(store.guildColor(g.id)).getHexString();
      const n = store.members(g.id);
      return h('button', {
        class: 'guild-row' + (this.guildFilter === g.id ? ' active' : ''), title: `${store.guildName(g.id)} · ${formatInt(n)} members: light up their worlds`, 'aria-pressed': this.guildFilter === g.id ? 'true' : 'false',
        onclick: () => { audio.play('select'); this.guildFilter = this.guildFilter === g.id ? null : g.id; this.applyGuildFilter(); this.renderGuilds(); },
      }, h('i', { class: 'swatch', style: `background:${c}; box-shadow:0 0 8px ${c}` }), h('span', { class: 'grow dw-ell' }, store.guildName(g.id)), h('span', { class: 'num dw-num' }, ico('team', 13), formatInt(n)));
    });
    let solo = 0;
    for (const p of store.players.values()) if (!p.guildId) solo++;
    if (solo) rows.push(h('div', { class: 'guild-row static', title: `${formatInt(solo)} commanders in no guild` }, h('i', { class: 'swatch', style: 'background:#7394A5' }), h('span', { class: 'grow' }, 'Independent'), h('span', { class: 'num dw-num' }, ico('team', 13), formatInt(solo))));
    this.guildEl.replaceChildren(...rows);
  }

  private startReplay() {
    if (!store.planets.size) { toast('Still charting the galaxy…', 'warn', 1400); return; }
    audio.play('warp', 0.7);
    this.replay = { t: 0, dur: 14 };
    this.select(null);
    // Pull back to see the whole disk grow.
    this.fly = { from: this.controls.target.clone(), to: new THREE.Vector3(0, 0, 0), camFrom: this.camera.position.clone(), camTo: this.homeView(new THREE.Vector3(0, 190, 150)), t: 0 };
    if (this.beacons) this.beacons.visible = false;
    this.arcs.visible = false;
  }

  /* Worlds with the most recent activity, hottest first. */
  private renderHot() {
    if (!this.hotEl) return;
    // Every 2 s with the hot list: the lists above it may have grown or shrunk too.
    this.edgeFade();
    const top = [...this.heat.entries()].filter(([, v]) => v > 0.05).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (!top.length) { this.hotEl.replaceChildren(h('div', { class: 't-tiny c-hint', title: 'Nothing has happened yet' }, 'Quiet')); return; }
    this.hotEl.replaceChildren(...top.map(([pid, v]) => {
      const owner = store.homeOf.get(pid) || store.planets.get(pid)?.owner || '';
      return h('button', { class: 'guild-row', title: `Fly to ${pid}`, onclick: () => { audio.play('select'); this.focusPlanet(pid, true); } },
        h('i', { class: 'swatch', style: `background:#ff8c59; opacity:${(0.35 + Math.min(1, v) * 0.65).toFixed(2)}; box-shadow:0 0 ${Math.round(4 + v * 8)}px #ff8c59` }),
        h('span', { class: 'grow', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, owner ? store.playerName(owner) : pid),
        h('span', { class: 'num c-hint' }, pid));
    }));
  }

  /** The last few attacks on the chain, each a link into the combat theatre. */
  private async loadCombat(force = false) {
    if (force || Date.now() - this.combatAt > 60000) {
      this.combatAt = Date.now();
      try { this.combatRecs = await latestAttacks(force); this.combatState = 'ok'; } catch { this.combatAt = 0; this.combatState = this.combatRecs.length ? 'ok' : 'error'; }
      // The archive can fail alone (a slow tx search while the roster is fine): it retries on its own.
      clearTimeout(this.combatRetry);
      if (this.combatState === 'error' && this.root?.isConnected) this.combatRetry = window.setTimeout(() => { if (this.root?.isConnected && this.combatState === 'error') void this.loadCombat(); }, 15000);
    }
    this.renderCombat();
    this.buildSites();
  }

  /** Aggregate the newest attacks by the world they were fought over. */
  private buildSites() {
    if (this.sites) { this.scene.remove(this.sites); this.sites.geometry.dispose(); (this.sites.material as THREE.Material).dispose(); this.sites = null; }
    if (!this.combatRecs.length || !store.coreLoaded) return;
    const by = new Map<string, { planetId: string; count: number; kills: number; last: CombatRecord }>();
    for (const r of this.combatRecs) {
      const shot = r.attack.eventAttackShotDetail?.[0];
      const pid = store.planetOfLocation(shot?.targetStructLocationId) || store.planetOfLocation(r.attack.attackerStructLocationId);
      if (!pid || !idIndex(pid)) continue;
      const e = by.get(pid) || { planetId: pid, count: 0, kills: 0, last: r };
      e.count++;
      e.kills += (r.attack.eventAttackShotDetail || []).filter((x) => x.targetDestroyed).length;
      if (r.height > e.last.height) e.last = r;
      by.set(pid, e);
    }
    this.siteData = [...by.values()];
    if (!this.siteData.length) return;
    const pos = new Float32Array(this.siteData.length * 3), size = new Float32Array(this.siteData.length), phase = new Float32Array(this.siteData.length);
    const v = new THREE.Vector3();
    this.siteData.forEach((e, i) => {
      planetPosition(idIndex(e.planetId), v);
      pos.set([v.x, v.y + 0.2, v.z], i * 3);
      size[i] = 22 + Math.min(28, Math.sqrt(e.count) * 6);
      phase[i] = (hash32(e.planetId) % 628) / 100;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    g.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
    this.sites = new THREE.Points(g, siteMaterial());
    this.sites.frustumCulled = false;
    this.sites.renderOrder = 5;
    this.scene.add(this.sites);
  }

  private pickSite(): number | null {
    if (!this.sites || this.pointer.x > 2 || this.replay) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const d = this.camera.position.distanceTo(this.controls.target);
    this.raycaster.params.Points = { threshold: Math.max(0.8, d * 0.02) };
    const hits = this.raycaster.intersectObject(this.sites, false);
    if (!hits.length) return null;
    hits.sort((a, b) => (a.distanceToRay ?? 0) - (b.distanceToRay ?? 0));
    return hits[0].index ?? null;
  }

  private renderCombat() {
    if (!this.combatEl) return;
    if (!this.combatRecs.length) {
      this.combatEl.replaceChildren(h('div', { class: 't-tiny c-hint' }, this.combatState === 'loading' ? 'Loading…' : this.combatState === 'ok' ? 'No attacks yet' : 'Archive could not be read'));
      return;
    }
    // Each fight: its result as a picture (destroyed, hit, nothing), attacker ▸ target, how long ago.
    this.combatEl.replaceChildren(...this.combatRecs.slice(0, 4).map((r) => {
      const s = summarize(r.attack, (id) => store.playerName(id));
      const at = Date.parse(r.time);
      const target = r.attack.eventAttackShotDetail?.[0]?.targetPlayerId;
      return h('button', { class: 'guild-row', title: `${s.title} — ${s.result}`, onclick: () => { audio.play('select'); this.navigate('/combat/' + r.hash + '/e'); } },
        ico(s.tone === 'kill' ? 'boom' : s.tone === 'hit' ? 'target' : 'shield', 14, 'dw-res-' + s.tone),
        h('span', { class: 'grow dw-ell' }, h('b', null, store.playerName(r.attack.attackerPlayerId)), h('span', { class: 'fw-to' }, '▸'), target ? store.playerName(target) : '—'),
        h('span', { class: 'num c-hint' }, Number.isFinite(at) ? ago(Date.now() - at) : '#' + r.height));
    }));
  }

  private renderBases() {
    if (!this.basesEl || !store.planets.size) return;
    const top = [...store.planets.values()].filter((p) => p.active && p.owner).sort((a, b) => b.structs - a.structs || a.index - b.index).slice(0, 6);
    this.basesEl.replaceChildren(...top.map((p) => h('button', { class: 'guild-row', title: `${store.playerName(p.owner)} · ${p.structs} structs on ${p.id}`, onclick: () => { audio.play('select'); this.focusPlanet(p.id, true); } },
      h('i', { class: 'swatch', style: `background:#${new THREE.Color(store.guildColor(store.players.get(p.owner)?.guildId || '')).getHexString()}` }),
      h('span', { class: 'grow', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, store.playerName(p.owner)),
      h('span', { class: 'num dw-num' }, ico('build', 13), String(p.structs)))));
  }

  /** The front door, Dreamcast style: the logo over the live galaxy and PRESS START. Any button
   * opens four doors, each a picture and one word; Escape (or B) just watches the galaxy. */
  private showTitle() {
    const daily = dailyScenario();
    const stats = h('div', { class: 'title-live' });
    this.titleUp = true;
    this.root.classList.add('titled');
    const close = () => {
      if (o.classList.contains('out')) return;
      o.classList.add('out');
      document.body.classList.remove('press-start');
      this.titleUp = false;
      this.root.classList.remove('titled');
      window.removeEventListener('keydown', key);
      window.removeEventListener('keydown', poke, true);
      window.removeEventListener('pointerdown', poke, true);
      window.removeEventListener('focusin', poke, true);
      clearTimeout(demoAt); clearInterval(demoTour);
      offE(); offW(); offR();
      window.removeEventListener('structs:progress', onProgress);
      holdNotices(false);
      this.closeTitle = null;
      setTimeout(() => o.remove(), 600);
      // The galaxy's guide card waits for the title to step aside.
      window.dispatchEvent(new Event('structs:title-closed'));
    };
    this.closeTitle = close;
    const go = (hash: string | null, run?: () => void) => () => { audio.play('confirm'); close(); run?.(); if (hash) this.navigate(hash); };
    const door = (ico: string, tone: string, word: string, title: string, run: () => void) =>
      h('button', { class: 'dc-door ' + tone, title, onclick: run }, h('span', { class: 'dc-door-ico', html: icon(ico, 56) }), h('span', { class: 'dc-door-word' }, word));
    const first = h('div', { class: 'title-first' });
    const paintFirst = () => {
      const st = wallet.state;
      const e = enlisting.current;
      const mine = wallet.active?.playerId;
      first.replaceChildren(
        e && e.status === 'running' && !mine ? door('join', 'player', 'Join', `${e.guildName} is creating ${e.name}: wait in the arrival bay`, go('/lobby'))
          : mine ? door('base', 'player', 'Base', 'Your planet, fleet and moves', go('/command'))
          : st === 'locked' ? door('lock', 'player', 'Unlock', 'Unlock your vault', go(null, () => openVault()))
          // Joining is player setup first: build a droid, name it, pick a guild, then the lobby.
          : door('join', 'player', 'Join', 'Build your droid and join the Concourse: free, in seconds', go('/lobby')));
    };
    paintFirst();
    const offE = enlisting.onChange(paintFirst);
    const offW = wallet.onChange(paintFirst);
    const doors = h('div', { class: 'dc-doors', role: 'group', 'aria-label': 'Start' },
      first,
      // The gentlest start after Enlist: a practice battle needs nothing at all.
      door('target', 'enemy', 'Battle', `Practice battle · today: ${daily.name}`, go('/sim')),
      door('academy', 'academy', 'Learn', academy.doneCount ? `Academy: ${academy.doneCount} of ${academy.total} lessons` : 'Academy: quick lessons with XP', go('/academy')),
      door('explore', 'secondary', 'Watch', 'The live galaxy', go(null)));
    // The memory card: a returning player's rank, wins, today's daily and best gauntlet, one tap each.
    // (A first visit has nothing to show, so it shows nothing.)
    const save = h('div', { class: 'dc-save', role: 'group', 'aria-label': 'Your record' });
    const paintSave = () => {
      const rec = loadRecord(), xp = service.r.xp;
      save.hidden = !rec.battles && !xp;
      if (save.hidden) { save.replaceChildren(); return; }
      const best = dailyBest(daily.key), streak = dailyStreak(daily.key);
      let gauntlet = 0;
      try { gauntlet = Number(localStorage.getItem('structs.gauntlet.best') || 0); } catch { /* none */ }
      const rank = service.rank, next = RANKS[rank + 1];
      const chip = (cls: string, ico: string, title: string, href: string, ...body: (Node | string | null)[]) =>
        h('a', { class: 'dc-save-chip ' + cls, href, title, 'aria-label': title, 'data-k': cls.split(' ')[0], onclick: (e: Event) => {
          e.preventDefault();
          // Coming back, you're past PRESS START: the doors wait.
          try { sessionStorage.setItem('structs.started', '1'); } catch { /* ignore */ }
          go(href)();
        } }, h('span', { class: 'dc-save-ico', html: icon(ico, 20) }), ...body);
      // A repaint keeps the link in focus (a pad or keyboard player may be standing on it).
      const was = save.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.k : '';
      save.replaceChildren(...[
        chip('rank', 'rank', next ? `${RANKS[rank]} · ${formatInt(xp)} XP · ${formatInt(xpFor(rank + 1) - xp)} to ${next}` : `${RANKS[rank]} · ${formatInt(xp)} XP`, '/ops/record',
          h('span', { class: 'dc-save-col' }, h('span', { class: 'dc-save-k' }, RANKS[rank]), h('i', { class: 'dc-save-bar' }, h('b', { style: `width:${Math.round(service.progress * 100)}%` })))),
        rec.battles ? chip('wins', 'crown', `Battles won: ${rec.wins} of ${rec.battles}`, '/sim', h('span', { class: 'dc-save-n' }, formatInt(rec.wins))) : null,
        chip('daily' + (best?.won ? ' won' : best ? '' : ' fresh'), 'daily', `Today: ${daily.name} · ${daily.twist.name}${best ? ' · ' + (best.won ? 'won' : 'not won yet') : ' · not played yet'}${streak > 1 ? ` · ${streak}-day streak` : ''}`, '/sim/daily',
          h('span', { class: 'dc-save-n' }, best?.won ? '★' : best ? '…' : 'NEW'), streak > 1 ? h('span', { class: 'dc-save-sub' }, `${streak}×`) : null),
        gauntlet ? chip('gauntlet', 'flag', `Gauntlet: best ${gauntlet} of 5 rounds`, '/sim', h('span', { class: 'dc-save-n' }, `${gauntlet}/5`)) : null,
      ].filter((x): x is HTMLAnchorElement => !!x));
      if (was) save.querySelector<HTMLElement>(`[data-k="${was}"]`)?.focus({ preventScroll: true });
    };
    paintSave();
    // Missions credited late, a promotion, a daily won in another tab: the card keeps up.
    const offR = service.onChange(() => paintSave());
    const onProgress = () => paintSave();
    window.addEventListener('structs:progress', onProgress);
    // START then A should be a fight, not a form: a visitor without a commander lands on Battle.
    const firstDoor = () => (wallet.active?.playerId ? doors.querySelector('.dc-door') : doors.querySelector('.dc-door.enemy')) as HTMLElement | null;
    const open = () => {
      if (o.classList.contains('menu')) return;
      // A commander walks straight into the Concourse; a visitor gets the doors.
      if (wallet.active?.playerId && startInLobby()) { try { sessionStorage.setItem('structs.started', '1'); } catch { /* ignore */ } go('/lobby')(); return; }
      wake();
      o.classList.add('menu');
      // The bars come in with the doors (dc-nav.css): PRESS START is the logo and the galaxy alone.
      // Rewards that landed meanwhile (missions credited, a promotion) play now, one by one.
      document.body.classList.remove('press-start');
      holdNotices(false);
      audio.play('confirm');
      try { sessionStorage.setItem('structs.started', '1'); } catch { /* ignore */ }
      firstDoor()?.focus({ preventScroll: true });
    };
    const press = h('button', { class: 'dc-press', onclick: open }, 'PRESS START');
    let started = false;
    try { started = sessionStorage.getItem('structs.started') === '1'; } catch { /* ignore */ }
    const o = h('div', { class: 'title-overlay dc-title' + (started ? ' menu' : '') },
      h('div', { class: 'title-inner' },
        h('div', { class: 'dc-logo' }, h('span', { class: 'dc-mark', html: MARK }), h('h1', { class: 'title-mark' }, 'STRUCTS')),
        press, doors, save),
      h('div', { class: 'title-foot' }, stats,
        h('div', { class: 'title-links' },
          h('a', { href: 'https://playstructs.com', target: '_blank', rel: 'noopener' }, 'playstructs.com'),
          h('a', { href: 'https://structs.ai', target: '_blank', rel: 'noopener' }, 'docs'))));
    // …and on a touch screen, a tap anywhere (but the links) is START.
    o.addEventListener('click', (e) => { if (!(e.target as Element).closest('a, button')) open(); });
    this.root.appendChild(o);
    document.body.classList.toggle('press-start', !started);
    holdNotices(!started);
    const key = (e: KeyboardEvent) => {
      if (!o.isConnected) { window.removeEventListener('keydown', key); return; }
      // A modal on top (the vault, a confirm) takes its own Enter and Escape; so does anything that
      // already handled the key, a field being typed in, or focus in the top bar or the chat dock.
      if (document.querySelector('.modal-back') || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable]') || t?.isContentEditable) return;
      const at0 = document.activeElement;
      if (at0 && at0 !== document.body && at0.tagName !== 'CANVAS' && !o.contains(at0)) return;
      if (e.key === 'Escape') { e.preventDefault(); audio.play('confirm'); close(); return; }
      // PRESS START means any button: a letter, a number, Enter, Space or an arrow (Tab still walks).
      // A memory-card link in focus (Tab got there) opens like any link: Enter is its own.
      const inSave = !!save && save.contains(document.activeElement);
      if (inSave && e.key === 'Enter') return;
      if (!o.classList.contains('menu')) {
        if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key.length === 1 || e.key === 'Enter' || e.key.startsWith('Arrow'))) { e.preventDefault(); open(); }
        return;
      }
      // Two rows: left and right walk the doors (or the card's links), down steps to the card and up
      // back to the doors; Enter opens the one in focus. (The pad's d-pad arrives as these arrows.)
      const all = [...doors.querySelectorAll<HTMLElement>('.dc-door')];
      const chips = save ? [...save.querySelectorAll<HTMLElement>('.dc-save-chip')] : [];
      const row = inSave ? chips : all;
      const at = row.indexOf(document.activeElement as HTMLElement);
      const to = (el: HTMLElement | null | undefined) => { e.preventDefault(); if (el) { el.focus(); audio.play('hover', 0.6); } };
      if (e.key === 'ArrowRight') to(row[(at + 1) % row.length]);
      else if (e.key === 'ArrowLeft') to(row[(at - 1 + row.length) % row.length]);
      else if (e.key === 'ArrowDown') to(inSave ? null : chips.length ? chips[Math.min(Math.max(at, 0), chips.length - 1)] : all[(at + 1) % all.length]);
      else if (e.key === 'ArrowUp') to(inSave ? all[Math.min(Math.max(at, 0), all.length - 1)] : all[(at - 1 + all.length) % all.length]);
      else if (e.key === 'Enter' && at < 0) { e.preventDefault(); firstDoor()?.click(); }
    };
    window.addEventListener('keydown', key);
    if (started) requestAnimationFrame(() => firstDoor()?.focus({ preventScroll: true }));
    // Attract mode: left at PRESS START for half a minute, the camera tours the battle sites and the
    // busiest worlds, as a console's demo loop does. Any key, button or click brings the title back
    // (that first press only wakes it). Not with reduced motion: the tour is all camera flight.
    let demoAt = 0, demoTour = 0;
    const tour = () => {
      const busy = [...store.planets.values()].filter((p) => p.active && p.owner).sort((a, b) => b.structs - a.structs).slice(0, 8).map((p) => p.id);
      const picks = [...this.siteData.map((x) => x.planetId), ...busy];
      if (picks.length && o.isConnected) this.focusPlanet(picks[Math.floor(Math.random() * picks.length)], false);
    };
    const startDemo = () => {
      if (!o.isConnected || o.classList.contains('menu') || o.classList.contains('out') || this.engine.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      o.classList.add('demo');
      tour();
      demoTour = window.setInterval(tour, 6500);
    };
    /** End the tour (if one is running) and fly home; true when there was one. */
    const wake = () => {
      clearTimeout(demoAt);
      if (!o.classList.contains('demo')) return false;
      o.classList.remove('demo');
      clearInterval(demoTour);
      this.fly = { from: this.controls.target.clone(), to: new THREE.Vector3(0, 0, 0), camFrom: this.camera.position.clone(), camTo: this.homeView(new THREE.Vector3(0, 120, 210)), t: 0 };
      return true;
    };
    // Any key, click, tap or focus move (a pad's Back, A on a focused button) wakes the title.
    const poke = (e: Event) => {
      if (wake() && e.type === 'keydown') { e.preventDefault(); e.stopImmediatePropagation(); }
      if (o.isConnected && !o.classList.contains('menu')) demoAt = window.setTimeout(startDemo, 30000);
    };
    window.addEventListener('keydown', poke, true);
    window.addEventListener('pointerdown', poke, true);
    window.addEventListener('focusin', poke, true);
    poke(new Event('init'));
    const stat = (ico: string, n: string, title: string) => h('span', { class: 'title-stat', title }, h('span', { html: icon(ico, 20) }), n);
    const paint = () => {
      if (!o.isConnected) return;
      const on = store.coreLoaded && !this.offline;
      stats.replaceChildren(
        h('span', { class: 'title-dot' + (on ? ' on' : '') }, on ? 'LIVE' : this.offline ? 'Galaxy not answering' : 'LINK'),
        ...(store.coreLoaded ? [
          store.maxPlanetIndex ? stat('explore', formatInt(store.maxPlanetIndex), 'Worlds discovered') : null,
          stat('team', formatInt(store.players.size), 'Commanders'),
          live.height ? h('span', { class: 'x-only x-contents' }, stat('clock', formatInt(live.height), 'Block (a new one every ~6 s)')) : null,
        ].filter((x): x is HTMLSpanElement => !!x) : []));
    };
    paint();
    const t = window.setInterval(() => { if (!o.isConnected) clearInterval(t); else paint(); }, 1000);
  }

  /* ── Selection ────────────────────────────────────────────────────────── */
  focusPlanet(planetId: string, select: boolean) {
    const idx = idIndex(planetId);
    if (!idx) return;
    const p = planetPosition(idx);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = 26;
    this.fly = { from: this.controls.target.clone(), to: p.clone(), camFrom: this.camera.position.clone(), camTo: p.clone().add(dir.multiplyScalar(dist)).add(new THREE.Vector3(0, 6, 0)), t: 0 };
    if (select) this.select(planetId);
  }

  /** Plunge toward a world, then open its map. */
  private dive(planetId: string) {
    const p = planetPosition(idIndex(planetId));
    const dir = this.camera.position.clone().sub(p).normalize();
    this.fly = { from: this.controls.target.clone(), to: p.clone(), camFrom: this.camera.position.clone(), camTo: p.clone().add(dir.multiplyScalar(1.2)), t: 0 };
    this.fx.flare(p, 0xffffff, 6, 0.9);
    audio.play('warp', 0.8);
    clearTimeout(this.diveTimer);
    this.diveTimer = window.setTimeout(() => { if (this.root.isConnected) this.navigate('/planet/' + planetId); }, 650);
  }

  private select(planetId: string | null) {
    this.selected = planetId;
    this.cardEl?.remove();
    this.cardEl = null;
    if (!planetId) { this.selectRing.visible = false; return; }
    const p = planetPosition(idIndex(planetId));
    this.selectRing.position.copy(p);
    this.selectRing.visible = true;
    this.paintHero(planetId);
    const owner = store.homeOf.get(planetId) || store.planets.get(planetId)?.owner || '';
    const player = owner ? store.players.get(owner) : undefined;
    const lite = store.planets.get(planetId);
    const fleetsHere = [...store.fleets.values()].filter((f) => f.locationId === planetId && f.owner !== owner);
    const raided = fleetsHere.filter((f) => f.status === 'away');
    // A fact: its picture (the word is its title) and its value.
    const fact = (pic: string, label: string, value: string | HTMLElement, cls = '') => [
      h('span', { class: 'dw-k', title: label, role: 'img', 'aria-label': label, html: icon(pic, 15) }),
      typeof value === 'string' ? h('span', { class: cls, title: label }, value) : value];
    const status = lite && !lite.active ? h('span', { class: 'dw-call spent', title: 'Spent: its ore ran out' }, 'SPENT') : h('span', { class: 'dw-call good', title: 'Active' }, 'ACTIVE');
    const card = h('div', { class: 'planet-card panel ' + (raided.length ? 'enemy' : 'player') },
      h('div', { class: 'panel-head' }, h('span', { class: 'dw-head' }, ico('planet', 20), h('span', { class: 't-label' }, planetId)), h('button', { class: 'btn ghost icon', 'aria-label': 'Close', onclick: () => this.select(null) }, '×')),
      h('div', { class: 'panel-body row', style: 'align-items:flex-start' },
        player ? portrait(player.pfpClientRenderAttributes, 'player', player.id) : h('div', { class: 'pfp' }),
        h('div', { class: 'col grow', style: 'gap:6px; min-width:0' },
          h('div', { class: 't-label-lg c-player dw-ell' }, lite?.name || (player ? (player.name || player.id) + '’s world' : 'Unclaimed world')),
          h('div', { class: 'kv dw-kv' },
            ...fact('team', 'Commander', player ? (player.name || player.id) : '—'),
            ...fact('flag', 'Guild', player ? store.guildName(player.guildId) : '—'),
            ...fact('health', 'Status', status),
            ...fact('ship', 'Raiders', raided.length ? raided.map((f) => store.playerName(f.owner)).join(', ') : '0', raided.length ? 'c-enemy' : ''),
          ),
          h('div', { class: 'row wrap', style: 'margin-top:4px; gap:6px' },
            h('button', { class: 'btn solid', title: 'Open the planet map', onclick: () => { audio.play('confirm'); this.dive(planetId); } }, ico('planet', 16), 'Open'),
            player ? h('button', { class: 'btn ghost', title: 'Their base (look, don’t touch)', onclick: () => { audio.play('select'); this.navigate('/command/' + player.id); } }, ico('base', 16), 'Base') : null,
            player ? h('button', { class: 'btn ghost x-only', title: 'Copy the player id', onclick: () => copyText(player.id, 'Copied ' + player.id, 1200) }, player.id) : null),
        )));
    this.root.appendChild(card);
    this.cardEl = card;
    // Fill in the live readout: ore left, shield and slots built, straight from the LCD.
    const readout = h('div', { class: 'dw-readout', title: 'Reading the world' }, 'Reading…');
    card.querySelector('.kv')?.after(readout);
    void lcd.planet(planetId).then((pf) => {
      if (this.selected !== planetId) return;
      const ore = Number(pf.gridAttributes?.ore || 0), max = Number(pf.Planet.maxOre || 0);
      const shield = Number(pf.planetAttributes?.planetaryShield || 0);
      const n = AMBITS_LIST.reduce((s, a) => s + (pf.Planet[a] || []).filter(Boolean).length, 0);
      readout.title = `Ore ${ore}/${max} · Shield ${shield} · ${n}/16 slots built`;
      readout.replaceChildren(
        h('span', { class: 'dw-num c-neutral', title: `Ore left: ${ore} of ${max}` }, ico('ore', 14), `${ore}/${max}`),
        h('span', { class: 'dw-num', title: `Planetary shield ${shield}` }, ico('shield', 14), String(shield)),
        h('span', { class: 'dw-num', title: `${n} of 16 slots built` }, ico('build', 14), `${n}/16`));
    }).catch(() => { readout.textContent = 'No readout'; readout.title = 'Live readout unavailable'; });
  }

  /** Repaint the hero world for `id` (the renderer and palettes load on first use). */
  private paintHero(id: string) {
    void Promise.all([import('./battle/env'), import('../gfx/planet')]).then(([env, gp]) => {
      if (this.selected !== id) return;
      const seed = hash32(id);
      const world = { palette: env.WORLD_PALETTES[seed % env.WORLD_PALETTES.length], seed: (seed % 1000) / 37, spent: store.planets.get(id)?.active === false };
      if (!this.hero) {
        this.hero = new gp.Planet({ radius: 1, ...world, tilt: [-0.5, 0.3], detail: 768 });
        this.hero.group.visible = false;
        this.scene.add(this.hero.group);
      } else if (this.heroId !== id) this.hero.setWorld(world);
      if (this.heroId !== id) { this.heroK = 0; planetPosition(idIndex(id), this.heroPos); }
      this.heroId = id;
    }).catch(() => { /* the points still show the world */ });
  }

  /** The pointer is over the materialized hero world (it hides the points behind it). */
  private overHero(): boolean {
    if (!this.hero || !this.hero.group.visible || this.heroK < 0.3 || this.pointer.x > 2) return false;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.ray.intersectsSphere(this.heroBall.set(this.heroPos, HERO_R * this.heroK * 1.05));
  }

  /* ── Input ────────────────────────────────────────────────────────────── */
  private bindInput() {
    const canvas = this.engine.canvas;
    const move = (e: PointerEvent) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.pointerPx = { x: e.clientX, y: e.clientY };
      this.idleT = 0;
    };
    // A finger has no hover: a tap never moves the pointer first, so the press and the lift say where it is.
    const down = (e: PointerEvent) => { if (e.pointerType !== 'mouse') move(e); this.downAt = { x: e.clientX, y: e.clientY }; this.fly = null; this.idleT = 0; };
    const up = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 5) return;
      if (e.pointerType !== 'mouse') move(e);
      const site = this.pickSite();
      if (site != null && this.siteData[site]) { audio.play('select'); this.navigate('/combat/' + this.siteData[site].last.hash + '/e'); return; }
      // A click on the materialized world keeps it selected.
      if (this.overHero()) return;
      const id = this.pickBeacon();
      if (id) { audio.play('select'); this.focusPlanet(id, true); }
      else if (this.selected) this.select(null);
    };
    const leave = () => { this.pointer.set(9, 9); if (this.canvasTip) { this.canvasTip = false; hideTooltip(); } };
    const wheel = () => { this.fly = null; this.idleT = 0; };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('wheel', wheel, { passive: true });
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Escape' && this.selected) this.select(null);
      if ((e.key === 'h' || e.key === 'H') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) this.startReplay();
    };
    window.addEventListener('keydown', key);
    this.unsub.push(() => window.removeEventListener('keydown', key));
    this.unsub.push(() => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel);
    });
  }

  /* Commander names fade in near the camera's focus as you dive in. The
   * nearest-N search is throttled; projection runs every frame. */
  private namePicks: { id: string; d: number; p: THREE.Vector3 }[] = [];
  private updateNames(dt: number, camDist: number) {
    if (!this.beacons) return;
    this.nameTimer -= dt;
    if (this.nameTimer <= 0) {
      this.nameTimer = 0.15;
      const picks: { id: string; d: number; p: THREE.Vector3 }[] = [];
      if (camDist < 70 && !this.replay) {
        const pos = this.beacons.geometry.attributes.position as THREE.BufferAttribute;
        const v = new THREE.Vector3();
        const target = this.controls.target;
        const radius = camDist * 0.75;
        for (let i = 0; i < this.beaconIds.length; i++) {
          v.fromBufferAttribute(pos, i);
          const d = v.distanceTo(target);
          if (d < radius) picks.push({ id: this.beaconIds[i], d, p: v.clone() });
        }
        picks.sort((a, b) => a.d - b.d);
        picks.length = Math.min(picks.length, 14);
      }
      this.namePicks = picks;
      while (this.namePool.length < picks.length) { const el = h('div', { class: 'gname' }); this.nameLayer.appendChild(el); this.namePool.push(el); }
      this.namePool.forEach((el, i) => {
        const pk = picks[i];
        if (!pk) return;
        const owner = store.homeOf.get(pk.id);
        el.textContent = owner ? store.playerName(owner) : pk.id;
      });
    }
    const w = window.innerWidth, hh = window.innerHeight;
    const fadeIn = Math.min(1, (70 - camDist) / 20);
    // The hero world's disc on screen: names anchored under it would print across the planet.
    let disc: { x: number; y: number; r: number } | null = null;
    if (this.hero && this.heroId && this.heroK > 0.05) {
      const hp = S3.copy(this.heroPos);
      const d = this.camera.position.distanceTo(hp);
      const c = hp.project(this.camera);
      const r = (HERO_R * this.heroK / (Math.max(d, 1e-3) * Math.tan((this.camera.fov * Math.PI) / 360))) * (hh / 2);
      disc = { x: ((c.x + 1) / 2) * w, y: ((1 - c.y) / 2) * hh, r: r * 1.75 + 18 };
    }
    // Greedy placement, nearest first: a label that would overlap one already placed waits.
    const placed: { x: number; y: number; w: number }[] = [];
    this.namePool.forEach((el, i) => {
      const pk = this.namePicks[i];
      if (!pk || pk.id === this.hovered) { el.style.opacity = '0'; return; }
      const sp = pk.p.clone().project(this.camera);
      if (sp.z > 1) { el.style.opacity = '0'; return; }
      if (disc && (pk.id === this.heroId || Math.hypot(((sp.x + 1) / 2) * w - disc.x, ((1 - sp.y) / 2) * hh - disc.y) < disc.r)) { el.style.opacity = '0'; return; }
      const x = ((sp.x + 1) / 2) * w + 10, y = ((1 - sp.y) / 2) * hh - 6;
      const lw = (el.textContent || '').length * 6.5;
      if (placed.some((q) => Math.abs(q.y - y) < 14 && x < q.x + q.w && q.x < x + lw)) { el.style.opacity = '0'; return; }
      placed.push({ x, y, w: lw });
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.opacity = String(Math.max(0.3, 1 - pk.d / (camDist * 0.75)) * fadeIn);
    });
  }

  private pickBeacon(): string | null {
    if (!this.beacons || !this.beacons.visible || this.pointer.x > 2) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const d = this.camera.position.distanceTo(this.controls.target);
    this.raycaster.params.Points = { threshold: Math.max(0.4, d * 0.012) };
    const hits = this.raycaster.intersectObject(this.beacons, false);
    if (!hits.length) return null;
    hits.sort((a, b) => (a.distanceToRay ?? 0) - (b.distanceToRay ?? 0));
    return this.beaconIds[hits[0].index!] || null;
  }

  /** The shared tooltip shows a readout from the map (not a HUD tile's tip). */
  private canvasTip = false;
  private updateHover() {
    const site = this.pickSite();
    if (site !== this.hoveredSite) {
      this.hoveredSite = site;
      if (this.sites) (this.sites.material as THREE.ShaderMaterial).uniforms.uHover.value = site ?? -1;
      if (site != null) audio.play('hover');
    }
    if (site != null && this.siteData[site]) {
      const e = this.siteData[site];
      const at = Date.parse(e.last.time);
      const owner = store.homeOf.get(e.planetId);
      this.hovered = null;
      this.hoverRing.visible = false;
      this.engine.canvas.style.cursor = 'pointer';
      // Attacks, kills and how long ago, as numbers behind their pictures; a click watches the latest.
      this.canvasTip = true;
      showTooltip(this.pointerPx.x, this.pointerPx.y, h('div', null,
        h('div', { class: 'spread' }, h('span', { class: 't-label c-enemy dw-tt' }, ico('battle', 14), 'Battle'), h('span', { class: 't-tiny c-hint' }, e.planetId)),
        h('div', { class: 'dw-tt-row', 'aria-label': `${e.count} attacks, ${e.kills} destroyed` }, ico('target', 13), String(e.count), e.kills ? ico('boom', 13, 'c-enemy') : null, e.kills ? String(e.kills) : null,
          ico('clock', 13), Number.isFinite(at) ? ago(Date.now() - at) : '#' + e.last.height),
        h('div', { class: 't-tiny c-hint' }, (owner ? store.playerName(owner) + ' · ' : '') + '▶ click to watch'),
      ), 'enemy');
      return;
    }
    const id = this.pointer.x < 2 ? (this.overHero() ? this.heroId : this.pickBeacon()) : null;
    if (id !== this.hovered) {
      this.hovered = id;
      this.engine.canvas.style.cursor = id ? 'pointer' : 'default';
      if (id) audio.play('hover');
    }
    // Only a readout the map put up is taken down here: a HUD tile's or a glossary word's stays.
    if (!id) { this.hoverRing.visible = false; if (this.canvasTip) { this.canvasTip = false; hideTooltip(); } return; }
    if (id === this.heroId) this.hoverRing.position.copy(this.heroPos);
    else planetPosition(idIndex(id), this.hoverRing.position);
    this.hoverRing.visible = true;
    const owner = store.homeOf.get(id);
    const pl = owner ? store.players.get(owner) : undefined;
    const lite = store.planets.get(id);
    this.canvasTip = true;
    showTooltip(this.pointerPx.x, this.pointerPx.y, h('div', null,
      h('div', { class: 'spread' }, h('span', { class: 't-label c-player' }, pl?.name || owner || id), h('span', { class: 't-tiny c-hint' }, id)),
      h('div', { class: 'dw-tt-row' }, pl ? store.guildName(pl.guildId) : 'Unclaimed', lite ? ico('build', 13) : null, lite ? String(lite.structs) : null),
    ), 'player');
  }

  /* ── Frame ────────────────────────────────────────────────────────────── */
  update(dt: number, t: number) {
    tickSpace(this.sky, t);
    (this.dust.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    if (this.beacons) (this.beacons.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    const G = this.galaxy.u;
    G.uTime.value = t;
    G.uTwinkle.value = this.engine.reduceMotion ? 0 : 1;
    for (const sh of this.ships) sh.u.uTime.value = t;
    if (this.sites) (this.sites.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    // Raiders shuttle along their arcs, out and back, trailing their comets.
    for (const sh of this.ships) {
      sh.t = (sh.t + dt * sh.speed) % 2;
      sh.u.uHead.value = sh.t < 1 ? sh.t : 2 - sh.t;
      sh.u.uDir.value = sh.t < 1 ? 1 : -1;
    }
    // While the title is up the view slides right, clear of its column (wide screens only).
    const shiftGoal = this.titleUp && window.innerWidth > 900 ? 0.12 : 0;
    if (shiftGoal || this.titleShift) {
      this.titleShift = this.engine.reduceMotion ? shiftGoal : damp(this.titleShift, shiftGoal, 3, dt);
      if (!shiftGoal && this.titleShift < 0.002) this.titleShift = 0;
      const W = 1000 * this.camera.aspect;
      if (this.titleShift) this.camera.setViewOffset(W, 1000, -this.titleShift * W, 0, W, 1000);
      else this.camera.clearViewOffset();
    }
    this.corePulse = Math.max(0, this.corePulse - dt * 1.5);
    G.uPulse.value = this.corePulse;

    if (this.fly) {
      this.fly.t = Math.min(1, this.fly.t + dt / 1.4);
      const k = easeInOutCubic(this.fly.t);
      this.controls.target.lerpVectors(this.fly.from, this.fly.to, k);
      this.camera.position.lerpVectors(this.fly.camFrom, this.fly.camTo, k);
      if (this.fly.t >= 1) this.fly = null;
    } else {
      // Idle drift: a slow orbit once nobody is touching anything.
      this.idleT += dt;
      if (this.idleT > 8 && !this.selected) {
        const ang = dt * 0.03 * Math.min(1, (this.idleT - 8) / 4);
        const off = this.camera.position.clone().sub(this.controls.target);
        off.applyAxisAngle(new THREE.Vector3(0, 1, 0), ang);
        this.camera.position.copy(this.controls.target).add(off);
      }
    }
    this.controls.update();

    const camDist = this.camera.position.distanceTo(this.controls.target);
    PROJ.value = window.innerHeight / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    // The selected world materializes as a real planet as the camera closes in, lit from the core
    // with a little fill from the viewer's side so its day side shows.
    if (this.hero && this.heroId) {
      const p = this.heroPos;
      const on = this.selected === this.heroId && !this.replay && this.camera.position.distanceTo(p) < 70;
      this.heroK = damp(this.heroK, on ? 1 : 0, 4, dt);
      const g = this.hero.group;
      g.visible = this.heroK > 0.01;
      if (g.visible) {
        this.heroIdle = 0;
        g.position.copy(p);
        g.scale.setScalar(HERO_R * (1 - Math.pow(1 - this.heroK, 3)));
        S1.copy(p).negate().normalize().multiplyScalar(0.8).addScaledVector(S2.subVectors(this.camera.position, p).normalize(), 0.55);
        S1.y += 0.3;
        this.hero.setSun(S1);
        this.hero.update(dt, t);
      } else {
        // Hidden a while (deselected, or zoomed out): free its cubes; showing it again repaints them.
        const was = this.heroIdle;
        this.heroIdle += dt;
        if (was <= 12 && this.heroIdle > 12) this.hero.release();
      }
    }
    const ringScale = Math.max(0.8, camDist * 0.025);
    // Hovering the materialized world, the ring opens out past its limb.
    this.hoverRing.scale.setScalar(this.hovered && this.hovered === this.heroId ? Math.max(ringScale, HERO_R * 1.3 * this.heroK) : ringScale);
    this.hoverRing.quaternion.copy(this.camera.quaternion);
    // Around the materialized world the selection opens out to frame it.
    const selR = Math.max(ringScale * 1.5, HERO_R * 1.7 * this.heroK);
    this.selectRing.scale.setScalar(selR + Math.sin(t * 4) * 0.06 * selR);
    this.selectRing.quaternion.copy(this.camera.quaternion);
    this.selectRing.rotateZ(t * 0.6);
    // Disk fades as you dive in so worlds stay legible; the dust sheet always sits between far and near.
    G.uFade.value = damp(G.uFade.value, Math.min(1, Math.pow(Math.max(0, camDist - 10) / 140, 1.2)), 3, dt);
    this.galaxy.face(this.camera.position.y >= 0);

    // Pinned commander's world.
    const mePlanet = commander.state?.planetId;
    if (mePlanet && !this.replay) {
      if (this.mePos.id !== mePlanet) { this.mePos.id = mePlanet; planetPosition(idIndex(mePlanet), this.mePos.p); }
      const p = this.mePos.p;
      this.meRing.visible = true;
      this.meRing.position.copy(p);
      this.meRing.quaternion.copy(this.camera.quaternion);
      this.meRing.rotateZ(-t * 0.8);
      const meR = Math.max(1, camDist * 0.03, mePlanet === this.heroId ? HERO_R * 1.45 * this.heroK : 0);
      this.meRing.scale.setScalar(meR * (1 + Math.sin(t * 3) * 0.08));
      const v = S3.copy(p).project(this.camera);
      const onScreen = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      this.meLabel.style.display = onScreen ? '' : 'none';
      this.meLabel.textContent = commander.state?.name || 'You';
      this.meLabel.style.transform = `translate(${((v.x + 1) / 2) * window.innerWidth}px, ${((1 - v.y) / 2) * window.innerHeight - 22}px) translate(-50%, -100%)`;
    } else {
      this.meRing.visible = false;
      if (this.meLabel) this.meLabel.style.display = 'none';
    }
    // History replay: reveal worlds in discovery order.
    const dustMat = this.dust.material as THREE.ShaderMaterial;
    if (this.replay) {
      this.replay.t += dt;
      const k = Math.min(1, this.replay.t / this.replay.dur);
      const eased = k * k * (3 - 2 * k);
      const reveal = Math.max(1, eased * store.maxPlanetIndex);
      dustMat.uniforms.uReveal.value = reveal;
      G.uRadius.value = Math.sqrt(reveal / 60000) * 1.05 + 0.02;
      // The replay's caption: a clock and the world count (what it is lives in the title).
      if (!this.replayEl.firstChild) { this.replayEl.title = 'Discovery replay'; this.replayEl.append(ico('clock', 16), h('span', null)); }
      (this.replayEl.lastChild as HTMLElement).textContent = `#${formatInt(Math.floor(reveal))} / ${formatInt(store.maxPlanetIndex)}`;
      this.replayEl.style.opacity = '1';
      if (Math.random() < dt * 20) {
        const p = planetPosition(Math.max(1, Math.floor(reveal)));
        this.fx.flare(p, 0xffd59a, 3, 0.4);
      }
      if (k >= 1) {
        this.replay = null;
        dustMat.uniforms.uReveal.value = 1e9;
        G.uRadius.value = 10;
        if (this.beacons) this.beacons.visible = true;
        this.arcs.visible = true;
        this.replayEl.style.opacity = '0';
        audio.play('ping');
      }
    }
    if (this.beacons && this.heat.size) {
      const attr = this.beacons.geometry.attributes.heat as THREE.BufferAttribute;
      for (const [id, v] of this.heat) {
        const nv = v * Math.exp(-dt / 90);
        const i = this.beaconIndex.get(id);
        if (i != null) attr.setX(i, nv);
        if (nv < 0.01) { this.heat.delete(id); if (i != null) attr.setX(i, 0); } else this.heat.set(id, nv);
      }
      attr.needsUpdate = true;
    }
    this.hotTimer -= dt;
    if (this.hotTimer <= 0) { this.hotTimer = 2; this.renderHot(); }
    this.updateNames(dt, camDist);
    this.fx.update(dt);
    this.updateHover();
    // Refresh relative timestamps occasionally.
    if (Math.floor(t) !== Math.floor(t - dt) && Math.floor(t) % 5 === 0) {
      this.feedEl?.querySelectorAll<HTMLElement>('.when[data-at]').forEach((el) => { el.textContent = ago(Date.now() - Number(el.dataset.at)); });
    }
    void GALAXY_RADIUS;
  }
}

/* ── Materials ──────────────────────────────────────────────────────────── */

const R_GAL = GALAXY_RADIUS.toFixed(1);
/** Half-width of the baked disk map: room past the rim for the faint outer skirt. */
const DISK_EXTENT = GALAXY_RADIUS * 1.5;
const E_GAL = DISK_EXTENT.toFixed(1);
/** Side of the baked galaxy map; phones and tablets get half (their VRAM is shared and scarce). */
const GALAXY_MAP = 2048;
/** The disk's light sits in thin sheets at these heights, mirrored about the mid-plane. */
const SHEETS = [0.15, 1.3, 3.0];

/** Uniforms shared by every layer of the galaxy (one write per frame reaches them all). */
type GalaxyUniforms = { uTime: { value: number }; uFade: { value: number }; uRadius: { value: number }; uPulse: { value: number }; uTwinkle: { value: number } };
type Galaxy = { group: THREE.Group; u: GalaxyUniforms; face(above: boolean): void };

/* Shared GLSL: hashes, value noise, fbm, ridged noise and cells for the bake. */
const NOISE = /* glsl */ `
  float h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  vec2 h22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
  float vn(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(h12(i), h12(i + vec2(1, 0)), u.x), mix(h12(i + vec2(0, 1)), h12(i + vec2(1, 1)), u.x), u.y); }
  const mat2 ROT = mat2(1.6, 1.2, -1.2, 1.6);
  float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { s += a * vn(p); p = ROT * p + 17.1; a *= 0.5; } return s; }
  float ridge(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { float n = 1.0 - abs(vn(p) * 2.0 - 1.0); s += a * n * n; p = ROT * p + 5.3; a *= 0.5; } return s; }
  vec2 cells(vec2 p) { vec2 i = floor(p), f = fract(p); float d = 9.0, id = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 o = vec2(x, y); vec2 v = o + h22(i + o) - f; float dd = dot(v, v); if (dd < d) { d = dd; id = h12(i + o + 0.37); } }
    return vec2(sqrt(d), id); }
`;

/* The galaxy's light, baked into a 2048² map (sqrt-encoded): R the old stellar disk and bar,
 * G the young blue arms, B HII knots, A dust. The same four arms as the worlds (twist = r·0.042,
 * the same spread), warped so they read as grown rather than drawn. Dust lanes trail on the arms'
 * concave edges, where gas shocks on entry; star formation lights up just downstream. */
function bakeGalaxy(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget) {
  // 2048² on a desktop GPU, smaller on phones and software rasterisers (see bakeScale).
  const n = Math.round(GALAXY_MAP * bakeScale(renderer));
  if (rt.width !== n) rt.setSize(n, n);
  const mat = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      #define PI 3.14159265
      const float R = ${R_GAL}, E = ${E_GAL}, TW = 0.042;
      ${NOISE}
      // Gaussian across the nearest of the four arms, centred \`off\` radians from its ridge.
      float arm(float th, float r, float sig, float off, float wid) {
        float d = mod(th - TW * r - off + PI * 0.25, PI * 0.5) - PI * 0.25;
        return exp(-0.5 * d * d / (wid * wid * sig * sig));
      }
      void main() {
        vec2 p = (vUv - 0.5) * 2.0 * E;
        vec2 wv = vec2(fbm(p * 0.018 + 3.1), fbm(p * 0.018 + 9.7)) - 0.5;
        vec2 q = p + wv * 14.0;
        float r = length(q), rn = r / R, th = atan(q.y, q.x);
        float t = clamp((r - 2.0) / R, 0.0, 1.2);
        float sig = (0.28 + 0.5 * max(0.0, 1.0 - t)) * 0.333 + 0.015;
        float ridgeA = arm(th, r, sig, 0.0, 1.0);
        float armCore = arm(th, r, sig, -0.15 * sig, 0.42);
        float armWing = arm(th, r, sig, -0.1 * sig, 1.15);
        float lane = arm(th, r, sig, 0.62 * sig, 0.2);
        float lane2 = arm(th, r, sig, 1.25 * sig, 0.42);
        float n1 = fbm(p * 0.05 + 1.7);
        // Long-wavelength patchiness: arms brighten and fade along their length.
        float seg = 0.3 + 1.1 * smoothstep(0.3, 0.72, fbm(p * 0.02 + 50.0));

        // Old stars: an exponential disk, mildly armed, with a faint extended skirt.
        float disk = exp(-r / 38.0) * smoothstep(1.38, 0.92, rn);
        float skirt = 0.05 * exp(-r / 90.0) * smoothstep(1.48, 1.05, rn) * (0.6 + 0.8 * fbm(p * 0.02 + 8.0));
        float old = disk * (0.5 + 0.9 * armWing) * (0.72 + 0.56 * n1) + skirt;
        // A short bar, its ends feeding two of the arms.
        float ba = 1.1;
        vec2 bd = vec2(cos(ba), sin(ba));
        float along = dot(p, bd), across = dot(p, vec2(-bd.y, bd.x));
        float bar = exp(-pow(length(vec2(along / 27.0, across / 7.5)), 1.6));
        old += bar * 0.5;

        // Young arms: a clumpy bright core inside a soft wing, beaded with associations.
        float env = smoothstep(0.12, 0.36, rn) * smoothstep(1.22, 0.95, rn);
        float knots = pow(smoothstep(0.42, 0.82, fbm(p * 0.14 + 11.0)), 1.4) * 2.6;
        float young = (armCore * (0.22 + knots) + armWing * (0.14 + 0.2 * ridge(p * 0.06 + 2.0))) * env * seg;
        float spur = pow(max(0.0, 0.5 + 0.5 * cos(8.0 * (th - 0.024 * r) + fbm(p * 0.03) * 5.0)), 10.0);
        young += spur * env * (0.2 + armWing) * knots * 0.25;

        // HII knots: pink nebulae of varied size, gathered into star-forming complexes along the ridges.
        float sf = smoothstep(0.48, 0.72, fbm(p * 0.035 + 70.0));
        vec2 c1 = cells(p * 0.45 + wv * 4.0), c2 = cells(p * 1.1 + 31.0);
        float k1 = smoothstep(0.42 * (0.4 + c1.y), 0.0, c1.x) * step(0.66, c1.y);
        float k2 = smoothstep(0.3, 0.0, c2.x) * step(0.8, c2.y);
        float hii = (k1 + k2 * 0.6) * armCore * env * (0.06 + sf * 1.9);

        // Dust: a sharp lane on each arm's concave edge, a broader one beyond it, feathered spurs
        // crossing the inter-arm gap, filaments, and the bar's leading-edge lanes.
        float rid = ridge(p * 0.075 + 5.0);
        float denv = smoothstep(0.05, 0.15, rn) * smoothstep(1.22, 0.86, rn);
        float feather = pow(max(0.0, 0.5 + 0.5 * cos(16.0 * (th - 0.013 * r) + 4.0 * fbm(p * 0.05 + 3.0))), 5.0) * arm(th, r, sig, 1.9 * sig, 1.1);
        float dust = (lane * (0.55 + 0.8 * rid) + lane2 * rid * 0.5 + feather * 0.45 * rid) * denv;
        dust += pow(ridge(p * 0.042 + 20.0), 3.0) * 0.35 * smoothstep(0.08, 0.3, rn) * smoothstep(1.05, 0.55, rn);
        float bx = (across * sign(along) + 5.0) / 1.6;
        float bl = exp(-bx * bx) * smoothstep(32.0, 12.0, abs(along)) * smoothstep(2.0, 8.0, abs(along));
        dust += bl * (0.6 + 0.6 * rid);
        dust *= 0.55 + 0.7 * fbm(p * 0.025 + 40.0);

        gl_FragColor = sqrt(clamp(vec4(old * 0.85, young * 0.75, hii * 0.9, dust * 0.75), 0.0, 1.0));
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, new THREE.OrthographicCamera());
  renderer.setRenderTarget(prev);
  quad.geometry.dispose();
  mat.dispose();
}

/** Flat quads covering the baked map at the given heights, merged into one geometry. */
function sheetGeometry(heights: number[]) {
  const pos: number[] = [], idx: number[] = [];
  heights.forEach((y, i) => {
    const e = DISK_EXTENT;
    pos.push(-e, y, -e, e, y, -e, e, y, e, -e, y, e);
    const o = i * 4;
    idx.push(o, o + 2, o + 1, o, o + 3, o + 2);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const SHEET_VERT = /* glsl */ `varying vec3 vW; void main() { vW = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/* The galaxy as seen: the baked map drawn as a stack of thin emissive sheets (a thick, smooth
 * old disk; young arms and HII only near the mid-plane), a dust sheet at the mid-plane that
 * absorbs (reddening as it goes) whatever lies behind it, a bulge-and-halo spheroid split in two
 * halves about that sheet, and field stars split the same way. face() orders the halves so the
 * dust always sits between the far side and the camera. */
function buildGalaxy(): Galaxy {
  const rt = new THREE.WebGLRenderTarget(GALAXY_MAP, GALAXY_MAP, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  const map = rt.texture;
  const u: GalaxyUniforms = { uTime: { value: 0 }, uFade: { value: 1 }, uRadius: { value: 10 }, uPulse: { value: 0 }, uTwinkle: { value: 1 } };
  const sq = SHEETS.map((h) => (h * h).toFixed(4));
  const glow = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uMap: { value: map }, uFade: u.uFade, uRadius: u.uRadius, uTime: u.uTime },
    vertexShader: SHEET_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform float uFade, uRadius, uTime; varying vec3 vW;
      void main() {
        float h = vW.y, ah = abs(h);
        float r = length(vW.xz), rn = r / ${R_GAL};
        // The thick sheets read a blurrier mip: the old thick disk is smooth.
        vec4 m = texture(uMap, vW.xz / (2.0 * ${E_GAL}) + 0.5, ah > 2.0 ? 2.6 : ah > 1.0 ? 1.1 : 0.0); m *= m;
        // Each sheet's share of the old light: gaussian in height with the worlds' own thickness.
        float th = 1.2 + 7.0 * exp(-r / 18.0), i2 = 1.0 / (th * th);
        float share = exp(-h * h * i2) / (2.0 * (exp(-${sq[0]} * i2) + exp(-${sq[1]} * i2) + exp(-${sq[2]} * i2)));
        float mid = step(ah, 0.5) * 0.5;
        vec3 cOld = mix(vec3(1.0, 0.66, 0.36), vec3(0.78, 0.79, 0.9), smoothstep(0.06, 0.85, rn));
        float breathe = 0.88 + 0.12 * sin(uTime * 0.7 + vW.x * 0.21 + vW.z * 0.17);
        vec3 col = cOld * m.r * share * 0.34
          + vec3(0.4, 0.58, 1.0) * m.g * mid * 0.3
          + vec3(1.0, 0.3, 0.55) * m.b * mid * 0.75 * breathe;
        // Optical path: a grazing view looks through more of the disk.
        vec3 V = normalize(cameraPosition - vW);
        col *= clamp(0.55 / max(abs(V.y), 0.01), 0.75, 2.6);
        float rev = smoothstep(uRadius + 0.08, uRadius - 0.04, rn);
        // During a discovery replay, a golden front sweeps outward.
        float df = abs(rn - uRadius);
        float fx = df * 120.0;
        float front = (exp(-fx * fx) * 0.9 + exp(-df * 45.0) * 0.12) * step(uRadius, 4.0) * mid;
        gl_FragColor = vec4((col * rev + vec3(1.0, 0.78, 0.45) * front) * uFade, 1.0);
      }`,
  });
  const absorb = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcColorFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    uniforms: { uMap: { value: map }, uFade: u.uFade, uRadius: u.uRadius },
    vertexShader: SHEET_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform float uFade, uRadius; varying vec3 vW;
      void main() {
        float rn = length(vW.xz) / ${R_GAL};
        float d = texture(uMap, vW.xz / (2.0 * ${E_GAL}) + 0.5).a; d *= d;
        vec3 V = normalize(cameraPosition - vW);
        // Extinction reddens: blue is lost first.
        vec3 tau = d * vec3(1.9, 2.4, 3.1) * clamp(0.55 / max(abs(V.y), 0.01), 0.75, 3.0);
        gl_FragColor = vec4((1.0 - exp(-tau)) * uFade * smoothstep(uRadius + 0.08, uRadius - 0.04, rn), 1.0);
      }`,
  });
  const lower = new THREE.Mesh(sheetGeometry(SHEETS.map((h) => -h)), glow);
  const upper = new THREE.Mesh(sheetGeometry(SHEETS), glow);
  const dust = new THREE.Mesh(sheetGeometry([0]), absorb);
  dust.renderOrder = -5;
  // The map needs the live renderer, so it bakes at the first draw, and again whenever a lost
  // context is restored (the restored target comes back empty).
  let baked = -1;
  const bake = (renderer: THREE.WebGLRenderer) => {
    const e = bakeEpoch(renderer);
    if (e === baked) return;
    baked = e;
    map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    bakeGalaxy(renderer, rt);
  };
  for (const m of [lower, upper, dust]) m.onBeforeRender = bake;
  const sph = spheroidMaterial(u);
  const quad = new THREE.PlaneGeometry(2, 2);
  const bulgeFar = new THREE.Mesh(quad, sph), bulgeNear = new THREE.Mesh(quad, sph);
  const [starsLo, starsHi] = fieldStars(u);
  const group = new THREE.Group();
  for (const o of [lower, upper, dust, bulgeFar, bulgeNear, starsLo, starsHi]) { o.frustumCulled = false; group.add(o); }
  bulgeFar.renderOrder = -6;
  bulgeNear.renderOrder = -2;
  let side: boolean | null = null;
  return {
    group, u,
    face(above: boolean) {
      if (above === side) return;
      side = above;
      const [far, near] = above ? [lower, upper] : [upper, lower];
      const [sFar, sNear] = above ? [starsLo, starsHi] : [starsHi, starsLo];
      far.renderOrder = -8; sFar.renderOrder = -7;
      near.renderOrder = -4; sNear.renderOrder = -3;
    },
  };
}

/* The bulge and the stellar halo: a camera-facing quad shading an oblate spheroid (it flattens
 * as the disk turns edge-on). A hot white nucleus, a golden Sérsic bulge, a faint cool halo.
 * Each block sends a soft ring of light out from the core. Drawn as two halves of the light,
 * one each side of the dust sheet. */
function spheroidMaterial(u: GalaxyUniforms) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uPulse: u.uPulse, uSize: { value: 250 } },
    vertexShader: /* glsl */ `
      uniform float uSize; varying vec2 vQ, vN; varying float vNear;
      void main() {
        vQ = position.xy * uSize;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        // Inside the bulge the field stars take over from the glow.
        vNear = smoothstep(12.0, 120.0, -mv.z);
        mv.xy += vQ;
        vN = (modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xy;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uPulse; varying vec2 vQ, vN; varying float vNear;
      void main() {
        float L = min(length(vN), 1.0);
        vec2 n = L > 1e-4 ? vN / L : vec2(0.0, 1.0);
        float al = dot(vQ, n), pe = length(vQ - al * n);
        float rb = length(vec2(pe, al / mix(1.0, 0.6, L)));
        float rh = length(vec2(pe, al / mix(1.0, 0.78, L)));
        float nucleus = exp(-rb * rb / 0.12) * 6.0 * (1.0 + uPulse * 0.8) + exp(-rb / 1.4) * 0.8;
        float bulge = exp(-3.67 * (sqrt(rb / 9.0) - 1.0)) * 0.034;
        float halo = exp(-rh / 60.0) * 0.016 * smoothstep(250.0, 150.0, rh);
        vec3 col = vec3(1.0, 0.94, 0.84) * nucleus
          + mix(vec3(1.0, 0.8, 0.52), vec3(1.0, 0.56, 0.28), smoothstep(2.0, 34.0, rb)) * bulge
          + vec3(0.5, 0.56, 0.8) * halo;
        float wave = (rb - (1.0 - uPulse) * 36.0) / 2.6;
        col += vec3(1.0, 0.78, 0.5) * exp(-wave * wave) * uPulse * 0.1;
        gl_FragColor = vec4(col * 0.5 * mix(0.25, 1.0, vNear), 1.0);
      }`,
  });
}

/* Field stars: ~75k non-interactive stars on the same four arms (young blue clusters strung along
 * the ridges, an old disk between, a golden bulge and bar, a sparse halo with globular clusters),
 * so the disk has stellar grain at every zoom. Sub-pixel stars keep their energy (dimmer, never
 * thinner), the brightest grow diffraction spikes up close, and none blow out in the camera's
 * face. Split at the mid-plane so the dust sheet can sit between the halves. */
function fieldStars(u: GalaxyUniforms): [THREE.Points, THREE.Points] {
  const rnd = mulberry(90210);
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.732;
  const SPEC: Record<string, [number, number, number]> = {
    O: [0.5, 0.66, 1.0], A: [0.8, 0.87, 1.0], G: [1.0, 0.9, 0.74], K: [1.0, 0.7, 0.42], M: [1.0, 0.48, 0.3],
  };
  const pick = (mix: [string, number][]) => { let x = rnd(); for (const [k, w] of mix) { if ((x -= w) <= 0) return SPEC[k]; } return SPEC.G; };
  const halves = [0, 1].map(() => ({ pos: [] as number[], col: [] as number[], size: [] as number[], seed: [] as number[] }));
  const add = (x: number, y: number, z: number, c: [number, number, number], lum: number, size: number) => {
    const h = halves[y < 0 ? 0 : 1];
    h.pos.push(x, y, z);
    h.col.push(c[0] * lum, c[1] * lum, c[2] * lum);
    h.size.push(size);
    h.seed.push(rnd());
  };
  const R = GALAXY_RADIUS, TW = 0.042;
  const lumOf = (base: number, spread: number) => base + spread * Math.pow(rnd(), 8);
  const thickness = (r: number) => 1.2 + 7 * Math.exp(-r / 18);
  const ARM_MIX: [string, number][] = [['O', 0.32], ['A', 0.24], ['G', 0.26], ['K', 0.14], ['M', 0.04]];
  const OLD_MIX: [string, number][] = [['A', 0.06], ['G', 0.38], ['K', 0.4], ['M', 0.16]];
  // Arm stars: half on the worlds' own radial law, half exponential toward the core.
  for (let i = 0; i < 40000; i++) {
    const r = (rnd() < 0.5 ? R * 1.12 * Math.sqrt(rnd()) : Math.min(R * 1.25, -R * 0.32 * Math.log(1 - rnd() * 0.99))) + 2;
    const t = r / R, spread = (0.28 + 0.5 * Math.max(0, 1 - t)) * 0.333;
    const a = Math.floor(rnd() * 4) * Math.PI / 2 + r * TW + gauss() * spread * 1.05;
    const lum = lumOf(0.35, 2.4);
    add(Math.cos(a) * r, gauss() * thickness(r) * 0.3, Math.sin(a) * r, pick(ARM_MIX), lum, 0.34 + lum * 0.16);
  }
  // The old disk between the arms.
  for (let i = 0; i < 15000; i++) {
    const r = Math.min(R * 1.4, -R * 0.3 * Math.log(1 - rnd() * 0.995)) + 1;
    const a = rnd() * Math.PI * 2;
    const lum = lumOf(0.3, 1.4);
    add(Math.cos(a) * r, gauss() * thickness(r) * 0.45, Math.sin(a) * r, pick(OLD_MIX), lum, 0.32 + lum * 0.12);
  }
  // Bulge and bar.
  const ba = 1.1, bx = Math.cos(ba), bz = Math.sin(ba);
  for (let i = 0; i < 7000; i++) {
    const lum = lumOf(0.1, 0.8);
    const c = pick([['G', 0.3], ['K', 0.5], ['M', 0.2]]);
    if (rnd() < 0.3) { const al = gauss() * 15, ac = gauss() * 4.2; add(al * bx - ac * bz, gauss() * 3.2, al * bz + ac * bx, c, lum, 0.3 + lum * 0.1); }
    else { const s = 4 + 9 * rnd(); add(gauss() * s, gauss() * s * 0.6, gauss() * s, c, lum, 0.3 + lum * 0.1); }
  }
  // The stellar halo.
  for (let i = 0; i < 2600; i++) {
    const r = 22 + 230 * Math.pow(rnd(), 2.2);
    const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
    const lum = lumOf(0.22, 1.0);
    add(Math.cos(a) * s * r, z * r * 0.75, Math.sin(a) * s * r, pick(OLD_MIX), lum, 0.32 + lum * 0.1);
  }
  // Young clusters (OB associations) strung along the arm ridges.
  for (let k = 0; k < 230; k++) {
    const r = R * (0.24 + 0.9 * Math.sqrt(rnd()));
    const spread = (0.28 + 0.5 * Math.max(0, 1 - r / R)) * 0.333;
    const a = Math.floor(rnd() * 4) * Math.PI / 2 + r * TW + gauss() * spread * 0.4;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r, cy = gauss() * 0.3, n = 10 + Math.floor(rnd() * 24), s = 0.35 + rnd() * 0.6;
    for (let i = 0; i < n; i++) {
      const lum = 0.45 + 2.0 * Math.pow(rnd(), 3);
      add(cx + gauss() * s, cy + gauss() * s * 0.5, cz + gauss() * s, pick([['O', 0.6], ['A', 0.35], ['G', 0.05]]), lum, 0.36 + lum * 0.14);
    }
  }
  // Globular clusters orbiting in the halo.
  for (let k = 0; k < 28; k++) {
    const r = 30 + 125 * rnd(), z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
    const cx = Math.cos(a) * s * r, cy = z * r * 0.7, cz = Math.sin(a) * s * r;
    for (let i = 0; i < 70; i++) {
      const d = 0.15 + 0.7 * Math.pow(rnd(), 1.8), lum = 0.3 + 1.2 * Math.pow(rnd(), 4);
      add(cx + gauss() * d, cy + gauss() * d, cz + gauss() * d, pick([['G', 0.4], ['K', 0.5], ['M', 0.1]]), lum, 0.3 + lum * 0.1);
    }
  }
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: u.uTime, uRadius: u.uRadius, uTwinkle: u.uTwinkle, uScale: { value: 260 }, uPR: PIXEL_RATIO },
    vertexShader: /* glsl */ `
      attribute float size, seed; attribute vec3 color;
      uniform float uTime, uRadius, uTwinkle, uScale, uPR;
      varying vec3 vColor; varying float vPx, vSpike;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float z = -mv.z;
        float px = size * uScale / max(z, 0.05);
        float rn = length(position.xz) / ${R_GAL};
        float rev = smoothstep(uRadius + 0.06, uRadius - 0.02, rn);
        float tw = 1.0 + uTwinkle * 0.22 * sin(uTime * (1.3 + seed * 3.0) + seed * 60.0);
        // Below ~1.6 px a star keeps its energy rather than its size; near the camera it fades out.
        float e = min(1.0, px * px / 2.56) * smoothstep(0.4, 3.5, z);
        vColor = color * e * tw * rev * 0.8;
        vPx = clamp(px, 1.6, 7.0 + 5.0 * smoothstep(1.4, 3.0, size)) * uPR;
        vSpike = smoothstep(3.5, 7.0, px) * smoothstep(0.55, 0.8, size);
        gl_PointSize = dot(vColor, vColor) < 1e-6 ? 0.0 : vPx;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uPR; varying vec3 vColor; varying float vPx, vSpike;
      void main() {
        vec2 c = (gl_PointCoord - 0.5) * vPx / uPR;
        float d2 = dot(c, c), half_ = 0.5 * vPx / uPR;
        float core = exp(-d2 / 0.7);
        float halo = exp(-sqrt(d2) / max(0.6, half_ * 0.3)) * 0.18;
        float edge = 1.0 - smoothstep(half_ * 0.55, half_, sqrt(d2));
        float spike = (exp(-abs(c.x) * 2.4) + exp(-abs(c.y) * 2.4)) * (1.0 - smoothstep(0.0, half_, max(abs(c.x), abs(c.y)))) * vSpike * 0.5;
        gl_FragColor = vec4(vColor * (core * 1.2 + (halo + spike) * edge), 1.0);
      }`,
  });
  const [lo, hi] = halves.map((h) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(h.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(h.col, 3));
    g.setAttribute('size', new THREE.Float32BufferAttribute(h.size, 1));
    g.setAttribute('seed', new THREE.Float32BufferAttribute(h.seed, 1));
    return new THREE.Points(g, mat);
  });
  return [lo, hi];
}

/** Pixels per world unit at unit depth (CSS px): worlds up close are sized by their true radius. */
const PROJ = { value: 965 };
/** A world's own radius in world units: discs of worlds and beacons coincide exactly. */
const WORLD_R = '0.13';

/* Shared GLSL for a small world seen up close: a sphere lit from the galactic core. `q` is the
 * offset from centre in units of the world's radius, `rp` that radius in CSS px. */
const WORLD_DISC = /* glsl */ `
  float discCover(float rl, float rp) { return clamp((1.0 - rl) * rp + 0.5, 0.0, 1.0); }
  vec3 discNormal(vec2 q) { return vec3(q.x, -q.y, sqrt(max(0.0, 1.0 - dot(q, q)))); }
`;
/* The galaxy lights its worlds: the key light comes from the core (view space). */
const CORE_LIGHT = /* glsl */ `normalize((viewMatrix * vec4(-normalize(position + vec3(0.0, 1e-3, 0.0)), 0.0)).xyz)`;

/* Every world as a crisp point: a tight core, a soft corona that grows as you near it and, for
 * live worlds, a faint diffraction cross. Within a few dozen units each resolves into a small
 * sphere lit by the core (spent worlds dull rock, live ones bright). Sub-pixel worlds keep their
 * energy; worlds in the camera's face fade rather than blow out. Replay reveals them in
 * discovery order. */
function worldMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uScale: { value: 234 }, uPR: PIXEL_RATIO, uReveal: { value: 1e9 }, uProj: PROJ },
    vertexShader: /* glsl */ `
      attribute float size, order; attribute vec3 color;
      uniform float uTime, uScale, uPR, uReveal, uProj;
      varying vec3 vColor, vL; varying float vPx, vSpike, vRp;
      void main() {
        float ahead = order - uReveal;
        if (ahead > 0.0 || size <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
        float fresh = clamp(1.0 + ahead / 900.0, 0.0, 1.0) * step(uReveal, 1e8);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float z = -mv.z;
        float px = size * uScale / max(1.0, z);
        vRp = ${WORLD_R} * uProj / max(z, 0.1);
        float lum = max(color.r, max(color.g, color.b));
        vColor = mix(color, vec3(1.0, 0.82, 0.5) * 1.8, fresh) * min(1.0, px * px / 2.25) * smoothstep(1.2, 7.0, z);
        vPx = clamp(max(px, vRp * 2.8), 1.5, 64.0) * uPR;
        vSpike = smoothstep(6.0, 14.0, px) * smoothstep(0.18, 0.4, lum) * (1.0 - smoothstep(1.5, 3.0, vRp));
        vL = ${CORE_LIGHT};
        gl_PointSize = vPx;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uPR; varying vec3 vColor, vL; varying float vPx, vSpike, vRp;
      ${WORLD_DISC}
      void main() {
        vec2 c = (gl_PointCoord - 0.5) * vPx / uPR;
        float d = length(c), half_ = 0.5 * vPx / uPR;
        float edge = 1.0 - smoothstep(half_ * 0.5, half_, d);
        float disc = smoothstep(1.5, 3.0, vRp);
        float core = exp(-d * d / 0.6) * (1.0 - disc);
        float halo = exp(-d / max(0.7, half_ * 0.28)) * 0.16 * (1.0 - disc * 0.75);
        float spike = (exp(-abs(c.x) * 2.2) + exp(-abs(c.y) * 2.2)) * (1.0 - smoothstep(0.0, half_, max(abs(c.x), abs(c.y)))) * vSpike * 0.3;
        vec3 col = vColor * (core * 0.95 + (halo + spike) * edge);
        if (disc > 0.0) {
          vec2 q = c / vRp;
          float rl = length(q);
          vec3 n = discNormal(q);
          float ndl = max(dot(n, vL), 0.0);
          float lum = max(vColor.r, max(vColor.g, vColor.b));
          float live = smoothstep(0.1, 0.3, lum);
          col += vColor * (vec3(1.0, 0.9, 0.76) * (0.05 + 1.1 * ndl) + mix(0.1, 0.35, live) * pow(1.0 - n.z, 3.0)) * discCover(rl, vRp) * disc * mix(0.7, 1.0, live);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

/* Commanders' home worlds. Far off: a hot point in a guild-coloured corona, pulsing (faster and
 * redder while the world is hot with activity), sparing with light since thousands crowd the rim.
 * Up close each becomes a world: the same sphere as its point in the dust, now wrapped in its
 * guild's atmosphere, lit by the core on the day side and by city lights on the night side. */
function beaconMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uScale: { value: 170 }, uPR: PIXEL_RATIO, uProj: PROJ },
    vertexShader: /* glsl */ `
      attribute float size, phase, heat; attribute vec3 color;
      uniform float uTime, uScale, uPR, uProj;
      varying vec3 vColor, vL; varying float vPulse, vPx, vHeat, vRp, vFar;
      void main() {
        vHeat = clamp(heat, 0.0, 1.0);
        vColor = mix(color, vec3(1.0, 0.55, 0.35) * max(color.r, max(color.g, color.b)), vHeat * 0.6);
        vPulse = 0.75 + 0.25 * sin(uTime * (1.6 + heat * 6.0) + phase) + heat * 1.4;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float z = -mv.z;
        float s = size * uScale / max(1.0, z);
        vRp = ${WORLD_R} * uProj / max(z, 0.1);
        vPx = clamp(max(s * (1.0 + heat * 0.9), vRp * 3.6), 2.5 + heat * 6.0, 72.0) * uPR;
        // Seen from far off (a phone's whole-galaxy view) the crowded rim spends less light.
        vFar = mix(0.35, 1.0, min(1.0, s * s / 6.25));
        gl_PointSize = vPx;
        vL = ${CORE_LIGHT};
      }`,
    fragmentShader: /* glsl */ `
      uniform float uPR; varying vec3 vColor, vL; varying float vPulse, vPx, vHeat, vRp, vFar;
      ${WORLD_DISC}
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        float px = vPx / uPR, dp = d * px;
        // White light scales with the world's own brightness, so worlds outside a guild filter stay dim.
        float lumN = clamp(max(vColor.r, max(vColor.g, vColor.b)) * 1.6, 0.0, 1.0);
        float near = mix(0.42, 1.0, smoothstep(4.0, 12.0, px));
        float edge = 1.0 - smoothstep(0.3, 0.5, d);
        float disc = smoothstep(1.5, 3.0, vRp);
        float core = exp(-dp * dp / 0.6) * (1.0 - disc);
        float halo = exp(-d * 9.0) * 0.4 * edge * (1.0 - disc * 0.92);
        vec3 col = (vColor * (halo * vPulse + core * 1.2) + vec3(core) * 0.3 * lumN) * near * vFar;
        if (disc > 0.0) {
          vec2 q = c * px / vRp;
          float rl = length(q), inside = discCover(rl, vRp);
          vec3 n = discNormal(q);
          float ndl = dot(n, vL), day = smoothstep(-0.1, 0.3, ndl);
          vec2 g = floor((q + 1.0) * 6.0);
          float city = step(0.74, fract(sin(dot(g, vec2(12.9898, 78.233))) * 43758.5453)) * (1.0 - day) * smoothstep(0.9, 0.3, dot(q, q));
          vec3 surf = vColor * 0.03 + vec3(1.0, 0.88, 0.7) * mix(vec3(lumN), vColor * 1.5, 0.4) * max(ndl, 0.0) * 0.22
            + vColor * city * 0.8 + vColor * pow(1.0 - n.z, 3.0) * (0.15 + 0.6 * day);
          // A thin atmosphere past the limb, brightest toward the light.
          vec2 l2 = vec2(vL.x, -vL.y);
          float sun = 0.3 + 0.7 * max(0.0, dot(q / max(rl, 1e-3), l2 / max(length(l2), 1e-3)));
          float atmo = exp(-max(0.0, rl - 1.0) * vRp / 1.4) * (1.0 - inside);
          vec3 world = surf * inside + vColor * atmo * sun * 0.75 + vec3(1.0, 0.55, 0.35) * vHeat * exp(-d * 8.0) * 0.25 * (1.0 - inside);
          col += world * disc;
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

/* Battle sites: HUD-grade targeting glyphs. A broken outer ring turning slowly, cardinal ticks
 * closing on the target, a counter-turning diamond, a hot centre, and a sonar ping. */
function siteMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPR: PIXEL_RATIO, uHover: { value: -1 } },
    vertexShader: /* glsl */ `
      attribute float size, phase; uniform float uTime, uPR, uHover; varying float vPulse, vHover, vPx, vPhase;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        vHover = float(abs(float(gl_VertexID) - uHover) < 0.5);
        vPulse = 0.6 + 0.4 * sin(uTime * 2.4 + phase);
        vPhase = phase;
        vPx = size * uPR * (1.0 + vHover * 0.3);
        gl_PointSize = vPx;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; varying float vPulse, vHover, vPx, vPhase;
      float line(float x, float x0, float w) { return clamp(0.5 * w - abs(x - x0) * vPx + 0.5, 0.0, 1.0); }
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c), a = atan(c.y, c.x);
        float spin = uTime * 0.5 + vPhase;
        float ar = fract((a + spin) / 6.2832 * 4.0);
        float outer = line(r, 0.42, 1.6) * step(0.12, ar) * step(ar, 0.88);
        float outer2 = line(r, 0.47, 1.0) * step(0.42, ar) * step(ar, 0.58) * 0.8;
        float ax = min(abs(c.x), abs(c.y));
        float ticks = line(ax, 0.0, 1.6) * step(0.25, r) * step(r, 0.37);
        float sa = -spin * 0.7, cs = cos(sa), sn = sin(sa);
        vec2 rc = mat2(cs, sn, -sn, cs) * c;
        float dia = line(abs(rc.x) + abs(rc.y), 0.17, 1.4) * step(0.035, abs(abs(rc.x) - abs(rc.y)));
        float cr = r * vPx / 2.2;
        float core = exp(-cr * cr);
        float ping = fract(uTime * 0.42 + vPhase * 0.159);
        float pings = line(r, 0.1 + ping * 0.38, 1.3) * (1.0 - ping) * (1.0 - ping);
        float v = outer * (0.7 + 0.3 * vPulse) + outer2 + ticks + dia * 0.85 + pings * 0.8;
        v *= 0.85 + vHover * 0.6;
        gl_FragColor = vec4(vec3(1.0, 0.3, 0.22) * v * 1.9 + vec3(1.0, 0.72, 0.6) * core * (1.2 + vPulse), 1.0);
      }`,
  });
}

/* Hover, selection and "you" markers: camera-facing HUD glyphs with pixel-true lines at any
 * scale. kind 0 hover: a clean ring with four ticks. kind 1 select: a segmented ring with inner
 * dashes and corner brackets. kind 2 you: a dashed ring with three chevrons closing in. */
function markerMesh(kind: 0 | 1 | 2, color: number, gain: number) {
  // HUD glyphs: never clipped by the opaque hero world they frame.
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    defines: { KIND: kind },
    uniforms: { uColor: { value: new THREE.Color(color).multiplyScalar(gain) } },
    vertexShader: /* glsl */ `varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying vec2 vP;
      float line(float x, float x0, float w) { float f = max(fwidth(x), 1e-5); return clamp(0.5 * w - abs(x - x0) / f + 0.5, 0.0, 1.0); }
      void main() {
        float r = length(vP), a = atan(vP.y, vP.x) / 6.2832 + 0.5;
        float f = max(fwidth(r), 1e-5);
        float v = 0.0;
        #if KIND == 0
          v = line(r, 1.0, 1.6);
          v += line(min(abs(vP.x), abs(vP.y)), 0.0, 1.6) * step(1.1, r) * step(r, 1.32);
        #elif KIND == 1
          v = line(r, 1.0, 2.2) * step(0.1, fract(a * 6.0 + 0.05));
          v += line(r, 0.84, 1.0) * step(0.5, fract(a * 48.0)) * 0.55;
          v += line(r, 1.24, 2.0) * step(abs(fract(a * 4.0) - 0.5), 0.075);
        #else
          v = line(r, 1.0, 1.6) * step(0.38, fract(a * 24.0));
          float s = 6.2832 / 3.0, ang = atan(vP.y, vP.x), k = floor(ang / s + 0.5), aa = ang - k * s;
          vec2 q = r * vec2(cos(aa), sin(aa));
          v += line(q.x - 1.16 - abs(q.y) * 0.9, 0.0, 2.2) * step(abs(q.y), 0.17) * 1.2;
        #endif
        float glow = exp(-abs(r - 1.0) / max(f * 5.0, 0.02)) * 0.12;
        gl_FragColor = vec4(uColor * (v + glow) * (1.0 - smoothstep(1.36, 1.45, r)), 1.0);
      }`,
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(2.9, 2.9), mat);
}

/** Where a fleet is on its route (0..1) and which way it is heading; shared by its route, trail and comet. */
type Raid = { uHead: { value: number }; uDir: { value: number }; uTail: { value: number }; uTime: { value: number } };
function raidUniforms(len: number): Raid {
  return { uHead: { value: 0 }, uDir: { value: 1 }, uTail: { value: clamp(14 / len, 0.04, 0.35) }, uTime: { value: 0 } };
}

/* A raid's route: a fine dashed lane (a true 1 px line at every zoom), crawling toward the target
 * and brightening at both ends. */
function routeLine(curve: THREE.QuadraticBezierCurve3, len: number, color: number, U: Raid) {
  const pts = curve.getPoints(Math.min(160, 32 + Math.round(len)));
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  g.setAttribute('u', new THREE.BufferAttribute(new Float32Array(pts.map((_, i) => i / (pts.length - 1))), 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { ...U, uDash: { value: Math.max(6, Math.round(len / 1.4)) }, uColor: { value: new THREE.Color(color) } },
    vertexShader: /* glsl */ `attribute float u; varying float vU; void main() { vU = u; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uHead, uDir, uTail, uDash; uniform vec3 uColor; varying float vU;
      void main() {
        float dash = step(0.45, fract(vU * uDash - uTime * 0.6));
        float ends = exp(-vU * 25.0) + exp(-(1.0 - vU) * 25.0);
        float behind = (uHead - vU) * uDir;
        float wake = behind >= 0.0 ? exp(-behind / uTail) : 0.0;
        gl_FragColor = vec4(uColor * (0.16 + 0.34 * dash + ends * 0.9 + wake * 0.8), 1.0);
      }`,
  });
  const line = new THREE.Line(g, mat);
  line.frustumCulled = false;
  return line;
}

/* The comet's trail: a tube that swells to a glowing filament just behind the fleet and tapers to
 * nothing (it collapses to zero width elsewhere), soft at its edges and white-hot near the head. */
const TRAIL_R = 0.12;
function trailMaterial(color: number, U: Raid) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { ...U, uColor: { value: new THREE.Color(color) } },
    vertexShader: /* glsl */ `
      uniform float uHead, uDir, uTail; varying float vTail; varying vec3 vN;
      void main() {
        float behind = (uHead - uv.x) * uDir;
        vTail = behind >= 0.0 ? exp(-behind / (uTail * 0.4)) : exp(behind * 400.0);
        vec3 p = position - normal * ${TRAIL_R} * (1.0 - 1.3 * vTail);
        vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying float vTail; varying vec3 vN;
      void main() {
        float facing = abs(vN.z);
        vec3 col = mix(uColor * 1.1, vec3(1.0, 0.86, 0.76) * 1.5, vTail * vTail) * vTail * facing * facing;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

/* The fleet itself: a white-hot head with a flare cross and a fraying tail of sparks, all placed
 * on the route's bezier in the shader (one shared geometry for every fleet). */
const COMET_SPARKS = 56;
function cometGeometry() {
  const rnd = mulberry(4417);
  const pos = new Float32Array(COMET_SPARKS * 3), lag = new Float32Array(COMET_SPARKS), seed = new Float32Array(COMET_SPARKS * 3);
  for (let i = 0; i < COMET_SPARKS; i++) {
    lag[i] = i === 0 ? 0 : Math.pow(i / COMET_SPARKS, 1.3);
    seed.set([rnd(), rnd(), rnd()], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('lag', new THREE.BufferAttribute(lag, 1));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 3));
  return g;
}
function cometMaterial(curve: THREE.QuadraticBezierCurve3, U: Raid) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { ...U, uPR: PIXEL_RATIO, uA: { value: curve.v0 }, uM: { value: curve.v1 }, uB: { value: curve.v2 } },
    vertexShader: /* glsl */ `
      attribute float lag; attribute vec3 seed;
      uniform float uTime, uHead, uDir, uTail, uPR; uniform vec3 uA, uM, uB;
      varying vec3 vColor; varying float vPx, vHead;
      void main() {
        float k = clamp(uHead - uDir * lag * uTail, 0.0, 1.0), o = 1.0 - k;
        vec3 p = o * o * uA + 2.0 * o * k * uM + k * k * uB;
        p += (seed - 0.5) * lag * lag * 2.4 + sin(uTime * 3.0 + seed * 40.0) * 0.12 * lag;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        vHead = step(lag, 0.0);
        float fl = 0.7 + 0.3 * sin(uTime * 23.0 + seed.x * 90.0);
        vColor = vHead > 0.5 ? vec3(1.0, 0.88, 0.8) * 2.4 : mix(vec3(1.0, 0.72, 0.56), vec3(0.93, 0.4, 0.32), lag) * pow(1.0 - lag, 1.6) * 1.5 * fl;
        vPx = (vHead > 0.5 ? 16.0 : 1.5 + 3.0 * (1.0 - lag)) * uPR * clamp(80.0 / -mv.z, 0.7, 1.6);
        gl_PointSize = vPx;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uPR; varying vec3 vColor; varying float vPx, vHead;
      void main() {
        vec2 c = (gl_PointCoord - 0.5) * vPx / uPR;
        float d = length(c), half_ = 0.5 * vPx / uPR;
        float core = exp(-d * d / (vHead > 0.5 ? 2.2 : 0.9));
        float halo = exp(-d / max(0.6, half_ * 0.3)) * 0.4 * vHead;
        float cross_ = (exp(-abs(c.x) * 1.8) + exp(-abs(c.y) * 1.8)) * (1.0 - smoothstep(0.0, half_, max(abs(c.x), abs(c.y)))) * vHead * 0.5;
        gl_FragColor = vec4(vColor * (core + halo + cross_) * (1.0 - smoothstep(half_ * 0.6, half_, d) * (1.0 - vHead)), 1.0);
      }`,
  });
}
