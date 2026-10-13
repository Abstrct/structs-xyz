/* Battle Simulator: setup → deploy → battle ⇄ paused → debrief.
 * Your fleet against the computer's, both away from home, resolved block by
 * block by the TypeScript port of structsd's combat rules. */
import * as THREE from 'three';
import type { Engine, Screen } from '../../core/engine';
import { moveFocus } from '../../core/pad';
import { banner, confirmBox, copyText, dismissConfirms, h, hideTooltip, holdRewards, portrait, showTooltip, toast } from '../../core/dom';
import { audio } from '../../core/audio';
import { cap, clamp, damp, hash32 } from '../../core/util';
import { BoardZoom, bindPinch, bindTap } from './zoom';
import {
  type Ambit, AMBIT_FLAG, AMBIT_NAME, AMBITS, canTargetAmbit, COMMAND_SHIP_ID, controlName, DEFENSE_HINT, DEFENSE_NAME, PASSIVE_NAME,
  reachLabel, TYPES_BY_ID, type WeaponSystem, weaponField, weaponLabel, hasWeapon, roleOf,
} from '../../data/catalogue';
import { BATTLE_LINES } from '../../data/lore';
import { Chain, type Block, type Msg, type SimStruct } from '../../sim/chain';
import { Ai, type Difficulty } from '../../sim/ai';
import { closeGuide } from '../../ui/guide';
import { icon } from '../../ui/icons';
import { record, RANKS } from '../../game/record';
import { chainSetup, CPU, type Daily, dailyKey, dailyScenario, decodeBattle, decodeReplay, DIFFICULTY_FOR, encodeBattle, encodeReplay, type ReplayCode, FLEET_TYPES, fits, GAUNTLET_ROUNDS, gauntletEnemy, layout, PRESETS, type Preset, reinforcementOffers, type Unit, unitId, validate, YOU } from '../../sim/fleets';
import { addBattle, dailyBest, dailyStreak, describeDaily, loadRecord, saveDaily, type DailyResult } from './record';
import { createNebulaSky, createStarfield, tickSpace } from '../../gfx/space';
import { spriteDataUrl } from '../../gfx/pixelModel';
import { BattleView, type UnitView } from './view';
import { BattleSession, predictAttack, QUIET_BLOCKS, type Outcome } from './session';
import { addBattleLights, FIELD, fieldHalfWidth, portraitField, slotStagger, slotX, TIER_STRETCH, WORLD_PALETTES } from './env';
import { currentRoute, routeUrl } from '../../core/nav';
import '../../styles/dc-battle.css';

type Phase = 'setup' | 'deploy' | 'battle' | 'debrief' | 'replay';
type Targeting = { kind: 'attack'; ws: WeaponSystem } | { kind: 'guard' } | null;

const BATTERY_CELLS = 12;

/** How the player is playing right now: a pad (its face buttons), a keyboard (keys), or touch. */
function inputMode(): 'pad' | 'keys' | 'touch' {
  if (document.body.classList.contains('pad')) return 'pad';
  return matchMedia('(hover: none)').matches ? 'touch' : 'keys';
}
/** A verb's button for the input in use: the pad's face button, the key, or nothing on touch.
 * The colour stays the verb's either way (red goes, yellow guards, green drifts). */
function face(btn: 'a' | 'b' | 'x' | 'y', key: string | null): HTMLElement | null {
  const mode = inputMode();
  if (mode === 'touch' || (mode === 'keys' && !key)) return null;
  return h('span', { class: 'dc-face ' + btn + (mode === 'keys' ? ' key' : ''), 'aria-hidden': 'true' }, mode === 'pad' ? btn.toUpperCase() : key);
}
const say = (m: Record<'pad' | 'keys' | 'touch', string>) => m[inputMode()];
/** Fleet sizes in words, so "Easy" only ever means the computer's skill. */
const SIZE_WORD: Record<Preset, string> = { easy: 'Small', difficult: 'Medium', hard: 'Large', random: 'Random' };

/** How far (px) a tap reaches for the nearest ship: a thumb-sized target (44 px) around every hull. */
const FINGER_REACH = 44;

/** mobile.css's upright-phone layout, where the hubs are a 64 px bar along the bottom. */
const TABBAR_QUERY = '(max-width: 760px) and (pointer: coarse) and (min-height: 561px)';

/** The TV setup panel folded to a strip while the pad's cursor is on the board (dc-battle.css
 * .setup-panel.slim: 8 px margin + 104 px strip + 8 px gap). */
const SLIM_SIDE = 120;

/** The results' Next ▸ climbs one rung at a time, in the order kid-style pilots found smoothest (a
 * headless balance run, 30 seeds a cell): a Medium fleet on Easy, then a Small fleet against a Medium
 * computer (where guarding the Command Ship starts to pay), then a Large fleet on Easy, and up. */
const LADDER: { preset: Preset; difficulty: Difficulty; why?: string }[] = [
  { preset: 'easy', difficulty: 'easy' }, { preset: 'difficult', difficulty: 'easy' },
  { preset: 'easy', difficulty: 'difficult', why: 'guard your Command Ship' }, { preset: 'hard', difficulty: 'easy', why: 'bring more ships: fill your empty + bays' },
  { preset: 'difficult', difficulty: 'difficult' }, { preset: 'hard', difficulty: 'difficult' }, { preset: 'hard', difficulty: 'hard' },
];

/** Each daily twist's picture, beside its name on the Daily tile. */
const TWIST_ICON: Record<string, string> = { standard: 'counter', outnumbered: 'ship', battered: 'health', 'no-guards': 'shield', orbit: 'space', fortress: 'crown' };

/** Two glyphs the kit's set lacks, drawn the same way (24×24, round 2.6 strokes in currentColor):
 * a hand (you fly your fleet) and a door with an arrow out of it (retreat). */
