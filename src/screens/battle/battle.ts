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
import { structPortrait } from '../../gfx/hull/portrait';
import { BattleView, type UnitView } from './view';
import { BattleSession, DECIDE_AT, predictAttack, QUIET_BLOCKS, type Outcome } from './session';
import { addBattleLights, FIELD, fieldHalfWidth, portraitField, slotStagger, slotX, tierStretch, WORLD_PALETTES } from './env';
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
  { preset: 'difficult', difficulty: 'difficult' }, { preset: 'hard', difficulty: 'difficult', why: 'it hunts your flagship: keep its guard' }, { preset: 'hard', difficulty: 'hard' },
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
  arm: '.action-bar .btn.action.weapon.a-first:not(:disabled) || .action-bar .btn.action.weapon:not(:disabled), .action-bar.ab-pick, .action-bar.empty',
  aim: '.action-bar .btn.action.weapon.active',
  // "A move needs its ⚡": the ⚡ on the weapon's button (the HUD's battery drains as it says).
  charge: '.action-bar .btn.action.weapon.a-first .a-cost || .action-bar .btn.action.weapon .a-cost',
  guard: '.action-bar .btn.action.guard-btn',
  // (' || ': the first that is on screen. Drift's own buttons show only with the flagship selected; else
  // the pointer goes to your flagship's row in the HUD.)
  drift: '.action-bar .drift || .battle-top .fleet-card.player',
  flagship: '.action-bar .btn.action.weapon.active',
  stuck: '.action-bar .drift .btn.mini.dc-go-layer || .action-bar .drift',
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
  private gauntlet: { round: number; fleet: Unit[]; seed: string; engaged: boolean; over: boolean; fought: number; reinforce: boolean; ms?: number } | null = null;
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
    this.rewardsOwed = false;
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
    document.querySelectorAll('.debrief-back, .gauntlet-back, .gauntlet-intro, .slot-editor, .dc-guard-chip').forEach((n) => n.remove());
    this.forfeitIfEngaged();
  }

  resize(_w: number, hgt: number) {
    this.view?.fx.setScale(hgt, this.camera.fov);
    // A phone turned mid-fight: the decks stand apart only while it is upright (buildBoard). A browser
    // bar coming and going changes the height too: that keeps the stretch it has (no rebuild).
    if (this.view && this.phase !== 'setup') {
      // A fight begun on its side and turned upright moves onto the compact deck too.
      let moved = false;
      if (portraitField() && !FIELD.compact) { FIELD.compact = true; moved = true; }
      if (this.view.set.layTiers(FIELD.compact && portraitField() ? (this.view.set.stretch > 1 ? this.view.set.stretch : tierStretch()) : 1)) moved = true;
      if (moved) this.view.restand();
    }
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
    const stretched = this.view.set.layTiers(compact && portraitField() && this.phase !== 'setup' ? tierStretch() : 1);
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
    // (Stretched decks on an upright phone fill the band between the HUD and the bar: centred lower.)
    else if (this.phase !== 'setup') this.camera.setViewOffset(w, hgt, right / 2, compact ? (short ? -10 : (this.view?.set.stretch ?? 1) > 1 ? 4 : 34) : -12, w, hgt);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /* ── Setup ────────────────────────────────────────────────────────────── */
  private toSetup(reroll = true) {
    this.clearPointer();
    // (Anything held plays now, in setup: nothing is owed to the next fight, unless Again or Next goes
    // straight into one: fightOrFill.)
    holdRewards(false);
    this.rewardsOwed = false;
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
    document.querySelectorAll('.debrief-back, .banner, .dc-guard-chip').forEach((n) => n.remove());
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
        h('div', { class: 'dc-setup-head' }, h('span', { class: 'dc-setup-ico', html: icon('target', 30) }), h('span', { class: 't-display' }, g ? `Round ${g.round}/5` : this.daily ? this.daily.name.replace(/^Operation /, '') : 'Battle'),
          this.gauntletWins() ? h('span', { class: 'dc-gauntlet-trophy', title: `Gauntlet won${this.gauntletWins() > 1 ? ` ×${this.gauntletWins()}` : ''}${this.gauntletBestMs() ? ` · best run ${clock(this.gauntletBestMs())}` : ''}`, 'aria-label': 'Gauntlet won', html: icon('flag', 16) }) : null,
          this.ladderCleared() ? h('span', { class: 'dc-ladder-crown', title: `Ladder cleared${this.ladderCleared() > 1 ? ` ×${this.ladderCleared()}` : ''}: you beat a Large fleet on Hard`, 'aria-label': 'Ladder cleared', html: icon('crown', 18) }) : null),
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
        h('div', { class: 'dc-versus' + (this.outnumbered() ? ' outnumbered' : ''), title: this.daily || g ? say({ pad: 'Your ships are fixed. Select one and press X to change who it guards.', keys: 'Your ships are fixed. Select one and press G to change who it guards.', touch: 'Your ships are fixed. Tap one, then Guard, to change who it guards.' })
          : say({ pad: 'Press A on one of your ships to swap it, or on an empty frame to add one. X chooses who it guards.', keys: 'Click one of your ships to swap it, or an empty frame to add one. Select a ship and press G to choose who it guards.', touch: 'Tap one of your ships to swap it, or an empty frame to add one. Tap a ship, then Guard, to choose who it guards.' }) },
          h('span', { class: 'c-player', html: icon('ship', 22) }), h('b', { class: 'c-player' }, String(youCount)),
          h('span', { class: 'dc-vs' }, 'VS'),
          h('b', { class: 'c-enemy' }, String(cpuCount)), h('span', { class: 'c-enemy dc-flip', html: icon('ship', 22) }),
          // Outnumbered with bays to spare: one press adds a ship (the picker opens on the first empty bay).
          this.outnumbered() && this.emptyBays().length ? h('button', { class: 'btn dc-outnumbered', 'data-k': 'add', 'aria-label': `Outnumbered: add a ship (${cpuCount} against ${youCount})`,
            title: `Outnumbered: ${cpuCount} enemy ships against your ${youCount}. Add ships to your empty bays (the + frames): each tap here opens the next one.`,
            onclick: () => { audio.play('select'); this.fillBay(); } }, h('span', { class: 'dc-add-plus' }, '+'), h('span', { class: 'dc-add-w' }, 'Add')) : null),
        err ? h('div', { class: 't-tiny c-enemy' }, err) : null,
        this.reachCue(),
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

  /** Setup: their flagship's layer is out of every ship's reach: say so (its layer's icon, one line). */
  private reachCue(): HTMLElement | null {
    const cs = this.draft.find((u) => u.side === 'computer' && u.type === COMMAND_SHIP_ID);
    if (!cs || this.spectate) return null;
    const reaches = (u: Unit) => (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).some((ws) => hasWeapon(TYPES_BY_ID[u.type], ws) && canTargetAmbit(TYPES_BY_ID[u.type], ws, u.ambit, cs.ambit));
    if (this.draft.some((u) => u.side === 'player' && reaches(u))) return null;
    const L = AMBIT_NAME[cs.ambit];
    return h('div', { class: 'dc-reach-cue', title: `Their Command Ship flies in ${L} and none of your ships can hit it there. Swap in a ship whose weapons reach ${L}.` },
      h('span', { class: 'ambit-' + cs.ambit, html: icon(cs.ambit, 16) }), `Their flagship flies in ${L}: bring a ship that reaches it`);
  }

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

  /** Gauntlets won in this browser, and the fastest won run's fighting time (ms; 0: none yet). */
  private gauntletWins(): number { try { return Number(localStorage.getItem('structs.gauntlet.won') || 0); } catch { return 0; } }
  private gauntletBestMs(): number { try { return Number(localStorage.getItem('structs.gauntlet.bestMs') || 0); } catch { return 0; } }
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
    this.gauntlet = { round: 1, fleet, seed, engaged: false, over: false, fought: 0, reinforce: false, ms: 0 };
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
      // Go means go: round 1 starts (its setup is the round's own, fixed).
      void this.engage();
    };
    const key = (e: KeyboardEvent) => {
      if (!back.isConnected) { window.removeEventListener('keydown', key, true); return; }
      const modals = document.querySelectorAll('.modal-back');
      if (modals[modals.length - 1] !== back) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(false); return; }
      // A held Enter (the one that picked the tile) mustn't also answer the card.
      if ((e.key === 'Enter' || e.key === ' ') && e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      // START (Space) is Go too: a pad's START always (whatever has the cursor); a keyboard's Space
      // presses the button in focus.
      if (e.key === ' ' && (inputMode() === 'pad' || !e.isTrusted || !(document.activeElement instanceof HTMLButtonElement && back.contains(document.activeElement)))) { e.preventDefault(); e.stopImmediatePropagation(); close(true); return; }
      // Enter on a button presses that button; anywhere else it is Go.
      if (e.key === 'Enter' && !(document.activeElement instanceof HTMLButtonElement && back.contains(document.activeElement))) { e.preventDefault(); e.stopImmediatePropagation(); close(true); }
    };
    const row = (cls: string, title: string, lead: Node, word: string, extra?: Node) =>
      h('div', { class: 'dc-gi-row ' + cls, title }, h('span', { class: 'dc-gi-lead' }, lead), h('span', { class: 'dc-gi-word' }, word), extra || null);
    const back = h('div', { class: 'modal-back gauntlet-intro' },
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
    // The next round's flagship out of every ship's reach: one offer is a ship that reaches it (crowned).
    const nextCs = gauntletEnemy(g.round, g.seed).find((u) => u.type === COMMAND_SHIP_ID);
    const reaches = (type: number, from: Ambit, to: Ambit) => (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).some((ws) => hasWeapon(TYPES_BY_ID[type], ws) && canTargetAmbit(TYPES_BY_ID[type], ws, from, to));
    let reacher = -1;
    if (nextCs && !g.fleet.some((u) => reaches(u.type, u.ambit, nextCs.ambit)) && !offers.some((o) => reaches(o.type, o.ambit, nextCs.ambit))) {
      const free: { ambit: Ambit; slot: number }[] = [];
      for (const ambit of AMBITS) for (let slot = 0; slot < 4; slot++) if (!g.fleet.some((u) => u.type !== COMMAND_SHIP_ID && u.ambit === ambit && u.slot === slot) && !offers.some((o) => o.ambit === ambit && o.slot === slot)) free.push({ ambit, slot });
      outer: for (const ft of FLEET_TYPES) {
        if (ft.id === COMMAND_SHIP_ID) continue;
        for (const cell of free) if (fits(ft.id, cell.ambit) && reaches(ft.id, cell.ambit, nextCs.ambit)) {
          const o = { type: ft.id, ambit: cell.ambit, slot: cell.slot };
          if (offers.length >= 3) offers[offers.length - 1] = o; else offers.push(o);
          reacher = offers.indexOf(o);
          break outer;
        }
      }
    }
    // Down to two ships or fewer: every ship card also repairs the Command Ship (a lone flagship can't win a
    // round, however whole), and a repair alone is no longer offered.
    const few = g.fleet.length <= 2 && !!cmd && (cmd.health ?? 6) < 6 && offers.length > 0;
    const cards = offers.map((o) => {
      const t = TYPES_BY_ID[o.type];
      const img = h('img', { alt: '' });
      void structPortrait(o.type).then((u) => { img.src = u; });
      return h('button', { class: 'reward', onclick: () => choose(() => { g.fleet.push({ id: unitId('player', o.type, o.ambit, o.slot), side: 'player', type: o.type, ambit: o.ambit, slot: o.slot, protects: null }); if (few && cmd) cmd.health = undefined; }) },
        h('div', { class: 'sprite big player' }, img), h('div', { class: 't-label c-player' }, t.type), h('div', { class: 't-tiny c-hint' }, `${AMBIT_NAME[o.ambit]} · ${roleOf(t)}`),
        offers.indexOf(o) === reacher && nextCs ? h('div', { class: 't-tiny c-warn reward-reach', title: `Next round their flagship flies in ${AMBIT_NAME[nextCs.ambit]}: none of yours reach it` }, h('span', { html: icon('crown', 12) }), ` Reaches ${AMBIT_NAME[nextCs.ambit]}`) : null,
        few ? h('div', { class: 't-tiny c-player' }, '✚ and a full repair') : null);
    });
    if (cmd && (cmd.health ?? 6) < 6 && !few) {
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
        strikesCs(t.id) ? h('span', { class: 'slot-cs', 'aria-label': 'reaches their Command Ship', html: icon('target', 15) }) : null));
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
    ed.querySelectorAll<HTMLImageElement>('img.slot-img').forEach((img) => { void structPortrait(Number(img.dataset.type)).then((u) => { img.src = u; }); });
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
    // Rewards earned in this fight (or still on their way from the last results) wait for its results
    // screen, from the countdown on (core/dom holdRewards: a release already scheduled re-queues).
    holdRewards(true);
    // The last results' rewards, skipped past (Next or Again pressed before they played): they play once
    // this fight is under way (after the countdown), then the hold resumes for this fight's own.
    if (this.rewardsOwed) {
      this.rewardsOwed = false;
      const s0 = this.session;
      setTimeout(() => {
        if (this.phase !== 'battle' || !this.root.isConnected) return;
        holdRewards(false);
        setTimeout(() => { if (this.phase === 'battle' && this.root.isConnected) holdRewards(true); }, 8000);
      }, 7000);
      void s0;
    }
    audio.play('confirm');
    document.querySelectorAll('.slot-editor, .slot-scrim').forEach((n) => n.remove());
    this.phase = 'deploy';
    this.clearPointer();
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
    // Overtime: a call and a double beep; the turn card counts down the seconds from here (paintHud).
    this.session.onOvertime = () => {
      banner('OVERTIME', 'MORE HULL WINS', 'neutral', 1800);
      audio.play('alert');
    };
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
    audio.setIntensity(1);
    this.session.start();
    this.endgameKey = '';
    this.endgameSel = null;
    this.stuckLayer = null;
    this.stuckWhy = 'reach';
    this.otBehind = false; this.otNudged = false; this.soNudged = false;
    this.csReachAt = this.chain?.height ?? 0; this.hideNudged = false;
    this.flagshipTold = false;
    this.driftAsk = null;
    this.cmdHits = 0; this.cmdHitDmg = 0; this.cmdCounterDmg = 0; this.cmdGuardsSunk = 0; this.cmdGuardsLeft = 0; this.cmdGuardPossible = false; this.guardOfferDue = false; this.theirGuardMax = 0;
    this.cmdGuardIds = new Set();
    { const c0 = this.chain!, mine = Object.values(c0.structs).find((x) => x.owner === YOU.id && x.typeId === COMMAND_SHIP_ID); const bl = mine ? this.blockersOf(mine.id) : [];
      this.cmdBlockersWas = new Set(bl.map((g) => g.id)); for (const g of bl) this.cmdGuardIds.add(g.id);
      this.cmdGuardMax = bl.length; this.cmdGuardAtEnd = bl.length; }
    this.shotLanded = false;
    this.cmdHp = null;
    // The fight opens on the best attacker that isn't the Command Ship: the flagship's own shots draw
    // every counter-attack onto it (it stays one Tab, or a click, away).
    this.selectBest();
    this.countReach();
    // A first battle walks through its first shot in three steps, each waiting until it is done
    // (only when a shot is possible: a step nothing can finish would just hold the clock).
    const canShoot = Object.values(this.chain!.structs).some((x) => x.owner === YOU.id && !this.chain!.isDestroyed(x) && this.weaponsReady(x).some((w) => w.targets.length));
    // The rung where the sharper computer hunts your flagship: the Guard step plays again at the start
    // (once a fight, unless a guard already blocks for your Command Ship in its layer).
    const hunts = this.preset === 'hard' && this.difficulty !== 'easy' && !this.gauntlet && !this.daily && !this.scenario && !this.spectate;
    this.guardGoal = hunts ? 2 : 1;
    // (Offered on the first turn the player is free: nothing armed, picked, queued or waiting.)
    this.guardStartDue = hunts && this.coachSeen('arm');
    // Step 1 waits for the ENGAGE banner to clear, so the two never stack over the fleet. A player
    // quicker than the banner has found the weapon alone: step 1 counts as done, and step 2 (or 3) follows.
    if (!this.spectate && canShoot && !this.coachSeen('arm')) setTimeout(() => {
      if (this.session !== session || this.phase !== 'battle') return;
      const shot = (m?: Msg) => !!m && String(m['@type']).endsWith('MsgStructAttack');
      if (shot(session.pending?.msg) || shot(this.held?.msg)) { this.coachMark('arm'); this.coachMark('aim'); return; }
      if (this.targeting?.kind === 'attack') { this.coachMark('arm'); this.coach('aim', 'Step 2 of 3 · Fire', { pad: 'D-pad picks, A fires', keys: 'Click FIRE again (or the ringed ship)', touch: 'Tap FIRE' }, true); return; }
      // Another ship (or an enemy) may have been picked meanwhile: the step starts on one of yours that can shoot.
      if (!this.targeting) this.pickReadyShip();
      this.coach('arm', 'Step 1 of 3 · Weapon', { pad: 'Press A', keys: 'Press 1, or click a weapon', touch: 'Tap a weapon below' }, true);
    }, 1500);
  }

  /** This fight: enemy shots that hit your Command Ship (not blocked, not evaded) and their damage; the
   * damage its own shots drew back; its guards sunk, and its guards left behind. */
  private cmdHits = 0;
  private cmdHitDmg = 0;
  private cmdCounterDmg = 0;
  private cmdGuardsSunk = 0;
  private cmdGuardsLeft = 0;
  /** Some ship of yours could have guarded it at some point this fight. */
  private cmdGuardPossible = false;
  /** The most guards their flagship had at once this fight. */
  private theirGuardMax = 0;
  /** Guards that blocked for it this fight, and how many blocked last turn. */
  private cmdGuardIds = new Set<string>();
  private cmdBlockersWas = new Set<string>();
  /** Guard flashes (the flagship's last guard was sunk) until then. */
  private guardFlashUntil = 0;
  /** The most guards it had at once this fight, and how many it had on its last turn afloat. */
  private cmdGuardMax = 0;
  private cmdGuardAtEnd = 0;
  /** The fight's first shot of yours has landed; your Command Ship's health last turn (null: not yet seen). */
  private shotLanded = false;
  private chargeAt = 0;
  private cmdHp: number | null = null;
  /** "Guard your Command Ship": hands over a ship that can (in the flagship's layer, where guards block),
   * selected, its Guard button pointed at. Done when the guard order goes in, or on OK. */
  /** `hold`: the step holds the clock (a oncePerFight key: held the first time the step really shows). */
  private guardStep(again = false, hold: boolean | string = true) {
    // On the rungs that hunt flagships it wants two ("Guard 1 of 2", then "2 of 2"); guarded enough already,
    // there is nothing to teach (and nothing to hold the clock for).
    const c = this.chain, cmd = c && Object.values(c.structs).find((x) => x.owner === YOU.id && x.typeId === COMMAND_SHIP_ID && !c.isDestroyed(x));
    const have = cmd ? this.blockersOf(cmd.id).length : 0;
    if (have >= this.guardGoal) return false;
    const guard = this.guardCandidate();
    if (!guard) return false;
    this.select(guard.id);
    const c0 = this.chain, old = guard.protectedStructId && c0 ? c0.structs[guard.protectedStructId] : null;
    const retask = old && !c0!.isDestroyed(old) ? ` (it stops guarding the ${TYPES_BY_ID[old.typeId].type})` : '';
    const title = this.guardGoal > 1 ? `Step ${Math.min(have + 1, this.guardGoal)} of ${this.guardGoal} · Guard` : 'Guard';
    if (typeof hold === 'string') hold = this.oncePerFight(hold);
    this.coach('guard', title, { pad: `Guard your Command Ship: X, then pick it${retask}`, keys: `Guard your Command Ship: G, then click it${retask}`, touch: `Guard your Command Ship: tap Guard, then it${retask}` }, hold, again);
    return true;
  }
  /** Why an order can no longer go (its ship or target gone, its target out of reach), or null. */
  private orderStale(msg: Msg): string | null {
    const c = this.chain;
    if (!c) return 'ship gone';
    const m = msg as unknown as Record<string, unknown>;
    const actor = c.structs[String(m.operatingStructId || m.structId || m.defenderStructId || '')];
    if (!actor || c.isDestroyed(actor)) return 'ship gone';
    const tid = Array.isArray(m.targetStructId) ? String(m.targetStructId[0]) : m.protectedStructId ? String(m.protectedStructId) : '';
    if (!tid) return null;
    const t = c.structs[tid];
    if (!t || c.isDestroyed(t)) return 'target gone';
    if (String(m['@type']).endsWith('MsgStructAttack') && c.canAttack(actor, t, m.weaponSystem as WeaponSystem)) return 'out of reach';
    if (String(m['@type']).endsWith('MsgStructAttack') && actor.owner === YOU.id && actor.typeId === COMMAND_SHIP_ID && !this.flagshipSafe(actor, m.weaponSystem as WeaponSystem, t.id)) return 'too hurt';
    return null;
  }
  /** What the queued order is, in words (said when something replaces it). */
  private pendingLabel = '';
  /** How many guards the flagship should have (two where the computer hunts it). */
  private guardGoal = 1;
  /** The hunting rungs' opening Guard step is still to be offered (on a free turn). */
  private guardStartDue = false;
  /** This turn's hit on an unguarded flagship asks for the one-press chip (made after the Guard steps). */
  private chipDue = false;
  /** The last turn a ship of yours reached their flagship; the once-a-fight "it hides in…" line is said. */
  private csReachAt = 0;
  private hideNudged = false;
  private hideCheck(height: number) {
    const c = this.chain;
    if (!c || this.spectate || this.phase !== 'battle' || this.session?.finished) return;
    const theirs = Object.values(c.structs).find((x) => x.owner !== YOU.id && x.typeId === COMMAND_SHIP_ID && !c.isDestroyed(x));
    const mine = Object.values(c.structs).filter((x) => x.owner === YOU.id && !c.isDestroyed(x));
    if (!theirs || mine.some((x) => this.weaponsReady(x).some((w) => w.targets.some((t) => t.id === theirs.id)))) { this.csReachAt = height; return; }
    if (this.hideNudged || height - this.csReachAt < 10) return;
    this.hideNudged = true;
    // Your flagship (it alone changes layer) goes only where the Move rule finds it safe, it isn't
    // crippled, and from there it reaches theirs; under fire or crippled it guards first; else the ship
    // type that would reach it.
    const cmd = mine.find((x) => x.typeId === COMMAND_SHIP_ID);
    const ct = cmd && TYPES_BY_ID[cmd.typeId];
    const reachFrom = (t: (typeof TYPES_BY_ID)[number], a: Ambit) => (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).some((ws) => hasWeapon(t, ws) && canTargetAmbit(t, ws, a, theirs.ambit));
    const adv = cmd && ct && ct.movable ? this.moveAdvice(c, cmd) : null;
    const safeTo = adv?.to && ct && cmd && cmd.health > 2 && reachFrom(ct, adv.to) ? adv.to : null;
    const L = AMBIT_NAME[theirs.ambit];
    let text: string;
    if (safeTo) {
      text = safeTo === theirs.ambit ? `Their flagship's in ${L}: move yours there` : `Their flagship's in ${L}: move yours to ${AMBIT_NAME[safeTo]}`;
      // (Your card, which selects your flagship, and its Move pulse while the line shows.)
      this.movePulseUntil = performance.now() + 6000;
      const fc = this.root.querySelector<HTMLElement>('.battle-top .fleet-card.player');
      fc?.classList.add('dc-pulse'); setTimeout(() => fc?.classList.remove('dc-pulse'), 6000);
      this.renderActionBar();
    } else if (cmd && (cmd.health <= 2 || (adv?.here ?? 0) > 0)) text = `Their flagship's in ${L}: guard yours first`;
    else {
      const types = FLEET_TYPES.map((x) => TYPES_BY_ID[x.id]).filter((t) => t && t.id !== COMMAND_SHIP_ID && AMBITS.some((a) => (t.possibleAmbit & AMBIT_FLAG[a]) !== 0 && reachFrom(t, a)));
      const t = types.sort((p0, p1) => p0.type.length - p1.type.length)[0];
      text = t ? `Their flagship's in ${L}: a ${t.type} reaches it` : `Their flagship's in ${L}: out of reach`;
    }
    this.hudNudge(theirs.ambit, text, 'gold', 6000);
  }
  /** The flagship's Move control pulses until then (a "move yours there" line is up). */
  private movePulseUntil = 0;
  /** One line under the turn card (and the overtime meter) for a few seconds: an icon and a few words. */
  private hudNudge(ico: string | null, text: string, cls = '', ms = 4200) {
    const card = this.els.blockNum?.closest('.block-card') as HTMLElement | null;
    if (!card) return;
    card.querySelectorAll('.dc-ot-nudge').forEach((x) => x.remove());
    const n = h('div', { class: 'dc-ot-nudge ' + cls, role: 'status' }, ico ? h('span', { class: 'dc-nudge-ico', html: icon(ico, 16) }) : null, text);
    card.appendChild(n);
    setTimeout(() => { n.classList.add('out'); setTimeout(() => n.remove(), 400); }, ms);
  }
  /** Overtime: the deciding hull row is behind (the meter's word); the once-a-fight nudge has been said. */
  private otBehind = false;
  private otBehindRow: 'cmd' | 'fleet' = 'cmd';
  private soNudged = false;
  private otNudged = false;
  /** The fight just finished (the results' tips read how it ended). */
  private lastOutcome: Outcome | null = null;
  /** The results' line for a decision on time: whose flagship (or, flagships even, whose fleet) had more hull. */
  private timeLine(o: Outcome) {
    const fleet = !o.hull || Math.abs(o.hull.you - o.hull.cpu) <= 1e-9;
    const why = o.stalemate === 'time' ? 'Time' : 'Standoff';
    return o.winner === 'you' ? (fleet ? `${why}: your fleet had more hull` : `${why}: your flagship had more hull`)
      : o.winner === 'cpu' ? (fleet ? `${why}: their fleet had more hull` : `${why}: theirs had more hull`) : `${why}: even hull`;
  }
  /** Each side's hull at a decision on time, in words (titles). */
  private hullWords(o: Outcome) {
    const p = (v: number) => Math.round(v * 100) + '%';
    return o.hull ? `of the hull each began this fight with, your flagship kept ${p(o.hull.you)}, theirs ${p(o.hull.cpu)}; your fleet ${p(o.hull.fleetYou)}, theirs ${p(o.hull.fleetCpu)}` : '';
  }
  /** The last results closed before its rewards played (they play once the next fight is under way). */
  private rewardsOwed = false;
  /** A Guard step is owed (skipped while the player was busy, or its ship sank). */
  private guardOfferDue = false;
  /** One press guards the flagship: the chip that shows when it is hit with no guard. */
  private guardChip(cmd: SimStruct) {
    if (this.root.querySelector('.dc-guard-chip') || this.spectate || this.targeting || this.coachKey === 'guard' || (this.coachStay && this.coachEl?.isConnected)) return;
    const g = this.guardCandidate();
    if (!g) return;
    const c1 = this.chain, oldWard = g.protectedStructId && c1 ? c1.structs[g.protectedStructId] : null;
    const was = oldWard && !c1!.isDestroyed(oldWard) ? TYPES_BY_ID[oldWard.typeId].type : '';
    const el = h('button', { class: 'btn dc-guard-chip', type: 'button', title: `Your flagship is hit with no guard: ${TYPES_BY_ID[g.typeId].type} guards it (one press)${was ? `; it stops guarding the ${was}` : ''}`, 'aria-label': 'Guard your flagship',
      onclick: () => {
        el.remove();
        const c = this.chain, cand = this.guardCandidate();
        if (!c || !cand || c.isDestroyed(cmd)) return;
        this.select(cand.id);
        const prev = cand.protectedStructId ? c.structs[cand.protectedStructId] : null;
        const from = prev && !c.isDestroyed(prev) ? ` (stops guarding the ${TYPES_BY_ID[prev.typeId].type})` : '';
        this.order({ '@type': '/structs.structs.MsgStructDefenseSet', defenderStructId: cand.id, protectedStructId: cmd.id }, TYPES_BY_ID[cand.typeId].defendChangeCharge, `${TYPES_BY_ID[cand.typeId].type} guards your Command Ship${from}`);
      } }, face('x', 'G'), h('span', { html: icon('shield', 18) }), 'Guard', h('span', { class: 'dc-guard-chip-flag', html: icon('crown', 14) }));
    this.root.appendChild(el);
    this.placeGuardChip();
    setTimeout(() => el.remove(), 6000);
  }
  /** The chip sits above the bar's right end, clear of a callout or the aim pill. */
  private placeGuardChip() {
    const el = this.root.querySelector<HTMLElement>('.dc-guard-chip');
    if (!el) return;
    this.root.classList.toggle('dc-chip-hush', !!this.targeting || (this.coachStay && !!this.coachEl?.isConnected) || this.coachKey === 'guard');
    const bar = this.root.querySelector('.action-bar')?.getBoundingClientRect();
    const root = this.root.getBoundingClientRect();
    if (bar) {
      el.style.right = Math.round(root.right - bar.right + 8) + 'px';
      // Above a callout or the aim pill that sits over the bar, never on them.
      const over = [this.coachEl?.isConnected ? this.coachEl : null, this.root.querySelector<HTMLElement>('.action-bar .targeting-hint')].filter((x): x is HTMLElement => !!x && !!x.offsetWidth).map((x) => x.getBoundingClientRect());
      const right = bar.right - 8, left = right - el.offsetWidth;
      let top = bar.top - el.offsetHeight - 8;
      for (const o of over.sort((p, q) => q.top - p.top)) if (o.left < right && left < o.right && o.top < top + el.offsetHeight && top < o.bottom) top = o.top - el.offsetHeight - 6;
      el.style.top = Math.round(top - root.top) + 'px';
    }
  }

  /** The weapon a press of A (Enter) arms: one that reaches their Command Ship, else the first with anything in reach. */
  private armFirst(s: SimStruct) {
    const c = this.activeChain();
    const ws = this.weaponsReady(s);
    const guards = new Set(this.theirGuards().map((g) => g.id));
    return (guards.size ? ws.find((w) => w.targets.some((t) => guards.has(t.id))) : null)
      || ws.find((w) => w.targets.some((t) => t.typeId === COMMAND_SHIP_ID && !c?.isDestroyed(t))) || ws.find((w) => w.targets.length) || null;
  }
  /** How likely this shot sinks its own shooter (the return fire), sampled and cached per turn. */
  private riskCache = new Map<string, number>();
  private shotRisk(shooterId: string, ws: WeaponSystem, targetId: string) {
    const c = this.chain;
    if (!c) return 1;
    const key = `${shooterId}|${ws}|${targetId}|${c.height}`;
    let r = this.riskCache.get(key);
    if (r == null) {
      const p = predictAttack(c, { '@type': '/structs.structs.MsgStructAttack', operatingStructId: shooterId, targetStructId: [targetId], weaponSystem: ws }, 12);
      r = p.error != null ? 1 : p.attackerDies ?? 1;
      this.riskCache.set(key, r);
    }
    return r;
  }
  /** A shot the game may pick on its own: its shooter lives through the return fire (and, for your own
   * flagship, the worst case can't sink it). */
  private autoSafe(shooter: SimStruct, ws: WeaponSystem, targetId: string) {
    if (shooter.owner === YOU.id && shooter.typeId === COMMAND_SHIP_ID) return this.flagshipSafe(shooter, ws, targetId);
    return this.shotRisk(shooter.id, ws, targetId) < 0.5;
  }
  /** Hand a press over to another fleet ship of yours (never your Command Ship) with a survivable shot at
   * what A aims at; false when none has one. */
  private handOffToGoal(exclude: string) {
    const c = this.chain;
    if (!c) return false;
    const ships = Object.values(c.structs).filter((x) => x.owner === YOU.id && x.id !== exclude && x.typeId !== COMMAND_SHIP_ID && !c.isDestroyed(x))
      .sort((a, b) => AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit) || a.slot - b.slot);
    for (const x of ships) if (this.aimGoalWith(x)) return true;
    return false;
  }
  /** What A aims at first: the red-shield guards of their flagship if any, else their flagship (ids). */
  private aimGoals(): Set<string> {
    const gs = this.theirGuards();
    if (gs.length) return new Set(gs.map((g) => g.id));
    const c = this.activeChain();
    const cs = c && Object.values(c.structs).find((x) => x.owner !== YOU.id && x.typeId === COMMAND_SHIP_ID && !c.isDestroyed(x));
    return new Set(cs ? [cs.id] : []);
  }
  /** Their flagship's guards that block shots at it (the red shields). */
  private theirGuards() {
    const c = this.activeChain();
    const cs = c && Object.values(c.structs).find((x) => x.owner !== YOU.id && x.typeId === COMMAND_SHIP_ID && !c.isDestroyed(x));
    return cs ? this.blockersOf(cs.id) : [];
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
    const guards = new Set(this.theirGuards().map((g) => g.id));
    const want = (t: SimStruct) => (guards.size ? guards.has(t.id) : t.typeId === COMMAND_SHIP_ID && !c.isDestroyed(t));
    const cost = (x: SimStruct) => Math.min(Infinity, ...this.weaponsReady(x).filter((w) => w.targets.some(want)).map((w) => w.cost));
    const reach = ring.filter((x) => cost(x) < Infinity);
    return reach.sort((a, b) => cost(a) - cost(b))[0] || this.bestAttacker();
  }

  /** Arm a ship of yours that reaches this enemy, aimed at it (a touch opens its card). False if none can. */
  private armAt(targetId: string, touch: boolean) {
    const pick = this.shooterFor(targetId);
    if (!pick) return false;
    if (this.selected !== pick.ship.id) this.select(pick.ship.id);
    if (!(this.targeting?.kind === 'attack' && this.targeting.ws === pick.ws)) this.beginAttack(pick.ws);
    if (this.targeting?.kind !== 'attack') return false;
    this.aimId = targetId;
    const u = this.view.units.get(targetId);
    const at = this.view.screenOf(targetId) ?? { ...this.pointerPx };
    if (touch) { this.touchArmed = { target: targetId, ws: pick.ws, from: pick.ship.id, at }; if (u) { if (this.hovered && this.hovered !== targetId) { const h0 = this.view.units.get(this.hovered); if (h0) h0.hover = 0; } this.hovered = targetId; u.hover = 1; this.tipFor(u, at); } }
    else this.refreshDock();
    return true;
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
    // Your Command Ship only when no other ship of yours can reach this one, and only for a shot whose
    // counter-fire can't sink it.
    const fleet = opts.filter((o) => o.ship.typeId !== COMMAND_SHIP_ID);
    opts.splice(0, opts.length, ...(fleet.length ? fleet : opts.filter((o) => this.flagshipSafe(o.ship, o.ws, targetId))));
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
      const el = h('i', { class: 'dc-reach', title: 'Can hit their Command Ship', 'aria-hidden': 'true', html: icon('target', 11) });
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
  /** A first press of a Move that would leave the flagship's guards behind (the second, within 3 s, goes). */
  private driftAsk: { to: Ambit; at: number } | null = null;
  /** A first press of Unguard on a ship guarding your flagship (the second, within 3 s, goes). */
  private unguardAsk: { id: string; at: number } | null = null;
  /** Where your flagship should move to reach something, if anywhere (the Move step and the results' tip
   * both ask here, so they agree): their Command Ship's reach first, then the most ships in reach. A move
   * never goes where more of their guns reach it than where it stands, nor (with 2 hull or less, under
   * fire) anywhere guns reach it at all; a duel with a weaker lone flagship is fine. */
  private moveAdvice(c: Chain, cmd: SimStruct): { to: Ambit | null; here: number } {
    const t = TYPES_BY_ID[cmd.typeId];
    const foes = Object.values(c.structs).filter((x) => x.owner !== YOU.id && !c.isDestroyed(x));
    const hits = (from: Ambit, list: SimStruct[]) => list.filter((f) => (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).some((ws) => hasWeapon(t, ws) && canTargetAmbit(t, ws, from, f.ambit))).length;
    const gunsOn = (a: Ambit) => foes.filter((f) => (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).some((ws) => hasWeapon(TYPES_BY_ID[f.typeId], ws) && canTargetAmbit(TYPES_BY_ID[f.typeId], ws, f.ambit, a)));
    const here = gunsOn(cmd.ambit).length;
    const duel = (a: Ambit) => { const g = gunsOn(a); return g.length > 0 && g.every((f) => f.typeId === COMMAND_SHIP_ID && f.health < cmd.health); };
    const low = cmd.health <= 2;
    const layers = AMBITS.filter((a) => a !== cmd.ambit && (t.possibleAmbit & AMBIT_FLAG[a]) !== 0)
      .map((a) => ({ a, cs: hits(a, foes.filter((f) => f.typeId === COMMAND_SHIP_ID)), n: hits(a, foes), risk: gunsOn(a).length }))
      .filter((x) => x.n > 0 && (x.risk === 0 || duel(x.a) || (!low && (x.risk <= here || (here === 0 && cmd.health > 2 * x.risk)))))
      .sort((x, y) => (low ? x.risk - y.risk : 0) || y.cs - x.cs || x.risk - y.risk || y.n - x.n);
    return { to: layers[0]?.a || null, here };
  }

  /** A layer your flagship could reach their flagship (else anything) from, however many guns reach it there. */
  private riskyLayer(c: Chain, cmd: SimStruct): Ambit | null {
    const t = TYPES_BY_ID[cmd.typeId];
    if (!t.movable) return null;
    const foes = Object.values(c.structs).filter((x) => x.owner !== YOU.id && !c.isDestroyed(x));
    const hits = (from: Ambit, f: SimStruct) => (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).some((ws) => hasWeapon(t, ws) && canTargetAmbit(t, ws, from, f.ambit));
    const layers = AMBITS.filter((a) => a !== cmd.ambit && (t.possibleAmbit & AMBIT_FLAG[a]) !== 0);
    return layers.find((a) => foes.some((f) => f.typeId === COMMAND_SHIP_ID && hits(a, f))) || layers.find((a) => foes.some((f) => hits(a, f))) || null;
  }
  /** The layer the Move step points at (where your flagship would reach something). */
  private stuckLayer: Ambit | null = null;
  /** This fight, the coach told the player to fire with the flagship (the results then don't blame it). */
  private flagshipTold = false;
  /** What the stuck step decided (the "nothing in reach" line says the same). */
  private stuckSay: 'move' | 'guard' | 'hold' = 'hold';
  /** Who of yours can reach something now (the endgame hands over again only when this changes). */
  private endgameKey = '';
  private endgameSel: string | null = null;
  private reachKey() {
    const c = this.chain;
    if (!c) return '';
    // (Keyed by where the flagship stands too, so a move hands over again: stuck, or too hurt to fire.)
    const mine = Object.values(c.structs).filter((x) => x.owner === YOU.id && !c.isDestroyed(x));
    const at = mine.find((x) => x.typeId === COMMAND_SHIP_ID)?.ambit || '';
    const ids = mine.filter((x) => this.weaponsReady(x).some((w) => w.targets.length)).map((x) => x.id).sort().join(',');
    return ids ? ids + '@' + at : '-' + at;
  }
  /** Why the Move step is up: nothing in reach, or the flagship reaches but is too hurt to trade fire. */
  private stuckWhy: 'reach' | 'hurt' = 'reach';
  private stuckFrom: Ambit | null = null;
  /** The Move step's reason is gone: a ship of yours reaches (stuck), or (too hurt) another ship of yours
   * reaches or the flagship has moved. */
  private stuckOver() {
    const c = this.chain;
    if (!c) return true;
    if (this.stuckWhy !== 'hurt') return !this.reachKey().startsWith('-');
    const mine = Object.values(c.structs).filter((x) => x.owner === YOU.id && !c.isDestroyed(x));
    const cmd = mine.find((x) => x.typeId === COMMAND_SHIP_ID);
    return !cmd || cmd.ambit !== this.stuckFrom || mine.some((x) => x.typeId !== COMMAND_SHIP_ID && this.weaponsReady(x).some((w) => w.targets.length));
  }
  /** Your Command Ship's first shot that can't sink it: any weapon (the one A would arm first), their
   * guards, then their Command Ship, then the rest. `only`: that weapon alone. Null when none is safe. */
  private safeFlagshipShot(cmd: SimStruct, only?: WeaponSystem): { ws: WeaponSystem; t: SimStruct } | null {
    const first = this.armFirst(cmd);
    const ready = this.weaponsReady(cmd).filter((w) => w.targets.length && (!only || w.ws === only));
    const guards = new Set(this.theirGuards().map((g) => g.id));
    const rank = (t: SimStruct) => (guards.has(t.id) ? 0 : t.typeId === COMMAND_SHIP_ID ? 1 : 2);
    for (const w of first && ready.some((x) => x.ws === first.ws) ? [first, ...ready.filter((x) => x.ws !== first.ws)] : ready) {
      const t = [...w.targets].sort((p0, p1) => rank(p0) - rank(p1)).find((tg) => this.flagshipSafe(cmd, w.ws, tg.id));
      if (t) return { ws: w.ws, t };
    }
    return null;
  }
  /** Your own flagship armed at a target its shot could now be sunk for: refused (said once), and a safe
   * target ringed instead if there is one. True when refused. */
  private flagshipRefuses(targetId: string) {
    const flag = this.flagshipSelected();
    if (!flag || this.targeting?.kind !== 'attack' || this.flagshipSafe(flag, this.targeting.ws, targetId)) return false;
    audio.play('deny');
    toast('Too hurt to trade fire: that shot could sink it', 'warn', 2000);
    this.clearAim(); this.disarmTouch();
    const a = this.aimStart();
    if (a) this.preAim(a);
    return true;
  }
  /** The selected ship is your own Command Ship (its shots are checked against its own sinking). */
  private flagshipSelected() { const sel = this.selectedStruct(); return sel && sel.owner === YOU.id && sel.typeId === COMMAND_SHIP_ID && !this.chain?.isDestroyed(sel) ? sel : null; }
  /** A shot by your Command Ship that can't sink it: in every sampled exchange the fire it draws back
   * stays under its hull (the worst case, not the average). Cached per turn. */
  private safeCache = new Map<string, boolean>();
  private flagshipSafe(cmd: SimStruct, ws: WeaponSystem, targetId: string) {
    const c = this.chain;
    if (!c) return false;
    const key = `${cmd.id}|${ws}|${targetId}|${c.height}|${cmd.health}`;
    let ok = this.safeCache.get(key);
    if (ok == null) {
      const p = predictAttack(c, { '@type': '/structs.structs.MsgStructAttack', operatingStructId: cmd.id, targetStructId: [targetId], weaponSystem: ws }, 16);
      ok = p.error == null && (p.attackerDies ?? 1) === 0 && (p.counterMax ?? Infinity) < cmd.health;
      this.safeCache.set(key, ok);
    }
    return ok;
  }
  /** "Nothing in reach": the deny sound, and a short line when no tip is saying it already. */
  private nothingInReach() {
    if (this.session?.finished || this.phase !== 'battle') return;
    audio.play('deny');
    if (this.coachEl?.isConnected) return;
    const to = this.stuckLayer ? AMBIT_NAME[this.stuckLayer] : '';
    // (Its flagship reaches, but every shot could sink it: said as such, never "nothing in reach".)
    const lead = this.stuckWhy === 'hurt' ? 'Too hurt to trade fire' : 'Nothing in reach';
    toast(this.stuckSay === 'move' && to ? say({ keys: `${lead} · D, then ${to}`, pad: `${lead} · Y, then ${to}`, touch: `${lead} · move to ${to}` })
      : this.stuckSay === 'guard' ? say({ keys: `${lead} · G guards your flagship`, pad: `${lead} · X guards your flagship`, touch: `${lead} · guard your flagship` })
      : lead, 'warn', 2400);
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
    // A hurt flagship fires only where the worst counter can't sink it.
    const ready = this.weaponsReady(cmd).filter((w) => w.targets.length);
    const safe = this.safeFlagshipShot(cmd);
    const ws = ready.length ? ready[0] : null;
    if (safe) {
      if (this.selected !== cmd.id) this.select(cmd.id);
      this.beginAttack(safe.ws);
      if (this.targeting) this.cycleAimTo(safe.t.id);
      this.flagshipTold = true;
      if (this.oncePerFight('flagship')) this.coach('flagship', 'Flagship', { pad: 'Only your flagship reaches: A fires', keys: 'Only your flagship reaches: Enter fires', touch: 'Only your flagship reaches: tap a target' }, false, true);
      return 'armed';
    }
    // Too hurt to trade fire: guard it, if a ship can.
    if (ws?.targets.length && this.oncePerFight('flagship-guard') && this.guardStep(true, 'guard-hold')) return 'stuck';
    if (TYPES_BY_ID[cmd.typeId].movable) {
      if (this.selected !== cmd.id) this.select(cmd.id);
      const { to, here } = this.moveAdvice(c, cmd);
      // (It reaches, but every shot could sink it: the step says so, and holds until it moves.)
      const hurt = !!ws;
      this.stuckWhy = hurt ? 'hurt' : 'reach';
      this.stuckFrom = cmd.ambit;
      // Under fire with no safer layer: guard the flagship instead, if a ship can.
      if (!to && here > 0 && this.oncePerFight('stuck-guard') && this.guardStep(true, 'guard-hold')) { this.stuckLayer = null; this.stuckSay = 'guard'; return 'stuck'; }
      this.stuckSay = to ? 'move' : 'hold';
      this.stuckLayer = to;
      this.renderActionBar();
      // No layer it can go safely: ahead on hull, a standoff goes to you (hold); else the risky way to finish it.
      if (!to && this.oncePerFight(`hold:${cmd.ambit}`)) {
        const hl = this.session?.hullNow();
        const ahead = !!hl && (hl.you > hl.cpu + 1e-9 || (Math.abs(hl.you - hl.cpu) <= 1e-9 && hl.fleetYou > hl.fleetCpu + 1e-9));
        // (Hold only out of their guns: none reach its layer and no order of theirs is aimed at your ships.)
        const mineIds = new Set(Object.values(c.structs).filter((x) => x.owner === YOU.id).map((x) => x.id));
        const aimed = c.mempool.some((tx) => tx.signer !== YOU.id && Array.isArray((tx.msg as unknown as { targetStructId?: string[] }).targetStructId) && (tx.msg as unknown as { targetStructId: string[] }).targetStructId.some((id) => mineIds.has(id)));
        const risky = this.riskyLayer(c, cmd);
        if (ahead && here === 0 && !aimed) this.coach('stuck', 'Hold', 'Ahead on hull: hold, the standoff goes to you', false, true);
        else if (risky) { const R = AMBIT_NAME[risky]; this.coach('stuck', 'Move', { pad: `Y: move to ${R} to finish it (risky)`, keys: `D: move to ${R} to finish it (risky)`, touch: `Move to ${R} to finish it (risky)` }, false, true); }
        else if (here > 0 || aimed) this.coach('stuck', 'Under fire', { pad: 'Guard your flagship: X', keys: 'Guard your flagship: G', touch: 'Guard your flagship' }, false, true);
      }
      if (to && this.oncePerFight(`stuck:${cmd.ambit}:${to}`)) {
        const where = AMBIT_NAME[to];
        this.coach('stuck', 'Move', hurt ? { pad: `Too hurt to trade fire: Y, then ${where}`, keys: `Too hurt to trade fire: D, then ${where}`, touch: `Too hurt to trade fire: move to ${where}` }
          : { pad: `Nothing in reach: Y, then to ${where}`, keys: `Nothing in reach: D, then to ${where}`, touch: `Nothing in reach: move your flagship to ${where}` }, false, true);
      }
      // A pad or keys: the cursor waits on that layer's button (A moves).
      // (Only when nothing else has the cursor: never from Retreat, the top bar or a chat field.)
      const free = () => { const f = document.activeElement; return !f || f === document.body || f === this.engine.canvas; };
      if (to && inputMode() !== 'touch' && free()) requestAnimationFrame(() => { if (free()) this.root.querySelector<HTMLElement>(`.action-bar .drift .btn.mini.ambit-${to}:not(:disabled)`)?.focus({ focusVisible: true } as FocusOptions); });
      return 'stuck';
    }
    return null;
  }

  private guardEls = new Map<string, HTMLElement>();
  private paintGuardMarks() {
    const c = this.chain;
    // Every enemy ship that guards another (alive, its ward alive) wears a mark in its tag all fight: a red
    // shield when it blocks (it guards from its ward's own layer), an orange ↻ when it can only fire back.
    const want = new Map<string, string>();
    if (c && this.phase === 'battle') for (const x of Object.values(c.structs)) {
      if (x.owner === YOU.id || c.isDestroyed(x) || !x.protectedStructId) continue;
      const ward = c.structs[x.protectedStructId];
      if (!ward || c.isDestroyed(ward)) continue;
      want.set(x.id, `${ward.id}|${this.blocks(x, ward) ? 'block' : 'back'}`);
    }
    for (const [g, el] of this.guardEls) if (want.get(g) !== el.dataset.k || !el.isConnected) { el.remove(); this.guardEls.delete(g); }
    for (const [g, k] of want) {
      if (this.guardEls.has(g)) continue;
      const tag = this.view.units.get(g)?.tag;
      if (!tag) continue;
      const ward = c!.structs[k.split('|')[0]];
      const block = k.endsWith('|block');
      const whom = ward?.typeId === COMMAND_SHIP_ID ? 'their Command Ship' : `their ${TYPES_BY_ID[ward.typeId].type}`;
      const el = h('i', { class: 'dc-guard-mark' + (block ? '' : ' back'), 'data-k': k, 'aria-hidden': 'true', html: icon(block ? 'shield' : 'replay', 10),
        title: block ? `Guards ${whom}: it blocks your shots at it. Sink it first.` : `Guards ${whom} from another layer: it fires back at you, but can't block.` });
      tag.insertBefore(el, tag.firstChild);
      this.guardEls.set(g, el);
    }
  }
  /** This guard blocks shots at its ward: online, able to guard, beside it and in its own layer (chain.ts). */
  private blocks(d: SimStruct, ward: SimStruct) {
    const c = this.activeChain();
    return !!c && !c.isDestroyed(d) && c.isOnline(d) && c.canDefend(d) && d.id !== ward.id && c.isProtecting(d, ward) && d.ambit === ward.ambit;
  }
  /** The guards that block shots at one ship (not the ones that only fire back from another layer). */
  private blockersOf(id: string) {
    const c = this.activeChain();
    const t = c?.structs[id];
    return c && t ? c.defendersOf(id).map((g) => c.structs[g]).filter((x) => x && this.blocks(x, t)) : [];
  }
  /** Every shot the armed weapon fires at this ship would be blocked by a guard. */
  private fullyBlocked(id: string) {
    const p = this.targeting?.kind === 'attack' ? this.forecast(id) : null;
    return !!p && (p.blocked ?? 0) >= 0.99 && this.blockersOf(id).length > 0;
  }
  /** Every shot at this ship would be blocked: fire at one of its guards instead (said in a toast). */
  private fireAtGuard(id: string, touch: boolean) {
    this.aimAtGuard(id, touch);
    const g = this.aimId && this.aimId !== id ? this.aimId : null;
    if (!g || this.targeting?.kind !== 'attack') return;
    const ws = this.targeting.ws;
    this.disarmTouch();
    toast('Guarded: the shot goes at its guard', 'warn', 1800);
    this.attack(ws, g);
  }
  /** Aim at a guard of this ship instead (with this weapon if it reaches one, else the ship that can). */
  private aimAtGuard(id: string, touch: boolean) {
    const gs = this.blockersOf(id);
    const valid = this.validTargets();
    // (Your own flagship armed: only a guard its shot can't be sunk for; else another ship takes it.)
    const flag = this.targeting?.kind === 'attack' ? this.flagshipSelected() : null;
    const tws = this.targeting?.kind === 'attack' ? this.targeting.ws : null;
    let g = gs.find((x) => valid.has(x.id) && !(flag && tws && !this.flagshipSafe(flag, tws, x.id)));
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
    if (!cmd) return null;
    // A free ship in its layer first; else one there that guards some other ship (it can be re-tasked).
    const there = Object.values(c.structs).filter((x) => x.owner === YOU.id && x.id !== cmd.id && !c.isDestroyed(x) && c.isOnline(x) && x.ambit === cmd.ambit && TYPES_BY_ID[x.typeId].canDefend && x.protectedStructId !== cmd.id);
    return there.find((x) => !x.protectedStructId) || there[0] || null;
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
    // A guard for your flagship landed: the Guard step is done (it was only queued until now).
    { const fl = Object.values(chain.structs).find((x) => x.owner === YOU.id && x.typeId === COMMAND_SHIP_ID);
      if (fl && b.txs.some((tx) => tx.ok && tx.signer === YOU.id && String(tx.type).endsWith('DefenseSet') && (tx.msg as unknown as { protectedStructId?: string }).protectedStructId === fl.id)) this.coachDone('guard'); }
    // Your flagship: a guard blocking for it now; enemy shots that landed on it (not blocked, not evaded).
    { const mine = Object.values(chain.structs).find((x) => x.owner === YOU.id && x.typeId === COMMAND_SHIP_ID);
      const blockers = mine && !chain.isDestroyed(mine) ? this.blockersOf(mine.id) : [];
      for (const g of blockers) this.cmdGuardIds.add(g.id);
      // Its last guard was just sunk (not unguarded, not left behind by a drift: your own moves never alarm),
      // and the fight is still on (their flagship stands): say so, flash Guard, and offer the Guard step once more.
      const theirsUp = Object.values(chain.structs).some((x) => x.owner === CPU.id && x.typeId === COMMAND_SHIP_ID && !chain.isDestroyed(x));
      const sunk = [...this.cmdBlockersWas].some((id) => chain.structs[id] && chain.isDestroyed(chain.structs[id]));
      const live = mine && !chain.isDestroyed(mine) && theirsUp && !this.spectate && !this.session?.finished;
      const choosing = !!document.activeElement?.closest('.action-bar, .slot-editor, .modal-back');
      const free = !this.targeting && !choosing && !this.held && !this.session?.pending && !(this.coachStay && this.coachEl?.isConnected);
      if (mine && !chain.isDestroyed(mine)) this.cmdGuardMax = Math.max(this.cmdGuardMax, blockers.length);
      if (mine && !chain.isDestroyed(mine) && (blockers.length || this.guardCandidate())) this.cmdGuardPossible = true;
      { const tc = Object.values(chain.structs).find((x) => x.owner === CPU.id && x.typeId === COMMAND_SHIP_ID && !chain.isDestroyed(x)); if (tc) this.theirGuardMax = Math.max(this.theirGuardMax, this.blockersOf(tc.id).length); }
      // Guards that left its side this turn: sunk, or left behind (a drift, an Unguard, a re-task).
      if (mine && !chain.isDestroyed(mine)) for (const id of this.cmdBlockersWas) if (!blockers.some((g) => g.id === id)) { const g = chain.structs[id]; if (g && chain.isDestroyed(g)) this.cmdGuardsSunk++; else this.cmdGuardsLeft++; }
      else if (mine) for (const id of this.cmdBlockersWas) { const g = chain.structs[id]; if (g && chain.isDestroyed(g)) this.cmdGuardsSunk++; }
      if (!live) document.querySelectorAll('.dc-guard-chip').forEach((n) => n.remove());
      // The Guard step's ship sank: the step goes quietly, and another is offered when free.
      if (this.coachKey === 'guard') { const g0 = this.selectedStruct(); if (g0 && chain.isDestroyed(g0)) { this.clearCoach(); this.guardOfferDue = true; } }
      // A re-guard owed (skipped while the player aimed or picked): now, if they are free and it is still short.
      if (this.guardOfferDue && live && free && !this.coachEl?.isConnected && blockers.length < this.guardGoal) { this.guardOfferDue = false; this.guardStep(true, false); }
      else if (this.guardOfferDue && blockers.length >= this.guardGoal) this.guardOfferDue = false;
      // The hunting rungs' opening Guard step, on the first free turn.
      if (this.guardStartDue && live && free && !this.coachEl?.isConnected) {
        this.guardStartDue = false;
        if (blockers.length < this.guardGoal && this.oncePerFight('guard-start')) this.guardStep(true, 'guard-hold');
      }
      // A guard of it was sunk: say so when none is left (never for your own Unguard or drift), and offer the
      // Guard step again whenever the count drops, each time.
      if (live && sunk && blockers.length < this.cmdBlockersWas.size) {
        if (!blockers.length) { toast(say({ pad: '⚠ Your flagship lost its guard · X', keys: '⚠ Your flagship lost its guard · G', touch: '⚠ Your flagship lost its guard' }), 'enemy', 2600); this.guardFlashUntil = performance.now() + 2600; }
        // (It holds the clock at most once a fight; after that it waits beside the fight. Mid-aim or mid-pick,
        // it is offered once the player is free.)
        if (free) this.guardStep(true, 'guard-hold'); else this.guardOfferDue = true;
      }
      // The hunting rungs want two: once the first is set, the second is asked for.
      // (Mid-aim or with an order waiting, it is owed and offered on the first free turn.)
      else if (live && this.guardGoal > 1 && blockers.length > 0 && blockers.length < this.guardGoal && this.cmdBlockersWas.size < blockers.length) {
        if (!free) this.guardOfferDue = true;
        else if (this.oncePerFight('guard-2')) this.guardStep(true, 'guard-hold');
      }
      // (The one-press chip: below, after the Guard step has had its say this turn.)
      this.chipDue = !!live && !blockers.length && this.cmdHp != null && mine!.health < this.cmdHp;
      if (blockers.length) this.root.querySelector('.dc-guard-chip')?.remove();
      if (mine && !chain.isDestroyed(mine)) this.cmdGuardAtEnd = blockers.length;
      this.cmdBlockersWas = new Set(blockers.map((g) => g.id));
      if (mine) for (const tx of b.txs) {
        if (!tx.ok) continue;
        for (const e of tx.events) if (e.category === 'struct_attack') for (const r of e.detail?.eventAttackShotDetail || []) {
          // Their shots that hit it.
          if (tx.signer === CPU.id && r.targetStructId === mine.id && !r.evaded && !r.blocked && Number(r.damage || 0) > 0) { this.cmdHits++; this.cmdHitDmg += Number(r.damage || 0); }
          // Fire drawn by its own shots: the target's return fire and its guards' counters.
          if (tx.signer === YOU.id && String((tx.msg as unknown as { operatingStructId?: string }).operatingStructId) === mine.id) {
            this.cmdCounterDmg += Number(r.targetCounteredDamage || 0);
            for (const x of r.eventAttackDefenderCounterDetail || []) this.cmdCounterDmg += Number(x.counterDamage || 0);
          }
        }
      } }
    if (mineHit && !this.shotLanded) { this.shotLanded = true; this.chargeAt = performance.now(); }
    // The Move hint lets go once anything of yours reaches again (the move landed, or their ship came close).
    if (this.stuckLayer && this.stuckOver()) {
      this.stuckLayer = null;
      if (this.coachKey === 'stuck') this.clearCoach();
      const f = document.activeElement as HTMLElement | null;
      if (f?.closest?.('.dc-go-layer')) f.blur();
      this.renderActionBar();
    }
    // An armed weapon with nothing left in reach (its targets sank or went out of reach) lets go.
    if (this.targeting?.kind === 'attack' && !this.spectate) {
      const armed = this.selectedStruct();
      const ws = this.targeting.ws;
      if (!armed || chain.isDestroyed(armed) || !this.weaponsReady(armed).some((w) => w.ws === ws && w.targets.length)) { this.targeting = null; this.clearAim(); this.disarmTouch(); this.refreshSelectionVisuals(); }
      // (Its ringed target sank or left reach: the ring and its card let go; the next press rings anew.)
      else {
        const valid = this.validTargets(), flag = this.flagshipSelected();
        const gone = (id: string) => !valid.has(id) || (!!flag && !this.flagshipSafe(flag, ws, id));
        if (this.aimId && gone(this.aimId)) { this.clearAim(); this.refreshDock(); }
        if (this.touchArmed && gone(this.touchArmed.target)) this.disarmTouch();
      }
    }
    // The fight would lock (only your Command Ship can shoot, or nothing can): it says so and hands over.
    // (The Move step's own pre-focused layer button is not a choice in progress.)
    const busy = document.activeElement?.closest('.action-bar, .slot-editor, .modal-back') && !document.activeElement?.closest('.dc-go-layer');
    if (!this.spectate && !this.targeting && !this.held && !this.session?.pending && !busy) {
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
    const guardUp = this.coachKey === 'guard' && !!this.coachEl?.isConnected;
    if (mineHit && !this.spectate && !this.targeting && !this.held && !this.session?.pending && !choosing && !guardUp) {
      const shooter = b.txs.find((tx) => tx.ok && tx.signer === YOU.id && String(tx.type).endsWith('MsgStructAttack'));
      const fromId = shooter ? String((shooter.msg as unknown as Record<string, unknown>).operatingStructId ?? '') : '';
      const from = (fromId && chain.structs[fromId]) || this.selectedStruct();
      if (from && from.owner === YOU.id && from.id === this.selected) {
        const n = this.nextShooter(from);
        // It comes armed at what A aims at (a red-shield guard, else their flagship: one press fires), unless
        // your flagship is being hit unguarded (the Guard chip's turn) or a step is waiting or due.
        // (Nor while the first fight's Guard lesson is still to come: it needs nothing armed.)
        const fl = Object.values(chain.structs).find((x) => x.owner === YOU.id && x.typeId === COMMAND_SHIP_ID && !chain.isDestroyed(x));
        const lessonDue = !this.coachSeen('guard') && !!fl && this.blockersOf(fl.id).length < this.guardGoal && !!this.guardCandidate();
        // (Nor on the turn the Drift tip is due: it shows first, uncovered.)
        const driftDue = !this.coachSeen('drift') && (this.coachSeen('guard') || !this.guardCandidate());
        const calm = !this.chipDue && !this.guardOfferDue && !lessonDue && !driftDue && !(this.coachStay && this.coachEl?.isConnected);
        if (n && !(calm && n.typeId !== COMMAND_SHIP_ID && this.aimGoalWith(n)) && n.id !== this.selected) this.select(n.id);
      }
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
    // Hit with no guard at all: the one-press chip, after every Guard step has had its say this turn
    // (never alongside one).
    if (this.chipDue && this.coachKey !== 'guard') { const fl = Object.values(chain.structs).find((x) => x.owner === YOU.id && x.typeId === COMMAND_SHIP_ID && !chain.isDestroyed(x)); if (fl) this.guardChip(fl); }
    this.chipDue = false;
    // Once guarding is taught (or can't be: no free ship in the flagship's layer) and no other tip is up:
    // the flagship can change battleground.
    if (!this.spectate && mineHit && (this.coachSeen('guard') || !this.guardCandidate()) && !this.coachEl?.isConnected && !document.querySelector('.tooltip.on')) {
      this.coach('drift', 'Drift', { pad: 'Y moves your Command Ship', keys: 'D moves your Command Ship', touch: 'Tap your flagship, then Move' });
    }
    for (const tx of b.txs) {
      // (A guard order whose ship sank in the same turn fails quietly: the Guard step offers another.)
      if (!tx.ok && tx.signer === YOU.id && !this.spectate && String(tx.type).endsWith('DefenseSet') && /destroyed/.test(tx.error || '')) { this.guardOfferDue = true; this.logTx(b.height, tx); continue; }
      if (!tx.ok && tx.signer === YOU.id && !this.spectate && /destroyed|not found/.test(tx.error || '')) { this.logTx(b.height, tx); continue; }
      if (!tx.ok && tx.signer === YOU.id && !this.spectate) {
        toast((window.innerWidth <= 760 || window.innerHeight <= 560 ? '✕ ' : 'Order failed: ') + humanError(tx.error || ''), 'enemy', 4200);
        audio.play('deny');
      }
      this.logTx(b.height, tx);
    }
    // A held order whose ship or target sank, or whose target went out of reach, while it waited: withdrawn.
    if (this.held && this.session) {
      const why = this.orderStale(this.held.msg);
      if (why) {
        const short = why === 'ship gone' ? 'Ship gone' : why === 'target gone' ? 'Target gone' : why === 'too hurt' ? 'Too hurt' : 'Out of reach';
        this.orderCall(this.held.msg, '✕', `${this.held.label} withdrawn · ${why}`, 0, short, '');
        if (![...document.querySelectorAll('.toast')].some((n) => n.textContent === `✕ ${short}`)) toast(`✕ ${short}`, 'warn', 1800);
        audio.play('deny'); this.held = null;
      }
    }
    // Release a held order once the battery covers it (the client's charge gating).
    if (this.held && this.session && !this.session.pending && this.session.chargeAtNext() >= this.held.cost) {
      this.session.submit(this.held.msg);
      this.pendingLabel = this.held.label;
      this.held = null;
    }
    this.predictCache.clear();
    this.safeCache.clear();
    this.riskCache.clear();
    this.countReach();
    this.hideCheck(b.height);
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
      g.ms = (g.ms || 0) + (session?.elapsedMs || 0);
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
    const c = this.chain!;
    const actor = c.structs[String(m.operatingStructId || m.structId || m.defenderStructId || '')];
    // (A ship (or its target) gone already: quietly back to a ship that can act, never an "order failed".)
    const tgt = Array.isArray(m.targetStructId) ? c.structs[String(m.targetStructId[0])] : m.protectedStructId ? c.structs[String(m.protectedStructId)] : undefined;
    if ((actor && c.isDestroyed(actor)) || (tgt && c.isDestroyed(tgt))) { this.targeting = null; this.clearAim(); if (actor && c.isDestroyed(actor)) this.selectBest(); else this.renderActionBar(); audio.play('deny'); return; }
    this.targeting = null;
    const type = String(m['@type']);
    // Firing finishes step 2, and step 3 follows (any other order leaves the steps where they are).
    const firing = type.endsWith('MsgStructAttack');
    if (firing) { this.coachDone('aim'); this.coachDone('flagship'); }
    // (The Guard step is done when the guard lands, not when it is queued: onBlock.)
    if (type.endsWith('MsgStructMove')) this.coachDone('stuck');
    // A guard for your flagship already queued is never replaced: this order waits until it lands.
    const pend = this.session.pending;
    const myCmd = Object.values(c.structs).find((x) => x.owner === YOU.id && x.typeId === COMMAND_SHIP_ID);
    const pendGuard = !!pend && String(pend.msg['@type']).endsWith('MsgStructDefenseSet') && (pend.msg as unknown as { protectedStructId?: string }).protectedStructId === myCmd?.id;
    if (pendGuard && !type.endsWith('MsgStructDefenseSet')) {
      this.held = { msg, cost, label };
      this.orderCall(msg, '⏳', `Guard lands first · then ${label}`, cost, 'Guard first');
      audio.play('select');
      this.refreshSelectionVisuals();
      this.renderActionBar();
      return;
    }
    const charge = this.session.chargeAtNext();
    // (A held order replaced by a different one is said too.)
    const heldWas = this.held && JSON.stringify(this.held.msg) !== JSON.stringify(msg) ? this.held.label : '';
    if (charge >= cost) {
      const was = pend ? this.pendingLabel : heldWas;
      // (The same order pressed again stands as it was: not a replacement.)
      const same = !!pend && JSON.stringify(pend.msg) === JSON.stringify(msg);
      const r = this.session.submit(msg);
      this.pendingLabel = label;
      this.held = null;
      // A replaced order is said, never silent.
      if ((r.replaced || heldWas) && was && !same) toast(`↺ ${label} · instead of ${was}`, 'warn', 2400);
      // The turn card already says ✓ Sent; this is just the call.
      else if (!this.coachEl?.isConnected) this.orderCall(msg, r.replaced && !same ? '↺' : '✓', label);
    } else {
      if (pend) { toast(`✕ ${this.pendingLabel || 'Queued order'} withdrawn · ⏳ ${label}`, 'warn', 2400); this.session.cancelPending(); }
      else if (heldWas) toast(`↺ ${label} · instead of ${heldWas}`, 'warn', 2400);
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

  /** Select your own Command Ship (its card in the HUD was pressed): its Move shows on the bar. */
  private pickFlagship() {
    const c = this.chain;
    if (!c || this.phase !== 'battle' || this.spectate || this.session?.finished) return;
    const cmd = Object.values(c.structs).find((x) => x.owner === YOU.id && x.typeId === COMMAND_SHIP_ID && !c.isDestroyed(x));
    if (!cmd) return;
    // Picking who to guard: your flagship is the pick (as a tap on it would be).
    if (this.targeting?.kind === 'guard') {
      const g = this.selectedStruct();
      if (g && g.owner === YOU.id && g.id !== cmd.id && !c.isDestroyed(g)) this.order({ '@type': '/structs.structs.MsgStructDefenseSet', defenderStructId: g.id, protectedStructId: cmd.id }, TYPES_BY_ID[g.typeId].defendChangeCharge, `${TYPES_BY_ID[g.typeId].type} guards your Command Ship`);
      else audio.play('deny');
      return;
    }
    // A shot armed: the Drift step's tap (it points here) lets go of the shot and takes the flagship;
    // otherwise the shot stays armed, and the tap says so.
    if (this.targeting?.kind === 'attack') {
      if (!(this.coachKey === 'drift' && this.coachEl?.isConnected)) { audio.play('deny'); toast('Aiming: fire, or cancel first', 'warn', 1400); return; }
      this.targeting = null; this.clearAim(); this.disarmTouch();
    }
    audio.play('select');
    this.disarmTouch();
    this.select(cmd.id);
    this.playerPick = cmd.id;
  }
  /** The ship the player picked themselves (a click on it, Tab or L/R): A (Enter) fires with it. */
  private playerPick: string | null = null;
  private select(id: string | null) {
    this.playerPick = null;
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
      // Your card is a way to your flagship: a click or tap selects it, and the bar shows its Move.
      // (A button to a touch screen's title bubbles too: a tap on it is its own, never a bubble over Pause.)
      if (side === 'player' && !this.spectate) { card.classList.add('dc-pick-cmd'); card.setAttribute('role', 'button'); card.title = 'Your fleet: click or tap to select your Command Ship (then Move)'; card.addEventListener('click', () => this.pickFlagship()); }
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
    // Overtime: who is ahead on hull, under the countdown (flagship, then fleet; yours over theirs).
    const otBar = (cls: string, ico: string, title: string) => h('div', { class: 'dc-ot-row ' + cls, title }, h('span', { class: 'dc-ot-ico', html: icon(ico, 16) }),
      h('span', { class: 'dc-ot-bars' }, h('i', { class: 'you' }), h('i', { class: 'cpu' })));
    const otMeter = h('div', { class: 'dc-ot-meter' }, h('b', { class: 'dc-ot-tag' }, 'Standoff'), otBar('cmd', 'crown', 'Command Ship hull kept: yours (top) and theirs'), otBar('fleet', 'ship', 'Fleet hull kept: yours (top) and theirs (decides when the flagships are even)'),
      h('b', { class: 'dc-ot-word' }, 'EVEN'));
    const center = h('div', { class: 'block-card panel', title: 'Turn: one block of the chain' },
      h('div', { class: 'spread' }, h('span', { class: 't-label c-hint' }, h('span', { class: 's-only' }, 'Turn'), h('span', { class: 'x-only' }, 'Block')), h('span', { class: 't-label c-hint' }, nextIn)),
      blockNum, blockBar, otMeter, h('div', { class: 'row', style: 'justify-content:center; gap:6px' }, order, cancel),
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
    this.els.otMeter = otMeter;
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
    // Overtime: the turn card counts down the seconds to the decision on hull, in red.
    const otLeft = s.overtimeLeft();
    // A standoff closing in (nobody hurt for a while, or flagships only dancing): the same countdown and
    // meter, said STANDOFF (never in Auto, and gone as soon as someone is hurt).
    const so = otLeft == null && !this.spectate && this.phase === 'battle' && !s.finished ? s.standoffLeft() : null;
    const card = this.els.blockNum.closest('.block-card') as HTMLElement | null;
    if (otLeft != null || so) {
      const secs = otLeft != null ? Math.max(0, Math.ceil((otLeft * s.blockMs - s.blockClock) / 1000))
        : so!.kind === 'quiet' ? Math.max(0, Math.ceil((so!.left * s.blockMs - s.blockClock) / 1000)) : so!.left;
      const moves = !!so && so.kind === 'moves';
      this.els.blockNum.textContent = String(secs);
      this.els.blockNum.dataset.unit = moves ? (secs === 1 ? ' move' : ' moves') : 's';
      if (card) card.classList.toggle('dc-so', !!so);
      // The meter: each side's share of the hull it began with (repainted once a turn).
      const m = this.els.otMeter;
      const mk = `${c.height}|${so ? so.kind : 'ot'}`;
      if (m && m.dataset.h !== mk) {
        m.dataset.h = mk;
        const hl = s.hullNow(), pc = (v: number) => Math.round(v * 100) + '%';
        const even = Math.abs(hl.you - hl.cpu) < 1e-9;
        const set = (row: string, you: number, cpu: number, live: boolean) => {
          const r = m.querySelector<HTMLElement>('.dc-ot-row.' + row);
          if (!r) return;
          (r.querySelector('i.you') as HTMLElement).style.width = pc(you);
          (r.querySelector('i.cpu') as HTMLElement).style.width = pc(cpu);
          r.classList.toggle('live', live);
          r.classList.toggle('ahead', you > cpu + 1e-9);
          r.classList.toggle('behind', cpu > you + 1e-9);
        };
        set('cmd', hl.you, hl.cpu, !even);
        set('fleet', hl.fleetYou, hl.fleetCpu, even);
        // The word: the row that decides, ahead, behind or even.
        const [a0, b0] = even ? [hl.fleetYou, hl.fleetCpu] : [hl.you, hl.cpu];
        const lead = a0 > b0 + 1e-9 ? 'ahead' : b0 > a0 + 1e-9 ? 'behind' : 'even';
        const word = m.querySelector<HTMLElement>('.dc-ot-word');
        if (word) { word.textContent = lead.toUpperCase(); word.className = 'dc-ot-word ' + lead; }
        this.otBehind = lead === 'behind';
        this.otBehindRow = even ? 'fleet' : 'cmd';
        const when = so ? (so.kind === 'quiet' ? `Standoff: nobody hurt for a while. In ${secs} s with no damage` : `Standoff: the flagships keep moving with no hits. After ${secs} more moves`) : `Overtime: in ${secs} s`;
        if (card) card.title = `${when} the side with more hull left wins. Flagships: yours ${pc(hl.you)}, theirs ${pc(hl.cpu)}${even ? `; even, so the fleets decide: yours ${pc(hl.fleetYou)}, theirs ${pc(hl.fleetCpu)}` : ''}.`;
      }
      if (card) card.classList.add('dc-ot');
      // Behind near the end (about 20 s, or 2 moves): once a fight each, what turns it around.
      const near = moves ? secs <= 2 : secs > 0 && secs <= 20;
      if (this.otBehind && near && !(so ? this.soNudged : this.otNudged) && !this.paused && !this.spectate && !s.finished && card) {
        if (so) this.soNudged = true; else this.otNudged = true;
        this.hudNudge(null, this.otBehindRow === 'cmd' ? 'Behind: hit their Command Ship' : 'Behind: sink a ship');
      }
    } else {
      // (A standoff that someone broke: the card is the turn card again.)
      if (card && card.classList.contains('dc-so')) { card.classList.remove('dc-ot', 'dc-so'); card.title = 'Turn: one block of the chain'; }
      this.els.blockNum.textContent = document.body.classList.contains('expert') ? c.height.toLocaleString('en-US') : String(c.height - s.startHeight);
    }
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
        : h('div', { class: 'action-bar panel empty', title: inputMode() === 'pad' ? 'Press A to pick a ship' : 'Select one of your ships (Tab or Enter) to give an order' }, h('span', { class: 'c-player', html: icon('ship', 22) }), inputMode() === 'pad' ? face('a', null) : h('kbd', null, 'Tab')));
      this.pulseCoachTarget();
      return;
    }
    const t = TYPES_BY_ID[s.typeId];
    const mine = s.owner === YOU.id;
    const side = mine ? 'player' : 'enemy';
    const dead = c.isDestroyed(s);
    const ward = s.protectedStructId ? c.structs[s.protectedStructId] : undefined;
    const img = h('img', { alt: t.type });
    void structPortrait(t.id, s.health < t.maxHealth ? 'dmg' : 'base', side).then((u) => { img.src = u; });
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
      // The weapon A (or 1) arms comes first: the one that reaches a red-shield guard of their flagship,
      // else their flagship (your own flagship's: its safe shot); it wears the 1/A badge on every input,
      // and a red-shield pip marks each weapon that reaches a guard.
      const order = this.weaponOrder(s);
      const gset = new Set(this.theirGuards().map((g) => g.id));
      const flashing = this.weaponFlash && performance.now() < this.weaponFlash.until ? this.weaponFlash.ws : null;
      // (Your own flagship with no shot that can't sink it: no weapon wears the badge.)
      const badged = !(s.owner === YOU.id && s.typeId === COMMAND_SHIP_ID && !this.safeFlagshipShot(s));
      this.weaponsReady(s).forEach((w) => {
        const rank = order.indexOf(w.ws);
        const pip = gset.size && w.targets.some((x) => gset.has(x.id)) ? h('span', { class: 'a-pip', title: 'Reaches a red-shield guard: hit it first', html: icon('shield', 11) })
          : w.targets.some((x) => x.typeId === COMMAND_SHIP_ID && x.owner !== YOU.id) ? h('span', { class: 'a-pip cmd', title: 'Reaches their Command Ship: sink it to win', html: icon('crown', 11) }) : null;
        const label = weaponLabel(t, w.ws);
        const ctl = controlName(weaponField(t, w.ws, 'Control'));
        const shots = weaponField(t, w.ws, 'Shots') || 1;
        const dmg = weaponField(t, w.ws, 'Damage') || 0;
        const disabled = !w.targets.length;
        const active = this.targeting?.kind === 'attack' && this.targeting.ws === w.ws;
        actions.push(h('button', {
          class: 'btn action weapon' + (active ? ' active' : '') + (charge < w.cost ? ' short' : '') + (flashing === w.ws ? ' dc-switch' : '') + (rank === 0 && badged ? ' a-first' : ''), disabled,
          title: disabled ? 'No enemy in reach' : `${label} (${rank + 1}): ${ctl} · reaches ${reachLabel(t, w.ws)} · ${shots > 1 ? shots + '×' : ''}${dmg} damage · needs ${w.cost} charge (firing empties it)`,
          'aria-label': `${label}: ${shots > 1 ? shots + ' shots of ' : ''}${dmg} damage, needs ${w.cost} charge`,
          onclick: () => this.weaponPress(w.ws),
        // Every verb is its icon over one word (MISSILE, GUARD, MOVE), then its numbers: damage and ⚡.
        }, h('span', { class: 'a-top' }, inputMode() === 'pad' ? (rank === 0 && badged ? face('a', null) : null) : rank ? (inputMode() === 'keys' ? h('kbd', { 'aria-hidden': 'true' }, '2') : null) : badged ? face('a', '1') : null, h('span', { class: 'a-ico', html: icon('missile', 22) }), pip),
          // (Armed, it reads Fire: pressed again it fires at the ringed target.)
          h('span', { class: 'a-name' }, active ? 'Fire' : weaponWord(label)),
          h('span', { class: 'a-nums' }, h('span', { class: 'a-dmg' }, h('span', { html: icon('boom', 14) }), `${shots > 1 ? shots + '×' : ''}${dmg}`), h('span', { class: 'a-cost', title: 'Needs this much charge' }, `${w.cost}⚡`))));
      });
      if (t.canDefend) {
        const cost = t.defendChangeCharge;
        actions.push(h('button', { class: 'btn action secondary guard-btn' + (this.targeting?.kind === 'guard' ? ' active' : '') + (performance.now() < this.guardFlashUntil ? ' dc-flash' : ''), title: `Guard (G): block shots aimed at a friend, and fire back · needs ${cost} charge`, 'aria-label': `Guard a friend, needs ${cost} charge`, onclick: () => this.startGuardPick() },
          h('span', { class: 'a-top' }, face('x', 'G'), h('span', { class: 'a-ico', html: icon('shield', 22) })), h('span', { class: 'a-name' }, 'Guard'), h('span', { class: 'a-nums' }, h('span', { class: 'a-cost' }, `${cost}⚡`))));
        if (s.protectedStructId) {
          // Unguarding your Command Ship leaves it open: the first press asks, the second (within 3 s) goes.
          const flag = !!ward && ward.typeId === COMMAND_SHIP_ID && ward.owner === YOU.id && !c.isDestroyed(ward);
          const asking = flag && this.unguardAsk?.id === s.id && performance.now() - this.unguardAsk.at < 3000;
          actions.push(h('button', { class: 'btn action ghost stand-down' + (asking ? ' asking' : ''), title: `Unguard: stop guarding${ward && !c.isDestroyed(ward) ? ' the ' + TYPES_BY_ID[ward.typeId].type : ''}${flag ? ' (it leaves your flagship open)' : ''} · needs ${cost} charge`, 'aria-label': `Unguard${flag ? ' your flagship' : ''}, needs ${cost} charge`,
            onclick: () => {
              if (flag && !(this.unguardAsk?.id === s.id && performance.now() - this.unguardAsk.at < 3000)) {
                const ask = this.unguardAsk = { id: s.id, at: performance.now() };
                setTimeout(() => { if (this.unguardAsk === ask) { this.unguardAsk = null; if (this.phase === 'battle') this.renderActionBar(); } }, 3050);
                audio.play('deny');
                toast(say({ pad: '⚠ Unguards your flagship: press again', keys: '⚠ Unguards your flagship: press again', touch: '⚠ Unguards your flagship: tap again' }), 'warn', 2600);
                this.renderActionBar();
                return;
              }
              this.unguardAsk = null;
              this.order({ '@type': '/structs.structs.MsgStructDefenseClear', defenderStructId: s.id }, cost, `${t.type} stops guarding`);
            } },
            h('span', { class: 'a-top' }, h('span', { class: 'a-ico', html: UNGUARD(22) })), h('span', { class: 'a-name' }, asking ? 'Sure? ⚠' : 'Unguard'), h('span', { class: 'a-nums' }, h('span', { class: 'a-cost' }, `${cost}⚡`))));
        }
      }
      if (t.movable) {
        // The Command Ship's drive: a card like the others, with a button per battleground.
        const cost = t.moveCharge;
        const drift = h('div', { class: 'drift' + (charge < cost ? ' short' : '') + (performance.now() < this.movePulseUntil ? ' dc-pulse' : ''), title: `${t.drive_label || 'Drift'}: ${t.drive_description || 'move to another layer'}` },
          h('div', { class: 'row', style: 'gap:6px' }, face('y', 'D'), h('span', { class: 'a-ico', html: icon('rank', 18) }), h('span', { class: 'a-name' }, 'Move')),
          h('div', { class: 'row', style: 'gap:3px' }, AMBITS.filter((a) => (t.possibleAmbit & AMBIT_FLAG[a]) !== 0).map((a) => h('button', {
            class: 'btn ghost mini ambit-' + a + (a === s.ambit ? ' here' : '') + (this.phase === 'battle' && a === this.stuckLayer ? ' dc-go-layer' : ''), disabled: a === s.ambit, title: a === s.ambit ? 'It is here now' : `Drift to ${AMBIT_NAME[a]}`,
            'aria-label': `Drift to ${AMBIT_NAME[a]}`,
            onclick: () => {
              // Its guards guard from its layer: leaving them behind asks first.
              const left = s.typeId === COMMAND_SHIP_ID && s.owner === YOU.id ? this.blockersOf(s.id).length : 0;
              if (left && !(this.driftAsk?.to === a && performance.now() - this.driftAsk.at < 3000)) {
                const ask = this.driftAsk = { to: a, at: performance.now() };
                audio.play('deny');
                toast(say({ pad: `⚠ Leaves its guard${left === 1 ? '' : 's'} behind: press again`, keys: `⚠ Leaves its guard${left === 1 ? '' : 's'} behind: press again`, touch: `⚠ Leaves its guard${left === 1 ? '' : 's'} behind: tap again` }), 'warn', 2600);
                setTimeout(() => { if (this.driftAsk === ask) this.driftAsk = null; }, 3050);
                return;
              }
              this.driftAsk = null;
              this.coachDone('drift'); this.order({ '@type': '/structs.structs.MsgStructMove', structId: s.id, locationType: 'fleet', ambit: a, slot: 0 }, cost, `Command Ship drifts to ${AMBIT_NAME[a]}`);
            },
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
    this.placeGuardChip();
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
    const gN = u && u.owner !== YOU.id ? this.blockersOf(u.id).length : 0;
    const blockedAll = !!u && kind === 'attack' && this.fullyBlocked(u.id);
    // Icon and number (the word is the cell's title: the strip has room for numbers, not sentences).
    const cell = (ico: string, label: string, value: string, cls = '') => h('div', { class: 'pf-row ' + cls, title: `${label} ${value}` }, h('span', { class: 'pf-ico', html: icon(ico, 15) }), h('span', { class: 'pf-k' }, label), h('b', null, value));
    const step = this.coachKey === 'aim' && this.coachEl?.isConnected ? h('span', { class: 'coach-dots', 'aria-hidden': 'true' }, h('i', { class: 'on' }), h('i', { class: 'on' }), h('i')) : null;
    // Another callout up (it steps aside while aiming here): its words, in the card's last line.
    const told = this.coachKey && this.coachKey !== 'aim' && this.coachKey !== 'flagship' && this.coachEl?.isConnected && this.coachLine ? this.coachLine : null;
    if (told && this.coachUnseen === this.coachKey) { this.coachMark(this.coachKey); this.coachUnseen = null; }
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
        p.attackerDies! >= 0.5 ? cell('ship', 'You lose it', pct(p.attackerDies!), 'c-enemy pf-die high') : p.counter! > 0 ? cell('replay', 'Hits back', '−' + p.counter!.toFixed(1), 'c-enemy pf-back') : p.blocked! > 0 ? cell('shield', 'Blocked', pct(p.blocked!)) : null)
        : kind === 'guard' && u ? h('div', { class: 't-tiny c-player' }, 'Blocks shots, fires back') : null,
      h('div', { class: 'aim-how' }, step, gN ? h('span', { class: 'dc-guarded', title: `${gN} guard${gN === 1 ? '' : 's'} in its layer: shots at it are blocked` }, h('span', { html: icon('shield', 12) }), `×${gN}`) : null,
        told ? h('span', { class: 'aim-coach', title: told.text }, h('b', null, told.title), ' ', told.text.replace(/\s*\([^)]*\)\s*$/, ''))
        : blockedAll ? h('span', null, say({ pad: 'Blocked: A aims at its guard', keys: 'Blocked: Enter aims at its guard', touch: '' })) : h('span', null, say(kind === 'guard' ? { pad: 'D-pad picks, A guards', keys: '←→ pick · Enter guards', touch: '' } : { pad: 'D-pad picks, A fires', keys: '←→ pick · Enter fires', touch: '' })), face('b', 'Esc')));
  }

  /** Bring the docked card up to date (the cursor, the mouse or the turn moved on), and tell a screen
   * reader once per new target, from one quiet status line that stays put (the card itself is rebuilt
   * every turn, so it carries no live region). */
  private refreshDock() {
    if (!this.dockAim()) return;
    const c = this.activeChain();
    const id = this.aimId || this.hovered;
    const key = [id, c?.height, this.selected, this.targeting?.kind === 'attack' ? this.targeting.ws : 'guard', this.coachKey, !!this.coachEl?.isConnected, inputMode()].join('|');
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
  /** `why`: a few words that show even docked (why a held order waits, or why it was withdrawn), after
   * `whyIcon`. */
  private orderCall(msg: Msg, mark: '✓' | '↺' | '⏳' | '✕', label: string, cost = 0, why = '', whyIcon = 'shield') {
    const small = window.innerWidth <= 760 || window.innerHeight <= 560;
    const c = this.chain;
    const m = msg as unknown as Record<string, unknown>;
    const type = String(m['@type']);
    const sprite = (id: unknown) => {
      const st = c && typeof id === 'string' ? c.structs[id] : undefined;
      if (!st) return null;
      const img = h('img', { alt: '' });
      void structPortrait(st.typeId, 'base', st.owner === YOU.id ? 'player' : 'enemy').then((u) => { img.src = u; });
      return h('span', { class: 'dc-order-ship ' + (st.owner === YOU.id ? 'player' : 'enemy') }, img);
    };
    const verb = (ico: string) => h('span', { class: 'dc-order-verb', html: icon(ico, 16) });
    const parts = type.endsWith('MsgStructAttack') ? [sprite(m.operatingStructId), verb('missile'), sprite((m.targetStructId as string[])[0])]
      : type.endsWith('MsgStructDefenseSet') ? [sprite(m.defenderStructId), verb('shield'), sprite(m.protectedStructId)]
      : type.endsWith('MsgStructDefenseClear') ? [sprite(m.defenderStructId), verb('back')]
      : type.endsWith('MsgStructMove') ? [sprite(m.structId), verb('rank'), h('span', { class: 'dc-order-verb', html: icon(String(m.ambit), 16) })]
      : [sprite(m.structId), verb('eye')];
    this.root.querySelectorAll('.dc-order').forEach((n) => n.remove());
    const el = h('div', { class: 'dc-order' + (mark === '⏳' ? ' held' : mark === '✕' ? ' gone' : ''), title: label, 'aria-hidden': 'true' },
      h('b', { class: 'dc-order-mark' }, mark), why ? h('span', { class: 'dc-order-why' }, whyIcon ? h('span', { class: 'dc-order-verb', html: icon(whyIcon, 16) }) : null, why) : null,
      ...parts, mark === '⏳' && !why ? h('span', { class: 'a-cost' }, `${cost}⚡`) : null,
      small || why ? null : h('span', { class: 'dc-order-words' }, label));
    // Docked just above the verbs' left end, where no hull stands (the HUD's edge sat on the space row).
    this.root.appendChild(el);
    const bar = this.root.querySelector('.action-bar')?.getBoundingClientRect();
    const root = this.root.getBoundingClientRect();
    // (Above the callout when one sits over the bar.)
    const co = this.coachEl?.isConnected && this.coachEl.offsetWidth ? this.coachEl.getBoundingClientRect() : null;
    const ceiling = bar ? Math.min(bar.top, co && co.bottom <= bar.top + 4 && co.top > bar.top - 200 ? co.top : bar.top) : 0;
    if (bar) { el.classList.add('docked'); el.style.left = Math.round(bar.left - root.left + 8) + 'px'; el.style.top = Math.round(ceiling - root.top - el.offsetHeight - 6) + 'px'; }
    else el.style.top = '120px';
    this.srSay(mark === '⏳' ? `${label}: waiting for ${cost} charge` : label);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, why ? 3200 : mark === '⏳' ? 2000 : 1500);
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
      if (this.coachSeen('arm') && !this.spectate) this.coach('aim', 'Step 2 of 3 · Fire', { pad: 'D-pad picks, A fires', keys: 'Click FIRE again (or the ringed ship)', touch: 'Tap FIRE' }, true);
      audio.play('select');
    }
    this.predictCache.clear();
    this.refreshSelectionVisuals();
    this.renderActionBar();
  }

  /** A weapon's button (or its key, 1 or 2): the first press arms it and aims as a pad's A does (a guard of
   * their flagship first, then their flagship); pressed again it fires there (or at the target the player
   * ringed since), so a mouse or a finger fires in one press too. */
  private weaponPress(pressed: WeaponSystem, how: 'button' | 'key' = 'button') {
    let ws = pressed;
    const s = this.selectedStruct();
    // A fresh press of a weapon button that reaches none of their flagship's red-shield guards, on a ship
    // the game picked, when its other weapon does (and can be paid for if this one can): that one arms
    // instead, flashing so the switch shows. (Your own flagship: the weapon of its safe shot.) A key, a
    // weapon already armed, or a ship the player picked arms exactly what was pressed.
    if (s && s.owner === YOU.id && how === 'button' && !this.targeting && this.playerPick !== s.id && this.phase === 'battle' && !this.spectate && !this.chain?.isDestroyed(s)) {
      const ready = this.weaponsReady(s);
      const charge = this.session?.chargeAtNext() ?? 0;
      const affordable = (w: { cost: number }) => w.cost <= charge || (ready.find((x) => x.ws === pressed)?.cost ?? Infinity) > charge;
      if (s.typeId === COMMAND_SHIP_ID) {
        if (!this.safeFlagshipShot(s, ws)) { const alt = this.safeFlagshipShot(s); const aw = alt && ready.find((x) => x.ws === alt.ws); if (alt && aw && affordable(aw)) ws = alt.ws; }
      } else {
        const gs = this.aimGoals();
        // (Reaching one counts only where the shooter lives through the return fire.)
        const hits = (w?: { ws: WeaponSystem; targets: SimStruct[] }) => !!w && w.targets.some((x) => gs.has(x.id) && this.autoSafe(s, w.ws, x.id));
        if (gs.size && !hits(ready.find((w) => w.ws === ws))) {
          const other = ready.find((w) => w.ws !== ws && hits(w));
          if (other && affordable(other)) ws = other.ws;
          // (Neither of its weapons reaches one: another fleet ship of yours that does, and lives through it, takes over.)
          else if (!other && this.handOffToGoal(s.id)) { const tg = this.targeting as { kind: string; ws?: WeaponSystem } | null; this.flashWeapon(tg?.ws ?? null); this.renderActionBar(); audio.play('select'); return; }
        }
      }
    }
    const t = this.targeting;
    if (ws !== pressed) this.flashWeapon(ws);
    if (t?.kind === 'attack' && t.ws === ws && this.phase === 'battle') {
      const valid = this.validTargets();
      const flag = this.flagshipSelected();
      const ringed = (this.touchArmed?.ws === ws ? this.touchArmed.target : null) || this.aimId;
      const aim = ringed && valid.has(ringed) && !(flag && !this.flagshipSafe(flag, ws, ringed)) ? ringed : null;
      // Nothing ringed now (it sank, left reach, or could sink your flagship): ring the start; the next press fires.
      if (!aim) {
        this.clearAim(); this.disarmTouch();
        const a = this.aimStart();
        if (a) { this.preAim(a); audio.play('hover'); }
        else { audio.play('deny'); if (flag) toast('Too hurt to trade fire', 'warn', 1800); }
        return;
      }
      // (The button lets go of the cursor, as arming does: a verb left in focus would hold the bar's handover.)
      this.releaseBarFocus();
      if (this.fullyBlocked(aim)) { this.fireAtGuard(aim, inputMode() === 'touch'); return; }
      this.disarmTouch();
      this.clearAim();
      this.attack(ws, aim);
      return;
    }
    this.beginAttack(ws);
    if (this.targeting?.kind === 'attack' && this.phase === 'battle') { const a = this.aimStart(); if (a) this.preAim(a); }
    else if (this.targeting) this.cycleAim(0);
  }
  /** The weapon a press switched to flashes on the bar for a moment. */
  private weaponFlash: { ws: WeaponSystem; until: number } | null = null;
  private flashWeapon(ws: WeaponSystem | null) { this.weaponFlash = ws ? { ws, until: performance.now() + 1500 } : null; }
  /** This ship's weapons in badge order: first the one A (or 1) arms (a red-shield guard in reach, else their
   * flagship; your own flagship: the weapon of its safe shot), then the other. */
  private weaponOrder(s: SimStruct): WeaponSystem[] {
    const ready = this.weaponsReady(s).map((w) => w.ws);
    const first = (s.owner === YOU.id && s.typeId === COMMAND_SHIP_ID ? this.safeFlagshipShot(s)?.ws : null) ?? this.armFirst(s)?.ws;
    return first ? [first, ...ready.filter((x) => x !== first)] : ready;
  }
  /** Ring one target for the armed weapon, as a pad's aim does (its forecast beside it); a touch screen
   * pins its card, Fire on it. */
  private preAim(id: string) {
    const u = this.view.units.get(id);
    if (!u || this.targeting?.kind !== 'attack') return;
    // (Never a ring your flagship's shot there could sink it for.)
    const flag = this.flagshipSelected();
    if (flag && !this.flagshipSafe(flag, this.targeting.ws, id)) return;
    if (inputMode() !== 'touch') { this.cycleAimTo(id); this.refreshDock(); return; }
    const at = this.view.screenOf(id) ?? { x: innerWidth / 2, y: innerHeight / 2 };
    this.aimId = id;
    this.touchArmed = { target: id, ws: this.targeting.ws, from: this.selected || '', at };
    if (this.hovered && this.hovered !== id) { const h0 = this.view.units.get(this.hovered); if (h0) h0.hover = 0; }
    this.hovered = id;
    u.hover = 1;
    this.tipFor(u, at);
  }
  /** After a shot: the next ship arms the weapon that reaches what A aims at (a red-shield guard, else
   * their flagship) and rings it (one press fires it: A, its button again, or Fire on its card). False
   * when it reaches none. */
  private aimGoalWith(ship: SimStruct) {
    const gs = [...this.aimGoals()];
    if (!gs.length) return false;
    // (Only a shot it lives through: an automatic pick never sends a ship to its death.)
    let w: { ws: WeaponSystem; targets: SimStruct[] } | undefined, g: string | undefined;
    for (const x of this.weaponsReady(ship)) { const id = gs.find((i) => x.targets.some((t) => t.id === i) && this.autoSafe(ship, x.ws, i)); if (id) { w = x; g = id; break; } }
    if (!w || !g) return false;
    if (this.selected !== ship.id) this.select(ship.id);
    if (!(this.targeting?.kind === 'attack' && this.targeting.ws === w.ws)) this.beginAttack(w.ws);
    if (this.targeting?.kind !== 'attack') return false;
    this.preAim(g);
    return true;
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
    const pickShip = this.coachKey === 'arm' && this.phase === 'battle' && !(this.selectedStruct()?.owner === YOU.id);
    const guardQueued = this.coachKey === 'guard' && !!this.session?.pending && String(this.session.pending.msg['@type']).endsWith('MsgStructDefenseSet');
    const words = guardQueued ? { pad: 'Guard lands next turn: hold fire', keys: 'Guard lands next turn: hold fire', touch: 'Guard lands next turn: hold fire' }
      : this.coachKey === 'guard' && this.targeting?.kind === 'guard' ? { pad: 'Now pick your Command Ship, A', keys: 'Now click your Command Ship', touch: 'Now tap your Command Ship' }
      : pickShip ? { pad: 'Pick a ship: A', keys: 'Pick a ship: Enter', touch: 'Pick a ship below' } : this.coachSay;
    if (line && words) { const t = say(words); if (line.textContent !== t) line.textContent = t; }
    this.root.querySelectorAll('.dc-pulse').forEach((n) => n.classList.remove('dc-pulse'));
    if (!this.coachEl?.isConnected) return;
    const want = this.coachKey === 'arm' || this.coachKey === 'guard' || this.coachKey === 'drift' || this.coachKey === 'stuck' ? this.coachAnchor(this.coachKey) : null;
    want?.classList.add('dc-pulse');
    // The bar is rebuilt every turn (and the pill comes and goes): the callout follows its control.
    this.placeCoach();
    this.placeGuardChip();
  }

  /** The control a step points at: the first of its anchors (COACH_ANCHOR, ' || ') that is on screen. */
  private coachAnchor(key: string): HTMLElement | null {
    for (const sel of (COACH_ANCHOR[key] || '').split(' || ').filter(Boolean)) {
      const el = this.root.querySelector<HTMLElement>(sel);
      if (el && el.getClientRects().length) return el;
    }
    return null;
  }
  /** The control a waiting step asks for is on screen (a weapon, Guard, the armed weapon). */
  private coachControlShown() {
    const want: Record<string, string> = { arm: '.action-bar .btn.action.weapon:not(:disabled)', aim: '.action-bar .btn.action.weapon.active', guard: '.action-bar .btn.action.guard-btn' };
    const sel = want[this.coachKey];
    if (!sel) return true;
    if (this.coachKey === 'guard' && this.phase === 'battle' && this.guardCandidate()?.id !== this.selected) return false;
    const el = this.root.querySelector<HTMLElement>(sel);
    return !!el && el.getClientRects().length > 0;
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
    // A plain tip is seen once it has really been on screen (a docked aim card can hide it on a short screen).
    if (this.coachUnseen === this.coachKey) { this.coachMark(this.coachKey); this.coachUnseen = null; }
    // (An anchor in the HUD, Drift's fallback, only pulses: the callout keeps its place above the bar.)
    const anchor0 = this.coachAnchor(this.coachKey);
    // (On a touch screen the Drift tip points at your card: a tap there selects the flagship.)
    const anchor = anchor0 && (!anchor0.closest('.battle-top') || (this.coachKey === 'drift' && inputMode() === 'touch')) ? anchor0 : null;
    const a = anchor && anchor.getClientRects().length ? anchor.getBoundingClientRect() : null;
    const root = this.root.getBoundingClientRect();
    const hud = this.root.querySelector('.battle-top')?.getBoundingClientRect();
    const bar = this.root.querySelector('.action-bar')?.getBoundingClientRect();
    // The "Fire! / Command Ship in reach" pill floats above the bar (outside its box): stay above it too.
    const pillEl = this.root.querySelector<HTMLElement>('.action-bar .targeting-hint');
    const pill = pillEl && pillEl.getClientRects().length && getComputedStyle(pillEl).display !== 'none' ? pillEl.getBoundingClientRect() : null;
    const vw = window.innerWidth, gap = 14;
    // (Measured at its full width: the narrow and tight forms are tried below. The Drift step on a touch
    // screen is a narrow column under your HUD card, at the screen's edge, so the top lane stays in sight.)
    el.classList.remove('narrow', 'tight');
    const col = this.coachKey === 'drift' && inputMode() === 'touch' && !!anchor && !!anchor.closest('.battle-top');
    el.classList.toggle('col', col);
    let detached = false, narrow = false;
    const w = el.offsetWidth, hh = el.offsetHeight;
    let below = !!a && a.top + a.height / 2 < window.innerHeight / 2;
    const cx = a ? a.left + a.width / 2 : vw / 2;
    let x = clamp(cx - w / 2, 8, Math.max(8, vw - 8 - w));
    const floor = hud ? hud.bottom + 8 : root.top + 8;
    let y = below ? a!.bottom + gap : Math.min(a ? a.top : bar ? bar.top : window.innerHeight - 160, bar?.top ?? Infinity, pill ? pill.top : Infinity) - gap - hh;
    y = Math.max(y, floor);
    if (col && a) { x = 8; below = true; y = a.bottom + gap; }
    // "Add ships" never covers the setup panel or the + bays it asks for: beside a side panel it keeps to
    // the board (its left edge past the panel); over a phone's bottom sheet it sits on the sheet's top
    // edge, its pointer up at the bay, the board above it clear.
    const panel = this.coachKey === 'fill' ? this.root.querySelector('.setup-panel')?.getBoundingClientRect() : null;
    if (panel && panel.width > vw * 0.6) {
      // A phone's bottom sheet: between the bay and the sheet if it fits there (pointer up at the bay),
      // else above the bay (pointer down), else on the sheet's top edge. Never over the sheet's heading
      // and sizes when there is room on the board.
      const tb = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
      const top = Math.max(tb + 6, root.top + 8), bottom = panel.top - 4;
      // (A short phone has room neither above nor below the bay: beside it on the board, centred on it,
      // as it is or cut to its title and OK (the bay's mark pulses); else on the sheet's top edge.)
      let side: { x: number; y: number } | null = null;
      if (a && !(a.bottom + gap + hh <= bottom) && !(a.top - gap - hh >= top)) for (const tight of [false, true]) {
        el.classList.toggle('tight', tight);
        const cw = el.offsetWidth, ch = el.offsetHeight;
        const y0 = clamp(a.top + a.height / 2 - ch / 2, top, bottom - ch);
        if (y0 < top - 0.5) continue;
        const xr = a.right + 8, xl = a.left - 8 - cw;
        const x0 = xr + cw <= vw - 8 ? xr : xl >= 8 ? xl : null;
        if (x0 != null) { side = { x: x0, y: y0 }; break; }
      }
      if (!side) el.classList.remove('tight');
      if (a && a.bottom + gap + hh <= bottom) { below = true; y = a.bottom + gap; }
      else if (a && a.top - gap - hh >= top) { below = false; y = a.top - gap - hh; }
      else if (side) { below = false; x = side.x; y = side.y; detached = true; }
      else { below = true; y = panel.top + 8; }
    }
    else if (panel && panel.right < vw * 0.6) x = clamp(cx - w / 2, panel.right + 8, Math.max(panel.right + 8, vw - 8 - w));
    // In a fight, a callout over the bar keeps off the ships when it can: in the gap above the bar (the
    // default), in a gap between two decks, at either side, just above the step's own ship, or narrowed
    // to two lines at a side. It takes the spot covering the fewest ships, never the step's own ship,
    // and never the HUD (Pause and Retreat live there).
    if (this.phase === 'battle' && !below && this.coachKey !== 'fill' && this.view) {
      const R = Math.max(16, Math.min(30, vw / 22));
      const ships = [...this.view.units.values()].filter((u) => !u.destroyed).map((u) => ({ id: u.id, p: this.view.screenOf(u.id) })).filter((q): q is { id: string; p: { x: number; y: number } } => !!q.p);
      const own = this.coachKey === 'guard' || this.coachKey === 'flagship' || this.coachKey === 'stuck' ? this.selected : null;
      const ceiling = Math.min(bar?.top ?? Infinity, pill ? pill.top : Infinity, a ? a.top : Infinity) - gap;
      el.classList.add('narrow');
      const nw = el.offsetWidth, nh = el.offsetHeight;
      el.classList.remove('narrow');
      // A callout with a control to point at keeps its pointer unless leaving uncovers two ships or more;
      // the first fight's weapon lessons (arm, aim, charge) stay on their button unless it buries a deck.
      const tether = !a ? 0 : this.coachKey === 'arm' || this.coachKey === 'aim' || this.coachKey === 'charge' || this.coachKey === 'guard' ? 3 : 1.2;
      const best = { x, y, score: Infinity, narrow: false };
      for (const [cw, ch, isNarrow] of [[w, hh, false], [nw, nh, true]] as [number, number, boolean][]) {
        // A ship whose centre is under the callout counts whole; one it only grazes (the hull's edge under
        // the callout's rim, as the bottom deck is under one resting on the bar) counts a third.
        const hit = (q: { x: number; y: number }, x0: number, y0: number) =>
          q.x > x0 && q.x < x0 + cw && q.y > y0 && q.y < y0 + ch ? 1 : q.x + R > x0 && q.x - R < x0 + cw && q.y + R > y0 && q.y - R < y0 + ch ? 0.35 : 0;
        const yDefault = Math.max(ceiling - ch, floor);
        const xs = [clamp(cx - cw / 2, 8, Math.max(8, vw - 8 - cw)), 8, Math.max(8, vw - 8 - cw)];
        const cands: { x: number; y: number; cost: number }[] = xs.map((x0, i) => ({ x: x0, y: yDefault, cost: i ? 0.15 + tether : 0 }));
        const ys = ships.map((q) => q.p.y).sort((p0, p1) => p0 - p1);
        for (let i = 0; i < ys.length - 1; i++) { const top = ys[i] + R, bottom = ys[i + 1] - R; if (bottom - top >= ch + 4) for (const x0 of xs) cands.push({ x: x0, y: top + (bottom - top - ch) / 2, cost: 0.2 + tether }); }
        const sp = own ? ships.find((q) => q.id === own)?.p : null;
        if (sp) cands.push({ x: clamp(sp.x - cw / 2, 8, Math.max(8, vw - 8 - cw)), y: sp.y - R - gap - ch, cost: 0.1 + tether });
        for (const c0 of cands) {
          if (c0.y < floor - 0.5 || c0.y + ch > ceiling + 0.5) continue;
          const cover = ships.reduce((n, q) => n + hit(q.p, c0.x, c0.y), 0);
          const score = cover + c0.cost + (isNarrow ? 0.3 + tether : 0) + (own && ships.some((q) => q.id === own && hit(q.p, c0.x, c0.y)) ? 100 : 0);
          if (score < best.score) Object.assign(best, { x: c0.x, y: c0.y, score, narrow: isNarrow });
        }
      }
      if (best.score < Infinity) {
        detached = Math.abs(best.x - x) > 4 || Math.abs(best.y - y) > 4 || best.narrow;
        x = best.x; y = best.y; narrow = best.narrow;
      }
    }
    el.classList.toggle('narrow', narrow);
    el.style.left = Math.round(x - root.left) + 'px';
    el.style.top = Math.round(y - root.top) + 'px';
    el.style.setProperty('--tip-x', Math.round(clamp(cx - x, 22, w - 22)) + 'px');
    el.classList.toggle('below', below);
    // (Moved off its control to keep the ships clear: no pointer, the control pulses instead.)
    el.classList.toggle('no-tip', !a || detached);
    // A docked order chip under the callout steps up above it.
    const chip = this.root.querySelector<HTMLElement>('.dc-order.docked');
    if (chip) {
      const cr = el.getBoundingClientRect(), ch = chip.getBoundingClientRect();
      if (ch.left < cr.right && cr.left < ch.right && ch.top < cr.bottom && cr.top < ch.bottom) chip.style.top = Math.round(cr.top - root.top - ch.height - 6) + 'px';
    }
  }

  /** A tip, once ever. `stay`: a tutorial step that waits for the player (marked done when they do
   * it or press Got it); a plain tip is marked when shown and fades after 16 s. */
  private coachSay: Record<'pad' | 'keys' | 'touch', string> | null = null;
  /** The callout's words (the docked aim card prints them while the callout steps aside). */
  private coachLine: { title: string; text: string } | null = null;
  /** A plain tip not yet painted (marked seen on its first paint: placeCoach). */
  private coachUnseen: string | null = null;
  private coach(key: string, title: string, text: string | Record<'pad' | 'keys' | 'touch', string>, stay = false, again = false) {
    if ((!again && this.coachSeen(key)) || (this.coachKey === key && this.coachEl?.isConnected)) return;
    // A flagship is down (the K.O.): the fight is decided, no more steps.
    if (this.phase === 'battle' && this.chain && Object.values(this.chain.structs).some((x) => x.typeId === COMMAND_SHIP_ID && this.chain!.isDestroyed(x))) return;
    // A waiting step keeps the floor; a plain tip comes back another time.
    if (!stay && this.coachStay && this.coachEl?.isConnected) return;
    this.coachUnseen = stay ? null : key;
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
    this.coachLine = { title: step ? step[3] : title, text: typeof text === 'string' ? text : say(text) };
    this.root.appendChild(el);
    this.coachEl = el;
    this.coachKey = key;
    this.coachStay = stay;
    this.pulseCoachTarget();
    // A window resized (a phone turned) moves the controls: the callout follows.
    window.addEventListener('resize', this.coachResize);
    // Once the field has settled (the camera and the bar), place it again: it keeps off the ships.
    setTimeout(() => { if (this.coachEl === el) this.placeCoach(); }, 700);
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
      else if (e.category === 'struct_defense_remove' && tx.type.endsWith('DefenseClear')) rows.push(`${name(d.defender_struct_id)} unguards`);
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
    this.clearPointer();
    this.lastOutcome = o;
    this.clearCoach();
    document.querySelectorAll('.dc-guard-chip').forEach((n) => n.remove());
    audio.setIntensity(0.3);
    const s = this.session;
    const won = o.winner === 'you', draw = o.winner === 'draw';
    // The ladder's top rung beaten (a Large fleet against a Hard computer): the ladder is cleared.
    const cleared = won && this.preset === 'hard' && this.difficulty === 'hard' && !this.gauntlet && !this.daily && !this.scenario && !this.spectate;
    // All five gauntlet rounds won: the run's own climax (a banner over the card, a fanfare, a trophy).
    const conquered = won && !!this.gauntlet && this.gauntlet.over && this.gauntlet.fought >= GAUNTLET_ROUNDS.length && !this.spectate;
    const runMs = conquered ? this.gauntlet!.ms || 0 : 0;
    if (conquered) {
      const short = window.innerHeight <= 560;
      const bn = banner('GAUNTLET WON', 'ALL FIVE ROUNDS · BOSS DOWN', 'player', short ? 1800 : 3600);
      if (!short) bn.classList.add('reward');
      audio.stinger('secure', 1); setTimeout(() => audio.play('confirm'), 450); setTimeout(() => audio.play('charge'), 900);
    }
    else if (cleared) {
      // (Raised above the results card, as reward banners are.)
      // (Raised above the results card; on a short screen the card waits for it instead.)
      const short = window.innerHeight <= 560;
      const bn = banner('LADDER CLEARED', o.hull ? 'THE HARDEST FLEET OUTLASTED' : 'THE HARDEST FLEET IS BROKEN', 'player', short ? 1800 : 3600);
      if (!short) bn.classList.add('reward');
      audio.stinger('secure', 1); setTimeout(() => audio.play('confirm'), 450);
    }
    // (Decided on hull, on time or in a standoff: said so, with whose hull held.)
    else banner(won ? 'VICTORY' : draw ? 'STALEMATE' : 'DEFEAT', o.hull ? `${o.stalemate === 'time' ? 'ON TIME' : 'STANDOFF'} · ${won ? 'MORE HULL LEFT' : draw ? 'EVEN HULL' : 'THEIRS HAD MORE HULL'}` : won ? 'ENEMY FLEET BROKEN' : draw ? 'NEITHER FLEET CAN FINISH THE OTHER' : 'YOUR FLEET FALLS BACK', won ? 'player' : draw ? 'neutral' : 'enemy', 2400);
    if (!cleared && !conquered) audio.stinger(won ? 'secure' : draw ? 'alpha' : 'vulnerable', 0.7);
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
    if (!this.spectate && !this.paid.has(s)) {
      this.paid.add(s); record.gain(won ? 25 + 5 * stars : effort); this.noteRung(won);
      // The ladder cleared: remembered (a crown on the setup panel from now on), and a bonus the first time.
      if (cleared) { const first = !this.ladderCleared(); try { localStorage.setItem('structs.ladder.cleared', String(Number(localStorage.getItem('structs.ladder.cleared') || 0) + 1)); } catch { /* this visit */ } if (first) record.gain(150); }
      // The gauntlet won: remembered (a flag beside the crown on the setup panel), its best time kept, and a bonus the first time.
      if (conquered) {
        const first = !this.gauntletWins();
        try {
          localStorage.setItem('structs.gauntlet.won', String(this.gauntletWins() + 1));
          const best = this.gauntletBestMs();
          if (runMs > 0 && (!best || runMs < best)) localStorage.setItem('structs.gauntlet.bestMs', String(Math.round(runMs)));
        } catch { /* this visit */ }
        if (first) record.gain(200);
      }
    }
    // The fight's rewards play now, its own XP (and any promotion it brings) in the same queue, so
    // banners go first and toasts after them, never over them (core/dom holdRewards).
    // (A beat after the fight's own call has gone, so a promotion never prints over "VICTORY".)
    { const s0 = s; this.rewardsOwed = true; setTimeout(() => { if (this.session === s0 && this.phase === 'debrief' && this.rewardsOwed) { this.rewardsOwed = false; holdRewards(false); } }, cleared || conquered ? 2900 : 2100); }
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
        h('div', { class: 'db-call t-display ' + (won ? 'c-player' : draw ? 'c-neutral' : 'c-enemy'), title: o.hull ? `${o.stalemate === 'time' ? `Decided on time after ${DECIDE_AT} turns` : o.stalemate === 'moves' ? 'The flagships kept dancing: decided on hull' : `No damage in ${QUIET_BLOCKS} turns: decided on hull`}: ${this.hullWords(o)}` : line }, won ? 'Victory' : draw ? 'Stalemate' : 'Defeat'),
        o.hull ? h('div', { class: 'db-time', title: this.hullWords(o) }, h('span', { html: icon(o.stalemate === 'time' ? 'clock' : 'shield', 16) }), this.timeLine(o)) : null,
        h('div', { class: 'db-stars', 'aria-label': `${stars} of 3 stars` }, ...[1, 2, 3].map((i) => h('span', { class: i <= stars ? 'on' : '', html: icon('star', 40) }))),
        cleared ? h('div', { class: 'db-trophy', title: 'You beat every rung: a Large fleet against a Hard computer' }, h('span', { html: icon('crown', 30) }), h('b', null, 'Ladder cleared')) : null,
        conquered ? h('div', { class: 'db-trophy gauntlet', title: `All five rounds won in ${clock(runMs)} of fighting${this.gauntletBestMs() ? ` · best ${clock(this.gauntletBestMs())}` : ''}${this.gauntletWins() > 1 ? ` · won ${this.gauntletWins()} times` : ''}` },
          h('span', { html: icon('flag', 30) }), h('b', null, 'Gauntlet won'), runMs ? h('span', { class: 'db-trophy-time' }, clock(runMs)) : null) : null,
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
          h('span', null, won ? (this.gauntlet.over ? `All five rounds won${runMs ? ` in ${clock(runMs)}` : ''}.${this.gauntletBestMs() ? ` Best run: ${clock(this.gauntletBestMs())}.` : ''}` : `Round ${this.gauntlet.fought} of 5 won. Survivors carry their damage forward.`) : `The run ends in round ${this.gauntlet.fought}. Best run: ${this.gauntletBest()}/5 rounds cleared.`)) : null,
        this.daily && this.dailyLast ? this.dailyDebrief(o) : null,
        // What next, biggest first: the next fleet size after a win (A), else the same fight again;
        // then Again, then the fleets (B). One press of A is always a fight.
        this.gauntlet ? h('div', { class: 'debrief-row db-main' },
          this.gauntlet.reinforce
            ? h('button', { class: 'btn solid big grow db-go', 'data-primary': '', onclick: () => { back.remove(); this.resumeGauntlet(); } }, face('a', '⏎'), `Round ${this.gauntlet.round} ▸`)
            : h('button', { class: 'btn solid big grow db-go' + (conquered ? ' db-cleared' : ''), 'data-primary': '', onclick: () => { back.remove(); this.startGauntlet(); } }, face('a', '⏎'), conquered ? 'Play again' : 'New gauntlet'),
          // (A run over: back to the battles, the fleet sizes and the ladder.)
          this.gauntlet.over ? h('button', { class: 'btn secondary', 'data-back': '', title: 'Back to the battles', onclick: () => { back.remove(); this.gauntlet = null; this.toSetup(true); } }, face('b', 'Esc'), 'Battles') : null)
          : (() => {
            const next = this.nextSize(won);
            const again = () => { const owed = this.rewardsOwed; back.remove(); this.toSetup(false); this.fightOrFill(owed); };
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
                  face('a', '⏎'), h('span', { class: 'db-next-w' }, h('span', null, 'Easier'), h('small', null, efill ? 'Add ships' : easier.smaller && easier.softer ? 'Smaller + softer' : easier.smaller ? 'Smaller fleet' : 'Softer CPU')),
                  h('span', { class: 'db-next-size' },
                    easier.smaller || !easier.softer ? [h('span', { html: icon('ship', 18) }), h('b', null, String(k)), h('span', { class: 'db-size-w' }, SIZE_WORD[easier.preset])] : null,
                    easier.difficulty !== this.difficulty ? [h('span', { html: icon('robot', 18) }), h('b', { class: 'db-next-stars' }, stars)] : null)),
                h('button', { class: 'btn secondary', title: againFill ? 'The same fight again: setup opens first, so you can add ships' : 'The same fight again', onclick: again }, h('span', { html: icon('refresh', 16) }), 'Again'), fleets);
            }
            if (cleared) return h('div', { class: 'debrief-row db-main' },
              h('button', { class: 'btn solid big grow db-go db-next db-cleared', 'data-primary': '', title: 'Ladder cleared! Next: the Gauntlet, five battles in a row, a boss at the end', 'aria-label': 'Next: the Gauntlet',
                onclick: () => { back.remove(); this.toSetup(false); this.startGauntlet(); } },
                face('a', '⏎'), h('span', { class: 'db-next-w' }, h('span', null, 'Gauntlet'), h('small', null, '5 rounds · boss')), h('span', { class: 'db-next-size', html: icon('flag', 18) })),
              h('button', { class: 'btn secondary', title: 'The same fight again', onclick: again }, h('span', { html: icon('refresh', 16) }), 'Again'), fleets);
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
    const back = h('div', { class: 'modal-back debrief-back' + ((cleared || conquered) && window.innerHeight <= 560 ? ' dc-late' : '') }, box);
    document.body.appendChild(back);
    if (back.classList.contains('dc-late')) setTimeout(() => back.classList.remove('dc-late'), 1800);
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
    }, (cleared || conquered) && window.innerHeight <= 560 ? 2300 : inputMode() === 'touch' ? 1500 : 1100);
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
  /** The last loss tip's lesson on this rung (the tips take turns rather than repeat). */
  private lastTip(): string { try { const r = JSON.parse(sessionStorage.getItem('structs.lasttip') || 'null'); return r && r.key === this.rungOf().key ? r.kind : ''; } catch { return ''; } }
  private noteTip(kind: string) { try { sessionStorage.setItem('structs.lasttip', JSON.stringify({ key: this.rungOf().key, kind })); } catch { /* this fight only */ } }
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
    const owed = this.rewardsOwed;
    this.carryFleet = this.draft.filter((u) => u.side === 'player').map((u) => ({ ...u, health: undefined }));
    this.preset = p; this.difficulty = d; this.seed = Math.random().toString(36).slice(2, 8);
    this.toSetup(true);
    this.fightOrFill(owed);
  }
  /** Again (or a rung just set up): straight into the fight, unless you're outnumbered with bays to spare.
   * `owed`: the results' rewards had not played yet; straight into a fight they wait for it (engage), and
   * in setup they play there (toSetup released them). */
  private fightOrFill(owed = false) {
    if (this.outnumbered() && this.emptyBays().length) {
      this.fillPrompt = true;
      this.renderSetup();
      return;
    }
    this.rewardsOwed = owed;
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

  /** How many times this browser has cleared the ladder (0: not yet). */
  private ladderCleared() { try { return Number(localStorage.getItem('structs.ladder.cleared') || 0); } catch { return 0; } }

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
    if (won && this.preset === 'hard' && this.difficulty === 'hard') return null;
    if (won) return h('div', { class: 'next-step player', title: 'You beat the hardest fleet. Try today’s Daily Challenge, or the five-round Gauntlet.' }, h('span', { html: icon('daily', 20) }),
      h('span', { class: 'grow ns-big' }, 'Daily'), h('button', { class: 'btn secondary mini', onclick: () => { document.querySelector('.debrief-back')?.remove(); this.startDaily(); } }, 'Go ▸'));
    // After a loss: where their Command Ship is, and how many of your ships reach that layer.
    const c = this.chain, sess = this.session;
    const theirs = c && Object.values(c.structs).find((x) => x.owner === CPU.id && x.typeId === COMMAND_SHIP_ID && !c.isDestroyed(x));
    // Your ships still flying (and where they are now) whose weapons reach its layer; if none survive,
    // the fleet you started with (so a fleet that could reach, and sank, doesn't read "out of reach").
    const reaches = (type: number, from: Ambit) => !!theirs && (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).some((ws) => hasWeapon(TYPES_BY_ID[type], ws) && canTargetAmbit(TYPES_BY_ID[type], ws, from, theirs.ambit));
    const units = c ? Object.values(c.structs).filter((x) => x.owner === YOU.id && !c.isDestroyed(x)) : [];
    const liveReach = units.filter((u) => reaches(u.typeId, u.ambit)).length;
    const startReach = (this.liveSetup?.units || []).filter((u) => u.side === 'player' && reaches(u.type, u.ambit)).length;
    // (Few left at the end: what the fleet could do is what the fleet you started with could reach.)
    const reach = units.length <= 2 ? Math.max(liveReach, startReach) : liveReach;
    // Its guards (they block the shots aimed at it, and fire back).
    const guards = theirs && c ? this.blockersOf(theirs.id) : [];
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
    // Yours fell with no guard ever blocking for it: that is the lesson (a guard in its layer blocks shots).
    // Yours fell: the defence, with this fight's numbers (Outnumbered leads only when it started outnumbered).
    const defence = () => {
      const hits = this.cmdHits, max = this.cmdGuardMax, end = this.cmdGuardAtEnd, sunk = this.cmdGuardsSunk, left = this.cmdGuardsLeft, counter = this.cmdCounterDmg;
      const k = say({ pad: ' (X)', keys: ' (G)', touch: '' });
      // (One short line, every number in the title. Told to fire with the flagship, it isn't blamed for it.)
      const text = counter > 0 && counter >= this.cmdHitDmg && !this.flagshipTold ? 'Its shots drew fire: use others'
        : !max && !this.cmdGuardPossible ? 'No ship could guard it: bring one'
        : !max ? `No guard: guard yours${k}`
        : sunk ? `${sunk === 1 ? 'Its guard' : 'Guards'} sank: guard again${k}`
        : left && !end ? 'Guard left behind: keep one by it'
        : `Still sank: add a 2nd guard${k}`;
      return h('div', { class: 'next-step warn db-tip', title: `Your Command Ship ${max ? `had ${max} guard${max === 1 ? '' : 's'} at most (${sunk} sunk, ${left} left behind), ${end} on its last turn` : 'had no guard'}; ${hits} enemy shots hit it${counter ? `, and its own shots drew ${counter} damage back` : ''}. A guard in its layer blocks shots at it: when one falls, set another at once.\n${lines}` },
        h('span', { class: 'db-tip-ico c-player', html: icon('shield', 20) }), h('span', null, text));
    };
    // Their flagship came out (nearly) untouched behind guards that blocked you: sink the red shields first.
    // When both lessons apply the tips take turns on this rung, so the same advice never repeats.
    const barely = !!theirs && theirs.health >= TYPES_BY_ID[theirs.typeId].maxHealth - 1;
    const blockedN = sess?.stats[YOU.id]?.blocked || 0;
    // (Guarded at any time this fight counts: the kid often never shot at it, so no shot was blocked.)
    const guardedN = Math.max(guards.length, this.theirGuardMax);
    const attackCase = !!theirs && guardedN > 0 && barely && reach > 0;
    const last = this.lastTip();
    const attack = () => {
      this.noteTip('attack');
      return h('div', { class: 'next-step warn db-tip', title: `Their Command Ship ${untouched ? 'took no damage' : barely ? 'was barely scratched' : 'kept more hull than yours'}: up to ${guardedN} guard${guardedN === 1 ? '' : 's'} in its layer guarded it${blockedN ? ` and blocked ${blockedN} of your shots` : ''}${guards.length ? ` (${guards.map((g) => `${TYPES_BY_ID[g.typeId].type}, ${AMBIT_NAME[g.ambit]}`).join('; ')})` : ''}. Their guards wear red shields: sink them first, then it.\n${lines}` },
        h('span', { class: 'db-tip-ico c-enemy', html: icon('shield', 20) }), h('span', null, 'Sink the red shields first'));
    };
    const defenceTip = () => { this.noteTip('defence'); return defence(); };
    // Decided on time (lost, or even): press their flagship sooner. Its guards blocked you: the attack tip;
    // none of yours reach it: the reach line below (where to drift). Never guard advice: yours never fell.
    if (this.lastOutcome?.hull && !outnumbered) {
      if (attackCase || (!!theirs && guardedN > 0 && blockedN > 0 && reach > 0)) return attack();
      if (!theirs || liveReach) return h('div', { class: 'next-step warn db-tip', title: `Decided ${this.lastOutcome.stalemate === 'time' ? 'on time' : 'in a standoff'}: ${this.hullWords(this.lastOutcome)}. Hit their Command Ship sooner${theirs ? ` (it sat in ${layer})` : ''}: when time runs out, the side whose flagship has more hull left wins (flagships even: the whole fleet's hull).\n${lines}` },
        h('span', { class: 'db-tip-ico c-warn', html: icon('clock', 20) }), h('span', null, 'Hit their flagship sooner'));
    }
    const pick = attackCase && !(fell && last === 'attack') ? 'attack'
      : fell && last === 'defence' && this.rungLosses() >= 2 && attackCase ? 'attack'
      : fell ? 'defence' : null;
    if (pick && !outnumbered) return pick === 'attack' ? attack() : defenceTip();
    if (outnumbered) return h('button', { class: 'next-step warn db-tip db-tip-add', title: lines, onclick: () => {
      document.querySelector('.debrief-back')?.remove();
      this.fillPrompt = true;
      this.fillAfterBuild = true;
      this.toSetup(false);
    } }, h('span', { class: 'db-tip-ico db-tip-plus' }, '+'), h('span', { class: 'grow' }, 'Outnumbered: add ships'), h('span', { class: 'db-tip-go' }, '▸'));
    if (pick) return pick === 'attack' ? attack() : defenceTip();
    // Untouched behind its guards: sink the guards first.
    if (untouched && guards.length && reach > 0 && (sess?.stats[YOU.id]?.blocked || 0) > 0) return h('div', { class: 'next-step warn db-tip', title: `Their Command Ship took no damage: ${guards.length} guard${guards.length === 1 ? '' : 's'} blocked your shots (${guards.map((g) => `${TYPES_BY_ID[g.typeId].type} ${g.id}, ${AMBIT_NAME[g.ambit]}`).join('; ')}). Sink the guards first, then it.\n${lines}` },
      h('span', { class: 'db-tip-ico c-enemy', html: icon('shield', 20) }), h('span', null, guards.length === 1 ? 'Its guard blocked you: sink it first' : `${guards.length} guards blocked you: sink them`));
    if (theirs && (!liveReach || untouched || !fell)) {
      // Out of reach: the Move step's own advice (a layer only if the flagship can safely go there).
      const mineCs = c && Object.values(c.structs).find((x) => x.owner === YOU.id && x.typeId === COMMAND_SHIP_ID && !c.isDestroyed(x));
      const go = !liveReach && mineCs && c ? this.moveAdvice(c, mineCs).to : null;
      return h('div', { class: 'next-step warn db-tip', title: lines },
        h('span', { class: 'db-tip-ico ambit-' + theirs.ambit, html: icon(theirs.ambit, 20) }),
        h('span', null, liveReach ? `Their flagship: ${layer} · ${liveReach} reach it`
          : go ? say({ pad: `Y: drift to ${AMBIT_NAME[go]} to reach it`, keys: `D: drift to ${AMBIT_NAME[go]} to reach it`, touch: `Move to ${AMBIT_NAME[go]} to reach it` })
          : `Theirs sits in ${layer}: out of reach`));
    }
    if (fell) return h('div', { class: 'next-step warn db-tip', title: lines },
      h('span', { class: 'db-tip-ico c-player', html: icon('shield', 20) }), h('span', null, say({ pad: 'Guard yours (X), then Drift (Y)', keys: 'Guard yours (G), then Drift (D)', touch: 'Guard yours, then Drift' })));
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
    return { ...this.liveSetup, txs: this.session.executed.slice(), title, winner: o?.winner, end: o?.height, stalemate: o?.stalemate };
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
    // A fight decided on time plays to its decision turn; any other ends a few turns after its last order
    // (or where its flagship fell). Older links don't say how they ended: the last order + 6.
    // (Older links say neither: one whose orders stop by the decision turn ends there at the latest.)
    const decided = code.start + DECIDE_AT, told = code.stalemate != null || code.end != null;
    const end = code.stalemate && code.end != null && code.end >= last ? code.end : told || last > decided ? last + 6 : Math.min(last + 6, decided);
    this.replay = { code, chain, i: 0, acc: 0, speed: 1, end, done: false, ready: false };
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
    holdRewards(false);
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
      // (An older link: a winner with both fleets still in at the decision turn was decided on time.)
      const told = r.code.stalemate != null || r.code.end != null;
      const onTime = r.code.stalemate === 'time' || (!told && (w === 'you' || w === 'cpu') && c.fleetsAtBattle().length >= 2 && c.height - r.code.start >= DECIDE_AT);
      const standoff = (r.code.stalemate === 'moves' || r.code.stalemate === 'quiet') && (w === 'you' || w === 'cpu');
      setTimeout(() => { if (this.replay === r) banner('REPLAY COMPLETE', (w === 'you' ? 'VICTORY' : w === 'cpu' ? 'DEFEAT' : w === 'draw' ? 'STALEMATE' : '') + (onTime ? ' · ON TIME' : standoff ? ' · STANDOFF' : ''), w === 'cpu' ? 'enemy' : 'player', 2600); }, 1800);
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
    // A finger in a fight: of the hulls under it and those within `near` px, the one whose centre is
    // nearest (a hull under the finger counts a little nearer), not whichever was drawn in front.
    if (near && this.phase === 'battle' && (hits.length > 1 || (hits.length && this.view.units.size > 1))) {
      const under = new Set(hits.map((x) => x.object.userData.unit as UnitView).filter((u) => u && !u.destroyed));
      let best: UnitView | undefined, bd = Infinity;
      for (const u of this.view.units.values()) {
        if (u.destroyed || (this.targeting && !u.targetable && !under.has(u))) continue;
        const p = this.view.screenOf(u.id);
        if (!p) continue;
        const d = Math.hypot(p.x - this.pointerPx.x, p.y - this.pointerPx.y) * (under.has(u) ? 0.7 : 1);
        if ((under.has(u) || d < near) && d < bd) { bd = d; best = u; }
      }
      if (best) return { unit: best };
    }
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
    const armedBefore = this.touchArmed;
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
        const a = this.touchArmed, g0 = armedBefore;
        // (Its guard's card already up, the guarded ship tapped: the second tap fires at the guard.)
        if (touch && g0 && g0.target !== unit.id && g0.ws === this.targeting.ws && g0.from === this.selected && this.fullyBlocked(unit.id) && this.blockersOf(unit.id).some((g) => g.id === g0.target)) {
          if (this.flagshipRefuses(g0.target)) return;
          const ws = this.targeting.ws;
          this.disarmTouch();
          toast('Guarded: the shot goes at its guard', 'warn', 1800);
          this.attack(ws, g0.target);
          return;
        }
        if (touch && !(a && a.target === unit.id && a.ws === this.targeting.ws && a.from === this.selected)) {
          // First tap: show the forecast (hover's job on a desktop); a second tap on it fires.
          this.touchArmed = { target: unit.id, ws: this.targeting.ws, from: this.selected || '', at: { ...this.pointerPx } };
          audio.play('hover');
          this.updateHover();
          return;
        }
        if (this.flagshipRefuses(unit.id)) return;
        // Every shot at it would be blocked (a guard in its layer): the shot goes at that guard.
        if (this.fullyBlocked(unit.id)) { this.fireAtGuard(unit.id, touch); return; }
        this.disarmTouch();
        this.attack(this.targeting.ws, unit.id);
      }
      else {
        const s = this.selectedStruct();
        if (s) this.order({ '@type': '/structs.structs.MsgStructDefenseSet', defenderStructId: s.id, protectedStructId: unit.id }, TYPES_BY_ID[s.typeId].defendChangeCharge, `${TYPES_BY_ID[s.typeId].type} guards ${TYPES_BY_ID[unit.typeId].type}`);
      }
      return;
    }
    // An enemy out of the armed weapon's reach: another ship of yours that reaches it takes over.
    if (this.targeting?.kind === 'attack' && !unit.targetable && unit.side === 'enemy' && this.phase === 'battle' && !unit.destroyed) {
      if (this.armAt(unit.id, touch)) return;
      audio.play('deny'); return;
    }
    if (this.targeting?.kind === 'attack' && unit.side === 'player' && this.phase === 'battle' && !unit.destroyed && !this.spectate) {
      audio.play('select'); this.disarmTouch(); this.select(unit.id); this.playerPick = unit.id; return;
    }
    if (this.targeting && !unit.targetable) { audio.play('deny'); return; }
    // An enemy clicked (or tapped) with nothing armed: as A does, arm the best ship of yours that can hit
    // it (never your Command Ship), aimed at it. A second click (a tap on the card's Fire) fires. If none
    // of yours can reach it, its card shows and your selection stays.
    if (this.phase === 'battle' && unit.side === 'enemy' && !this.targeting && !this.spectate && !unit.destroyed) {
      // (Their guarded flagship: one of its guards, the red shields, first.)
      if (unit.typeId === COMMAND_SHIP_ID) for (const g of this.blockersOf(unit.id)) if (this.armAt(g.id, touch)) return;
      if (this.armAt(unit.id, touch)) return;
      audio.play('hover'); this.touchTip = unit.id; this.tipFor(unit, this.pointerPx);
      return;
    }
    // On a touch screen your own bar stays put: an enemy tapped shows its card as a pop-up.
    if (touch && this.phase === 'battle' && unit.side === 'enemy' && this.selectedStruct()?.owner === YOU.id) { audio.play('hover'); this.touchTip = unit.id; this.tipFor(unit, this.pointerPx); return; }
    audio.play('select');
    this.select(unit.id);
    if (unit.side === 'player') this.playerPick = unit.id;
  }

  /** An enemy's card pinned by a tap on a touch screen (your own bar stays): until the next tap or turn. */
  private touchTip: string | null = null;
  /** Keyboard and pad aiming: the target the arrows picked while a weapon (or a guard) is armed. */
  private aimId: string | null = null;
  /** Step the aim through what the armed weapon can reach (or the friends a guard can take), in board order. */
  /** What the armed weapon (or guard pick) can take, in board order, and where a fresh aim starts. */
  private aimOrder() {
    const c = this.activeChain();
    if (!c || !this.targeting) return { order: [] as SimStruct[], start: -1 };
    const order = [...this.validTargets()].map((id) => c.structs[id]).filter((x) => x && !c.isDestroyed(x))
      .sort((a, b) => AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit) || a.slot - b.slot);
    // A fresh aim starts on their Command Ship when it is in reach (taking it down wins the battle).
    let cs = this.targeting.kind === 'attack' ? order.findIndex((x) => x.typeId === COMMAND_SHIP_ID) : -1;
    // Guarded: start on one of its guards (the red shields) that this weapon reaches; the flagship next.
    if (cs >= 0 && this.blockersOf(order[cs].id).length) { const g = this.blockersOf(order[cs].id).find((x) => order.some((o) => o.id === x.id)); if (g) cs = order.findIndex((o) => o.id === g.id); else if (this.fullyBlocked(order[cs].id)) cs = -1; }
    // (Their flagship out of this weapon's reach: one of its guards it does reach, if any.)
    if (cs < 0 && this.targeting.kind === 'attack') { const gs = new Set(this.theirGuards().map((g) => g.id)); cs = order.findIndex((o) => gs.has(o.id)); }
    // Your own Command Ship armed: it starts only on a shot that can't sink it (none: no fresh aim).
    const flag = this.targeting.kind === 'attack' ? this.flagshipSelected() : null;
    if (flag && this.targeting.kind === 'attack') { const shot = this.safeFlagshipShot(flag, this.targeting.ws); return { order, start: shot ? order.findIndex((o) => o.id === shot.t.id) : -1 }; }
    // A fleet ship: the pick above if it lives through the return fire; else the first by the same rank
    // (guards, their flagship, the rest) that it does; else the pick above (only a deliberate press fires it).
    const sel = this.selectedStruct();
    if (this.targeting.kind === 'attack' && sel && order.length) {
      const ws = this.targeting.ws, first = Math.max(0, cs);
      if (!this.autoSafe(sel, ws, order[first].id)) {
        const gs = new Set(this.theirGuards().map((g) => g.id));
        const rank = (t: SimStruct) => (gs.has(t.id) ? 0 : t.typeId === COMMAND_SHIP_ID ? 1 : 2);
        const alt = [...order].sort((a, b) => rank(a) - rank(b)).find((t) => !this.fullyBlocked(t.id) && this.autoSafe(sel, ws, t.id));
        if (alt) return { order, start: order.indexOf(alt) };
      }
    }
    return { order, start: Math.max(0, cs) };
  }
  private aimStart(): string | null { const { order, start } = this.aimOrder(); return start >= 0 ? order[start]?.id ?? null : null; }
  /** Everything the selected ship's ready weapons reach, in board order (the aim walk), with the weapon
   * for each (the armed one when it reaches it). */
  private aimWalk(): { t: SimStruct; ws: WeaponSystem }[] {
    const c = this.activeChain(), sel = this.selectedStruct();
    if (!c || !sel || this.targeting?.kind !== 'attack') return [];
    const armed = this.targeting.ws, by = new Map<string, { t: SimStruct; ws: WeaponSystem }>();
    for (const w of this.weaponsReady(sel)) for (const t of w.targets) if (!c.isDestroyed(t) && (!by.has(t.id) || w.ws === armed)) by.set(t.id, { t, ws: w.ws });
    return [...by.values()].sort((a, b) => AMBITS.indexOf(a.t.ambit) - AMBITS.indexOf(b.t.ambit) || a.t.slot - b.t.slot);
  }
  private cycleAim(dir: number) {
    const c = this.activeChain();
    if (!c || !this.targeting) return;
    const { order, start } = this.aimOrder();
    // Stepping (not a fresh aim) with a weapon armed: every target this ship reaches, switching weapon
    // where only the other one reaches (a pad's only way to the other weapon's targets).
    const walk = dir && this.targeting.kind === 'attack' && this.phase === 'battle' ? this.aimWalk() : [];
    if (walk.length) {
      const i0 = walk.findIndex((x) => x.t.id === this.aimId);
      const step = walk[i0 >= 0 ? (i0 + dir + walk.length) % walk.length : 0];
      if (this.targeting.kind === 'attack' && step.ws !== this.targeting.ws) { this.flashWeapon(step.ws); this.targeting = { kind: 'attack', ws: step.ws }; this.predictCache.clear(); this.refreshSelectionVisuals(); this.renderActionBar(); }
      this.cycleAimTo(step.t.id);
      audio.play('hover');
      return;
    }
    if (!order.length) return;
    const i = order.findIndex((x) => x.id === this.aimId);
    // (No safe start for your flagship: the arrows still walk the targets; A alone rings nothing.)
    const next = order[i >= 0 ? (i + dir + order.length) % order.length : start >= 0 ? start : dir ? 0 : -1];
    if (!next) return;
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

  /** Aim the keys' and pad's cursor at one target (the ring, the forecast), as cycleAim does. */
  private cycleAimTo(id: string) {
    const u = this.view.units.get(id);
    if (!u || !this.targeting) return;
    if (this.hovered && this.hovered !== id) { const h0 = this.view.units.get(this.hovered); if (h0) h0.hover = 0; }
    this.aimId = id; this.hovered = id; this.pointer.set(9, 9); u.hover = 1;
    this.tipFor(u, this.view.screenOf(id) ?? { x: innerWidth / 2, y: innerHeight / 2 });
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
    if (this.targeting.kind === 'attack' && this.flagshipRefuses(target.id)) return true;
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
    // The fight is over (the win beat, the results): Enter, A, 1, 2, G and D order nothing more.
    if ((this.phase === 'debrief' || (this.phase === 'battle' && this.session?.finished)) && ['Enter', '1', '2', 'g', 'G', 'd', 'D', 's', 'S', 'Tab'].includes(e.key)) { e.preventDefault(); return; }
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
      // This ship reaches none of what A aims at (their flagship's guards, else their flagship): a ship that
      // does takes over, unless the player picked this one and it has something in reach (A then fires with it).
      const goals = this.aimGoals();
      const theirPick = this.playerPick === s.id && this.weaponsReady(s).some((w) => w.targets.length);
      if (goals.size && !theirPick && !this.weaponsReady(s).some((w) => w.targets.some((t) => goals.has(t.id) && this.autoSafe(s, w.ws, t.id))) && this.handOffToGoal(s.id)) return;
      // Nothing armed: Enter arms the weapon that reaches a guard of theirs, or their Command Ship, else anything in reach.
      // (Never a hurt flagship's shot that could sink it: the next ship, or the Move step, instead.)
      if (s.typeId === COMMAND_SHIP_ID) {
        const shot = this.safeFlagshipShot(s);
        if (shot) { this.beginAttack(shot.ws); if (this.targeting) this.cycleAimTo(shot.t.id); return; }
      } else {
        const ws = this.armFirst(s)?.ws;
        if (ws) { this.beginAttack(ws); if (this.targeting) this.cycleAim(0); return; }
      }
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
      const eg = this.endgame();
      if (eg === 'armed') return;
      // Stuck with a layer to go to: Enter (A) puts the cursor on it (one more press moves).
      const go = eg === 'stuck' && this.stuckLayer ? this.root.querySelector<HTMLElement>(`.action-bar .drift .btn.mini.ambit-${this.stuckLayer}:not(:disabled)`) : null;
      if (go) { go.focus({ focusVisible: true } as FocusOptions); audio.play('select'); return; }
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
      // In a fight with nothing of yours selected, Tab starts on the best ship to fire with.
      if (this.phase === 'battle' && !(this.selectedStruct()?.owner === YOU.id && !c.isDestroyed(this.selectedStruct()!))) { this.selectBest(); audio.play('hover'); return; }
      const mine = Object.values(c.structs).filter((x) => x.owner === YOU.id && !c.isDestroyed(x)).sort((a, b) => (a.typeId === COMMAND_SHIP_ID ? -1 : b.typeId === COMMAND_SHIP_ID ? 1 : AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit) || a.slot - b.slot));
      if (!mine.length) return;
      const i = mine.findIndex((x) => x.id === this.selected);
      // In setup L/R steps onto the board: A then acts on the ship, not on a panel button left in focus.
      if (this.phase === 'setup') { this.boardKeys = true; if (panel?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur(); }
      this.select(mine[(i + (e.shiftKey ? -1 : 1) + mine.length) % mine.length].id);
      this.playerPick = this.selected;
      audio.play('hover');
      return;
    }
    if ((e.key === '1' || e.key === '2') && this.phase === 'battle' && (!s || s.owner !== YOU.id || this.chain?.isDestroyed(s))) { this.handleKey(new KeyboardEvent('keydown', { key: 'Enter' })); return; }
    // The one-press Guard chip is up (and not hushed): X (G) presses it, whatever is selected.
    if ((e.key === 'g' || e.key === 'G') && this.phase === 'battle' && !this.targeting) {
      const chip = this.root.querySelector<HTMLButtonElement>('.dc-guard-chip');
      if (chip && !this.root.classList.contains('dc-chip-hush')) { chip.click(); return; }
    }
    if (!s || s.owner !== YOU.id) return;
    if (this.phase === 'setup' && (e.key === 'g' || e.key === 'G')) { this.startGuardPick(); if (this.targeting) this.cycleAim(0); return; }
    if (this.phase !== 'battle') return;
    // A destroyed hull can't act (and a new order would replace a valid queued one).
    if (this.chain?.isDestroyed(s)) return;
    const t = TYPES_BY_ID[s.typeId];
    if (e.key === '1' || e.key === '2') {
      // 1 is the weapon wearing the 1 badge (the one that reaches a red-shield guard, or their flagship), 2 the other.
      // A weapon with nothing in reach hands over to the one that has (or, like Enter, to another ship).
      const want = this.weaponOrder(s)[Number(e.key) - 1];
      const w = this.weaponsReady(s).find((x) => x.ws === want);
      const ws = w?.targets.length ? w.ws : this.armFirst(s)?.ws;
      // (The other weapon, already aimed: the aim stays; only a key's own weapon pressed again lets go.)
      if (ws && ws !== w?.ws && this.targeting?.kind === 'attack' && this.targeting.ws === ws) { this.cycleAim(0); return; }
      if (ws) this.weaponPress(ws, 'key');
      else if (this.targeting?.kind === 'guard') { this.targeting = null; this.clearAim(); this.refreshSelectionVisuals(); this.renderActionBar(); audio.play('deny'); }
      else { const enter = new KeyboardEvent('keydown', { key: 'Enter' }); this.handleKey(enter); }
    } else if (e.key === 'g' || e.key === 'G') {
      this.startGuardPick(); if (this.targeting) this.cycleAim(0);
    }
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
        // The layer the Move step suggests, if it suggests one; else the first.
        const first = (this.stuckLayer && this.root.querySelector<HTMLButtonElement>(`.drift .btn.mini.ambit-${this.stuckLayer}:not(:disabled)`)) || this.root.querySelector<HTMLButtonElement>('.drift .btn.mini:not(:disabled)');
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

  /** Let go of every hover, ring and card (a phase change; a finger lifted off nothing). */
  private clearPointer() {
    this.disarmTouch();
    this.touchTip = null;
    if (this.hovered) { const u = this.view?.units.get(this.hovered); if (u) u.hover = 0; this.hovered = null; }
    this.pointer?.set(9, 9);
    hideTooltip();
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

  /** Floating words (GUARDING, LOCK-ON, damage) born near the top of the field keep below the HUD's
   * cards instead of printing underneath them: the view clamps them to this floor. (Measured twice a
   * second, not every frame: the cards only change size on a resize or when overtime adds its meter.) */
  private floorAt = 0;
  private clampFloaters(t: number) {
    if (t - this.floorAt < 0.5) return;
    this.floorAt = t;
    const hud = this.root.querySelector('.battle-top')?.getBoundingClientRect();
    // (Overtime's meter hangs below the turn card on TV and desktop: the words keep below it too.)
    const meter = this.root.querySelector('.dc-ot-meter')?.getBoundingClientRect();
    this.view.floorY = hud && hud.height ? Math.max(hud.bottom, meter && meter.height ? meter.bottom : 0) + 4 : 0;
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
    const guardN = unit.side === 'enemy' ? this.blockersOf(unit.id).length : 0;
    if (guardN) lines.push(h('div', { class: 'dc-guarded', title: `${guardN} of their ships guard it from its own layer: your shots at it are blocked. Sink the guards.` }, h('span', { html: icon('shield', 14) }), `Guarded ×${guardN}`));
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
          p.attackerDies! > 0 ? row('ship', 'You lose it', pct(p.attackerDies!), 'c-enemy pf-die' + (p.attackerDies! >= 0.5 ? ' high' : '')) : null,
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
      if (this.flagshipRefuses(a.target)) return;
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
    // (Only while the control the step points at is on screen: a step whose control has gone holds nothing.)
    const teaching = this.coachStay && !!this.coachEl?.isConnected && !this.session?.pending && !this.held && this.coachControlShown();
    if (this.session && this.phase === 'battle' && !this.paused && !teaching) this.session.update(Math.max(dt, this.engine.realDt) * 1000);
    if (this.phase === 'replay') this.stepReplay(dt);
    this.view.update(dt, t);
    this.clampFloaters(t);
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

/** A run's fighting time as m:ss. */
function clock(ms: number) { const t = Math.round(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }

function humanError(e: string) {
  if (e.includes('insufficient charge')) return 'not enough charge — ' + e.split(': ').pop();
  if (e.includes(': hidden')) return 'the target is hidden (stealth) in another layer';
  if (e.endsWith(' is hidden')) return 'it is already hidden';
  if (e.includes('out_of_range')) return 'the target is out of reach';
  if (e.includes('destroyed')) return 'that ship is already destroyed';
  if (e.includes('not found')) return 'that ship is gone';
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
