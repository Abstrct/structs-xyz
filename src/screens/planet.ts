/* A live planet: the game's map — defender Command Ship, planetary slots,
 * the home fleet, the divider, then any raider on the right — rebuilt in 3D
 * from the LCD, with the owner's dossier beside it. Real EventAttack rows
 * from the chain replay through the same choreography as the simulator. */
import '../styles/dc-base.css';
import * as THREE from 'three';
import { icon } from '../ui/icons';
import { face, head, pill, tip, vital } from '../ui/dcbase';
import type { Engine, Screen } from '../core/engine';
import { banner, copyText, h, hideTooltip, portrait, showTooltip, toast } from '../core/dom';
import { empire, type PlayerState } from '../game/empire';
import { act, buildable, formatDraw, reservedSlots, verbsFor } from '../game/actions';
import { wallet } from '../wallet/wallet';
import { txq, type TxJob } from '../wallet/queue';
import { openVault } from '../ui/vault';
import { openChannel } from '../ui/channel';
import { audio } from '../core/audio';
import { currentRoute, setPageMeta } from '../core/nav';
import { ago, blocksToDuration, clamp, damp, easeInOutCubic, formatAlpha, formatInt, formatPower, hash32, idIndex, powAgeFor, powDifficulty } from '../core/util';
import { lcd, num, big, statusText, type Grid, type PlanetAttributes, type RawFleet, type RawPlanet, type RawPlayer, type StructFull } from '../chain/lcd';
import { structsByIds } from '../chain/reader';
import { live } from '../chain/live';
import { store } from '../chain/store';
import { commander } from '../chain/commander';
import {
  type Ambit, AMBIT_NAME, AMBITS, COMMAND_SHIP_ID, controlName, DEFENSE_HINT, DEFENSE_NAME, PASSIVE_NAME, reachLabel,
  roleOf, TYPES_BY_ID, type StructType, type WeaponSystem, hasWeapon, weaponField, weaponLabel,
} from '../data/catalogue';
import { createNebulaSky, createStarfield, tickSpace } from '../gfx/space';
import { structPortrait } from '../gfx/hull/portrait';
import { BattleView, UnitView, type SideV } from './battle/view';
import { BoardZoom, bindDrag, bindPinch, bindTap } from './battle/zoom';
import { addBattleLights, WORLD_PALETTES } from './battle/env';
import type { AttackDetail, SimStruct } from '../sim/chain';
import { type ChainFleetInput, encodeBattle, mirrorUnits, unitsFromChainFleet, validate } from '../sim/fleets';
import { latestAttacks, summarize } from '../chain/combat';
import {
  type Arm, type Field, FieldOverlay, type Intent, type Slot, type TileSpec, addPick, asOwned, attackBlock, attackTargets, buildBlock, emptySlots,
  guardBlock, guardTargets, headroom, idsInMsg, intentBlock, moveDestinations, readyBlock, slotKey, slotOfMsg, tileKey, viewerRaids,
} from './planetActions';

const PALETTES = WORLD_PALETTES;

interface PlanetData {
  planet: RawPlanet; grid: Grid; attrs: PlanetAttributes;
  owner: RawPlayer | null; ownerGrid: Grid; alpha: string;
  fleet: RawFleet | null; raiders: RawFleet[];
  structs: Map<string, StructFull>;
}

function xFor(side: SideV, slot: number, command: boolean, column: 'fleet' | 'planet') {
  if (side === 'player') {
    if (command) return -31.2;
    return column === 'planet' ? -(16.6 + slot * 3.55) : -(2.9 + slot * 3.4);
  }
  return command ? 17.6 : 2.9 + slot * 3.4;
}

/** Chain JSON carries uint64 as strings; the choreography wants numbers. */
function numeric<T>(v: T): T {
  if (Array.isArray(v)) return v.map(numeric) as unknown as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      o[k] = typeof x === 'string' && /^-?\d+$/.test(x) && !/Id$|^id$|Ids$/.test(k) ? Number(x) : numeric(x);
    }
    return o as T;
  }
  return v;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const other = (s: SideV): SideV => (s === 'player' ? 'enemy' : 'player');
/** Tx hashes come upper-case from the LCD and the socket alike; normalise so a landed order is never replayed twice. */
const hkey = (hash: string) => hash.toUpperCase();
/** A held order goes stale after this many blocks: the board it was aimed on has moved on. */
const HOLD_BLOCKS = 40;
/** What a practice fight is, said once for its every button. */
const PRACTICE_WHAT = 'Puts these real fleets into a training battle, exactly as they are now: the same ships, layers, guards and damage. Nothing here can be lost.';

/** A unit whose colour (`side`: teal = the viewer's) and board half can differ: when the viewer
 * commands the raider, its ships are teal on the right and face left; the defender's red on the left. */
class MapUnit extends UnitView {
  constructor(id: string, side: SideV, s: SimStruct, private mirrored: boolean) { super(id, side, s); }
  override async load() {
    await super.load();
    if (this.mirrored) this.mesh.scale.x *= -1;
  }
  override get facing(): 1 | -1 { return this.mirrored ? (super.facing === 1 ? -1 : 1) : super.facing; }
}

/** A queued order's state in a word or two, for the marker over its struct. */
function pendText(j: TxJob): string {
  if (j.status === 'pending') return 'landing';
  if (j.status === 'signing') return 'signing';
  const m = /charging (\d+)\/(\d+)/.exec(j.waitReason || '');
  if (m) return `⚡${m[1]}/${m[2]}`;
  return j.waitReason === 'wallet locked' ? 'locked' : 'queued';
}

