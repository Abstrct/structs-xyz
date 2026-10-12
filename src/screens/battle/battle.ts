/* Battle Simulator: setup → deploy → battle ⇄ paused → debrief.
 * Your fleet against the computer's, both away from home, resolved block by
 * block by the TypeScript port of structsd's combat rules. */
import * as THREE from 'three';
import type { Engine, Screen } from '../../core/engine';
import { moveFocus } from '../../core/pad';
import { banner, confirmBox, copyText, dismissConfirms, h, hideTooltip, portrait, showTooltip, toast } from '../../core/dom';
import { audio } from '../../core/audio';
import { cap, clamp, damp, hash32 } from '../../core/util';
import { BoardZoom, bindPinch, bindTap } from './zoom';
import {
  type Ambit, AMBIT_FLAG, AMBIT_NAME, AMBITS, COMMAND_SHIP_ID, controlName, DEFENSE_HINT, DEFENSE_NAME, PASSIVE_NAME,
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
import { BattleSession, predictAttack, type Outcome } from './session';
import { addBattleLights, slotX, TIER_Y, WORLD_PALETTES } from './env';
import { currentRoute, routeUrl } from '../../core/nav';

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
    document.querySelectorAll('.debrief-back, .gauntlet-back, .slot-editor').forEach((n) => n.remove());
    this.forfeitIfEngaged();
  }

  resize(_w: number, hgt: number) {
    this.view?.fx.setScale(hgt, this.camera.fov);
    this.fitCamera();
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
    const side = this.phase === 'setup' ? (short ? 316 : w > 760 ? 346 : 0) : 0;
    // The battle log docks on the right from 1100px up, when it shows (always in a replay).
    const right = this.phase !== 'setup' && w > 1100 && (this.showLog || this.phase === 'replay') ? 300 : 0;
    const usableW = w - side - right;
    const narrow = w <= 760;
    const compact = narrow || short;
    // On a phone the setup sheet covers the lower 55%: fit the board above it.
    // (A phone on its side packs its HUD tighter still, mobile.css: about 170 px of it.)
    const hud = this.phase === 'setup' ? (narrow && !short ? hgt * 0.55 + 50 : 60) : compact ? (short ? (coarse && hgt <= 450 ? 170 : 230) : 360) : 300;
    const usableH = Math.max(160, hgt - hud);
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    // A phone held upright is short of width, not height: frame the field closer (the Command Ships
    // sit at ±19.4, so 22.5 still shows them whole) and every ship draws about a fifth bigger.
    const halfW = narrow && !short ? 22.5 : 26.5, halfH = 11.8;
    const distW = halfW / (t * (usableW / hgt));
    const distH = halfH / (t * (usableH / hgt));
    this.fitDist = Math.max(distW, distH, 34);
    if (side) this.camera.setViewOffset(w, hgt, -side / 2, -14, w, hgt);
    else if (narrow && !short && this.phase === 'setup') this.camera.setViewOffset(w, hgt, 0, hgt / 2 - (44 + hgt * 0.45) / 2, w, hgt);
    // A tall phone frames the field a little high, toward the HUD, leaving the action bar room below.
    else if (this.phase !== 'setup') this.camera.setViewOffset(w, hgt, right / 2, compact ? (short ? -10 : 34) : -12, w, hgt);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /* ── Setup ────────────────────────────────────────────────────────────── */
  private toSetup(reroll = true) {
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
    } else if ((reroll || !this.draft.length) && !this.gauntlet) this.draft = layout(this.preset, this.seed);
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
    await this.view.build(chain, YOU.id);
    if (token !== this.buildToken) return;
    this.buildGhosts();
    this.refreshSelectionVisuals();
    // The card reads the preview chain (guards, wards): redraw it from the new one.
    if (this.phase === 'setup') this.renderActionBar();
  }

  private clearGhosts() {
    // Ghost geometry and materials are shared (GHOST below), so clearing only detaches.
    for (const g of [...this.ghosts.children]) this.ghosts.remove(g);
  }

  /* Empty player slots during setup: clickable frames to add a struct. */
  private buildGhosts() {
    this.clearGhosts();
    if (this.phase !== 'setup') return;
    for (const ambit of AMBITS) {
      for (let slot = 0; slot < 4; slot++) {
        if (this.draft.some((u) => u.side === 'player' && u.type !== COMMAND_SHIP_ID && u.ambit === ambit && u.slot === slot)) continue;
        const m = new THREE.Mesh(GHOST.plate, GHOST.mat);
        m.renderOrder = 3;
        const y = ambit === 'land' ? TIER_Y.land - 0.85 : ambit === 'water' ? TIER_Y.water - 1.0 : TIER_Y[ambit] - 0.2;
        m.position.set(slotX('player', slot, false), y, 0);
        m.userData.ghost = { ambit, slot };
        const pick = new THREE.Mesh(GHOST.pick, GHOST.pickMat);
        pick.userData.ghost = { ambit, slot };
        m.add(pick);
        this.ghosts.add(m);
      }
    }
  }

  private renderSetup() {
    this.root.querySelectorAll('.battle-hud, .setup-panel, .action-bar, .battle-log, .battle-top').forEach((n) => n.remove());
    // Dreamcast setup: the enemy's size as big numbers, the challenges as tiles, one word each.
    // Everything else (what a mode is, how to edit a fleet) is a hover away in the title.
    // Counted as the versus strip and the HUD count them (their Command Ship too), and sized in words,
    // so "Easy" only ever means the computer's skill.
    const presetBtns = PRESETS.map((p) => h('button', {
      class: 'btn choice dc-size' + (p.id === this.preset && !this.scenario && !this.gauntlet && !this.daily ? ' active' : ''), title: `${p.name}: ${p.enemy} enemy ships and their Command Ship. ${p.note}`,
      onclick: () => this.leaveGauntlet(() => { audio.play('select'); this.preset = p.id; this.scenario = null; this.daily = null; this.difficulty = DIFFICULTY_FOR[p.id]; this.seed = Math.random().toString(36).slice(2, 8); this.toSetup(true); }),
    }, h('span', { class: 'dc-size-n' }, p.id === 'random' ? '?' : String(Number(p.enemy) + 1)), h('span', { class: 'sub' }, SIZE_WORD[p.id])));
    const diffBtns = (['easy', 'difficult', 'hard'] as Difficulty[]).map((d) => h('button', {
      class: 'btn choice small' + (d === this.difficulty ? ' active' : ''), disabled: (!!this.gauntlet || !!this.daily) && d !== this.difficulty,
      title: this.gauntlet ? 'Set by the gauntlet round' : this.daily ? 'Set by the daily engagement' : 'Computer skill',
      'aria-label': `Computer skill: ${cap(d)}`,
      onclick: () => { audio.play('select'); this.difficulty = d; this.renderSetup(); },
    }, '★'.repeat(d === 'easy' ? 1 : d === 'difficult' ? 2 : 3)));
    const blockBtns = [{ ms: 2000, name: '2 s', note: 'Quick turns' }, { ms: 6000, name: '6 s', note: 'Real game speed' }].map((b) => h('button', {
      class: 'btn choice small' + (b.ms === this.blockMs ? ' active' : ''), disabled: (!!this.gauntlet || !!this.daily) && b.ms !== this.blockMs, title: b.note,
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
          h('button', { class: 'btn choice gauntlet' + (g ? ' active' : ''), title: g ? `${GAUNTLET_ROUNDS[g.round - 1].name}: ships you lose stay lost, damage carries over, a win earns a new ship` : 'Gauntlet: five battles in a row. Ships you lose stay lost.',
            onclick: () => { if (g) return; audio.play('select'); this.startGauntlet(); } },
            h('span', { class: 'dc-ch-ico', html: icon('flag', 26) }), h('span', null, 'Gauntlet'), h('span', { class: 'sub dc-pips', 'aria-label': `best ${this.gauntletBest()} of 5` }, ...[1, 2, 3, 4, 5].map((i) => h('i', { class: i <= (g ? g.round - 1 : this.gauntletBest()) ? 'on' : '' })))),
          this.dailyButton()),
        // The finer controls fold away behind a gear: a first battle needs only a fleet size and Start.
        h('button', { class: 'setup-more' + (this.moreOpts ? ' open' : ''), 'aria-expanded': this.moreOpts ? 'true' : 'false', 'aria-label': 'More options', title: `${cap(this.difficulty)} computer · ${this.spectate ? 'autopilot' : 'you fly'} · ${this.blockMs / 1000} s turns`,
          onclick: () => { audio.play('select'); this.moreOpts = !this.moreOpts; this.renderSetup(); if (this.moreOpts) this.root.querySelector('.setup-more-body')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } },
          h('span', { html: icon('gear', 18) }), h('span', { class: 'setup-more-sum' }, `${'★'.repeat(this.difficulty === 'easy' ? 1 : this.difficulty === 'difficult' ? 2 : 3)} · ${this.spectate ? 'Auto' : 'You'} · ${this.blockMs / 1000} s`)),
        this.moreOpts ? h('div', { class: 'col setup-more-body' },
          h('div', { class: 'choice-row', title: 'Computer skill' }, h('span', { class: 'dc-opt-ico', html: icon('robot', 18) }), diffBtns),
          h('div', { class: 'choice-row', title: 'Who flies your fleet' },
            h('span', { class: 'dc-opt-ico', html: icon('ship', 18) }),
            h('button', { class: 'btn choice small' + (!this.spectate ? ' active' : ''), onclick: () => { audio.play('select'); this.spectate = false; this.renderSetup(); } }, 'You'),
            h('button', { class: 'btn choice small' + (this.spectate ? ' active' : ''), disabled: !!g || !!this.daily, title: g ? 'A gauntlet run is flown, not watched' : this.daily ? 'A daily is flown, not watched' : 'The computer flies both sides', onclick: () => { audio.play('select'); this.spectate = true; this.renderSetup(); } }, 'Auto')),
          h('div', { class: 'choice-row', title: 'Turn length (block time)' }, blockBtns)) : null,
        h('div', { class: 'dc-versus', title: this.daily || g ? 'Your ships are fixed. Select one and press G to change who it guards.' : 'Click one of your ships to swap it, or an empty frame to add one. Select a ship and press G to choose who it guards.' },
          h('span', { class: 'c-player', html: icon('ship', 22) }), h('b', { class: 'c-player' }, String(youCount)),
          h('span', { class: 'dc-vs' }, 'VS'),
          h('b', { class: 'c-enemy' }, String(cpuCount)), h('span', { class: 'c-enemy dc-flip', html: icon('ship', 22) })),
        err ? h('div', { class: 't-tiny c-enemy' }, err) : null,
        this.recordStrip(),
      ),
      h('div', { class: 'setup-foot row' },
          g ? h('button', { class: 'btn ghost', title: 'Abandon the run', onclick: () => this.leaveGauntlet(() => { audio.play('select'); this.toSetup(true); }) }, h('span', { html: icon('back', 16) }))
            : h('button', { class: 'btn ghost', title: this.daily ? 'Leave the daily' : 'Shuffle both fleets', 'aria-label': this.daily ? 'Leave the daily' : 'New fleets', onclick: () => { audio.play('select'); this.scenario = null; this.daily = null; this.seed = Math.random().toString(36).slice(2, 8); this.toSetup(true); } }, h('span', { html: icon(this.daily ? 'back' : 'dice', 18) })),
          h('button', { class: 'btn solid big grow dc-start', disabled: !!err, onclick: () => void this.engage() }, face('a', '⏎'), this.spectate ? 'Watch' : 'Start'),
        ),
      h('div', { class: 'keys setup-keys dc-keys' },
        h('span', { title: 'Fire (keys 1 and 2)' }, h('kbd', null, '1'), h('span', { html: icon('target', 16) })), h('span', { title: 'Guard (G)' }, h('kbd', null, 'G'), h('span', { html: icon('shield', 16) })),
        h('span', { title: 'Drift (D)' }, h('kbd', null, 'D'), h('span', { html: icon('trade', 16) })), h('span', { title: 'Next ship (Tab)' }, h('kbd', null, 'Tab'), h('span', { html: icon('ship', 16) })), h('span', { title: 'Pause (Space)' }, h('kbd', null, '␣'), h('span', null, '❚❚'))),
    );
    this.root.appendChild(panel);
    this.els.setup = panel;
    this.renderActionBar();
  }

  private scenario: string | null = null;

  private dailyButton() {
    const key = dailyKey();
    const d = this.daily && this.daily.key === key ? this.daily : dailyScenario(key);
    const best = dailyBest(key), streak = dailyStreak(key);
    return h('button', { class: 'btn choice daily' + (this.daily ? ' active' : ''), title: [`Daily Challenge: ${d.name}`, `${d.twist.name}: ${d.twist.note}`, best ? 'Best today: ' + describeDaily(best) : 'The same battle for everyone today', `Next in ${untilTomorrow()}`].join('\n'),
      onclick: () => { if (this.daily) return; audio.play('select'); this.startDaily(); } },
      h('span', { class: 'dc-ch-ico', html: icon('daily', 26) }), h('span', null, 'Daily'),
      // Time left on today's battle reads as a countdown: the clock says so.
      h('span', { class: 'sub dc-left' }, best?.won ? '★' : streak ? `${streak}×` : [h('span', { html: icon('clock', 13) }), untilTomorrow()]));
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
    const seed = Math.random().toString(36).slice(2, 8);
    const fleet = layout('difficult', seed).filter((u) => u.side === 'player');
    this.gauntlet = { round: 1, fleet, seed, engaged: false, over: false, fought: 0, reinforce: false };
    this.scenario = null;
    this.daily = null;
    this.spectate = false;        // a run is flown, not watched
    this.blockMs = 2000;
    this.loadGauntletRound();
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

  private loadGauntletRound() {
    const g = this.gauntlet!;
    g.engaged = false;
    const r = GAUNTLET_ROUNDS[g.round - 1];
    this.difficulty = r.difficulty;
    this.draft = [...g.fleet.map((u) => ({ ...u })), ...gauntletEnemy(g.round, g.seed)];
    this.toSetup(false);
    banner(`ROUND ${g.round}`, `GAUNTLET · ${r.name.toUpperCase()}`, 'neutral', 1600);
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

  /* Fleet editor popover for a player slot. */
  private openSlotEditor(ambit: Ambit, slot: number, existing: Unit | null, at: { x: number; y: number }) {
    document.querySelectorAll('.slot-editor').forEach((n) => n.remove());
    const isCmd = existing?.type === COMMAND_SHIP_ID;
    const opts = isCmd ? [] : FLEET_TYPES.filter((t) => t.id !== COMMAND_SHIP_ID && fits(t.id, ambit));
    const close = () => ed.remove();
    const choose = (typeId: number | null) => {
      audio.play('confirm');
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
      close();
      this.renderSetup();
      void this.buildPreview();
    };
    const list = isCmd
      ? AMBITS.map((a) => h('button', { class: 'btn ghost', disabled: existing?.ambit === a, onclick: () => moveCmd(a) }, AMBIT_NAME[a]))
      : opts.map((t) => h('button', { class: 'slot-opt' + (existing?.type === t.id ? ' active' : ''), onclick: () => choose(t.id) },
        h('img', { class: 'slot-img', alt: '', 'data-type': String(t.id) }), h('span', { class: 'grow' }, h('div', null, t.type), h('div', { class: 't-tiny c-hint' }, roleOf(t)))));
    const ed = h('div', { class: 'slot-editor panel player', style: `left:${Math.min(at.x, window.innerWidth - 300)}px; top:${Math.min(at.y, window.innerHeight - 380)}px` },
      h('div', { class: 'panel-head' }, h('span', { class: 't-label' }, isCmd ? 'Command Ship layer' : `${AMBIT_NAME[ambit]} · slot ${slot + 1}`), h('button', { class: 'btn ghost icon', onclick: close, 'aria-label': 'Close' }, '×')),
      h('div', { class: 'panel-body col scroll', style: 'max-height:320px' }, list,
        existing && !isCmd ? h('button', { class: 'btn danger', onclick: () => choose(null) }, 'Remove ship') : null),
    );
    this.root.appendChild(ed);
    ed.querySelectorAll<HTMLImageElement>('img.slot-img').forEach((img) => { void spriteDataUrl(Number(img.dataset.type)).then((u) => { img.src = u; }); });
    const off = (e: PointerEvent) => { if (!ed.contains(e.target as Node)) { close(); window.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => window.addEventListener('pointerdown', off, true), 0);
  }

  /* ── Engage ───────────────────────────────────────────────────────────── */
  private async engage() {
    if (validate(this.draft)) return;
    if (this.gauntlet && (this.gauntlet.over || this.gauntlet.reinforce)) { this.resumeGauntlet(); return; }
    audio.play('confirm');
    document.querySelectorAll('.slot-editor').forEach((n) => n.remove());
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
    if (!(await this.view.build(this.chain, YOU.id)) || !current()) return;
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
    this.selectFirst();
    // Step 1 needs a ship with something in reach: if the Command Ship has nothing, start on one that does.
    if (!this.coachSeen('arm')) {
      const sel = this.selectedStruct();
      if (sel && !this.weaponsReady(sel).some((w) => w.targets.length)) {
        const ready = Object.values(this.chain!.structs).find((x) => x.owner === YOU.id && !this.chain!.isDestroyed(x) && this.weaponsReady(x).some((w) => w.targets.length));
        if (ready) this.select(ready.id);
      }
    }
    // A first battle walks through its first shot in three steps, each waiting until it is done
    // (only when a shot is possible: a step nothing can finish would just hold the clock).
    const canShoot = Object.values(this.chain!.structs).some((x) => x.owner === YOU.id && !this.chain!.isDestroyed(x) && this.weaponsReady(x).some((w) => w.targets.length));
    if (!this.spectate && canShoot) this.coach('arm', 'Step 1 of 3 · Weapon', { pad: 'Press A', keys: 'Press 1, or click a weapon', touch: 'Tap a weapon below' }, true);
  }

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
    // Once the player has fired a shot, and no other tip is up: the flagship can change battleground.
    if (!this.spectate && !this.coachEl?.isConnected && b.txs.some((tx) => tx.ok && tx.signer === YOU.id && tx.events.some((e) => e.category === 'struct_attack'))) {
      this.coach('drift', 'Drift', { pad: 'Y moves your Command Ship', keys: 'D moves your Command Ship', touch: 'Your Command Ship can move layers' });
    }
    if (b.txs.some((tx) => tx.ok && tx.signer === CPU.id && tx.events.some((e) => e.category === 'struct_attack'))) {
      if (!this.spectate && !this.coachEl?.isConnected && !this.coachSeen('guard') && !this.targeting) {
        // The tip asks for a guard on the Command Ship, so it hands over a ship that can be one:
        // in the flagship's layer (guards block only there), selected, its Guard button pulsing.
        const cmd = Object.values(chain.structs).find((x) => x.owner === YOU.id && x.typeId === COMMAND_SHIP_ID && !chain.isDestroyed(x));
        const guard = cmd && Object.values(chain.structs).find((x) => x.owner === YOU.id && x.id !== cmd.id && !chain.isDestroyed(x) && x.ambit === cmd.ambit && TYPES_BY_ID[x.typeId].canDefend);
        if (guard) {
          this.select(guard.id);
          this.coach('guard', 'Guard', { pad: 'X, then pick your Command Ship', keys: 'G, then click your Command Ship', touch: 'Guard, then tap your Command Ship' });
        }
      }
    }
    for (const tx of b.txs) {
      if (!tx.ok && tx.signer === YOU.id && !this.spectate) {
        toast('Order failed: ' + humanError(tx.error || ''), 'enemy', 4200);
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
    // Reach changes block to block (a target went dark, an attacker died): re-ring.
    const sel = this.selectedStruct();
    if (this.targeting && (!sel || chain.isDestroyed(sel))) this.targeting = null;
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
    if (firing) this.coachDone('aim');
    const charge = this.session.chargeAtNext();
    if (charge >= cost) {
      const r = this.session.submit(msg);
      this.held = null;
      // The turn card already says ✓ Sent; the toast is just the call.
      if (!this.coachEl?.isConnected) toast((r.replaced ? '↺ ' : '✓ ') + label, 'player', 1500);
    } else {
      this.session.cancelPending();
      this.held = { msg, cost, label };
      toast(`⏳ ${label} · ⚡${cost}`, 'warn', 2000);
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
    const pauseBtn = h('button', { class: 'btn ghost mini', title: 'Pause (Space)', 'aria-label': 'Pause', onclick: () => this.togglePause() }, '❚❚');
    const center = h('div', { class: 'block-card panel', title: 'Turn: one block of the chain' },
      h('div', { class: 'spread' }, h('span', { class: 't-label c-hint' }, h('span', { class: 's-only' }, 'Turn'), h('span', { class: 'x-only' }, 'Block')), h('span', { class: 't-label c-hint' }, nextIn)),
      blockNum, blockBar, h('div', { class: 'row', style: 'justify-content:center; gap:6px' }, order, cancel),
      h('div', { class: 'row wrap block-ctl', style: 'justify-content:center; gap:4px; margin-top:4px' }, pauseBtn,
        h('button', { class: 'btn ghost mini', disabled: !!this.gauntlet || !!this.daily, title: this.gauntlet || this.daily ? 'Pace is fixed for this run' : 'Turn length: 2 s training or 6 s real game pace', onclick: (e: Event) => { this.blockMs = this.blockMs === 2000 ? 6000 : 2000; if (this.session) { this.session.blockMs = this.blockMs; this.session.blockClock = Math.min(this.session.blockClock, this.blockMs - 1); } (e.currentTarget as HTMLElement).textContent = `${this.blockMs / 1000}s`; toast(`${this.blockMs / 1000} s turns`, '', 1400); } }, `${this.blockMs / 1000}s`),
        h('button', { class: 'btn ghost mini', title: 'Battle log', 'aria-label': 'Battle log', 'aria-pressed': this.showLog ? 'true' : 'false', onclick: (e: Event) => { this.showLog = !this.showLog; try { localStorage.setItem('structs.battle.log', this.showLog ? '1' : '0'); } catch { /* ignore */ } (e.currentTarget as HTMLElement).setAttribute('aria-pressed', this.showLog ? 'true' : 'false'); this.root.querySelector('.battle-log')?.classList.toggle('shut', !this.showLog); this.fitCamera(); } }, h('span', { html: icon('queue', 14) })),
        h('button', { class: 'btn danger mini', title: 'Retreat', 'aria-label': 'Retreat', onclick: () => {
          const wasPaused = this.paused;
          if (!wasPaused) this.togglePause();
          void confirmBox('Retreat', this.gauntlet ? 'Pull your fleet out? This ends your gauntlet run.' : 'Pull your fleet out? The battle ends and you return to fleet setup.', 'Retreat').then((yes) => {
            if (yes) this.toSetup(false);
            else if (!wasPaused && this.paused) this.togglePause();
          });
        } }, h('span', { html: icon('flag', 14) }))),
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
    if (!c || !s) {
      // On a touch screen there is no Tab: the empty bar is itself the button that picks a ship.
      if (this.phase === 'battle') this.root.appendChild(inputMode() === 'touch'
        ? h('button', { type: 'button', class: 'action-bar panel empty ab-pick', onclick: () => { audio.play('select'); this.selectFirst(); } }, h('span', { class: 'c-player', html: icon('ship', 22) }), h('span', { class: 't-label' }, 'Pick a ship'))
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
      actions.push(h('button', { class: 'btn', onclick: () => this.startGuardPick() }, 'Assign guard', h('kbd', null, 'G')));
      const du = this.draftUnit(s.id);
      if (du?.protects) actions.push(h('button', { class: 'btn ghost', onclick: () => { du.protects = null; this.renderSetup(); void this.buildPreview(); } }, 'Clear guard'));
    }
    if (this.phase === 'battle' && mine && !dead && this.spectate) {
      actions.push(h('div', { class: 'dc-auto', title: 'Spectating: the computer (Hard) flies your fleet. Watch the lock-on lines.' }, h('span', { html: icon('robot', 22) }), 'Auto'));
    }
    if (this.phase === 'battle' && mine && !dead && !this.spectate) {
      const charge = this.session?.chargeAtNext() ?? 0;
      // A pad's A arms the first weapon with something in reach: its badge goes there.
      const padA = this.weaponsReady(s).findIndex((w) => w.targets.length);
      this.weaponsReady(s).forEach((w, i) => {
        const label = weaponLabel(t, w.ws);
        const ctl = controlName(weaponField(t, w.ws, 'Control'));
        const shots = weaponField(t, w.ws, 'Shots') || 1;
        const dmg = weaponField(t, w.ws, 'Damage') || 0;
        const disabled = !w.targets.length;
        const active = this.targeting?.kind === 'attack' && this.targeting.ws === w.ws;
        actions.push(h('button', {
          class: 'btn action' + (active ? ' active' : '') + (charge < w.cost ? ' short' : ''), disabled,
          title: disabled ? 'No enemy in reach' : `${label} (${i + 1}): ${ctl} · reaches ${reachLabel(t, w.ws)} · ${shots > 1 ? shots + '×' : ''}${dmg} damage · needs ${w.cost} charge (firing empties it)`,
          'aria-label': `${label}: ${shots > 1 ? shots + ' shots of ' : ''}${dmg} damage, needs ${w.cost} charge`,
          onclick: () => this.beginAttack(w.ws),
        }, h('span', { class: 'a-top' }, inputMode() === 'pad' ? (i === padA ? face('a', null) : null) : i ? (inputMode() === 'keys' ? h('kbd', { 'aria-hidden': 'true' }, '2') : null) : face('a', '1'), h('span', { class: 'a-ico', html: icon('missile', 22) })),
          h('span', { class: 'a-name' }, label), h('span', { class: 'a-dmg' }, h('span', { html: icon('boom', 14) }), `${shots > 1 ? shots + '×' : ''}${dmg}`), h('span', { class: 'a-cost', title: 'Needs this much charge' }, `${w.cost}⚡`)));
      });
      if (t.canDefend) {
        const cost = t.defendChangeCharge;
        actions.push(h('button', { class: 'btn action secondary' + (this.targeting?.kind === 'guard' ? ' active' : ''), title: `Guard (G): block shots aimed at a friend, and fire back · needs ${cost} charge`, 'aria-label': `Guard a friend, needs ${cost} charge`, onclick: () => this.startGuardPick() },
          h('span', { class: 'a-top' }, face('x', 'G'), h('span', { class: 'a-ico', html: icon('shield', 22) })), h('span', { class: 'a-name' }, 'Guard'), h('span', { class: 'a-cost' }, `${cost}⚡`)));
        if (s.protectedStructId) actions.push(h('button', { class: 'btn action ghost', onclick: () => this.order({ '@type': '/structs.structs.MsgStructDefenseClear', defenderStructId: s.id }, cost, `${t.type} stops guarding`) },
          h('span', { class: 'a-name' }, 'Stand down'), h('span', { class: 'a-cost' }, `${cost}⚡`)));
      }
      if (t.movable) {
        // The Command Ship's drive: a card like the others, with a button per battleground.
        const cost = t.moveCharge;
        const drift = h('div', { class: 'drift' + (charge < cost ? ' short' : ''), title: t.drive_description || 'Move to another layer' },
          h('div', { class: 'row', style: 'gap:6px' }, face('y', 'D'), h('span', { class: 'a-ico', html: icon('rank', 18) }), h('span', { class: 'a-name' }, t.drive_label || 'Drift')),
          h('div', { class: 'row', style: 'gap:3px' }, AMBITS.filter((a) => (t.possibleAmbit & AMBIT_FLAG[a]) !== 0).map((a) => h('button', {
            class: 'btn ghost mini ambit-' + a + (a === s.ambit ? ' here' : ''), disabled: a === s.ambit, title: a === s.ambit ? 'It is here now' : `Drift to ${AMBIT_NAME[a]}`,
            'aria-label': `Drift to ${AMBIT_NAME[a]}`,
            onclick: () => { this.coachDone('drift'); this.order({ '@type': '/structs.structs.MsgStructMove', structId: s.id, locationType: 'fleet', ambit: a, slot: 0 }, cost, `Command Ship drifts to ${AMBIT_NAME[a]}`); },
          }, h('span', { html: icon(a, 18) })))),
          h('span', { class: 'a-cost' }, `${cost}⚡`));
        actions.push(drift);
      }
      if (t.unitDefenses === 'stealthMode') {
        const hidden = c.isHidden(s);
        const cost = t.stealthActivateCharge;
        actions.push(h('button', { class: 'btn action secondary', onclick: () => this.order(hidden ? { '@type': '/structs.structs.MsgStructStealthDeactivate', structId: s.id } : { '@type': '/structs.structs.MsgStructStealthActivate', structId: s.id }, cost, hidden ? 'Drop stealth' : 'Engage stealth') },
          h('kbd', null, 'S'), h('span', { class: 'a-name' }, hidden ? 'Uncloak' : 'Stealth'), h('span', { class: 'a-cost' }, `${cost}⚡`)));
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
    const cmdInReach = this.targeting?.kind === 'attack' && mine && (this.weaponsReady(s).find((w) => w.ws === (this.targeting as { ws: WeaponSystem }).ws)?.targets || []).some((x) => x.typeId === COMMAND_SHIP_ID && !c.isDestroyed(x));
    const hint = this.targeting ? h('div', { class: 'targeting-hint t-label' + (cmdInReach ? ' win' : ''), title: this.targeting.kind === 'attack' ? say({ keys: 'Click a red-ringed enemy to fire · Esc to cancel', pad: 'The d-pad picks a red-ringed enemy, A fires · B cancels', touch: 'Tap a red-ringed enemy, then Fire' }) : say({ keys: 'Click a friend to guard · Esc to cancel', pad: 'The d-pad picks a friend, A guards it · B cancels', touch: 'Tap a friend to guard it' }) },
      h('span', { html: icon(this.targeting.kind === 'attack' ? 'target' : 'shield', 16) }), this.targeting.kind === 'attack' ? (cmdInReach ? 'Command Ship in reach!' : 'Fire!') : 'Guard who?', face('b', 'Esc')) : null;
    const bar = h('div', { class: 'action-bar panel ' + side, 'data-ship': this.selected || '' }, card, h('div', { class: 'actions' }, actions), hint);
    this.root.appendChild(bar);
    this.pulseCoachTarget();
  }

  private draftUnit(structId: string) { const k = this.preview?.reverse[structId]; return k ? this.draft.find((u) => u.id === k) : undefined; }

  private beginAttack(ws: WeaponSystem) {
    this.releaseBarFocus();
    const s = this.selectedStruct();
    if (!s) return;
    if (this.targeting?.kind === 'attack' && this.targeting.ws === ws) { this.targeting = null; this.clearAim(); }
    else {
      const targets = this.weaponsReady(s).find((w) => w.ws === ws)?.targets || [];
      if (!targets.length) { audio.play('deny'); toast('Nothing in reach of that weapon', 'warn', 1600); return; }
      this.targeting = { kind: 'attack', ws };
      this.coachDone('arm');
      // Step 2 follows step 1 (done or dismissed), once.
      if (this.coachSeen('arm') && !this.spectate) this.coach('aim', 'Step 2 of 3 · Fire', { pad: 'D-pad picks, A fires', keys: 'Click a red ring (or Enter)', touch: 'Tap a red ring, then Fire' }, true);
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
    this.coachDone('guard');
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
  private clearCoach() { this.coachEl?.remove(); this.coachEl = null; this.coachKey = ''; this.coachStay = false; this.pulseCoachTarget(); }

  /** Show, don't tell: while a step is up, the thing it asks for pulses (the weapon to arm). */
  private pulseCoachTarget() {
    // The step's words follow the input in use (a pad picked up, a mouse moved).
    const line = this.coachSay && this.coachEl?.querySelector('.coach-text');
    if (line && this.coachSay) { const t = say(this.coachSay); if (line.textContent !== t) line.textContent = t; }
    this.root.querySelectorAll('.dc-pulse').forEach((n) => n.classList.remove('dc-pulse'));
    if (!this.coachEl?.isConnected) return;
    const want = this.coachKey === 'arm' ? '.action-bar .btn.action:not(:disabled)' : this.coachKey === 'guard' ? '.action-bar .btn.action.secondary' : this.coachKey === 'drift' ? '.action-bar .drift' : '';
    if (want) this.root.querySelector(want)?.classList.add('dc-pulse');
  }

  /** A tip, once ever. `stay`: a tutorial step that waits for the player (marked done when they do
   * it or press Got it); a plain tip is marked when shown and fades after 16 s. */
  private coachSay: Record<'pad' | 'keys' | 'touch', string> | null = null;
  private coach(key: string, title: string, text: string | Record<'pad' | 'keys' | 'touch', string>, stay = false) {
    if (this.coachSeen(key) || (this.coachKey === key && this.coachEl?.isConnected)) return;
    // A waiting step keeps the floor; a plain tip comes back another time.
    if (!stay && this.coachStay && this.coachEl?.isConnected) return;
    if (!stay) this.coachMark(key);
    this.coachEl?.remove();
    // A callout, not a paragraph: step dots, one word, one short line, and OK.
    const step = /^Step (\d) of (\d) · (.*)$/.exec(title);
    // (`wait`: a step that holds the clock, so it may sit over the HUD on a short screen.)
    const el = h('div', { class: 'coach panel neutral' + (stay ? ' wait' : '') },
      step ? h('div', { class: 'coach-dots', role: 'img', 'aria-label': `Step ${step[1]} of ${step[2]}` }, ...Array.from({ length: Number(step[2]) }, (_, i) => h('i', { class: i < Number(step[1]) ? 'on' : '' }))) : null,
      h('div', { class: 'coach-title' }, step ? step[3] : title),
      h('div', { class: 'coach-text' }, typeof text === 'string' ? text : say(text)),
      h('button', { class: 'btn solid coach-ok', onclick: () => { if (this.coachEl === el) this.coachDone(key); else el.remove(); } }, 'OK'));
    // Announced as it appears, for screen readers (the battle waits on it).
    el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    this.coachSay = typeof text === 'string' ? null : text;
    this.root.appendChild(el);
    this.coachEl = el;
    this.coachKey = key;
    this.coachStay = stay;
    this.pulseCoachTarget();
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
    if (!this.spectate && !this.paid.has(s)) { this.paid.add(s); record.gain(won ? 25 + 5 * stars : 5); }
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
        h('div', { class: 'db-call t-display ' + (won ? 'c-player' : draw ? 'c-neutral' : 'c-enemy'), title: draw ? (o.stalemate === 'moves' ? 'The flagships kept dancing' : 'No damage in 100 blocks') : line }, won ? 'Victory' : draw ? 'Stalemate' : 'Defeat'),
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
        this.gauntlet ? h('div', { class: 'row', style: 'margin-top:8px; justify-content:flex-end' },
          h('button', { class: 'btn ghost', onclick: () => { back.remove(); if (this.gauntlet?.over) this.gauntlet = null; this.navigate('/galaxy'); } }, 'Leave'),
          this.gauntlet.reinforce
            ? h('button', { class: 'btn solid', 'data-primary': '', onclick: () => { back.remove(); this.resumeGauntlet(); } }, `Continue to round ${this.gauntlet.round} ▸`)
            : h('button', { class: 'btn solid', 'data-primary': '', onclick: () => { back.remove(); this.startGauntlet(); } }, 'New gauntlet')) : null,
        h('div', { class: 'row wrap debrief-row', style: 'gap:6px; margin-top:4px' },
          h('button', { class: 'btn secondary', title: 'Watch this battle again', onclick: () => { back.remove(); const r = this.replayCode(o); if (r) void this.startReplay(r); } }, h('span', { html: icon('replay', 16) }), 'Replay'),
          h('button', { class: 'btn ghost', title: 'Copy a link that replays this exact battle', onclick: () => { const r = this.replayCode(o); if (!r) return; copyText(routeUrl('/sim/' + encodeReplay(r)), 'Replay link copied — anyone can watch this exact battle', 2600); } }, h('span', { html: icon('send', 16) }), 'Share'),
          h('button', { class: 'btn ghost', title: 'Challenge your guild: post these fleets to comms (you press send)', onclick: () => {
            void import('../../ui/comms/dock').then((m) => m.mountCommsDock().draft(`⚔ Battle challenge — ${o.winner === 'you' ? 'I won' : o.winner === 'cpu' ? 'I lost' : 'a draw'} in ${o.height} blocks. Beat it: ${routeUrl('/sim/' + this.battleCode())}`));
          } }, h('span', { html: icon('chat', 16) }), 'Challenge'),
          this.gauntlet || this.daily ? null : h('button', { class: 'btn ghost x-only', title: 'A link to fight these exact fleets', onclick: () => copyText(routeUrl('/sim/' + this.battleCode()), 'Battle code copied — share the exact fleets', 3200) }, 'Share fleets')),
        this.gauntlet ? null : h('div', { class: 'row debrief-row', style: 'margin-top:4px' },
          h('div', { class: 'grow' }),
          h('button', { class: 'btn ghost', title: 'Back to the galaxy', onclick: () => { back.remove(); this.navigate('/galaxy'); } }, 'Leave'),
          h('button', { class: 'btn secondary', 'data-back': '', title: this.daily ? 'Back to setup' : 'Change the fleets', onclick: () => { back.remove(); this.toSetup(false); if (inputMode() === 'pad') requestAnimationFrame(() => this.root.querySelector<HTMLElement>('.dc-start')?.focus({ focusVisible: true } as FocusOptions)); } }, face('b', 'Esc'), this.daily ? 'Setup' : 'Fleets'),
          h('button', { class: 'btn solid', 'data-primary': '', onclick: () => { back.remove(); this.toSetup(false); void this.engage(); } }, face('a', '⏎'), 'Again')),
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

  /** One clear next step after a plain training battle: a bigger fleet after a win, a tip after a loss. */
  private nextStep(won: boolean): HTMLElement | null {
    if (this.gauntlet || this.daily || this.scenario || this.spectate) return null;
    // Random fleets have no "bigger" step: a win there offers the hardest set fleet.
    const up: Record<Preset, Preset | null> = { easy: 'difficult', difficult: 'hard', hard: null, random: 'hard' };
    const next = won ? up[this.preset] : null;
    const go = (p: Preset) => () => { document.querySelector('.debrief-back')?.remove(); this.preset = p; this.difficulty = DIFFICULTY_FOR[p]; this.seed = Math.random().toString(36).slice(2, 8); this.toSetup(true); };
    if (won && next) return h('div', { class: 'next-step player', title: 'Ready for a bigger enemy fleet?' }, h('span', { class: 'c-enemy', html: icon('ship', 20) }),
      h('span', { class: 'grow ns-big' }, `${Number(PRESETS.find((p) => p.id === next)?.enemy ?? 0) + 1} · ${SIZE_WORD[next]}`), h('button', { class: 'btn solid mini', 'aria-label': `Next: a ${SIZE_WORD[next].toLowerCase()} fleet`, onclick: go(next) }, 'Go ▸'));
    if (won) return h('div', { class: 'next-step player', title: 'You beat the hardest fleet. Try today’s Daily Challenge, or the five-round Gauntlet.' }, h('span', { html: icon('daily', 20) }),
      h('span', { class: 'grow ns-big' }, 'Daily'), h('button', { class: 'btn solid mini', onclick: () => { document.querySelector('.debrief-back')?.remove(); this.startDaily(); } }, 'Go ▸'));
    return h('div', { class: 'next-step warn', title: 'Aim at the enemy Command Ship: when it falls, you win. And protect yours: select a ship, press G, then click your Command Ship.' },
      h('span', { class: 'c-warn', html: icon('star', 20) }), h('span', { class: 'grow' }, 'Hit their Command Ship. Guard yours (G).'),
      this.preset !== 'easy' ? h('button', { class: 'btn ghost mini', onclick: go('easy') }, 'Easy ▸') : null);
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
    if (!(await this.view.build(chain, YOU.id)) || this.replay !== replay || this.phase !== 'replay' || !this.root.isConnected) return;
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
      this.fingerNear = e.pointerType === 'mouse' ? 0 : 30;
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
    const { unit, ghost } = this.pick(touch ? this.fingerNear || 30 : 0);
    if (this.touchArmed && unit?.id !== this.touchArmed.target) this.disarmTouch();
    document.querySelectorAll('.slot-editor').forEach((n) => n.remove());
    if (this.phase === 'setup') {
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
    const next = order[i < 0 ? 0 : (i + dir + order.length) % order.length];
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
    if (this.targeting.kind === 'attack') this.attack(this.targeting.ws, target.id);
    else {
      const s = this.selectedStruct();
      if (s) this.order({ '@type': '/structs.structs.MsgStructDefenseSet', defenderStructId: s.id, protectedStructId: target.id }, TYPES_BY_ID[s.typeId].defendChangeCharge, `${TYPES_BY_ID[s.typeId].type} guards ${TYPES_BY_ID[target.typeId].type}`);
    }
    return true;
  }

  private handleKey(e: KeyboardEvent) {
    // Typing anywhere (chat, a search) is typing, not orders.
    const typing = e.target as HTMLElement | null;
    if (typing?.closest?.('input, textarea, select, [contenteditable]') || typing?.isContentEditable) return;
    // A window on top (a confirm, the debrief, the vault) has the keyboard: Tab, 1, G… are its own.
    if (document.querySelector('.modal-back')) return;
    // Keys in the top bar and its menus are theirs (a pad walking the hubs), not orders.
    if (typing?.closest?.('.topbar, .hub-menu, .more-menu')) return;
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
    const s = this.selectedStruct();
    if (e.key === 'Escape') { this.clearAim(); if (this.targeting) { this.targeting = null; this.refreshSelectionVisuals(); this.renderActionBar(); } else this.select(null); return; }
    // Setup, not aiming: the arrows walk the setup's buttons as a pad's d-pad does (the first press
    // lands on Start), so a keyboard reaches the sizes, the Daily and the Gauntlet too.
    if (this.phase === 'setup' && !this.targeting && e.key.startsWith('Arrow')) {
      const panel = this.root.querySelector<HTMLElement>('.setup-panel');
      if (panel) {
        e.preventDefault();
        if (!panel.contains(document.activeElement)) panel.querySelector<HTMLElement>('.dc-start')?.focus({ focusVisible: true } as FocusOptions);
        else moveFocus(e.key as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight');
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
      if (!s || s.owner !== YOU.id || this.chain?.isDestroyed(s)) { this.selectFirst(); return; }
      // Nothing armed: Enter arms the first weapon that has something in reach, as 1 does.
      const ws = this.weaponsReady(s).find((w) => w.targets.length)?.ws;
      if (ws) { this.beginAttack(ws); if (this.targeting) this.cycleAim(0); return; }
      // This ship has nothing in reach: Enter hands over to the next ship of yours that has, or says
      // how to close the distance, rather than doing nothing.
      const c = this.chain!;
      const next = Object.values(c.structs).find((x) => x.owner === YOU.id && x.id !== s.id && !c.isDestroyed(x) && this.weaponsReady(x).some((w) => w.targets.length));
      if (next) {
        this.select(next.id);
        const ws2 = this.weaponsReady(next).find((w) => w.targets.length)?.ws;
        if (ws2) { this.beginAttack(ws2); if (this.targeting) this.cycleAim(0); }
        return;
      }
      audio.play('deny');
      toast(say({ keys: 'Nothing in reach · D drifts your Command Ship', pad: 'Nothing in reach · Y drifts your Command Ship', touch: 'Nothing in reach · drift your Command Ship' }), 'warn', 2400);
      return;
    }
    if (e.key === ' ' && this.phase === 'battle') { e.preventDefault(); this.togglePause(); return; }
    if ((e.key === 'z' || e.key === 'Z') && !e.metaKey && !e.ctrlKey) { this.zoom.reset(); return; }
    if (e.key === 'Enter' && this.phase === 'setup' && !onControl) {
      // Picking a guard: Enter (A) takes the aimed friend. Otherwise it starts the battle.
      if (this.targeting) { if (!this.commitAim()) this.cycleAim(0); return; }
      void this.engage(); return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const c = this.activeChain();
      if (!c) return;
      const mine = Object.values(c.structs).filter((x) => x.owner === YOU.id && !c.isDestroyed(x)).sort((a, b) => (a.typeId === COMMAND_SHIP_ID ? -1 : b.typeId === COMMAND_SHIP_ID ? 1 : AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit) || a.slot - b.slot));
      if (!mine.length) return;
      const i = mine.findIndex((x) => x.id === this.selected);
      this.select(mine[(i + (e.shiftKey ? -1 : 1) + mine.length) % mine.length].id);
      audio.play('hover');
      return;
    }
    if (!s || s.owner !== YOU.id) return;
    if (this.phase === 'setup' && (e.key === 'g' || e.key === 'G')) { this.startGuardPick(); if (this.targeting) this.cycleAim(0); return; }
    if (this.phase !== 'battle') return;
    // A destroyed hull can't act (and a new order would replace a valid queued one).
    if (this.chain?.isDestroyed(s)) return;
    const t = TYPES_BY_ID[s.typeId];
    if (e.key === '1' || e.key === '2') {
      const ws = this.weaponsReady(s)[Number(e.key) - 1]?.ws;
      if (ws) { this.beginAttack(ws); if (this.targeting) this.cycleAim(0); }
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
    if (this.els.pause) { this.els.pause.textContent = this.paused ? '▶' : '❚❚'; this.els.pause.setAttribute('aria-label', this.paused ? 'Resume' : 'Pause'); }
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
    const { unit } = this.pick(this.fingerNear);
    // A pinned touch forecast belongs to its target: a drag or a pointer onto anything else withdraws it.
    if (this.touchArmed && unit?.id !== this.touchArmed.target) this.disarmTouch();
    const id = unit && !unit.destroyed ? unit.id : null;
    if (id !== this.hovered) {
      if (this.hovered) { const u = this.view.units.get(this.hovered); if (u) u.hover = 0; }
      this.hovered = id;
      if (unit) { unit.hover = 1; audio.play('hover'); }
      this.engine.canvas.style.cursor = unit ? (this.targeting && !unit.targetable ? 'not-allowed' : 'pointer') : 'default';
    }
    if (!unit || unit.destroyed) { hideTooltip(); return; }
    this.tipFor(unit, this.pointerPx);
  }

  /** The struct card (and, while targeting, the forecast) for one unit, shown at `at`. */
  private tipFor(unit: UnitView, at: { x: number; y: number }) {
    const c = this.activeChain();
    const s = c?.structs[unit.id];
    if (!c || !s) { hideTooltip(); return; }
    const t = TYPES_BY_ID[s.typeId];
    const lines: (HTMLElement | null)[] = [
      h('div', { class: 'spread' }, h('span', { class: 't-label ' + (unit.side === 'player' ? 'c-player' : 'c-enemy') }, t.type), h('span', { class: 'chip ambit-' + s.ambit }, AMBIT_NAME[s.ambit])),
      h('div', { class: 'row', style: 'margin:4px 0' }, h('div', { class: 'pips' }, Array.from({ length: t.maxHealth }, (_, i) => h('i', { class: i < s.health ? '' : 'lost' }))), h('span', { class: 't-tiny c-hint' }, DEFENSE_NAME[t.unitDefenses] || '')),
    ];
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
    if (this.touchArmed?.target === unit.id) lines.push(h('button', { class: 'btn solid tip-fire', type: 'button', onpointerup: (e: Event) => {
      e.stopPropagation();
      const a = this.touchArmed;
      if (!a || !this.armedStands() || this.targeting?.kind !== 'attack') return;
      const ws = this.targeting.ws;
      this.disarmTouch();
      this.attack(ws, a.target);
    } }, h('span', { html: icon('target', 16) }), 'Fire'));
    showTooltip(at.x, at.y, h('div', null, lines), unit.side === 'player' ? 'player' : 'enemy');
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
    // A held touch forecast lapses once its weapon, shooter or target no longer stands.
    if (this.touchArmed && !this.armedStands()) this.disarmTouch();

    // Ghost frames pulse and scan.
    GHOST.mat.uniforms.uTime.value = t;

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
    uniforms: { uTime: { value: 0 }, uSeed: { value: 0 }, uColor: { value: new THREE.Color(0x43cdb6) } },
    vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vW; void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; varying vec2 vUv; varying vec3 vW;
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
        // Plus sigil in the middle.
        vec2 c = abs(p - vec2(1.35, 1.1));
        float plus = (box(c, vec2(0.0), vec2(0.2, 0.03)) + box(c, vec2(0.0), vec2(0.03, 0.2))) * 0.8;
        // Deck pad: a soft ellipse of light along the base.
        vec2 e = (vUv - vec2(0.5, 0.0)) * vec2(1.0, 4.2);
        float pad = exp(-dot(e, e) * 5.0) * 0.4;
        float pulse = 0.75 + 0.25 * sin(uTime * 3.0 + vW.x * 0.6);
        float a = (br * 0.95 + hair + fill + scan + plus + pad) * pulse;
        gl_FragColor = vec4(uColor * a * 1.3, a);
      }
    `,
  });
  const pick = new THREE.BoxGeometry(2.8, 2.2, 1.4);
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });
  return { plate, mat, pick, pickMat };
})();
