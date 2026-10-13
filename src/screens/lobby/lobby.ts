/* The Concourse: the lobby you walk into after PRESS START. Your PFP is your droid; the deck's
 * channel plays out as balloons over the droids of whoever's talking; a kiosk for each hub, the warp
 * gate, the notice wall and the Academy are a walk away (and the top bar still reaches all of it).
 * The lobby is players only, so someone without a commander starts in the hangar below it: player
 * setup first, then up the lift.
 *
 * Controls: WASD/arrows or the left stick walk (Shift or a full stick runs), the right stick or a
 * mouse drag turns the camera, E/Space/A uses what you're next to, Enter/Start talks, X stamps,
 * R/Y opens the ring menu, F/L/R faces the camera ahead. On a touch screen the left half is a thumb
 * stick, the right half turns, and a tap walks there (or opens a droid's card). */
import * as THREE from 'three';
import type { Engine, Screen } from '../../core/engine';
import { softwareGL } from '../../core/engine';
import { h, toast, fade } from '../../core/dom';
import { audio } from '../../core/audio';
import { capturePad } from '../../core/pad';
import { wallet } from '../../wallet/wallet';
import { store } from '../../chain/store';
import { empire } from '../../game/empire';
import { act } from '../../game/actions';
import { comms } from '../../chat/matrix';
import type { Msg, Room } from '../../chat/model';
import { pfpAttrs, AURA_COLOR, droidSpec, type PfpAttrs } from '../../data/droidParts';
import { DroidActor } from '../../gfx/droid/actor';
import { buildWorld, STATIONS, SPAWN, INSTRUCTOR, HANGAR_Y, WALK_R, type World, type Station } from './world';
import { Crowd, clampWalk, sendSpot, attrsOf, lists, turnToward, wrap } from './crowd';
import { Talk, STAMPS, type Deck } from './talk';
import { Tags, type Tagged } from './tags';
import { Setup } from './setup';
import { cwWindow, closeWindows, anyWindow, stationDialog, deckWindow, ringWindow, stampWindow, emoteWindow, phraseWindow, profileCard, partRows, focusFirst } from './menus';
import { icon } from '../../ui/icons';
import { vmuLobby } from '../../ui/vmu';
import '../../styles/dc-concourse.css';

type Mode = 'hangar' | 'plaza';
const WALK = 3.2, RUN = 5.6;
const INSTRUCTOR_ATTRS: PfpAttrs = { head: 22, body: 19, arms: 21, neck: 4, background: 6 };
const INSTRUCTOR_ID = 'npc:instructor';
const SEEN_KEY = 'structs.lobby.welcomed';

