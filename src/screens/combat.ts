/* Combat theatre: real attacks from the chain, staged again in 3D.
 * Every MsgStructAttack carries structsd's full EventAttack (attacker, shot
 * rows, blocks, evasions, counters, health before/after), so one record is
 * enough to put the structs back in their battlegrounds and replay the volley
 * through the simulator's choreography. The archive pages back through every
 * attack the testnet has seen; new ones join the top as blocks land. */
import * as THREE from 'three';
import type { Engine, Screen } from '../core/engine';
import { banner, copyText, h, hideTooltip, showTooltip, toast } from '../core/dom';
import { audio } from '../core/audio';
import { ago, blocksToDuration, clamp, damp, formatInt, hash32, humanize } from '../core/util';
import { store } from '../chain/store';
import { commander } from '../chain/commander';
import { attacksBetween, attacksInTx, inChainOrder, latestAttacks, recentAttacks, summarize, type CombatRecord, type RawAttack } from '../chain/combat';
import { battlefieldAt, type Battlefield } from '../chain/history';
import { currentRoute, replaceRoute, routeUrl } from '../core/nav';
import { type Ambit, AMBITS, AMBIT_NAME, COMMAND_SHIP_ID, TYPES_BY_ID, weaponLabel, type WeaponSystem } from '../data/catalogue';
import { encodeBattle, type Side, type Unit, unitId, validate } from '../sim/fleets';
import { createNebulaSky, createStarfield, tickSpace } from '../gfx/space';
import { spriteDataUrl } from '../gfx/pixelModel';
import { BattleView, UnitView, type SideV } from './battle/view';
import { addBattleLights, WORLD_PALETTES } from './battle/env';
import { BoardZoom, bindPinch, bindTap } from './battle/zoom';
import type { AttackDetail, SimStruct } from '../sim/chain';
import { icon } from '../ui/icons';
import '../styles/dc-watch.css';

const PAGE = 20;

/* The theatre speaks in pictures: a sprite for every struct, an icon for every number, and the
 * result as a big call ("-2", BLOCKED, DESTROYED). The sentence behind each one is its title. */
/** An icon as a node (its meaning goes in the parent's title). */
const ico = (name: string, size = 16, cls = '') => h('span', { class: 'dw-ico' + (cls ? ' ' + cls : ''), html: icon(name, size) });
/** A struct type's sprite, filled in when it has been drawn. */
function sprite(typeId: string | number, cls = 'cr-thumb', title?: string) {
  const img = h('img', { class: 'cr-sprite', alt: '' }) as HTMLImageElement;
  void spriteDataUrl(Number(typeId)).then((u) => { img.src = u; }).catch(() => {});
  return h('span', { class: cls, title }, img);
}
/** A result call: DESTROYED, BLOCKED, EVADED. */
const call = (word: string, tone: 'kill' | 'block' | 'miss', title?: string) => h('span', { class: 'dw-call ' + tone, title }, word);
/** A number that changed something ("-2"), toned like its result. */
const delta = (n: number | string, tone: 'hit' | 'kill' | 'block' | 'heal' = 'hit', title?: string) => h('b', { class: 'dw-n ' + tone, title }, String(n));
/** Health before → after (of max), behind a health icon. */
const hpOf = (before: string | number, after: string | number, max?: string | number) =>
  h('span', { class: 'dw-hp', title: `Health ${before} → ${after}${max ? ' of ' + max : ''}` }, ico('health', 13), `${before}→${after}`, max ? h('span', { class: 'c-hint' }, '/' + max) : null);
/** What one attack did, counted. */
function tally(a: RawAttack) {
  const shots = a.eventAttackShotDetail || [];
  let dmg = 0, kills = 0, evaded = 0, blocked = 0;
  for (const s of shots) { dmg += Number(s.damage || 0); if (s.targetDestroyed) kills++; if (s.blockerDestroyed) kills++; if (s.evaded) evaded++; if (s.blocked) blocked++; }
  const lost = a.attackerHealthAfter === '0' || !!a.recoilDamageDestroyedAttacker || !!a.planetaryDefenseCannonDamageDestroyedAttacker;
  return { shots: shots.length, dmg, kills, evaded, blocked, lost };
}

/** The same attack, whichever fetch the record object came from (a tx may hold several attacks). */
const sameRec = (a: CombatRecord | null, b: CombatRecord | null) => !!a && !!b && a.hash === b.hash && a.attack.attackerStructId === b.attack.attackerStructId;

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

/* A staged attack packs each side's pieces toward the divider, row by row:
 * only the battleground (row) carries meaning here, so `slot` is the piece's
 * place in its row — fleet hulls by chain slot first, then planetary structs,
 * then the Command Ship. Narration and tooltips keep the real slots. */
/** Attacks between the same two commanders less than this many blocks apart are one engagement. */
const ENGAGEMENT_GAP = 400;
/** The two commanders of an attack, in a fixed order. */
const pairOf = (r: CombatRecord) => [r.attack.attackerPlayerId, r.attack.eventAttackShotDetail?.[0]?.targetPlayerId || ''].sort().join('|');

function xFor(side: SideV, slot: number, command: boolean) {
  const x = 3.2 + slot * 3.6 + (command ? 0.6 : 0);
  return side === 'player' ? -x : x;
}

/** `status` is the chain's struct status bits (built, online, hidden…), from the board snapshot when there is one. */
interface Piece { id: string; typeId: number; owner: string; side: SideV; ambit: Ambit; slot: number; column: 'fleet' | 'planet'; health: number; maxHealth: number; locationId: string; chainSlot: number; status: number }