const glyph = (body: string, size: number) => `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const HAND = (size: number) => glyph('<path d="M8 12.5 V6 A1.6 1.6 0 0 1 11.2 6 V11 M11.2 10.5 V4.6 A1.6 1.6 0 0 1 14.4 4.6 V11 M14.4 10.8 V6.2 A1.6 1.6 0 0 1 17.6 6.2 V13.5 C17.6 18.5 15 21 11.5 21 C8.8 21 7.4 19.6 6 17.3 L3.8 13.6 A1.5 1.5 0 0 1 6.4 12.1 L8 14"/>', size);
const UNGUARD = (size: number) => glyph('<path d="M12 3 L20 6 V12 C20 17 16 20 12 21 C8 20 4 17 4 12 V6 Z" opacity=".55"/><path d="M4 4 L20 20"/>', size);
const EXIT = (size: number) => glyph('<path d="M13 4 H6 A2 2 0 0 0 4 6 V18 A2 2 0 0 0 6 20 H13 M10 12 H21 M17 8 L21 12 L17 16"/>', size);

/** A weapon's one word, under its icon: the last word of its name ("Chimera Missile" → Missile), or
 * a plainer word where that one says little. The full name stays in the button's title. */
const WEAPON_WORD: Record<string, string> = { 'Mass Accelerator': 'Cannon', 'Attack Run': 'Strafe', 'AA-Cannons': 'Flak', 'Smart weapon': 'Fire', 'Ballistic weapon': 'Fire', Weapon: 'Fire' };
const weaponWord = (label: string) => WEAPON_WORD[label] || label.split(/\s+/).pop() || 'Fire';

/** The control each coach step is about: its callout points there. */
const COACH_ANCHOR: Record<string, string> = {
  fill: '.dc-fill-mark',
  arm: '.action-bar .btn.action.weapon:not(:disabled)',
  aim: '.action-bar .btn.action.weapon.active',
  // "A move needs its ⚡": the ⚡ on the weapon's button (the HUD's battery drains as it says).
  charge: '.action-bar .btn.action.weapon .a-cost',
  guard: '.action-bar .btn.action.secondary',
  drift: '.action-bar .drift',
  flagship: '.action-bar .btn.action.weapon.active',
  stuck: '.action-bar .drift .btn.mini.dc-go-layer, .action-bar .drift',
};

export class BattleScreen implements Screen {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.1, 2000);
  readonly bloom = { strength: 0.75, radius: 0.5, threshold: 0.5 };
  private view!: BattleView;
  private sky: THREE.Object3D[] = [];
  private root!: HTMLElement;
  private layer!: HTMLElement;
  private phase: Phase = 'setup';
  /** Early battles are easy ones: until three wins, the picket and the computer start small and easy
   *  (the results' "9 · Medium ▸" is the way up before then). */
  private preset: Preset = loadRecord().wins < 3 ? 'easy' : 'difficult';
  private difficulty: Difficulty = DIFFICULTY_FOR[this.preset];
  /** The setup's finer controls (computer skill, who flies, pace) fold away until asked for. */
  private moreOpts = false;
  /** XP when the battle began: the results screen shows what this fight earned. */
  private xpAtStart = 0;
  /** Sessions whose fight has been paid for (a results screen shown twice pays once). */
  private paid = new WeakSet<object>();
  /** The written battle log: off unless the player opens it (remembered). */
  private showLog = (() => { try { return localStorage.getItem('structs.battle.log') === '1'; } catch { return false; } })();
  private blockMs = 2000;
  /** Spectate: computer vs computer. */
  private spectate = false;
  /** Gauntlet run: your surviving fleet carries from round to round. */
  /** Gauntlet run: `round` is the next round to fight; `fought` the last one finished;
   * `reinforce` means a won round still owes its reinforcement pick. */
  private gauntlet: { round: number; fleet: Unit[]; seed: string; engaged: boolean; over: boolean; fought: number; reinforce: boolean } | null = null;
  /** Daily engagement: today's shared scenario (fixed fleets, twist, dice). */
  private daily: Daily | null = null;
  /** The last finished daily attempt, and whether it set today's best. */
  private dailyLast: { r: DailyResult; best: boolean } | null = null;
  /** Unit id → chain struct id for the battle in progress. */
  private liveIdMap: Record<string, string> = {};
  /** Keep the current draft on the next enter (leaving a replay link). */
  private keepDraft = false;
  /** The battle in progress as a replay would need it: the exact layout and chain seed. */
  private liveSetup: { units: Unit[]; seed: string; start: number } | null = null;
  /** Replay playback state. */
  private replay: { code: ReplayCode; chain: Chain; i: number; acc: number; speed: number; end: number; done: boolean; ready: boolean } | null = null;
  private seed = 'structs';
  private draft: Unit[] = [];
  private preview: { chain: Chain; idMap: Record<string, string>; reverse: Record<string, string> } | null = null;
  private session: BattleSession | null = null;
  private chain: Chain | null = null;
  private selected: string | null = null;
  private hovered: string | null = null;
  /** Touch has no hover: the target whose forecast a first tap is showing; a second tap fires. */
  private touchArmed: { target: string; ws: string; from: string; at: { x: number; y: number } } | null = null;
  private targeting: Targeting = null;
  private held: { msg: Msg; cost: number; label: string } | null = null;
  private paused = false;
  private ghosts = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(9, 9);
  private pointerPx = { x: 0, y: 0 };
  /** How far (px) a finger's tap reaches for the nearest ship; 0 for a mouse, which points exactly. */
  private fingerNear = 0;
  private camLook = new THREE.Vector3(0, -0.4, 0);
  private focus = new THREE.Vector3(0, -0.4, 0);
  private focusW = 0;
  private logEl!: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private predictCache = new Map<string, ReturnType<typeof predictAttack>>();
  private cleanup: (() => void)[] = [];
  private buildToken = 0;
  private lastBattery = { you: -1, cpu: -1 };
  private coachEl: HTMLElement | null = null;
  private punch = 0;
  private zoom = new BoardZoom(0.42, 26, 12);
  /** Smoothed camera state before zoom is applied. */
  private sway = new THREE.Vector2(0, 0.6);
  private look = new THREE.Vector2(0, -0.4);
  private dist = 47;
  /** Snap the camera to its fit on the first frame after entering (no zoom-out on load). */
  private snapCam = true;

  constructor(private engine: Engine, private navigate: (h: string) => void) {
    this.sky = [createNebulaSky({ seed: 11.3, intensity: 0.9 }), createStarfield(5000, 800, 21)];
    for (const s of this.sky) this.scene.add(s);
    addBattleLights(this.scene);
    this.scene.add(this.ghosts);
    this.camera.position.set(0, 0.6, 47);
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */
  async enter(params: Record<string, string>) {
    this.root = h('div', { class: 'screen battle' });
    this.layer = h('div', { class: 'tags-layer' });
    this.root.appendChild(this.layer);
    document.getElementById('ui')!.appendChild(this.root);
    this.view = new BattleView(this.camera, this.layer);
    this.scene.add(this.view.group);
    this.view.onFocus = (p, w) => { this.focus.copy(p); this.focusW = Math.max(this.focusW, w); };
    this.view.onShake = (a) => this.engine.addShake(a);
    this.view.onFlash = (a, c) => this.engine.addFlash(a, c);
    this.view.onCinematic = (p) => { if (this.engine.reduceMotion) return; this.focus.copy(p); this.focusW = 1.6; this.punch = 1; };
    this.view.reduceMotion = this.engine.reduceMotion;
    this.view.onCommandDestroyed = (side) => {
      banner(side === 'player' ? 'FLAGSHIP DOWN' : 'K.O.!', side === 'player' ? 'YOUR COMMAND SHIP IS GONE' : 'ENEMY COMMAND SHIP DOWN', side === 'player' ? 'enemy' : 'player', 1800);
      if (side === 'player') audio.stinger('youExploded', 0.7);
    };
    this.zoom.reset(true);
    this.resize(window.innerWidth, window.innerHeight);
    this.snapCam = true;
    this.bindInput();
    if (params.code === 'daily') {
      // A link to today's daily: open it in setup, ready to engage. A run in progress is
      // shown first, and the daily asks before abandoning it.
      if (this.gauntlet?.over) this.gauntlet = null;
      this.keepDraft = false;
      if (this.gauntlet) this.resumeGauntlet();
      this.startDaily();
      return;
    }
    // A replay link plays and then returns you to whatever you were doing. A battle code
    // replaces a run in progress, but only once it decodes, and only after you confirm.
    if (this.gauntlet?.over) this.gauntlet = null;
    if (params.code?.startsWith('R')) {
      const r = decodeReplay(params.code);
      if (r) { void this.startReplay(r); return; }
      toast('That replay link could not be read', 'warn');
    }
    const code = params.code && !params.code.startsWith('R') ? params.code : null;
    const valid = code ? !!decodeBattle(code) : false;
    if (code && !valid) toast('That battle code could not be read', 'warn');
    if (valid && this.gauntlet) {
      this.keepDraft = false;
      this.resumeGauntlet();
      this.leaveGauntlet(() => { this.tryLoadCode(code!); this.toSetup(false); });
      return;
    }
    if (valid) this.tryLoadCode(code!);
    if (this.gauntlet) this.resumeGauntlet();
    else this.toSetup(!params.code && !this.keepDraft);
    this.keepDraft = false;
  }

  exit() {
    holdRewards(false);
    audio.setIntensity(0.3);
    this.clearCoach();
    // Leaving mid-countdown or mid-load: anything still awaiting sees a new phase and session.
    this.phase = 'setup';
    this.buildToken++;
    this.session?.pause();
    this.session = null;
    this.chain = null;
    this.paused = false;
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
    this.scene.remove(this.view.group);
    this.view.dispose();
    this.clearGhosts();
    hideTooltip();
    this.root.remove();
    this.replay = null;
    dismissConfirms();
    // A run whose card never answered Go was never started.
    if (document.querySelector('.gauntlet-intro')) this.dropUnstartedGauntlet();
    document.querySelectorAll('.debrief-back, .gauntlet-back, .gauntlet-intro, .slot-editor').forEach((n) => n.remove());
    this.forfeitIfEngaged();
  }

  resize(_w: number, hgt: number) {
    this.view?.fx.setScale(hgt, this.camera.fov);
    // A phone turned mid-fight: the decks stand apart only while it is upright (buildBoard).
    if (this.view && this.phase !== 'setup' && this.view.set.layTiers(FIELD.compact && portraitField() ? TIER_STRETCH : 1)) this.view.restand();
    this.fitCamera();
    // A phone turned in setup: the ship bar moves between the sheet and the field, a picker of the
    // other kind (sheet or popover) closes, and the TV strip folds or opens to match.
    if (this.phase === 'setup' && this.root?.isConnected) {
      const sheet = matchMedia(TABBAR_QUERY).matches;
      const ed = this.root.querySelector('.slot-editor');
      if (ed && ed.classList.contains('sheet') !== sheet) { if (this.editorClose) this.editorClose(); else this.root.querySelectorAll('.slot-editor, .slot-scrim').forEach((n) => n.remove()); }
      if (!!this.root.querySelector('.action-bar.in-sheet') !== sheet && (this.selected || this.bayCursor)) this.renderActionBar();
      else this.syncSlim();
    }
  }

  /** Build the board on the deck this view wants (compact on an upright phone), framed to match. */
  private buildBoard(chain: Chain) {
    // Compact on an upright phone, and in setup on a narrow screen (the TV's 640×480), where the
    // setup panel leaves the board a narrow strip; a fight there is short of height, not width.
    const compact = portraitField() || (this.phase === 'setup' && window.innerWidth <= 760);
    // An upright phone's fight stands its battlegrounds further apart, to fill the tall field (setup
    // keeps the regular decks: its board shares the screen with the setup sheet).
    const stretched = this.view.set.layTiers(compact && portraitField() && this.phase !== 'setup' ? TIER_STRETCH : 1);
    if (compact !== FIELD.compact || stretched) { FIELD.compact = compact; this.fitCamera(); }
    return this.view.build(chain, YOU.id);
  }

  /* Fit the board into the part of the viewport no panel covers: a side
   * panel shifts the projection centre (view offset), the HUD bands shrink
   * the usable height. */
  private fitDist = 47;
  /** Phase changes (setup, deploy, replay) also frame the whole board again; a window resize keeps the zoom. */
  private fitCamera(resetZoom = false) {
    if (resetZoom) this.zoom.reset();
    const w = window.innerWidth, hgt = window.innerHeight;
    // A short narrow screen (the Dreamcast's 640×480, a small laptop window), or a phone on its side
    // (short and touch, however wide), keeps the setup panel at the side and the HUD in two thin
    // bands, as the stylesheet lays them out. A desktop mouse never counts as the phone.
    const coarse = matchMedia('(pointer: coarse)').matches;
    const short = (w <= 760 || coarse) && hgt <= 560;
    const side = this.phase === 'setup' ? (short ? (this.slimSetup ? SLIM_SIDE : 316) : w > 760 ? 346 : 0) : 0;
    // The battle log docks on the right from 1100px up, when it shows (always in a replay).
    const right = this.phase !== 'setup' && w > 1100 && (this.showLog || this.phase === 'replay') ? 300 : 0;
    const usableW = w - side - right;
    const narrow = w <= 760;
    const compact = narrow || short;
    // On a phone the setup sheet covers the lower 55%: fit the board above it.
    // (The short layouts are slim rows: about 185 px of HUD and bar on the TV, 172 on a phone on its side.)
    // An upright phone's bottom bar of hubs (mobile.css, the same query) shows during setup; a fight
    // hides it. (Asked of the screen, not the CSS variable: that still reads 0 while a fight's HUD
    // is on its way out.)
    const tab = this.phase === 'setup' && matchMedia(TABBAR_QUERY).matches ? 64 : 0;
    const hud = this.phase === 'setup' ? (narrow && !short ? hgt * 0.55 + 50 + tab : 60) : compact ? (short ? (coarse && hgt <= 450 ? 176 : 188) : 360) : 300;
    const usableH = Math.max(160, hgt - hud);
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    // A phone held upright is short of width, not height: frame the field closer. On the compact
    // deck (env.ts FIELD) the Command Ships sit at ±13.25 in a staggered line and the hulls draw nearly twice as big.
    const halfW = (narrow && !short) || (FIELD.compact && this.phase === 'setup') ? fieldHalfWidth() : 26.5, halfH = (this.view?.set.tiers.space ?? 7.8) + 4;
    const distW = halfW / (t * (usableW / hgt));
    const distH = halfH / (t * (usableH / hgt));
    this.fitDist = Math.max(distW, distH, 34);
    if (side) this.camera.setViewOffset(w, hgt, -side / 2, -14, w, hgt);
    else if (narrow && !short && this.phase === 'setup') this.camera.setViewOffset(w, hgt, 0, hgt / 2 - (44 + hgt * 0.45 - tab) / 2, w, hgt);
    // A tall phone frames the field a little high, toward the HUD, leaving the action bar room below.
    else if (this.phase !== 'setup') this.camera.setViewOffset(w, hgt, right / 2, compact ? (short ? -10 : 34) : -12, w, hgt);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /* ── Setup ────────────────────────────────────────────────────────────── */
  private toSetup(reroll = true) {
    holdRewards(false);
    this.clearAim();
    if (this.gauntlet?.over) this.gauntlet = null;
    this.replay = null;
    this.root.querySelector('.replay-bar')?.remove();
    this.phase = 'setup';
    this.paused = false;
    this.view.paused = false;
    audio.setIntensity(0.3);
    this.fitCamera(true);
    this.session?.pause();
    this.session = null;
    this.chain = null;
    this.selected = null;
    this.bayCursor = null;
    this.pendingCursor = null;
    this.boardKeys = false;
    this.coachDirty = false;
    this.targeting = null;
    this.held = null;
    document.querySelectorAll('.debrief-back, .banner').forEach((n) => n.remove());
    this.clearCoach();
    this.forfeitIfEngaged();
    if (this.daily) {
      // The daily's fleets are fixed: restore them if anything (a reroll, a replay link) replaced
      // them; guard assignments made in setup are kept. A new UTC day brings a new daily.
      if (this.daily.key !== dailyKey()) { this.daily = dailyScenario(); this.difficulty = this.daily.difficulty; this.seed = this.daily.seed; this.draft = []; }
      const d = this.daily;
      const same = this.draft.length === d.units.length && d.units.every((u) => this.draft.some((x) => x.id === u.id && x.type === u.type && x.ambit === u.ambit && x.health === u.health));
      if (!same) this.draft = d.units.map((u) => ({ ...u }));
      this.difficulty = d.difficulty;
      this.seed = d.seed;
      // One pace for everyone: the computer's reaction is in seconds, so pace changes its strength.
      this.blockMs = 2000;
    } else if ((reroll || !this.draft.length) && !this.gauntlet) {
      this.draft = layout(this.preset, this.seed);
      // A ladder move keeps your own fleet: only the enemy's side is new.
      if (this.carryFleet?.length) this.draft = [...this.carryFleet, ...this.draft.filter((u) => u.side === 'computer')];
    }
    this.carryFleet = null;
    this.renderSetup();
    void this.buildPreview();
  }

  private async buildPreview() {
    const token = ++this.buildToken;
    const { setup, idMap } = chainSetup(this.draft, this.seed, { player: 9, computer: 9 });
    const chain = new Chain(setup);
    const reverse = Object.fromEntries(Object.entries(idMap).map(([k, v]) => [v, k]));
    this.preview = { chain, idMap, reverse };
    const world = hash32('world:' + this.seed + (this.gauntlet ? ':' + this.gauntlet.round : ''));
    this.view.set.setWorld({ palette: WORLD_PALETTES[world % WORLD_PALETTES.length], seed: (world % 997) / 37 });
    await this.buildBoard(chain);
    if (token !== this.buildToken) return;
    this.buildGhosts();
    // A pad's (or keys') pick keeps the cursor on its slot: the new ship, or the bay it emptied.
    const pc = this.pendingCursor;
    this.pendingCursor = null;
    if (pc && this.phase === 'setup') {
      const sid = pc.unitId ? idMap[pc.unitId] : undefined;
      if (sid) { this.selected = sid; this.bayCursor = null; } else { this.selected = null; this.bayCursor = { ambit: pc.ambit, slot: pc.slot }; }
    }
    if (this.bayCursor && !this.ghosts.children.some((m) => m.userData.ghost?.ambit === this.bayCursor!.ambit && m.userData.ghost?.slot === this.bayCursor!.slot)) this.bayCursor = null;
    this.paintBayCursor();
    this.refreshSelectionVisuals();
    // Outnumbered for the first time: one step points at a + bay ("Add ships").
    if (this.phase === 'setup' && this.outnumbered() && this.emptyBays().length && (this.fillPrompt || !this.coachSeen('fill')) && !this.coachEl?.isConnected) {
      this.coach('fill', 'Add ships', { pad: 'Press A on +, or a + bay', keys: 'Click a + bay', touch: 'Tap a + bay' }, true, this.fillPrompt);
      this.fillPrompt = false;
      this.paintFillMark();
    }
    if (this.fillAfterBuild && this.phase === 'setup') { this.fillAfterBuild = false; this.fillBay(); }
    // The card reads the preview chain (guards, wards): redraw it from the new one.
    if (this.phase === 'setup') this.renderActionBar();
  }

  private clearGhosts() {
    // Ghost geometry and materials are shared (GHOST below), so clearing only detaches.
    for (const g of [...this.ghosts.children]) this.ghosts.remove(g);
    this.dropGhostHover();
  }
  /** The empty frame under the mouse in setup: it swells a little, and the cursor says "click". */
  private ghostHover: THREE.Object3D | null = null;
  /** The mouse left the frame (or the frames went): back to its size, and the cursor to an arrow. */
  private dropGhostHover() {
    if (!this.ghostHover) return;
    this.ghostHover.scale.setScalar(this.isCursorBay(this.ghostHover) ? 1.25 : 1);
    this.ghostHover = null;
    if (!this.hovered) this.engine.canvas.style.cursor = 'default';
  }

  /* ── Setup with a pad or keys: the board cursor ─────────────────────────
   * The cursor is your selected ship or an empty bay (lit orange). The d-pad walks the bays and your
   * ships (and off the left edge, back to the panel); A (Enter) opens the ship picker there; X (G)
   * sets a guard; B (Escape) goes back to the panel. START (Space) or the Start button fights. */
  private bayCursor: { ambit: Ambit; slot: number } | null = null;
  /** Where the cursor lands once the picker's change is on the board (the preview rebuilds first). */
  private pendingCursor: { unitId: string | null; ambit: Ambit; slot: number } | null = null;
  private isCursorBay(m: THREE.Object3D) { const g = m.userData.ghost, b = this.bayCursor; return !!b && !!g && g.ambit === b.ambit && g.slot === b.slot; }
  private paintBayCursor() {
    const base = this.gauntlet || this.daily ? GHOST.lockedMat : GHOST.mat;
    for (const m of this.ghosts.children as THREE.Mesh[]) {
      const on = this.isCursorBay(m);
      m.material = on ? GHOST.focusMat : base;
      if (m !== this.ghostHover) m.scale.setScalar(on ? 1.25 : 1);
    }
  }
  /** Your ships and the editable bays, where they are on screen. */
  private boardCells() {
    const out: { ship?: string; bay?: { ambit: Ambit; slot: number }; x: number; y: number }[] = [];
    const c = this.preview?.chain;
    if (!c) return out;
    for (const st of Object.values(c.structs)) if (st.owner === YOU.id) { const p = this.view.screenOf(st.id); if (p) out.push({ ship: st.id, x: p.x, y: p.y }); }
    if (!this.gauntlet && !this.daily) for (const m of this.ghosts.children) {
      const g = m.userData.ghost as { ambit: Ambit; slot: number } | undefined;
      if (!g) continue;
      const v = m.getWorldPosition(new THREE.Vector3()).project(this.camera);
      out.push({ bay: g, x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight });
    }
    return out;
  }
  private cursorCell(cells = this.boardCells()) {
    const b = this.bayCursor, s = this.selectedStruct();
    return cells.find((x) => (b && x.bay && x.bay.ambit === b.ambit && x.bay.slot === b.slot) || (!b && s && s.owner === YOU.id && x.ship === s.id)) || null;
  }
  private onBoard() { const s = this.selectedStruct(); return this.phase === 'setup' && (!!this.bayCursor || (!!s && s.owner === YOU.id)); }
  /** The nearest cell in a direction from a point (straight ahead beats off to the side, as pad.ts does). */
  private nearestCell(from: { x: number; y: number }, key: string, skip?: object | null) {
    const [dx, dy] = key === 'ArrowUp' ? [0, -1] : key === 'ArrowDown' ? [0, 1] : key === 'ArrowLeft' ? [-1, 0] : [1, 0];
    let best: ReturnType<BattleScreen['boardCells']>[number] | null = null, bestScore = Infinity;
    for (const cell of this.boardCells()) {
      if (skip && ((cell.ship && cell.ship === (skip as { ship?: string }).ship) || (cell.bay && cell.bay === (skip as { bay?: unknown }).bay))) continue;
      const x = cell.x - from.x, y = cell.y - from.y, along = x * dx + y * dy;
      if (along <= 4) continue;
      const score = along + 2 * Math.abs(x * dy - y * dx);
      if (score < bestScore) { bestScore = score; best = cell; }
    }
    return best;
  }
  private cursorTo(cell: { ship?: string; bay?: { ambit: Ambit; slot: number } }) {
    audio.play('hover');
    this.boardKeys = true;
    if (cell.ship) { this.select(cell.ship); return; }
    this.select(null);
    this.bayCursor = cell.bay!;
    this.paintBayCursor();
    this.renderActionBar();
  }
  /** A d-pad step on the board; false when there is nothing that way. */
  private moveBoard(key: string) {
    const cur = this.cursorCell();
    const next = cur && this.nearestCell(cur, key, cur);
    if (!next) return false;
    this.cursorTo(next);
    return true;
  }
  /** Onto the board from the panel (or from nothing): the cell nearest the panel's right edge. */
  private enterBoard(from: DOMRect | null) {
    const origin = from ? { x: from.right, y: from.top + from.height / 2 } : { x: 0, y: window.innerHeight / 2 };
    const cell = this.nearestCell(origin, 'ArrowRight') || this.boardCells()[0];
    if (!cell) return false;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.cursorTo(cell);
    return true;
  }
  /** The pad's (or keys') cursor drawn big over the board, where a 480-line screen can see it: a
   * bouncing ▼ over a filled orange plate on an empty bay, a ▼ over your selected ship, and while
   * aiming a ▼ and an orange ring on the picked target (the other targets keep their plain brackets). */
  private cursorEl: HTMLElement | null = null;
  private cursorV = new THREE.Vector3();
  private paintCursor() {
    let at: { x: number; y: number } | null = null, mode = '';
    const toScreen = (v: THREE.Vector3) => { v.project(this.camera); return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight }; };
    const unitAt = (id: string) => { const u = this.view.units.get(id); return u ? toScreen(this.cursorV.copy(u.center())) : null; };
    if (this.phase === 'setup' && this.boardKeys && !this.targeting) {
      const bay = this.bayCursor ? this.ghosts.children.find((m) => this.isCursorBay(m)) : null;
      const s = this.selectedStruct();
      if (bay) { at = toScreen(bay.getWorldPosition(this.cursorV)); mode = 'bay'; }
      else if (!this.bayCursor && s && s.owner === YOU.id && !this.targeting) { at = unitAt(s.id); mode = 'ship'; }
    } else if ((this.phase === 'battle' || this.phase === 'setup') && this.targeting) {
      const id = this.aimId || (this.dockAim() ? this.hovered : null);
      if (id && this.validTargets().has(id)) { at = unitAt(id); mode = 'aim' + (this.targeting.kind === 'guard' ? ' guard' : ''); }
    }
    if (!at) { if (this.cursorEl) this.cursorEl.style.display = 'none'; return; }
    if (!this.cursorEl?.isConnected) {
      this.cursorEl = h('div', { class: 'dc-cursor', 'aria-hidden': 'true' }, h('i', { class: 'dc-cursor-mark' }), h('b', { class: 'dc-cursor-arrow' }, '▼'));
      this.root.appendChild(this.cursorEl);
    }
    const cls = 'dc-cursor ' + mode;
    if (this.cursorEl.className !== cls) this.cursorEl.className = cls;
    this.cursorEl.style.display = '';
    this.cursorEl.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
  }

  /** The "Add ships" step's anchor: a point on the first empty bay, kept on it as the camera sways. */
  private fillMark: HTMLElement | null = null;
  private paintFillMark() {
    const on = this.phase === 'setup' && this.coachKey === 'fill' && !!this.coachEl?.isConnected;
    const bay = on ? this.emptyBays()[0] : null;
    const m = bay && this.ghosts.children.find((x) => x.userData.ghost?.ambit === bay.ambit && x.userData.ghost?.slot === bay.slot);
    if (!m) { this.fillMark?.remove(); this.fillMark = null; return; }
    if (!this.fillMark?.isConnected) { this.fillMark = h('div', { class: 'dc-fill-mark', 'aria-hidden': 'true' }); this.root.appendChild(this.fillMark); }
    const v = m.getWorldPosition(new THREE.Vector3()).project(this.camera);
    const x = Math.round((v.x + 1) / 2 * window.innerWidth), y = Math.round((1 - v.y) / 2 * window.innerHeight);
    const was = this.fillMark.dataset.at;
    this.fillMark.style.transform = `translate(${x - 22}px, ${y - 22}px)`;
    this.fillMark.dataset.at = x + ',' + y;
    // The callout follows the bay (only when it has really moved).
    if (was) { const [px, py] = was.split(',').map(Number); if (Math.abs(px - x) + Math.abs(py - y) > 6) this.placeCoach(); } else this.placeCoach();
  }

  /** The setup panel's nearest control in a direction (straight ahead beats off to the side), or null. */
  private panelStep(panel: HTMLElement, from: HTMLElement, key: string): HTMLElement | null {
    const [dx, dy] = key === 'ArrowUp' ? [0, -1] : key === 'ArrowDown' ? [0, 1] : key === 'ArrowLeft' ? [-1, 0] : [1, 0];
    const r0 = from.getBoundingClientRect(), cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    let best: HTMLElement | null = null, bestScore = Infinity;
    for (const el of panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')) {
      if (el === from || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > window.innerHeight) continue;
      const x = r.left + r.width / 2 - cx, y = r.top + r.height / 2 - cy, along = x * dx + y * dy, side = Math.abs(x * dy - y * dx);
      // Only what lies that way (a 45° cone): Right from Start is the board, not the Daily tile above it.
      if (along <= 4 || side > along) continue;
      const score = along + 2 * side;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  /** Back to the panel: nothing selected, the cursor on Start. */
  private leaveBoard() {
    this.select(null);
    this.root.querySelector<HTMLElement>('.setup-panel .dc-start')?.focus({ focusVisible: true } as FocusOptions);
    audio.play('hover', 0.6);
  }
  /** A (Enter) on the cursor: the ship picker for that bay, or to swap that ship. */
  private editAtCursor() {
    if (this.phase !== 'setup') return;
    if (this.gauntlet || this.daily) { audio.play('deny'); toast(this.gauntlet ? 'Gauntlet fleets grow only through reinforcements' : 'The daily fleet is the same for everyone', 'warn', 1600); return; }
    const cell = this.cursorCell();
    const at = cell ? { x: cell.x + 28, y: cell.y - 40 } : { x: window.innerWidth / 2, y: 80 };
    const keys = inputMode() !== 'touch';
    audio.play('select');
    if (this.bayCursor) { this.openSlotEditor(this.bayCursor.ambit, this.bayCursor.slot, null, at, keys); return; }
    const s = this.selectedStruct();
    const du = s && s.owner === YOU.id ? this.draftUnit(s.id) : undefined;
    if (du) this.openSlotEditor(du.ambit, du.slot, du, at, keys);
  }

  /* Empty player slots during setup: clickable frames to add a struct. Each shows a breathing "+";
   * a gauntlet's or a daily's fleet is fixed, so its empty frames show no "+" (and stay dim). */
  private buildGhosts() {
    this.clearGhosts();
    if (this.phase !== 'setup') return;
    const mat = this.gauntlet || this.daily ? GHOST.lockedMat : GHOST.mat;
    // Outnumbered: the "+" in every empty bay beats louder.
    GHOST.mat.uniforms.uBoost.value = this.outnumbered() ? 1 : 0;
    for (const ambit of AMBITS) {
      for (let slot = 0; slot < 4; slot++) {
        if (this.draft.some((u) => u.side === 'player' && u.type !== COMMAND_SHIP_ID && u.ambit === ambit && u.slot === slot)) continue;
        const m = new THREE.Mesh(GHOST.plate, mat);
        m.renderOrder = 3;
        const T = this.view.set.tiers;
        const y = ambit === 'land' ? T.land - 0.85 : ambit === 'water' ? T.water - 1.0 : T[ambit] - 0.2;
        const [lift, depth] = slotStagger(slot, false, ambit);
        m.position.set(slotX('player', slot, false), y + lift, depth);
        m.userData.ghost = { ambit, slot };
        const pick = new THREE.Mesh(GHOST.pick, GHOST.pickMat);
        pick.userData.ghost = { ambit, slot };
        m.add(pick);
        this.ghosts.add(m);
      }
    }
  }

  private renderSetup() {
    // The cursor's place in the panel survives the repaint (each control has a data-k key).
    const was = document.activeElement as HTMLElement | null;
    const keyWas = was?.closest?.('.setup-panel') ? was.dataset.k || null : null;
    this.root.querySelectorAll('.battle-hud, .setup-panel, .action-bar, .battle-log, .battle-top').forEach((n) => n.remove());
    // Dreamcast setup: the enemy's size as big numbers, the challenges as tiles, one word each.
    // Everything else (what a mode is, how to edit a fleet) is a hover away in the title.
    // Counted as the versus strip and the HUD count them (their Command Ship too), and sized in words,
    // so "Easy" only ever means the computer's skill.
    const presetBtns = PRESETS.map((p) => h('button', {
      class: 'btn choice dc-size' + (p.id === this.preset && !this.scenario && !this.gauntlet && !this.daily ? ' active' : ''), 'data-k': 'size:' + p.id, title: `${p.name}: ${p.enemy} enemy ships and their Command Ship. ${p.note}`,
      onclick: () => this.leaveGauntlet(() => { audio.play('select'); this.preset = p.id; this.scenario = null; this.daily = null; this.difficulty = DIFFICULTY_FOR[p.id]; this.seed = Math.random().toString(36).slice(2, 8); this.toSetup(true); }),
    }, h('span', { class: 'dc-size-n' }, p.id === 'random' ? '?' : String(Number(p.enemy) + 1)), h('span', { class: 'sub' }, SIZE_WORD[p.id])));
    const diffBtns = (['easy', 'difficult', 'hard'] as Difficulty[]).map((d) => h('button', {
      class: 'btn choice small' + (d === this.difficulty ? ' active' : ''), 'data-k': 'skill:' + d, disabled: (!!this.gauntlet || !!this.daily) && d !== this.difficulty,
      title: this.gauntlet ? 'Set by the gauntlet round' : this.daily ? 'Set by the daily engagement' : 'Computer skill',
      'aria-label': `Computer skill: ${cap(d)}`,
      onclick: () => { audio.play('select'); this.difficulty = d; this.renderSetup(); },
    }, '★'.repeat(d === 'easy' ? 1 : d === 'difficult' ? 2 : 3)));
    const blockBtns = [{ ms: 2000, name: '2 s', note: 'Quick turns' }, { ms: 6000, name: '6 s', note: 'Real game speed' }].map((b) => h('button', {
      class: 'btn choice small' + (b.ms === this.blockMs ? ' active' : ''), 'data-k': 'pace:' + b.ms, disabled: (!!this.gauntlet || !!this.daily) && b.ms !== this.blockMs, title: b.note,
      onclick: () => { audio.play('select'); this.blockMs = b.ms; this.renderSetup(); },
    }, h('span', { html: icon('clock', 16) }), b.name));
    const err = validate(this.draft);
    const youCount = this.draft.filter((u) => u.side === 'player').length;
    const cpuCount = this.draft.filter((u) => u.side === 'computer').length;
    const g = this.gauntlet;

    const panel = h('div', { class: 'setup-panel panel player' },
      h('div', { class: 'panel-body col setup-body scroll' },
        h('div', { class: 'dc-setup-head' }, h('span', { class: 'dc-setup-ico', html: icon('target', 30) }), h('span', { class: 't-display' }, g ? `Round ${g.round}/5` : this.daily ? this.daily.name.replace(/^Operation /, '') : 'Battle')),
        this.scenario ? h('div', { class: 'scenario', title: 'Fleets as they really were: ship types, layers, guards and damage' }, h('span', { html: icon('replay', 16) }), h('span', null, this.scenario)) : null,
        h('div', { class: 'dc-size-row', title: 'How big is the enemy fleet?' }, h('span', { class: 'c-enemy', html: icon('ship', 18) }), h('div', { class: 'choice-grid dc-sizes' }, presetBtns)),
        h('div', { class: 'dc-challenges' },
          h('button', { class: 'btn choice gauntlet' + (g ? ' active' : ''), 'data-k': 'gauntlet', title: g ? `${GAUNTLET_ROUNDS[g.round - 1].name}: ships you lose stay lost, damage carries over, a win earns a new ship` : 'Gauntlet: five battles in a row. Ships you lose stay lost.',
            onclick: () => { if (g) return; audio.play('select'); this.startGauntlet(); } },
            h('span', { class: 'dc-ch-ico', html: icon('flag', 26) }), h('span', null, 'Gauntlet'), h('span', { class: 'sub dc-pips', 'aria-label': `best ${this.gauntletBest()} of 5` }, ...[1, 2, 3, 4, 5].map((i) => h('i', { class: i <= (g ? g.round - 1 : this.gauntletBest()) ? 'on' : '' })))),
          this.dailyButton()),
        // The finer controls fold away behind a gear: a first battle needs only a fleet size and Start.
        h('button', { class: 'setup-more' + (this.moreOpts ? ' open' : ''), 'data-k': 'more', 'aria-expanded': this.moreOpts ? 'true' : 'false', 'aria-label': 'More options', title: `${cap(this.difficulty)} computer · ${this.spectate ? 'autopilot' : 'you fly'} · ${this.blockMs / 1000} s turns`,
          onclick: () => { audio.play('select'); this.moreOpts = !this.moreOpts; this.renderSetup(); if (this.moreOpts) this.root.querySelector('.setup-more-body')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } },
          // The summary in pictures: the computer's stars, a hand (you fly) or a robot (autopilot), the turn clock.
          h('span', { html: icon('gear', 18) }), h('span', { class: 'setup-more-sum', 'aria-hidden': 'true' },
            h('span', { class: 'sm-part sm-stars' }, ...Array.from({ length: this.difficulty === 'easy' ? 1 : this.difficulty === 'difficult' ? 2 : 3 }, () => h('span', { html: icon('star', 14) }))),
            h('span', { class: 'sm-part sm-who', html: this.spectate ? icon('robot', 18) : HAND(18) }),
            h('span', { class: 'sm-part sm-pace' }, h('span', { html: icon('clock', 15) }), `${this.blockMs / 1000}s`)),
          // It opens: the chevron says so (and turns when it has).
          h('span', { class: 'setup-more-chev', html: icon('down', 16) })),
        this.moreOpts ? h('div', { class: 'col setup-more-body' },
          h('div', { class: 'choice-row', title: 'Computer skill' }, h('span', { class: 'dc-opt-ico', html: icon('robot', 18) }), diffBtns),
          h('div', { class: 'choice-row', title: 'Who flies your fleet' },
            h('span', { class: 'dc-opt-ico', html: icon('ship', 18) }),
            h('button', { class: 'btn choice small' + (!this.spectate ? ' active' : ''), 'data-k': 'who:you', title: 'You fly your fleet', onclick: () => { audio.play('select'); this.spectate = false; this.renderSetup(); } }, h('span', { class: 'sm-who', html: HAND(16) }), 'You'),
            h('button', { class: 'btn choice small' + (this.spectate ? ' active' : ''), 'data-k': 'who:auto', disabled: !!g || !!this.daily, title: g ? 'A gauntlet run is flown, not watched' : this.daily ? 'A daily is flown, not watched' : 'The computer flies both sides', onclick: () => { audio.play('select'); this.spectate = true; this.renderSetup(); } }, h('span', { class: 'sm-who', html: icon('robot', 16) }), 'Auto')),
          h('div', { class: 'choice-row', title: 'Turn length (block time)' }, blockBtns)) : null,
        h('div', { class: 'dc-versus' + (this.outnumbered() ? ' outnumbered' : ''), title: this.daily || g ? 'Your ships are fixed. Select one and press G to change who it guards.' : 'Click one of your ships to swap it, or an empty frame to add one. Select a ship and press G to choose who it guards.' },
          h('span', { class: 'c-player', html: icon('ship', 22) }), h('b', { class: 'c-player' }, String(youCount)),
          h('span', { class: 'dc-vs' }, 'VS'),
          h('b', { class: 'c-enemy' }, String(cpuCount)), h('span', { class: 'c-enemy dc-flip', html: icon('ship', 22) }),
          // Outnumbered with bays to spare: one press adds a ship (the picker opens on the first empty bay).
          this.outnumbered() && this.emptyBays().length ? h('button', { class: 'btn dc-outnumbered', 'data-k': 'add', 'aria-label': `Outnumbered: add a ship (${cpuCount} against ${youCount})`,
            title: `Outnumbered: ${cpuCount} enemy ships against your ${youCount}. Add ships to your empty bays (the + frames): each tap here opens the next one.`,
            onclick: () => { audio.play('select'); this.fillBay(); } }, h('span', { class: 'dc-add-plus' }, '+'), h('span', { class: 'dc-add-w' }, 'Add')) : null),
        err ? h('div', { class: 't-tiny c-enemy' }, err) : null,
        this.recordStrip(),
      ),
      h('div', { class: 'setup-foot row' },
          g ? h('button', { class: 'btn ghost', title: 'Abandon the run', onclick: () => this.leaveGauntlet(() => { audio.play('select'); this.toSetup(true); }) }, h('span', { html: icon('back', 16) }))
            : h('button', { class: 'btn ghost', title: this.daily ? 'Leave the daily' : 'Shuffle both fleets', 'aria-label': this.daily ? 'Leave the daily' : 'New fleets', onclick: () => { audio.play('select'); this.scenario = null; this.daily = null; this.seed = Math.random().toString(36).slice(2, 8); this.toSetup(true); } }, h('span', { html: icon(this.daily ? 'back' : 'dice', 18) })),
          h('button', { class: 'btn solid big grow dc-start', 'data-k': 'start', disabled: !!err, onclick: () => void this.engage() }, face('a', '⏎'), this.spectate ? 'Watch' : 'Start'),
        ),
      h('div', { class: 'keys setup-keys dc-keys' },
        h('span', { title: 'Fire (keys 1 and 2)' }, h('kbd', null, '1'), h('span', { html: icon('target', 16) })), h('span', { title: 'Guard (G)' }, h('kbd', null, 'G'), h('span', { html: icon('shield', 16) })),
        h('span', { title: 'Drift (D)' }, h('kbd', null, 'D'), h('span', { html: icon('trade', 16) })), h('span', { title: 'Next ship (Tab)' }, h('kbd', null, 'Tab'), h('span', { html: icon('ship', 16) })), h('span', { title: 'Pause (Space)' }, h('kbd', null, '␣'), h('span', null, '❚❚'))),
    );
    this.root.appendChild(panel);
    this.els.setup = panel;
    this.renderActionBar();
    // Focus back on the same control; else, with a pad (or a ladder landing that wants ships added), on
    // + Add when outnumbered, or Start: a pad never starts on nothing. Never over the board's own cursor.
    const usable = (e: HTMLElement | null) => !!e && !(e as HTMLButtonElement).disabled && e.getClientRects().length > 0;
    const same = keyWas ? panel.querySelector<HTMLElement>(`[data-k="${keyWas}"]`) : null;
    if (usable(same)) same!.focus({ preventScroll: true });
    else if ((inputMode() === 'pad' || (this.fillPrompt && inputMode() === 'keys')) && !this.onBoard() && !this.pendingCursor && !document.querySelector('.modal-back, .slot-editor')
      && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) {
      const to = panel.querySelector<HTMLElement>('.dc-outnumbered') || panel.querySelector<HTMLElement>('.dc-start');
      if (usable(to)) to!.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
    }
  }

  private scenario: string | null = null;

  private dailyButton() {
    const key = dailyKey();
    const d = this.daily && this.daily.key === key ? this.daily : dailyScenario(key);
    const best = dailyBest(key), streak = dailyStreak(key);
    return h('button', { class: 'btn choice daily' + (this.daily ? ' active' : ''), 'data-k': 'daily', title: [`Daily Challenge: ${d.name}`, `${d.twist.name}: ${d.twist.note}`, best ? 'Best today: ' + describeDaily(best) : 'The same battle for everyone today', `Next in ${untilTomorrow()}`].join('\n'),
      onclick: () => { if (this.daily) return; audio.play('select'); this.startDaily(); } },
      h('span', { class: 'dc-ch-ico', html: icon('daily', 26) }), h('span', null, 'Daily'),
      // Picked, it names today's twist (what makes it different), with its picture. Otherwise the time
      // left on today's battle reads as a countdown: the clock says so.
      this.daily ? h('span', { class: 'sub dc-left dc-twist' }, h('span', { html: icon(TWIST_ICON[d.twist.id] || 'daily', 13) }), d.twist.name)
        : h('span', { class: 'sub dc-left' }, best?.won ? '★' : streak ? `${streak}×` : [h('span', { html: icon('clock', 13) }), untilTomorrow()]));
  }

  private startDaily() {
    this.leaveGauntlet(() => {
      const d = dailyScenario();
      this.daily = d;
      this.scenario = null;
      this.spectate = false;
      this.preset = 'random';
      this.difficulty = d.difficulty;
      this.seed = d.seed;
      this.draft = d.units.map((u) => ({ ...u }));
      this.toSetup(false);
      toast(`${d.name} — ${d.twist.name}`, 'player', 2200);
    });
  }

  private recordStrip() {
    const r = loadRecord();
    if (!r.battles) return null;
    return h('div', { class: 'record-strip dc-record', title: `Service record (this browser): ${r.battles} battles, ${r.kills} kills, ${r.flagships} Command Ships` },
      h('span', { html: icon('record', 16) }), h('span', { class: 'c-player' }, `${r.wins}`), h('span', { class: 'c-hint' }, '–'), h('span', { class: 'c-enemy' }, `${r.losses}`));
  }

  private gauntletBest(): number { try { return Number(localStorage.getItem('structs.gauntlet.best') || 0); } catch { return 0; } }
  private saveGauntletBest(n: number) { try { if (n > this.gauntletBest()) localStorage.setItem('structs.gauntlet.best', String(n)); } catch { /* ignore */ } window.dispatchEvent(new Event('structs:progress')); }

  private startGauntlet() {
    // Back on the intro card puts everything as it was (a daily, a shared battle, the pace, Auto).
    const before = { scenario: this.scenario, daily: this.daily, spectate: this.spectate, blockMs: this.blockMs, difficulty: this.difficulty, draft: this.gauntlet ? null : this.draft.map((u) => ({ ...u })) };
    this.gauntletUndo = () => {
      Object.assign(this, { scenario: before.scenario, daily: before.daily, spectate: before.spectate, blockMs: before.blockMs, difficulty: before.difficulty });
      if (before.draft) this.draft = before.draft;
      return !!before.draft;
    };
    const seed = Math.random().toString(36).slice(2, 8);
    const fleet = layout('difficult', seed).filter((u) => u.side === 'player');
    this.gauntlet = { round: 1, fleet, seed, engaged: false, over: false, fought: 0, reinforce: false };
    this.scenario = null;
    this.daily = null;
    this.spectate = false;        // a run is flown, not watched
    this.blockMs = 2000;
    // A run starts with its rules on one card (the round's own banner waits for Go).
    this.loadGauntletRound(true);
    this.showGauntletIntro();
  }

  /** Undoes a run's start while its intro card is up (Back, or leaving the screen): true if the setup
   * before it came back whole. */
  private gauntletUndo: (() => boolean) | null = null;
  /** Put a run down before it began (its card never answered Go): the setup is as it was. */
  private dropUnstartedGauntlet(): boolean {
    const undo = this.gauntletUndo;
    this.gauntletUndo = null;
    this.gauntlet = null;
    return undo ? undo() : false;
  }

  /** The gauntlet's rules, once per run: five rounds, wounds carry over, a boss at the end. Go (A,
   * Enter) starts round 1's setup; Back (B, Escape) puts the run down before it begins. */
  private showGauntletIntro() {
    document.querySelectorAll('.gauntlet-intro').forEach((n) => n.remove());
    const g = this.gauntlet;
    if (!g) return;
    const boss = GAUNTLET_ROUNDS[GAUNTLET_ROUNDS.length - 1];
    const close = (go: boolean) => {
      if (!back.isConnected) return;
      back.remove();
      window.removeEventListener('keydown', key, true);
      if (this.gauntlet !== g || !this.root.isConnected) return;
      audio.play(go ? 'confirm' : 'select');
      if (!go) { this.toSetup(!this.dropUnstartedGauntlet()); return; }
      this.gauntletUndo = null;
      const r = GAUNTLET_ROUNDS[g.round - 1];
      banner(`ROUND ${g.round}`, `GAUNTLET · ${r.name.toUpperCase()}`, 'neutral', 1600);
      if (inputMode() === 'pad') requestAnimationFrame(() => this.root.querySelector<HTMLElement>('.dc-start')?.focus({ focusVisible: true } as FocusOptions));
    };
    const key = (e: KeyboardEvent) => {
      if (!back.isConnected) { window.removeEventListener('keydown', key, true); return; }
      const modals = document.querySelectorAll('.modal-back');
      if (modals[modals.length - 1] !== back) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(false); return; }
      // A held Enter (the one that picked the tile) mustn't also answer the card.
      if (e.key === 'Enter' && e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      // Enter on a button presses that button; anywhere else it is Go.
      if (e.key === 'Enter' && !(document.activeElement instanceof HTMLButtonElement && back.contains(document.activeElement))) { e.preventDefault(); e.stopImmediatePropagation(); close(true); }
    };
    const row = (cls: string, title: string, lead: Node, word: string, extra?: Node) =>
      h('div', { class: 'dc-gi-row ' + cls, title }, h('span', { class: 'dc-gi-lead' }, lead), h('span', { class: 'dc-gi-word' }, word), extra || null);
    const back = h('div', { class: 'modal-back gauntlet-intro', onclick: (e: Event) => { if (e.target === back) close(true); } },
      h('div', { class: 'modal panel neutral dc-gi', role: 'dialog', 'aria-label': 'Gauntlet: five rounds, wounds carry over, a boss at the end' },
        h('div', { class: 'dc-gi-head' }, h('span', { class: 'dc-gi-flag', html: icon('flag', 34) }), h('span', { class: 't-display' }, 'Gauntlet')),
        h('div', { class: 'dc-gi-rows' },
          row('rounds', 'Five battles in a row. Each win sends a new ship.', h('b', null, '5'), 'Rounds', h('span', { class: 'dc-pips' }, ...[1, 2, 3, 4, 5].map(() => h('i')))),
          row('wounds', 'Ships you lose stay lost, and damage carries into the next round', h('span', { html: icon('health', 24) }), 'Wounds carry over'),
          row('boss', `Round 5: the ${boss.name}, a big fleet on ${cap(boss.difficulty)}`, h('span', { html: icon('crown', 24) }), 'Boss at the end')),
        h('div', { class: 'row dc-gi-foot' },
          h('button', { class: 'btn ghost', title: 'Not now', onclick: () => close(false) }, face('b', 'Esc'), 'Back'),
          h('button', { class: 'btn solid big grow', 'data-primary': '', onclick: () => close(true) }, face('a', '⏎'), 'Go!'))));
    document.body.appendChild(back);
    window.addEventListener('keydown', key, true);
    requestAnimationFrame(() => back.querySelector<HTMLElement>('[data-primary]')?.focus({ preventScroll: true, focusVisible: inputMode() === 'pad' } as FocusOptions));
  }

  /** Back to the run: owe a reinforcement pick first, then the next round's setup. */
  private resumeGauntlet() {
    const g = this.gauntlet;
    if (!g || g.over) { this.gauntlet = null; this.toSetup(true); return; }
    if (g.reinforce) this.showReinforcements(() => { g.reinforce = false; this.loadGauntletRound(); });
    else this.loadGauntletRound();
  }

  /* Leaving a round mid-fight ends the run — no free retries. */
  private forfeitIfEngaged() {
    const g = this.gauntlet;
    if (!g || !g.engaged) return;
    g.engaged = false;
    this.saveGauntletBest(g.round - 1);
    this.gauntlet = null;
    toast(`Gauntlet run ended in round ${g.round}`, 'warn', 3000);
  }

  /** Run `then` after confirming that a live gauntlet run may be abandoned. */
  private leaveGauntlet(then: () => void) {
    if (!this.gauntlet || this.gauntlet.over) { this.gauntlet = null; then(); return; }
    void confirmBox('Abandon run', `Abandon the gauntlet at round ${this.gauntlet.round}? Your best stays ${this.gauntletBest()}/5.`, 'Abandon').then((yes) => {
      if (!yes) return;
      this.gauntlet = null;
      document.querySelectorAll('.gauntlet-back').forEach((n) => n.remove());
      then();
    });
  }

  private loadGauntletRound(quiet = false) {
    const g = this.gauntlet!;
    g.engaged = false;
    const r = GAUNTLET_ROUNDS[g.round - 1];
    this.difficulty = r.difficulty;
    this.draft = [...g.fleet.map((u) => ({ ...u })), ...gauntletEnemy(g.round, g.seed)];
    this.toSetup(false);
    if (!quiet) banner(`ROUND ${g.round}`, `GAUNTLET · ${r.name.toUpperCase()}`, 'neutral', 1600);
  }

  /** After a won round: survivors keep their wounds; dead hulls stay dead. */
  private carryOver() {
    const g = this.gauntlet!, chain = this.chain!;
    const alive = new Set<string>();
    g.fleet = this.draft.filter((u) => u.side === 'player').flatMap((u) => {
      const s = chain.structs[this.liveIdMap[u.id]];
      if (!s || chain.isDestroyed(s)) return [];
      alive.add(u.id);
      return [{ ...u, ambit: s.ambit, slot: s.slot, health: s.health }];
    });
    for (const u of g.fleet) if (u.protects && !alive.has(u.protects)) u.protects = null;
  }

  private showReinforcements(onDone: () => void) {
    // One picker at a time (Enter or a re-entry must not open a second, which would grant two picks).
    if (document.querySelector('.gauntlet-back')) return;
    const g = this.gauntlet!;
    const offers = reinforcementOffers(g.fleet, g.seed + ':r' + g.round);
    const cmd = g.fleet.find((u) => u.type === COMMAND_SHIP_ID);
    // The run may have been abandoned while the picker was open: then the pick does nothing.
    const choose = (f: () => void) => { audio.play('confirm'); back.remove(); if (this.gauntlet !== g || !g.reinforce) return; f(); if (this.root.isConnected) onDone(); };
    const cards = offers.map((o) => {
      const t = TYPES_BY_ID[o.type];
      const img = h('img', { alt: '' });
      void spriteDataUrl(o.type).then((u) => { img.src = u; });
      return h('button', { class: 'reward', onclick: () => choose(() => { g.fleet.push({ id: unitId('player', o.type, o.ambit, o.slot), side: 'player', type: o.type, ambit: o.ambit, slot: o.slot, protects: null }); }) },
        h('div', { class: 'sprite big player' }, img), h('div', { class: 't-label c-player' }, t.type), h('div', { class: 't-tiny c-hint' }, `${AMBIT_NAME[o.ambit]} · ${roleOf(t)}`));
    });
    if (cmd && (cmd.health ?? 6) < 6) {
      // A hurt Command Ship's repair comes first: it is the card the cursor starts on.
      cards.unshift(h('button', { class: 'reward', onclick: () => choose(() => { cmd.health = undefined; }) },
        h('div', { class: 'reward-icon' }, '✚'), h('div', { class: 't-label c-player' }, 'Repair Command Ship'), h('div', { class: 't-tiny c-hint' }, `Command Ship back to full hull (now ${cmd.health}/6)`)));
    }
    const back = h('div', { class: 'modal-back gauntlet-back' }, h('div', { class: 'modal panel neutral', style: 'width:min(640px, calc(100vw - 32px))' },
      h('div', { class: 'panel-head', title: 'Command sends one reinforcement before the next engagement' }, h('span', { class: 't-label' }, `Round ${g.fought} won`), h('span', { class: 'chip warn' }, 'Pick one')),
      h('div', { class: 'panel-body col' },
        h('div', { class: 'reward-row' }, cards.length ? cards : h('div', { class: 't-tiny c-hint' }, 'No free slot for a reinforcement — your fleet is full.')),
        cards.length ? null : h('button', { class: 'btn solid', onclick: () => { back.remove(); if (this.gauntlet === g && g.reinforce) onDone(); } }, 'Continue'))));
    document.body.appendChild(back);
    // The cursor starts on a card, so Enter (or a pad's A) picks and the d-pad walks the others.
    requestAnimationFrame(() => back.querySelector<HTMLElement>('.reward, .btn.solid')?.focus({ preventScroll: true, focusVisible: document.body.classList.contains('pad') } as FocusOptions));
  }

  private tryLoadCode(code: string) {
    const c = decodeBattle(code);
    if (!c) { toast('That battle code could not be read', 'warn'); return; }
    this.draft = c.units;
    if (c.difficulty) this.difficulty = c.difficulty;
    if (c.blockMs) this.blockMs = c.blockMs;
    this.scenario = c.title || 'Shared battle';
    this.daily = null;
    this.preset = 'random';
  }

  private battleCode() {
    return encodeBattle({ units: this.draft, difficulty: this.difficulty, blockMs: this.blockMs, title: this.scenario || undefined });
  }

  /* Fleet editor popover for a player slot. `keys`: opened by a pad or the keyboard, so the cursor
   * starts on an option, the d-pad (arrows) walks them, A (Enter) picks, B (Escape) closes, and the
   * board cursor stays on the slot afterwards. */
  private openSlotEditor(ambit: Ambit, slot: number, existing: Unit | null, at: { x: number; y: number }, keys = false, returnTo: string | null = null) {
    document.querySelectorAll('.slot-editor, .slot-scrim').forEach((n) => n.remove());
    const isCmd = existing?.type === COMMAND_SHIP_ID;
    // Ships that can strike their Command Ship's layer from this bay come first, crowned.
    const theirCs = this.draft.find((u) => u.side === 'computer' && u.type === COMMAND_SHIP_ID);
    const strikesCs = (id: number) => !!theirCs && (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).some((ws) => hasWeapon(TYPES_BY_ID[id], ws) && canTargetAmbit(TYPES_BY_ID[id], ws, ambit, theirCs.ambit));
    const opts = isCmd ? [] : FLEET_TYPES.filter((t) => t.id !== COMMAND_SHIP_ID && fits(t.id, ambit)).sort((a, b) => Number(strikesCs(b.id)) - Number(strikesCs(a.id)));
    // Opened from a panel control (keys or a pad): the cursor goes back there after, not onto the board.
    const back = () => { if (keys && returnTo) requestAnimationFrame(() => (this.root.querySelector<HTMLElement>(returnTo) || this.root.querySelector<HTMLElement>('.setup-panel .dc-start'))?.focus({ focusVisible: true } as FocusOptions)); };
    const close = () => { const was = ed.isConnected; ed.remove(); scrim?.remove(); window.removeEventListener('pointerdown', off, true); if (this.editorClose === close) this.editorClose = null; if (was) { back(); requestAnimationFrame(() => this.placeCoach()); } };
    this.editorClose = close;
    const choose = (typeId: number | null) => {
      audio.play('confirm');
      if (keys && !returnTo) this.pendingCursor = { unitId: typeId != null ? unitId('player', typeId, ambit, slot) : null, ambit, slot };
      // A ship added to an empty bay: the "Add ships" step is done.
      if (typeId != null && !existing) this.coachDone('fill');
      if (existing) this.draft = this.draft.filter((u) => u !== existing);
      // Wards pointing at a removed hull lose their ward.
      if (existing) for (const u of this.draft) if (u.protects === existing.id) u.protects = null;
      if (typeId != null) {
        const nu: Unit = { id: unitId('player', typeId, ambit, slot), side: 'player', type: typeId, ambit, slot, protects: existing?.protects ?? null };
        if (existing) for (const u of this.draft) if (u.protects === existing.id) u.protects = nu.id;
        this.draft.push(nu);
      }
      close();
      this.selected = null;
      this.renderSetup();
      void this.buildPreview();
    };
    const moveCmd = (a: Ambit) => {
      audio.play('confirm');
      if (existing) existing.ambit = a;
      if (keys && existing) this.pendingCursor = { unitId: existing.id, ambit: a, slot: existing.slot };
      close();
      this.renderSetup();
      void this.buildPreview();
    };
    const list = isCmd
      ? AMBITS.map((a) => h('button', { class: 'btn ghost', disabled: existing?.ambit === a, onclick: () => moveCmd(a) }, AMBIT_NAME[a]))
      : opts.map((t) => h('button', { class: 'slot-opt' + (existing?.type === t.id ? ' active' : '') + (strikesCs(t.id) ? ' reaches-cs' : ''), title: strikesCs(t.id) ? `Reaches their Command Ship (in ${AMBIT_NAME[theirCs!.ambit]}) from here` : undefined, onclick: () => choose(t.id) },
        h('img', { class: 'slot-img', alt: '', 'data-type': String(t.id) }), h('span', { class: 'grow' }, h('div', null, t.type), h('div', { class: 't-tiny c-hint' }, roleOf(t))),
        strikesCs(t.id) ? h('span', { class: 'slot-cs', 'aria-label': 'reaches their Command Ship', html: icon('crown', 14) }) : null));
    // On an upright phone the picker is a bottom sheet (dc-battle.css); elsewhere it opens by the slot.
    const sheet = matchMedia(TABBAR_QUERY).matches;
    const ed = h('div', { class: 'slot-editor panel player' + (sheet ? ' sheet' : ''), role: 'dialog', 'aria-label': isCmd ? 'Command Ship layer' : `Pick a ship for ${AMBIT_NAME[ambit]} slot ${slot + 1}`, style: sheet ? undefined : `left:${Math.max(8, Math.min(at.x, window.innerWidth - 300))}px; top:${Math.max(48, Math.min(at.y, window.innerHeight - 380))}px` },
      h('div', { class: 'panel-head' }, h('span', { class: 't-label' }, isCmd ? 'Command Ship layer' : `${AMBIT_NAME[ambit]} · slot ${slot + 1}`), face('b', 'Esc'), h('button', { class: 'btn ghost icon', onclick: close, 'aria-label': 'Close' }, '×')),
      h('div', { class: 'panel-body col scroll', style: sheet ? undefined : 'max-height:320px' }, list,
        existing && !isCmd ? h('button', { class: 'btn danger', onclick: () => choose(null) }, 'Remove ship') : null),
    );
    // The phone's sheet dims the screen behind it with a real backdrop: a tap there closes the sheet and
    // goes no further (it never lands on a size button or a ship under the dimming).
    // (Only a press that began on it counts: the tap that opened the sheet ends in a click that lands here.)
    let pressed = false;
    const scrim = sheet ? h('div', { class: 'slot-scrim', 'aria-hidden': 'true', onpointerdown: (e: Event) => { e.stopPropagation(); e.preventDefault(); pressed = true; }, onclick: (e: Event) => { e.stopPropagation(); if (!pressed) return; audio.play('select'); close(); } }) : null;
    if (scrim) this.root.appendChild(scrim);
    this.root.appendChild(ed);
    ed.querySelectorAll<HTMLImageElement>('img.slot-img').forEach((img) => { void spriteDataUrl(Number(img.dataset.type)).then((u) => { img.src = u; }); });
    function off(e: PointerEvent) { if (!ed.contains(e.target as Node) && !scrim?.contains(e.target as Node)) close(); }
    setTimeout(() => { if (ed.isConnected) window.addEventListener('pointerdown', off, true); }, 0);
    // The d-pad (arrows) walks the options and Remove; B (Escape) closes; keys stay inside the picker.
    const items = () => [...ed.querySelectorAll<HTMLButtonElement>('.panel-body button:not(:disabled)')];
    ed.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); audio.play('select'); close(); return; }
      if (e.key.startsWith('Arrow') || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation();
        const all = items();
        if (!all.length) return;
        const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey);
        const next = all[(all.indexOf(document.activeElement as HTMLButtonElement) + (back ? -1 : 1) + all.length) % all.length];
        next.focus({ focusVisible: true } as FocusOptions);
        next.scrollIntoView({ block: 'nearest' });
        audio.play('hover', 0.6);
      }
    });
    // Opened by a pad or keys, it lives where the focus is: focus taken elsewhere (the pad's Back to the
    // hubs, a Tab out) closes it, so it never sits orphaned over the board.
    if (keys) ed.addEventListener('focusout', (e) => { const to = (e as FocusEvent).relatedTarget; if (to instanceof Element && !ed.contains(to)) close(); });
    if (keys) requestAnimationFrame(() => { const first = ed.querySelector<HTMLButtonElement>('.slot-opt.active') || items()[0]; first?.focus({ focusVisible: true } as FocusOptions); first?.scrollIntoView({ block: 'nearest' }); });
  }
  /** Closes the open ship picker, however it was opened. */
  private editorClose: (() => void) | null = null;

  /* ── Engage ───────────────────────────────────────────────────────────── */
  private async engage() {
    if (validate(this.draft)) return;
    if (this.gauntlet && (this.gauntlet.over || this.gauntlet.reinforce)) { this.resumeGauntlet(); return; }
    if (this.coachKey === 'fill') this.clearCoach();
    audio.play('confirm');
    document.querySelectorAll('.slot-editor, .slot-scrim').forEach((n) => n.remove());
    this.phase = 'deploy';
    this.xpAtStart = record.r.xp;
    this.fitCamera(true);
    this.clearGhosts();
    this.els.setup?.remove();
    if (this.gauntlet) this.gauntlet.engaged = true;
    // A daily rolls the same dice for everyone; anything else gets fresh ones.
    const chainSeed = this.daily ? this.daily.seed : this.seed + ':' + Date.now();
    const { setup, idMap } = chainSetup(this.draft, chainSeed, { player: 9, computer: 9 });
    this.liveIdMap = idMap;
    this.liveSetup = { units: this.draft.map((u) => ({ ...u })), seed: chainSeed, start: setup.height! };
    this.chain = new Chain(setup);
    this.session = new BattleSession(this.chain, this.difficulty, this.seed, this.blockMs);
    this.session.onBlock = (b) => this.onBlock(b);
    this.session.onFinish = (o) => this.onFinish(o);
    this.session.onAiOrder = (m) => this.onSensor(m);
    if (this.spectate) {
      // Your side flies itself at Hard: the sharpest of the computer's levels.
      this.session.autopilot = new Ai(YOU.id, 'hard', this.seed + ':you');
      this.session.onAutoOrder = (m) => { if (m['@type'] === '/structs.structs.MsgStructAttack') this.view.onFocus(this.view.units.get(m.operatingStructId)?.center() || new THREE.Vector3(), 0.5); };
    }
    this.selected = null;
    this.held = null;
    this.paused = false;
    this.view.paused = false;
    this.lastBattery = { you: -1, cpu: -1 };
    const session = this.session;
    const current = () => this.session === session && this.phase === 'deploy';
    if (!(await this.buildBoard(this.chain)) || !current()) return;
    this.renderBattleHud();
    await this.view.deploy();
    for (const n of [3, 2, 1]) {
      if (!current()) return;
      banner(String(n), 'ENGAGEMENT IN', 'neutral', 650);
      audio.play('tick', 1.5);
      await new Promise((r) => setTimeout(r, 700));
    }
    if (!current()) return;
    closeGuide();   // the screen's intro card steps aside: the battle's own steps take over
    banner('ENGAGE', BATTLE_LINES.start[Math.floor(Math.random() * BATTLE_LINES.start.length)].toUpperCase(), 'player', 1500);
    audio.play('alert');
    this.phase = 'battle';
    // Rewards earned mid-fight wait for the results screen (core/dom holdRewards).
    holdRewards(true);
    audio.setIntensity(1);
    this.session.start();
    this.endgameKey = '';
    this.endgameSel = null;
    this.stuckLayer = null;
    this.shotLanded = false;
    this.cmdHp = null;
    // The fight opens on the best attacker that isn't the Command Ship: the flagship's own shots draw
    // every counter-attack onto it (it stays one Tab, or a click, away).
    this.selectBest();
    this.countReach();
    // A first battle walks through its first shot in three steps, each waiting until it is done
    // (only when a shot is possible: a step nothing can finish would just hold the clock).
    const canShoot = Object.values(this.chain!.structs).some((x) => x.owner === YOU.id && !this.chain!.isDestroyed(x) && this.weaponsReady(x).some((w) => w.targets.length));
    // Step 1 waits for the ENGAGE banner to clear, so the two never stack over the fleet. A player
    // quicker than the banner has found the weapon alone: step 1 counts as done, and step 2 (or 3) follows.
    if (!this.spectate && canShoot && !this.coachSeen('arm')) setTimeout(() => {
      if (this.session !== session || this.phase !== 'battle') return;
      const shot = (m?: Msg) => !!m && String(m['@type']).endsWith('MsgStructAttack');
      if (shot(session.pending?.msg) || shot(this.held?.msg)) { this.coachMark('arm'); this.coachMark('aim'); return; }
      if (this.targeting?.kind === 'attack') { this.coachMark('arm'); this.coach('aim', 'Step 2 of 3 · Fire', { pad: 'D-pad picks, A fires', keys: 'Click a ship in red brackets (or Enter)', touch: 'Tap a ship in red brackets, then Fire' }, true); return; }
      // Another ship (or an enemy) may have been picked meanwhile: the step starts on one of yours that can shoot.
      if (!this.targeting) this.pickReadyShip();
      this.coach('arm', 'Step 1 of 3 · Weapon', { pad: 'Press A', keys: 'Press 1, or click a weapon', touch: 'Tap a weapon below' }, true);
    }, 1500);
  }

  /** The fight's first shot of yours has landed; your Command Ship's health last turn (null: not yet seen). */
  private shotLanded = false;
  private chargeAt = 0;
  private cmdHp: number | null = null;
  /** "Guard your Command Ship": hands over a ship that can (in the flagship's layer, where guards block),
   * selected, its Guard button pointed at. Done when the guard order goes in, or on OK. */
  private guardStep() {
    const guard = this.guardCandidate();
    if (!guard) return;
    this.select(guard.id);
    this.coach('guard', 'Guard', { pad: 'Guard your Command Ship: X, then pick it', keys: 'Guard your Command Ship: G, then click it', touch: 'Guard your Command Ship: tap Guard, then it' }, true);
  }

  /** The weapon a press of A (Enter) arms: one that reaches their Command Ship, else the first with anything in reach. */
  private armFirst(s: SimStruct) {
    const c = this.activeChain();
    const ws = this.weaponsReady(s);
    return ws.find((w) => w.targets.some((t) => t.typeId === COMMAND_SHIP_ID && !c?.isDestroyed(t))) || ws.find((w) => w.targets.length) || null;
  }

  /** After a shot of yours lands, the next ship to fire: one that can reach their Command Ship (the one
   * that empties the battery least first, then in board order after the ship that just fired), else the
   * best attacker. A kid who keeps pressing fire keeps aiming at what wins. */
  private nextShooter(from: SimStruct): SimStruct | null {
    const c = this.chain;
    if (!c) return null;
    const others = Object.values(c.structs).filter((x) => x.owner === YOU.id && !c.isDestroyed(x) && x.typeId !== COMMAND_SHIP_ID)
      .sort((a, b) => AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit) || a.slot - b.slot);
    const at = others.findIndex((x) => x.id === from.id);
    const ring = [...others.slice(at + 1), ...others.slice(0, at + 1)];
    const cost = (x: SimStruct) => Math.min(Infinity, ...this.weaponsReady(x).filter((w) => w.targets.some((t) => t.typeId === COMMAND_SHIP_ID && !c.isDestroyed(t))).map((w) => w.cost));
    const reach = ring.filter((x) => cost(x) < Infinity);
    return reach.sort((a, b) => cost(a) - cost(b))[0] || this.bestAttacker();
  }

  /** The ship (and weapon) of yours to fire at one enemy: not your Command Ship unless nothing else can;
   * the selected ship if it can, else one whose battery covers the shot, cheapest first, else any. */
  private shooterFor(targetId: string): { ship: SimStruct; ws: WeaponSystem } | null {
    const c = this.chain;
    if (!c) return null;
    const charge = this.session?.chargeAtNext() ?? 0;
    const opts: { ship: SimStruct; ws: WeaponSystem; cost: number }[] = [];
    for (const x of Object.values(c.structs)) {
      if (x.owner !== YOU.id || c.isDestroyed(x)) continue;
      for (const w of this.weaponsReady(x)) if (w.targets.some((t) => t.id === targetId)) opts.push({ ship: x, ws: w.ws, cost: w.cost });
    }
    // Your Command Ship only when no other ship of yours can reach this one.
    const fleet = opts.filter((o) => o.ship.typeId !== COMMAND_SHIP_ID);
    if (fleet.length) opts.splice(0, opts.length, ...fleet);
    if (!opts.length) return null;
    const sel = opts.find((o) => o.ship.id === this.selected && o.cost <= charge);
    return sel || opts.filter((o) => o.cost <= charge).sort((a, b) => a.cost - b.cost)[0] || opts.sort((a, b) => a.cost - b.cost)[0];
  }

  /** Your ships that can hit their Command Ship wear a small crosshair-crown over them in a fight, so a
   * kid sees which ones to fire with. Recounted each turn and on each selection; placed each frame. */
  private reachIds = new Set<string>();
  private reachEls = new Map<string, HTMLElement>();
  private countReach() {
    this.reachIds.clear();
    const c = this.chain;
    if (!c || this.phase !== 'battle' || this.spectate) return;
    for (const x of Object.values(c.structs)) {
      if (x.owner !== YOU.id || c.isDestroyed(x) || x.typeId === COMMAND_SHIP_ID) continue;
      if (this.weaponsReady(x).some((w) => w.targets.some((t) => t.typeId === COMMAND_SHIP_ID && !c.isDestroyed(t)))) this.reachIds.add(x.id);
    }
  }
  private paintReach() {
    const show = this.phase === 'battle' && !this.spectate;
    for (const [id, el] of this.reachEls) if (!show || !this.reachIds.has(id) || !el.isConnected) { el.remove(); this.reachEls.delete(id); }
    if (!show) return;
    // The crown rides in the ship's own tag, beside its pips, so it moves with them (never onto a neighbour).
    for (const id of this.reachIds) {
      if (this.reachEls.has(id)) continue;
      const tag = this.view.units.get(id)?.tag;
      if (!tag) continue;
      const el = h('i', { class: 'dc-reach', title: 'Can hit their Command Ship', 'aria-hidden': 'true', html: icon('crown', 10) });
      tag.insertBefore(el, tag.firstChild);
      this.reachEls.set(id, el);
    }
  }


  /** Tips said once per fight (the endgame's), keyed by the fight's session. */
  private fightTips = new WeakMap<object, Set<string>>();
  private oncePerFight(key: string) {
    const sess = this.session;
    if (!sess) return false;
    const seen = this.fightTips.get(sess) || new Set<string>();
    this.fightTips.set(sess, seen);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }
  /** The fight would lock: no ship but your Command Ship can reach anything (it takes over, armed, with a
   * one-line step), or nothing of yours can (your Command Ship's Move is pointed at). True when it acted. */
  /** The layer the Move step points at (where your flagship would reach something). */
  private stuckLayer: Ambit | null = null;
  /** Who of yours can reach something now (the endgame hands over again only when this changes). */
  private endgameKey = '';
  private endgameSel: string | null = null;
  private reachKey() {
    const c = this.chain;
    if (!c) return '';
    return Object.values(c.structs).filter((x) => x.owner === YOU.id && !c.isDestroyed(x) && this.weaponsReady(x).some((w) => w.targets.length)).map((x) => x.id).sort().join(',') || '-';
  }
  /** "Nothing in reach": the deny sound, and a short line when no tip is saying it already. */
  private nothingInReach() {
    audio.play('deny');
    if (!this.coachEl?.isConnected) toast(say({ keys: 'Nothing in reach · D moves your flagship', pad: 'Nothing in reach · Y moves your flagship', touch: 'Nothing in reach · move your flagship' }), 'warn', 2400);
  }
  private endgame(): 'armed' | 'stuck' | null {
    const c = this.chain;
    if (!c || this.phase !== 'battle' || this.spectate || this.targeting || this.session?.finished) return null;
    if (!Object.values(c.structs).some((x) => x.owner !== YOU.id && !c.isDestroyed(x))) return null;
    // Their Command Ship is down: the fight is won, whatever the turn says.
    if (!Object.values(c.structs).some((x) => x.owner !== YOU.id && x.typeId === COMMAND_SHIP_ID && !c.isDestroyed(x))) return null;
    const mine = Object.values(c.structs).filter((x) => x.owner === YOU.id && !c.isDestroyed(x));
    if (mine.some((x) => x.typeId !== COMMAND_SHIP_ID && this.weaponsReady(x).some((w) => w.targets.length))) return null;
    const cmd = mine.find((x) => x.typeId === COMMAND_SHIP_ID);
    if (!cmd) return null;
    const ws = this.armFirst(cmd);
    if (ws?.targets.length) {
      if (this.selected !== cmd.id) this.select(cmd.id);
      this.beginAttack(ws.ws);
      if (this.targeting) this.cycleAim(0);
      if (this.oncePerFight('flagship')) this.coach('flagship', 'Flagship', { pad: 'Only your flagship reaches: A fires', keys: 'Only your flagship reaches: Enter fires', touch: 'Only your flagship reaches: tap a target' }, false, true);
      return 'armed';
    }
    if (TYPES_BY_ID[cmd.typeId].movable) {
      if (this.selected !== cmd.id) this.select(cmd.id);
      // The layer that gives it reach (their Command Ship's reach first, then the most ships in reach).
      const t = TYPES_BY_ID[cmd.typeId];
      const foes = Object.values(c.structs).filter((x) => x.owner !== YOU.id && !c.isDestroyed(x));
      const hits = (from: Ambit, list: SimStruct[]) => list.filter((f) => (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).some((ws) => hasWeapon(t, ws) && canTargetAmbit(t, ws, from, f.ambit))).length;
      const layers = AMBITS.filter((a) => a !== cmd.ambit && (t.possibleAmbit & AMBIT_FLAG[a]) !== 0)
        .map((a) => ({ a, cs: hits(a, foes.filter((f) => f.typeId === COMMAND_SHIP_ID)), n: hits(a, foes) })).filter((x) => x.n > 0)
        .sort((x, y) => y.cs - x.cs || y.n - x.n);
      const to = layers[0]?.a || null;
      this.stuckLayer = to;
      this.renderActionBar();
      if (this.oncePerFight('stuck')) {
        const where = to ? ` to ${AMBIT_NAME[to]}` : '';
        this.coach('stuck', 'Move', { pad: `Nothing in reach: Y, then${where || ' a layer'}`, keys: `Nothing in reach: D, then${where || ' a layer'}`, touch: `Nothing in reach: move your flagship${where}` }, false, true);
      }
      // A pad or keys: the cursor waits on that layer's button (A moves).
      if (to && inputMode() !== 'touch') requestAnimationFrame(() => this.root.querySelector<HTMLElement>(`.action-bar .drift .btn.mini.ambit-${to}:not(:disabled)`)?.focus({ focusVisible: true } as FocusOptions));
      return 'stuck';
    }
    return null;
  }

  private guardEls = new Map<string, HTMLElement>();
  private paintGuardMarks() {
    const c = this.chain;
    // Every enemy ship that guards another (alive, its ward alive) wears a red shield in its tag all fight.
    const want = new Set<string>(c && this.phase === 'battle' ? Object.values(c.structs)
      .filter((x) => x.owner !== YOU.id && !c.isDestroyed(x) && x.protectedStructId && c.structs[x.protectedStructId] && !c.isDestroyed(c.structs[x.protectedStructId]))
      .map((x) => x.id) : []);
    for (const [g, el] of this.guardEls) if (!want.has(g) || !el.isConnected) { el.remove(); this.guardEls.delete(g); }
    for (const g of want) {
      if (this.guardEls.has(g)) continue;
      const tag = this.view.units.get(g)?.tag;
      if (!tag) continue;
      const ward = c!.structs[c!.structs[g].protectedStructId!];
      const el = h('i', { class: 'dc-guard-mark', title: ward?.typeId === COMMAND_SHIP_ID ? 'Guards their Command Ship: it blocks your shots. Sink it first.' : 'Guards one of their ships: it blocks your shots at it.', 'aria-hidden': 'true', html: icon('shield', 10) });
      tag.insertBefore(el, tag.firstChild);
      this.guardEls.set(g, el);
    }
  }
  /** Their live guards on one ship. */
  private guardsOf(id: string) {
    const c = this.activeChain();
    return c ? c.defendersOf(id).map((g) => c.structs[g]).filter((x) => x && !c.isDestroyed(x)) : [];
  }
  /** Every shot the armed weapon fires at this ship would be blocked by a guard. */
  private fullyBlocked(id: string) {
    const p = this.targeting?.kind === 'attack' ? this.forecast(id) : null;
    return !!p && (p.blocked ?? 0) >= 0.99 && this.guardsOf(id).length > 0;
  }
  /** Aim at a guard of this ship instead (with this weapon if it reaches one, else the ship that can). */
  private aimAtGuard(id: string, touch: boolean) {
    const gs = this.guardsOf(id);
    const valid = this.validTargets();
    let g = gs.find((x) => valid.has(x.id));
    if (!g) {
      for (const x of gs) { const pick = this.shooterFor(x.id); if (pick) { this.select(pick.ship.id); this.beginAttack(pick.ws); g = x; break; } }
    }
    if (!g || this.targeting?.kind !== 'attack') { audio.play('deny'); return; }
    this.disarmTouch();
    this.aimId = g.id;
    const u = this.view.units.get(g.id);
    const at = this.view.screenOf(g.id) ?? { x: innerWidth / 2, y: innerHeight / 2 };
    if (touch && u) this.touchArmed = { target: g.id, ws: this.targeting.ws, from: this.selected || '', at };
    if (this.hovered && this.hovered !== g.id) { const h0 = this.view.units.get(this.hovered); if (h0) h0.hover = 0; }
    this.hovered = g.id;
    if (u) { u.hover = 1; this.tipFor(u, at); }
    audio.play('select');
    this.refreshDock();
  }


  /** A ship that could guard your Command Ship now: alive, free, able to guard, in the flagship's layer. */
  private guardCandidate(): SimStruct | null {
    const c = this.chain;
    if (!c) return null;
    const cmd = Object.values(c.structs).find((x) => x.owner === YOU.id && x.typeId === COMMAND_SHIP_ID && !c.isDestroyed(x));
    return (cmd && Object.values(c.structs).find((x) => x.owner === YOU.id && x.id !== cmd.id && !c.isDestroyed(x) && x.ambit === cmd.ambit && TYPES_BY_ID[x.typeId].canDefend && !x.protectedStructId)) || null;
  }

  /** Keep the selection if it is a ship of yours with an enemy in reach; otherwise select the best attacker. */
  private pickReadyShip() {
    const c = this.chain;
    if (!c) return;
    const s = this.selectedStruct();
    if (s && s.owner === YOU.id && !c.isDestroyed(s) && this.weaponsReady(s).some((w) => w.targets.length)) return;
    this.selectBest();
  }

  /** The ship a new player should fire with: not the Command Ship (its shots draw every counter-attack
   * onto it) but a ship that can reach the enemy's Command Ship, else one with anything in reach, else any
   * armed ship. The Command Ship only when nothing else is left. */
  private bestAttacker(): SimStruct | null {
    const c = this.chain;
    if (!c) return null;
    const mine = Object.values(c.structs).filter((x) => x.owner === YOU.id && !c.isDestroyed(x))
      .sort((a, b) => AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit) || a.slot - b.slot);
    const others = mine.filter((x) => x.typeId !== COMMAND_SHIP_ID);
    const reach = (x: SimStruct) => this.weaponsReady(x).flatMap((w) => w.targets);
    const cmd = mine.find((x) => x.typeId === COMMAND_SHIP_ID);
    // When no other ship has anything in reach, the Command Ship fires (a fight never locks on it).
    return others.find((x) => reach(x).some((t) => t.typeId === COMMAND_SHIP_ID && !c.isDestroyed(t)))
      || others.find((x) => reach(x).length)
      || (cmd && reach(cmd).length ? cmd : null)
      || others.find((x) => this.weaponsReady(x).length)
      || cmd || mine[0] || null;
  }
  private selectBest() { const b = this.bestAttacker(); if (b) this.select(b.id); else this.select(null); }

  private selectFirst() {
    if (!this.chain) return;
    const mine = Object.values(this.chain.structs).filter((s) => s.owner === YOU.id && !this.chain!.isDestroyed(s));
    const cmd = mine.find((s) => s.typeId === COMMAND_SHIP_ID);
    this.select(cmd?.id || mine[0]?.id || null);
  }

  /* ── Blocks ───────────────────────────────────────────────────────────── */
  private onBlock(b: Block) {
    const chain = this.chain!;
    audio.play('tick', 0.6);
    this.view.clearIntent();
    this.view.playBlock(b, chain, YOU.id);
    if (this.touchTip) { this.touchTip = null; hideTooltip(); }
    // A move of yours landed: the battery visibly empties, and a first shot's step 3 says why.
    if (b.txs.some((tx) => tx.ok && tx.signer === YOU.id)) {
      const bat = this.els.playerBattery;
      bat?.classList.remove('drain'); void bat?.offsetWidth; bat?.classList.add('drain');
      if (!this.spectate && this.coachSeen('aim') && b.txs.some((tx) => tx.ok && tx.signer === YOU.id && tx.events.some((e) => e.category === 'struct_attack')))
        this.coach('charge', 'Step 3 of 3 · Charge', 'A move needs its ⚡, then empties it.');
    }
    const mineHit = b.txs.some((tx) => tx.ok && tx.signer === YOU.id && tx.events.some((e) => e.category === 'struct_attack'));
    if (mineHit && !this.shotLanded) { this.shotLanded = true; this.chargeAt = performance.now(); }
    // An armed weapon with nothing left in reach (its targets sank or went out of reach) lets go.
    if (this.targeting?.kind === 'attack' && !this.spectate) {
      const armed = this.selectedStruct();
      const ws = this.targeting.ws;
      if (!armed || chain.isDestroyed(armed) || !this.weaponsReady(armed).some((w) => w.ws === ws && w.targets.length)) { this.targeting = null; this.clearAim(); this.disarmTouch(); this.refreshSelectionVisuals(); }
    }
    // The fight would lock (only your Command Ship can shoot, or nothing can): it says so and hands over.
    if (!this.spectate && !this.targeting && !this.held && !this.session?.pending && !document.activeElement?.closest('.action-bar, .slot-editor, .modal-back')) {
      const sel0 = this.selectedStruct();
      // (Also when the flagship on the bar has just come into reach, after a move: its step follows.)
      const cmdOnly = !!sel0 && sel0.typeId === COMMAND_SHIP_ID && sel0.owner === YOU.id && this.reachKey() !== this.endgameKey;
      if (cmdOnly || !sel0 || sel0.owner !== YOU.id || chain.isDestroyed(sel0) || !this.weaponsReady(sel0).some((w) => w.targets.length)) {
        // Once per lock: again only when who can reach changes, or the ship it handed over is lost. A ship
        // the player picked since then is theirs (guarding with it, say): never taken back.
        const key = this.reachKey();
        const handed = this.endgameSel ? chain.structs[this.endgameSel] : null;
        const picked = !!sel0 && sel0.owner === YOU.id && !chain.isDestroyed(sel0) && this.selected !== this.endgameSel;
        const lost = !!handed && chain.isDestroyed(handed);
        if (picked && key === this.endgameKey) { /* the player's choice stands */ }
        else if (key !== this.endgameKey || lost) { this.endgameKey = key; if (this.endgame()) this.endgameSel = this.selected; }
      }
    }
    // Your shot went in from the ship on the bar: the bar moves on to the next ship that can reach their
    // Command Ship (not while you aim or have another order waiting, and never in Auto).
    // (Nor while the player is choosing on the bar: a Drift layer, a focused verb, a picker.)
    const choosing = !!document.activeElement?.closest('.action-bar, .slot-editor, .modal-back');
    if (mineHit && !this.spectate && !this.targeting && !this.held && !this.session?.pending && !choosing) {
      const shooter = b.txs.find((tx) => tx.ok && tx.signer === YOU.id && String(tx.type).endsWith('MsgStructAttack'));
      const fromId = shooter ? String((shooter.msg as unknown as Record<string, unknown>).operatingStructId ?? '') : '';
      const from = (fromId && chain.structs[fromId]) || this.selectedStruct();
      if (from && from.owner === YOU.id && from.id === this.selected) { const n = this.nextShooter(from); if (n && n.id !== this.selected) this.select(n.id); }
    }
    // Your Command Ship took a hit (its health went down since the last turn).
    const cmd = Object.values(chain.structs).find((x) => x.owner === YOU.id && x.typeId === COMMAND_SHIP_ID);
    const cmdHit = !!cmd && this.cmdHp != null && cmd.health < this.cmdHp;
    if (cmd) this.cmdHp = cmd.health;
    // Guarding the Command Ship is what wins past Small: one waiting step teaches it in the first fight,
    // on every input, once your first shot has landed (after the charge tip has had a moment) or the
    // moment your Command Ship is first hit. Never over a step already waiting, or mid-aim.
    if (!this.spectate && !this.coachSeen('guard') && !this.targeting && !(this.coachStay && this.coachEl?.isConnected)) {
      const tipUp = this.coachEl?.isConnected;
      const after = this.shotLanded && (!tipUp || (this.coachKey === 'charge' && performance.now() - this.chargeAt > 4000) || this.coachKey === 'drift');
      if (cmdHit || after) this.guardStep();
    }
    // Once guarding is taught (or can't be: no free ship in the flagship's layer) and no other tip is up:
    // the flagship can change battleground.
    if (!this.spectate && mineHit && (this.coachSeen('guard') || !this.guardCandidate()) && !this.coachEl?.isConnected) {
      this.coach('drift', 'Drift', { pad: 'Y moves your Command Ship', keys: 'D moves your Command Ship', touch: 'Your Command Ship can move layers' });
    }
    for (const tx of b.txs) {
      if (!tx.ok && tx.signer === YOU.id && !this.spectate) {
        toast((window.innerWidth <= 760 || window.innerHeight <= 560 ? '✕ ' : 'Order failed: ') + humanError(tx.error || ''), 'enemy', 4200);
        audio.play('deny');
      }
      this.logTx(b.height, tx);
    }
    // Release a held order once the battery covers it (the client's charge gating).
    if (this.held && this.session && !this.session.pending && this.session.chargeAtNext() >= this.held.cost) {
      this.session.submit(this.held.msg);
      this.held = null;
    }
    this.predictCache.clear();
    this.countReach();
    // Reach changes block to block (a target went dark, an attacker died): re-ring.
    const sel = this.selectedStruct();
    if (this.targeting && (!sel || chain.isDestroyed(sel))) this.targeting = null;
    // Your selected ship went down: the bar moves on to the next best attacker (not an empty card).
    if (this.phase === 'battle' && !this.spectate && sel && sel.owner === YOU.id && chain.isDestroyed(sel)) { this.selectBest(); return; }
    this.refreshSelectionVisuals();
    this.renderActionBar();
    // A pinned touch forecast is re-run on the new block (health, odds), as hover would be.
    if (this.touchArmed) {
      const armed = this.armedStands() ? this.view.units.get(this.touchArmed.target) : null;
      if (armed) this.tipFor(armed, this.touchArmed.at); else this.disarmTouch();
    }
  }

  /* The computer's order is public the moment it is sent, as a mempool is. */
  private onSensor(m: Msg) {
    if (!this.chain || this.phase !== 'battle') return;
    const name = (id: string) => { const s = this.chain!.structs[id]; return s ? TYPES_BY_ID[s.typeId].type : id; };
    let line = '';
    if (m['@type'] === '/structs.structs.MsgStructAttack') {
      this.view.showIntent(m.operatingStructId, m.targetStructId[0]);
      line = `enemy ${name(m.operatingStructId)} locking onto your ${name(m.targetStructId[0])}`;
      audio.play('alert');
    } else if (m['@type'] === '/structs.structs.MsgStructDefenseSet') line = `enemy ${name(m.defenderStructId)} moving to guard ${name(m.protectedStructId)}`;
    else if (m['@type'] === '/structs.structs.MsgStructMove') line = `enemy Command Ship spooling its drive for ${m.ambit}`;
    else if (m['@type'] === '/structs.structs.MsgStructStealthActivate') line = `enemy ${name(m.structId)} powering stealth systems`;
    if (line && this.logEl) {
      this.logEl.appendChild(h('div', { class: 'log-row sensor' }, h('span', { class: 'when num' }, 'mempool'), h('span', { class: 'what' }, h('span', { class: 'tag c-warn' }, 'Sensors'), line)));
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
  }

  private onFinish(o: Outcome) {
    const session = this.session;
    // Gauntlet bookkeeping happens the instant the fight ends — leaving before the
    // debrief can neither forfeit a win nor dodge a loss, and a replay cannot rewind it.
    const g = this.gauntlet;
    if (g && g.engaged) {
      const won = o.winner === 'you';
      g.engaged = false;
      g.fought = g.round;
      this.saveGauntletBest(won ? g.round : g.round - 1);
      if (!won || g.round >= 5) g.over = true;
      else { this.carryOver(); g.round++; g.reinforce = true; }
    }
    // Service record and daily results: only battles you commanded.
    this.dailyLast = null;
    if (session && !this.spectate) {
      const st = session.standing();
      const theirs = session.kills.filter((k) => k.owner === CPU.id);
      addBattle({ winner: o.winner, kills: theirs.length, flagship: theirs.some((k) => k.command), lost: session.kills.filter((k) => k.owner === YOU.id).length });
      if (this.daily) {
        const r: DailyResult = { won: o.winner === 'you', draw: o.winner === 'draw', blocks: o.height - session.startHeight, standing: st[YOU.id], fielded: session.fielded[YOU.id], enemyLeft: st[CPU.id] };
        this.dailyLast = { r, best: saveDaily(this.daily.key, r) };
      }
    }
    const show = () => {
      if (this.session !== session) return;
      if (this.view.busy) { setTimeout(show, 300); return; }
      setTimeout(() => { if (this.session === session) this.showDebrief(o); }, 900);
    };
    show();
  }

  /* ── Orders ───────────────────────────────────────────────────────────── */
  private order(msg: Msg, cost: number, label: string) {
    if (!this.session || this.phase !== 'battle') return;
    if (this.spectate) { toast('Auto is flying', 'warn', 1600); return; }
    const m = msg as unknown as Record<string, unknown>;
    const actor = this.chain?.structs[String(m.operatingStructId || m.structId || m.defenderStructId || '')];
    if (actor && this.chain!.isDestroyed(actor)) { this.targeting = null; this.renderActionBar(); toast('That ship is destroyed', 'warn', 1400); return; }
    this.targeting = null;
    // Firing finishes step 2, and step 3 follows (any other order leaves the steps where they are).
    const firing = String(m['@type']).endsWith('MsgStructAttack');
    if (firing) { this.coachDone('aim'); this.coachDone('flagship'); }
    if (String(m['@type']).endsWith('MsgStructDefenseSet')) this.coachDone('guard');
    if (String(m['@type']).endsWith('MsgStructMove')) { this.coachDone('stuck'); this.stuckLayer = null; }
    const charge = this.session.chargeAtNext();
    if (charge >= cost) {
      const r = this.session.submit(msg);
      this.held = null;
      // The turn card already says ✓ Sent; this is just the call.
      if (!this.coachEl?.isConnected) this.orderCall(msg, r.replaced ? '↺' : '✓', label);
    } else {
      this.session.cancelPending();
      this.held = { msg, cost, label };
      this.orderCall(msg, '⏳', label, cost);
    }
    audio.play('confirm');
    this.refreshSelectionVisuals();
    this.renderActionBar();
  }

  private attack(ws: WeaponSystem, targetId: string) {
    const s = this.selectedStruct();
    if (!s || !this.chain) return;
    const t = TYPES_BY_ID[s.typeId];
    const target = this.chain.structs[targetId];
    this.order({ '@type': '/structs.structs.MsgStructAttack', operatingStructId: s.id, targetStructId: [targetId], weaponSystem: ws },
      weaponField(t, ws, 'Charge') || 0, `${t.type} ▸ ${weaponLabel(t, ws)} on ${target ? TYPES_BY_ID[target.typeId].type : targetId}`);
  }

  /* ── Selection & targeting ───────────────────────────────────────────── */
  private activeChain() { return this.chain || this.preview?.chain || null; }
  private selectedStruct(): SimStruct | null { const c = this.activeChain(); return c && this.selected ? c.structs[this.selected] || null : null; }

  private select(id: string | null) {
    this.clearAim();
    if (this.bayCursor) { this.bayCursor = null; this.paintBayCursor(); }
    this.selected = id;
    this.targeting = null;
    this.refreshSelectionVisuals();
    this.renderActionBar();
  }

  private validTargets(): Set<string> {
    const out = new Set<string>();
    const c = this.activeChain();
    const s = this.selectedStruct();
    if (!c || !s || !this.targeting) return out;
    if (this.targeting.kind === 'attack') {
      for (const t of Object.values(c.structs)) if (t.owner !== s.owner && !c.canAttack(s, t, this.targeting.ws)) out.add(t.id);
    } else {
      for (const t of Object.values(c.structs)) if (t.owner === s.owner && t.id !== s.id && !c.isDestroyed(t)) out.add(t.id);
    }
    return out;
  }

  private refreshSelectionVisuals() {
    const valid = this.validTargets();
    for (const u of this.view.units.values()) {
      u.selected = u.id === this.selected;
      u.targetable = valid.has(u.id);
      u.dimmed = !!this.targeting && !u.targetable && !u.selected;
    }
  }

  private weaponsReady(s: SimStruct) {
    const c = this.activeChain()!;
    const t = TYPES_BY_ID[s.typeId];
    return (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).filter((ws) => hasWeapon(t, ws)).map((ws) => {
      const targets = Object.values(c.structs).filter((x) => x.owner !== s.owner && !c.canAttack(s, x, ws));
      return { ws, cost: weaponField(t, ws, 'Charge') || 0, targets };
    });
  }

  /* ── HUD ─────────────────────────────────────────────────────────────── */
  private renderBattleHud() {
    this.root.querySelectorAll('.battle-top, .battle-log, .action-bar').forEach((n) => n.remove());
    const fleetCard = (side: 'player' | 'enemy') => {
      const who = side === 'player' ? YOU : CPU;
      const battery = h('div', { class: 'battery' + (side === 'enemy' ? ' enemy' : '') }, Array.from({ length: BATTERY_CELLS }, () => h('i')));
      const chargeNum = h('span', { class: 'num' }, '0');
      const hulls = h('span', { class: 'num' }, '');
      const cmdPips = h('div', { class: 'pips' });
      // Icons and numbers: who (portrait), ships standing, charge, and the Command Ship's health.
      const card = h('div', { class: 'fleet-card panel ' + side },
        h('div', { class: 'row' }, portrait(who.pfp, 'sm ' + side),
          h('div', { class: 'grow col', style: 'gap:4px' },
            h('div', { class: 'spread' }, h('span', { class: 't-label ' + (side === 'player' ? 'c-player' : 'c-enemy') }, side === 'player' ? 'You' : 'CPU', h('span', { class: 'fc-diff' }, side === 'player' ? (this.spectate ? ' · Auto' : '') : ` · ${cap(this.difficulty)}`)),
              h('span', { class: 'fc-stat', title: 'Ships still fighting' }, h('span', { html: icon('ship', 14) }), hulls)),
            h('div', { class: 'fc-meter', title: 'Charge: it grows one a turn, and any move empties it. Each move needs at least its ⚡.' }, h('span', { class: 'fc-ico charge', html: icon('charge', 16) }), battery, h('span', { class: 'fc-n' }, chargeNum)),
            h('div', { class: 'fc-meter', title: 'Command Ship health: destroy theirs to win' }, h('span', { class: 'fc-ico cmd', html: icon('crown', 16) }), cmdPips),
          )),
      );
      this.els[side + 'Battery'] = battery; this.els[side + 'Charge'] = chargeNum; this.els[side + 'Hulls'] = hulls; this.els[side + 'Cmd'] = cmdPips;
      return card;
    };
    const blockNum = h('div', { class: 'block-num num' }, '—');
    const blockBar = h('div', { class: 'bar' }, h('i'));
    const nextIn = h('span', { class: 'num' }, '');
    const order = h('div', { class: 'order-line t-tiny' });
    const cancel = h('button', { class: 'btn ghost mini order-cancel', title: 'Withdraw the queued order', 'aria-label': 'Cancel order', onclick: () => {
      if (!this.session) return;
      this.session.cancelPending();
      this.held = null;
      audio.play('deny');
      toast('✕ Withdrawn', '', 1200);
    } }, '✕');
    const pauseBtn = h('button', { class: 'btn ghost mini hud-pause', title: 'Pause (Space)', 'aria-label': 'Pause', html: icon('pause', 16), onclick: () => this.togglePause() });
    const center = h('div', { class: 'block-card panel', title: 'Turn: one block of the chain' },
      h('div', { class: 'spread' }, h('span', { class: 't-label c-hint' }, h('span', { class: 's-only' }, 'Turn'), h('span', { class: 'x-only' }, 'Block')), h('span', { class: 't-label c-hint' }, nextIn)),
      blockNum, blockBar, h('div', { class: 'row', style: 'justify-content:center; gap:6px' }, order, cancel),
      h('div', { class: 'row wrap block-ctl', style: 'justify-content:center; gap:4px; margin-top:4px' }, pauseBtn,
        h('button', { class: 'btn ghost mini', disabled: !!this.gauntlet || !!this.daily, title: this.gauntlet || this.daily ? 'Pace is fixed for this run' : 'Turn length: 2 s training or 6 s real game pace', onclick: (e: Event) => { this.blockMs = this.blockMs === 2000 ? 6000 : 2000; if (this.session) { this.session.blockMs = this.blockMs; this.session.blockClock = Math.min(this.session.blockClock, this.blockMs - 1); } (e.currentTarget as HTMLElement).textContent = `${this.blockMs / 1000}s`; toast(`${this.blockMs / 1000} s turns`, '', 1400); } }, `${this.blockMs / 1000}s`),
        h('button', { class: 'btn ghost mini', title: 'Battle log', 'aria-label': 'Battle log', 'aria-pressed': this.showLog ? 'true' : 'false', onclick: (e: Event) => { this.showLog = !this.showLog; try { localStorage.setItem('structs.battle.log', this.showLog ? '1' : '0'); } catch { /* ignore */ } (e.currentTarget as HTMLElement).setAttribute('aria-pressed', this.showLog ? 'true' : 'false'); this.root.querySelector('.battle-log')?.classList.toggle('shut', !this.showLog); this.fitCamera(); } }, h('span', { html: icon('queue', 14) })),
        // Retreat reads as leaving: a red door with an arrow out of it.
        h('button', { class: 'btn danger mini hud-retreat', title: this.gauntlet ? 'Retreat: pull out and end the gauntlet run' : 'Retreat: pull out and end the battle', 'aria-label': 'Retreat', onclick: () => {
          const wasPaused = this.paused;
          if (!wasPaused) this.togglePause();
          void confirmBox('Retreat', this.gauntlet ? 'Pull your fleet out? This ends your gauntlet run.' : 'Pull your fleet out? The battle ends and you return to fleet setup.', 'Retreat').then((yes) => {
            if (yes) this.toSetup(false);
            else if (!wasPaused && this.paused) this.togglePause();
          });
        } }, h('span', { html: EXIT(18) }))),
    );
    this.els.blockNum = blockNum; this.els.blockBar = blockBar; this.els.nextIn = nextIn; this.els.order = order; this.els.pause = pauseBtn; this.els.cancel = cancel;
    const top = h('div', { class: 'battle-top' }, fleetCard('player'), center, fleetCard('enemy'));
    this.logEl = h('div', { class: 'log-body scroll' });
    // The battle speaks for itself (shots, numbers, banners); the written log is one button away.
    const log = h('div', { class: 'battle-log panel' + (this.showLog ? '' : ' shut') }, h('div', { class: 'panel-head' }, h('span', { class: 't-label' }, 'Battle log'), h('span', { class: 'chip x-only' }, 'chain events')), this.logEl);
    this.root.appendChild(top);
    this.root.appendChild(log);
    this.renderActionBar();
  }

  private paintHud() {
    if (!this.session || !this.chain || !this.els.playerBattery?.isConnected) return;
    const s = this.session, c = this.chain;
    const paintBattery = (side: 'player' | 'enemy', pid: string) => {
      const charge = c.chargeOf(pid, c.height + 1);
      const key = side === 'player' ? 'you' : 'cpu';
      if (this.lastBattery[key] !== charge) {
        this.lastBattery[key] = charge;
        const cells = this.els[side + 'Battery'].children;
        for (let i = 0; i < cells.length; i++) cells[i].classList.toggle('on', i < Math.min(BATTERY_CELLS, charge));
        this.els[side + 'Charge'].textContent = String(charge);
      }
      const standing = s.standing()[pid] || 0;
      this.els[side + 'Hulls'].textContent = `${standing}/${s.fielded[pid] || 0}`;
      const cmd = Object.values(c.structs).find((x) => x.owner === pid && x.typeId === COMMAND_SHIP_ID);
      const hp = cmd && !c.isDestroyed(cmd) ? cmd.health : 0;
      const pips = this.els[side + 'Cmd'];
      if (pips.dataset.hp !== String(hp)) {
        pips.dataset.hp = String(hp);
        pips.replaceChildren(...Array.from({ length: 6 }, (_, i) => h('i', { class: i < hp ? '' : 'lost' })));
      }
    };
    paintBattery('player', YOU.id);
    // The armed move's minimum charge, marked on the battery (any move then empties it).
    const sel = this.selectedStruct();
    const need = !sel || !this.targeting ? 0 : this.targeting.kind === 'attack' ? (this.weaponsReady(sel).find((w) => w.ws === (this.targeting as { ws: WeaponSystem }).ws)?.cost ?? 0) : TYPES_BY_ID[sel.typeId].defendChangeCharge;
    const cells = this.els.playerBattery.children;
    for (let i = 0; i < cells.length; i++) cells[i].classList.toggle('mark', need > 0 && i === Math.min(BATTERY_CELLS, need) - 1);
    paintBattery('enemy', CPU.id);
    // Turns count the blocks since this battle began, as the debrief does (expert mode shows the chain's own height).
    this.els.blockNum.textContent = document.body.classList.contains('expert') ? c.height.toLocaleString('en-US') : String(c.height - s.startHeight);
    (this.els.blockBar.firstChild as HTMLElement).style.width = (100 * s.blockClock / s.blockMs).toFixed(1) + '%';
    this.els.nextIn.textContent = this.paused ? '❚❚' : (s.nextBlockIn / 1000).toFixed(1) + 's';
    const ord = this.spectate ? 'Auto' : s.pending ? '✓ Sent' : this.held ? `⚡ ${s.chargeAtNext()}/${this.held.cost}` : '';
    this.els.cancel.style.display = s.pending || this.held ? '' : 'none';
    if (this.els.order.textContent !== ord) {
      this.els.order.textContent = ord;
      this.els.order.className = 'order-line t-tiny ' + (s.pending ? 'c-player' : this.held ? 'c-warn' : 'c-hint');
    }
  }

  private renderActionBar() {
    // The bar is rebuilt every turn: a control in focus (a pad's, a keyboard's) keeps its place.
    const old = this.root.querySelector('.action-bar') as HTMLElement | null;
    // Only for the same ship: another ship's bar has other buttons at the same places.
    const sameShip = old?.dataset.ship === (this.selected || '');
    const focused = sameShip && old?.contains(document.activeElement) ? [...old.querySelectorAll('button')].indexOf(document.activeElement as HTMLButtonElement) : -1;
    old?.remove();
    if (focused >= 0) requestAnimationFrame(() => {
      const again = this.root.querySelectorAll<HTMLButtonElement>('.action-bar button')[focused];
      if (again && !document.activeElement?.closest('.action-bar, .modal-back')) again.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
    });
    const c = this.activeChain();
    const s = this.selectedStruct();
    this.root.classList.toggle('dc-dock-aim', this.dockAim());
    this.syncSlim();
    if (this.phase === 'setup' && this.bayCursor && !s) { this.placeBar(this.bayBar(this.bayCursor)); this.pulseCoachTarget(); return; }
    if (!c || !s) {
      // On a touch screen there is no Tab: the empty bar is itself the button that picks a ship.
      if (this.phase === 'battle') this.root.appendChild(inputMode() === 'touch'
        ? h('button', { type: 'button', class: 'action-bar panel empty ab-pick', onclick: () => { audio.play('select'); this.selectBest(); } }, h('span', { class: 'c-player', html: icon('ship', 22) }), h('span', { class: 't-label' }, 'Pick a ship'))
        : h('div', { class: 'action-bar panel empty', title: 'Select one of your ships (Tab) to give an order' }, h('span', { class: 'c-player', html: icon('ship', 22) }), h('kbd', null, 'Tab')));
      return;
    }
    const t = TYPES_BY_ID[s.typeId];
    const mine = s.owner === YOU.id;
    const side = mine ? 'player' : 'enemy';
    const dead = c.isDestroyed(s);
    const ward = s.protectedStructId ? c.structs[s.protectedStructId] : undefined;
    const img = h('img', { alt: t.type });
    void spriteDataUrl(t.id, s.health < t.maxHealth ? 'dmg' : 'base').then((u) => { img.src = u; });
    const chips: (HTMLElement | null)[] = [
      h('span', { class: 'chip ambit-' + s.ambit, title: AMBIT_NAME[s.ambit], 'aria-label': AMBIT_NAME[s.ambit], html: icon(s.ambit, 14) }),
      DEFENSE_NAME[t.unitDefenses] ? h('span', { class: 'chip', title: DEFENSE_HINT[t.unitDefenses] || '' }, DEFENSE_NAME[t.unitDefenses]) : null,
      PASSIVE_NAME[t.passiveWeaponry] ? h('span', { class: 'chip', title: `Fires back ${t.counterAttackSameAmbit} damage in its layer / ${t.counterAttack} elsewhere` }, PASSIVE_NAME[t.passiveWeaponry]) : null,
      c.isHidden(s) ? h('span', { class: 'chip warn' }, 'Hidden') : null,
      ward && !c.isDestroyed(ward) ? h('span', { class: 'chip ' + side }, 'Guarding ' + TYPES_BY_ID[ward.typeId].type) : null,
      dead ? h('span', { class: 'chip enemy' }, 'Destroyed') : null,
    ];
    const guards = c.defendersOf(s.id).map((id) => c.structs[id]).filter((x) => x && !c.isDestroyed(x));
    const card = h('div', { class: 'unit-card' },
      h('div', { class: 'sprite big ' + side }, img),
      h('div', { class: 'col grow', style: 'gap:4px; min-width:0' },
        h('div', { class: 'unit-name t-label-lg ' + (mine ? 'c-player' : 'c-enemy') }, t.type),
        h('div', { class: 't-tiny c-hint x-only' }, t.defaultCosmeticModelNumber + ` “${t.defaultCosmeticName}” · ${t.category === 'fleet' ? 'ship' : 'planet building'}`),
        h('div', { class: 'row', title: `Health ${s.health} of ${t.maxHealth}` }, h('span', { class: 'fc-ico hp', html: icon('shield', 14) }), h('div', { class: 'pips' }, Array.from({ length: t.maxHealth }, (_, i) => h('i', { class: i < s.health ? '' : 'lost' }))), h('span', { class: 'fc-n' }, `${s.health}`)),
        h('div', { class: 'row wrap', style: 'gap:4px' }, chips),
        guards.length ? h('div', { class: 'fc-stat c-player', title: 'Guarded by ' + guards.map((g) => TYPES_BY_ID[g.typeId].type).join(', ') }, h('span', { html: icon('shield', 14) }), `×${guards.length}`) : null,
      ),
    );

    const actions: HTMLElement[] = [];
    if (this.phase === 'setup' && mine) {
      // A swaps the ship (the picker), X sets who it guards: the pad's badges, or the keys' caps.
      const fixed = !!this.gauntlet || !!this.daily;
      if (!fixed) actions.push(h('button', { class: 'btn action setup-swap', title: 'Swap this ship for another (Enter)', onclick: () => this.editAtCursor() },
        h('span', { class: 'a-top' }, face('a', '⏎'), h('span', { class: 'a-ico', html: icon('refresh', 22) })), h('span', { class: 'a-name' }, 'Swap')));
      actions.push(h('button', { class: 'btn action secondary setup-guard', title: 'Assign guard (G): pick a friend for this ship to shield', onclick: () => { this.startGuardPick(); if (this.targeting && inputMode() !== 'touch') this.cycleAim(0); } },
        h('span', { class: 'a-top' }, face('x', 'G'), h('span', { class: 'a-ico', html: icon('shield', 22) })), h('span', { class: 'a-name' }, 'Guard')));
      const du = this.draftUnit(s.id);
      if (du?.protects) actions.push(h('button', { class: 'btn ghost', onclick: () => { du.protects = null; this.renderSetup(); void this.buildPreview(); } }, 'Clear guard'));
    }
    if (this.phase === 'battle' && mine && !dead && this.spectate) {
      actions.push(h('div', { class: 'dc-auto', title: 'Spectating: the computer (Hard) flies your fleet. Watch the lock-on lines.' }, h('span', { html: icon('robot', 22) }), 'Auto'));
    }
    if (this.phase === 'battle' && mine && !dead && !this.spectate) {
      const charge = this.session?.chargeAtNext() ?? 0;
      // A pad's A arms the first weapon with something in reach: its badge goes there.
      const padA = this.weaponsReady(s).findIndex((w) => w.ws === this.armFirst(s)?.ws);
      this.weaponsReady(s).forEach((w, i) => {
        const label = weaponLabel(t, w.ws);
        const ctl = controlName(weaponField(t, w.ws, 'Control'));
        const shots = weaponField(t, w.ws, 'Shots') || 1;
        const dmg = weaponField(t, w.ws, 'Damage') || 0;
        const disabled = !w.targets.length;
        const active = this.targeting?.kind === 'attack' && this.targeting.ws === w.ws;
        actions.push(h('button', {
          class: 'btn action weapon' + (active ? ' active' : '') + (charge < w.cost ? ' short' : ''), disabled,
          title: disabled ? 'No enemy in reach' : `${label} (${i + 1}): ${ctl} · reaches ${reachLabel(t, w.ws)} · ${shots > 1 ? shots + '×' : ''}${dmg} damage · needs ${w.cost} charge (firing empties it)`,
          'aria-label': `${label}: ${shots > 1 ? shots + ' shots of ' : ''}${dmg} damage, needs ${w.cost} charge`,
          onclick: () => this.beginAttack(w.ws),
        // Every verb is its icon over one word (MISSILE, GUARD, MOVE), then its numbers: damage and ⚡.
        }, h('span', { class: 'a-top' }, inputMode() === 'pad' ? (i === padA ? face('a', null) : null) : i ? (inputMode() === 'keys' ? h('kbd', { 'aria-hidden': 'true' }, '2') : null) : face('a', '1'), h('span', { class: 'a-ico', html: icon('missile', 22) })),
          h('span', { class: 'a-name' }, weaponWord(label)),
          h('span', { class: 'a-nums' }, h('span', { class: 'a-dmg' }, h('span', { html: icon('boom', 14) }), `${shots > 1 ? shots + '×' : ''}${dmg}`), h('span', { class: 'a-cost', title: 'Needs this much charge' }, `${w.cost}⚡`))));
      });
      if (t.canDefend) {
        const cost = t.defendChangeCharge;
        actions.push(h('button', { class: 'btn action secondary' + (this.targeting?.kind === 'guard' ? ' active' : ''), title: `Guard (G): block shots aimed at a friend, and fire back · needs ${cost} charge`, 'aria-label': `Guard a friend, needs ${cost} charge`, onclick: () => this.startGuardPick() },
          h('span', { class: 'a-top' }, face('x', 'G'), h('span', { class: 'a-ico', html: icon('shield', 22) })), h('span', { class: 'a-name' }, 'Guard'), h('span', { class: 'a-nums' }, h('span', { class: 'a-cost' }, `${cost}⚡`))));
        if (s.protectedStructId) actions.push(h('button', { class: 'btn action ghost stand-down', title: `Stand down: stop guarding${ward && !c.isDestroyed(ward) ? ' the ' + TYPES_BY_ID[ward.typeId].type : ''} · needs ${cost} charge`, 'aria-label': `Stand down, needs ${cost} charge`, onclick: () => this.order({ '@type': '/structs.structs.MsgStructDefenseClear', defenderStructId: s.id }, cost, `${t.type} stops guarding`) },
          h('span', { class: 'a-top' }, h('span', { class: 'a-ico', html: UNGUARD(22) })), h('span', { class: 'a-name' }, 'Stand down'), h('span', { class: 'a-nums' }, h('span', { class: 'a-cost' }, `${cost}⚡`))));
      }
      if (t.movable) {
        // The Command Ship's drive: a card like the others, with a button per battleground.
        const cost = t.moveCharge;
        const drift = h('div', { class: 'drift' + (charge < cost ? ' short' : ''), title: `${t.drive_label || 'Drift'}: ${t.drive_description || 'move to another layer'}` },
          h('div', { class: 'row', style: 'gap:6px' }, face('y', 'D'), h('span', { class: 'a-ico', html: icon('rank', 18) }), h('span', { class: 'a-name' }, 'Move')),
          h('div', { class: 'row', style: 'gap:3px' }, AMBITS.filter((a) => (t.possibleAmbit & AMBIT_FLAG[a]) !== 0).map((a) => h('button', {
            class: 'btn ghost mini ambit-' + a + (a === s.ambit ? ' here' : '') + (this.phase === 'battle' && a === this.stuckLayer ? ' dc-go-layer' : ''), disabled: a === s.ambit, title: a === s.ambit ? 'It is here now' : `Drift to ${AMBIT_NAME[a]}`,
            'aria-label': `Drift to ${AMBIT_NAME[a]}`,
            onclick: () => { this.coachDone('drift'); this.order({ '@type': '/structs.structs.MsgStructMove', structId: s.id, locationType: 'fleet', ambit: a, slot: 0 }, cost, `Command Ship drifts to ${AMBIT_NAME[a]}`); },
          }, h('span', { html: icon(a, 18) })))),
          h('span', { class: 'a-cost' }, `${cost}⚡`));
        actions.push(drift);
      }
      if (t.unitDefenses === 'stealthMode') {
        const hidden = c.isHidden(s);
        const cost = t.stealthActivateCharge;
        actions.push(h('button', { class: 'btn action secondary', title: `${hidden ? 'Drop stealth' : 'Stealth: hide from other layers'} (S) · needs ${cost} charge`, onclick: () => this.order(hidden ? { '@type': '/structs.structs.MsgStructStealthDeactivate', structId: s.id } : { '@type': '/structs.structs.MsgStructStealthActivate', structId: s.id }, cost, hidden ? 'Drop stealth' : 'Engage stealth') },
          h('span', { class: 'a-top' }, inputMode() === 'keys' ? h('kbd', { 'aria-hidden': 'true' }, 'S') : null, h('span', { class: 'a-ico', html: icon('eye', 22) })), h('span', { class: 'a-name' }, hidden ? 'Uncloak' : 'Stealth'), h('span', { class: 'a-nums' }, h('span', { class: 'a-cost' }, `${cost}⚡`))));
      }
    }
    if (!mine && !dead) {
      const w = (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).filter((ws) => hasWeapon(t, ws));
      // Their threat in numbers: each weapon's damage, and what it fires back. The words are in the titles.
      actions.push(h('div', { class: 'col enemy-intel' },
        w.map((ws) => h('div', { class: 'ei-row', title: `${weaponLabel(t, ws)} · ${controlName(weaponField(t, ws, 'Control'))} · reaches ${reachLabel(t, ws)}` }, h('span', { class: 'c-enemy', html: icon('target', 14) }), h('span', null, weaponLabel(t, ws)), h('b', { class: 'c-enemy' }, `${(weaponField(t, ws, 'Shots') || 1) > 1 ? weaponField(t, ws, 'Shots') + '×' : ''}${weaponField(t, ws, 'Damage')}`))),
        h('div', { class: 'ei-row', title: `Fires back ${t.counterAttackSameAmbit} damage at attackers in its layer, ${t.counterAttack} at others.${DEFENSE_HINT[t.unitDefenses] ? ' ' + DEFENSE_HINT[t.unitDefenses] : ''}` }, h('span', { class: 'c-enemy', html: icon('replay', 14) }), h('b', null, `${t.counterAttackSameAmbit} / ${t.counterAttack}`))));
    }
    // While aiming: if their Command Ship is in reach, say so (taking it down wins the battle).
    const cmdInReach = this.targeting?.kind === 'attack' && mine && (this.weaponsReady(s).find((w) => w.ws === (this.targeting as { ws: WeaponSystem }).ws)?.targets || []).some((x) => x.typeId === COMMAND_SHIP_ID && !c.isDestroyed(x) && !this.fullyBlocked(x.id));
    // Firing with the Command Ship draws the counter-attacks onto it: said on its card the first few times.
    const cmdWarn = mine && s.typeId === COMMAND_SHIP_ID && this.targeting?.kind === 'attack' && this.cmdWarnShown() ? h('span', { class: 'chip enemy cmd-warn', title: 'Every ship it shoots fires back at your Command Ship. Fire with your other ships, and guard this one.' }, '⚠ Hits back') : null;
    if (cmdWarn) card.querySelector('.unit-name')?.after(cmdWarn);
    const docked = this.dockAim() && mine;
    const hint = this.targeting && !docked ? h('div', { class: 'targeting-hint t-label' + (cmdInReach ? ' win' : ''), title: this.targeting.kind === 'attack' ? say({ keys: 'Click an enemy in red brackets to fire · Esc to cancel', pad: 'The d-pad picks an enemy in red brackets, A fires · B cancels', touch: 'Tap an enemy in red brackets, then Fire' }) : say({ keys: 'Click a friend to guard · Esc to cancel', pad: 'The d-pad picks a friend, A guards it · B cancels', touch: 'Tap a friend to guard it' }) },
      h('span', { html: icon(this.targeting.kind === 'attack' ? 'target' : 'shield', 16) }), this.targeting.kind === 'attack' ? (cmdInReach ? 'Command Ship in reach!' : 'Fire!') : 'Guard who?', face('b', 'Esc')) : null;
    this.dockKey = '';
    const bar = h('div', { class: 'action-bar panel ' + side, 'data-ship': this.selected || '' }, docked ? this.aimCard(cmdInReach) : card, h('div', { class: 'actions' }, actions), hint);
    this.placeBar(bar);
    this.pulseCoachTarget();
  }

  /** The bar goes over the field, except in setup on an upright phone: there it takes the START row's
   * place in the setup sheet (with Done to go back to it), so a tap meant for START never lands on Swap. */
  private placeBar(bar: HTMLElement) {
    const sheet = this.phase === 'setup' && matchMedia(TABBAR_QUERY).matches ? this.root.querySelector<HTMLElement>('.setup-panel') : null;
    if (!sheet) { this.root.appendChild(bar); return; }
    bar.classList.add('in-sheet');
    bar.querySelector('.actions')?.appendChild(h('button', { class: 'btn ghost setup-done', title: 'Done: back to Start', onclick: () => { audio.play('select'); this.select(null); } }, h('span', { html: icon('check', 18) }), 'Done'));
    sheet.insertBefore(bar, sheet.querySelector('.setup-foot'));
  }

  /* ── TV setup with a pad or keys: while the cursor is on the board, the panel folds to a strip
   * (its heading and START) so the board gets the room; it opens again when the cursor leaves. ── */
  private slimSetup = false;
  /** Pad or keys moved the setup cursor (a click or tap leaves the panel as it is). */
  private boardKeys = false;
  private syncSlim() {
    const short = window.innerHeight <= 560 && (window.innerWidth <= 760 || matchMedia('(pointer: coarse)').matches);
    const want = this.phase === 'setup' && short && this.boardKeys && this.onBoard();
    const panel = this.root.querySelector('.setup-panel');
    panel?.classList.toggle('slim', want);
    if (want === this.slimSetup) return;
    this.slimSetup = want;
    this.fitCamera();
  }

  /** A short screen played with a pad or keys (the TV) has no field to spare while aiming: the target's
   * forecast sits in the action bar, where the ship's card was, and nothing floats over the field. */
  private dockAim() { return this.phase === 'battle' && !!this.targeting && window.innerHeight <= 560 && inputMode() !== 'touch'; }
  private dockKey = '';

  /** The docked aim card: what the cursor is on and the forecast in numbers, then how to fire. */
  private aimCard(cmdInReach = false): HTMLElement {
    const c = this.activeChain();
    const kind = this.targeting?.kind;
    const id = this.aimId || this.hovered;
    const u = c && id && this.validTargets().has(id) ? c.structs[id] : null;
    const t = u ? TYPES_BY_ID[u.typeId] : null;
    const p = u && kind === 'attack' ? this.forecast(u.id) : null;
    const gN = u && u.owner !== YOU.id ? this.guardsOf(u.id).length : 0;
    const blockedAll = !!u && kind === 'attack' && this.fullyBlocked(u.id);
    // Icon and number (the word is the cell's title: the strip has room for numbers, not sentences).
    const cell = (ico: string, label: string, value: string, cls = '') => h('div', { class: 'pf-row ' + cls, title: `${label} ${value}` }, h('span', { class: 'pf-ico', html: icon(ico, 15) }), h('span', { class: 'pf-k' }, label), h('b', null, value));
    const step = this.coachKey === 'aim' && this.coachEl?.isConnected ? h('span', { class: 'coach-dots', 'aria-hidden': 'true' }, h('i', { class: 'on' }), h('i', { class: 'on' }), h('i')) : null;
    const sel = this.selectedStruct();
    // Firing with the Command Ship: the card's red edge and a ⚠ on its "Hits back" say what that costs.
    const risk = kind === 'attack' && sel?.typeId === COMMAND_SHIP_ID && this.cmdWarnShown();
    return h('div', { class: 'unit-card aim-card' + (kind === 'guard' ? ' guard' : '') + (risk ? ' cmd-risk' : '') + (u?.typeId === COMMAND_SHIP_ID || (!u && cmdInReach) ? ' win' : ''), title: risk ? 'Every ship your Command Ship shoots fires back at it' : null },
      h('div', { class: 'aim-head' },
        h('span', { class: 'aim-ico', html: icon(u?.typeId === COMMAND_SHIP_ID ? 'crown' : kind === 'guard' ? 'shield' : 'target', 18) }),
        h('span', { class: 'aim-name' }, t ? t.type : kind === 'guard' ? 'Guard who?' : cmdInReach ? 'Command Ship in reach!' : 'Fire!'),
        u ? h('div', { class: 'pips' }, Array.from({ length: t!.maxHealth }, (_, i) => h('i', { class: i < u.health ? '' : 'lost' }))) : null),
      p ? h('div', { class: 'dc-forecast aim-forecast' },
        cell('target', 'Hit', pct(p.hit!), 'c-player'), cell('boom', 'Damage', p.damage!.toFixed(1)), cell('star', 'Kill', pct(p.kill!), 'c-warn pf-kill'),
        p.counter! > 0 ? cell('replay', 'Hits back', '−' + p.counter!.toFixed(1), 'c-enemy pf-back') : p.blocked! > 0 ? cell('shield', 'Blocked', pct(p.blocked!)) : null)
        : kind === 'guard' && u ? h('div', { class: 't-tiny c-player' }, 'Blocks shots, fires back') : null,
      h('div', { class: 'aim-how' }, step, gN ? h('span', { class: 'dc-guarded', title: `${gN} guard${gN === 1 ? '' : 's'}: shots at it hit a guard first` }, h('span', { html: icon('shield', 12) }), `×${gN}`) : null,
        blockedAll ? h('span', null, say({ pad: 'Blocked: A aims at its guard', keys: 'Blocked: Enter aims at its guard', touch: '' })) : h('span', null, say(kind === 'guard' ? { pad: 'D-pad picks, A guards', keys: '←→ pick · Enter guards', touch: '' } : { pad: 'D-pad picks, A fires', keys: '←→ pick · Enter fires', touch: '' })), face('b', 'Esc')));
  }

  /** Bring the docked card up to date (the cursor, the mouse or the turn moved on), and tell a screen
   * reader once per new target, from one quiet status line that stays put (the card itself is rebuilt
   * every turn, so it carries no live region). */
  private refreshDock() {
    if (!this.dockAim()) return;
    const c = this.activeChain();
    const id = this.aimId || this.hovered;
    const key = [id, c?.height, this.selected, this.targeting?.kind === 'attack' ? this.targeting.ws : 'guard', this.coachKey, inputMode()].join('|');
    if (key === this.dockKey) return;
    this.dockKey = key;
    this.root.querySelector('.action-bar .aim-card')?.replaceWith(this.aimCard());
    const u = c && id && this.validTargets().has(id) ? c.structs[id] : null;
    const said = u ? `${this.targeting?.kind === 'guard' ? 'Guard' : 'Aiming at'} ${TYPES_BY_ID[u.typeId].type}` : '';
    if (said && said !== this.srSaid) {
      this.srSaid = said;
      if (!this.srAim?.isConnected) { this.srAim = h('div', { class: 'dc-sr', role: 'status', 'aria-live': 'polite' }); this.root.appendChild(this.srAim); }
      const p = this.targeting?.kind === 'attack' ? this.forecast(u!.id) : null;
      this.srAim.textContent = p ? `${said}: hit ${pct(p.hit!)}, damage ${p.damage!.toFixed(1)}, kill ${pct(p.kill!)}` : said;
    }
  }
  private srAim: HTMLElement | null = null;
  private srSaid = '';

  /** How many fights have armed the Command Ship's weapon (the warning shows for the first three). */
  private cmdArms = (() => { try { return Number(localStorage.getItem('structs.warn.cmdfire') || 0); } catch { return 0; } })();
  private cmdArmCounted: object | null = null;
  private countCmdArm() {
    if (this.cmdArmCounted === this.session) return;
    this.cmdArmCounted = this.session;
    this.cmdArms++;
    try { localStorage.setItem('structs.warn.cmdfire', String(this.cmdArms)); } catch { /* this visit only */ }
  }
  private cmdWarnShown() { return this.cmdArms <= 3; }

  /** Say something to a screen reader, from one quiet status line that stays put. */
  private srSay(text: string) {
    if (!this.srAim?.isConnected) { this.srAim = h('div', { class: 'dc-sr', role: 'status', 'aria-live': 'polite' }); this.root.appendChild(this.srAim); }
    this.srAim.textContent = text;
  }

  /** An order's call: pictures, not a sentence over the field. ✓ (or ↺ replaced, ⏳ waiting for ⚡) with
   * the shooter → what it does → its target, hung under the HUD (inside it, so a taller turn card pushes
   * it down and it never covers Pause or Retreat). A wide screen adds the words; a small one keeps them
   * in the title, the battle log and the screen reader's line. */
  private orderCall(msg: Msg, mark: '✓' | '↺' | '⏳', label: string, cost = 0) {
    const small = window.innerWidth <= 760 || window.innerHeight <= 560;
    const c = this.chain;
    const m = msg as unknown as Record<string, unknown>;
    const type = String(m['@type']);
    const sprite = (id: unknown) => {
      const st = c && typeof id === 'string' ? c.structs[id] : undefined;
      if (!st) return null;
      const img = h('img', { alt: '' });
      void spriteDataUrl(st.typeId).then((u) => { img.src = u; });
      return h('span', { class: 'dc-order-ship ' + (st.owner === YOU.id ? 'player' : 'enemy') }, img);
    };
    const verb = (ico: string) => h('span', { class: 'dc-order-verb', html: icon(ico, 16) });
    const parts = type.endsWith('MsgStructAttack') ? [sprite(m.operatingStructId), verb('missile'), sprite((m.targetStructId as string[])[0])]
      : type.endsWith('MsgStructDefenseSet') ? [sprite(m.defenderStructId), verb('shield'), sprite(m.protectedStructId)]
      : type.endsWith('MsgStructDefenseClear') ? [sprite(m.defenderStructId), verb('back')]
      : type.endsWith('MsgStructMove') ? [sprite(m.structId), verb('rank'), h('span', { class: 'dc-order-verb', html: icon(String(m.ambit), 16) })]
      : [sprite(m.structId), verb('eye')];
    this.root.querySelectorAll('.dc-order').forEach((n) => n.remove());
    const el = h('div', { class: 'dc-order' + (mark === '⏳' ? ' held' : ''), title: label, 'aria-hidden': 'true' },
      h('b', { class: 'dc-order-mark' }, mark), ...parts, mark === '⏳' ? h('span', { class: 'a-cost' }, `${cost}⚡`) : null,
      small ? null : h('span', { class: 'dc-order-words' }, label));
    // Docked just above the verbs' left end, where no hull stands (the HUD's edge sat on the space row).
    this.root.appendChild(el);
    const bar = this.root.querySelector('.action-bar')?.getBoundingClientRect();
    const root = this.root.getBoundingClientRect();
    if (bar) { el.classList.add('docked'); el.style.left = Math.round(bar.left - root.left + 8) + 'px'; el.style.top = Math.round(bar.top - root.top - el.offsetHeight - 6) + 'px'; }
    else el.style.top = '120px';
    this.srSay(mark === '⏳' ? `${label}: waiting for ${cost} charge` : label);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, mark === '⏳' ? 2000 : 1500);
  }

  /** The aimed shot's forecast (40 forks of the chain), cached per turn. */
  private forecast(targetId: string) {
    const c = this.activeChain();
    if (!c || this.targeting?.kind !== 'attack' || !this.selected) return null;
    const msg: Msg = { '@type': '/structs.structs.MsgStructAttack', operatingStructId: this.selected, targetStructId: [targetId], weaponSystem: this.targeting.ws };
    const key = this.selected + targetId + this.targeting.ws + c.height;
    let p = this.predictCache.get(key);
    if (!p) { p = predictAttack(c, msg, 40); this.predictCache.set(key, p); }
    return p.error == null && 'hit' in p ? p : null;
  }

  /** The bar for an empty bay under the setup cursor: a "+" and Add (A). */
  private bayBar(b: { ambit: Ambit; slot: number }) {
    return h('div', { class: 'action-bar panel player bay-bar', 'data-ship': '' },
      h('div', { class: 'unit-card' }, h('div', { class: 'sprite big player bay-plus', html: icon('build', 30) }),
        h('div', { class: 'col grow', style: 'gap:4px; min-width:0' }, h('div', { class: 'unit-name t-label-lg c-player' }, 'Empty bay'),
          h('div', { class: 'row', title: AMBIT_NAME[b.ambit] }, h('span', { class: 'chip ambit-' + b.ambit, html: icon(b.ambit, 14) }), h('span', { class: 't-tiny c-hint' }, `${AMBIT_NAME[b.ambit]} · ${b.slot + 1}`)))),
      h('div', { class: 'actions' }, h('button', { class: 'btn action setup-add', title: 'Add a ship here (Enter)', onclick: () => this.editAtCursor() },
        h('span', { class: 'a-top' }, face('a', '⏎'), h('span', { class: 'a-ico', html: icon('build', 22) })), h('span', { class: 'a-name' }, 'Add'))));
  }

  private draftUnit(structId: string) { const k = this.preview?.reverse[structId]; return k ? this.draft.find((u) => u.id === k) : undefined; }

  private beginAttack(ws: WeaponSystem) {
    this.releaseBarFocus();
    const s = this.selectedStruct();
    if (!s) return;
    if (this.targeting?.kind === 'attack' && this.targeting.ws === ws) { this.targeting = null; this.clearAim(); }
    else {
      let targets = this.weaponsReady(s).find((w) => w.ws === ws)?.targets || [];
      // Nothing in reach of this weapon: the other one, if it has something.
      if (!targets.length) { const alt = this.armFirst(s); if (alt?.targets.length) { ws = alt.ws; targets = alt.targets; } }
      if (!targets.length) { audio.play('deny'); toast('Nothing in reach of that weapon', 'warn', 1600); return; }
      this.targeting = { kind: 'attack', ws };
      if (s.typeId === COMMAND_SHIP_ID && s.owner === YOU.id) this.countCmdArm();
      this.coachDone('arm');
      // Step 2 follows step 1 (done or dismissed), once.
      if (this.coachSeen('arm') && !this.spectate) this.coach('aim', 'Step 2 of 3 · Fire', { pad: 'D-pad picks, A fires', keys: 'Click a ship in red brackets (or Enter)', touch: 'Tap a ship in red brackets, then Fire' }, true);
      audio.play('select');
    }
    this.predictCache.clear();
    this.refreshSelectionVisuals();
    this.renderActionBar();
  }

  private startGuardPick() {
    this.releaseBarFocus();
    const s = this.selectedStruct();
    if (!s || s.owner !== YOU.id) return;
    if (!TYPES_BY_ID[s.typeId].canDefend) { toast('This struct cannot guard', 'warn'); return; }
    this.targeting = this.targeting?.kind === 'guard' ? null : { kind: 'guard' };
    // The guard step's pick starts on your Command Ship (a pad's or keys' A then guards it).
    if (this.targeting && this.coachKey === 'guard') {
      const c = this.activeChain();
      const cmd = c && Object.values(c.structs).find((x) => x.owner === YOU.id && x.typeId === COMMAND_SHIP_ID && !c.isDestroyed(x));
      if (cmd && cmd.id !== s.id) this.aimId = cmd.id;
    }
    audio.play('select');
    this.refreshSelectionVisuals();
    this.renderActionBar();
  }

  /* ── Field manual: one-time coaching for a first battle ───────────────── */
  private coachKey = '';
  /** The tip on show waits for the player (a tutorial step): other tips don't replace it. */
  private coachStay = false;
  /** Seen this visit too, so blocked storage doesn't repeat tips all battle long. */
  private coachMem = new Set<string>();
  private coachSeen(key: string) { if (this.coachMem.has(key)) return true; try { return !!localStorage.getItem('structs.coach.' + key); } catch { return false; } }
  private coachMark(key: string) { try { localStorage.setItem('structs.coach.' + key, '1'); } catch { this.coachMem.add(key); /* remembered for this visit */ } }
  /** The player did what the coach suggested: the step is done (for good) and lets go. */
  private coachDone(key: string) {
    if (this.coachKey !== key) return;
    if (this.coachStay) this.coachMark(key);
    this.clearCoach();
  }
  /** Take down whatever tip is up (leaving the battle, a replay, the debrief). A step left
   * undone stays unmarked, so it comes back next battle. */
  private clearCoach() { this.coachEl?.remove(); this.coachEl = null; this.coachKey = ''; this.coachStay = false; window.removeEventListener('resize', this.coachResize); this.pulseCoachTarget(); }
  private coachResize = () => requestAnimationFrame(() => this.placeCoach());

  /** Show, don't tell: while a step is up, the thing it asks for pulses (the weapon to arm). */
  private pulseCoachTarget() {
    // The step's words follow the input in use (a pad picked up, a mouse moved); the guard step's second
    // half shows once Guard is armed.
    const line = this.coachSay && this.coachEl?.querySelector('.coach-text');
    const words = this.coachKey === 'guard' && this.targeting?.kind === 'guard' ? { pad: 'Now pick your Command Ship, A', keys: 'Now click your Command Ship', touch: 'Now tap your Command Ship' } : this.coachSay;
    if (line && words) { const t = say(words); if (line.textContent !== t) line.textContent = t; }
    this.root.querySelectorAll('.dc-pulse').forEach((n) => n.classList.remove('dc-pulse'));
    if (!this.coachEl?.isConnected) return;
    const want = this.coachKey === 'arm' || this.coachKey === 'guard' || this.coachKey === 'drift' || this.coachKey === 'stuck' ? COACH_ANCHOR[this.coachKey] : '';
    if (want) this.root.querySelector(want)?.classList.add('dc-pulse');
    // The bar is rebuilt every turn (and the pill comes and goes): the callout follows its control.
    this.placeCoach();
  }

  /** Pin the callout to its control: just above a button in the action bar (its pointer down at it),
   * or just under a meter in the HUD (pointer up). Never over the HUD's cards; on screen always. */
  /** The callout couldn't be measured (hidden while the picker is open): place it once it shows. */
  private coachDirty = false;
  private placeCoach() {
    const el = this.coachEl;
    if (!el?.isConnected) return;
    if (!el.offsetWidth) { this.coachDirty = true; return; }
    this.coachDirty = false;
    const sel = COACH_ANCHOR[this.coachKey];
    const anchor = sel ? this.root.querySelector<HTMLElement>(sel) : null;
    const a = anchor && anchor.getClientRects().length ? anchor.getBoundingClientRect() : null;
    const root = this.root.getBoundingClientRect();
    const hud = this.root.querySelector('.battle-top')?.getBoundingClientRect();
    const bar = this.root.querySelector('.action-bar')?.getBoundingClientRect();
    // The "Fire! / Command Ship in reach" pill floats above the bar (outside its box): stay above it too.
    const pillEl = this.root.querySelector<HTMLElement>('.action-bar .targeting-hint');
    const pill = pillEl && pillEl.getClientRects().length && getComputedStyle(pillEl).display !== 'none' ? pillEl.getBoundingClientRect() : null;
    const vw = window.innerWidth, gap = 14;
    const w = el.offsetWidth, hh = el.offsetHeight;
    let below = !!a && a.top + a.height / 2 < window.innerHeight / 2;
    const cx = a ? a.left + a.width / 2 : vw / 2;
    let x = clamp(cx - w / 2, 8, Math.max(8, vw - 8 - w));
    const floor = hud ? hud.bottom + 8 : root.top + 8;
    let y = below ? a!.bottom + gap : Math.min(a ? a.top : bar ? bar.top : window.innerHeight - 160, bar?.top ?? Infinity, pill ? pill.top : Infinity) - gap - hh;
    y = Math.max(y, floor);
    // "Add ships" never covers the setup panel or the + bays it asks for: beside a side panel it keeps to
    // the board (its left edge past the panel); over a phone's bottom sheet it sits on the sheet's top
    // edge, its pointer up at the bay, the board above it clear.
    const panel = this.coachKey === 'fill' ? this.root.querySelector('.setup-panel')?.getBoundingClientRect() : null;
    if (panel && panel.width > vw * 0.6) { below = true; y = panel.top + 8; }
    else if (panel && panel.right < vw * 0.6) x = clamp(cx - w / 2, panel.right + 8, Math.max(panel.right + 8, vw - 8 - w));
    el.style.left = Math.round(x - root.left) + 'px';
    el.style.top = Math.round(y - root.top) + 'px';
    el.style.setProperty('--tip-x', Math.round(clamp(cx - x, 22, w - 22)) + 'px');
    el.classList.toggle('below', below);
    el.classList.toggle('no-tip', !a);
  }

  /** A tip, once ever. `stay`: a tutorial step that waits for the player (marked done when they do
   * it or press Got it); a plain tip is marked when shown and fades after 16 s. */
  private coachSay: Record<'pad' | 'keys' | 'touch', string> | null = null;
  private coach(key: string, title: string, text: string | Record<'pad' | 'keys' | 'touch', string>, stay = false, again = false) {
    if ((!again && this.coachSeen(key)) || (this.coachKey === key && this.coachEl?.isConnected)) return;
    // A waiting step keeps the floor; a plain tip comes back another time.
    if (!stay && this.coachStay && this.coachEl?.isConnected) return;
    if (!stay) this.coachMark(key);
    this.coachEl?.remove();
    // A callout, not a paragraph: step dots and one word, one short line, and OK, with a pointer at
    // the control it is about (placeCoach).
    const step = /^Step (\d) of (\d) · (.*)$/.exec(title);
    const el = h('div', { class: 'coach panel neutral dc-callout k-' + key + (stay ? ' wait' : '') },
      h('i', { class: 'coach-tip', 'aria-hidden': 'true' }),
      h('div', { class: 'coach-head' },
        step ? h('div', { class: 'coach-dots', role: 'img', 'aria-label': `Step ${step[1]} of ${step[2]}` }, ...Array.from({ length: Number(step[2]) }, (_, i) => h('i', { class: i < Number(step[1]) ? 'on' : '' }))) : null,
        h('div', { class: 'coach-title' }, step ? step[3] : title)),
      h('div', { class: 'coach-text' }, typeof text === 'string' ? text : say(text)),
      h('button', { class: 'btn solid coach-ok', title: 'Got it', onclick: () => { if (this.coachEl === el) this.coachDone(key); else el.remove(); } }, 'OK'));
    // Announced as it appears, for screen readers (the battle waits on it).
    el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    this.coachSay = typeof text === 'string' ? null : text;
    this.root.appendChild(el);
    this.coachEl = el;
    this.coachKey = key;
    this.coachStay = stay;
    this.pulseCoachTarget();
    // A window resized (a phone turned) moves the controls: the callout follows.
    window.addEventListener('resize', this.coachResize);
    if (!stay) setTimeout(() => { el.remove(); if (this.coachEl === el) this.clearCoach(); }, 16000);
  }

  /* ── Log ──────────────────────────────────────────────────────────────── */
  private logTx(height: number, tx: Block['txs'][number]) {
    if (!this.logEl) return;
    const c = this.chain!;
    const who = tx.signer === YOU.id ? 'You' : 'Computer';
    const tone = tx.signer === YOU.id ? 'c-player' : 'c-enemy';
    // Rows are HTML (for <b>); every value that came from the chain or a link is escaped.
    const name = (id: string) => { const s = c.structs[id]; return esc(s ? TYPES_BY_ID[s.typeId].type : id); };
    const rows: string[] = [];
    if (!tx.ok) rows.push(`order failed — ${esc(humanError(tx.error || ''))}`);
    for (const e of tx.events) {
      const d = e.detail;
      if (e.category === 'struct_attack') {
        let dmg = 0, ev = false, bl = '', killed: string[] = [], countered = 0;
        for (const r of d.eventAttackShotDetail) {
          dmg += Number(r.damage || 0);
          if (r.evaded) ev = true;
          if (r.blocked) bl = name(r.blockedByStructId);
          if (r.targetDestroyed) killed.push(name(r.targetStructId));
          if (r.blockerDestroyed) killed.push(name(r.blockedByStructId));
          countered += Number(r.targetCounteredDamage || 0);
          for (const x of r.eventAttackDefenderCounterDetail || []) countered += Number(x.counterDamage || 0);
          if (r.targetCounterDestroyedAttacker || (r.eventAttackDefenderCounterDetail || []).some((x: any) => x.counterDestroyedAttacker)) killed.push(esc(d.attackerStructType));
        }
        killed = [...new Set(killed)];
        const tgt = name(d.eventAttackShotDetail[0]?.targetStructId);
        let line = `${esc(d.attackerStructType)} ▸ ${tgt}: ${ev ? 'evaded' : dmg + ' dmg'}`;
        if (bl) line += `, blocked by ${bl}`;
        if (countered) line += `, countered ${countered}`;
        if (killed.length) line += ` — <b>destroyed ${killed.join(', ')}</b>`;
        rows.push(line);
      } else if (e.category === 'struct_defense_add') rows.push(`${name(d.defender_struct_id)} guards ${name(d.protected_struct_id)}`);
      else if (e.category === 'struct_defense_remove' && tx.type.endsWith('DefenseClear')) rows.push(`${name(d.defender_struct_id)} stands down`);
      else if (e.category === 'struct_move') rows.push(`${name(d.struct_id)} drifts to ${esc(d.ambit)}`);
      else if (e.category === 'struct_status' && ((d.status ^ d.status_old) & 16)) rows.push(`${name(d.struct_id)} ${(d.status & 16) ? 'goes dark' : 'is revealed'}`);
      else if (e.category === 'raid_status') rows.push(`<b>fleet ${esc(d.fleet_id)} defeated</b>`);
    }
    for (const r of rows) {
      // Turns since the battle began (a replay without a live session keeps the block height).
      const when = this.session ? [h('span', { class: 'x-only' }, '#' + height), h('span', { class: 's-only' }, 'T' + (height - this.session.startHeight))] : ['#' + height];
      const row = h('div', { class: 'log-row' }, h('span', { class: 'when num' }, ...when), h('span', { class: 'what' }, h('span', { class: 'tag ' + tone }, who), h('span', { html: r })));
      this.logEl.appendChild(row);
    }
    while (this.logEl.children.length > 200) this.logEl.firstElementChild?.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /* ── Debrief ──────────────────────────────────────────────────────────── */
  private showDebrief(o: Outcome) {
    if (!this.session) return;
    this.phase = 'debrief';
    holdRewards(false);
    this.clearCoach();
    audio.setIntensity(0.3);
    const s = this.session;
    const won = o.winner === 'you', draw = o.winner === 'draw';
    banner(won ? 'VICTORY' : draw ? 'STALEMATE' : 'DEFEAT', won ? 'ENEMY FLEET BROKEN' : draw ? 'NEITHER FLEET CAN FINISH THE OTHER' : 'YOUR FLEET FALLS BACK', won ? 'player' : draw ? 'neutral' : 'enemy', 2400);
    audio.stinger(won ? 'secure' : draw ? 'alpha' : 'vulnerable', 0.7);
    const standing = s.standing();
    const blocks = o.height - s.startHeight;
    const line = (won ? BATTLE_LINES.win : draw ? BATTLE_LINES.draw : BATTLE_LINES.lose)[0];
    // A results screen, not a report: the call, stars for how cleanly it was won, three numbers.
    const kept = (standing[YOU.id] || 0) / Math.max(1, s.fielded[YOU.id] || 1);
    const stars = won ? 1 + (kept >= 0.5 ? 1 : 0) + (kept >= 0.8 ? 1 : 0) : 0;
    // Every fight flown pays a little (a win more, each star more), so playing again always counts.
    // The bar starts where it was and fills once the results are up.
    const fromPct = Math.round(record.progress * 100), fromRank = record.rank;
    // A loss still pays for the fight put up: each enemy ship destroyed, and each gauntlet round reached.
    const downed = Math.max(0, (s.fielded[CPU.id] || 0) - (standing[CPU.id] || 0));
    const effort = 5 + (draw ? 5 : 0) + Math.min(30, 3 * downed) + (this.gauntlet ? 10 * Math.max(0, this.gauntlet.round - 1) : 0);
    if (!this.spectate && !this.paid.has(s)) { this.paid.add(s); record.gain(won ? 25 + 5 * stars : effort); this.noteRung(won); }
    const big = (ico: string, value: string, title: string, cls = '') => h('div', { class: 'db-stat ' + cls, title }, h('span', { class: 'db-ico', html: icon(ico, 26) }), h('b', null, value));
    // What the fight earned, and the rank bar filling: lessons and missions it finished pay in
    // moments after the last shot, so the row keeps up while the results are open.
    const xpRow = h('div', { class: 'db-xp' });
    const paintXp = (pct = Math.round(record.progress * 100)) => {
      const gained = record.r.xp - this.xpAtStart;
      xpRow.replaceChildren(h('span', { class: 'db-xp-n', html: icon('star', 18) }, gained > 0 ? `+${gained} XP` : `${record.r.xp} XP`),
        h('span', { class: 'db-xp-bar', title: `${RANKS[record.rank]} · ${Math.round(record.progress * 100)}% to ${RANKS[record.rank + 1] || 'the top'}` }, h('i', { style: `width:${pct}%` })),
        h('span', { class: 'db-xp-rank' }, RANKS[record.rank]));
    };
    paintXp(record.rank === fromRank ? fromPct : 0);
    setTimeout(() => { const bar = xpRow.querySelector<HTMLElement>('.db-xp-bar i'); if (bar) bar.style.width = Math.round(record.progress * 100) + '%'; }, 700);
    // (onChange calls back at once: that first call is skipped, so the bar can fill from where it was.)
    let first = true;
    const offXp = record.onChange(() => { if (first) { first = false; return; } if (!xpRow.isConnected && xpRow.dataset.mounted) { offXp(); return; } paintXp(); });
    const row = (label: string, a: string | number, b: string | number, cls = '') => h('tr', { class: cls }, h('td', { class: 't-label c-hint' }, label), h('td', { class: 'num c-player' }, String(a)), h('td', { class: 'num c-enemy' }, String(b)));
    const sy = s.stats[YOU.id], sc = s.stats[CPU.id];
    const kills = s.kills.map((k) => h('div', { class: 'kill-row t-tiny' }, h('span', { class: 'num c-hint x-only' }, '#' + k.height + ' '), h('span', { class: 'num c-hint s-only' }, `turn ${k.height - s.startHeight} · `), h('span', { class: k.owner === YOU.id ? 'c-player' : 'c-enemy' }, (k.owner === YOU.id ? 'Your ' : 'Enemy ') + k.type), k.command ? h('span', { class: 'chip warn', style: 'margin-left:6px' }, 'Flagship') : null));
    const box = h('div', { class: 'modal panel ' + (won ? 'player' : draw ? 'neutral' : 'enemy') },
      h('div', { class: 'panel-body col dc-debrief' },
        h('div', { class: 'db-call t-display ' + (won ? 'c-player' : draw ? 'c-neutral' : 'c-enemy'), title: draw ? (o.stalemate === 'moves' ? 'The flagships kept dancing' : `No damage in ${QUIET_BLOCKS} turns`) : line }, won ? 'Victory' : draw ? 'Stalemate' : 'Defeat'),
        h('div', { class: 'db-stars', 'aria-label': `${stars} of 3 stars` }, ...[1, 2, 3].map((i) => h('span', { class: i <= stars ? 'on' : '', html: icon('star', 40) }))),
        xpRow,
        h('div', { class: 'db-stats' },
          // A defeat says why first: the Command Ship fell (however many other ships still fly).
          !won && !draw && s.kills.some((k) => k.command && k.owner === YOU.id) ? big('crown', '0', 'Your Command Ship fell, and with it the battle', 'c-enemy db-lost') : null,
          big('ship', `${standing[YOU.id]}/${s.fielded[YOU.id]}`, 'Your ships still flying', 'c-player'),
          big('target', String(sy.damage), 'Damage dealt'),
          big('clock', String(blocks), `${blocks} turns · ${Math.round(s.elapsedMs / 1000)} s`)),
        (() => {
          const mine = Object.entries(s.dealt).filter(([id]) => this.view.units.get(id)?.side === 'player').sort((a, b) => b[1] - a[1])[0];
          if (!mine || !mine[1]) return null;
          const u = this.view.units.get(mine[0])!;
          return h('div', { class: 'mvp', title: `Standout: your ${TYPES_BY_ID[u.typeId].type} (${AMBIT_NAME[u.ambit]}) dealt ${mine[1]} damage${u.destroyed ? ' before it fell' : ''}` },
            h('span', { class: 'c-neutral', html: icon('star', 18) }), h('span', null, TYPES_BY_ID[u.typeId].type), h('b', null, String(mine[1])));
        })(),
        h('table', { class: 'stats x-only' },
          h('thead', null, h('tr', null, h('th'), h('th', { class: 't-label c-player' }, 'You'), h('th', { class: 't-label c-enemy' }, 'Computer'))),
          h('tbody', null,
            row('Ships still flying', `${standing[YOU.id]}/${s.fielded[YOU.id]}`, `${standing[CPU.id]}/${s.fielded[CPU.id]}`),
            row('Attacks', sy.attacks, sc.attacks), row('Damage dealt', sy.damage, sc.damage),
            row('Shots evaded by foe', sy.evaded, sc.evaded, 'x-only'), row('Shots blocked by foe', sy.blocked, sc.blocked, 'x-only'),
            row('Counter damage taken', sy.countered, sc.countered, 'x-only'), row('Failed orders', sy.failed, sc.failed, 'x-only'))),
        this.nextStep(won),
        kills.length ? h('div', { class: 'col scroll x-only', style: 'max-height:120px; gap:2px' }, h('div', { class: 't-label c-hint' }, 'Losses in order'), kills) : null,
        this.gauntlet ? h('div', { class: 'scenario' }, h('span', { class: 't-label c-neutral' }, 'Gauntlet'),
          h('span', null, won ? (this.gauntlet.over ? 'All five engagements won. The frontier is yours.' : `Round ${this.gauntlet.fought} of 5 won. Survivors carry their damage forward.`) : `The run ends in round ${this.gauntlet.fought}. Best run: ${this.gauntletBest()}/5 rounds cleared.`)) : null,
        this.daily && this.dailyLast ? this.dailyDebrief(o) : null,
        // What next, biggest first: the next fleet size after a win (A), else the same fight again;
        // then Again, then the fleets (B). One press of A is always a fight.
        this.gauntlet ? h('div', { class: 'debrief-row db-main' },
          this.gauntlet.reinforce
            ? h('button', { class: 'btn solid big grow db-go', 'data-primary': '', onclick: () => { back.remove(); this.resumeGauntlet(); } }, face('a', '⏎'), `Round ${this.gauntlet.round} ▸`)
            : h('button', { class: 'btn solid big grow db-go', 'data-primary': '', onclick: () => { back.remove(); this.startGauntlet(); } }, face('a', '⏎'), 'New gauntlet'))
          : (() => {
            const next = this.nextSize(won);
            const again = () => { back.remove(); this.toSetup(false); this.fightOrFill(); };
            const againFill = this.outnumbered() > 0 && this.emptyBays().length > 0;
            const fleets = h('button', { class: 'btn ' + (next ? 'ghost' : 'secondary'), 'data-back': '', title: this.daily ? 'Back to setup' : 'Change the fleets', onclick: () => { back.remove(); this.toSetup(false); if (inputMode() === 'pad') requestAnimationFrame(() => this.root.querySelector<HTMLElement>('.dc-start')?.focus({ focusVisible: true } as FocusOptions)); } }, face('b', 'Esc'), this.daily ? 'Setup' : 'Fleets');
            // Two losses in a row on this rung: one rung back is the big button, Again comes second.
            const easier = !won && this.rungLosses() >= 2 ? this.prevRung() : null;
            if (easier) {
              const k = easier.n, stars = '★'.repeat(easier.difficulty === 'easy' ? 1 : easier.difficulty === 'difficult' ? 2 : 3);
              const what = `${SIZE_WORD[easier.preset]} fleet (${k} enemy ships) vs ${aOrAn(cap(easier.difficulty))} computer`;
              const efill = this.wouldOutnumber(easier.preset);
              return h('div', { class: 'debrief-row db-main' },
                h('button', { class: 'btn solid big grow db-go db-next db-easier', 'data-primary': '', title: `Easier: one step back, then try this one again. ${what}${efill ? '. You will be outnumbered: setup opens first, so you can add ships to your empty bays (+)' : ''}`, 'aria-label': `Easier: ${what}${efill ? ', add ships first' : ''}`,
                  onclick: () => { back.remove(); this.goRung(easier.preset, easier.difficulty); } },
                  face('a', '⏎'), h('span', { class: 'db-next-w' }, h('span', null, 'Easier'), h('small', null, efill ? 'Add ships' : easier.smaller && easier.softer ? 'Smaller + easier' : easier.smaller ? 'Smaller fleet' : 'Easier CPU')),
                  h('span', { class: 'db-next-size' },
                    easier.smaller || !easier.softer ? [h('span', { html: icon('ship', 18) }), h('b', null, String(k)), h('span', { class: 'db-size-w' }, SIZE_WORD[easier.preset])] : null,
                    easier.difficulty !== this.difficulty ? [h('span', { html: icon('robot', 18) }), h('b', { class: 'db-next-stars' }, stars)] : null)),
                h('button', { class: 'btn secondary', title: againFill ? 'The same fight again: setup opens first, so you can add ships' : 'The same fight again', onclick: again }, h('span', { html: icon('refresh', 16) }), 'Again'), fleets);
            }
            if (!next) return h('div', { class: 'debrief-row db-main' },
              h('button', { class: 'btn solid big grow db-go', 'data-primary': '', title: againFill ? 'The same fight again: setup opens first, so you can add ships (+)' : 'The same fight again', onclick: again },
                face('a', '⏎'), againFill ? h('span', { class: 'db-next-w' }, h('span', null, 'Again'), h('small', null, 'Add ships')) : 'Again'), fleets);
            // The button names what changes: a bigger fleet, a sharper computer, or (from a random fleet) both.
            const { n, bigger, sharper } = next;
            const fill = this.wouldOutnumber(next.preset);
            const stars = '★'.repeat(next.difficulty === 'easy' ? 1 : next.difficulty === 'difficult' ? 2 : 3);
            const what = `${SIZE_WORD[next.preset]} fleet (${n} enemy ships) vs ${aOrAn(cap(next.difficulty))} computer`;
            const change = (bigger && sharper ? 'a bigger fleet and a sharper computer' : bigger ? 'a bigger fleet' : sharper ? 'a sharper computer' : 'a new fleet') + (next.why ? ` — ${next.why}` : '');
            return h('div', { class: 'debrief-row db-main' },
              h('button', { class: 'btn solid big grow db-go db-next', 'data-primary': '', title: `Next: ${change}. ${what}${fill ? '. You will be outnumbered: setup opens first, so you can add ships to your empty bays (+)' : ''}`, 'aria-label': `Next: ${what}${fill ? ', add ships first' : ''}`,
                onclick: () => { back.remove(); this.goRung(next.preset, next.difficulty); } },
                face('a', '⏎'), h('span', { class: 'db-next-w' }, h('span', null, 'Next'), h('small', null, fill ? 'Add ships' : bigger && sharper ? 'Bigger + sharper' : bigger ? 'Bigger fleet' : sharper ? 'Sharper CPU' : 'New fleet')),
                h('span', { class: 'db-next-size' },
                  bigger || !sharper ? [h('span', { html: icon('ship', 18) }), h('b', null, String(n)), h('span', { class: 'db-size-w' }, SIZE_WORD[next.preset])] : null,
                  sharper ? [h('span', { html: icon('robot', 18) }), h('b', { class: 'db-next-stars' }, stars)] : null)),
              h('button', { class: 'btn secondary', title: againFill ? 'The same fight again: setup opens first, so you can add ships' : 'The same fight again', onclick: again }, h('span', { html: icon('refresh', 16) }), 'Again'), fleets);
          })(),
        // The rest, small: watch it again, share it (icons, named in their titles), and leave for the menu.
        // (Leave first, at the left: the card opens over the enemy's side, and a hand still clicking at their
        // ships must not land on Leave.)
        h('div', { class: 'debrief-row db-minor' },
          h('button', { class: 'btn ghost', title: 'Back to the menu', onclick: () => { back.remove(); if (this.gauntlet?.over) this.gauntlet = null; this.leaveToMenu(); } }, h('span', { html: icon('back', 16) }), 'Leave'),
          h('button', { class: 'btn secondary', title: 'Watch this battle again', onclick: () => { back.remove(); const r = this.replayCode(o); if (r) void this.startReplay(r); } }, h('span', { html: icon('replay', 16) }), 'Replay'),
          h('button', { class: 'btn ghost db-ico-btn', title: 'Share: copy a link that replays this exact battle', 'aria-label': 'Share the replay', onclick: () => { const r = this.replayCode(o); if (!r) return; copyText(routeUrl('/sim/' + encodeReplay(r)), 'Replay link copied — anyone can watch this exact battle', 2600); } }, h('span', { html: icon('send', 18) })),
          h('button', { class: 'btn ghost db-ico-btn', title: 'Challenge your guild: post these fleets to chat (you press send)', 'aria-label': 'Challenge your guild', onclick: () => {
            void import('../../ui/comms/dock').then((m) => m.mountCommsDock().draft(`⚔ Battle challenge — ${o.winner === 'you' ? 'I won' : o.winner === 'cpu' ? 'I lost' : 'a draw'} in ${o.height} blocks. Beat it: ${routeUrl('/sim/' + this.battleCode())}`));
          } }, h('span', { html: icon('chat', 18) })),
          this.gauntlet || this.daily ? null : h('button', { class: 'btn ghost db-ico-btn x-only', title: 'Share fleets: copy a link to fight these exact fleets', 'aria-label': 'Share the fleets', onclick: () => copyText(routeUrl('/sim/' + this.battleCode()), 'Battle code copied — share the exact fleets', 3200) }, h('span', { html: icon('copy', 18) }))),
      ),
    );
    const back = h('div', { class: 'modal-back debrief-back' }, box);
    document.body.appendChild(back);
    xpRow.dataset.mounted = '1';
    // B (Escape) backs out to the fleets, as its badge says, while the debrief is the window on top.
    const onKey = (e: KeyboardEvent) => {
      if (!back.isConnected) { window.removeEventListener('keydown', onKey, true); return; }
      const modals = document.querySelectorAll('.modal-back');
      if (e.key !== 'Escape' || modals[modals.length - 1] !== back) return;
      const b = box.querySelector<HTMLButtonElement>('[data-back]');
      if (b) { e.preventDefault(); e.stopImmediatePropagation(); if (!box.inert) b.click(); }
    };
    window.addEventListener('keydown', onKey, true);
    // Keyboard players start on the main choice (Rematch, Continue…).
    // …unless the player is typing somewhere (chat, a search): a stray Space mustn't press Rematch.
    // The results hold still for a beat while the stars land, so a mashed A (or Enter) from the fight
    // doesn't skip them straight into the next battle.
    const typing = !!document.activeElement?.closest('input, textarea, select, [contenteditable]');
    if (!typing) (document.activeElement as HTMLElement | null)?.blur?.();
    box.inert = true;
    setTimeout(() => {
      box.inert = false;
      if (back.isConnected && !typing && document.querySelectorAll('.modal-back').length === 1)
        (box.querySelector('[data-primary]') as HTMLButtonElement | null)?.focus({ preventScroll: true, focusVisible: document.body.classList.contains('pad') } as FocusOptions);
    }, 1100);
  }

  /** After a plain training battle won, the next rung of LADDER (the results' main button), if any. A
   * fight on a rung (or a random fleet of that rung's size rank and skill) goes to the rung after it.
   * Anything else (a skill picked by hand) goes to the first rung that is neither smaller nor easier
   * and is bigger or sharper. Fleets are
   * compared by size rank (Small, Medium, Large), a random one ranked by its real count (6 to 16 ships;
   * more than Large counts as Large). Also says what goes up: `bigger`, `sharper`, or both. */
  private nextSize(won: boolean): { preset: Preset; difficulty: Difficulty; why?: string; n: number; bigger: boolean; sharper: boolean } | null {
    if (!won || this.gauntlet || this.daily || this.scenario || this.spectate) return null;
    const count = (p: Preset) => Number(PRESETS.find((x) => x.id === p)?.enemy ?? 0) + 1;
    const skill = (d: Difficulty) => (d === 'easy' ? 0 : d === 'difficult' ? 1 : 2);
    const fought = this.preset === 'random' ? this.draft.filter((u) => u.side === 'computer').length : count(this.preset);
    const rank = (n: number) => (n <= count('easy') ? 0 : n <= count('difficult') ? 1 : 2);
    const s0 = rank(fought), k0 = skill(this.difficulty);
    // On a rung (a random fleet counts as the rung of its size rank and skill): the rung after it.
    const at = LADDER.findIndex((x) => rank(count(x.preset)) === s0 && skill(x.difficulty) === k0);
    const r = at >= 0 ? LADDER[at + 1]
      : LADDER.find((x) => rank(count(x.preset)) >= s0 && skill(x.difficulty) >= k0 && (rank(count(x.preset)) > s0 || skill(x.difficulty) > k0));
    return r ? { ...r, n: count(r.preset), bigger: rank(count(r.preset)) > s0, sharper: skill(r.difficulty) > k0 } : null;
  }

  /** Where this fight sits: its fleet's size rank (a random fleet by its real count) and the computer's skill. */
  private rungOf() {
    const count = (p: Preset) => Number(PRESETS.find((x) => x.id === p)?.enemy ?? 0) + 1;
    const fought = this.preset === 'random' ? this.draft.filter((u) => u.side === 'computer').length : count(this.preset);
    const rank = (n: number) => (n <= count('easy') ? 0 : n <= count('difficult') ? 1 : 2);
    const skill = (d: Difficulty) => (d === 'easy' ? 0 : d === 'difficult' ? 1 : 2);
    return { count, rank, skill, s0: rank(fought), k0: skill(this.difficulty), key: `${rank(fought)}/${skill(this.difficulty)}` };
  }
  /** Losses in a row on this rung (this browser session), counted once per fight by `noteRung`. */
  private rungLosses() { try { const r = JSON.parse(sessionStorage.getItem('structs.rung') || 'null'); return r && r.key === this.rungOf().key ? Number(r.n) || 0 : 0; } catch { return 0; } }
  private noteRung(won: boolean) {
    if (this.gauntlet || this.daily || this.scenario || this.spectate) return;
    const key = this.rungOf().key;
    const n = won ? 0 : this.rungLosses() + 1;
    try { sessionStorage.setItem('structs.rung', JSON.stringify({ key, n })); } catch { /* this fight only */ }
  }
  /** One rung back down LADDER (a fight off the ladder steps to the hardest rung below it). */
  private prevRung(): { preset: Preset; difficulty: Difficulty; n: number; smaller: boolean; softer: boolean } | null {
    if (this.gauntlet || this.daily || this.scenario || this.spectate) return null;
    const { count, rank, skill, s0, k0 } = this.rungOf();
    // The hardest rung below this one that is no bigger and no sharper (the ladder's previous rung can be a
    // bigger fleet against a softer computer: that is no easier for someone who just lost twice).
    const below = (x: { preset: Preset; difficulty: Difficulty }) => rank(count(x.preset)) <= s0 && skill(x.difficulty) <= k0 && (rank(count(x.preset)) < s0 || skill(x.difficulty) < k0);
    const at = LADDER.findIndex((x) => rank(count(x.preset)) === s0 && skill(x.difficulty) === k0);
    // A softer computer at this size or smaller comes first; then a smaller fleet.
    const pool = [...(at >= 0 ? LADDER.slice(0, at) : LADDER)].reverse().filter(below);
    // Lost outnumbered: a smaller fleet first (a softer computer leaves you just as outnumbered).
    const r = (this.outnumbered() > 0 ? pool.find((x) => rank(count(x.preset)) < s0) : null) || pool.find((x) => skill(x.difficulty) < k0) || pool[0] || null;
    return r ? { preset: r.preset, difficulty: r.difficulty, n: count(r.preset), smaller: rank(count(r.preset)) < s0, softer: skill(r.difficulty) < k0 } : null;
  }

  /** How many more ships the enemy has than you (0 when you aren't outnumbered, or the fleets are fixed). */
  private outnumbered() {
    if (this.daily || this.gauntlet || this.scenario || this.spectate) return 0;
    const yours = this.draft.filter((u) => u.side === 'player').length, theirs = this.draft.filter((u) => u.side === 'computer').length;
    return Math.max(0, theirs - yours);
  }
  /** Your empty bays, in board order. */
  private emptyBays(): { ambit: Ambit; slot: number }[] {
    const out: { ambit: Ambit; slot: number }[] = [];
    for (const ambit of AMBITS) for (let slot = 0; slot < 4; slot++)
      if (!this.draft.some((u) => u.side === 'player' && u.type !== COMMAND_SHIP_ID && u.ambit === ambit && u.slot === slot)) out.push({ ambit, slot });
    return out;
  }
  /** A ladder move from the results (Next, Easier): the enemy's fleet is new, yours is the one you had
   * (ships you added included). Outnumbered with bays to spare: setup opens with the "Add ships" step
   * instead of the fight. */
  private carryFleet: Unit[] | null = null;
  /** Open the picker on the first empty bay once the next board is built (the bays are where it opens). */
  private fillAfterBuild = false;
  /** The next setup shows the "Add ships" step even if it was seen before (a ladder landing). */
  private fillPrompt = false;
  private goRung(p: Preset, d: Difficulty) {
    this.carryFleet = this.draft.filter((u) => u.side === 'player').map((u) => ({ ...u, health: undefined }));
    this.preset = p; this.difficulty = d; this.seed = Math.random().toString(36).slice(2, 8);
    this.toSetup(true);
    this.fightOrFill();
  }
  /** Again (or a rung just set up): straight into the fight, unless you're outnumbered with bays to spare. */
  private fightOrFill() {
    if (this.outnumbered() && this.emptyBays().length) {
      this.fillPrompt = true;
      this.renderSetup();
      return;
    }
    void this.engage();
  }
  /** Would a fight against this preset outnumber the fleet you have now? */
  private wouldOutnumber(p: Preset) {
    const mine = this.draft.filter((u) => u.side === 'player').length;
    return !this.scenario && !this.spectate && Number(PRESETS.find((x) => x.id === p)?.enemy ?? 0) + 1 > mine && this.emptyBays().length > 0;
  }

  /** The ship picker on the first empty bay (the Outnumbered "+"): one tap a ship. */
  private fillBay() {
    if (this.phase !== 'setup' || this.gauntlet || this.daily) return;
    const bay = this.emptyBays()[0];
    if (!bay) return;
    const m = this.ghosts.children.find((x) => x.userData.ghost?.ambit === bay.ambit && x.userData.ghost?.slot === bay.slot);
    const v = m ? m.getWorldPosition(new THREE.Vector3()).project(this.camera) : null;
    const at = v ? { x: (v.x + 1) / 2 * window.innerWidth + 28, y: (1 - v.y) / 2 * window.innerHeight - 40 } : { x: window.innerWidth / 2, y: 80 };
    this.openSlotEditor(bay.ambit, bay.slot, null, at, inputMode() !== 'touch', '.setup-panel .dc-outnumbered');
  }

  /** Leave a battle for the galaxy. Its title (shown on a first visit, e.g. after a direct link to a
   * battle) opens on its doors, not PRESS START, once start has been pressed this session: anyone
   * leaving a fight is past that. (A galaxy already visited shows no title again: galaxy.ts.) */
  private leaveToMenu() {
    // Past PRESS START, and the galaxy shows its doors again (galaxy.ts enter).
    try { sessionStorage.setItem('structs.started', '1'); sessionStorage.setItem('structs.menu', '1'); } catch { /* storage blocked: the title asks for START */ }
    this.navigate('/galaxy');
  }

  /** One clear hint after a plain training battle with no bigger fleet to fight next: the Daily after
   * beating the biggest, a tip after a loss. */
  private nextStep(won: boolean): HTMLElement | null {
    if (this.gauntlet || this.daily || this.scenario || this.spectate || this.nextSize(won)) return null;
    if (won) return h('div', { class: 'next-step player', title: 'You beat the hardest fleet. Try today’s Daily Challenge, or the five-round Gauntlet.' }, h('span', { html: icon('daily', 20) }),
      h('span', { class: 'grow ns-big' }, 'Daily'), h('button', { class: 'btn secondary mini', onclick: () => { document.querySelector('.debrief-back')?.remove(); this.startDaily(); } }, 'Go ▸'));
    // After a loss: where their Command Ship is, and how many of your ships reach that layer.
    const c = this.chain, sess = this.session;
    const theirs = c && Object.values(c.structs).find((x) => x.owner === CPU.id && x.typeId === COMMAND_SHIP_ID && !c.isDestroyed(x));
    // Your ships still flying (and where they are now) whose weapons reach its layer; if none survive,
    // the fleet you started with (so a fleet that could reach, and sank, doesn't read "out of reach").
    const reaches = (type: number, from: Ambit) => !!theirs && (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).some((ws) => hasWeapon(TYPES_BY_ID[type], ws) && canTargetAmbit(TYPES_BY_ID[type], ws, from, theirs.ambit));
    const units = c ? Object.values(c.structs).filter((x) => x.owner === YOU.id && !c.isDestroyed(x) && x.typeId !== COMMAND_SHIP_ID) : [];
    const reach = units.length ? units.filter((u) => reaches(u.typeId, u.ambit)).length
      : (this.liveSetup?.units || []).filter((u) => u.side === 'player' && u.type !== COMMAND_SHIP_ID && reaches(u.type, u.ambit)).length;
    // Its guards (they block the shots aimed at it, and fire back).
    const guards = theirs && c ? c.defendersOf(theirs.id).map((id) => c.structs[id]).filter((x) => x && !c.isDestroyed(x)) : [];
    // Yours fell to the last hit: guard it first, then drift it out of reach.
    const fell = !!sess?.kills.some((k) => k.command && k.owner === YOU.id);
    const layer = theirs ? AMBIT_NAME[theirs.ambit] : '';
    // Fought outnumbered with bays to spare: bring more ships, first.
    const fleet = this.liveSetup?.units || this.draft;
    const yours = fleet.filter((u) => u.side === 'player'), theirsN = fleet.filter((u) => u.side === 'computer').length;
    const spare = yours.filter((u) => u.type !== COMMAND_SHIP_ID).length < AMBITS.length * 4;
    const outnumbered = theirsN > yours.length && spare;
    // One line, the most useful: outnumbered → add ships (a button into setup with the picker open);
    // their Command Ship out of your reach (or never hit) → its layer; yours fell → Guard, then Drift.
    // Every tip is in the title.
    const lines = [
      outnumbered ? `Outnumbered: ${theirsN} enemy ships against your ${yours.length}. Add ships to your empty bays (+).` : '',
      theirs ? `Their Command Ship sits in ${layer}: ${reach} of your ships reach it. Take it down and you win.` : '',
      fell ? 'Yours fell: a guard in its layer blocks the shots, then Drift moves it where fewer enemies reach.' : '',
    ].filter(Boolean).join('\n');
    const untouched = !!theirs && theirs.health >= TYPES_BY_ID[theirs.typeId].maxHealth;
    if (outnumbered) return h('button', { class: 'next-step warn db-tip db-tip-add', title: lines, onclick: () => {
      document.querySelector('.debrief-back')?.remove();
      this.fillPrompt = true;
      this.fillAfterBuild = true;
      this.toSetup(false);
    } }, h('span', { class: 'db-tip-ico db-tip-plus' }, '+'), h('span', { class: 'grow' }, 'Outnumbered: add ships'), h('span', { class: 'db-tip-go' }, '▸'));
    // Untouched behind its guards: sink the guards first.
    if (untouched && guards.length && reach > 0 && (sess?.stats[YOU.id]?.blocked || 0) > 0) return h('div', { class: 'next-step warn db-tip', title: `Their Command Ship took no damage: ${guards.length} guard${guards.length === 1 ? '' : 's'} blocked your shots (${guards.map((g) => `${TYPES_BY_ID[g.typeId].type} ${g.id}, ${AMBIT_NAME[g.ambit]}`).join('; ')}). Sink the guards first, then it.\n${lines}` },
      h('span', { class: 'db-tip-ico c-enemy', html: icon('shield', 20) }), h('span', null, `${guards.length} guard${guards.length === 1 ? '' : 's'} blocked you: sink ${guards.length === 1 ? 'it' : 'them'} first`));
    if (theirs && (!reach || untouched || !fell)) return h('div', { class: 'next-step warn db-tip', title: lines },
      h('span', { class: 'db-tip-ico ambit-' + theirs.ambit, html: icon(theirs.ambit, 20) }),
      h('span', null, reach ? `Their Command Ship is in ${layer} · ${reach} of yours reach it` : `Their Command Ship is in ${layer}: out of your reach`));
    if (fell) return h('div', { class: 'next-step warn db-tip', title: lines },
      h('span', { class: 'db-tip-ico c-player', html: icon('shield', 20) }), h('span', null, say({ pad: 'Guard yours (X)', keys: 'Guard yours (G)', touch: 'Guard yours' })),
      h('span', { class: 'db-tip-ico c-player', html: icon('rank', 18) }), h('span', null, say({ pad: 'then Drift (Y)', keys: 'then Drift (D)', touch: 'then Drift' })));
    return h('div', { class: 'next-step warn db-tip', title: lines || 'Hit their Command Ship: when it falls, you win.' }, h('span', { class: 'db-tip-ico c-warn', html: icon('crown', 20) }), h('span', null, 'Hit their Command Ship'));
  }

  private dailyDebrief(o: Outcome) {
    const d = this.daily!, last = this.dailyLast!;
    const best = dailyBest(d.key), streak = dailyStreak(d.key);
    const share = () => {
      const r = this.replayCode(o);
      const link = r ? routeUrl('/sim/' + encodeReplay(r)) : '';
      const text = `Structs daily ${d.key} · ${d.name} (${d.twist.name})\n${describeDaily(last.r)}${streak > 1 ? ` · ${streak}-day streak` : ''}\n${link}`;
      copyText(text, 'Result copied, with a replay link', 2400);
    };
    return h('div', { class: 'scenario daily-result' },
      h('span', { class: 't-label c-neutral' }, 'Daily'),
      h('div', { class: 'col', style: 'gap:2px' },
        h('span', null, `${d.name}: ${describeDaily(last.r)}.`),
        h('span', { class: 't-tiny c-hint' }, last.best ? 'Your best result today.' : best ? `Today’s best: ${describeDaily(best)}.` : '',
          streak ? ` Victory streak: ${streak} day${streak === 1 ? '' : 's'}.` : ''),
        h('div', { class: 'row', style: 'gap:6px; margin-top:4px' },
          h('button', { class: 'btn ghost mini', onclick: share }, 'Share result'))));
  }

  /* ── Replay: the deterministic chain re-runs the recorded transactions ── */
  private replayCode(o?: Outcome): ReplayCode | null {
    if (!this.liveSetup || !this.session) return null;
    const title = this.scenario || (this.daily ? `${this.daily.name} · daily ${this.daily.key}` : this.gauntlet ? `Gauntlet round ${this.gauntlet.fought || this.gauntlet.round}` : `${cap(this.preset)} · ${cap(this.difficulty)}`);
    return { ...this.liveSetup, txs: this.session.executed.slice(), title, winner: o?.winner };
  }

  private async startReplay(code: ReplayCode) {
    this.clearAim();
    this.session?.pause();
    this.session = null;
    this.clearCoach();
    document.querySelectorAll('.debrief-back, .banner, .slot-editor').forEach((n) => n.remove());
    this.root.querySelectorAll('.setup-panel, .battle-top, .battle-log, .action-bar, .replay-bar').forEach((n) => n.remove());
    this.clearGhosts();
    this.phase = 'replay';
    this.paused = false;
    this.view.paused = false;
    this.fitCamera(true);
    audio.setIntensity(0.7);
    const chain = new Chain(chainSetup(code.units, code.seed, { player: 9, computer: 9 }).setup);
    this.chain = chain;
    this.selected = null;
    const last = code.txs.length ? code.txs[code.txs.length - 1].height : chain.height;
    this.targeting = null;
    this.held = null;
    this.replay = { code, chain, i: 0, acc: 0, speed: 1, end: last + 6, done: false, ready: false };
    this.logEl = h('div', { class: 'log-body scroll' });
    const replay = this.replay;
    if (!(await this.buildBoard(chain)) || this.replay !== replay || this.phase !== 'replay' || !this.root.isConnected) return;
    replay.ready = true;
    const speedBtns = [1, 2, 4].map((k) => h('button', { class: 'btn ghost mini' + (k === 1 ? ' active' : ''), onclick: (e: Event) => {
      if (!this.replay) return;
      this.replay.speed = k;
      (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.currentTarget));
    } }, `×${k}`));
    const bar = h('div', { class: 'replay-bar panel neutral' },
      h('span', { class: 't-label c-neutral' }, '▶ Replay'),
      h('span', { class: 't-body' }, code.title || 'Battle'),
      this.els.replayBlock = h('span', { class: 'num c-hint' }, ''),
      h('div', { class: 'row', style: 'gap:3px' }, speedBtns),
      h('button', { class: 'btn ghost', onclick: () => copyText(routeUrl('/sim/' + encodeReplay(code)), 'Replay link copied', 1600) }, 'Copy link'),
      h('button', { class: 'btn', onclick: () => this.exitReplay(code) }, 'Exit replay'));
    const log = h('div', { class: 'battle-log panel' }, h('div', { class: 'panel-head' }, h('span', { class: 't-label' }, 'Battle log'), h('span', { class: 'chip warn' }, 'replay')), this.logEl);
    this.root.append(bar, log);
    banner('REPLAY', (code.title || 'BATTLE').toUpperCase(), 'neutral', 1400);
  }

  private exitReplay(code: ReplayCode) {
    this.replay = null;
    this.root.querySelector('.replay-bar')?.remove();
    if (currentRoute().startsWith('/sim/R')) {
      // Opened from a link: leave through the router so its state stays in sync, keeping the fleets.
      if (!this.gauntlet) { this.draft = code.units.map((u) => ({ ...u, health: undefined })); this.keepDraft = true; }
      this.navigate('/sim');
      return;
    }
    this.phase = 'setup';
    if (this.gauntlet) this.resumeGauntlet(); else this.toSetup(false);
  }

  private stepReplay(dt: number) {
    const r = this.replay;
    if (!r || !r.ready || r.done || this.phase !== 'replay') return;
    // Let the animation keep up: hold the clock while more than a block is waiting to play.
    r.acc += dt * 1000 * r.speed * (this.view.busy ? 0.35 : 1);
    if (r.acc < 900) return;
    r.acc = 0;
    const c = r.chain, next = c.height + 1;
    while (r.i < r.code.txs.length && r.code.txs[r.i].height === next) { c.submit(r.code.txs[r.i].signer, r.code.txs[r.i].msg); r.i++; }
    const b = c.produceBlock();
    audio.play('tick', 0.4);
    this.view.playBlock(b, c, YOU.id);
    for (const tx of b.txs) this.logTx(b.height, tx);
    if (this.els.replayBlock) this.els.replayBlock.textContent = `block ${b.height - r.code.start} / ${r.end - r.code.start}`;
    if (c.fleetsAtBattle().length < 2 || c.height >= r.end) {
      r.done = true;
      const w = r.code.winner;
      setTimeout(() => { if (this.replay === r) banner('REPLAY COMPLETE', w === 'you' ? 'VICTORY' : w === 'cpu' ? 'DEFEAT' : w === 'draw' ? 'STALEMATE' : '', w === 'cpu' ? 'enemy' : 'player', 2600); }, 1800);
    }
  }

  /* ── Input ────────────────────────────────────────────────────────────── */
  private bindInput() {
    const canvas = this.engine.canvas;
    const move = (e: PointerEvent) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.pointerPx = { x: e.clientX, y: e.clientY };
      if (e.pointerType === 'mouse') this.fingerNear = 0;
    };
    const click = (e: PointerEvent) => {
      move(e);
      this.fingerNear = e.pointerType === 'mouse' ? 0 : FINGER_REACH;
      // Touch and pen have no reliable hover, so both get the forecast-first tap.
      this.handleClick(e.pointerType !== 'mouse');
    };
    let lastTouch = 0;
    const markTouch = (e: PointerEvent) => { if (e.pointerType !== 'mouse') lastTouch = performance.now(); };
    const key = (e: KeyboardEvent) => this.handleKey(e);
    // A touch forecast stays up after the finger lifts (touch pointers "leave" on release).
    const leave = () => { this.pointer.set(9, 9); if (!this.touchArmed && !this.touchTip) hideTooltip(); };
    // Wheel zooms toward the cursor; double-click (or Z) frames the whole board again.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.zoom.wheel(e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY, this.camera, this.pointer);
    };
    // Tap-then-tap-again to fire reads as a double-click on touch screens: only a mouse reframes.
    const dbl = () => { if (performance.now() - lastTouch > 700) this.zoom.reset(); };
    const unpinch = bindPinch(canvas, (dy, x, y) => {
      this.disarmTouch(); // the board moves under a pinned forecast
      this.pointer.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
      this.zoom.wheel(dy, this.camera, this.pointer);
    });
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('dblclick', dbl);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerdown', markTouch);
    const untap = bindTap(canvas, click);
    canvas.addEventListener('pointerleave', leave);
    window.addEventListener('keydown', key);
    const vis = () => { if (document.hidden && this.phase === 'battle' && !this.paused) this.togglePause(); };
    document.addEventListener('visibilitychange', vis);
    // A pad picked up (or put down) after the screen drew: the face badges (A, X, B) and the key caps
    // trade places, so the controls that carry them are drawn again.
    let padWas = document.body.classList.contains('pad');
    const redraw = () => {
      if (!this.root.isConnected) return;
      if (this.phase === 'setup' && this.root.querySelector('.setup-panel')) this.renderSetup();
      else if (this.phase === 'battle' || this.phase === 'setup') this.renderActionBar();
      this.pulseCoachTarget();
    };
    let later = 0;
    const padWatch = new MutationObserver(() => {
      const pad = document.body.classList.contains('pad');
      if (pad === padWas) return;
      padWas = pad;
      clearTimeout(later);
      if (pad) { redraw(); return; }
      // The pointer press that put the pad down must reach its button first: draw again only after
      // its click (pointerup, then a tick), or a moment later if no press follows.
      const after = () => { window.removeEventListener('pointerup', after, true); clearTimeout(later); later = window.setTimeout(redraw, 0); };
      window.addEventListener('pointerup', after, true);
      later = window.setTimeout(after, 1500);
    });
    padWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    this.cleanup.push(() => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerdown', markTouch);
      untap();
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('dblclick', dbl);
      unpinch();
      window.removeEventListener('keydown', key);
      document.removeEventListener('visibilitychange', vis);
      padWatch.disconnect();
    });
  }

  private pick(near = 0): { unit?: UnitView; ghost?: { ambit: Ambit; slot: number } } {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const ghostHits = this.phase === 'setup' ? this.raycaster.intersectObjects(this.ghosts.children, true) : [];
    const hits = this.raycaster.intersectObjects(this.view.pickables(), false);
    if (hits.length) return { unit: hits[0].object.userData.unit as UnitView };
    if (ghostHits.length) return { ghost: ghostHits.find((x) => x.object.userData.ghost)?.object.userData.ghost };
    // A fingertip is wider than a far-off ship: in a fight, a tap that misses takes the nearest ship
    // within `near` px (only valid targets while aiming; the forecast card shows before anything fires).
    if (near && this.phase === 'battle') {
      let best: UnitView | undefined, bd = near * near;
      for (const u of this.view.units.values()) {
        if (u.destroyed || (this.targeting && !u.targetable)) continue;
        const p = this.view.screenOf(u.id);
        if (!p) continue;
        const d = (p.x - this.pointerPx.x) ** 2 + (p.y - this.pointerPx.y) ** 2;
        if (d < bd) { bd = d; best = u; }
      }
      if (best) return { unit: best };
    }
    return {};
  }

  private handleClick(touch = false) {
    const { unit, ghost } = this.pick(touch ? this.fingerNear || FINGER_REACH : 0);
    if (this.touchArmed && unit?.id !== this.touchArmed.target) this.disarmTouch();
    document.querySelectorAll('.slot-editor, .slot-scrim').forEach((n) => n.remove());
    if (this.phase === 'setup') {
      this.boardKeys = false;
      if ((this.gauntlet || this.daily) && (ghost || (unit && unit.side === 'player' && this.targeting?.kind !== 'guard'))) {
        // Gauntlet fleets are earned and daily fleets are shared, not edited: select only (guards may still be set).
        if (unit) { audio.play('select'); this.select(unit.id); }
        else toast(this.gauntlet ? 'Gauntlet fleets grow only through reinforcements' : 'The daily fleet is the same for everyone', 'warn', 1600);
        return;
      }
      if (ghost) { audio.play('select'); this.openSlotEditor(ghost.ambit, ghost.slot, null, { x: this.pointerPx.x + 12, y: this.pointerPx.y - 40 }); return; }
      if (!unit) { this.select(null); return; }
      if (this.targeting?.kind === 'guard') {
        const du = this.draftUnit(this.selected || ''), ward = this.draftUnit(unit.id);
        if (du && ward && ward.side === du.side && ward !== du) {
          du.protects = ward.id; audio.play('confirm'); this.targeting = null;
          this.renderSetup(); void this.buildPreview();
        } else audio.play('deny');
        return;
      }
      if (unit.side === 'player' && this.selected === unit.id) {
        const du = this.draftUnit(unit.id);
        if (du) this.openSlotEditor(du.ambit, du.slot, du, { x: this.pointerPx.x + 12, y: this.pointerPx.y - 40 });
        return;
      }
      audio.play('select');
      this.select(unit.id);
      if (unit.side === 'player') {
        const du = this.draftUnit(unit.id);
        if (du) this.openSlotEditor(du.ambit, du.slot, du, { x: this.pointerPx.x + 12, y: this.pointerPx.y - 40 });
      }
      return;
    }
    if (this.phase !== 'battle' && this.phase !== 'debrief' && this.phase !== 'replay') return;
    if (!unit) { if (this.targeting) { this.targeting = null; this.refreshSelectionVisuals(); this.renderActionBar(); } return; }
    if (this.targeting && unit.targetable) {
      if (this.targeting.kind === 'attack') {
        const a = this.touchArmed;
        if (touch && !(a && a.target === unit.id && a.ws === this.targeting.ws && a.from === this.selected)) {
          // First tap: show the forecast (hover's job on a desktop); a second tap on it fires.
          this.touchArmed = { target: unit.id, ws: this.targeting.ws, from: this.selected || '', at: { ...this.pointerPx } };
          audio.play('hover');
          this.updateHover();
          return;
        }
        this.disarmTouch();
        this.attack(this.targeting.ws, unit.id);
      }
      else {
        const s = this.selectedStruct();
        if (s) this.order({ '@type': '/structs.structs.MsgStructDefenseSet', defenderStructId: s.id, protectedStructId: unit.id }, TYPES_BY_ID[s.typeId].defendChangeCharge, `${TYPES_BY_ID[s.typeId].type} guards ${TYPES_BY_ID[unit.typeId].type}`);
      }
      return;
    }
    if (this.targeting && !unit.targetable) { audio.play('deny'); return; }
    // An enemy clicked (or tapped) with nothing armed: as A does, arm the best ship of yours that can hit
    // it (never your Command Ship), aimed at it. A second click (a tap on the card's Fire) fires. If none
    // of yours can reach it, its card shows and your selection stays.
    if (this.phase === 'battle' && unit.side === 'enemy' && !this.targeting && !this.spectate && !unit.destroyed) {
      const pick = this.shooterFor(unit.id);
      if (pick) {
        this.select(pick.ship.id);
        this.beginAttack(pick.ws);
        if (this.targeting) {
          this.aimId = unit.id;
          if (touch) { this.touchArmed = { target: unit.id, ws: pick.ws, from: pick.ship.id, at: { ...this.pointerPx } }; this.updateHover(); }
          else this.refreshDock();
        }
        return;
      }
      audio.play('hover'); this.touchTip = unit.id; this.tipFor(unit, this.pointerPx);
      return;
    }
    // On a touch screen your own bar stays put: an enemy tapped shows its card as a pop-up.
    if (touch && this.phase === 'battle' && unit.side === 'enemy' && this.selectedStruct()?.owner === YOU.id) { audio.play('hover'); this.touchTip = unit.id; this.tipFor(unit, this.pointerPx); return; }
    audio.play('select');
    this.select(unit.id);
  }

  /** An enemy's card pinned by a tap on a touch screen (your own bar stays): until the next tap or turn. */
  private touchTip: string | null = null;
  /** Keyboard and pad aiming: the target the arrows picked while a weapon (or a guard) is armed. */
  private aimId: string | null = null;
  /** Step the aim through what the armed weapon can reach (or the friends a guard can take), in board order. */
  private cycleAim(dir: number) {
    const c = this.activeChain();
    if (!c || !this.targeting) return;
    const order = [...this.validTargets()].map((id) => c.structs[id]).filter((x) => x && !c.isDestroyed(x))
      .sort((a, b) => AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit) || a.slot - b.slot);
    if (!order.length) return;
    const i = order.findIndex((x) => x.id === this.aimId);
    // A fresh aim starts on their Command Ship when it is in reach (taking it down wins the battle).
    let cs = this.targeting.kind === 'attack' ? order.findIndex((x) => x.typeId === COMMAND_SHIP_ID) : -1;
    if (cs >= 0 && this.fullyBlocked(order[cs].id)) { const g = this.guardsOf(order[cs].id).find((x) => order.some((o) => o.id === x.id)); cs = g ? order.findIndex((o) => o.id === g.id) : -1; }
    const next = order[i < 0 ? Math.max(0, cs) : (i + dir + order.length) % order.length];
    this.aimId = next.id;
    // Shown the way a hover is: the ring lights and the forecast opens beside it. The mouse
    // takes over again the moment it moves.
    if (this.hovered && this.hovered !== next.id) { const u = this.view.units.get(this.hovered); if (u) u.hover = 0; }
    this.hovered = next.id;
    this.pointer.set(9, 9);
    const u = this.view.units.get(next.id);
    if (u) { u.hover = 1; this.tipFor(u, this.view.screenOf(next.id) ?? { x: innerWidth / 2, y: innerHeight / 2 }); }
    audio.play('hover');
  }

  /** Arming hands the cursor back to the board: a bar button left in focus would take the pad's A
   * (it clicks what has focus) or Enter, and press itself again instead of firing. */
  private releaseBarFocus() {
    const f = document.activeElement as HTMLElement | null;
    if (f?.closest?.('.action-bar')) f.blur();
  }

  /** Let go of a keyboard or pad aim: the ring, the forecast and the pick. */
  private clearAim() {
    if (this.aimId && this.hovered === this.aimId) { const u = this.view.units.get(this.hovered); if (u) u.hover = 0; this.hovered = null; hideTooltip(); }
    this.aimId = null;
  }

  /** Fire at (or guard) the aimed unit, as a click on it would. */
  private commitAim() {
    const c = this.activeChain();
    const target = this.aimId ? c?.structs[this.aimId] : undefined;
    if (!c || !target || !this.targeting || !this.validTargets().has(target.id)) return false;
    this.clearAim();
    if (this.phase === 'setup') {
      // Setup guards are drafted, not ordered: as a click on a friend does.
      const du = this.draftUnit(this.selected || ''), ward = this.draftUnit(target.id);
      if (du && ward && ward.side === du.side && ward !== du) { du.protects = ward.id; audio.play('confirm'); this.targeting = null; this.renderSetup(); void this.buildPreview(); }
      else audio.play('deny');
      return true;
    }
    // Every shot at it would be blocked: A (Enter) aims at its guard first; the next press fires.
    if (this.targeting.kind === 'attack' && this.fullyBlocked(target.id)) { this.aimAtGuard(target.id, false); return true; }
    if (this.targeting.kind === 'attack') this.attack(this.targeting.ws, target.id);
    else {
      const s = this.selectedStruct();
      if (s) this.order({ '@type': '/structs.structs.MsgStructDefenseSet', defenderStructId: s.id, protectedStructId: target.id }, TYPES_BY_ID[s.typeId].defendChangeCharge, `${TYPES_BY_ID[s.typeId].type} guards ${TYPES_BY_ID[target.typeId].type}`);
    }
    return true;
  }

  private handleKey(e: KeyboardEvent) {
    // Keys aimed at anything outside the battle (the ops or chat dock, a toast's button) are theirs:
    // START there doesn't fight, and the d-pad isn't pulled back to the panel.
    const tgt = e.target;
    if (tgt instanceof Element && tgt !== document.body && tgt !== document.documentElement && tgt !== this.engine.canvas && !this.root.contains(tgt)) return;
    // Typing anywhere (chat, a search) is typing, not orders.
    const typing = e.target as HTMLElement | null;
    if (typing?.closest?.('input, textarea, select, [contenteditable]') || typing?.isContentEditable) return;
    // A window on top (a confirm, the debrief, the vault) has the keyboard: Tab, 1, G… are its own.
    if (document.querySelector('.modal-back')) return;
    // Keys in the top bar and its menus are theirs (a pad walking the hubs), not orders.
    if (typing?.closest?.('.topbar, .hub-menu, .more-menu, .slot-editor')) return;
    // Backing out of the drift picker leaves the ship selected.
    if (typing?.closest?.('.drift') && e.key === 'Escape') { (typing as HTMLElement).blur(); return; }
    if (typing?.closest?.('.drift') && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const all = [...this.root.querySelectorAll<HTMLButtonElement>('.drift .btn.mini:not(:disabled)')];
      const at = all.indexOf(typing as HTMLButtonElement);
      all[(at + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + all.length) % all.length]?.focus({ focusVisible: true } as FocusOptions);
      audio.play('hover', 0.6);
      return;
    }
    // Escape closes an open ship picker first (one opened by a click has no focus inside it).
    if (e.key === 'Escape' && this.root.querySelector('.slot-editor')) {
      if (this.editorClose) this.editorClose(); else this.root.querySelectorAll('.slot-editor, .slot-scrim').forEach((n) => n.remove());
      audio.play('select');
      return;
    }
    const s = this.selectedStruct();
    const panel = this.phase === 'setup' ? this.root.querySelector<HTMLElement>('.setup-panel') : null;
    const inPanel = !!panel?.contains(document.activeElement);
    if (e.key === 'Escape') {
      this.clearAim();
      if (this.targeting) { this.targeting = null; this.refreshSelectionVisuals(); this.renderActionBar(); }
      // B on the setup board goes back to the panel (its cursor on Start).
      else if (this.onBoard() && !inPanel && panel) this.leaveBoard();
      else this.select(null);
      return;
    }
    // Setup, not aiming. On the board (a ship of yours or an empty bay under the cursor) the arrows walk
    // the bays and ships, and off the left edge back to the panel. In the panel they walk its buttons
    // as a pad's d-pad does (the first press lands on Start), and off its right edge onto the board.
    if (this.phase === 'setup' && !this.targeting && e.key.startsWith('Arrow')) {
      if (this.onBoard() && !inPanel) {
        e.preventDefault();
        if (!this.moveBoard(e.key)) { if (e.key === 'ArrowLeft' && panel) this.leaveBoard(); else audio.play('deny', 0.5); }
        return;
      }
      if (panel) {
        e.preventDefault();
        if (!inPanel) { panel.querySelector<HTMLElement>('.dc-start')?.focus({ focusVisible: true } as FocusOptions); audio.play('hover', 0.6); return; }
        // Within the panel first; off its right edge onto the board; any other edge as the pad does.
        const was = document.activeElement as HTMLElement;
        const inside = this.panelStep(panel, was, e.key);
        if (inside) { inside.focus({ focusVisible: true } as FocusOptions); inside.scrollIntoView({ block: 'nearest' }); audio.play('hover', 0.6); return; }
        if (e.key === 'ArrowRight' && this.enterBoard(was.getBoundingClientRect())) return;
        moveFocus(e.key as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight');
        audio.play('hover', 0.6);
        return;
      }
    }
    // Aiming without a mouse: arrows walk the targets, Enter (A on a pad) fires.
    if (this.targeting && (this.phase === 'battle' || this.phase === 'setup') && e.key.startsWith('Arrow')) { e.preventDefault(); this.cycleAim(e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1); return; }
    // While aiming, Enter fires at the aimed target even if a bar button kept the cursor.
    const onControl = !!typing?.closest?.('button, a[href]') && !(this.targeting && typing?.closest?.('.action-bar') && !typing?.closest?.('.drift'));
    if (e.key === 'Enter' && this.phase === 'battle' && !onControl) {
      e.preventDefault();
      if (this.targeting) { if (!this.commitAim()) this.cycleAim(0); return; }
      // Nothing selected: pick your first ship (as the battle does at the start) rather than nothing.
      if (!s || s.owner !== YOU.id || this.chain?.isDestroyed(s)) { this.selectBest(); return; }
      // Nothing armed: Enter arms the weapon that reaches their Command Ship, else the first with anything in reach.
      const ws = this.armFirst(s)?.ws;
      if (ws) { this.beginAttack(ws); if (this.targeting) this.cycleAim(0); return; }
      // This ship has nothing in reach: Enter hands over to the next ship of yours that has, or says
      // how to close the distance, rather than doing nothing.
      // (Never your Command Ship: its shots draw every counter-attack onto it.)
      const c = this.chain!;
      const cand = this.nextShooter(s);
      const next = cand && cand.id !== s.id && cand.typeId !== COMMAND_SHIP_ID && this.weaponsReady(cand).some((w) => w.targets.length) ? cand
        : Object.values(c.structs).filter((x) => x.owner === YOU.id && x.id !== s.id && x.typeId !== COMMAND_SHIP_ID && !c.isDestroyed(x) && this.weaponsReady(x).some((w) => w.targets.length))
          .sort((a, b) => AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit) || a.slot - b.slot)[0];
      if (next) {
        this.select(next.id);
        const ws2 = this.armFirst(next)?.ws;
        if (ws2) { this.beginAttack(ws2); if (this.targeting) this.cycleAim(0); }
        return;
      }
      if (this.endgame() === 'armed') return;
      this.nothingInReach();
      return;
    }
    if (e.key === ' ' && this.phase === 'battle') { e.preventDefault(); this.togglePause(); return; }
    // START (Space) fights from anywhere in setup; a keyboard's Space on a focused button presses that button.
    if (e.key === ' ' && this.phase === 'setup' && !this.targeting && (inputMode() === 'pad' || !onControl)) { e.preventDefault(); void this.engage(); return; }
    if ((e.key === 'z' || e.key === 'Z') && !e.metaKey && !e.ctrlKey) { this.zoom.reset(); return; }
    if (e.key === 'Enter' && this.phase === 'setup' && !onControl) {
      // Picking a guard: Enter (A) takes the aimed friend. On the board it opens the ship picker there.
      // With nothing under the cursor it starts the battle.
      if (this.targeting) { if (!this.commitAim()) this.cycleAim(0); return; }
      if (this.onBoard()) { e.preventDefault(); this.editAtCursor(); return; }
      void this.engage(); return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const c = this.activeChain();
      if (!c) return;
      const mine = Object.values(c.structs).filter((x) => x.owner === YOU.id && !c.isDestroyed(x)).sort((a, b) => (a.typeId === COMMAND_SHIP_ID ? -1 : b.typeId === COMMAND_SHIP_ID ? 1 : AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit) || a.slot - b.slot));
      if (!mine.length) return;
      const i = mine.findIndex((x) => x.id === this.selected);
      // In setup L/R steps onto the board: A then acts on the ship, not on a panel button left in focus.
      if (this.phase === 'setup') { this.boardKeys = true; if (panel?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur(); }
      this.select(mine[(i + (e.shiftKey ? -1 : 1) + mine.length) % mine.length].id);
      audio.play('hover');
      return;
    }
    if ((e.key === '1' || e.key === '2') && this.phase === 'battle' && (!s || s.owner !== YOU.id || this.chain?.isDestroyed(s))) { this.handleKey(new KeyboardEvent('keydown', { key: 'Enter' })); return; }
    if (!s || s.owner !== YOU.id) return;
    if (this.phase === 'setup' && (e.key === 'g' || e.key === 'G')) { this.startGuardPick(); if (this.targeting) this.cycleAim(0); return; }
    if (this.phase !== 'battle') return;
    // A destroyed hull can't act (and a new order would replace a valid queued one).
    if (this.chain?.isDestroyed(s)) return;
    const t = TYPES_BY_ID[s.typeId];
    if (e.key === '1' || e.key === '2') {
      // A weapon with nothing in reach hands over to the one that has (or, like Enter, to another ship).
      const w = this.weaponsReady(s)[Number(e.key) - 1];
      const ws = w?.targets.length ? w.ws : this.armFirst(s)?.ws;
      // (The other weapon, already aimed: the aim stays; only a key's own weapon pressed again lets go.)
      if (ws && ws !== w?.ws && this.targeting?.kind === 'attack' && this.targeting.ws === ws) { this.cycleAim(0); return; }
      if (ws) { this.beginAttack(ws); if (this.targeting) this.cycleAim(0); }
      else { const enter = new KeyboardEvent('keydown', { key: 'Enter' }); this.handleKey(enter); }
    } else if (e.key === 'g' || e.key === 'G') { this.startGuardPick(); if (this.targeting) this.cycleAim(0); }
    else if ((e.key === 's' || e.key === 'S') && t.unitDefenses === 'stealthMode') {
      const hidden = this.chain!.isHidden(s);
      this.order(hidden ? { '@type': '/structs.structs.MsgStructStealthDeactivate', structId: s.id } : { '@type': '/structs.structs.MsgStructStealthActivate', structId: s.id }, t.stealthActivateCharge, hidden ? 'Drop stealth' : 'Engage stealth');
    }
    if (e.key === 'd' || e.key === 'D') {
      // A choice, not a jump: D (Y on a pad) puts the cursor on the Command Ship's layer buttons
      // (selecting it first if need be); arrows pick, Enter (A) drifts, Escape (B) backs out.
      this.clearAim();
      if (this.targeting) { this.targeting = null; this.refreshSelectionVisuals(); }
      if (!t.movable) this.selectFirst(); else this.renderActionBar();
      requestAnimationFrame(() => {
        const first = this.root.querySelector<HTMLButtonElement>('.drift .btn.mini:not(:disabled)');
        if (first) { first.focus({ focusVisible: true } as FocusOptions); audio.play('select'); }
      });
    }
  }

  private togglePause() {
    if (this.phase !== 'battle' || !this.session) return;
    this.paused = !this.paused;
    if (this.paused) this.session.pause(); else this.session.resume();
    this.view.paused = this.paused;
    if (this.els.pause) { this.els.pause.innerHTML = icon(this.paused ? 'play' : 'pause', 16); this.els.pause.setAttribute('aria-label', this.paused ? 'Resume' : 'Pause'); this.els.pause.title = this.paused ? 'Resume (Space)' : 'Pause (Space)'; }
    toast(this.paused ? 'Paused — the chain waits' : 'Resumed', '', 1200);
  }

  /* ── Hover tooltip ────────────────────────────────────────────────────── */
  /** The armed weapon, its shooter and its target all still stand. */
  private armedStands() {
    const a = this.touchArmed;
    return !!a && this.targeting?.kind === 'attack' && this.targeting.ws === a.ws && this.selected === a.from && !!this.view.units.get(a.target)?.targetable;
  }

  private disarmTouch() {
    if (!this.touchArmed) return;
    this.touchArmed = null;
    hideTooltip();
    if (this.hovered) { const u = this.view.units.get(this.hovered); if (u) u.hover = 0; this.hovered = null; }
  }

  private updateHover() {
    const { unit, ghost } = this.pick(this.fingerNear);
    // A pinned touch forecast belongs to its target: a drag or a pointer onto anything else withdraws it.
    if (this.touchArmed && unit?.id !== this.touchArmed.target) this.disarmTouch();
    // An empty frame in setup is a button: the cursor says so, and the frame swells a little.
    const bay = !unit && ghost ? this.ghosts.children.find((m) => m.userData.ghost?.ambit === ghost.ambit && m.userData.ghost?.slot === ghost.slot) || null : null;
    if (bay !== this.ghostHover) {
      this.ghostHover?.scale.setScalar(1);
      this.ghostHover = bay;
      const editable = !this.gauntlet && !this.daily;
      if (bay && editable) { bay.scale.setScalar(1.1); audio.play('hover', 0.6); }
      if (!unit) this.engine.canvas.style.cursor = bay && editable ? 'pointer' : 'default';
    }
    const id = unit && !unit.destroyed ? unit.id : null;
    if (id !== this.hovered) {
      if (this.hovered) { const u = this.view.units.get(this.hovered); if (u) u.hover = 0; }
      this.hovered = id;
      // The mouse moved onto (or off) a ship: it aims now, not the keys' or pad's last pick.
      if (this.aimId && this.aimId !== id) this.aimId = null;
      this.refreshDock();
      if (unit) { unit.hover = 1; audio.play('hover'); }
      this.engine.canvas.style.cursor = unit ? (this.targeting && !unit.targetable ? 'not-allowed' : 'pointer') : this.ghostHover && !this.gauntlet && !this.daily ? 'pointer' : 'default';
    }
    if (!unit || unit.destroyed) { hideTooltip(); return; }
    this.tipFor(unit, this.pointerPx);
  }

  /** The struct card (and, while targeting, the forecast) for one unit, shown at `at`. */
  private tipFor(unit: UnitView, at: { x: number; y: number }) {
    const c = this.activeChain();
    const s = c?.structs[unit.id];
    if (!c || !s) { hideTooltip(); return; }
    // Docked (a short screen, a pad or keys): the forecast lives in the bar, nothing covers the field.
    if (this.dockAim()) {
      hideTooltip();
      this.refreshDock();
      return;
    }
    const t = TYPES_BY_ID[s.typeId];
    const lines: (HTMLElement | null)[] = [
      h('div', { class: 'spread' }, h('span', { class: 't-label ' + (unit.side === 'player' ? 'c-player' : 'c-enemy') }, t.type), h('span', { class: 'chip ambit-' + s.ambit }, AMBIT_NAME[s.ambit])),
      h('div', { class: 'row', style: 'margin:4px 0' }, h('div', { class: 'pips' }, Array.from({ length: t.maxHealth }, (_, i) => h('i', { class: i < s.health ? '' : 'lost' }))), h('span', { class: 't-tiny c-hint' }, DEFENSE_NAME[t.unitDefenses] || '')),
    ];
    const guardN = unit.side === 'enemy' ? this.guardsOf(unit.id).length : 0;
    if (guardN) lines.push(h('div', { class: 'dc-guarded', title: `${guardN} of their ships guard it: your shots at it hit a guard first. Sink the guards.` }, h('span', { html: icon('shield', 14) }), `Guarded ×${guardN}`));
    if (this.targeting?.kind === 'attack' && unit.targetable && this.selected) {
      const msg: Msg = { '@type': '/structs.structs.MsgStructAttack', operatingStructId: this.selected, targetStructId: [unit.id], weaponSystem: this.targeting.ws };
      const key = this.selected + unit.id + this.targeting.ws + c.height;
      let p = this.predictCache.get(key);
      if (!p) { p = predictAttack(c, msg, 40); this.predictCache.set(key, p); }
      if (p.error == null && 'hit' in p) {
        // The forecast as pictures and numbers: hit chance, damage, kill chance, then the risks.
        const row = (ico: string, label: string, value: string, cls = '') => h('div', { class: 'pf-row ' + cls }, h('span', { class: 'pf-ico', html: icon(ico, 16) }), h('span', { class: 'pf-k' }, label), h('b', null, value));
        lines.push(h('div', { class: 'predict dc-forecast' },
          row('target', 'Hit', pct(p.hit!), 'c-player'),
          row('boom', 'Damage', p.damage!.toFixed(1)),
          row('star', 'Kill', pct(p.kill!), 'c-warn'),
          p.blocked! > 0 ? row('shield', 'Blocked', pct(p.blocked!)) : null,
          p.counter! > 0 ? row('replay', 'Hits back', '−' + p.counter!.toFixed(1), 'c-enemy') : null,
          p.attackerDies! > 0 ? row('ship', 'You lose it', pct(p.attackerDies!), 'c-enemy') : null,
          h('div', { class: 't-tiny c-hint x-only', style: 'margin-top:3px' }, 'Forecast: 40 forks of the chain'),
        ));
      }
    } else if (this.targeting?.kind === 'guard' && unit.targetable) {
      lines.push(h('div', { class: 't-tiny c-player' }, 'Guard it: blocks shots, fires back'));
    } else {
      lines.push(h('div', { class: 't-tiny c-hint' }, roleOf(t)));
    }
    // The armed card's own Fire button (the only live control in a tooltip). Tapping the ship again fires too.
    // (pointerup, not click: the card is rebuilt each turn, and a press may straddle a rebuild.)
    const blockedAll = this.touchArmed?.target === unit.id && this.fullyBlocked(unit.id);
    // (One tap: the shot goes at the guard, as Fire would have gone at the ship it guards.)
    if (blockedAll) lines.push(h('button', { class: 'btn solid tip-fire tip-guard', type: 'button', title: 'Every shot at it would be blocked: fire at its guard instead', onpointerup: (e: Event) => {
      e.stopPropagation();
      this.aimAtGuard(unit.id, true);
      const a = this.touchArmed;
      if (a && this.targeting?.kind === 'attack' && a.target !== unit.id) { const ws = this.targeting.ws; this.disarmTouch(); this.attack(ws, a.target); }
    } },
      h('span', { html: icon('shield', 16) }), 'Hit its guard'));
    else if (this.touchArmed?.target === unit.id) lines.push(h('button', { class: 'btn solid tip-fire', type: 'button', onpointerup: (e: Event) => {
      e.stopPropagation();
      const a = this.touchArmed;
      if (!a || !this.armedStands() || this.targeting?.kind !== 'attack') return;
      const ws = this.targeting.ws;
      this.disarmTouch();
      this.attack(ws, a.target);
    } }, h('span', { html: icon('target', 16) }), 'Fire'));
    showTooltip(at.x, at.y, h('div', null, lines), unit.side === 'player' ? 'player' : 'enemy');
    this.fitTip(at);
  }

  /** The card never covers the verbs, the "Command Ship in reach" pill or a callout above them, nor
   * the HUD. Where it fits, it stays where it opened and only lifts clear of the bar. A short screen
   * (the TV's 480 lines, a phone on its side) has no room to spare: there the card sits beside its
   * ship in the band between the HUD and the verbs (dc-battle.css packs the forecast into two columns). */
  private fitTip(at: { x: number; y: number }) {
    if (this.phase === 'setup') return;
    const tip = document.querySelector<HTMLElement>('body > .tooltip.on');
    if (!tip) return;
    const rect = (sel: string) => { const e = this.root.querySelector<HTMLElement>(sel); const cs = e && e.getClientRects().length ? getComputedStyle(e) : null; return cs && cs.display !== 'none' && cs.visibility !== 'hidden' ? e!.getBoundingClientRect() : null; };
    const hud = rect('.battle-top'), bar = rect('.action-bar') || rect('.replay-bar'), pill = rect('.action-bar .targeting-hint'), coach = rect('.coach');
    const mid = window.innerHeight / 2;
    let top = (hud?.bottom ?? 44) + 6;
    let floor = Math.min(bar?.top ?? window.innerHeight, pill?.top ?? window.innerHeight) - 6;
    // A callout up under the HUD, or down above the bar, narrows the band too.
    if (coach && coach.top < mid) top = Math.max(top, coach.bottom + 6);
    if (coach && coach.top >= mid) floor = Math.min(floor, coach.top - 6);
    const w = tip.offsetWidth, hh = tip.offsetHeight;
    // (The stylesheet nudges every tooltip 14 px right and down: its box includes that.)
    if (window.innerHeight > 560) {
      const r = tip.getBoundingClientRect();
      if (r.bottom > floor + 0.5) tip.style.top = Math.round(Math.max(top, floor - hh) - 14) + 'px';
      return;
    }
    let x = at.x + 26;
    if (x + w > window.innerWidth - 8) x = at.x - 26 - w;
    x = clamp(x, 8, window.innerWidth - 8 - w);
    const y = floor - top >= hh ? clamp(at.y - hh / 2, top, floor - hh) : top;
    tip.style.left = Math.round(x - 14) + 'px';
    tip.style.top = Math.round(y - 14) + 'px';
  }

  /* ── Frame ────────────────────────────────────────────────────────────── */
  update(dt: number, t: number) {
    tickSpace(this.sky, t);
    // The block clock keeps wall time even when frames are slow.
    // A tutorial step waiting on the player holds the turn clock: nothing happens while they read.
    // (An order already in, or held for charge, lets the turns run: it has to land.)
    const teaching = this.coachStay && !!this.coachEl?.isConnected && !this.session?.pending && !this.held;
    if (this.session && this.phase === 'battle' && !this.paused && !teaching) this.session.update(Math.max(dt, this.engine.realDt) * 1000);
    if (this.phase === 'replay') this.stepReplay(dt);
    this.view.update(dt, t);
    if (this.phase === 'battle' || this.phase === 'deploy') this.paintHud();
    if (this.pointer.x < 2) this.updateHover();
    else this.dropGhostHover();
    this.paintCursor();
    if (this.coachKey === 'fill' || this.fillMark) this.paintFillMark();
    if (this.reachIds.size || this.reachEls.size) this.paintReach();
    if (this.phase === 'battle' || this.guardEls.size) this.paintGuardMarks();
    if (this.coachDirty && this.coachEl?.isConnected && this.coachEl.offsetWidth) this.placeCoach();
    // A held touch forecast lapses once its weapon, shooter or target no longer stands.
    if (this.touchArmed && !this.armedStands()) this.disarmTouch();

    // Ghost frames pulse and scan.
    GHOST.mat.uniforms.uTime.value = t;
    GHOST.lockedMat.uniforms.uTime.value = t;
    GHOST.focusMat.uniforms.uTime.value = t;

    // Camera: parallax toward the pointer, lean toward the action, idle sway.
    const px = this.pointer.x < 2 ? this.pointer.x : 0, py = this.pointer.x < 2 ? this.pointer.y : 0;
    this.focusW = Math.max(0, this.focusW - dt * 0.35);
    this.punch = Math.max(0, this.punch - dt * 0.45);
    const lean = clamp(this.focusW, 0, 0.6) + this.punch * 0.9;
    // Zoomed in, the sway and parallax shrink with the distance so the view holds still.
    const z = this.zoom;
    z.update(dt);
    const zs = z.cur;
    const off = z.offset;
    // Sway, lean and distance are smoothed on their own; the zoom (scale and pan, smoothed
    // together in BoardZoom) is applied on top, so the point under the cursor stays put.
    const sx = px * 2.6 + Math.sin(t * 0.13) * 0.8 + this.focus.x * 0.12 * lean;
    const sy = 0.6 + py * 1.4 + Math.sin(t * 0.17) * 0.3 + this.focus.y * 0.1 * lean;
    const dist = this.fitDist * (1 - 0.32 * Math.min(1, this.punch * 1.4));
    if (this.snapCam) { this.sway.set(sx, sy); this.dist = dist; this.look.set(0, -0.4); }
    this.sway.x = damp(this.sway.x, sx, 2.2, dt);
    this.sway.y = damp(this.sway.y, sy, 2.2, dt);
    this.dist = damp(this.dist, dist, 3, dt);
    this.look.x = damp(this.look.x, this.focus.x * 0.18 * lean, 2, dt);
    this.look.y = damp(this.look.y, -0.4 + this.focus.y * 0.12 * lean, 2, dt);
    this.snapCam = false;
    const cam = this.camera.position;
    cam.set(off.x + this.sway.x * zs, off.y + this.sway.y * zs, this.dist * zs);
    this.camLook.set(off.x + this.look.x * zs, off.y + this.look.y * zs, 0);
    this.camera.lookAt(this.camLook);
  }
}

function pct(v: number) { return Math.round(v * 100) + '%'; }
/** "an Easy computer", "a Hard one". */
function aOrAn(word: string) { return (/^[aeiou]/i.test(word) ? 'an ' : 'a ') + word; }

/** Time until the next UTC day (and the next daily), as "5h 12m". */
function untilTomorrow() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const m = Math.max(0, Math.round((next - now.getTime()) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** Text for an HTML context. */
function esc(v: unknown) {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function humanError(e: string) {
  if (e.includes('insufficient charge')) return 'not enough charge — ' + e.split(': ').pop();
  if (e.includes(': hidden')) return 'the target is hidden (stealth) in another layer';
  if (e.endsWith(' is hidden')) return 'it is already hidden';
  if (e.includes('out_of_range')) return 'the target is out of reach';
  if (e.includes('destroyed')) return 'that ship is already destroyed';
  if (e.includes('slot_occupied')) return 'that slot is taken';
  if (e.includes('unreachable')) return 'that fleet has left the battle';
  return e;
}

/* An empty slot during setup: a holographic bay — corner brackets, a faint
 * rising fill, a scan line sweeping up, a "+" sigil and a pad of light on the
 * deck. One shared plate and material for every ghost (they live as long as
 * the screen). */
const GHOST = (() => {
  const plate = new THREE.PlaneGeometry(2.7, 2.2);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uSeed: { value: 0 }, uColor: { value: new THREE.Color(0x43cdb6) }, uPlus: { value: 1 }, uBoost: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vW; void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform float uPlus; uniform float uBoost; varying vec2 vUv; varying vec3 vW;
      float box(vec2 p, vec2 a, vec2 b) { vec2 s = step(a, p) * step(p, b); return s.x * s.y; }
      void main() {
        vec2 p = vUv * vec2(2.7, 2.2);
        vec2 q = min(p, vec2(2.7, 2.2) - p);           // distance to the nearest edges
        float w = 0.045, len = 0.42;
        // Corner brackets: an L in each corner.
        float br = (step(q.x, w) * step(q.y, len) + step(q.y, w) * step(q.x, len));
        br = clamp(br, 0.0, 1.0);
        // Hairline frame between the brackets.
        float hair = (step(q.x, 0.012) + step(q.y, 0.012)) * 0.22;
        // Rising fill and a scan line that sweeps up the bay.
        float fill = smoothstep(1.0, 0.0, vUv.y) * 0.07;
        float scanY = fract(uTime * 0.35 + vW.x * 0.03);
        float scan = smoothstep(0.03, 0.0, abs(vUv.y - scanY)) * 0.35 * smoothstep(0.0, 0.2, q.x);
        // A "+" in the middle that breathes, slow and soft, so an empty bay reads as "add a ship here".
        // (A fixed fleet's bays, uPlus 0, have none and sit dimmer.)
        vec2 c = abs(p - vec2(1.35, 1.1));
        float plus = clamp(box(c, vec2(0.0), vec2(0.36, 0.07)) + box(c, vec2(0.0), vec2(0.07, 0.36)), 0.0, 1.0);
        plus *= uPlus * (0.5 + 0.5 * (0.5 + 0.5 * sin(uTime * 2.4 + vW.x * 0.5))) * (1.0 + uBoost * (0.6 + 0.6 * sin(uTime * 5.0)));
        // Deck pad: a soft ellipse of light along the base.
        vec2 e = (vUv - vec2(0.5, 0.0)) * vec2(1.0, 4.2);
        float pad = exp(-dot(e, e) * 5.0) * 0.4;
        float pulse = 0.75 + 0.25 * sin(uTime * 3.0 + vW.x * 0.6);
        float frame = (br * 0.95 + hair + fill + scan + pad) * pulse * mix(0.55, 1.0, uPlus);
        float a = clamp(frame + plus, 0.0, 1.0);
        gl_FragColor = vec4(uColor * frame * 1.3 + vec3(0.8, 0.97, 1.0) * plus * 1.3, a);
      }
    `,
  });
  const lockedMat = mat.clone();
  lockedMat.uniforms.uPlus.value = 0;
  // The bay under a pad's (or keys') cursor glows in the accent.
  const focusMat = mat.clone();
  focusMat.uniforms.uColor.value = new THREE.Color(2.2, 0.95, 0.25);   // the accent, lifted (it adds over space)
  const pick = new THREE.BoxGeometry(2.8, 2.2, 1.4);
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });
  return { plate, mat, lockedMat, focusMat, pick, pickMat };
})();