export class PlanetScreen implements Screen {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.1, 3000);
  readonly bloom = { strength: 0.75, radius: 0.5, threshold: 0.5 };
  private sky: THREE.Object3D[];
  private view: BattleView | null = null;
  private root!: HTMLElement;
  private layer!: HTMLElement;
  private planetId = '';
  private data: PlanetData | null = null;
  private selected: string | null = null;
  private hovered: string | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(9, 9);
  private pointerPx = { x: 0, y: 0 };
  private unsub: (() => void)[] = [];
  private els: Record<string, HTMLElement> = {};
  private fitDist = 60;
  private zoom = new BoardZoom(0.42, 19.5, 11.8);
  /** A drag of the map in progress (the cursor shows the grabbing hand meanwhile). */
  private dragging = false;
  private look = new THREE.Vector3(-6.5, -0.4, 0);
  private zoomLook = new THREE.Vector3();
  private capV = new THREE.Vector3();
  private shieldMesh: THREE.Mesh | null = null;
  /** One quiet re-read after a burst of attacks, not one per attack. */
  private attackReload = false;
  /** Dossier scroll to restore once late content (the last fight) has landed. */
  private dossierScroll = 0;
  private loadSeq = 0;
  private appliedSeq = 0;
  private sceneGen = 0;
  /** Smoothed camera state before zoom is applied. */
  private sway = new THREE.Vector2(0, 0.6);
  private cx = -6.5;
  private dist = 60;
  /** Screen x range no side panel covers. */
  private safeX: [number, number] = [0, 1e9];
  /** Screen y above which a folded dossier covers the map (phones). */
  private safeY = 0;
  private centerX = -6.5;
  private loadToken = 0;
  private refreshTimer: number | null = null;
  private fallbackHeight = 0;
  /** Arrival swoop: 0 → 1 as the camera descends from orbit to the map. */
  private intro = 1;
  private introPending = false;
  /** Which raider in the queue the map shows (the game's map shows one); null = queue head. */
  private raiderId: string | null = null;
  /* Playing the map: an armed order waiting for its target (weapon, guard post, move), the empty
   * slot whose build menu is open, and an order given while the vault was locked — it goes the
   * moment the vault opens. */
  private arm: Arm | null = null;
  private valid = new Set<string>();
  private buildAt: Slot | null = null;
  private overlay: FieldOverlay | null = null;
  private hoverTile: TileSpec | null = null;
  /** Transactions the live feed has shown (our own included), so a landed order isn't replayed twice. */
  private seenTx = new Set<string>();
  /** The queued attack whose lock-on line the board is drawing. */
  private intentJob: string | null = null;
  private fieldTimer = 0;
  private cardKey = '';
  /** An order waiting on the vault: what it means, whose it is, and when it was given. */
  private held: { label: string; intent: Intent; owner: string; account: number; height: number; after?: () => void } | null = null;
  /** The board's orientation: true when the viewer commands the raider (their ships teal, on the right). */
  private flip = false;
  /** Bumped whenever the field is re-derived: the hover tooltip rebuilds only when it changes. */
  private fieldVersion = 0;
  /** Some slot on the board glows to build in. */
  private canBuild = false;
  private tip = { key: '', x: -1, y: -1, node: null as HTMLElement | null };
  /** A double-click's second press lands just after the first gave an order: swallow it. */
  private quietUntil = 0;
  private get height() { return live.height || this.fallbackHeight; }

  constructor(private engine: Engine, private navigate: (h: string) => void) {
    this.sky = [createNebulaSky({ seed: 23.1, intensity: 0.85 }), createStarfield(5000, 800, 33)];
    for (const s of this.sky) this.scene.add(s);
    addBattleLights(this.scene);
    this.camera.position.set(-6.5, 0.6, 60);
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */
  async enter(params: Record<string, string>) {
    this.root = h('div', { class: 'screen planet' });
    this.layer = h('div', { class: 'tags-layer' });
    this.root.appendChild(this.layer);
    document.getElementById('ui')!.appendChild(this.root);
    this.bindInput();
    // Load without blocking the router: the person can leave a slow world.
    void this.start(params, ++this.loadToken);
  }

  private timers = new Set<number>();
  private refreshSoon = 0;
  private later(ms: number, f: () => void) {
    const id = window.setTimeout(() => { this.timers.delete(id); f(); }, ms);
    this.timers.add(id);
    return id;
  }

  private async start(params: Record<string, string>, token: number) {
    this.introPending = true;
    this.zoom.reset(true);
    this.raiderId = null;
    // While the chain answers: the dossier's outline with a scan sweeping it, and a receiving pill
    // (dc-polish.css), never a bare line of text on empty sky.
    const bars = () => h('span', { class: 'dcp-bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
    const loading = h('div', { class: 'planet-loading', role: 'status', 'aria-label': 'Reading this world from the chain' },
      h('div', { class: 'planet-skel panel player dcp-sweep', 'aria-hidden': 'true' },
        h('i', { class: 'sk-title' }), h('i', { class: 'sk-bar' }), h('div', { class: 'sk-grid' }, h('i'), h('i'), h('i'), h('i')), h('i', { class: 'sk-bar' }), h('i', { class: 'sk-bar short' })),
      h('span', { class: 'dcp-rx planet-rx', title: 'Reading this world from the chain' }, h('span', { class: 'dcp-dish', 'aria-hidden': 'true', html: icon('planet', 16) }), bars(), 'Receiving'));
    this.root.appendChild(loading);
    try {
      let id = params.id || '';
      if (params.player) {
        const p = await lcd.player(params.player);
        if (token !== this.loadToken) return;
        id = p.Player.planetId;
        if (!id) {
          loading.remove();
          this.renderNoPlanet(p.Player);
          return;
        }
      }
      this.planetId = id;
      await this.load(token);
    } catch (e) {
      if (token !== this.loadToken) return;
      loading.remove();
      // No signal: the dish, two words and the way on; the testnet's own words are in the title.
      const why = 'Could not read ' + (params.id || params.player) + ' from the testnet: ' + String((e as Error).message || e);
      const panel = h('div', { class: 'planet-error panel enemy', role: 'alert' }, h('div', { class: 'panel-body col', title: why },
        h('span', { class: 'dcp-dish big', 'aria-hidden': 'true', html: icon('planet', 34) }),
        h('div', { class: 't-display c-enemy' }, 'No signal'),
        h('div', { class: 't-body c-hint' }, 'The testnet didn’t answer.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => this.navigate('/galaxy') }, h('span', { html: icon('back', 16) }), 'Galaxy'),
          h('button', { class: 'btn solid', onclick: () => { audio.play('select'); panel.remove(); void this.start(params, ++this.loadToken); } }, h('span', { html: icon('refresh', 16) }), 'Try again'))));
      this.root.appendChild(panel);
      return;
    }
    if (token !== this.loadToken) return;
    loading.remove();
    this.unsub.push(live.onTx((tx) => {
      // Our own order may already have played from its receipt (the socket was slow): once only.
      if (tx.hash) { const k = hkey(tx.hash); if (this.seenTx.has(k)) return; this.seenTx.add(k); }
      if (this.seenTx.size > 4000) [...this.seenTx].slice(0, 2000).forEach((x) => this.seenTx.delete(x));
      this.onTx(tx.events);
    }));
    this.unsub.push(live.onBlock((b) => {
      this.paintCommander(); this.paintBattery();
      if (this.held && this.held.height && b.height - this.held.height > HOLD_BLOCKS) {
        toast(`Dropped “${this.held.label}” — held too long for the vault; the board has moved on`, 'warn', 4000);
        this.held = null;
        this.renderCard();
      }
    }));
    this.unsub.push(txq.onChange(() => this.fieldSoon()), txq.onSettled((j) => this.settled(j)));
    this.unsub.push(empire.onChange(() => this.empireChanged()), wallet.onChange(() => this.walletChanged()));
    this.unsub.push(store.onFeed((item) => { if (!item.replay && (item.planetId === this.planetId || (this.data?.owner && item.playerId === this.data.owner.id))) this.addLog(item.text, item.tone, item.height, item.kind === 'attack' ? item.hash : undefined); }));
    this.refreshTimer = window.setInterval(() => { void this.load(this.loadToken, true); }, 45000);
  }

  exit() {
    this.loadToken++;            // any load still in flight is now stale
    this.dossierScroll = 0;      // a restore still pending belongs to this planet, not the next
    this.unsub.forEach((f) => f());
    this.unsub = [];
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.attackReload = false;
    clearTimeout(this.fieldTimer); this.fieldTimer = 0;
    this.arm = null; this.buildAt = null; this.held = null; this.hoverTile = null; this.valid.clear();
    this.seenTx.clear(); this.intentJob = null; this.cardKey = '';
    this.pointer.set(9, 9); this.hovered = null; this.tip = { key: '', x: -1, y: -1, node: null }; this.quietUntil = 0;
    this.disposeView();
    this.data = null;
    this.els = {};
    hideTooltip();
    this.root.remove();
    this.selected = null;
    this.engine.canvas.style.cursor = 'default';
  }

  resize() { this.view?.fx.setScale(window.innerHeight, this.camera.fov); this.fit(); }

  private fit() {
    const w = window.innerWidth, hgt = window.innerHeight;
    // Mirror the CSS: the dossier is 320px wide above 1100px, 280px down to 760px; the log docks above 1300px.
    const left = w > 1100 ? 336 : w > 760 ? 296 : 0, right = w > 1300 ? 300 : 0;
    this.safeX = [left, w - right];
    const usableW = Math.max(320, w - left - right);
    const narrow = w <= 760;
    // Phones: the map lives between the (folded) dossier and the bottom bar.
    const topBand = narrow ? Math.max(110, (this.els.left?.classList.contains('collapsed') ? this.els.left.getBoundingClientRect().bottom : 160) + 10) : 0;
    const usableH = narrow ? Math.max(200, hgt - topBand - 90) : Math.max(200, hgt - 300);
    // Captions hide under whatever the dossier covers right now (open or folded).
    this.safeY = narrow ? Math.max(topBand, (this.els.left?.getBoundingClientRect().bottom || 0) + 4) : 0;
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    // Frame what is there: the whole map when raiders are in orbit, otherwise just
    // the defender's columns (flagship, planetary slots, home fleet).
    const raided = !!this.data?.raiders.length;
    // Wide enough that the battleground labels at the board's left edge stay clear of the dossier.
    const halfW = raided ? 28 : 21.5, halfH = 11.8;
    this.centerX = raided ? -6.5 : -13.4;
    this.look.x = this.centerX;
    this.fitDist = Math.max(halfW / (t * (usableW / hgt)), halfH / (t * (usableH / hgt)), 34);
    this.zoom.center.set(this.centerX, 0);
    this.zoom.setBounds(halfW, halfH);
    this.camera.setViewOffset(w, hgt, (right - left) / 2, narrow ? -((topBand + hgt - 90) / 2 - hgt / 2) : 40, w, hgt);
    this.camera.updateProjectionMatrix();
  }

  /* ── Data ─────────────────────────────────────────────────────────────── */
  private async load(token: number, quiet = false) {
    // Refreshes can overlap (timer, events, button): the newest read wins, an older one is dropped.
    const seq = ++this.loadSeq;
    const minHeight = live.height;
    if (!live.height && !this.fallbackHeight) this.fallbackHeight = await lcd.latestHeight().then((r) => r.height).catch(() => 0);
    const pf = await lcd.planet(this.planetId);
    if (token !== this.loadToken) return;
    const planet = pf.Planet;
    const ownerId = planet.owner;
    await store.loadCore().catch(() => {});
    const [ownerFull, fleet] = await Promise.all([
      ownerId ? lcd.player(ownerId).catch(() => null) : Promise.resolve(null),
      ownerId ? lcd.fleet('9-' + idIndex(ownerId)).catch(() => null) : Promise.resolve(null),
    ]);
    // The page is named after the world and its commander (search results, link previews, the tab).
    if (/^\/(planet|player)\//.test(currentRoute())) {
      const ownerName = ownerId ? (store.players.get(ownerId)?.name || ownerId) : null;
      setPageMeta({ title: ownerName ? `${ownerName} · ${this.planetId}` : `Planet ${this.planetId}`, description: `${ownerName ? `${ownerName}’s world ${this.planetId}` : `Planet ${this.planetId}`} on the Structs testnet: the planet map in 3D, structs, guards, raiders, ore, shield and the commander’s dossier.` });
    }
    // Queue head first: the fleet with nothing ahead of it raids; the rest wait.
    const raiders = [...store.fleets.values()].filter((f) => f.locationId === this.planetId && f.owner !== ownerId && f.status === 'away')
      .sort((a, b) => (a.locationListForward ? 1 : 0) - (b.locationListForward ? 1 : 0));
    // Unless one was picked, show our own raiding fleet if we have one here: that's the fight we play.
    const preferred = this.raiderId ?? raiders.find((f) => empire.commands(f.owner))?.id;
    const at = Math.max(0, raiders.findIndex((f) => f.id === preferred));
    const shown = raiders.length ? [raiders[at], ...raiders.filter((_, i) => i !== at)] : [];
    // Fresh copy of the shown raider's fleet (its slots change in combat).
    const raiderFull = await Promise.all(shown.map((f, i) => (i === 0 ? lcd.fleet(f.id).catch(() => f) : Promise.resolve(f))));
    const ids = new Set<string>();
    const addAll = (list: string[] | undefined) => (list || []).forEach((x) => x && ids.add(x));
    for (const a of AMBITS) addAll(planet[a]);
    const fleetHome = fleet && fleet.locationId === this.planetId ? fleet : null;
    if (fleetHome) { for (const a of AMBITS) addAll(fleetHome[a]); if (fleetHome.commandStruct) ids.add(fleetHome.commandStruct); }
    for (const r of raiderFull.slice(0, 1)) { for (const a of AMBITS) addAll(r[a]); if (r.commandStruct) ids.add(r.commandStruct); }
    // The guild answers each side's structs in one read (src/chain/reader.ts); else one LCD read each.
    const structs = await structsByIds(ids, [ownerId, raiderFull[0]?.owner], minHeight);
    // The owner's secondary capacity is their substation's per-connection share.
    const subId = ownerFull?.Player?.substationId;
    const sub = subId ? await lcd.entity<{ gridAttributes?: Grid }>('substation', subId).catch(() => null) : null;
    if (token !== this.loadToken || seq < this.appliedSeq) return;
    this.appliedSeq = seq;
    this.data = {
      planet, grid: pf.gridAttributes || {}, attrs: pf.planetAttributes || {},
      owner: ownerFull?.Player || null, ownerGrid: { ...(ownerFull?.gridAttributes || {}), connectionCapacity: sub?.gridAttributes?.connectionCapacity || '0' }, alpha: ownerFull?.playerInventory?.rocks?.amount || '0',
      fleet, raiders: raiderFull, structs,
    };
    // A quiet refresh only re-syncs, unless structs arrived or left (a new raider, a build).
    const changed = !this.view || this.flipNow() !== this.flip || [...structs.keys()].some((id) => !this.view!.units.has(id)) || [...this.view.units.keys()].some((id) => !structs.has(id));
    if (!quiet || changed) await this.buildScene();
    else if (this.view?.busy) this.view.enqueue(async () => this.syncUnits());   // let explosions play first
    else this.syncUnits();
    if (token !== this.loadToken) return;
    this.renderHud();
  }

  private async buildScene() {
    const d = this.data!;
    this.disposeView();
    const seed = hash32(this.planetId);
    const spent = !(d.planet.status === 'active' || d.planet.status === '0');
    this.flip = this.flipNow();
    this.view = new BattleView(this.camera, this.layer, { halfWidth: 33, palette: PALETTES[seed % PALETTES.length], seed: (seed % 1000) / 37, spent });
    // `side` is the colour (teal = the viewer's); the board half is the defender's left, the raider's right.
    this.view.xFor = (side, slot, command, column) => xFor(this.flip ? other(side) : side, slot, command, column);
    this.view.fx.scale = 1.9;
    this.view.group.position.x = 0;
    this.scene.add(this.view.group);
    this.view.fx.setScale(window.innerHeight, this.camera.fov);
    this.view.onShake = (a) => this.engine.addShake(a * 0.6);
    this.view.onFlash = (a, c) => this.engine.addFlash(a * 0.5, c);
    const gen = ++this.sceneGen;
    const view = this.view;
    const views: UnitView[] = [];
    for (const [id, s] of d.structs) {
      const v = this.unitFor(id, s);
      if (v) views.push(v);
    }
    await view.addUnits(views);
    // A newer build replaced this one while its models loaded: leave the board to it.
    if (gen !== this.sceneGen || this.view !== view) return;
    this.syncUnits();
    // Keep the open struct card's highlight (or drop the card if that struct is gone).
    if (this.selected && !view.units.has(this.selected)) { this.selected = null; this.renderCard(); }
    for (const u of view.units.values()) u.selected = u.id === this.selected;
    this.overlay = new FieldOverlay(xFor, this.camera);
    view.group.add(this.overlay.group);
    this.intentJob = null;   // a new board has no lock-on line yet
    this.refreshField();
    this.buildShield();
    this.fit();
    if (this.introPending) {
      this.introPending = false;
      this.intro = this.engine.reduceMotion ? 1 : 0;
      this.cx = this.centerX; this.sway.set(0, 0.6); this.dist = this.fitDist;
      audio.play('warp', 0.5);
    }
  }

  /* The planetary shield as a hex-energy shell over the planetary slots; its
   * strength follows planetaryShield (base 25 + every defensive struct online). */
  private shieldMat: THREE.ShaderMaterial | null = null;
  private activityAcc = 0;
  private buildShield() {
    const d = this.data, view = this.view;
    if (!d || !view) return;
    const spent = !(d.planet.status === 'active' || d.planet.status === '0');
    if (spent) { this.shieldMat = null; return; }
    const shield = num(d.attrs.planetaryShield);
    const strength = clamp(shield / 260, 0.18, 1);
    const geo = new THREE.CylinderGeometry(1, 1, 23, 64, 1, true, -Math.PI / 2, Math.PI);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uStrength: { value: strength }, uColor: { value: new THREE.Color(this.flip ? 0xee7d69 : 0x43cdb6) }, uRaid: { value: d.raiders.length ? 1 : 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main() {
          vUv = uv; vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uStrength, uRaid; uniform vec3 uColor; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        float hexDist(vec2 p) { p = abs(p); return max(dot(p, vec2(0.5, 0.8660254)), p.x); }
        void main() {
          // A hex lattice with crisp edges; each cell knows who it is.
          vec2 uv = vec2(vUv.x * 20.0, vUv.y * 24.0);
          vec2 r = vec2(1.0, 1.7320508), hh = r * 0.5;
          vec2 a0 = mod(uv, r) - hh, b0 = mod(uv - hh, r) - hh;
          vec2 gv = dot(a0, a0) < dot(b0, b0) ? a0 : b0;
          vec2 id = uv - gv;
          float edge = 0.5 - hexDist(gv);
          float px = fwidth(edge);
          float line = 1.0 - smoothstep(0.0, px * 1.5 + 0.004, edge - 0.012);
          float h = fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453);
          // Cells take the charge in turn, flaring and fading.
          float spark = pow(max(0.0, sin(uTime * (0.35 + h * 0.6) + h * 40.0)), 24.0);
          float fres = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.4);
          float sq = (fract(vUv.y * 0.8 - uTime * 0.07) - 0.5) * 10.0;
          float scan = exp(-sq * sq);
          float drift = 0.75 + 0.25 * sin(vUv.y * 9.0 - uTime * 0.9 + vUv.x * 5.0);
          float flicker = uRaid > 0.5 ? 0.6 + 0.4 * step(0.3, fract(sin(floor(uTime * 12.0)) * 43758.5)) : 1.0;
          float edgeFade = smoothstep(0.0, 0.06, vUv.y) * smoothstep(1.0, 0.93, vUv.y);
          float fill = 0.025 + fres * 0.42;
          float lines = line * (0.15 + fres * 0.7 + scan * 0.5) * drift;
          float cells = spark * smoothstep(0.0, 0.45, edge) * 0.32;
          float a = (fill + lines * 1.3 + cells + scan * 0.05) * uStrength * edgeFade * flicker;
          gl_FragColor = vec4(uColor * a, a);
        }`,
    });
    const shell = new THREE.Mesh(geo, mat);
    shell.position.set(-22, -0.2, -0.4);
    shell.scale.set(7.4, 1, 4.6);
    shell.renderOrder = 6;
    view.group.add(shell);
    this.shieldMat = mat;
    this.shieldMesh = shell;
  }

  /** Free the board, including the shield shell BattleView doesn't own. */
  private disposeView() {
    this.overlay?.dispose(); this.overlay = null;
    if (this.shieldMesh) { this.shieldMesh.geometry.dispose(); (this.shieldMesh.material as THREE.Material).dispose(); this.shieldMesh = null; this.shieldMat = null; }
    if (this.view) { this.scene.remove(this.view.group); this.view.dispose(); this.view = null; }
  }

  /* Visible work: sparks at an extractor that is mining, embers at a refinery
   * that is refining, motes rising from generators that are online. */
  private updateActivity(dt: number) {
    const d = this.data, view = this.view;
    if (!d || !view) return;
    this.activityAcc += dt;
    if (this.activityAcc < 0.09) return;
    this.activityAcc = 0;
    const mining = num(d.attrs.oreMiningActiveQuantity) > 0, refining = num(d.attrs.oreRefiningActiveQuantity) > 0;
    for (const u of view.units.values()) {
      if (u.destroyed || u.building || !u.online || u.column !== 'planet') continue;
      const p = u.root.position.clone(); p.y += u.pivot.position.y;
      if (u.typeId === 14 && mining) {
        p.y -= u.halfHeight * 0.8;
        view.fx.particles.spawn({ pos: p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0, 0.6)), vel: new THREE.Vector3((Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, 0.5), color: 0xffd27a, size: 0.14, life: 0.5, drag: 1.5, gravity: 6 });
      } else if (u.typeId === 15 && refining) {
        view.fx.particles.spawn({ pos: p.clone().add(new THREE.Vector3((Math.random() - 0.5) * u.halfWidth, u.halfHeight * 0.6, 0.4)), vel: new THREE.Vector3(0, 0.8 + Math.random(), 0), color: 0xff9a4a, size: 0.22, life: 1.2, drag: 0.8 });
      } else if (u.typeId >= 20 && u.typeId <= 22 && Math.random() < 0.6) {
        view.fx.particles.spawn({ pos: p.clone().add(new THREE.Vector3((Math.random() - 0.5) * u.halfWidth, u.halfHeight * 0.4, 0.3)), vel: new THREE.Vector3(0, 1 + Math.random(), 0), color: 0x7ff0dc, size: 0.18, life: 1.4, drag: 0.6 });
      }
    }
  }

  /** Whether the viewer plays the raid on this board (see `viewerRaids`). */
  private flipNow() {
    const d = this.data;
    return !!d && viewerRaids(d.planet.owner, d.raiders[0]?.owner, (id) => empire.commands(id));
  }

  /** Colour by allegiance to the viewer: teal for the side they play (the defender, for spectators). */
  private sideOf(owner: string): SideV {
    const home: SideV = owner === this.data?.planet.owner ? 'player' : 'enemy';
    return this.flip ? other(home) : home;
  }

  private unitFor(id: string, s: StructFull): UnitView | null {
    const st = s.Struct;
    const typeId = Number(st.type);
    if (!TYPES_BY_ID[typeId]) return null;
    const ambit = (st.operatingAmbit || 'land') as Ambit;
    const sim: SimStruct = {
      id, typeId, owner: st.owner, locationType: 'fleet', locationId: st.locationId, ambit, slot: num(st.slot),
      health: num(s.structAttributes?.health), status: num(s.structAttributes?.status), protectedStructId: null, destroyedAt: null,
    };
    const v = new MapUnit(id, this.sideOf(st.owner), sim, this.flip);
    v.column = st.locationType === 'planet' ? 'planet' : 'fleet';
    return v;
  }

  /** Apply attributes (health, hidden, building, destroyed) and guard tethers. */
  private syncUnits() {
    const d = this.data, view = this.view;
    if (!d || !view) return;
    const pairs: { from: string; to: string }[] = [];
    for (const [id, s] of d.structs) {
      const u = view.units.get(id);
      if (!u) continue;
      const a = s.structAttributes || {};
      const st = num(a.status);
      u.setHealth(num(a.health));
      u.setHidden(!!a.isHidden);
      u.online = !!a.isOnline;
      u.building = !a.isBuilt;
      if (a.isDestroyed && !u.destroyed) { u.destroyed = true; u.mesh.visible = false; u.ring.visible = false; u.tag.remove(); }
      void st;
      for (const def of s.structDefenders || []) if (d.structs.has(def)) pairs.push({ from: def, to: id });
    }
    view.setTethers(pairs);
    // Reach follows state (a target went dark, a shooter went offline): re-ring the armed order.
    this.refreshField();
  }

  /* ── Live ─────────────────────────────────────────────────────────────── */
  private onTx(events: { type: string; data: any }[]) {
    const d = this.data, view = this.view;
    if (!d || !view) return;
    let refresh = false, sync = false;
    for (const e of events) {
      const x = e.data;
      if (!x) continue;
      if (e.type === 'EventAttack') {
        const det = numeric(x.eventAttackDetail || x) as AttackDetail;
        const involved = view.units.has(det.attackerStructId) || (det.eventAttackShotDetail || []).some((r) => view.units.has(r.targetStructId));
        if (involved) {
          if (this.intentJob && txq.jobs.find((j) => j.id === this.intentJob)?.msgs.some((m) => m.value.operatingStructId === det.attackerStructId)) { view.clearIntent(); this.intentJob = null; }
          view.playChainAttack(det);
          this.addLog(`${det.attackerStructType} ${det.attackerStructId} opened fire`, 'enemy', live.height);
          if (!this.attackReload) { this.attackReload = true; this.later(6000, () => { this.attackReload = false; void this.load(this.loadToken, true); }); }
        }
      } else if (e.type === 'EventStructAttribute') {
        const rec = x.structAttributeRecord || x;
        const [attr, , idx] = String(rec.attributeId || '').split('-');
        const sid = '5-' + idx;
        const s = d.structs.get(sid);
        if (!s) continue;
        s.structAttributes = s.structAttributes || {};
        if (rec.value == null) continue;
        if (attr === '0') s.structAttributes.health = String(rec.value);
        if (attr === '1') {
          const m = Number(rec.value);
          Object.assign(s.structAttributes, { status: String(m), isBuilt: !!(m & 2), isOnline: !!(m & 4), isHidden: !!(m & 16), isDestroyed: !!(m & 32) });
        }
        sync = true;
      } else if (e.type === 'EventPlanet' && (x.id === this.planetId)) {
        refresh = true;
      } else if (e.type === 'EventStruct' && (x.locationId === this.planetId || x.locationId === d.fleet?.id || d.raiders.some((r) => r.id === x.locationId))) {
        refresh = true;
      } else if (e.type === 'EventFleet' && (x.locationId === this.planetId || x.id === d.fleet?.id)) {
        refresh = true;
      } else if (e.type === 'EventRaid' && ((x.eventRaidDetail || x).planetId === this.planetId)) {
        const st = (x.eventRaidDetail || x).status;
        if (st === 'raidSuccessful') { audio.stinger('vulnerable', 0.7); toast('Raid successful — ore stolen from this world', 'enemy', 5000); }
        refresh = true;
      } else if (e.type === 'EventGrid' || e.type === 'EventPlanetAttribute') {
        const id = String((x.gridRecord || x.planetAttributeRecord || x).attributeId || '');
        const parts = id.split('-');
        const obj = parts[1] + '-' + parts[2];
        if (obj === this.planetId || obj === d.owner?.id) refresh = true;
      }
    }
    // One re-sync per transaction, not one per attribute row.
    if (sync && !view.busy) this.syncUnits();
    if (refresh) {
      if (this.refreshSoon) { clearTimeout(this.refreshSoon); this.timers.delete(this.refreshSoon); }
      this.refreshSoon = this.later(1200, () => { this.refreshSoon = 0; void this.load(this.loadToken, true); });
    }
  }

  /* ── HUD ─────────────────────────────────────────────────────────────── */
  private renderNoPlanet(p: RawPlayer) {
    this.root.appendChild(h('div', { class: 'planet-error panel player' }, h('div', { class: 'panel-body row', style: 'align-items:flex-start' },
      portrait(p.pfpClientRenderAttributes, 'player', p.id),
      h('div', { class: 'col' },
        h('div', { class: 't-display c-player' }, p.name || p.id),
        h('div', { class: 't-body c-hint', title: 'Their last world may be spent. A new one comes from planet-explore.' }, 'No planet right now.', h('span', { class: 'x-only' }, ' A new one comes from ', h('code', null, 'planet-explore'), '.')),
        pill('back', 'Galaxy', 'Back to the galaxy', () => this.navigate('/galaxy'), 'btn')))));
  }

  private renderHud() {
    const d = this.data!;
    // Read before the old dossier is detached (a detached element reports scrollTop 0).
    // A restore still pending from the previous render (clamped, waiting on late content) wins.
    const wasScroll = Math.max(this.dossierScroll, this.els.left?.isConnected ? this.els.left.scrollTop : 0);
    this.root.querySelectorAll('.planet-left, .planet-right, .planet-crumbs, .planet-columns').forEach((n) => n.remove());
    const p = d.planet;
    const spent = !(p.status === 'active' || p.status === '0');
    const ore = num(d.grid.ore), maxOre = num(p.maxOre);
    const a = d.attrs;
    const shield = num(a.planetaryShield);
    const interceptors = num(a.lowOrbitBallisticsInterceptorNetworkQuantity) + num(a.advancedLowOrbitBallisticsInterceptorNetworkQuantity);
    const cannons = num(a.defensiveCannonQuantity);
    const mining = num(a.blockStartOreMine), refining = num(a.blockStartOreRefine), raidStart = num(a.blockStartRaid);
    const height = this.height;
    const owner = d.owner;
    const guild = owner ? store.guildName(owner.guildId) : '—';
    // A spent world's former owner has moved on: their fleet is not "away", it is elsewhere for good.
    const fleetAway = !spent && d.fleet && d.fleet.locationId !== this.planetId;
    const newHome = spent && owner?.planetId && owner.planetId !== this.planetId ? owner.planetId : null;

    const progress = (since: number) => (height ? `${blocksToDuration(height - since)} ago` : `block #${formatInt(since)}`);
    /* A proof clock as a vital: dim "—" while idle; plain, the wait until its puzzle is easy (✓ once it
     * is); Expert, its age and the difficulty the chain will ask for, -D 3 being cheap. */
    const clock = (ico: string, label: string, hint: string, since: number, range: number, tone: string, idle = 'idle') => {
      if (!since) return vital(ico, '—', `${label}: ${idle}`, hint, 'dim dcb-clock');
      if (!height) return vital(ico, 'since ' + progress(since), label, hint, tone + ' dcb-clock');
      const age = height - since, d = powDifficulty(age, range), cheapAt = powAgeFor(3, range) - age;
      const readout = `${blocksToDuration(age)} · D${d}` + (cheapAt > 0 ? ` → D3 in ${blocksToDuration(cheapAt)}` : ' · cheap');
      // Expert mode's readout is long: there the clock takes a whole row (dc-base.css), and the tip repeats it.
      return vital(ico, h('span', null, h('span', { class: 'x-only' }, readout), h('span', { class: 's-only' }, cheapAt > 0 ? blocksToDuration(cheapAt) : '✓')),
        `${label}: ${cheapAt > 0 ? `easy in ${blocksToDuration(cheapAt)}` : 'ready to finish'}`,
        `${hint} Age ${readout}. Proof-of-work difficulty decays with age: 64 − ⌊log10(age)/log10(${formatInt(range)})·63⌋. Started block #${formatInt(since)}.`, tone + ' dcb-clock');
    };
    const extractor = TYPES_BY_ID[14], refinery = TYPES_BY_ID[15];
    // With a raider at the head of the queue the chain pauses the ore clocks (PauseOreClocksForRaid).
    const raidPaused = d.raiders.length > 0 && num(a.blockRaiderArrived) > 0;
    const paused = (ico: string, label: string) => vital(ico, '❚❚', `${label}: paused by raid`, 'Ore clocks pause while a raider heads the queue; their age resumes after the raid.', 'c-enemy dcb-clock');
    const used = AMBITS.map((x) => (p[x] || []).filter(Boolean).length).reduce((s, n) => s + n, 0);
    // On a phone the dossier folds to its header (tap to open) so the map gets the screen.
    const wasOpen = this.els.left ? !this.els.left.classList.contains('collapsed') : false;
    const left = h('div', { class: 'planet-left panel ' + (d.raiders.length ? 'enemy' : 'player') + (window.innerWidth <= 760 && !wasOpen ? ' collapsed' : '') },
      h('div', { class: 'panel-head dcb-head', title: 'Dossier', onclick: () => { if (window.innerWidth > 760) return; left.classList.toggle('collapsed'); audio.play('select'); this.fit(); } },
        h('span', { class: 'dcb-head-t' }, h('span', { class: 'dcb-ico', html: icon('planet', 18) }), h('span', { class: 't-label' }, p.id, p.name ? h('span', { class: 'dcb-strip-name' }, ' · ' + p.name) : null)),
        h('span', { class: 'row', style: 'gap:6px' }, h('span', { class: 'chip ' + (spent ? 'warn' : d.raiders.length ? 'enemy' : 'player') }, spent ? 'Spent' : d.raiders.length ? 'Under raid' : 'Active'), h('span', { class: 'fold-ind t-label', 'aria-label': 'Dossier' }))),
      h('div', { class: 'panel-body col' },
        h('div', { class: 't-display ' + (spent ? 'c-warn' : 'c-player'), style: 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap' }, p.name || (owner ? (owner.name || owner.id) + (spent ? '’s former world' : '’s world') : 'Unclaimed world')),
        spent ? tip(h('div', { class: 't-tiny c-warn', tabindex: 0 }, 'Spent: its ore ran out.'), 'Spent: its ore ran out', 'The world and every struct on it went with it.', 'neutral') : null,
        newHome ? pill('base', `Home ${newHome} ▸`, 'Their current home', () => this.navigate('/planet/' + newHome)) : null,
        // The world's ore as cells: what is left to mine, out of what it started with.
        vital('mine', `${ore}/${maxOre}`, 'Unmined ore', ore <= 1 && !spent ? 'Nearly exhausted. When the last ore goes, the world and everything on it go with it.' : 'Each mining run lifts one ore into the commander’s hold, where raiders can take it.',
          'dcb-ore ' + (ore <= 1 && !spent ? 'c-warn hot' : 'c-neutral'), h('span', { class: 'ore-cells' }, Array.from({ length: Math.max(maxOre, 1) }, (_, i) => h('i', { class: i < ore ? 'on' : '' })))),
        h('div', { class: 'dcb-vitals dossier-kv' },
          vital('shield', formatInt(shield), 'Shield', 'Base 25 plus every defensive struct online. The higher it is, the harder the raid puzzle.', 'c-secondary'),
          vital('target', String(cannons), 'Defense cannons', 'Planetary cannons that fire back at raiders.', cannons ? 'c-player' : 'dim'),
          vital('air', interceptors ? `${interceptors} · ${num(a.lowOrbitBallisticsInterceptorNetworkSuccessRateNumerator)}/${num(a.lowOrbitBallisticsInterceptorNetworkSuccessRateDenominator) || 1}` : '0', 'Interceptors', 'Low-orbit ballistic interceptors: how many, and their success rate.', 'x-only'),
          vital('build', `${used}/16`, 'Slots used', 'Planetary slots built on, of 16.'),
          raidPaused && mining ? paused('mine', 'Mining') : clock('mine', 'Mining', 'Each run lifts one ore into the hold.', num(a.oreMiningActiveQuantity) ? mining : 0, extractor.oreMiningDifficulty || 14000, 'c-neutral'),
          raidPaused && refining ? paused('alpha', 'Refining') : clock('alpha', 'Refining', 'Each run turns one ore into alpha.', num(a.oreRefiningActiveQuantity) ? refining : 0, refinery.oreRefiningDifficulty || 28000, 'c-player'),
          raidStart ? clock('battle', 'Raid clock', 'The raider’s puzzle: when it is solved, the raid takes the ore.', raidStart, Math.max(2, shield), 'c-enemy') : vital('battle', '—', 'Raid clock: not raidable', 'No raid is under way here.', 'dim'),
        ),
        h('div', { class: 'divider' }),
        owner ? this.commanderBlock(owner, guild, !!fleetAway) : h('div', { class: 't-body c-hint' }, 'No commander holds this world.'),
      ));
    left.appendChild(this.simBlock());
    this.els.left?.remove();
    this.root.appendChild(left);
    this.els.left = left;
    left.scrollTop = wasScroll;
    // If the new dossier was too short to reach the old position yet, finish the restore when the
    // late last-fight line lands, unless the user scrolls first.
    this.dossierScroll = left.scrollTop < wasScroll ? wasScroll : 0;
    // Arm the "user scrolled" check only after the restore's own scroll event has passed.
    if (this.dossierScroll) window.setTimeout(() => { if (left.isConnected) left.addEventListener('scroll', () => { this.dossierScroll = 0; }, { once: true, passive: true }); }, 150);
    this.lastCombat(left, p.id);

    const raiderRows = d.raiders.map((r, i) => h('div', { class: 'raider-row' + (i === 0 ? ' shown' : '') },
      h('button', { class: 'linkish ' + (empire.commands(r.owner) ? 'c-player' : 'c-enemy'), title: i === 0 ? 'On the map' : 'Show this raider on the map', onclick: () => { if (i === 0) return; this.raiderId = r.id; void this.load(++this.loadToken); } },
        (i === 0 ? '▸ ' : '') + store.playerName(r.owner)),
      h('span', { class: 'dcb-ico c-hint', title: r.locationListForward ? 'Queued behind the head of the raid' : 'Raiding: at the head of the queue', html: icon(r.locationListForward ? 'queue' : 'battle', 16) }),
      pill('planet', '', 'Their world', () => this.navigate('/player/' + r.owner), 'btn ghost mini')));
    this.els.log = h('div', { class: 'feed scroll' });
    const right = h('div', { class: 'planet-right panel' },
      head('ship', 'Raiders', 'Fleets in this world’s orbit, raiding it (the first is on the map)', h('span', { class: 'chip ' + (d.raiders.length ? 'enemy' : '') }, String(d.raiders.length))),
      h('div', { class: 'panel-body col', style: 'gap:4px' }, raiderRows.length ? raiderRows
        : fleetAway ? tip(h('div', { class: 't-tiny c-warn', tabindex: 0 }, 'Fleet away: exposed.'), 'Fleet away: exposed', 'No raiders — but the home fleet is away, so this world is exposed.', 'neutral')
          : tip(h('div', { class: 'dcb-quiet', tabindex: 0 }, h('span', { class: 'dcb-ico c-player', html: icon('shield', 16) }), h('span', { class: 't-label c-hint' }, 'Orbit clear')), 'Orbit clear', 'No fleets in orbit. The home fleet stands guard.')),
      head('news', 'Activity', 'Builds, mining, raids and attacks on this world, live', h('span', { class: 'dcb-live', title: 'Live' })),
      this.els.log);
    this.root.appendChild(right);
    this.els.log.appendChild(tip(h('div', { class: 'feed-empty t-tiny c-hint log-empty' }, 'Quiet here.'), 'Quiet here', 'Builds, mining, raids and attacks on this world show up here as they happen.'));
    for (const item of store.feed.filter((i) => i.planetId === this.planetId || (owner && i.playerId === owner.id)).slice(-30)) this.addLog(item.text, item.tone, item.height, item.kind === 'attack' ? item.hash : undefined);

    const crumbs = h('div', { class: 'planet-crumbs' },
      pill('back', 'Galaxy', 'Back to the galaxy', () => this.navigate('/galaxy/' + this.planetId)),
      h('span', { class: 't-label c-hint dcb-crumb', title: `Map of ${p.id}` }, h('span', { class: 'dcb-ico', html: icon('planet', 16) }), p.id),
      pill('refresh', '', 'Refresh: read it again from the chain', () => { audio.play('select'); void this.load(this.loadToken).then(() => toast('Re-read from the chain', 'player', 1200)); }));
    this.root.appendChild(crumbs);
    // Column captions over the map: an icon and a word each.
    const cols = h('div', { class: 'planet-columns t-label' });
    this.root.appendChild(cols);
    this.els.cols = cols;
    const caption = (ico: string, cls: string, x: string, y: string, ...text: (string | Node)[]) => h('span', { class: 'colcap dcb-cap ' + cls, 'data-x': x, 'data-y': y }, h('span', { class: 'dcb-ico', html: icon(ico, 14) }), ...text);
    if (fleetAway) cols.appendChild(caption('ship', 'c-warn', '-8', '11.8', `Away · ${d.fleet!.locationId}`));
    cols.appendChild(caption('planet', 'c-hint', '-22', '11.8', 'Planet'));
    if (!spent) cols.appendChild(caption('shield', this.flip ? 'c-enemy' : 'c-player', '-22', '-11.9', `Shield ${formatInt(shield)}`));
    if (!fleetAway) cols.appendChild(caption('ship', 'c-hint', '-8', '11.8', spent ? 'No fleet' : 'Fleet'));
    cols.appendChild(caption(d.raiders.length ? 'battle' : 'explore', d.raiders.length ? (this.flip ? 'c-player' : 'c-enemy') : 'c-hint', '9', '11.8', d.raiders.length ? store.playerName(d.raiders[0].owner) : 'Orbit clear'));
    this.renderCard();
  }

  /* Turn the real fleets here into a simulator battle. */
  private fleetInput(f: RawFleet): ChainFleetInput {
    const d = this.data!;
    const structs: ChainFleetInput['structs'] = new Map();
    for (const [id, s] of d.structs) {
      structs.set(id, { type: Number(s.Struct.type), ambit: s.Struct.operatingAmbit as Ambit, destroyed: !!s.structAttributes?.isDestroyed, defenders: s.structDefenders || [], health: num(s.structAttributes?.health) || undefined });
    }
    return { slots: { space: f.space || [], air: f.air || [], land: f.land || [], water: f.water || [] }, commandStruct: f.commandStruct, structs };
  }

  /** The training fights these real fleets make, exactly as they are now: with a raider here, defend
   * and raid; otherwise a fight against a copy of the one fleet. `bar` is its name on the bottom bar. */
  private practice(): { word: string; bar: string; title: string; cls: string; run: () => void }[] {
    const d = this.data!;
    const home = d.fleet && d.fleet.locationId === this.planetId ? d.fleet : null;
    const raider = d.raiders[0] || null;
    const ownerName = d.owner ? (d.owner.name || d.owner.id) : 'the defender';
    const raiderName = raider ? store.playerName(raider.owner) : '';
    const go = (units: ReturnType<typeof unitsFromChainFleet>['units'], title: string) => {
      const err = validate(units);
      if (err) { toast('Cannot simulate: ' + err, 'warn'); return; }
      audio.play('confirm');
      this.navigate('/sim/' + encodeBattle({ units, difficulty: 'difficult', blockMs: 2000, title }));
    };
    const homeU = home ? unitsFromChainFleet(this.fleetInput(home), 'player') : null;
    const raidU = raider ? unitsFromChainFleet(this.fleetInput(raider), 'computer') : null;
    if (homeU && raidU && !homeU.problem && !raidU.problem) return [
      { word: 'Defend', bar: 'Practice defence', title: 'Fly the defence', cls: '', run: () => go([...homeU.units, ...raidU.units], `Defend ${this.planetId} as ${ownerName}`) },
      { word: 'Raid', bar: 'Practice raid', title: 'Fly the raid', cls: 'danger', run: () => go([...mirrorUnits(raidU.units, 'player'), ...mirrorUnits(homeU.units, 'computer')], `Raid ${this.planetId} as ${raiderName}`) }];
    if (homeU && !homeU.problem) return [{ word: 'Copy', bar: 'Fight a copy', title: 'Fight a copy of it', cls: '', run: () => go([...homeU.units, ...mirrorUnits(homeU.units, 'computer')], `${ownerName}’s fleet vs its mirror`) }];
    if (raidU && !raidU.problem) return [{ word: 'Copy', bar: 'Fight a copy', title: 'Fight a copy of it', cls: 'danger', run: () => go([...mirrorUnits(raidU.units, 'player'), ...mirrorUnits(raidU.units, 'computer')], `${raiderName}’s fleet vs its mirror`) }];
    return [];
  }

  private simBlock() {
    const fly = (o: ReturnType<PlanetScreen['practice']>[number]) => h('button', { class: 'btn dcb-verb ' + o.cls, title: `${o.title}. ${PRACTICE_WHAT}`, onclick: o.run }, face('a'), o.word);
    const rows = this.practice().map(fly);
    return h('div', { class: 'panel-body col dcb-practice', style: 'gap:8px; border-top:2px solid rgba(110, 140, 240, 0.3)' },
      tip(h('div', { class: 'dcb-head-t' }, h('span', { class: 'dcb-ico', html: icon('target', 18) }), h('span', { class: 't-label' }, 'Practice')), 'Practise this fight', PRACTICE_WHAT),
      rows.length ? h('div', { class: 'row wrap', style: 'gap:6px' }, rows) : tip(h('div', { class: 't-tiny c-hint', tabindex: 0 }, 'No fleet here to copy.'), 'No fleet here to copy', 'No fleet with a Command Ship here to simulate.'));
  }


  /** The newest real fight involving this world (from the combat archive), with a link to watch it:
   * a strike on its planetary structs, or any attack by or on its owner. (A fleet's location on
   * chain is where it is now, not where it fought, so fleets alone can't place a past fight.) */
  private lastCombat(left: HTMLElement, planetId: string) {
    const token = this.loadToken;
    const owner = this.data?.owner?.id || '';
    void latestAttacks().then((recs) => {
      if (token !== this.loadToken || !left.isConnected) return;
      const hit = recs.find((r) => r.attack.attackerPlayerId === owner && !!owner
        || (r.attack.eventAttackShotDetail || []).some((s) => (s.targetStructLocationType === 'planet' && s.targetStructLocationId === planetId) || (!!owner && s.targetPlayerId === owner)));
      // A quiet activity log gets the owner's latest fights from the archive (oldest first, so newest ends on top).
      const log = this.els.log;
      if (log && log.querySelector('.log-empty') && owner) {
        const mine = recs.filter((r) => r.attack.attackerPlayerId === owner || (r.attack.eventAttackShotDetail || []).some((s) => s.targetPlayerId === owner)).slice(0, 4).reverse();
        for (const r of mine) {
          const s = summarize(r.attack, (id) => store.playerName(id));
          this.addLog(`${s.title}: ${s.result}`, r.attack.attackerPlayerId === owner ? 'player' : 'enemy', r.height, r.hash);
        }
      }
      const kv = left.querySelector('.dossier-kv');
      if (!hit || !kv) return;
      const at = Date.parse(hit.time);
      const keep = this.dossierScroll;
      this.dossierScroll = 0;
      const when = Number.isFinite(at) ? ago(Date.now() - at) + ' ago' : 'at block #' + hit.height;
      kv.append(h('button', { class: 'dcb-vital wide c-enemy dcb-fight', title: 'Last fight: the newest attack by or on this world’s owner, replayed in the combat theatre', 'aria-label': `Watch the last fight, ${when}`, onclick: () => { audio.play('select'); this.navigate('/combat/' + hit.hash + '/e'); } },
        h('span', { class: 'dcb-ico', html: icon('replay', 20) }), h('b', { class: 'dcb-n' }, Number.isFinite(at) ? when : '#' + hit.height), h('span', { class: 'grow' }), face('a')));
      if (keep) left.scrollTop = keep;
    }).catch(() => { /* the archive is optional here */ });
  }

  private commanderBlock(owner: RawPlayer, guild: string, fleetAway: boolean) {
    const g = this.data!.ownerGrid;
    const cap = big(g.capacity), load = big(g.load) + big(g.structsLoad);
    const online = load <= cap + big(g.connectionCapacity);
    const charge = h('b', { class: 'dcb-n' });
    const bar = h('span', { class: 'bar' }, h('i'));
    this.els.charge = charge; this.els.chargeBar = bar;
    const storedOre = num(g.ore);
    const mine = empire.commands(owner.id);
    const pinned = () => commander.id === owner.id;
    const pin = pill('star', pinned() ? 'Pinned' : 'Pin', 'Keep this commander’s vitals in the top bar', (e: MouseEvent) => {
      const was = pinned();
      commander.pin(was ? null : owner.id);
      const b = e.currentTarget as HTMLElement;
      b.classList.toggle('active', !was);
      b.lastElementChild!.textContent = was ? 'Pin' : 'Pinned';
      audio.play('confirm');
      toast(was ? 'Unpinned' : 'Pinned to the top bar', 'player', 1400);
    }, 'btn' + (pinned() ? ' active' : ''));
    const block = h('div', { class: 'col', style: 'gap:8px' },
      h('div', { class: 'row', style: 'align-items:center' },
        portrait(owner.pfpClientRenderAttributes, 'player', owner.id),
        h('div', { class: 'col grow', style: 'gap:4px; min-width:0' },
          h('div', { class: 't-label-lg c-player', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, owner.name || 'Commander'),
          h('div', { class: 'row wrap dcb-idrow' }, h('span', { class: 't-tiny c-hint x-only' }, owner.id), h('span', { class: 'dcb-guild', title: 'Their guild (team)' }, h('span', { class: 'dcb-ico', html: icon('team', 16) }), guild)),
          // Two lamps: the grid (lit = online) and the fleet (home, or away).
          h('div', { class: 'row dcb-lamps' },
            vital('power', online ? '' : 'Off', online ? 'Grid online' : 'Grid offline', 'Load ≤ capacity means online.', 'lamp ' + (online ? 'c-player' : 'c-enemy hot')),
            vital('ship', fleetAway ? 'Away' : '', fleetAway ? 'Fleet away' : 'Fleet home', fleetAway ? 'Out of orbit, so it isn’t defending this world.' : 'On station, guarding this world.', 'lamp ' + (fleetAway ? 'c-warn' : 'c-player'))))),
      h('div', { class: 'dcb-vitals' },
        vital('charge', charge, 'Charge', 'Blocks since this commander’s last action. Builds need 8, attacks 3–5.', 'wide c-player', bar),
        vital('power', `${formatPower(load.toString())} / ${formatPower(cap.toString())}`, 'Power', 'Load / capacity.', 'wide'),
        vital('ore', String(storedOre), 'Ore in hold', storedOre ? 'Stealable: raiders can take ore until it is refined.' : 'Nothing to steal.', 'wide ' + (storedOre ? 'c-warn hot' : '')),
        vital('alpha', formatAlpha(this.data!.alpha), 'Alpha Matter', 'Refined alpha. Raiders can’t take it.', 'wide c-player')),
      h('div', { class: 'row x-only', style: 'gap:6px' },
        h('button', { class: 'btn ghost grow', title: 'Copy address', onclick: () => copyText(owner.primaryAddress, 'Address copied', 1200) }, owner.primaryAddress.slice(0, 12) + '…' + owner.primaryAddress.slice(-5))),
      h('div', { class: 'dcb-quick' },
        pin,
        pill('chat', 'Chat', 'This planet’s chat room', () => { audio.play('select'); void openChannel(this.data!.planet.id); }),
        pill('replay', 'Battles', 'Their battles: every attack this commander has made, replayed in Battle Replays', () => { audio.play('select'); this.navigate('/combat/by/' + owner.id); }),
        pill('base', 'Base', mine ? 'My Base: command this player' : 'Their base: see this commander’s base (look, don’t touch)', () => { audio.play('select'); this.navigate('/command/' + owner.id); }, mine ? 'btn solid' : 'btn ghost')),
    );
    setTimeout(() => this.paintCommander(), 0);
    return block;
  }

  private paintCommander() {
    const g = this.data?.ownerGrid;
    if (!g || !this.els.charge) return;
    const last = num(g.lastAction);
    const height = this.height;
    if (!height || !last) { this.els.charge.textContent = '—'; return; }
    const charge = height - last;
    this.els.charge.textContent = formatInt(charge);
    this.els.charge.closest('.dcb-vital')?.setAttribute('aria-label', `Charge ${formatInt(charge)}`);
    (this.els.chargeBar.firstChild as HTMLElement).style.width = clamp(charge / 30, 0, 1) * 100 + '%';
    this.els.chargeBar.title = `Charge ${formatInt(charge)} blocks = current block − last action. Builds need 8, attacks 3–5.`;
  }

  /** `hash`: an attack transaction; the row then opens it in the combat theatre. */
  private addLog(text: string, tone: string, height: number, hash?: string) {
    const log = this.els.log;
    if (!log) return;
    log.querySelector('.log-empty')?.remove();
    const cls = tone === 'player' ? 'c-player' : tone === 'enemy' ? 'c-enemy' : tone === 'neutral' ? 'c-neutral' : 'c-hint';
    const row = h('div', { class: 'feed-row', style: hash ? '' : 'cursor:default', title: hash ? 'Watch it in the combat theatre' : '' }, h('span', { class: 'when num' }, '#' + (height % 100000)), h('span', { class: 'what ' + cls }, text));
    if (hash) row.addEventListener('click', () => { audio.play('select'); this.navigate('/combat/' + hash); });
    log.prepend(row);
    while (log.children.length > 60) log.lastElementChild?.remove();
  }

  /* Selected struct card with its chain readout and CLI orders. */
  private renderCard() {
    this.root.querySelector('.action-bar')?.remove();
    const d = this.data;
    if (!d) return;
    this.cardKey = this.cardKeyNow();
    if (this.buildAt) { this.renderBuild(this.buildAt); return; }
    const s = this.selected ? d.structs.get(this.selected) : null;
    if (!s) {
      const f = this.field();
      const commanding = !!f && (empire.commands(f.planet.owner) || f.fleets.some((x) => empire.commands(x.owner)));
      // Why no slot glows to build in, when it's for a reason the commander can fix.
      const paused = commanding ? this.buildPause() : null;
      const own = 'Click one of your machines to give it orders';
      const say = !commanding ? 'Click any ship or building to see what it is' : paused ? `${own} · builds paused: ${paused}` : this.canBuild ? `${own} — or an empty slot to build` : own;
      const pause = paused ? tip(h('span', { class: 'chip warn', tabindex: 0 }, h('span', { class: 'dcb-ico', html: icon('lock', 12) }), 'Builds paused'), 'Builds paused', cap(paused) + '.', 'neutral') : null;
      const units = [...d.structs.values()].filter((x) => !x.structAttributes?.isDestroyed).length;
      const build = commanding && this.canBuild;
      // An empty world has nothing to pick: say so, and offer the way to one with something on it.
      if (!units && !build) {
        const used = AMBITS.map((x) => (d.planet[x] || []).filter(Boolean).length).reduce((n, k) => n + k, 0);
        const busiest = () => [...store.planets.values()].filter((x) => x.active && x.owner && x.structs > 0 && x.id !== this.planetId).sort((x, y) => y.structs - x.structs)[0]?.id;
        this.root.appendChild(h('div', { class: 'action-bar panel empty dcb-emptyworld' + (this.held ? ' pa-armed' : '') }, this.hint(),
          tip(h('span', { class: 'chip', tabindex: 0 }, h('span', { class: 'dcb-ico', html: icon('planet', 14) }), 'Empty', h('b', { class: 'dcb-n' }, ` ${used}/16`)), `Empty world: ${used} of 16 slots built`, 'No ships or buildings here yet, so there is nothing to pick.'),
          h('button', { class: 'btn solid dcb-verb', title: 'Go to the world with the most ships and buildings on it', onclick: async (e: Event) => {
            audio.play('select');
            // Opened from a link, the galaxy's world list may still be on its way: wait for it (a few
            // seconds at most) rather than landing on the galaxy's title.
            let id = busiest();
            if (!id && !store.planetsLoaded) {
              const b = e.currentTarget as HTMLButtonElement;
              // (This screen is reused: a different root or load means the player has moved on.)
              const root = this.root, tok = this.loadToken;
              if (b.classList.contains('busy')) return;
              b.disabled = true; b.classList.add('busy');
              await Promise.race([store.loadPlanets().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
              b.disabled = false; b.classList.remove('busy');
              if (this.root !== root || this.loadToken !== tok || !root.isConnected) return;
              id = busiest();
            }
            this.navigate(id ? '/planet/' + id : '/galaxy');
          } }, face('a'), 'Visit a busy world'),
          pause));
        return;
      }
      // A caption, not a button: a picture and two or three words, the sentence in its tip. A build pause says why on its chip.
      const word = !units ? 'Pick a +' : build ? 'Pick a unit or a +' : 'Pick a unit';
      // The best thing to do here, on every screen size: fight these real fleets in training (A, then X).
      const fights = this.practice().map((o, i) => h('button', { class: 'btn dcb-verb ' + (i ? 'ghost ' : 'solid ') + o.cls, title: `${o.title}. ${PRACTICE_WHAT}`, onclick: o.run }, face(i ? 'x' : 'a'), o.bar));
      this.root.appendChild(h('div', { class: 'action-bar panel empty dcb-prompt' + (fights.length ? ' dcb-fights' : '') + (this.held ? ' pa-armed' : '') }, this.hint(),
        h('span', { class: 'dcb-ico c-player', html: icon(build ? 'build' : 'find', 18) }),
        tip(h('span', { class: 't-label c-hint' }, word), word, say), pause, ...fights));
      return;
    }
    const actor = this.actorFor(s.Struct.id);
    if (actor) { this.root.appendChild(this.ownCard(s, actor.p)); this.paintBattery(); return; }
    const st = s.Struct, at = s.structAttributes || {};
    const t = TYPES_BY_ID[Number(st.type)];
    const mine = this.sideOf(st.owner) === 'player';
    const hp = num(at.health);
    const img = h('img', { alt: t.type });
    void structPortrait(t.id, hp < t.maxHealth ? 'dmg' : 'base', mine ? 'player' : 'enemy').then((u) => { img.src = u; });
    const weapons = (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).filter((ws) => hasWeapon(t, ws));
    const cmds: string[] = [];
    if (weapons.length) cmds.push(`# fire on another struct with ${weaponLabel(t, weapons[0])}\nstructsd tx structs struct-attack --from [key] --gas auto --gas-adjustment 1.5 -- ${st.id} [target-struct-id] ${weapons[0]}`);
    cmds.push(`# attack this ${t.type} from one of your structs\nstructsd tx structs struct-attack --from [key] --gas auto --gas-adjustment 1.5 -- [your-struct-id] ${st.id} primaryWeapon`);
    if (t.canDefend) cmds.push(`# assign this struct to guard another\nstructsd tx structs struct-defense-set --from [key] --gas auto --gas-adjustment 1.5 -- ${st.id} [protected-struct-id]`);
    // Proof-of-work completions wait for cheap difficulty (-D 3), as structs.ai recommends.
    if (!at.isBuilt) cmds.unshift(`# finish construction once its proof is cheap\nstructsd tx structs struct-build-compute -D 3 --from [key] --gas auto --gas-adjustment 1.5 -y -- ${st.id}`);
    if (at.isBuilt && t.planetaryMining !== 'noPlanetaryMining') cmds.unshift(`# lift one ore when the mining proof is cheap (~17 h after the cycle starts)\nstructsd tx structs struct-ore-mine-compute -D 3 --from [key] --gas auto --gas-adjustment 1.5 -y -- ${st.id}`);
    if (at.isBuilt && t.planetaryRefinery !== 'noPlanetaryRefinery') cmds.unshift(`# refine one ore into Alpha Matter (~34 h at -D 3)\nstructsd tx structs struct-ore-refine-compute -D 3 --from [key] --gas auto --gas-adjustment 1.5 -y -- ${st.id}`);
    if (at.isBuilt) cmds.push(`# power it ${at.isOnline ? 'down' : 'up'}\nstructsd tx structs struct-${at.isOnline ? 'deactivate' : 'activate'} --from [key] --gas auto --gas-adjustment 1.5 -- ${st.id}`);
    cmds.push(`# read it\nstructsd query structs struct ${st.id}`);
    const pre = h('pre', { class: 'cli' }, cmds.join('\n\n'));
    const card = h('div', { class: 'action-bar panel ' + (mine ? 'player' : 'enemy') + (this.held ? ' pa-armed' : '') }, this.hint(),
      h('div', { class: 'unit-card' },
        h('div', { class: 'sprite big ' + (mine ? 'player' : 'enemy') }, img),
        h('div', { class: 'col grow', style: 'gap:4px; min-width:0' },
          h('div', { class: 'unit-name t-label-lg ' + (mine ? 'c-player' : 'c-enemy') }, t.type),
          h('div', { class: 't-tiny c-hint' }, h('span', { class: 'x-only' }, `${st.id} · ${t.defaultCosmeticModelNumber} “${t.defaultCosmeticName}” · `), store.playerName(st.owner)),
          h('div', { class: 'row', title: `${hp}/${t.maxHealth} HP · ${statusText(num(at.status))}` }, h('span', { class: 'dcb-ico c-hint', html: icon('health', 14) }), h('div', { class: 'pips' }, Array.from({ length: t.maxHealth }, (_, i) => h('i', { class: i < hp ? '' : 'lost' }))), h('span', { class: 't-tiny c-hint' }, `${hp}/${t.maxHealth}`)),
          h('div', { class: 'row wrap', style: 'gap:4px' },
            h('span', { class: 'chip ambit-' + st.operatingAmbit, title: AMBIT_NAME[st.operatingAmbit as Ambit] || st.operatingAmbit }, h('span', { class: 'dcb-ico', html: icon(st.operatingAmbit, 13) })),
            h('span', { class: 'chip', title: st.locationType === 'planet' ? 'Planetary slot ' + (num(st.slot) + 1) : t.id === COMMAND_SHIP_ID ? 'Flagship' : 'Fleet slot ' + (num(st.slot) + 1) }, h('span', { class: 'dcb-ico', html: icon(st.locationType === 'planet' ? 'planet' : t.id === COMMAND_SHIP_ID ? 'star' : 'ship', 13) }), t.id === COMMAND_SHIP_ID ? '' : String(num(st.slot) + 1)),
            DEFENSE_NAME[t.unitDefenses] ? h('span', { class: 'chip', title: DEFENSE_HINT[t.unitDefenses] || '' }, DEFENSE_NAME[t.unitDefenses]) : null,
            PASSIVE_NAME[t.passiveWeaponry] ? h('span', { class: 'chip' }, PASSIVE_NAME[t.passiveWeaponry]) : null),
          (s.structDefenders || []).length ? h('div', { class: 't-tiny c-hint' }, `Guarded by ${s.structDefenders!.length} struct${s.structDefenders!.length > 1 ? 's' : ''}`) : null,
          !at.isBuilt && num(at.blockStartBuild) ? (() => {
            const since = num(at.blockStartBuild), age = this.height ? this.height - since : 0;
            const d = powDifficulty(age, t.buildDifficulty), cheap = powAgeFor(3, t.buildDifficulty) - age;
            const full = `Under construction since block #${formatInt(since)}${this.height ? ` (${blocksToDuration(age)} ago) · proof difficulty D${d}${cheap > 0 ? `, D3 in ${blocksToDuration(cheap)}` : ', cheap now'}` : ''} — it stands when its proof-of-work lands.`;
            return h('div', { class: 't-tiny c-warn', title: full }, h('span', { class: 's-only' }, '▸ Being built'), h('span', { class: 'x-only' }, full));
          })() : null,
        )),
      h('div', { class: 'col', style: 'gap:4px; min-width:260px; max-width:300px' },
        h('div', { class: 'dcb-head-t', title: 'Capabilities' }, h('span', { class: 'dcb-ico', html: icon('target', 16) }), h('span', { class: 't-label c-hint' }, 'Can do')),
        weapons.map((ws) => h('div', { class: 't-tiny' }, h('span', { class: mine ? 'c-player' : 'c-enemy' }, weaponLabel(t, ws)), ` · ${controlName(weaponField(t, ws, 'Control'))} · ${reachLabel(t, ws)} · ${weaponField(t, ws, 'Damage')} dmg · ${weaponField(t, ws, 'Charge')}⚡`)),
        weapons.length ? null : h('div', { class: 't-tiny c-hint' }, roleOf(t)),
        t.planetaryShieldContribution ? h('div', { class: 't-tiny c-hint' }, `Shield +${t.planetaryShieldContribution}`) : null,
        h('div', { class: 't-tiny c-hint' }, `Draws ${formatPower(t.passiveDraw)} while online`)),
      this.ordersColumn(pre),
    );
    this.root.appendChild(card);
  }

  /** Anyone else's struct: the CLI, and the deck if your fleet is here. (Yours get `ownCard`.) */
  private ordersColumn(pre: HTMLElement) {
    const raider = [...empire.players.values()].find((x) => x.account >= 0 && x.fleet?.status === 'away' && x.fleet.locationId === this.data?.planet.id);
    return h('div', { class: 'col', style: 'gap:4px; min-width:0' },
      raider ? h('button', { class: 'btn danger mini', onclick: () => {
        audio.play('select');
        // Your raiding fleet is on this map: take its flagship; otherwise fight from the deck.
        const cmd = raider.fleet?.commandStruct;
        if (cmd && this.view?.units.has(cmd)) { this.selected = cmd; this.refreshField(true); } else this.navigate('/command/' + raider.playerId);
      } }, 'Your fleet is here — take command ▸') : null,
      // The command-line recipes are an expert's view; everyone else gets a plain line.
      h('div', { class: 'spread x-only' }, h('span', { class: 't-label c-hint' }, 'Orders (structsd CLI)'),
        h('button', { class: 'btn ghost mini', onclick: () => copyText(pre.textContent || '', 'Commands copied', 1200) }, 'Copy')),
      h('div', { class: 'x-only' }, pre),
      h('div', { class: 't-tiny c-hint s-only', title: raider ? 'Take command of your fleet to fight it.' : 'This belongs to another commander. To fight it, sail your fleet here from My Base.' }, raider ? 'Take command to fight it.' : 'Not yours: sail here to fight it.'));
  }

  /* ── Battlefield: your orders on the map ─────────────────────────────── */

  /** What the rules see: the world, the fleets in its orbit (the home fleet if here, raiders), the structs. */
  private field(): Field | null {
    const d = this.data;
    if (!d) return null;
    const home = d.fleet && d.fleet.locationId === this.planetId ? [d.fleet] : [];
    return { planet: d.planet, fleets: [...home, ...d.raiders], structs: d.structs };
  }

  /** Fleets drawn on the board: the home fleet if here and the raider shown (the rest of the queue isn't). */
  private shownFleets(f: Field) {
    const d = this.data;
    return d ? f.fleets.filter((x) => x === d.fleet || x === d.raiders[0]) : [];
  }

  /** The struct and its owner when this wallet commands them; `p` is null until the empire has read that player. */
  private actorFor(structId: string | null): { s: StructFull; p: PlayerState | null } | null {
    const s = structId ? this.data?.structs.get(structId) : undefined;
    if (!s || !empire.commands(s.Struct.owner)) return null;
    return { s, p: empire.players.get(s.Struct.owner) ?? null };
  }

  /** Re-derive what the map shows for the armed order: rings, reticles, slot frames, pending marks. */
  private refreshField(forceCard = false) {
    const view = this.view, ov = this.overlay, f = this.field();
    if (!view || !ov || !f) { if (forceCard) this.renderCard(); return; }
    this.fieldVersion++;
    this.validateArm(f);
    const a = this.arm;
    this.valid = !a ? new Set() : a.kind === 'attack' ? attackTargets(f, a.struct, a.weapon) : a.kind === 'defend' ? guardTargets(f, a.struct) : new Set();
    for (const u of view.units.values()) {
      u.selected = u.id === this.selected;
      u.targetable = a?.kind === 'attack' && this.valid.has(u.id);
      u.dimmed = !!a && !this.valid.has(u.id) && u.id !== a.struct;
    }
    const tone = a?.kind === 'attack' ? 'attack' as const : 'guard' as const;
    ov.setReticles([...this.valid].flatMap((id) => {
      const unit = view.units.get(id);
      return unit ? [{ unit, tone, picks: a?.kind === 'attack' ? a.picks.filter((x) => x === id).length : 0 }] : [];
    }));
    const tiles = this.tiles(f);
    ov.setTiles(tiles);
    this.canBuild = tiles.some((x) => x.state === 'build');
    // The open build menu's slot was taken (a build landed, a move arrived): close it.
    const at = this.buildAt;
    if (at && !tiles.some((x) => x.state === 'build' && tileKey(x) === tileKey(at))) this.buildAt = null;
    this.markPending();
    // The card follows what changed (an armed order put down, a target out of reach, a slot taken).
    if (forceCard || this.cardKeyNow() !== this.cardKey) this.renderCard();
  }

  private fieldSoon() {
    if (this.fieldTimer) return;
    this.fieldTimer = window.setTimeout(() => {
      this.fieldTimer = 0;
      if (this.view) this.refreshField();
      else if (this.data && this.cardKeyNow() !== this.cardKey) this.renderCard();
    }, 120);
  }

  /** Drop an armed order whose struct can no longer act (gone, offline, its owner's grid down or no
   * longer ours), and picks that left its reach. */
  private validateArm(f: Field) {
    const a = this.arm;
    if (!a) return;
    const s = f.structs.get(a.struct);
    const why = !s ? 'it left the map' : !empire.commands(s.Struct.owner) ? 'no longer yours'
      : readyBlock(s, a.kind === 'move' ? null : empire.players.get(s.Struct.owner) ?? null);
    if (why) { this.arm = null; toast(`Order put down — ${why}`, 'warn', 2400); return; }
    if (a.kind === 'attack') a.picks = a.picks.filter((id) => !attackBlock(f, a.struct, id, a.weapon));
  }

  /** Why `owner` can't build in this planet or fleet now (fleet home, Command Ship online, grid), or null. */
  private buildWhy(x: Pick<Slot, 'where' | 'containerId' | 'owner'>): string | null {
    const f = this.field(), d = this.data;
    if (!f || !d) return 'the map is still loading';
    const p = empire.players.get(x.owner) ?? null;
    const ownerFleet = p?.fleet ?? (x.owner === d.planet.owner ? d.fleet : null);
    return buildBlock(f, x, p, ownerFleet);
  }

  /** The planet's own builds, paused (fleet away, Command Ship down): the empty bar says why. */
  private buildPause(): string | null {
    const d = this.data;
    if (!d || !empire.commands(d.planet.owner) || !(d.planet.status === 'active' || d.planet.status === '0')) return null;
    return this.buildWhy({ where: 'planet', containerId: d.planet.id, owner: d.planet.owner });
  }

  private queuedBuilds(playerId: string) {
    return txq.active.filter((j) => j.playerId === playerId).flatMap((j) => j.msgs.filter((m) => m.typeUrl.endsWith('MsgStructBuildInitiate')).map((m) => Number(m.value.structTypeId)));
  }

  /** Why `p` can't start one more of `t` (build limit, spare power for its build draw), or null. */
  private typeWhy(t: StructType, p: PlayerState): string | null {
    const queued = this.queuedBuilds(p.playerId);
    const have = [...p.structs.values()].filter((s) => s.typeId === t.id && !s.destroyed).length + queued.filter((id) => id === t.id).length;
    if (t.buildLimit && have >= t.buildLimit) return `build limit reached (${have}/${t.buildLimit})`;
    const free = headroom(p, queued.reduce((n, id) => n + BigInt(TYPES_BY_ID[id]?.buildDraw || 0), 0n));
    if (free < BigInt(t.buildDraw)) return `not enough spare power — it draws ${formatDraw(t.buildDraw)} while building, ${formatDraw(Number(free))} free`;
    return null;
  }

  /** Slot frames: where a move may land while one is armed; otherwise every empty slot you may build
   * in (your planet, your fleet while home; battlegrounds something can stand in), with slots a queued
   * build or move is headed for marked. */
  private tiles(f: Field): TileSpec[] {
    const d = this.data!;
    if (!(d.planet.status === 'active' || d.planet.status === '0')) return [];
    const a = this.arm;
    if (a?.kind === 'move') {
      const queued = reservedSlots(f.structs.get(a.struct)?.Struct.owner || '');
      return moveDestinations(f, a.struct).filter((x) => x.command || !queued.has(slotKey(x))).map((x) => ({ ...x, state: 'move' as const }));
    }
    if (a) return [];
    const out: TileSpec[] = [];
    const add = (where: 'planet' | 'fleet', id: string, owner: string) => {
      if (!empire.commands(owner)) return;
      const queued = reservedSlots(owner);
      // No build frames where the chain would refuse every build (fleet away, Command Ship down, grid offline).
      const build = !this.buildWhy({ where, containerId: id, owner });
      for (const x of emptySlots(f, where, id)) {
        const q = queued.has(slotKey(x));
        // No frame where nothing can stand (no planetary struct flies, for one).
        if (q || (build && buildable(where, x.ambit).length)) out.push({ ...x, state: q ? 'reserved' : 'build' });
      }
    };
    add('planet', f.planet.id, f.planet.owner);
    for (const fl of this.shownFleets(f)) add('fleet', fl.id, fl.owner);
    return out;
  }

  /** A struct with an order in the queue wears a small live marker (charging, signing, landing);
   * a queued attack draws its lock-on line until the shot lands. */
  private markPending() {
    const view = this.view;
    if (!view) return;
    const jobs = txq.active.filter((j) => !!j.playerId && empire.commands(j.playerId) && !(j.hash && this.seenTx.has(hkey(j.hash))));
    const byActor = new Map<string, TxJob>();
    for (const j of jobs) for (const m of j.msgs) { const id = idsInMsg(m.value)[0]; if (id && !byActor.has(id)) byActor.set(id, j); }
    for (const u of view.units.values()) {
      const j = byActor.get(u.id);
      let el = u.tag.querySelector<HTMLElement>('.pa-pend');
      if (!j) { el?.remove(); continue; }
      if (!el) { el = h('span', { class: 'pa-pend' }); u.tag.appendChild(el); }
      const text = pendText(j);
      if (el.textContent !== text) el.textContent = text;
      el.title = j.label;
      el.classList.toggle('landing', j.status === 'pending');
    }
    const atk = [...jobs].reverse().find((j) => j.msgs.some((m) => m.typeUrl.endsWith('MsgStructAttack')));
    const m = atk?.msgs.find((x) => x.typeUrl.endsWith('MsgStructAttack'))?.value as { operatingStructId?: string; targetStructId?: string[] } | undefined;
    const from = m?.operatingStructId || '', to = m?.targetStructId?.[0] || '';
    const want = atk && view.units.has(from) && view.units.has(to) ? atk.id : null;
    if (want !== this.intentJob) { if (want) view.showIntent(from, to); else view.clearIntent(); this.intentJob = want; }
  }

  /** One of our orders landed or failed. A landed attack plays through the live feed like anyone's;
   * if the feed missed it (socket down), it plays from the receipt instead. */
  private settled(j: TxJob) {
    const d = this.data, f = this.field();
    if (!d || !f || !j.playerId || !empire.commands(j.playerId)) return;
    const here = j.msgs.some((m) => idsInMsg(m.value).some((id) => d.structs.has(id))) || j.playerId === d.planet.owner || f.fleets.some((x) => x.owner === j.playerId);
    if (!here) return;
    // (A failure is narrated by the ops dock; here the map just re-derives its marks.)
    const hash = j.hash;
    if (j.status === 'success' && hash && j.events?.length) {
      const k = hkey(hash);
      this.later(2500, () => { if (this.seenTx.has(k)) return; this.seenTx.add(k); this.onTx(j.events as { type: string; data: any }[]); });
    }
    this.fieldSoon();
  }

  private empireChanged() {
    this.reorient();
    if (this.data && this.cardKeyNow() !== this.cardKey) this.renderCard();
    this.fieldSoon();
  }

  /** The vault opened: an order held for it goes now — if it still stands, for the account it was given as. */
  private walletChanged() {
    const held = this.held;
    if (held && wallet.state === 'unlocked') { this.held = null; this.release(held); }
    else if (held && wallet.state === 'empty') { this.held = null; toast(`Dropped “${held.label}” — the vault is gone`, 'warn', 3000); }
    this.reorient();
    if (this.data && this.cardKeyNow() !== this.cardKey) this.renderCard();
    this.fieldSoon();
  }

  /** Who the viewer commands changed (an account added, a vault reset): turn the board to face them. */
  private reorient() {
    if (!this.data || !this.view || this.flipNow() === this.flip) return;
    const token = this.loadToken;
    void this.buildScene().then(() => { if (token === this.loadToken && this.data) this.renderHud(); });
  }

  private release(held: NonNullable<PlanetScreen['held']>) {
    if (wallet.byPlayer(held.owner)?.index !== held.account) { audio.play('deny'); toast(`Dropped “${held.label}” — this vault no longer signs for that commander`, 'warn', 4000); return; }
    try { this.execute(held.intent); held.after?.(); audio.play('confirm'); toast(`${held.label} — queued`, 'player', 2000); }
    catch (e) { audio.play('deny'); toast(`Dropped “${held.label}” — ${(e as Error).message}`, 'enemy', 4500); }
  }

  /** What the card shows, in brief: it re-renders only when this changes (charge is painted in place). */
  private cardKeyNow() {
    const s = this.selected ? this.data?.structs.get(this.selected) : undefined;
    const owner = s?.Struct.owner || this.buildAt?.owner || '';
    const a = this.arm;
    const p = empire.players.get(owner);
    return [this.selected, s?.structAttributes?.status, s?.structAttributes?.health, s?.structAttributes?.protectedStructIndex, (s?.structDefenders || []).length,
      empire.commands(owner), !!p, p?.online, a ? a.kind + a.struct + (a.kind === 'attack' ? a.weapon + a.picks.join() : '') : '', this.held?.label, wallet.state,
      this.buildAt ? tileKey(this.buildAt) : '', s && empire.commands(owner) ? this.reachSig(s) : '', this.flip, this.canBuild,
      txq.active.filter((j) => j.playerId === owner).map((j) => j.id).join()].join('|');
  }

  /** How much each order of an own struct can reach: the card's "N in reach" and enabled buttons follow it. */
  private reachSig(s: StructFull) {
    const f = this.field(), t = TYPES_BY_ID[Number(s.Struct.type)];
    if (!f || !t) return '';
    const id = s.Struct.id;
    return [...(['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).filter((ws) => hasWeapon(t, ws)).map((ws) => attackTargets(f, id, ws).size),
      t.canDefend ? guardTargets(f, id).size : '', t.movable ? moveDestinations(f, id).length : '', this.valid.size].join(',');
  }

  /** The strip over the action bar: what the armed order wants next, or the order waiting on the vault. */
  private hint(): HTMLElement | null {
    const touch = matchMedia('(pointer: coarse)').matches;
    const verb = touch ? 'tap' : 'click';
    if (this.held) {
      return h('div', { class: 'pa-hint warn' }, h('span', null, `Waiting on the vault: ${this.held.label}`),
        h('button', { class: 'btn mini', onclick: () => openVault() }, 'Unlock'),
        h('button', { class: 'btn ghost mini', onclick: () => this.disarm() }, 'Drop'));
    }
    const a = this.arm;
    const s = a ? this.data?.structs.get(a.struct) : undefined;
    const t = s ? TYPES_BY_ID[Number(s.Struct.type)] : undefined;
    if (!a || !t) return null;
    const cancel = h('button', { class: 'btn ghost mini', onclick: () => this.disarm() }, touch ? 'Cancel' : 'Cancel · Esc');
    if (a.kind === 'attack') {
      const max = weaponField(t, a.weapon, 'Targets') || 1;
      return h('div', { class: 'pa-hint enemy' },
        h('span', null, `${weaponLabel(t, a.weapon)} armed — ${this.valid.size ? `${verb} a red reticle to fire` : 'nothing in reach'}${max > 1 ? ` · ${a.picks.length}/${max} targets` : ''}`), cancel);
    }
    if (a.kind === 'defend') return h('div', { class: 'pa-hint' }, h('span', null, `Guard — ${verb} one of your structs to protect`), cancel);
    return h('div', { class: 'pa-hint' }, h('span', null, `${t.drive_label || 'Move'} — ${verb} a glowing slot`), cancel);
  }

  /** The owner's battery: charge in blocks since their last action, the cells every order draws on. */
  private batteryEl(p: PlayerState) {
    return h('span', { class: 'pa-batt', 'data-player': p.playerId, title: 'Charge: blocks since this player’s last action. Each order spends some; the queue holds an order until the battery covers it.' },
      h('span', { class: 'battery pa-battery' }, ...Array.from({ length: 8 }, (_, i) => h('i', { class: [1, 2, 3, 5, 8].includes(i + 1) ? 'mark' : '' }))),
      h('span', { class: 'pa-charge num' }, ''));
  }

  /** Live charge, every block: cells, number, and costs on the open card that the battery can't cover yet. */
  private paintBattery() {
    this.root?.querySelectorAll<HTMLElement>('.pa-batt').forEach((el) => {
      const p = empire.players.get(el.dataset.player || '');
      if (!p) return;
      const ch = empire.charge(p);
      el.querySelectorAll('.pa-battery i').forEach((c, i) => c.classList.toggle('on', ch > i));
      const n = el.querySelector('.pa-charge');
      if (n) n.textContent = `⚡${ch > 999 ? '999+' : ch}`;
      el.closest('.action-bar')?.querySelectorAll<HTMLElement>('[data-cost]').forEach((c) => c.classList.toggle('short', ch < Number(c.dataset.cost)));
    });
  }

  /** Your struct: its card and its orders — weapons that arm, guard and move that pick on the map,
   * its other verbs — priced against the owner's live battery. */
  private ownCard(s: StructFull, p: PlayerState | null): HTMLElement {
    const st = s.Struct, at = s.structAttributes || {};
    const t = TYPES_BY_ID[Number(st.type)];
    const hp = num(at.health);
    const img = h('img', { alt: t.type });
    void structPortrait(t.id, hp < t.maxHealth ? 'dmg' : 'base').then((u) => { img.src = u; });
    const f = this.field()!;
    const own = asOwned(s);
    // Attack and guard need the owner's grid online too (ReadinessCheck, DefenseSet); a move doesn't.
    const state = readyBlock(s, p) || '', moveState = readyBlock(s, null) || '';
    const a = this.arm;
    const btn = (o: { name: string; sub: string; cost?: number; kbd?: string; cls?: string; active?: boolean; disabled?: boolean; title?: string; run: () => void }) =>
      h('button', { class: `btn action ${o.cls || ''}${o.active ? ' active' : ''}`, disabled: !!o.disabled, title: o.title || o.sub, onclick: o.run },
        h('span', { class: 'a-name' }, o.name),
        h('span', { class: 'pa-sub' }, h('span', { class: 'a-sub' }, o.sub), o.cost ? h('span', { class: 'a-cost', 'data-cost': String(o.cost) }, `${o.cost}⚡`) : null),
        o.kbd ? h('kbd', null, o.kbd) : null);
    const actions: HTMLElement[] = [];
    if (p) {
      (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).filter((ws) => hasWeapon(t, ws)).forEach((ws, i) => {
        const n = attackTargets(f, st.id, ws).size;
        const shots = weaponField(t, ws, 'Shots') || 1;
        // The chain takes exactly this many distinct targets; fewer in reach and the weapon can't fire.
        const need = weaponField(t, ws, 'Targets') || 1;
        actions.push(btn({
          name: weaponLabel(t, ws), sub: state || `${n ? (n < need ? `needs ${need} targets, ${n} in reach` : `${n} in reach`) : 'nothing in reach'} · ${reachLabel(t, ws)}`, cost: weaponField(t, ws, 'Charge') || 0, kbd: String(i + 1), cls: 'danger',
          active: a?.kind === 'attack' && a.struct === st.id && a.weapon === ws, disabled: !!state || n < need,
          title: `${controlName(weaponField(t, ws, 'Control'))} · ${shots > 1 ? shots + '× ' : ''}${weaponField(t, ws, 'Damage')} dmg — arm it, then pick the target on the map`,
          run: () => this.beginArm({ kind: 'attack', struct: st.id, weapon: ws, picks: [] }),
        }));
      });
      if (t.canDefend && own.built) {
        const n = guardTargets(f, st.id).size;
        actions.push(btn({ name: 'Guard', sub: state || (n ? 'protect a friend' : 'nothing to guard here'), cost: t.defendChangeCharge, kbd: 'G', cls: 'secondary',
          active: a?.kind === 'defend' && a.struct === st.id, disabled: !!state || !n, run: () => this.beginArm({ kind: 'defend', struct: st.id }) }));
      }
      if (t.movable && own.built) {
        const n = moveDestinations(f, st.id).length;
        actions.push(btn({ name: t.drive_label || 'Move', sub: moveState || (n ? (t.id === COMMAND_SHIP_ID ? 'to another layer' : 'to an empty slot') : 'nowhere to go'), cost: t.moveCharge, kbd: 'M', cls: 'secondary',
          active: a?.kind === 'move' && a.struct === st.id, disabled: !!moveState || !n, run: () => this.beginArm({ kind: 'move', struct: st.id }) }));
      }
      for (const v of verbsFor(p, own)) actions.push(btn({ name: v.label, sub: v.hint, cost: v.cost, cls: v.danger ? 'danger' : 'ghost', run: () => { this.order(v.label, { kind: 'verb', struct: st.id, verb: v.id }); this.refreshField(true); } }));
    }
    const pend = txq.active.find((j) => j.msgs.some((m) => idsInMsg(m.value)[0] === st.id));
    return h('div', { class: 'action-bar panel player pa-own' + (a || this.held ? ' pa-armed' : '') }, this.hint(),
      h('div', { class: 'unit-card' },
        h('div', { class: 'sprite big player' }, img),
        h('div', { class: 'col grow', style: 'gap:4px; min-width:0' },
          h('div', { class: 'unit-name t-label-lg c-player' }, t.type),
          h('div', { class: 't-tiny c-hint', title: `${st.locationType === 'planet' ? 'Planetary slot ' + (own.slot + 1) : t.id === COMMAND_SHIP_ID ? 'Flagship' : 'Fleet slot ' + (own.slot + 1)}` }, h('span', { class: 'x-only' }, `${st.id} · ${st.locationType === 'planet' ? 'Planetary slot ' + (own.slot + 1) : t.id === COMMAND_SHIP_ID ? 'Flagship' : 'Fleet slot ' + (own.slot + 1)} · `), p?.name || store.playerName(st.owner)),
          h('div', { class: 'row', title: `${hp}/${t.maxHealth} HP · ${statusText(num(at.status))}` }, h('span', { class: 'dcb-ico c-hint', html: icon('health', 14) }), h('div', { class: 'pips' }, Array.from({ length: t.maxHealth }, (_, i) => h('i', { class: i < hp ? '' : 'lost' }))), h('span', { class: 't-tiny c-hint' }, `${hp}/${t.maxHealth}`)),
          h('div', { class: 'row wrap', style: 'gap:4px' },
            h('span', { class: 'chip ambit-' + st.operatingAmbit, title: AMBIT_NAME[st.operatingAmbit as Ambit] || st.operatingAmbit }, h('span', { class: 'dcb-ico', html: icon(st.operatingAmbit, 13) })),
            DEFENSE_NAME[t.unitDefenses] ? h('span', { class: 'chip', title: DEFENSE_HINT[t.unitDefenses] || '' }, DEFENSE_NAME[t.unitDefenses]) : null,
            own.hidden ? h('span', { class: 'chip warn' }, 'Stealthed') : null,
            own.defenders.length ? h('span', { class: 'chip player' }, `Guarded ×${own.defenders.length}`) : null),
          pend ? h('div', { class: 't-tiny c-warn' }, `Queued: ${pend.label}`) : null)),
      h('div', { class: 'col pa-orders' },
        h('div', { class: 'row pa-orders-head' },
          h('span', { class: 'dcb-head-t', style: 'flex:none' }, h('span', { class: 'dcb-ico', html: icon('flag', 16) }), h('span', { class: 't-label c-player' }, 'Orders')),
          wallet.state !== 'unlocked' ? h('span', { class: 't-tiny c-hint pa-locked', title: 'Arm and aim freely; firing asks for the vault and the order goes the moment it opens' }, 'vault locked') : null,
          h('span', { class: 'grow' }),
          p ? this.batteryEl(p) : h('span', { class: 't-tiny c-hint' }, 'Reading your empire…'),
          pill('base', 'Base', 'Open this commander’s base', () => { audio.play('select'); this.navigate('/command/' + st.owner); }, 'btn ghost mini')),
        actions.length ? h('div', { class: 'pa-actions' }, actions) : h('div', { class: 't-tiny c-hint' }, p ? 'No orders for this struct right now.' : '')));
  }

  /** The build menu for an empty slot of yours: what fits this battleground, its charge, draw and limit. */
  private renderBuild(x: Slot) {
    const p = empire.players.get(x.owner) ?? null;
    const types = buildable(x.where, x.ambit);
    const queued = this.queuedBuilds(x.owner);
    const owned = (t: StructType) => (p ? [...p.structs.values()].filter((s) => s.typeId === t.id && !s.destroyed).length : 0) + queued.filter((id) => id === t.id).length;
    const why = this.buildWhy(x);
    const warn = why ? cap(why) + '.' : '';
    const close = () => { this.buildAt = null; audio.play('select'); this.refreshField(true); };
    const opts = types.map((t) => {
      const img = h('img', { alt: '', draggable: false });
      void structPortrait(t.id).then((u) => { img.src = u; });
      const have = owned(t);
      const limit = !!t.buildLimit && have >= t.buildLimit;
      const no = why || (p ? this.typeWhy(t, p) : 'reading your empire');
      return h('button', { class: 'pa-opt' + (no ? ' dim' : ''), disabled: !!no, title: no ? cap(no) : roleOf(t), onclick: () => {
        this.buildAt = null;
        this.quietUntil = performance.now() + 400;
        this.order(`Build ${t.type}`, { kind: 'build', typeId: t.id, at: x }, () => banner(t.type.toUpperCase(), 'CONSTRUCTION QUEUED', 'player', 1400));
        this.refreshField(true);
      } }, h('div', { class: 'sprite' }, img), h('div', { class: 'col', style: 'gap:2px; min-width:0; text-align:left' },
        h('div', { class: 't-label-lg c-player pa-opt-name' }, t.type),
        h('div', { class: 't-tiny c-hint pa-opt-role x-only' }, roleOf(t)),
        h('div', { class: 'row t-tiny', style: 'gap:8px' },
          h('span', { class: 'pa-cost', 'data-cost': String(t.buildCharge) }, `⚡${t.buildCharge}`),
          h('span', { class: 'c-hint', title: 'Power drawn while it builds → while online' }, `${formatDraw(t.buildDraw)} → ${formatDraw(t.passiveDraw)}`),
          t.buildLimit ? h('span', { class: limit ? 'c-enemy' : 'c-hint', title: 'Owned (and queued) of its build limit' }, `${have}/${t.buildLimit}`) : null)));
    });
    this.root.appendChild(h('div', { class: 'action-bar panel player pa-build' + (this.held ? ' pa-armed' : '') }, this.hint(),
      h('div', { class: 'col grow', style: 'gap:6px; min-width:0' },
        h('div', { class: 'spread' },
          h('span', { class: 'dcb-head-t', title: `Build · ${x.where === 'planet' ? 'Planetary' : 'Fleet'} slot · ${AMBIT_NAME[x.ambit]} ${x.slot + 1}. Construction starts when the order lands; the proof engine grinds the proof-of-work that completes it.` },
            h('span', { class: 'dcb-ico', html: icon('build', 18) }), h('span', { class: 't-label c-player' }, 'Build'), h('span', { class: 'chip ambit-' + x.ambit }, h('span', { class: 'dcb-ico', html: icon(x.ambit, 13) }), String(x.slot + 1))),
          h('span', { class: 'row', style: 'gap:8px' }, p ? this.batteryEl(p) : h('span', { class: 't-tiny c-hint' }, 'Reading your empire…'),
            h('button', { class: 'btn ghost icon', 'aria-label': 'Close', onclick: close }, '×'))),
        warn ? h('div', { class: 't-tiny c-warn' }, warn) : null,
        types.length ? h('div', { class: 'pa-opts scroll' }, opts) : h('div', { class: 't-tiny c-hint' }, 'Nothing can be built in this layer.'),
        h('div', { class: 't-tiny c-hint x-only' }, 'Construction starts when the order lands; the proof engine grinds the proof-of-work that completes it.'))));
    this.paintBattery();
  }

  /** Arm an order (or put it down, pressing its button again). */
  private beginArm(next: Arm) {
    const a = this.arm;
    if (a && a.kind === next.kind && a.struct === next.struct && (a.kind !== 'attack' || (next.kind === 'attack' && a.weapon === next.weapon))) { this.disarm(); return; }
    this.arm = next;
    this.buildAt = null;
    this.selected = next.struct;
    audio.play(next.kind === 'attack' ? 'charge' : 'select');
    this.refreshField(true);
  }

  private disarm() {
    if (!this.arm && !this.held) return;
    this.arm = null;
    this.held = null;
    audio.play('deny', 0.4);
    this.engine.canvas.style.cursor = 'default';
    this.refreshField(true);
  }

  /** One click or tap on the map: fire, guard, move, build or select — whatever the armed order wants. */
  private tap(u: UnitView | null, tile: TileSpec | null) {
    if (performance.now() < this.quietUntil) return;
    const a = this.arm, f = this.field();
    if (a && f) {
      if (u && this.valid.has(u.id)) { if (a.kind === 'attack') this.pickTarget(u.id); else if (a.kind === 'defend') this.guardWard(u.id); return; }
      if (tile && a.kind === 'move' && tile.state === 'move') { this.moveTo(tile); return; }
      if (u && u.id !== a.struct) {
        const why = a.kind === 'attack' ? attackBlock(f, a.struct, u.id, a.weapon) : a.kind === 'defend' ? guardBlock(f, a.struct, u.id) : 'pick one of the glowing slots';
        audio.play('deny');
        toast(cap(why || 'not a target'), 'warn', 2400);
        return;
      }
      this.disarm();   // the shooter itself, or empty space, puts the order down
      return;
    }
    if (tile?.state === 'build') { this.openBuild(tile); return; }
    if (tile?.state === 'reserved') { audio.play('deny'); toast('An order is already headed for this slot', 'warn', 1800); return; }
    this.selected = u ? u.id : null;
    this.buildAt = null;
    if (u) audio.play('select');
    this.refreshField(true);
  }

  private openBuild(x: Slot) {
    this.buildAt = x;
    this.selected = null;
    this.arm = null;
    audio.play('select');
    this.refreshField(true);
  }

  /** Add a target to the armed weapon; it fires once it has as many (distinct) as the weapon takes. */
  private pickTarget(id: string) {
    const a = this.arm;
    const s = a ? this.data?.structs.get(a.struct) : undefined;
    const t = s ? TYPES_BY_ID[Number(s.Struct.type)] : undefined;
    if (a?.kind !== 'attack' || !t) return;
    const max = weaponField(t, a.weapon, 'Targets') || 1;
    const next = addPick(a.picks, id, max);
    if (typeof next === 'string') { audio.play('deny'); toast(cap(next), 'warn', 2000); return; }
    a.picks = next;
    audio.play('tick');
    if (a.picks.length >= max) this.fire();
    else this.refreshField(true);
  }

  private typeName(id: string) { return TYPES_BY_ID[Number(this.data?.structs.get(id)?.Struct.type)]?.type || id; }

  private fire() {
    const a = this.arm;
    if (a?.kind !== 'attack' || !a.picks.length) return;
    this.arm = null;
    this.quietUntil = performance.now() + 400;
    const ws = a.weapon;
    this.order(`${this.typeName(a.struct)} fires on ${a.picks.map((id) => this.typeName(id)).join(', ')}`, { kind: 'attack', struct: a.struct, weapon: ws, targets: [...a.picks] },
      () => audio.play(ws === 'primaryWeapon' ? 'missile' : 'gatling', 0.6));
    this.refreshField(true);
  }

  private guardWard(id: string) {
    const a = this.arm;
    if (a?.kind !== 'defend') return;
    this.arm = null;
    this.quietUntil = performance.now() + 400;
    this.order(`${this.typeName(a.struct)} guards ${this.typeName(id)}`, { kind: 'defend', struct: a.struct, ward: id }, () => audio.play('shield', 0.6));
    this.refreshField(true);
  }

  private moveTo(x: TileSpec) {
    const a = this.arm;
    if (a?.kind !== 'move') return;
    this.arm = null;
    this.quietUntil = performance.now() + 400;
    this.order(`${this.typeName(a.struct)} → ${AMBIT_NAME[x.ambit]}${x.command ? '' : ' ' + (x.slot + 1)}`, { kind: 'move', struct: a.struct, to: x }, () => audio.play('warp', 0.5));
    this.refreshField(true);
  }

  /** Queue an order — or, vault locked, hold it and open the vault: it goes the moment it unlocks, if it
   * still stands then. One order waits at a time; a new one replaces it, and says so. */
  private order(label: string, intent: Intent, after?: () => void) {
    const owner = intent.kind === 'build' ? intent.at.owner : this.data?.structs.get(intent.struct)?.Struct.owner || '';
    if (wallet.state !== 'unlocked') {
      const acct = wallet.byPlayer(owner);
      if (!acct) { audio.play('deny'); toast('This vault doesn’t sign for that commander', 'warn', 3000); return; }
      if (this.held) toast(`Replaced “${this.held.label}” — one order waits on the vault at a time`, 'warn', 3600);
      this.held = { label, intent, owner, account: acct.index, height: this.height, after };
      openVault();
      toast(`Unlock to send “${label}” — it goes the moment you do`, 'warn', 4200);
      return;
    }
    try { this.execute(intent); after?.(); audio.play('confirm'); toast(`${label} — queued`, 'player', 1800); }
    catch (e) { audio.play('deny'); toast(cap((e as Error).message), 'enemy', 4000); }
  }

  /** Queue what an intent means, checked against the board as it stands now (throws why not). */
  private execute(i: Intent): TxJob {
    const f = this.field();
    if (!f) throw new Error('the map is still loading');
    const why = intentBlock(f, i);
    if (why) throw new Error(why);
    if (i.kind === 'build') {
      const p = empire.players.get(i.at.owner), t = TYPES_BY_ID[i.typeId];
      if (!p || !empire.commands(i.at.owner) || !t) throw new Error('you no longer command that player');
      const no = this.buildWhy(i.at) || this.typeWhy(t, p);
      if (no) throw new Error(no);
      return act.build(p, t, i.at.ambit, i.at.slot);
    }
    const actor = this.actorFor(i.struct);
    if (!actor?.p) throw new Error('you no longer command that struct');
    const p = actor.p, own = asOwned(actor.s);
    if (i.kind === 'verb') {
      const v = verbsFor(p, own).find((x) => x.id === i.verb);
      if (!v) throw new Error('that order no longer applies');
      return v.run();
    }
    const r = readyBlock(actor.s, i.kind === 'move' ? null : p);
    if (r) throw new Error(r);
    if (i.kind === 'attack') {
      const need = own.type ? weaponField(own.type, i.weapon, 'Targets') || 1 : 1;
      if (i.targets.length !== need) throw new Error(`the weapon takes exactly ${need} target${need > 1 ? 's' : ''}`);
      return act.attack(p, own, i.targets, i.weapon);
    }
    if (i.kind === 'defend') return act.defend(p, own, i.ward);
    return act.move(p, own, i.to.where, i.to.ambit, i.to.slot);
  }

  private tileTip(x: TileSpec) {
    const where = `${x.where === 'planet' ? 'Planetary' : 'Fleet'} slot · ${AMBIT_NAME[x.ambit]}${x.command ? '' : ' ' + (x.slot + 1)}`;
    const job = x.state === 'reserved' ? txq.active.find((j) => j.playerId === x.owner && j.msgs.some((m) => slotOfMsg(m.typeUrl, m.value) === slotKey(x))) : undefined;
    return h('div', null, h('div', { class: 't-label ' + (x.state === 'reserved' ? 'c-warn' : 'c-player') }, x.state === 'move' ? 'Move here' : x.state === 'reserved' ? 'Order on its way' : 'Empty slot'),
      h('div', { class: 't-tiny c-hint' }, x.state === 'reserved' ? (job?.label || where) : x.state === 'move' ? where : `${where} — ${matchMedia('(pointer: coarse)').matches ? 'tap' : 'click'} to build`));
  }

  /* ── Input ────────────────────────────────────────────────────────────── */
  private bindInput() {
    const canvas = this.engine.canvas;
    const move = (e: PointerEvent) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.pointerPx = { x: e.clientX, y: e.clientY };
    };
    const click = (e: PointerEvent) => {
      move(e);
      const u = this.pick();
      this.tap(u, u ? null : this.pickTile());
    };
    const leave = () => { this.pointer.set(9, 9); this.tip.key = ''; hideTooltip(); };
    // Wheel zooms toward the cursor; double-click or Z frames the map again.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (this.intro < 1 || !this.view) return;
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.zoom.wheel(e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY, this.camera, this.pointer);
    };
    const dbl = () => this.zoom.reset();
    // Click and drag moves the map (one finger too): its edges sit under the panels, so it moves a
    // little even unzoomed, and freely when zoomed in. A click that didn't move still picks.
    this.zoom.slack = 0.35;
    const ndc = (x: number, y: number) => new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    const undrag = bindDrag(canvas, (x0, y0, x1, y1) => {
      if (this.intro < 1 || !this.view) return;
      this.dragging = true;
      this.zoom.drag(this.camera, ndc(x0, y0), ndc(x1, y1));
      if (this.tip.key) { this.tip.key = ''; hideTooltip(); }
      canvas.style.cursor = 'grabbing';
    }, () => { this.dragging = false; canvas.style.cursor = 'grab'; });
    const unpinch = bindPinch(canvas, (dy, x, y) => {
      if (this.intro < 1 || !this.view) return;
      this.pointer.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
      this.zoom.wheel(dy, this.camera, this.pointer);
    });
    // Capture phase, so a key the map takes (M to move) doesn't also reach the shell's (M mutes).
    const key = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement | null;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tg?.tagName || '') || tg?.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      // A modal (the vault, a confirm, the palette) owns the keyboard: Esc there must not drop the held order.
      if (document.querySelector('.modal-back') || !this.data) return;
      const took = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (e.key === 'z' || e.key === 'Z') { this.zoom.reset(); return; }
      if (e.key === 'Escape') {
        // Esc closes an open dock first; the order stays armed.
        if (document.querySelector('.ops-dock.open, .cp-dock.open')) return;
        if (this.arm || this.held) { took(); this.disarm(); }
        else if (this.buildAt || this.selected) { took(); this.buildAt = null; this.selected = null; this.refreshField(true); }
        return;
      }
      if (e.repeat) return;   // a held key would arm, disarm, arm…
      if (e.key === 'Backspace' && this.arm?.kind === 'attack' && this.arm.picks.length) { took(); this.arm.picks.pop(); audio.play('deny', 0.4); this.refreshField(true); return; }
      // 1 / 2 / G / M press the order button that shows that key (and only that: not mute too).
      const k = e.key.toLowerCase();
      const btn = [...this.root.querySelectorAll<HTMLButtonElement>('.pa-own .btn.action')].find((b) => b.querySelector('kbd')?.textContent?.toLowerCase() === k);
      if (!btn) return;
      took();
      if (btn.disabled) audio.play('deny', 0.5); else btn.click();
    };
    canvas.addEventListener('pointermove', move);
    const untap = bindTap(canvas, click, { mouseOnRelease: true });
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('dblclick', dbl);
    window.addEventListener('keydown', key, true);
    this.unsub.push(() => {
      canvas.removeEventListener('pointermove', move); untap(); canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('dblclick', dbl); window.removeEventListener('keydown', key, true); unpinch(); undrag();
    });
  }

  private pick(): UnitView | null {
    if (!this.view || this.pointer.x > 2) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.view.pickables(), false);
    return hits.length ? (hits[0].object.userData.unit as UnitView) : null;
  }

  private pickTile(): TileSpec | null {
    if (!this.overlay || this.pointer.x > 2) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.overlay.pickTile(this.raycaster);
  }

  private updateHover() {
    const u = this.pick();
    const tile = u ? null : this.pickTile();
    const id = u?.id || null;
    const a = this.arm;
    if (id !== this.hovered) {
      if (this.hovered) { const o = this.view?.units.get(this.hovered); if (o) o.hover = 0; }
      this.hovered = id;
      if (u) { u.hover = 1; audio.play('hover'); }
    }
    const tk = tile ? tileKey(tile) : null;
    if (tk && tk !== (this.hoverTile ? tileKey(this.hoverTile) : null)) audio.play('hover', 0.6);
    this.hoverTile = tile;
    if (this.overlay) {
      this.overlay.hoverUnit = id && this.valid.has(id) ? id : null;
      this.overlay.hoverTile = tk ?? (this.buildAt ? tileKey(this.buildAt) : null);
    }
    // Armed, the map is a gunsight: crosshair, refused over what the order can't take.
    const usable = !!tile && (a ? a.kind === 'move' && tile.state === 'move' : tile.state !== 'move');
    // Anywhere else the map can be dragged: an open hand, closed while it moves.
    const cursor = this.dragging ? 'grabbing' : a ? (u && !this.valid.has(u.id) && u.id !== a.struct ? 'not-allowed' : usable ? 'pointer' : 'crosshair') : u || usable ? 'pointer' : 'grab';
    if (this.engine.canvas.style.cursor !== cursor) this.engine.canvas.style.cursor = cursor;
    // The tooltip is rebuilt only when what it says can have changed, and moved only when the pointer did.
    const tipKey = tile && !u ? 'T' + tk + tile.state + this.fieldVersion : u && this.data ? 'U' + u.id + this.fieldVersion + (a ? 'a' : '') : '';
    const { x, y } = this.pointerPx;
    if (tipKey === this.tip.key) {
      if (tipKey && this.tip.node && (x !== this.tip.x || y !== this.tip.y)) { this.tip.x = x; this.tip.y = y; showTooltip(x, y, this.tip.node, this.tip.node.dataset.kind || ''); }
      return;
    }
    this.tip = { key: tipKey, x, y, node: null };
    if (tile && !u) { this.showTip(this.tileTip(tile), tile.state === 'reserved' ? 'neutral' : 'player'); return; }
    if (!u || !this.data) { hideTooltip(); return; }
    const s = this.data.structs.get(u.id);
    const f = this.field();
    if (!s || !f) { hideTooltip(); return; }
    const t = TYPES_BY_ID[Number(s.Struct.type)];
    let order: HTMLElement | null = null;
    if (a && u.id !== a.struct) {
      const why = a.kind === 'attack' ? attackBlock(f, a.struct, u.id, a.weapon) : a.kind === 'defend' ? guardBlock(f, a.struct, u.id) : 'pick one of the glowing slots';
      const shooter = TYPES_BY_ID[Number(f.structs.get(a.struct)?.Struct.type)];
      order = why ? h('div', { class: 't-tiny c-warn', style: 'margin-top:3px' }, cap(why))
        : a.kind === 'attack' ? h('div', { class: 't-label c-enemy', style: 'margin-top:4px' }, `Fire ${weaponLabel(shooter, a.weapon)} · ${weaponField(shooter, a.weapon, 'Damage')} dmg ▸`)
        : h('div', { class: 't-label c-player', style: 'margin-top:4px' }, 'Guard this struct ▸');
    }
    this.showTip(h('div', null,
      h('div', { class: 'spread' }, h('span', { class: 't-label ' + (u.side === 'player' ? 'c-player' : 'c-enemy') }, t.type), h('span', { class: 't-tiny c-hint' }, s.Struct.id)),
      h('div', { class: 't-tiny c-hint' }, `${statusText(num(s.structAttributes?.status))} · ${num(s.structAttributes?.health)}/${t.maxHealth} HP · ${store.playerName(s.Struct.owner)}`),
      (s.structDefenders || []).length ? h('div', { class: 't-tiny c-hint' }, `Guarded by ${s.structDefenders!.length}`) : null,
      order), u.side);
  }

  private showTip(node: HTMLElement, kind: string) {
    node.dataset.kind = kind;
    this.tip.node = node;
    showTooltip(this.tip.x, this.tip.y, node, kind);
  }

  /* ── Frame ────────────────────────────────────────────────────────────── */
  update(dt: number, t: number) {
    tickSpace(this.sky, t);
    if (!this.view) return;
    this.view.update(dt, t);
    this.overlay?.update(t, this.engine.reduceMotion);
    if (this.shieldMat) this.shieldMat.uniforms.uTime.value = t;
    this.updateActivity(dt);
    if (this.pointer.x < 2) this.updateHover();
    else if (this.overlay) { this.overlay.hoverUnit = null; this.overlay.hoverTile = this.buildAt ? tileKey(this.buildAt) : null; }
    const px = this.pointer.x < 2 ? this.pointer.x : 0, py = this.pointer.x < 2 ? this.pointer.y : 0;
    const cam = this.camera.position;
    if (this.intro < 1) {
      // Descend from high orbit over the world's limb onto the map.
      this.intro = Math.min(1, this.intro + dt / 2.2);
      const k = easeInOutCubic(this.intro);
      cam.set(this.centerX + (1 - k) * 18, 0.6 + (1 - k) * 70, this.fitDist + (1 - k) * 90);
      this.cx = this.centerX; this.sway.set(0, 0.6); this.dist = this.fitDist;
      const look = this.look.clone(); look.y -= (1 - k) * 40;
      this.camera.lookAt(look);
      if (this.els.cols) this.els.cols.style.opacity = '0';
      return;
    }
    if (this.els.cols && this.els.cols.style.opacity === '0') this.els.cols.style.opacity = '1';
    const z = this.zoom;
    z.update(dt);
    const zs = z.cur, off = z.offset;
    // Sway, framing centre and distance are smoothed on their own; the zoom (scale and pan,
    // smoothed together in BoardZoom) goes on top so the point under the cursor stays put.
    this.sway.x = damp(this.sway.x, px * 2.4 + Math.sin(t * 0.13) * 0.8, 2, dt);
    this.sway.y = damp(this.sway.y, 0.6 + py * 1.3 + Math.sin(t * 0.17) * 0.3, 2, dt);
    this.cx = damp(this.cx, this.centerX, 2, dt);
    this.dist = damp(this.dist, this.fitDist, 3, dt);
    cam.set(this.cx + off.x + this.sway.x * zs, off.y + this.sway.y * zs, this.dist * zs);
    this.zoomLook.set(this.cx + off.x, this.look.y + off.y, 0);
    this.camera.lookAt(this.zoomLook);
    // Column captions follow the map.
    const cols = this.els.cols;
    if (cols) {
      const v = this.capV;
      const w = window.innerWidth, hh = window.innerHeight;
      cols.querySelectorAll<HTMLElement>('.colcap').forEach((el) => {
        v.set(Number(el.dataset.x), Number(el.dataset.y), 0).project(this.camera);
        const sx = ((v.x + 1) / 2) * w, sy = ((1 - v.y) / 2) * hh;
        el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`;
        // A caption under a side panel (or off the zoomed view) would collide with its text.
        el.classList.toggle('placed', sx > this.safeX[0] + 40 && sx < this.safeX[1] - 40 && sy > this.safeY + 8);
      });
    }
  }
}