export class LobbyScreen implements Screen {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 2000);
  readonly bloom = { strength: 0.6, radius: 0.45, threshold: 0.55 };
  readonly streaks = 0;

  private world: World;
  private root!: HTMLElement;
  private cleanup: (() => void)[] = [];
  private mode: Mode = 'plaza';
  private live = false;

  // Me.
  private me: DroidActor | null = null;
  private pos = SPAWN.clone();
  private yaw = Math.PI;
  private vel = new THREE.Vector3();
  private goal: { at: THREE.Vector3; station?: Station } | null = null;
  private rising = 0;

  // Camera.
  private camYaw = 0;
  private camPitch = 0.3;
  private camDist = 6.4;
  private camHeld = 0;

  // Input.
  private keys = new Set<string>();
  private pad = { lx: 0, ly: 0, rx: 0, ry: 0, run: false, prev: [] as boolean[] };
  private stick: { id: number; x: number; y: number; dx: number; dy: number; el: HTMLElement } | null = null;
  private drag: { id: number; x: number; y: number; moved: number; turn: boolean } | null = null;

  // People and talk.
  private crowd: Crowd;
  private instructor: DroidActor;
  private talk: Talk | null = null;
  private tags: Tags | null = null;
  private room: Room | null = null;
  private setup: Setup | null = null;
  private preview: DroidActor | null = null;
  private previewSpin = 0;

  // HUD.
  private hud: { prompt: HTMLButtonElement; deck: HTMLButtonElement; map: HTMLCanvasElement; count: HTMLElement } | null = null;
  private near: Station | null = null;
  private mapT = 0;
  private noticeDirty = true;
  private lastStill = 0;
  /** Dev builds only: ?plaza skips setup, &crowd=N fills a pretend deck (src/screens/lobby/dev.ts). */
  private dev = import.meta.env.DEV ? new URLSearchParams(location.search) : null;
  private devRoom: Room | null = null;

  constructor(private engine: Engine, private navigate: (path: string) => void) {
    this.world = buildWorld(this.scene, engine.renderer);
    this.crowd = new Crowd(softwareGL(engine.renderer));
    this.scene.add(this.crowd.group);
    this.instructor = new DroidActor(INSTRUCTOR_ATTRS, { seed: INSTRUCTOR_ID, lite: softwareGL(engine.renderer) });
    this.instructor.group.position.copy(INSTRUCTOR);
    this.instructor.group.rotation.y = Math.atan2(SPAWN.x - INSTRUCTOR.x, SPAWN.z - INSTRUCTOR.z);
    this.world.plaza.add(this.instructor.group);
    store.onFeed(() => { this.noticeDirty = true; });
  }

  /* ── Lifecycle ─────────────────────────────────────────────────────── */

  enter(): void {
    this.root = h('div', { class: 'screen lobby' });
    document.getElementById('ui')!.appendChild(this.root);
    this.live = true;
    this.bindInput();
    const step = this.dev?.has('plaza') ? null : Setup.stepFor();
    if (step) this.toHangar(step);
    else this.toPlaza(false);
    // Who I am can change under us (a signup lands, the vault locks, another account).
    this.cleanup.push(wallet.onChange(() => {
      if (!this.live) return;
      if (this.mode === 'plaza' && !wallet.active?.playerId && !this.dev?.has('plaza')) this.toHangar(Setup.stepFor() ?? 'droid');
      else if (this.mode === 'plaza') this.me?.setAttrs(this.myAttrs());
    }));
    this.cleanup.push(store.onChange((c) => { if (c.kind === 'player' && this.mode === 'plaza') { this.me?.setAttrs(this.myAttrs()); this.crowd.sync(this.room); } }));
  }

  exit() {
    this.live = false;
    for (const f of this.cleanup.splice(0)) { try { f(); } catch (e) { console.error(e); } }
    closeWindows();
    this.leavePlaza();
    this.leaveHangar();
    this.root?.remove();
    this.keys.clear();
  }

  resize() { /* the engine sets the aspect; the HUD is CSS */ }

  /* ── Hangar: setup and arrival ─────────────────────────────────────── */

  private toHangar(step: ReturnType<typeof Setup.stepFor> & string) {
    this.leavePlaza();
    this.mode = 'hangar';
    this.world.plaza.visible = false;
    this.world.hangar.visible = true;
    this.crowd.group.visible = false;
    this.world.setLiftReady(step !== 'arrival' || !!wallet.active?.playerId);
    this.preview?.dispose();
    this.setup = new Setup({
      preview: (a) => {
        if (!this.preview) {
          this.preview = new DroidActor(a, { seed: 'preview' });
          this.preview.group.position.set(0, HANGAR_Y + 0.14, 0);
          this.scene.add(this.preview.group);
        } else this.preview.setAttrs(a);
        this.preview.play('wave');
      },
      rise: () => void this.rise(),
      navigate: this.navigate,
    });
    this.root.replaceChildren(this.setup.el);
    this.setup.start(step);
    this.cleanup.push(() => this.leaveHangar());
  }

  private leaveHangar() {
    this.setup?.dispose(); this.setup = null;
    this.preview?.dispose(); this.preview = null;
    this.world.hangar.visible = false;
  }

  /** The commander landed: up the lift into the Concourse. */
  private async rise() {
    if (!wallet.active?.playerId) return;
    audio.play('warp');
    await fade(true);
    this.leaveHangar();
    this.toPlaza(true);
    await fade(false);
    if (!wallet.backedUp) toast('Save your recovery phrase: it is the only way back to this commander.', 'warn', 7000, { label: 'Save it', run: () => void import('../../ui/vault').then((m) => m.openVault()) });
  }

  /* ── The plaza ─────────────────────────────────────────────────────── */

  private myAttrs(): PfpAttrs {
    const pid = wallet.active?.playerId ?? '';
    const raw = empire.commander?.pfp || store.players.get(pid)?.pfpClientRenderAttributes;
    return pfpAttrs(raw, comms.userIdForPlayer(pid) ?? pid);
  }

  private toPlaza(arriving: boolean) {
    this.root.replaceChildren();
    this.mode = 'plaza';
    this.world.plaza.visible = true;
    this.world.hangar.visible = false;
    this.crowd.group.visible = true;
    this.pos.copy(SPAWN);
    this.yaw = Math.PI;
    this.camYaw = 0;
    this.vel.set(0, 0, 0);
    this.goal = null;
    this.rising = arriving ? 1 : 0;
    this.me?.dispose();
    this.me = new DroidActor(this.myAttrs(), { seed: wallet.active?.playerId });
    this.scene.add(this.me.group);
    this.buildHud();
    this.talk = new Talk({
      onLine: (m, r) => this.onLine(m, r),
      onRoom: (r) => { if (this.devRoom) return; this.room = r; this.crowd.sync(r); this.paintDeck(); },
      navigate: this.navigate,
    });
    this.tags = new Tags(this.navigate);
    this.root.append(this.tags.el, this.talk.el);
    this.talk.start();
    // The lobby's music sits low: a place to talk.
    audio.setIntensity(0.12);
    const unpad = capturePad((pads) => this.readPad(pads));
    this.cleanup.push(unpad);
    if (import.meta.env.DEV && this.dev?.has('crowd')) void import('./dev').then(({ devRoom, devLine }) => {
      const r = devRoom(Number(this.dev!.get('crowd')) || 12);
      this.devRoom = r; this.room = r; this.crowd.sync(r);
      let last: Msg | undefined;
      const tick = window.setInterval(() => {
        if (!this.live || this.mode !== 'plaza') return;
        const m = devLine(r, last);
        if (m) { last = m; this.onLine(m, r); this.crowd.sync(r); }
      }, 2600);
      this.cleanup.push(() => { window.clearInterval(tick); this.devRoom = null; });
    });
    this.noticeDirty = true;
    // First visit: the Instructor says hello.
    let seen = false;
    try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch { /* ignore */ }
    if (!seen) setTimeout(() => {
      if (!this.live || this.mode !== 'plaza') return;
      this.npcSay('Welcome to the Concourse! Each kiosk opens a hub. Walk up and press A.');
      try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ }
    }, 1600);
  }

  private leavePlaza() {
    vmuLobby(null);
    audio.setIntensity(0.3);
    this.talk?.dispose(); this.talk = null;
    this.tags?.clear(); this.tags = null;
    this.me?.dispose(); this.me = null;
    this.crowd.dispose();
    this.hud = null;
    this.room = null;
    this.root?.replaceChildren();
  }

  private npcSay(text: string) {
    const m: Msg = { id: 'npc-' + Date.now(), sender: INSTRUCTOR_ID, ts: Date.now(), kind: 'text', body: text, pills: [], rev: 0 };
    this.tags?.say(m, 'Instructor', AURA_COLOR.tide);
    this.instructor.talk = 1;
    this.instructor.play('wave');
  }

  private onLine(m: Msg, r: Room) {
    const mine = m.sender === comms.me;
    if (!mine && lists.muted.has(m.sender)) return;
    if (!mine) this.crowd.speak(m.sender, m, r, this.pos);
    this.crowd.sync(r);
    const name = comms.nameOf(m.sender, r);
    const aura = mine ? AURA_COLOR[droidSpec(this.myAttrs()).aura] : AURA_COLOR[droidSpec(attrsOf(m.sender)).aura];
    const replyTo = m.replyTo ? r.byId.get(m.replyTo)?.sender : null;
    this.tags?.say(m, name, aura, replyTo ? comms.nameOf(replyTo, r) : null);
    const actor = mine ? this.me : this.crowd.people.get(m.sender)?.actor;
    if (actor) {
      actor.talk = 1;
      const st = STAMPS.find((s) => s.id === m.stamp);
      if (st) actor.play(st.emote);
    }
    if (!mine) audio.play('tick', 0.35);
  }

  /* ── HUD ───────────────────────────────────────────────────────────── */

  private buildHud() {
    const count = h('span', { class: 'lh-count', title: 'Droids on this deck' });
    const deck = h('button', { type: 'button', class: 'lh-deck cw', title: 'Change deck (channel)', onclick: () => this.openDecks() },
      h('span', { class: 'lh-deck-n' }), h('span', { class: 'lh-deck-name' }), h('span', { class: 'lh-people', html: icon('team', 16) }), count) as HTMLButtonElement;
    const map = h('canvas', { class: 'lh-map', width: 132, height: 132, 'aria-hidden': 'true' }) as HTMLCanvasElement;
    const prompt = h('button', { type: 'button', class: 'lh-prompt cw', hidden: true, onclick: () => this.use() }, h('span', { class: 'dc-face a' }, 'A'), h('span', { class: 'lh-prompt-word' })) as HTMLButtonElement;
    const acts = h('div', { class: 'lh-acts' },
      h('button', { type: 'button', class: 'lh-act', title: 'Talk (Enter)', onclick: () => this.talk?.focus() }, h('span', { class: 'dc-face a key' }, '↵'), h('span', { class: 'lh-act-ico', html: icon('chat', 18) }), h('span', { class: 'lh-act-word' }, 'Talk')),
      h('button', { type: 'button', class: 'lh-act', title: 'Stamp (X)', onclick: () => this.openStamps() }, h('span', { class: 'dc-face x' }, 'X'), h('span', { class: 'lh-act-ico', html: STAMPS[0] ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + STAMPS[0].glyph + '</svg>' : '' }), h('span', { class: 'lh-act-word' }, 'Stamp')),
      h('button', { type: 'button', class: 'lh-act', title: 'Menu (R)', onclick: () => this.openRing() }, h('span', { class: 'dc-face y' }, 'Y'), h('span', { class: 'lh-act-ico', html: icon('more', 18) }), h('span', { class: 'lh-act-word' }, 'Menu')));
    this.root.append(h('div', { class: 'lh' }, deck, map, prompt, acts));
    this.hud = { prompt, deck, map, count };
    this.paintDeck();
  }

  private paintDeck() {
    if (!this.hud || !this.talk) return;
    const d = this.talk.deck;
    (this.hud.deck.children[0] as HTMLElement).textContent = `DECK ${d.key}`;
    (this.hud.deck.children[1] as HTMLElement).textContent = d.name;
    this.hud.count.textContent = String(this.crowd.people.size + 1);
    vmuLobby({ deck: d.key, count: this.crowd.people.size + 1 });
  }

  private paintMap() {
    const c = this.hud?.map;
    if (!c) return;
    const g = c.getContext('2d')!;
    const S = 132, C = S / 2, k = (S / 2 - 8) / 20;
    g.clearRect(0, 0, S, S);
    g.fillStyle = 'rgba(12, 39, 68, 0.86)'; g.beginPath(); g.arc(C, C, C - 2, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#79D3F2'; g.lineWidth = 2; g.stroke();
    g.strokeStyle = '#FF6A13'; g.lineWidth = 2; g.beginPath(); g.arc(C, C, 2.6 * k, 0, Math.PI * 2); g.stroke();
    for (const s of STATIONS) {
      g.fillStyle = s.color;
      g.beginPath(); g.arc(C + s.at.x * k, C + s.at.z * k, s.kind === 'kiosk' ? 4 : 3, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#EAF6FF';
    for (const p of this.crowd.people.values()) { const q = p.actor.group.position; g.fillRect(C + q.x * k - 1.5, C + q.z * k - 1.5, 3, 3); }
    // Me: an arrow the way I face.
    g.save(); g.translate(C + this.pos.x * k, C + this.pos.z * k); g.rotate(-this.yaw + Math.PI);
    g.fillStyle = '#FF6A13'; g.beginPath(); g.moveTo(0, -6); g.lineTo(5, 5); g.lineTo(-5, 5); g.closePath(); g.fill();
    g.restore();
  }

  private paintNotice() {
    this.noticeDirty = false;
    const c = this.world.noticeCanvas, g = c.getContext('2d')!;
    g.fillStyle = '#071629'; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = '#79D3F2'; g.lineWidth = 4; g.strokeRect(6, 6, c.width - 12, c.height - 12);
    g.font = 'italic 900 40px "DC Display", system-ui, sans-serif';
    g.fillStyle = '#FF8A45'; g.textBaseline = 'top';
    g.fillText('LIVE', 28, 24);
    g.fillStyle = '#EAF6FF';
    g.fillText(`${store.players.size.toLocaleString('en-US')} COMMANDERS`, 140, 24);
    g.font = '600 24px "DC Text", system-ui, sans-serif';
    const items = store.feed.slice(-6).reverse();
    if (!items.length) { g.fillStyle = '#9FBED6'; g.fillText('Waiting for the galaxy…', 28, 100); }
    items.forEach((it, i) => {
      g.fillStyle = it.tone === 'enemy' ? '#FF8FA0' : it.tone === 'player' ? '#7FE3FF' : '#B9D3E6';
      const t = it.text.length > 52 ? it.text.slice(0, 51) + '…' : it.text;
      g.fillText(t, 28, 90 + i * 46);
    });
    this.world.noticeTexture.needsUpdate = true;
  }

  /* ── Windows ───────────────────────────────────────────────────────── */

  private openDecks() {
    if (!this.talk) return;
    deckWindow(this.talk.deck, (d) => {
      const r = comms.roomByAlias(d.alias);
      return r ? r.members.size ? [...r.members.values()].filter((m) => m.membership === 'join').length : null : null;
    }, (d: Deck) => {
      void this.talk?.switchTo(d).then(() => { this.crowd.dispose(); this.crowd.sync(this.talk?.room() ?? null); this.paintDeck(); });
      audio.play('warp', 0.5);
    });
  }

  private openStamps() { if (this.talk) stampWindow((s) => { this.talk?.stamp(s); this.me?.play(s.emote); }); }

  private openRing() {
    ringWindow('Menu', [
      { label: 'Stamp', ico: 'star', run: () => this.openStamps() },
      { label: 'Phrase', ico: 'chat', run: () => phraseWindow((t) => void this.talk?.send({ msgtype: 'm.text', body: t })) },
      { label: 'Emote', ico: 'robot', run: () => emoteWindow((e) => this.me?.play(e)) },
      { label: 'Decks', ico: 'flag', run: () => this.openDecks() },
      { label: 'Mirror', ico: 'eye', run: () => this.openMirror() },
      { label: 'Hubs', ico: 'grid', run: () => document.querySelector<HTMLElement>('.topbar .hub')?.focus({ focusVisible: true } as FocusOptions) },
      { label: 'Settings', ico: 'gear', run: () => window.dispatchEvent(new Event('structs:settings')) },
      { label: 'Galaxy', ico: 'explore', run: () => this.navigate('/galaxy') },
    ]);
  }

  /** The Mirror: restyle your droid, watch it change, sign to keep it. */
  private openMirror() {
    const before = this.myAttrs();
    let now = { ...before };
    let saved = false;
    const w = cwWindow('Mirror', { place: 'left', cls: 'cw-mirror', onClose: () => { if (!saved) this.me?.setAttrs(before); } });
    const rows = partRows(before, (a) => { now = a; this.me?.setAttrs(a); });
    const save = h('button', { type: 'button', class: 'cw-btn primary', onclick: () => {
      const p = empire.commander;
      if (!p) { toast('Your commander is still loading. Try again in a moment.', 'warn'); return; }
      try { act.setPortrait(p, now, 'lobby'); saved = true; toast('New look sent. It lands in a block or two.', 'player', 3000); w.close(); } catch (e) { toast((e as Error).message, 'enemy'); }
    } }, h('span', { class: 'dc-face a' }, 'A'), 'Keep it');
    w.body.append(rows.el, h('div', { class: 'cw-actions' }, h('button', { type: 'button', class: 'cw-btn', onclick: () => w.close() }, h('span', { class: 'dc-face b' }, 'B'), 'Cancel'), save));
    focusFirst(w);
    // Turn to face the camera while trying things on.
    this.yaw = this.camYaw;
  }

  private openCard(userId: string) {
    const r = this.room;
    const name = comms.nameOf(userId, r);
    const pid = this.crowd.people.get(userId)?.pid ?? '';
    const g = comms.guildOf(userId);
    profileCard(name, g ? store.guildName(g) : null, store.players.get(pid)?.pfpClientRenderAttributes ?? null, userId, {
      reply: () => { this.talk?.focus(); const i = document.getElementById('cl-say') as HTMLInputElement | null; if (i && !i.value) i.value = `@${name} `; },
      open: () => this.navigate('/player/' + pid),
      muted: lists.muted.has(userId), blocked: lists.blocked.has(userId),
      mute: () => { const on = lists.toggle('muted', userId); this.crowd.sync(r); return on; },
      block: () => { const on = lists.toggle('blocked', userId); this.crowd.sync(r); return on; },
    });
  }

  /** Use whatever I'm standing at. */
  private use() {
    const st = this.near;
    if (!st || anyWindow()) return;
    audio.play('confirm', 0.7);
    this.vel.set(0, 0, 0);
    if (st.kind === 'academy') { this.npcSay('Lessons are short and give XP. Have fun!'); }
    stationDialog(st, {
      go: (p) => this.navigate(p),
      mirror: () => this.openMirror(),
      decks: () => this.openDecks(),
      palette: () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' })),
    });
  }

  /* ── Input ─────────────────────────────────────────────────────────── */

  private walking() { return this.live && this.mode === 'plaza' && !anyWindow() && !this.talk?.typing && !document.querySelector('.modal-back'); }

  private bindInput() {
    const ignore = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t?.closest?.('input, textarea, select, .topbar, .hub-menu, .more-menu, .modal-back') || e.metaKey || e.ctrlKey || e.altKey;
    };
    const down = (e: KeyboardEvent) => {
      if (!this.live || this.mode !== 'plaza' || ignore(e) || !this.walking()) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const move = ['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift'];
      if (move.includes(k)) { this.keys.add(k); if (k.startsWith('Arrow')) e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (k === 'e' || k === ' ') { e.preventDefault(); e.stopImmediatePropagation(); this.use(); return; }
      if (k === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); this.talk?.focus(); return; }
      if (k === 'x') { e.stopImmediatePropagation(); this.openStamps(); return; }
      if (k === 'r') { e.stopImmediatePropagation(); this.openRing(); return; }
      if (k === 'f') { e.stopImmediatePropagation(); this.camYaw = this.yaw + Math.PI; return; }
      if (/^[1-8]$/.test(k)) { e.stopImmediatePropagation(); const s = STAMPS[Number(k) - 1]; this.talk?.stamp(s); this.me?.play(s.emote); }
    };
    const up = (e: KeyboardEvent) => { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; this.keys.delete(k); };
    const blur = () => this.keys.clear();
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    this.cleanup.push(() => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', blur); });

    const canvas = this.engine.canvas;
    const pd = (e: PointerEvent) => {
      if (!this.live) return;
      if (this.mode === 'hangar') { this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, turn: true }; return; }
      if (!this.walking()) return;
      const touch = e.pointerType === 'touch';
      if (touch && e.clientX < innerWidth * 0.45 && !this.stick) {
        const el = h('div', { class: 'lh-stick', style: `left:${e.clientX}px; top:${e.clientY}px` }, h('i'));
        this.root.append(el);
        this.stick = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0, el };
        return;
      }
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, turn: touch || e.button === 2 || e.button === 0 };
    };
    const pm = (e: PointerEvent) => {
      if (this.stick && e.pointerId === this.stick.id) {
        const dx = e.clientX - this.stick.x, dy = e.clientY - this.stick.y, d = Math.hypot(dx, dy), m = 56;
        const k = d > m ? m / d : 1;
        this.stick.dx = dx * k / m; this.stick.dy = dy * k / m;
        (this.stick.el.firstElementChild as HTMLElement).style.transform = `translate(${dx * k}px, ${dy * k}px)`;
        return;
      }
      if (this.drag && e.pointerId === this.drag.id) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        this.drag.moved += Math.abs(dx) + Math.abs(dy);
        this.drag.x = e.clientX; this.drag.y = e.clientY;
        if (this.drag.moved > 6) {
          if (this.mode === 'hangar') this.previewSpin += dx * 0.012;
          else { this.camYaw -= dx * 0.008; this.camPitch = THREE.MathUtils.clamp(this.camPitch + dy * 0.004, 0.08, 0.75); this.camHeld = 1.2; }
        }
      }
    };
    const pu = (e: PointerEvent) => {
      if (this.stick && e.pointerId === this.stick.id) { this.stick.el.remove(); this.stick = null; return; }
      if (this.drag && e.pointerId === this.drag.id) {
        const tap = this.drag.moved < 8;
        this.drag = null;
        if (tap && this.mode === 'plaza' && this.walking()) this.tap(e.clientX, e.clientY);
      }
    };
    const wheel = (e: WheelEvent) => { if (this.mode === 'plaza' && this.walking()) this.camDist = THREE.MathUtils.clamp(this.camDist + e.deltaY * 0.004, 3.5, 11); };
    const ctx = (e: Event) => { if (this.mode === 'plaza') e.preventDefault(); };
    canvas.addEventListener('pointerdown', pd);
    window.addEventListener('pointermove', pm);
    window.addEventListener('pointerup', pu);
    window.addEventListener('pointercancel', pu);
    canvas.addEventListener('wheel', wheel, { passive: true });
    canvas.addEventListener('contextmenu', ctx);
    this.cleanup.push(() => {
      canvas.removeEventListener('pointerdown', pd); window.removeEventListener('pointermove', pm); window.removeEventListener('pointerup', pu);
      window.removeEventListener('pointercancel', pu); canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('contextmenu', ctx);
      this.stick?.el.remove(); this.stick = null; this.drag = null;
    });
  }

  /** A tap or click on the 3D view: a droid opens its card, a station walks there, the floor walks. */
  private tap(x: number, y: number) {
    const v = new THREE.Vector3();
    const toScreen = (p: THREE.Vector3, lift: number) => { v.copy(p); v.y += lift; v.project(this.camera); return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, ok: v.z < 1 }; };
    let best: string | null = null, bestD = 48;
    for (const p of this.crowd.people.values()) {
      const s = toScreen(p.actor.group.position, 1.1);
      const d = Math.hypot(s.x - x, s.y - y);
      if (s.ok && d < bestD) { bestD = d; best = p.userId; }
    }
    if (best) { audio.play('select', 0.6); this.openCard(best); return; }
    for (const st of STATIONS) {
      const s = toScreen(st.at, 1.2);
      if (s.ok && Math.hypot(s.x - x, s.y - y) < 70) { this.walkTo(st.at, st); return; }
    }
    // The floor: where the ray meets y = 0.
    const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const t = -ray.ray.origin.y / ray.ray.direction.y;
    if (t > 0 && Number.isFinite(t)) {
      const at = ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
      if (Math.hypot(at.x, at.z) < WALK_R) this.walkTo(clampWalk(at));
    }
  }

  private walkTo(at: THREE.Vector3, station?: Station) {
    this.goal = { at: at.clone(), station };
    audio.play('tick', 0.5);
  }

  /** The pad, while walking: sticks walk and look, buttons are the lobby's verbs. */
  private readPad(pads: Gamepad[]): boolean {
    if (!this.walking()) { this.pad.lx = this.pad.ly = this.pad.rx = this.pad.ry = 0; return false; }
    const p = pads[0];
    const dead = (v: number) => (Math.abs(v) < 0.18 ? 0 : v);
    const b = (i: number) => !!p.buttons[i]?.pressed;
    let lx = dead(p.axes[0] ?? 0), ly = dead(p.axes[1] ?? 0);
    if (b(14)) lx = -1; if (b(15)) lx = 1; if (b(12)) ly = -1; if (b(13)) ly = 1;
    this.pad.lx = lx; this.pad.ly = ly;
    this.pad.rx = dead(p.axes[2] ?? 0); this.pad.ry = dead(p.axes[3] ?? 0);
    this.pad.run = Math.hypot(lx, ly) > 0.92 || b(10);
    const prev = this.pad.prev;
    const pressed = (i: number) => b(i) && !prev[i];
    if (pressed(0)) this.use();
    if (pressed(2)) this.openStamps();
    if (pressed(3)) this.openRing();
    if (pressed(9)) this.talk?.focus();
    if (pressed(4) || pressed(5)) this.camYaw = this.yaw + Math.PI;
    this.pad.prev = p.buttons.map((x) => x.pressed);
    return true;
  }

  /* ── Frame ─────────────────────────────────────────────────────────── */

  update(dt: number, t: number) {
    this.world.update(t, this.camera.position);
    if (!this.live) return;
    if (this.mode === 'hangar') return this.updateHangar(dt, t);
    if (this.noticeDirty) this.paintNotice();

    // Where I want to go.
    let ix = 0, iy = 0, run = false;
    if (this.walking()) {
      const k = this.keys;
      if (k.has('a') || k.has('ArrowLeft')) ix -= 1;
      if (k.has('d') || k.has('ArrowRight')) ix += 1;
      if (k.has('w') || k.has('ArrowUp')) iy += 1;
      if (k.has('s') || k.has('ArrowDown')) iy -= 1;
      run = k.has('Shift');
      ix += this.pad.lx; iy -= this.pad.ly; run ||= this.pad.run;
      if (this.stick) { ix += this.stick.dx; iy -= this.stick.dy; run ||= Math.hypot(this.stick.dx, this.stick.dy) > 0.95; }
      this.camYaw -= this.pad.rx * dt * 2.4;
      this.camPitch = THREE.MathUtils.clamp(this.camPitch + this.pad.ry * dt * 1.2, 0.08, 0.75);
      if (this.pad.rx || this.pad.ry) this.camHeld = 1.2;
    }
    const mag = Math.min(1, Math.hypot(ix, iy));
    const want = new THREE.Vector3();
    if (mag > 0.05) {
      this.goal = null;
      const fx = -Math.sin(this.camYaw), fz = -Math.cos(this.camYaw);
      const rx = Math.cos(this.camYaw), rz = -Math.sin(this.camYaw);
      want.set(fx * iy + rx * ix, 0, fz * iy + rz * ix).normalize().multiplyScalar((run ? RUN : WALK) * mag);
    } else if (this.goal) {
      const d = new THREE.Vector3(this.goal.at.x - this.pos.x, 0, this.goal.at.z - this.pos.z);
      const stop = this.goal.station ? this.goal.station.reach - 0.6 : 0.15;
      if (d.length() <= stop) {
        const st = this.goal.station;
        this.goal = null;
        if (st) { this.near = st; this.use(); }
      } else want.copy(d.normalize().multiplyScalar(WALK));
    }
    if (this.rising > 0) { this.rising = Math.max(0, this.rising - dt * 0.8); want.set(0, 0, 0); }
    this.vel.lerp(want, Math.min(1, dt * 10));
    const speed = this.vel.length();
    this.pos.addScaledVector(this.vel, dt);
    // Nobody walks through anybody.
    for (const p of this.crowd.people.values()) {
      const q = p.actor.group.position, dx = this.pos.x - q.x, dz = this.pos.z - q.z, d = Math.hypot(dx, dz);
      if (d < 0.9 && d > 1e-4) { this.pos.x = q.x + dx / d * 0.9; this.pos.z = q.z + dz / d * 0.9; }
    }
    clampWalk(this.pos);
    const prevYaw = this.yaw;
    if (speed > 0.2) this.yaw = turnToward(this.yaw, Math.atan2(this.vel.x, this.vel.z), dt * 10);

    if (this.me) {
      this.me.group.position.set(this.pos.x, -this.rising * 2.2, this.pos.z);
      this.me.group.rotation.y = this.yaw;
      this.me.speed = speed;
      this.me.turn = wrap(this.yaw - prevYaw) / Math.max(dt, 1e-3);
      this.me.update(dt, t);
    }
    this.instructor.update(dt, t);
    const meAt = this.pos;
    // Look at me when I come by.
    const di = Math.hypot(meAt.x - INSTRUCTOR.x, meAt.z - INSTRUCTOR.z);
    this.instructor.look = di < 5 ? wrap(Math.atan2(meAt.x - INSTRUCTOR.x, meAt.z - INSTRUCTOR.z) - this.instructor.group.rotation.y) : null;

    // Phase 2: when I've stood still a moment, tell the room where.
    if (speed < 0.05) {
      if (!this.lastStill) this.lastStill = t;
      if (t - this.lastStill > 1.5 && this.room) void sendSpot(this.room.id, this.pos.x, this.pos.z, this.yaw);
    } else this.lastStill = 0;

    // The camera swings in behind me as I walk, unless someone's holding it.
    this.camHeld = Math.max(0, this.camHeld - dt);
    if (speed > 0.5 && this.camHeld <= 0 && !this.engine.reduceMotion) this.camYaw = turnToward(this.camYaw, this.yaw + Math.PI, dt * 1.6);
    this.placeCamera(dt);

    this.crowd.update(dt, t, this.pos, this.camera);

    // What I'm next to.
    let near: Station | null = null, nd = Infinity;
    for (const s of STATIONS) {
      const d = Math.hypot(s.at.x - this.pos.x, s.at.z - this.pos.z);
      if (d < s.reach && d < nd) { nd = d; near = s; }
    }
    if (near !== this.near) {
      this.near = near;
      if (this.hud) {
        this.hud.prompt.hidden = !near;
        if (near) { (this.hud.prompt.children[1] as HTMLElement).textContent = near.label; this.hud.prompt.style.setProperty('--tone', near.color); audio.play('hover', 0.5); }
      }
    }

    // Tags over heads.
    if (this.tags) {
      const tagged: Tagged[] = [];
      const camPos = this.camera.position;
      if (this.me && comms.me) tagged.push({ userId: comms.me, head: new THREE.Vector3(this.pos.x, this.me.height, this.pos.z), name: 'You', aura: AURA_COLOR[this.me.spec.aura], guildTag: null, typing: false, dist: 0, me: true });
      tagged.push({ userId: INSTRUCTOR_ID, head: new THREE.Vector3(INSTRUCTOR.x, this.instructor.height, INSTRUCTOR.z), name: 'Instructor', aura: AURA_COLOR.tide, guildTag: null, typing: false, dist: camPos.distanceTo(INSTRUCTOR) });
      for (const p of this.crowd.people.values()) {
        const q = p.actor.group.position;
        tagged.push({
          userId: p.userId, head: new THREE.Vector3(q.x, p.actor.height + q.y, q.z), name: comms.nameOf(p.userId, this.room), aura: AURA_COLOR[p.actor.spec.aura],
          guildTag: comms.guildTag(comms.guildOf(p.userId) ?? '') ?? null, typing: p.typing, dist: camPos.distanceTo(q),
        });
      }
      this.tags.update(this.camera, innerWidth, innerHeight, tagged);
    }
    this.mapT -= dt;
    if (this.mapT <= 0) { this.mapT = 0.2; this.paintMap(); this.paintDeck(); }
  }

  private placeCamera(dt: number) {
    // Upright phones see more of the plaza: a wider lens, a step further back.
    const tall = this.camera.aspect < 0.8;
    this.setFov(tall ? 66 : 50);
    // A short frame (the 640×480 TV) aims a little lower, so I stand clear of the chat.
    const short = innerHeight < 560;
    const target = new THREE.Vector3(this.pos.x, (tall ? 1.7 : short ? 0.85 : 1.35) - this.rising * 2.2, this.pos.z);
    let dist = this.camDist * (tall ? 1.25 : 1);
    const off = () => new THREE.Vector3(Math.sin(this.camYaw) * Math.cos(this.camPitch) * dist, Math.sin(this.camPitch) * dist + 0.4, Math.cos(this.camYaw) * Math.cos(this.camPitch) * dist);
    let p = target.clone().add(off());
    // The dome wall pulls the camera in.
    for (let i = 0; i < 6 && Math.hypot(p.x, p.z) > 23; i++) { dist *= 0.82; p = target.clone().add(off()); }
    const k = Math.min(1, dt * 8);
    this.camera.position.lerp(p, k);
    if (this.camera.position.distanceTo(p) > 12) this.camera.position.copy(p);
    this.camera.lookAt(target);
  }

  private setFov(f: number) { if (this.camera.fov !== f) { this.camera.fov = f; this.camera.updateProjectionMatrix(); } }

  private updateHangar(dt: number, t: number) {
    this.setFov(50);
    const a = this.preview;
    if (a) {
      this.previewSpin += this.drag ? 0 : dt * 0.35;
      a.group.rotation.y = Math.sin(this.previewSpin) * 0.6 + (this.drag ? 0 : 0);
      a.update(dt, t);
    }
    // Frame the lift between the two windows; upright, the droid stands above the parts window.
    const narrow = this.camera.aspect < 1;
    this.camera.position.set(0, HANGAR_Y + 1.45, narrow ? 7.4 : 4.4);
    this.camera.lookAt(0, HANGAR_Y + (narrow ? -0.9 : 0.95), 0);
    if (this.setup && wallet.active?.playerId) this.world.setLiftReady(true);
  }
}