export class CombatScreen implements Screen {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.1, 2000);
  readonly bloom = { strength: 0.75, radius: 0.5, threshold: 0.5 };
  private sky: THREE.Object3D[];
  private view: BattleView | null = null;
  /** The field the current view shows (its planet) and how wide its set was built: a step on the same field keeps it. */
  private viewKey = '';
  private viewHalfWidth = 0;
  /** The two commanders and the last block of the fight on the board: the next volley between the
   * same pair soon after is the same battle, whichever side fires it. */
  private viewPair = '';
  private viewHeight = 0;
  /** The staged pieces belong to the attack on screen (false while its board is being read). */
  private boardReady = false;
  private root!: HTMLElement;
  private layer!: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private list: CombatRecord[] = [];
  private total = 0;
  private page = 0;
  private current: CombatRecord | null = null;
  /** Bumped per staged attack (stale stagings bail out). */
  private token = 0;
  /** Bumped per visit (stale archive reads bail out). */
  private visit = 0;
  private unsub: (() => void)[] = [];
  private timers = new Set<number>();
  private pointer = new THREE.Vector2(9, 9);
  private pointerPx = { x: 0, y: 0 };
  private raycaster = new THREE.Raycaster();
  private hovered: string | null = null;
  private zoom = new BoardZoom(0.42, 26, 12);
  private fitDist = 50;
  private centerX = 0;
  private look = new THREE.Vector3(0, -0.4, 0);
  private zoomLook = new THREE.Vector3();
  private focus = new THREE.Vector3();
  private focusW = 0;
  /** Transactions being fetched for the live feed (each one once). */
  private inflight = new Set<string>();
  /** A page read that failed, offered again by the list's button. */
  /** What Retry re-runs after a failed read (a page, or a whole link that never loaded). */
  private retry: (() => void) | null = null;
  private awaitingFilter = false;
  /** Only one commander's attacks (their primary address), or everyone's. */
  private filter: { playerId: string; address: string } | null = null;
  /** Autoplay walks back through the archive, one attack after another. */
  private autoplay = false;
  private playing = false;
  private pieces: Piece[] = [];
  /** The player whose hulls are drawn teal in the staged fight. */
  private teal = '';
  private punch = 0;
  /** What is on the board: one attack or a whole engagement. */
  private staged: CombatRecord[] = [];
  /** On a short screen (the TV's 480 px) the list and the narration fold to one-line strips so the
   * battle keeps the middle of the screen; a chip on each unfolds it over the stage. */
  private listOpen = false;
  private detailOpen = false;

  constructor(private engine: Engine, private navigate: (h: string) => void) {
    this.sky = [createNebulaSky({ seed: 41.7, intensity: 0.8 }), createStarfield(5000, 800, 71)];
    for (const s of this.sky) this.scene.add(s);
    addBattleLights(this.scene);
    this.camera.position.set(0, 0.6, 50);
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */
  enter(params: Record<string, string>) {
    // Each visit starts from the newest attacks (the archive grows while you are away).
    this.list = []; this.total = 0; this.page = 0; this.current = null; this.pieces = []; this.playing = false;
    this.filter = null; this.staged = []; this.autoplay = false; this.inflight.clear(); this.retry = null;
    this.listOpen = false; this.detailOpen = false;
    const visit = ++this.visit;
    // A commander's record waits for its filter before taking live attacks.
    this.awaitingFilter = !!params.by;
    audio.setIntensity(0.7);
    this.root = h('div', { class: 'screen combat' });
    this.layer = h('div', { class: 'tags-layer' });
    this.root.appendChild(this.layer);
    document.getElementById('ui')!.appendChild(this.root);
    this.buildUi();
    this.bindInput();
    this.zoom.reset(true);
    this.fit();
    void store.loadCore().catch(() => { /* names fall back to ids; main announces the outage */ });
    // New attacks join the top of the archive as their blocks land.
    this.unsub.push(store.onFeed((item) => {
      // Live attacks only (backfilled history is already in the archive), once per transaction.
      if (item.kind !== 'attack' || item.replay || !item.hash || this.awaitingFilter) return;
      if (this.filter && item.playerId !== this.filter.playerId) return;
      const hash = item.hash;
      if (this.inflight.has(hash) || this.list.some((r) => r.hash === hash)) return;
      this.inflight.add(hash);
      void attacksInTx(hash).then((recs) => {
        if (visit !== this.visit) return;
        const fresh = recs.filter((r) => !this.list.some((x) => sameRec(x, r)));
        if (!fresh.length) return;
        this.list.unshift(...fresh);
        this.total += 1;
        this.renderList();
        // Re-checked when it fires: something may have started playing in the meantime.
        if (this.autoplay && !this.playing) this.later(400, () => { if (this.autoplay && !this.playing) void this.select(fresh[0]); });
      }).catch(() => {}).finally(() => this.inflight.delete(hash));
    }));
    this.unsub.push(store.onCore(() => { this.renderList(); if (this.current) this.renderDetail(this.current); }));
    // Reads happen in the background so the screen appears at once.
    void this.start(params, visit);
  }

  private async start(params: Record<string, string>, visit: number) {
    if (params.by && this.awaitingFilter) {
      const rosterRead = await store.loadCore().then(() => true, () => false);
      if (visit !== this.visit) return;
      // An unreachable roster is not an unknown commander: keep the record pending and offer Retry.
      if (!rosterRead) { this.offerRetry(() => void this.start(params, visit)); return; }
      const p = store.players.get(params.by);
      if (p?.primaryAddress) {
        this.filter = { playerId: p.id, address: p.primaryAddress };
        this.list = []; this.page = 0; this.total = 0;
        this.buildUi(true);
      } else toast('No such commander: ' + params.by, 'warn', 2400);
      this.awaitingFilter = false;
    }
    let linked: CombatRecord | null = null;
    let linkUnreachable = false;
    if (params.hash) {
      try {
        const recs = await attacksInTx(params.hash);
        if (visit !== this.visit) return;
        if (!recs.length) throw new Error('That transaction holds no attack');
        linked = recs[0];
        // Show the linked attack at once; an engagement link upgrades to the whole fight below.
        void this.select(linked);
      } catch (e) {
        // A bad link says why; an unreachable testnet is already said by the archive and the top bar.
        linkUnreachable = e instanceof TypeError || (e as Error).name === 'AbortError';
        if (visit === this.visit && !linkUnreachable) toast(String((e as Error).message || e), 'warn', 3200);
      }
    }
    if (visit !== this.visit) return;
    // A re-run (the link's Retry) keeps the pages already read.
    const listed = this.page > 0 || await this.loadPage(1, !params.hash);
    if (visit !== this.visit) return;
    // Offline from the start: Retry re-reads everything the link asked for, not just the list.
    if (!listed && params.hash && !linked) { this.offerRetry(() => void this.start(params, visit)); return; }
    // The archive answered but the linked attack didn't: say so, with a way to try it again.
    if (linkUnreachable) toast('That attack could not be read from the testnet', 'warn', 8000, { label: 'Retry', run: () => void this.start(params, visit) });
    if (!linked || !params.engage) return;
    // Every attack (both commanders) within a few thousand blocks: the archive page alone may
    // miss early volleys or the other side's return fire.
    const target = linked;
    // Before the target (where early volleys are) and after it, budgeted separately; each window
    // is read from the end nearest the target, so a busy stretch drops the far blocks, not the fight.
    const [before, after] = await Promise.all([
      attacksBetween(target.height - 3000, target.height, 200, 'desc').catch(() => [] as CombatRecord[]),
      attacksBetween(target.height + 1, target.height + 3000, 100, 'asc').catch(() => [] as CombatRecord[]),
    ]);
    const pool = [...after, ...before];
    // Only if the user hasn't picked something else while the window was read.
    if (visit !== this.visit || (this.current && !sameRec(this.current, target))) return;
    const merged = [...this.list];
    for (const r of [target, ...pool]) if (!merged.some((x) => sameRec(x, r))) merged.push(r);
    const at = merged.find((r) => sameRec(r, target))!;
    // A lone attack is already playing: restaging it would restart the same replay.
    const engagement = this.engagementOf(at, merged);
    // As a pick: an engagement on the board keeps its /e link even if a replay rewrote the URL meanwhile.
    if (engagement.length > 1) void this.stage(at, engagement, true);
  }

  exit() {
    audio.setIntensity(0.3);
    this.token++;
    this.visit++;
    this.unsub.forEach((f) => f());
    this.unsub = [];
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    if (this.view) { this.scene.remove(this.view.group); this.view.dispose(); this.view = null; }
    hideTooltip();
    this.root.remove();
    this.engine.canvas.style.cursor = 'default';
    this.playing = false;
  }

  resize() { this.view?.fx.setScale(window.innerHeight, this.camera.fov); this.fit(); }

  private later(ms: number, f: () => void) {
    const t = window.setTimeout(() => { this.timers.delete(t); f(); }, ms);
    this.timers.add(t);
  }

  /* ── Archive ──────────────────────────────────────────────────────────── */
  private async loadPage(page: number, selectFirst: boolean): Promise<boolean> {
    const visit = this.visit;
    this.els.more.textContent = 'Loading…';
    (this.els.more as HTMLButtonElement).disabled = true;
    try {
      const { records, total } = await recentAttacks(PAGE, page, this.filter?.address);
      if (visit !== this.visit) return false;
      for (const r of records) if (!this.list.some((x) => sameRec(x, r))) this.list.push(r);
      this.total = Math.max(total, this.txCount());
      this.page = page;
      this.retry = null;
      this.renderList();
      if (selectFirst && !this.current && this.list.length) void this.select(this.list[0]);
      if (visit === this.visit) {
        // The LCD counts transactions; a transaction can hold several attacks.
        const more = this.txCount() < this.total;
        this.els.more.textContent = more ? 'Older ▾' : this.list.length ? '— End —' : 'None';
        this.els.more.title = more ? 'Older attacks' : this.list.length ? 'The beginning of the archive' : 'No attacks found';
        (this.els.more as HTMLButtonElement).disabled = !more;
      }
    } catch {
      if (visit !== this.visit) return false;
      toast('Could not read the combat archive', 'warn');
      // Offer the same page again rather than claiming the archive is empty.
      this.offerRetry(() => void this.loadPage(page, selectFirst));
      return false;
    }
    return true;
  }

  private offerRetry(run: () => void) {
    this.retry = run;
    this.els.more.textContent = 'Retry ↻';
    this.els.more.title = 'Read the archive again';
    (this.els.more as HTMLButtonElement).disabled = false;
    this.renderList();
  }

  private txCount() { return new Set(this.list.map((r) => r.hash)).size; }

  /** The busiest attackers in the newest 100 attacks, each a link to their record. */
  private mostActive() {
    const el = h('div', { class: 'most-active t-tiny' });
    void latestAttacks().then((recs) => {
      const by = new Map<string, { n: number; kills: number }>();
      for (const r of recs) {
        const e = by.get(r.attack.attackerPlayerId) || { n: 0, kills: 0 };
        e.n++;
        e.kills += (r.attack.eventAttackShotDetail || []).filter((x) => x.targetDestroyed).length;
        by.set(r.attack.attackerPlayerId, e);
      }
      const top = [...by.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 4);
      if (!top.length || !el.isConnected) return;
      // The busiest attackers as name chips, each with its count; the star says "most active".
      el.replaceChildren(h('span', { class: 'ma-ico', title: 'Most active in the last 100 attacks', role: 'img', 'aria-label': 'Most active', html: icon('star', 16) }),
        ...top.map(([pid, e]) => h('button', { class: 'ma-chip', title: `${e.n} of the last 100 attacks · ${e.kills} kills — open their record`, onclick: () => { audio.play('select'); this.navigate('/combat/by/' + pid); } },
          h('span', { class: 'ma-name' }, store.playerName(pid)), h('b', null, String(e.n)))));
    }).catch(() => {});
    return el;
  }

  private buildUi(rebuild = false) {
    if (rebuild) this.root.querySelectorAll('.combat-list, .combat-detail, .combat-bar').forEach((n) => n.remove());
    const rows = h('div', { class: 'feed scroll combat-rows' });
    const more = h('button', { class: 'btn ghost mini combat-more', disabled: true, onclick: () => {
      const r = this.retry;
      this.retry = null;
      // Busy until the re-run settles, so a second press can't start an unfiltered read meanwhile.
      more.textContent = 'Loading…';
      more.disabled = true;
      if (r) r();
      else if (this.page > 0 && !this.awaitingFilter) void this.loadPage(this.page + 1, false);
    } }, 'Loading…');
    const count = h('span', { class: 'chip dw-count' }, '…');
    const f = this.filter;
    // What the list is lives in the head's title; Expert mode keeps the technical line.
    const listPanel = h('div', { class: 'combat-list panel' + (this.listOpen ? ' fold-open' : '') },
      h('div', { class: 'panel-head', title: f ? 'Every attack this commander made, newest first. Pick one to watch it.' : 'Real fights between real players, newest first. Pick one to watch it, shot by shot.' },
        h('span', { class: 'dw-head' }, ico(f ? 'record' : 'replay', 20), h('span', { class: 't-label' }, f ? 'Record' : 'Replays')), count, this.foldBtn('list')),
      h('div', { class: 'panel-body col', style: 'gap:6px; padding-bottom:6px' },
        f ? h('div', { class: 'dw-filter' }, ico('record', 16, 'c-player'), h('span', { class: 'grow dw-name c-player' }, store.playerName(f.playerId)),
          h('button', { class: 'btn ghost mini', title: 'Show every commander’s attacks', onclick: () => { audio.play('select'); this.navigate('/combat'); } }, 'All ×')) : null,
        h('div', { class: 't-tiny c-hint x-only' }, f ? 'Every attack this commander has signed, newest first, staged from its EventAttack.' : 'Every attack on the testnet, newest first. Each one is staged from its EventAttack and replayed shot by shot.'),
        f ? null : this.mostActive()),
      rows, h('div', { class: 'combat-more-row' }, more));
    const detail = h('div', { class: 'combat-detail panel' });
    const bar = h('div', { class: 'combat-bar panel' },
      h('button', { class: 'btn ghost dw-step', title: 'Newer attack (↑)', 'aria-label': 'Newer attack', onclick: () => this.step(-1) }, ico('back', 20)),
      h('button', { class: 'btn solid', title: 'Replay (R)', onclick: () => { if (this.current) void this.stage(this.current, this.staged.length ? this.staged : [this.current], true); } }, ico('replay', 18), 'Replay'),
      h('button', { class: 'btn ghost dw-step', title: 'Older attack (↓)', 'aria-label': 'Older attack', onclick: () => this.step(1) }, ico('back', 20, 'dw-flip')),
      h('button', { class: 'btn ghost combat-auto', title: 'Autoplay: the archive plays back one attack after another', 'aria-pressed': 'false', onclick: (e: Event) => {
        this.autoplay = !this.autoplay;
        (e.currentTarget as HTMLElement).classList.toggle('active', this.autoplay);
        // The lit button says it is on; the label stays short enough for a phone's bar.
        (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(this.autoplay));
        audio.play('select');
        if (this.autoplay && !this.playing) this.step(1);
      } }, ico('play', 14), 'Auto'));
    const note = h('div', { class: 'combat-note t-tiny', role: 'status' });
    this.root.append(listPanel, detail, bar, note);
    this.els = { rows, more, count, detail, list: listPanel, bar, note };
    // The empty state and the idle transport from the first frame, not only once a read settles.
    this.renderList();
  }

  private renderList() {
    const rows = this.els.rows;
    if (!rows) return;
    // The count is a number behind the battle icon; what it counts is its title.
    this.els.count.replaceChildren(...(this.total ? [ico('target', 13), formatInt(this.total)] : ['…']));
    this.els.count.title = this.total ? `${formatInt(this.total)} attacks on chain` : '';
    // Nothing loaded and nothing staged: the transport has nothing to drive.
    const idle = !this.list.length && !this.current;
    this.els.bar?.querySelectorAll('button').forEach((b) => { b.disabled = idle; });
    if (!this.list.length) {
      rows.replaceChildren(h('div', { class: 't-tiny c-hint combat-empty', title: this.retry ? 'The archive could not be read from the testnet. Try again below.' : '' },
        this.retry ? 'Archive could not be read' : this.page ? 'No attacks found' : 'Loading…'));
      return;
    }
    // Engagement sizes, computed once per pair of commanders.
    const engaged = new Map<CombatRecord, number>();
    const groupOf = new Map<CombatRecord, CombatRecord[]>();
    for (const r of this.list) if (!engaged.has(r)) { const e = this.engagementOf(r); for (const x of e) { engaged.set(x, e.length > 1 ? e.length : 0); groupOf.set(x, e); } }
    // One row per fight: a multi-attack engagement shows its newest attack (with its ×N), and opens
    // to every attack when one of them is on the board. Stepping still walks every attack.
    const opened = new Set<CombatRecord[]>(), shownGroup = new Set<CombatRecord[]>();
    for (const r of this.list) { const g = groupOf.get(r); if (g && this.current && sameRec(r, this.current)) opened.add(g); }
    const shown = this.list.filter((r) => {
      const g = groupOf.get(r);
      if (!g || g.length < 2 || opened.has(g)) return true;
      if (shownGroup.has(g)) return false;
      shownGroup.add(g);
      return true;
    });
    // A row: when, the attacker's sprite, who hit whom, and what it did as numbers and icons.
    rows.replaceChildren(...shown.map((r) => {
      const s = summarize(r.attack, (id) => store.playerName(id));
      const n = tally(r.attack);
      const at = Date.parse(r.time);
      const eng = engaged.get(r);
      const target = r.attack.eventAttackShotDetail?.[0]?.targetPlayerId;
      return h('button', { class: 'combat-row' + (sameRec(r, this.current) ? ' active' : '') + ' ' + s.tone, title: `${s.title} — ${s.result}`, onclick: () => { audio.play('select'); void this.select(r, true); } },
        h('span', { class: 'when num', title: `block #${formatInt(r.height)}${Number.isFinite(at) ? ' · ' + new Date(at).toLocaleString() : ''}` }, Number.isFinite(at) ? ago(Date.now() - at) : '#' + r.height),
        sprite(r.attack.attackerStructTypeId),
        h('span', { class: 'what' },
          h('span', { class: 'cr-title' }, h('span', { class: 'cr-who' }, store.playerName(r.attack.attackerPlayerId)), h('span', { class: 'cr-to' }, '▸'), target ? store.playerName(target) : '—'),
          h('span', { class: 'cr-result' },
            n.dmg ? delta('-' + n.dmg, n.kills ? 'kill' : 'hit') : null,
            n.kills ? h('span', { class: 'cr-ico kill', title: 'Destroyed', html: icon('boom', 14) + (n.kills > 1 ? `<b>×${n.kills}</b>` : '') }) : null,
            n.blocked ? h('span', { class: 'cr-ico block', title: 'Blocked by a guard', html: icon('shield', 13) }) : null,
            !n.dmg && n.evaded ? h('span', { class: 'cr-ico miss', title: 'Every shot was evaded' }, 'EVADED') : null,
            n.lost ? h('span', { class: 'cr-ico kill', title: 'The attacker was lost', html: icon('ship', 12) + '<b>✕</b>' }) : null,
            eng ? h('span', { class: 'cr-eng', title: `One of ${eng} attacks in the same fight between these two commanders (press E, or the ▶ fight button, to see it all)` }, ico('target', 12), `×${eng}`) : null)));
    }));
    rows.querySelector('.combat-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  private step(dir: number) {
    const cur = this.current;
    const at = () => (cur ? this.list.findIndex((r) => sameRec(r, cur)) : -1);
    const i = at();
    // A deep-linked attack not in the list yet: "older" starts from the newest.
    const next = i < 0 ? (dir > 0 ? this.list[0] : undefined) : this.list[i + dir];
    if (next) { audio.play('select'); void this.select(next, true); return; }
    if (dir > 0 && this.txCount() < this.total) {
      const visit = this.visit;
      void this.loadPage(this.page + 1, false).then((ok) => {
        // Only if nothing changed meanwhile (another pick, leaving the screen).
        if (visit !== this.visit || !sameRec(this.current, cur)) return;
        if (!ok) { this.stopAutoplay('Autoplay paused: the archive could not be read'); return; }
        // Re-find the current attack: live arrivals may have shifted the list.
        const n = this.list[at() + 1];
        if (n && !sameRec(n, cur)) void this.select(n, true);
        else this.stopAutoplay('Nothing older to show');
      });
    } else this.stopAutoplay('End of the archive');
  }

  private stopAutoplay(msg: string) {
    if (!this.autoplay) return;
    this.autoplay = false;
    const b = this.els.bar.querySelector('.combat-auto');
    if (b) { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); }
    toast(msg, '', 1600);
  }

  /** The board's caption: an icon and a count, the sentence in its title (Expert mode spells it out). */
  private setNote(ico_: string, n: string, plain: string, expert = plain, partial = false) {
    this.els.note.replaceChildren(
      // The live region reads the sentence (a hidden span: aria-label on a plain span is not read).
      h('span', { class: 'dw-note s-only', title: plain }, h('span', { 'aria-hidden': 'true', style: 'display:contents' }, ico(ico_, 15), n, partial ? h('b', { class: 'c-warn' }, '!') : null), h('span', { class: 'dw-sr' }, plain)),
      h('span', { class: 'x-only' }, expert));
  }

  /* ── Staging ──────────────────────────────────────────────────────────── */
  /** Whose hulls are teal ("yours"): the commander whose record this is, or the pinned one,
   * if involved; otherwise whoever the first attack was aimed at. Sides follow owners, so
   * in an engagement both commanders keep their colour whoever fires. */
  private tealOf(attacks: RawAttack[]): string {
    const me = this.filter?.playerId || commander.id;
    const involved = new Set<string>();
    for (const a of attacks) { involved.add(a.attackerPlayerId); for (const s of a.eventAttackShotDetail || []) involved.add(s.targetPlayerId); }
    if (me && involved.has(me)) return me;
    // Whoever was teal stays teal while they are in the fight: the board never flips just because
    // the other side fired this time.
    if (this.teal && involved.has(this.teal)) return this.teal;
    return attacks[0]?.eventAttackShotDetail?.[0]?.targetPlayerId || '';
  }

  /** Every struct the attacks touch, at the health it had when it first appears. */
  private piecesOf(attacks: RawAttack[], teal: string): Piece[] {
    const out = new Map<string, Piece>();
    const ambitOf = (x: string): Ambit => (AMBITS.includes(x as Ambit) ? x as Ambit : 'land');
    const add = (p: Omit<Piece, 'chainSlot' | 'side' | 'status' | 'maxHealth'>, max?: number) => { if (!out.has(p.id) && TYPES_BY_ID[p.typeId]) out.set(p.id, { ...p, side: p.owner === teal ? 'player' : 'enemy', chainSlot: p.slot, status: 7, maxHealth: max || TYPES_BY_ID[p.typeId].maxHealth }); };
    for (const a of attacks) {
    add({ id: a.attackerStructId, typeId: Number(a.attackerStructTypeId), owner: a.attackerPlayerId, ambit: ambitOf(a.attackerStructOperatingAmbit), slot: Number(a.attackerStructSlot), column: a.attackerStructLocationType === 'planet' ? 'planet' : 'fleet', health: Number(a.attackerHealthBefore), locationId: a.attackerStructLocationId }, Number(a.attackerHealthMax) || undefined);
    for (const s of a.eventAttackShotDetail || []) {
      add({ id: s.targetStructId, typeId: Number(s.targetStructTypeId), owner: s.targetPlayerId, ambit: ambitOf(s.targetStructOperatingAmbit), slot: Number(s.targetStructSlot), column: s.targetStructLocationType === 'planet' ? 'planet' : 'fleet', health: Number(s.targetHealthBefore), locationId: s.targetStructLocationId });
      if (s.blocked && s.blockedByStructId) {
        add({ id: s.blockedByStructId, typeId: Number(s.blockedByStructTypeId), owner: s.targetPlayerId, ambit: ambitOf(s.blockedByStructOperatingAmbit), slot: Number(s.blockedByStructSlot), column: s.blockedByStructLocationType === 'planet' ? 'planet' : 'fleet', health: Number(s.blockerHealthBefore), locationId: s.blockedByStructLocationId });
      }
      for (const c of s.eventAttackDefenderCounterDetail || []) {
        const t = TYPES_BY_ID[Number(c.counterByStructTypeId)];
        add({ id: c.counterByStructId, typeId: Number(c.counterByStructTypeId), owner: s.targetPlayerId, ambit: ambitOf(c.counterByStructOperatingAmbit), slot: Number(c.counterByStructSlot), column: c.counterByStructLocationType === 'planet' ? 'planet' : 'fleet', health: t?.maxHealth || 1, locationId: c.counterByStructLocationId });
      }
    }
    }
    return [...out.values()];
  }

  /**
   * The whole field: every struct the board snapshot found (the planet's, its owner's fleet if home,
   * the raider at the head of the queue), plus any struct the fight names that the snapshot lacks
   * (built mid-fight, or no snapshot at all). Structs in the first attack take that attack's
   * health-before, which is exact; the rest stand as the snapshot found them.
   */
  private boardPieces(board: Battlefield | null, attacks: RawAttack[], teal: string): Piece[] {
    const named = this.piecesOf(attacks, teal);
    // Only the commanders in this fight: other fleets queued at the same planet, or a planet owner
    // whose world is merely the venue of a fleet-on-fleet fight, are not part of it.
    const players = new Set(attacks.flatMap((x) => [x.attackerPlayerId, ...(x.eventAttackShotDetail || []).map((s) => s.targetPlayerId)]));
    const out = new Map<string, Piece>();
    const maxOf = new Map<number, number>();
    for (const s of board?.structs || []) {
      const t = TYPES_BY_ID[s.typeId];
      if (!t || !AMBITS.includes(s.ambit as Ambit) || !players.has(s.owner)) continue;
      // Max health as the rules stood at that block (planetary structs had 3 before v0.18).
      const max = s.maxHealth || t.maxHealth;
      maxOf.set(s.typeId, max);
      out.set(s.id, { id: s.id, typeId: s.typeId, owner: s.owner, side: s.owner === teal ? 'player' : 'enemy', ambit: s.ambit as Ambit, slot: s.slot, chainSlot: s.slot,
        column: s.locationType === 'planet' ? 'planet' : 'fleet', health: Math.min(max, s.health || max), maxHealth: max, locationId: s.locationId, status: s.status || 7 });
    }
    const first = new Set(this.piecesOf(attacks.slice(0, 1), teal).map((p) => p.id));
    for (const p of named) {
      const have = out.get(p.id);
      if (!have) { if (maxOf.has(p.typeId)) p.maxHealth = maxOf.get(p.typeId)!; out.set(p.id, p); }
      // The snapshot is the field's state; the first attack's figure wins only when lower (an earlier
      // transaction in the same block did damage). The event can overstate: counter-firers carry no
      // health, and the deployed chain reports an overkilled target's health-before as after + damage.
      else if (first.has(p.id)) have.health = Math.min(have.health, p.health);
    }
    const list = [...out.values()];
    // Each side packs toward the divider: fleet hulls first, then planetary structs, the Command Ship last.
    const rank = (p: Piece) => (p.typeId === 1 ? 200 : p.column === 'planet' ? 100 : 0) + p.chainSlot;
    for (const side of ['player', 'enemy'] as SideV[]) {
      for (const ambit of AMBITS) {
        list.filter((p) => p.side === side && p.ambit === ambit).sort((a, b) => rank(a) - rank(b)).forEach((p, k) => { p.slot = k; });
      }
    }
    return list;
  }

  /** Which field a fight is on, from the records alone. Any planetary struct in it names the planet
   * (a fleet can only fight one where it is). A fleet-on-fleet fight names no planet, and where a
   * fleet is now says nothing about where it fought (it has usually gone home since, so each side's
   * volleys would name a different world): those key on the two commanders, one board per pair. */
  private fieldOf(recs: CombatRecord[]): string {
    const locs: [string, string][] = [];
    for (const r of recs) {
      const a = r.attack;
      locs.push([a.attackerStructLocationType, a.attackerStructLocationId]);
      for (const s of a.eventAttackShotDetail || []) {
        locs.push([s.targetStructLocationType, s.targetStructLocationId]);
        if (s.blocked && s.blockedByStructId) locs.push([s.blockedByStructLocationType, s.blockedByStructLocationId]);
        for (const c of s.eventAttackDefenderCounterDetail || []) locs.push([c.counterByStructLocationType, c.counterByStructLocationId]);
      }
    }
    return locs.find(([t, id]) => t === 'planet' && id)?.[1] || 'pair:' + pairOf(recs[0]);
  }

  private unitFor(p: Piece): UnitView {
    const sim: SimStruct = { id: p.id, typeId: p.typeId, owner: p.owner, locationType: 'fleet', locationId: p.locationId, ambit: p.ambit, slot: p.slot, health: p.health, status: 7, protectedStructId: null, destroyedAt: null };
    const v = new UnitView(p.id, p.side, sim);
    v.column = p.column;
    v.maxHealth = p.maxHealth;
    return v;
  }

  /** Health and status as the board found them: in stealth, offline, or still under construction. */
  private applyState(u: UnitView, p: Piece) {
    if (u.maxHealth !== p.maxHealth) { u.maxHealth = p.maxHealth; u.renderPips(); }
    if (u.health !== p.health) u.setHealth(p.health);
    const hidden = (p.status & 16) !== 0;
    if (u.hidden !== hidden) u.setHidden(hidden);
    u.online = (p.status & 4) !== 0;
    u.building = (p.status & 2) === 0;
  }

  /** Bring a kept board to a new field state: gone structs leave, standing ones update and slide to
   * their slots, newcomers appear. Nothing that stayed the same is touched. */
  private async reconcile(view: BattleView, pieces: Piece[]) {
    const want = new Map(pieces.map((p) => [p.id, p]));
    for (const u of [...view.units.values()]) {
      const p = want.get(u.id);
      if (!p || u.destroyed || u.side !== p.side || u.column !== p.column) view.removeUnit(u.id);
    }
    const fresh: UnitView[] = [];
    for (const p of pieces) {
      const u = view.units.get(p.id);
      if (!u) { fresh.push(this.unitFor(p)); continue; }
      this.applyState(u, p);
      view.moveUnit(u, p.ambit, p.slot);
    }
    await view.addUnits(fresh);
    for (const u of fresh) { const p = want.get(u.id); if (p && view.units.get(u.id) === u) this.applyState(u, p); }
  }

  /** The field one block before the first attack, read from the chain at that height (null if it can't be). */
  private async boardFor(recs: CombatRecord[]): Promise<{ board: Battlefield | null; note: (shown: number) => { plain: string; expert: string; partial: boolean } }> {
    const h = recs[0].height - 1;
    const a = recs[0].attack, s0 = a.eventAttackShotDetail?.[0];
    const planetId = s0?.targetStructLocationType === 'planet' ? s0.targetStructLocationId : a.attackerStructLocationType === 'planet' ? a.attackerStructLocationId : undefined;
    const fleets = new Set<string>();
    for (const r of recs) {
      const x = r.attack;
      if (x.attackerStructLocationType === 'fleet') fleets.add(x.attackerStructLocationId);
      for (const s of x.eventAttackShotDetail || []) {
        if (s.targetStructLocationType === 'fleet') fleets.add(s.targetStructLocationId);
        if (s.blockedByStructLocationType === 'fleet') fleets.add(s.blockedByStructLocationId);
        for (const c of s.eventAttackDefenderCounterDetail || []) if (c.counterByStructLocationType === 'fleet') fleets.add(c.counterByStructLocationId);
      }
    }
    try {
      let timer = 0;
      const board = await Promise.race([
        battlefieldAt(h, { planetId, fleets: [...fleets] }),
        new Promise<never>((_, j) => { timer = window.setTimeout(() => j(new Error('timed out')), 12000); }),
      ]).finally(() => clearTimeout(timer));
      // Counted as staged: structs of commanders outside the fight aren't shown.
      return { board, note: (n) => ({ partial: !!board.missing,
        expert: board.missing ? `Partial battlefield at block #${formatInt(h)} · ${n} structs (${board.missing} could not be read)` : `Full battlefield at block #${formatInt(h)} · ${n} structs`,
        plain: board.missing ? `${n} ships and buildings, as they stood just before the fight (${board.missing} couldn’t be read)` : `${n} ships and buildings, as they stood just before the fight` }) };
    } catch (e) {
      const pruned = /load state|version|pruned|height/i.test(String((e as Error)?.message || e));
      return { board: null, note: () => ({ partial: true,
        expert: pruned ? `Fight-only view: block #${formatInt(h)} is older than the node keeps` : 'Fight-only view: the battlefield could not be read',
        plain: pruned ? 'This fight is too old to show the whole battlefield: only the ships that fought appear' : 'Only the ships that fought are shown: the rest of the battlefield couldn’t be read' }) };
    }
  }

  /** Neighbouring attacks between the same two commanders (gaps under ENGAGEMENT_GAP blocks), oldest first. */
  private engagementOf(rec: CombatRecord, pool: CombatRecord[] = this.list): CombatRecord[] {
    const key = pairOf(rec);
    const same = pool.filter((r) => pairOf(r) === key).sort((a, b) => a.height - b.height || (a.hash === b.hash ? (a.evt ?? 0) - (b.evt ?? 0) : 0));
    const i = same.findIndex((r) => sameRec(r, rec));
    if (i < 0) return [rec];
    let lo = i, hi = i;
    while (lo > 0 && same[lo].height - same[lo - 1].height <= ENGAGEMENT_GAP && hi - lo < 29) lo--;
    while (hi < same.length - 1 && same[hi + 1].height - same[hi].height <= ENGAGEMENT_GAP && hi - lo < 29) hi++;
    return same.slice(lo, hi + 1);
  }

  private select(rec: CombatRecord, fromList = false) { return this.stage(rec, [rec], fromList); }

  /** Stage the structs of one or more attacks and play them in order. */
  private async stage(rec: CombatRecord, recs: CombatRecord[], fromList = false) {
    const token = ++this.token;
    // A replay starting folds the strips away: the battle is what to watch.
    if (this.listOpen || this.detailOpen) this.fold(false, false);
    // Claimed at once: a live arrival under autoplay must not replace a fight that is being ordered.
    this.current = rec;
    this.playing = true;
    // Same-block attacks replay in execution order (the block is read only when two share a height).
    if (recs.length > 1) { recs = await inChainOrder(recs); if (token !== this.token) return; }
    const attacks = recs.map((r) => r.attack);
    this.staged = recs;
    // The same field as the board on screen, with its teal commander still in the fight: keep the board
    // (and its colours) and change only what changed. Otherwise a fresh board.
    const key = this.fieldOf(recs);
    const players = new Set(attacks.flatMap((x) => [x.attackerPlayerId, ...(x.eventAttackShotDetail || []).map((s) => s.targetPlayerId)]));
    // The same battle as the board on screen: the same field, or the same two commanders trading
    // fire within an engagement's gap of the last volley shown (the field can read differently
    // depending on which side fired, e.g. fleet-on-fleet from a fleet that has since moved).
    const pair = pairOf(recs[0]);
    const near = Math.abs(recs[0].height - this.viewHeight) <= ENGAGEMENT_GAP || Math.abs(recs[recs.length - 1].height - this.viewHeight) <= ENGAGEMENT_GAP;
    const sameField = !!this.view && players.has(this.teal) && (this.viewKey === key || (this.viewPair === pair && near));
    this.teal = this.tealOf(attacks);
    this.renderList();
    this.renderDetail(recs[0], recs.length > 1 ? { i: 0, n: recs.length } : undefined);
    if (fromList && !this.filter && currentRoute().startsWith('/combat')) replaceRoute('/combat/' + rec.hash + (recs.length > 1 ? '/e' : ''));
    // The whole field as it stood the block before the first shot (cached per block, so replays are instant).
    // A kept board stays on screen while it is read.
    if (!sameField && this.view) { this.scene.remove(this.view.group); this.view.dispose(); this.view = null; hideTooltip(); this.hovered = null; }
    this.boardReady = false;
    this.setNote('clock', '…', `Reading the battlefield at block #${formatInt(recs[0].height - 1)}…`);
    // A held arrow key steps many times a second: only the attack it stops on reads its board.
    await new Promise((r) => setTimeout(r, 120));
    if (token !== this.token) return;
    const { board, note } = await this.boardFor(recs);
    if (token !== this.token) return;
    const seed = hash32(board?.planetId || key);
    const pieces = this.boardPieces(board, attacks, this.teal);
    const said = note(pieces.length);
    this.setNote('ship', String(pieces.length), said.plain, said.expert, said.partial);
    // The stage is as wide as its pieces, so the battleground labels sit just beyond them.
    const reach = Math.max(3.2, ...pieces.map((p) => Math.abs(xFor(p.side, p.slot, p.typeId === 1))));
    const halfWidth = clamp(reach + 6.5, 14, 60);
    const keep = sameField && this.view !== null && halfWidth <= this.viewHalfWidth;
    this.pieces = pieces;
    this.viewHeight = recs[recs.length - 1].height;
    let view: BattleView;
    if (keep) {
      view = this.view!;
      view.halt();
      await this.reconcile(view, pieces);
      if (token !== this.token || this.view !== view) return;
    } else {
      if (this.view) { this.scene.remove(this.view.group); this.view.dispose(); this.view = null; }
      view = new BattleView(this.camera, this.layer, { halfWidth, palette: WORLD_PALETTES[seed % WORLD_PALETTES.length], seed: (seed % 1000) / 37 });
      view.xFor = xFor;
      view.fx.scale = 1.6;
      view.fx.setScale(window.innerHeight, this.camera.fov);
      view.onFocus = (p, w) => { this.focus.copy(p); this.focusW = Math.max(this.focusW, w); };
      view.onShake = (s) => this.engine.addShake(s * 0.8);
      view.onFlash = (s, c) => this.engine.addFlash(s * 0.6, c);
      view.reduceMotion = this.engine.reduceMotion;
      // A Command Ship falling is the moment: the board slows and the camera leans in.
      view.onCinematic = (p) => { if (this.engine.reduceMotion) return; this.focus.copy(p); this.focusW = 1.6; this.punch = 1; };
      view.onCommandDestroyed = (side) => banner('FLAGSHIP DOWN', side === 'player' ? 'A COMMAND SHIP IS LOST' : 'ENEMY COMMAND SHIP DESTROYED', side === 'player' ? 'enemy' : 'player', 1600);
      this.view = view;
      this.viewKey = key;
      this.viewHalfWidth = halfWidth;
      this.viewPair = pair;
      this.scene.add(view.group);
      const units = pieces.map((p) => this.unitFor(p));
      await view.addUnits(units);
      if (token !== this.token || this.view !== view) return;
      for (const u of units) this.applyState(u, pieces.find((p) => p.id === u.id)!);
    }
    // Guards that stepped in or fired back are tethered to the struct they protect.
    const pairs: { from: string; to: string }[] = [];
    for (const x of attacks) for (const s of x.eventAttackShotDetail || []) {
      if (s.blocked && s.blockedByStructId) pairs.push({ from: s.blockedByStructId, to: s.targetStructId });
      for (const c of s.eventAttackDefenderCounterDetail || []) pairs.push({ from: c.counterByStructId, to: s.targetStructId });
    }
    // And every standing guard assignment on the field, from the snapshot.
    const onBoard = new Set(pieces.map((p) => p.id));
    for (const s of board?.structs || []) for (const d of s.defenders) if (onBoard.has(d) && onBoard.has(s.id)) pairs.push({ from: d, to: s.id });
    view.setTethers(pairs.filter((p, i) => pairs.findIndex((q) => q.from === p.from && q.to === p.to) === i));
    this.boardReady = true;
    this.fit();
    if (!keep) { this.zoom.reset(); audio.play('warp', 0.5); }
    this.later(keep ? 250 : 900, () => {
      if (token !== this.token || this.view !== view) return;
      recs.forEach((r, i) => {
        // Narration follows the volley being played.
        if (recs.length > 1) view.enqueue(async () => { if (token === this.token) this.renderDetail(r, { i, n: recs.length }); });
        view.playChainAttack(numeric(r.attack) as unknown as AttackDetail);
        if (recs.length > 1 && i < recs.length - 1) view.enqueue(() => new Promise((res) => setTimeout(res, 500)));
      });
      view.enqueue(async () => {
        if (token !== this.token) return;
        this.playing = false;
        if (recs.length > 1) this.renderSummary(recs);
        if (this.autoplay) this.later(2600, () => { if (token === this.token && this.autoplay) this.step(1); });
      });
    });
  }

  /** After a whole engagement: who fired how often, what it cost each side. */
  private renderSummary(recs: CombatRecord[]) {
    const tally = new Map<string, { attacks: number; damage: number; lost: number }>();
    const of = (pid: string) => { let t = tally.get(pid); if (!t) { t = { attacks: 0, damage: 0, lost: 0 }; tally.set(pid, t); } return t; };
    for (const r of recs) {
      const a = r.attack;
      const me = of(a.attackerPlayerId);
      me.attacks++;
      for (const s of a.eventAttackShotDetail || []) {
        me.damage += Number(s.damage || 0);
        if (s.targetDestroyed) of(s.targetPlayerId).lost++;
        if (s.blockerDestroyed) of(s.targetPlayerId).lost++;
      }
      if (a.attackerHealthAfter === '0' || a.recoilDamageDestroyedAttacker || a.planetaryDefenseCannonDamageDestroyedAttacker) me.lost++;
    }
    const first = recs[0], last = recs[recs.length - 1];
    const span = last.height - first.height;
    const rows = [...tally.entries()].sort((a, b) => (a[0] === this.teal ? -1 : b[0] === this.teal ? 1 : 0)).map(([pid, t]) =>
      h('tr', null, h('td', { class: 'dw-name ' + (pid === this.teal ? 'c-player' : 'c-enemy') }, store.playerName(pid)), h('td', { class: 'num' }, String(t.attacks)), h('td', { class: 'num c-warn' }, String(t.damage)), h('td', { class: 'num' + (t.lost ? ' c-enemy' : '') }, String(t.lost))));
    // Column heads are pictures: attacks fired, damage dealt, structs lost (their names are the titles).
    const th = (ico_: string, label: string, cls = '') => h('th', { class: 'c-hint ' + cls, title: label, 'aria-label': label }, ico(ico_, 16));
    this.els.detail.replaceChildren(
      h('div', { class: 'panel-head', title: 'Engagement summary: who fired how often, and what it cost each side' },
        h('span', { class: 'dw-head' }, ico('battle', 20), h('span', { class: 't-label' }, 'Fight')), h('span', { class: 'chip dw-count', title: `${recs.length} attacks` }, ico('target', 13), String(recs.length)), this.foldBtn('detail')),
      h('div', { class: 'panel-body col scroll', style: 'gap:8px' },
        h('div', { class: 'dw-span', title: `Blocks #${formatInt(first.height)}–#${formatInt(last.height)} · ${span} blocks` }, ico('clock', 14), blocksToDuration(span),
          h('span', { class: 'x-only c-hint' }, ` · #${formatInt(first.height)}–#${formatInt(last.height)} · ${span} blocks`)),
        h('table', { class: 'stats dw-stats' },
          h('thead', null, h('tr', null, th('team', 'Commander', 'dw-th-name'), th('target', 'Attacks'), th('battle', 'Damage'), th('boom', 'Lost'))),
          h('tbody', null, rows))),
      h('div', { class: 'dw-acts dw-foot' },
        h('button', { class: 'btn secondary mini', title: 'Replay the whole engagement', onclick: () => { audio.play('confirm'); void this.stage(this.current || recs[0], recs); } }, ico('replay', 14), 'Replay'),
        h('button', { class: 'btn ghost mini', title: 'Fight it yourself: fly these fleets against the computer, as they stood (planetary structs stay home)', onclick: () => this.refight() }, ico('target', 14), 'Refight'),
        h('button', { class: 'btn ghost mini dw-ibtn', title: 'Copy a link that opens this whole engagement', 'aria-label': 'Copy link', onclick: () => copyText(routeUrl('/combat/' + recs[recs.length - 1].hash + '/e'), 'Engagement link copied', 1400) }, ico('link', 15))));
  }

  /** The staged fleet structs as a simulator battle: teal is you, the other side the computer. */
  private refight() {
    if (!this.boardReady) { toast('The battlefield is still being read', 'warn', 1600); return; }
    // Hulls that could fight: built and online (one still under construction, or offline, sits it out).
    const pieces = this.pieces.filter((p) => TYPES_BY_ID[p.typeId]?.category === 'fleet' && (p.status & 6) === 6);
    // Each hull starts as it stood before the first shot of the staged fight, on today's health scale.
    const hurt = (p: Piece) => {
      const max = TYPES_BY_ID[p.typeId].maxHealth;
      const hp = Math.max(1, Math.round((p.health * max) / (p.maxHealth || max)));
      return p.health >= 1 && hp < max ? hp : undefined;
    };
    const units: Unit[] = [];
    const idOf = new Map<string, string>();
    for (const side of ['player', 'enemy'] as SideV[]) {
      const s: Side = side === 'player' ? 'player' : 'computer';
      const used = new Set<string>();
      for (const p of pieces.filter((x) => x.side === side).sort((a, b) => a.chainSlot - b.chainSlot)) {
        if (p.typeId === COMMAND_SHIP_ID) {
          if (units.some((u) => u.side === s && u.type === COMMAND_SHIP_ID)) continue;
          const id = unitId(s, COMMAND_SHIP_ID, p.ambit, 0);
          units.push({ id, side: s, type: COMMAND_SHIP_ID, ambit: p.ambit, slot: 0, protects: null, health: hurt(p) });
          idOf.set(p.id, id);
          continue;
        }
        // Keep the chain slot when it is free, else the next free one in that battleground.
        let slot = clamp(p.chainSlot, 0, 3);
        for (let k = 0; k < 4 && used.has(p.ambit + slot); k++) slot = (slot + 1) % 4;
        if (used.has(p.ambit + slot)) continue;
        used.add(p.ambit + slot);
        const id = unitId(s, p.typeId, p.ambit, slot);
        units.push({ id, side: s, type: p.typeId, ambit: p.ambit, slot, protects: null, health: hurt(p) });
        idOf.set(p.id, id);
      }
      // Every fleet needs its flagship.
      if (!units.some((u) => u.side === s && u.type === COMMAND_SHIP_ID)) units.push({ id: unitId(s, COMMAND_SHIP_ID, 'space', 0), side: s, type: COMMAND_SHIP_ID, ambit: 'space', slot: 0, protects: null });
    }
    // Guards that blocked or counter-fired keep guarding what they protected.
    for (const r of this.staged) for (const sh of r.attack.eventAttackShotDetail || []) {
      const ward = idOf.get(sh.targetStructId);
      const guards = [...(sh.blocked && sh.blockedByStructId ? [sh.blockedByStructId] : []), ...(sh.eventAttackDefenderCounterDetail || []).map((c) => c.counterByStructId)];
      for (const gid of guards) {
        const u = units.find((x) => x.id === idOf.get(gid));
        const w = units.find((x) => x.id === ward);
        if (u && w && u !== w && u.side === w.side && TYPES_BY_ID[u.type].canDefend) u.protects = w.id;
      }
    }
    const err = validate(units);
    if (err) { toast('Could not stage this fight: ' + err, 'warn', 2600); return; }
    const other = this.pieces.find((p) => p.owner !== this.teal)?.owner || '';
    audio.play('confirm');
    this.navigate('/sim/' + encodeBattle({ units, difficulty: 'difficult', blockMs: 2000, title: `Refight: ${store.playerName(this.teal)} vs ${store.playerName(other)}` }));
  }

  /* ── Narration ────────────────────────────────────────────────────────── */
  private renderDetail(rec: CombatRecord, seq?: { i: number; n: number }) {
    const a = rec.attack, el = this.els.detail;
    const name = (id: string) => store.playerName(id);
    const at = Date.parse(rec.time);
    const t = TYPES_BY_ID[Number(a.attackerStructTypeId)];
    const ws = (a.weaponSystem === 'secondaryWeapon' ? 'secondaryWeapon' : 'primaryWeapon') as WeaponSystem;
    const amb = (x: string) => AMBIT_NAME[x as Ambit] || humanize(x);
    /** The battleground's own icon (space, air, land, water). */
    const ambIco = (x: string) => (AMBITS.includes(x as Ambit) ? ico(x, 13, 'dw-amb') : null);
    const teal = this.teal || this.tealOf([a]);
    const atkTone = a.attackerPlayerId === teal ? 'c-player' : 'c-enemy';
    const toneOf = (pid: string) => (pid === teal ? 'c-player' : 'c-enemy');
    const playerLink = (id: string, tone: string) => h('button', { class: 'linkish dw-name ' + tone, title: 'Open their world', onclick: () => this.navigate('/player/' + id) }, name(id));
    const shots = a.eventAttackShotDetail || [];
    const weapon = t ? weaponLabel(t, ws) : humanize(a.weaponSystem);
    // Each shot: the target (sprite, battleground, owner), then what happened as calls and numbers.
    // Every sentence the old narration said is the title of the piece that shows it.
    const lines = shots.map((s, i) => {
      const tone = toneOf(s.targetPlayerId);
      const tgt = `${s.targetStructType} (${amb(s.targetStructOperatingAmbit)}${s.targetStructLocationType === 'planet' ? ', planetary' : ''})`;
      const res: (HTMLElement | null)[] = [];
      if (s.evaded) res.push(call('EVADED', 'miss', `Evaded — ${humanize(s.evadedByPlanetaryDefenses ? s.evadedByPlanetaryDefensesCause : s.evadedCause)}`));
      else if (s.blocked) {
        const said = `Blocked by ${s.blockedByStructType} (${s.blockerHealthBefore}→${s.blockerHealthAfter} HP${s.blockerDestroyed ? ', destroyed' : ''})`;
        res.push(call('BLOCKED', 'block', said), sprite(s.blockedByStructTypeId, 'dw-spr sm', said));
        const took = Number(s.blockerHealthBefore) - Number(s.blockerHealthAfter);
        if (took > 0) res.push(delta('-' + took, 'block', `The guard took ${took}`));
        if (s.blockerDestroyed) res.push(call('DESTROYED', 'kill', 'The guard was destroyed'));
      } else {
        const red = Number(s.damageReduction || 0);
        res.push(delta('-' + s.damage, s.targetDestroyed ? 'kill' : 'hit', `${s.damage} damage`));
        if (red) res.push(h('span', { class: 'dw-chip', title: `${s.damageDealt} dealt, ${red} stopped by ${humanize(s.damageReductionCause)}` }, ico('shield', 12), '-' + red));
        res.push(hpOf(s.targetHealthBefore, s.targetHealthAfter, s.targetHealthMax));
        if (s.targetDestroyed) res.push(call('DESTROYED', 'kill'));
      }
      const back: HTMLElement[] = [];
      for (const c of s.eventAttackDefenderCounterDetail || []) {
        const said = `↩ ${c.counterByStructType} (${amb(c.counterByStructOperatingAmbit)}) counter-fired for ${c.counterDamage}${c.counterDestroyedAttacker ? ' and destroyed the attacker' : ''}`;
        back.push(h('div', { class: 'dw-back', title: said }, h('span', { class: 'dw-arrow' }, '↩'), sprite(c.counterByStructTypeId, 'dw-spr sm'), delta('-' + c.counterDamage, 'hit'), c.counterDestroyedAttacker ? call('DESTROYED', 'kill') : null));
      }
      if (s.targetCountered) back.push(h('div', { class: 'dw-back', title: `↩ the target fired back for ${s.targetCounteredDamage}${s.targetCounterDestroyedAttacker ? ' and destroyed the attacker' : ''}` },
        h('span', { class: 'dw-arrow' }, '↩'), sprite(s.targetStructTypeId, 'dw-spr sm'), delta('-' + s.targetCounteredDamage, 'hit'), s.targetCounterDestroyedAttacker ? call('DESTROYED', 'kill') : null));
      if (s.postDestructionDamageToAttacker) back.push(h('div', { class: 'dw-back', title: `✷ its wreck hit the attacker for ${s.postDestructionDamage}` }, h('span', { class: 'dw-arrow' }, '✷'), delta('-' + s.postDestructionDamage, 'hit')));
      return h('div', { class: 'shot-row' }, h('span', { class: 'num c-hint' }, `${i + 1}`),
        h('div', { class: 'dw-shot' },
          h('div', { class: 'dw-who', title: tgt }, sprite(s.targetStructTypeId, 'dw-spr'), ambIco(s.targetStructOperatingAmbit), playerLink(s.targetPlayerId, tone)),
          h('div', { class: 'dw-res' }, ...res), ...back));
    });
    // What hit the attacker after the volley: one word and a number each.
    const after: HTMLElement[] = [];
    if (a.recoilDamageToAttacker) after.push(h('div', { class: 'dw-res', title: `Recoil: the attacker took ${a.recoilDamage}${a.recoilDamageDestroyedAttacker ? ' and was destroyed' : ''}.` },
      h('span', { class: 'dw-word' }, 'Recoil'), delta('-' + a.recoilDamage, 'hit'), a.recoilDamageDestroyedAttacker ? call('DESTROYED', 'kill') : null));
    if (a.planetaryDefenseCannonDamageToAttacker) after.push(h('div', { class: 'dw-res', title: `Planetary defense cannon hit the attacker for ${a.planetaryDefenseCannonDamage}${a.planetaryDefenseCannonDamageDestroyedAttacker ? ' and destroyed it' : ''}.` },
      ico('planet', 14), h('span', { class: 'dw-word' }, 'Cannon'), delta('-' + a.planetaryDefenseCannonDamage, 'hit'), a.planetaryDefenseCannonDamageDestroyedAttacker ? call('DESTROYED', 'kill') : null));
    const targetPlanet = store.planetOfLocation(shots[0]?.targetStructLocationId);
    const engagement = seq ? [] : this.engagementOf(rec);
    const sum = tally(a);
    const when = Number.isFinite(at) ? `${new Date(at).toLocaleString()} · ${ago(Date.now() - at)} ago` : `block #${formatInt(rec.height)}`;
    el.replaceChildren(
      h('div', { class: 'panel-head', title: 'This really happened. Every ship is where it stood just before the fight, and every shot plays exactly as it was fired.' },
        h('span', { class: 'dw-head' }, ico('battle', 20), h('span', { class: 't-label' }, seq ? 'Fight' : 'Attack'), seq ? h('span', { class: 'dw-seq', title: `Attack ${seq.i + 1} of ${seq.n} in this engagement` }, `${seq.i + 1}/${seq.n}`) : null),
        // Folded (short screens): who hit whom and the result, on the strip itself.
        h('span', { class: 'dw-strip' }, h('b', { class: atkTone }, name(a.attackerPlayerId)), h('span', { class: 'cr-to' }, '▸'), shots[0] ? h('span', { class: toneOf(shots[0].targetPlayerId) }, name(shots[0].targetPlayerId)) : null,
          sum.dmg ? delta('-' + sum.dmg, sum.kills ? 'kill' : 'hit') : null, sum.kills ? call('DESTROYED', 'kill') : sum.blocked ? call('BLOCKED', 'block') : sum.evaded && !sum.dmg ? call('EVADED', 'miss') : null),
        h('span', { class: 'row', style: 'gap:6px' },
          h('span', { class: 'chip x-only', title: rec.hash }, '#' + formatInt(rec.height)),
          h('span', { class: 'chip dw-count', title: when }, ico('clock', 13), Number.isFinite(at) ? ago(Date.now() - at) : '#' + formatInt(rec.height)), this.foldBtn('detail'))),
      h('div', { class: 'panel-body col scroll', style: 'gap:8px' },
        h('div', { class: 't-tiny c-hint x-only' }, when, h('span', { class: 'mono', style: 'margin-left:6px' }, rec.hash.slice(0, 10) + '…')),
        // The attacker: sprite, battleground, name; what it fired (shots) and its health after.
        h('div', { class: 'dw-atk', title: `${a.attackerStructType} (${amb(a.attackerStructOperatingAmbit)}) fired ${weapon}${shots.length > 1 ? ` · ${shots.length} shots` : ''}` },
          sprite(a.attackerStructTypeId, 'dw-spr big'),
          h('div', { class: 'col grow', style: 'gap:4px; min-width:0' },
            h('div', { class: 'dw-who' }, ambIco(a.attackerStructOperatingAmbit), playerLink(a.attackerPlayerId, atkTone)),
            h('div', { class: 'dw-res' },
              h('span', { class: 'dw-chip ' + atkTone, title: `Fired ${weapon} · ${humanize(a.weaponControl)}` }, ico('target', 13), shots.length > 1 ? `×${shots.length}` : '×1'),
              hpOf(a.attackerHealthBefore, a.attackerHealthAfter, a.attackerHealthMax),
              h('span', { class: 'x-only c-hint' }, `${weapon} · ${humanize(a.weaponControl)}`)))),
        h('div', { class: 'col', style: 'gap:0' }, lines),
        ...after,
        h('div', { class: 't-tiny c-hint x-only' }, 'Staged from the chain: every struct on the field as it stood the block before the fight (read at that height), then each EventAttack played shot by shot.')),
      // The verbs sit under the scrolling narration, always in view.
      h('div', { class: 'dw-acts dw-foot' },
        !seq && engagement.length > 1 ? h('button', { class: 'btn secondary mini', title: `Watch the whole fight: ${engagement.length} neighbouring attacks between these two commanders, on one board, in order (E)`, onclick: () => { audio.play('confirm'); void this.stage(rec, engagement, true); } }, ico('play', 12), `Fight ×${engagement.length}`) : null,
        targetPlanet ? h('button', { class: 'btn ghost mini', title: `Open planet ${targetPlanet}`, onclick: () => this.navigate('/planet/' + targetPlanet) }, ico('planet', 15), 'Planet') : null,
        this.filter?.playerId === a.attackerPlayerId ? null : h('button', { class: 'btn ghost mini', title: `${name(a.attackerPlayerId)}’s record: every attack they have made`, onclick: () => this.navigate('/combat/by/' + a.attackerPlayerId) }, ico('record', 14), 'Record'),
        h('button', { class: 'btn ghost mini', title: 'Fight it yourself: fly these fleets against the computer, as they stood (planetary structs stay home)', onclick: () => this.refight() }, ico('target', 14), 'Refight'),
        h('button', { class: 'btn ghost mini dw-ibtn', title: 'Copy a link to this attack', 'aria-label': 'Copy link', onclick: () => copyText(routeUrl('/combat/' + rec.hash), 'Link copied', 1400) }, ico('link', 15))));
  }

  /** The chip that folds or unfolds the list or the narration (shown on short screens only). */
  private foldBtn(which: 'list' | 'detail') {
    const b = h('button', { class: 'btn ghost mini dw-fold', 'data-fold': which, onclick: () => {
      audio.play('select');
      // One open at a time: each unfolds over the stage.
      if (which === 'list') this.fold(!this.listOpen, false); else this.fold(false, !this.detailOpen);
    } }, ico(which === 'list' ? 'queue' : 'rules', 15), h('span', null, '▾'));
    this.paintFold(b);
    return b;
  }

  private paintFold(b: HTMLElement) {
    const list = b.dataset.fold === 'list', open = list ? this.listOpen : this.detailOpen;
    const say = `${open ? 'Hide' : 'Show'} ${list ? 'the list of attacks' : 'the details'}`;
    b.title = say; b.setAttribute('aria-label', say); b.setAttribute('aria-expanded', String(open));
    (b.lastChild as HTMLElement).textContent = open ? '▴' : '▾';
  }

  private fold(list: boolean, detail: boolean) {
    this.listOpen = list; this.detailOpen = detail;
    this.els.list?.classList.toggle('fold-open', list);
    this.els.detail?.classList.toggle('fold-open', detail);
    this.root.querySelectorAll<HTMLElement>('.dw-fold').forEach((b) => this.paintFold(b));
    this.fit();
  }

  /* ── Camera ───────────────────────────────────────────────────────────── */
  private fit() {
    const w = window.innerWidth, hgt = window.innerHeight;
    if (hgt <= 560 && this.els.bar) { this.fitShort(w, hgt); return; }
    const narrow = w <= 760;
    // The narration panel docks on the right at every desktop width (300 px wide below 1300).
    const left = w > 1100 ? 356 : w > 760 ? 300 : 0, right = w > 1300 ? 356 : w > 760 ? 316 : 0;
    const xs = this.pieces.map((p) => xFor(p.side, p.slot, p.typeId === 1));
    const reach = Math.max(3.2, ...xs.map(Math.abs));
    // Frame the whole stage, labels included, symmetric about the divider.
    const minX = -clamp(reach + 6.5, 14, 60) - 1, maxX = -minX;
    this.centerX = (minX + maxX) / 2;
    this.look.x = this.centerX;
    const halfW = (maxX - minX) / 2, halfH = 11.8;
    const usableW = Math.max(300, w - left - right);
    const usableH = Math.max(200, hgt - (narrow ? 380 : 190));
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    this.fitDist = Math.max(halfW / (t * (usableW / hgt)), halfH / (t * (usableH / hgt)), 30);
    this.zoom.center.set(this.centerX, 0);
    this.zoom.setBounds(halfW, halfH);
    this.camera.aspect = w / hgt;
    this.camera.setViewOffset(w, hgt, (right - left) / 2, narrow ? 120 : 10, w, hgt);
    this.camera.updateProjectionMatrix();
  }

  /** Short screens: the panels are strips along the top and bottom (folded), so the stage is the
   * band between them, measured from where the strips really are. */
  private fitShort(w: number, hgt: number) {
    let top = 46, bottom = hgt;
    for (const el of [this.els.list, this.els.detail, this.els.bar]) {
      if (!el || el.classList.contains('fold-open') || !el.offsetParent) continue;
      const q = el.getBoundingClientRect();
      if (!q.height) continue;
      if (q.top + q.height / 2 < hgt / 2) top = Math.max(top, q.bottom); else bottom = Math.min(bottom, q.top);
    }
    const xs = this.pieces.map((p) => xFor(p.side, p.slot, p.typeId === 1));
    const reach = Math.max(3.2, ...xs.map(Math.abs));
    const minX = -clamp(reach + 6.5, 14, 60) - 1, maxX = -minX;
    this.centerX = (minX + maxX) / 2;
    this.look.x = this.centerX;
    const halfW = (maxX - minX) / 2, halfH = 11.8;
    const usableW = Math.max(240, w - 16), usableH = Math.max(120, bottom - top - 8);
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    this.fitDist = Math.max(halfW / (t * (usableW / hgt)), halfH / (t * (usableH / hgt)), 30);
    this.zoom.center.set(this.centerX, 0);
    this.zoom.setBounds(halfW, halfH);
    this.camera.aspect = w / hgt;
    // The band's middle is where the stage's middle lands.
    this.camera.setViewOffset(w, hgt, 0, hgt / 2 - (top + bottom) / 2, w, hgt);
    this.camera.updateProjectionMatrix();
  }

  /* ── Input ────────────────────────────────────────────────────────────── */
  private bindInput() {
    const canvas = this.engine.canvas;
    const move = (e: PointerEvent) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.pointerPx = { x: e.clientX, y: e.clientY };
    };
    // Touch has no hover: a tap holds that struct's readout for a moment, and the next touch drops it.
    let held = 0;
    const unhover = () => {
      hideTooltip();
      if (this.hovered) { const o = this.view?.units.get(this.hovered); if (o) o.hover = 0; this.hovered = null; }
    };
    const drop = () => { if (!held) return; clearTimeout(held); held = 0; unhover(); };
    const leave = () => { this.pointer.set(9, 9); if (!held) unhover(); };
    let lastTouch = 0;
    const touchDown = (e: PointerEvent) => { if (e.pointerType !== 'mouse') { lastTouch = performance.now(); drop(); } };
    // Before bindTap's own listener: a pen acts on press, and its fresh hold mustn't be dropped by its own touch.
    canvas.addEventListener('pointerdown', touchDown);
    const untap = bindTap(canvas, (e) => {
      if (e.pointerType === 'mouse') return;
      move(e);
      this.updateHover();
      if (this.hovered) held = window.setTimeout(() => { held = 0; unhover(); }, 3000);
    });
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.zoom.wheel(e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY, this.camera, this.pointer);
    };
    // Two quick taps read as a double-click on touch screens: only a mouse double-click reframes.
    const dbl = () => { if (performance.now() - lastTouch > 700) this.zoom.reset(); };
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || e.metaKey || e.ctrlKey) return;
      if (e.key === 'z' || e.key === 'Z') this.zoom.reset();
      else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); this.step(1); }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); this.step(-1); }
      else if ((e.key === 'e' || e.key === 'E') && this.current) { const eng = this.engagementOf(this.current); if (eng.length > 1) { audio.play('confirm'); void this.stage(this.current, eng, true); } }
      else if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') { if (this.current) void this.stage(this.current, this.staged.length ? this.staged : [this.current], true); }
    };
    const unpinch = bindPinch(canvas, (dy, x, y) => {
      this.pointer.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
      this.zoom.wheel(dy, this.camera, this.pointer);
    });
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('dblclick', dbl);
    window.addEventListener('keydown', key);
    this.unsub.push(() => {
      canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('pointerdown', touchDown); untap(); clearTimeout(held);
      canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('dblclick', dbl);
      window.removeEventListener('keydown', key); unpinch();
    });
  }

  private updateHover() {
    if (!this.view) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.view.pickables(), false)[0];
    const u = hit ? (hit.object.userData.unit as UnitView) : null;
    const id = u?.id || null;
    if (id !== this.hovered) {
      if (this.hovered) { const o = this.view.units.get(this.hovered); if (o) o.hover = 0; }
      this.hovered = id;
      if (u) { u.hover = 1; audio.play('hover'); }
      this.engine.canvas.style.cursor = u ? 'help' : 'default';
    }
    if (!u) { hideTooltip(); return; }
    const p = this.pieces.find((x) => x.id === u.id);
    const t = TYPES_BY_ID[u.typeId];
    if (!p || !t) return;
    showTooltip(this.pointerPx.x, this.pointerPx.y, h('div', null,
      h('div', { class: 'spread' }, h('span', { class: 't-label ' + (u.side === 'player' ? 'c-player' : 'c-enemy') }, t.type), h('span', { class: 't-tiny c-hint' }, u.id)),
      h('div', { class: 't-tiny c-hint' }, `${store.playerName(p.owner)} · ${AMBIT_NAME[p.ambit]} slot ${p.chainSlot + 1}${p.column === 'planet' ? ' · planetary' : ''} · ${u.health}/${u.maxHealth} HP`)), u.side);
  }

  /* ── Frame ────────────────────────────────────────────────────────────── */
  update(dt: number, t: number) {
    tickSpace(this.sky, t);
    if (!this.view) return;
    this.view.update(dt, t);
    if (this.pointer.x < 2) this.updateHover();
    const px = this.pointer.x < 2 ? this.pointer.x : 0, py = this.pointer.x < 2 ? this.pointer.y : 0;
    this.focusW = Math.max(0, this.focusW - dt * 0.35);
    this.punch = Math.max(0, this.punch - dt * 0.45);
    const lean = clamp(this.focusW, 0, 0.6) + this.punch * 0.9;
    const z = this.zoom;
    z.update(dt);
    const zs = z.cur, off = z.offset;
    const cam = this.camera.position;
    cam.x = damp(cam.x, this.centerX + off.x + (px * 2.4 + Math.sin(t * 0.13) * 0.8 + (this.focus.x - this.centerX) * 0.12 * lean) * zs, 2, dt);
    cam.y = damp(cam.y, off.y + (0.6 + py * 1.3 + Math.sin(t * 0.17) * 0.3 + this.focus.y * 0.1 * lean) * zs, 2, dt);
    cam.z = damp(cam.z, this.fitDist * zs * (1 - 0.3 * Math.min(1, this.punch * 1.4)), zs < 0.999 || z.zoomed ? 8 : 3, dt);
    this.zoomLook.set(this.look.x + off.x + (this.focus.x - this.centerX) * 0.15 * lean * zs, this.look.y + off.y, 0);
    this.camera.lookAt(this.zoomLook);
  }
}
