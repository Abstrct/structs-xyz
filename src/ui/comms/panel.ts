/* CommsPanel: the whole chat console, mountable anywhere — full screen in CommsScreen,
 * or narrow in the slide-out dock. Wide layouts show the channel rail, the room and its
 * members side by side; narrow ones stack them (list ↔ room) like a handset. */
import { h, toast, confirmBox } from '../../core/dom';
import { audio } from '../../core/audio';
import { store } from '../../chain/store';
import { comms, DEFAULT_CHANNELS, type CommsState } from '../../chat/matrix';
import { onGuilds } from '../../chat/guilds';
import { excerpt, hostOf } from '../../chat/format';
import { memberCount, roomLabel, type Room } from '../../chat/model';
import { ChannelList, roomGlyph } from './channels';
import { Composer, confirmLeave } from './composer';
import { Timeline } from './timeline';
import { signInCard } from './signin';
import { directoryView, membersView, peopleView, searchView, type ViewHost } from './views';
import { face, fill, popMenu, type Nav } from './rich';
import '../../styles/comms.css';

type View = 'home' | 'room' | 'browse' | 'search' | 'people' | 'members';
export interface PanelOpts {
  mode: 'full' | 'dock';
  nav: Nav;
  /** Unique per panel (the client tracks which room each panel shows). */
  key: string;
  /** The open room changed (the screen mirrors it into the URL). */
  onRoom?: (room: Room | null) => void;
  /** Close the container (dock). */
  onClose?: () => void;
}

const STATE_TEXT: Record<CommsState, string> = { idle: 'Standby', connecting: 'Linking', live: 'Live', stalled: 'Signal lost', expired: 'Expired', signedOut: 'Offline' };

export class CommsPanel {
  /** The full-screen panel while it is mounted (the dock defers to it). */
  static full: CommsPanel | null = null;
  readonly el: HTMLDivElement;
  private rail: HTMLDivElement;
  private main: HTMLDivElement;
  private side: HTMLDivElement;
  private ident: HTMLDivElement;
  private list: ChannelList;
  private timeline: Timeline;
  private composer: Composer;
  private roomHead: HTMLDivElement;
  private pins: HTMLDivElement;
  private typingEl: HTMLDivElement;
  private roomBox: HTMLDivElement;
  private invite: HTMLDivElement;
  private signin: { el: HTMLElement; destroy(): void } | null = null;
  private view: View = 'home';
  private roomId: string | null = null;
  private showMembers = false;
  private pinsOpen = false;
  private visible = true;
  private wide = false;
  private raf = 0;
  private pendingRoom: string | null = null;
  private pendingEvent: string | null = null;
  private pendingJoined = false;
  private joining: string | null = null;
  private sideKey = '';
  private offs: (() => void)[] = [];
  private ro: ResizeObserver;

  constructor(container: HTMLElement, private o: PanelOpts) {
    const self = this;
    const vh: ViewHost = {
      nav: o.nav,
      openRoom: (id, ev) => this.openRoom(id, ev, true),
      dm: (u) => void this.dm(u),
      mention: (u) => { if (this.roomId) { this.show('room'); this.composer.mention(u); } },
      back: () => this.back(),
    };
    this.list = new ChannelList({ open: (id) => this.openRoom(id, undefined, true), active: () => (this.view === 'room' ? this.roomId : null) });
    this.timeline = new Timeline({
      nav: o.nav,
      reply: (m) => this.composer.reply(m),
      edit: (m) => this.composer.edit(m),
      mention: (u) => this.composer.mention(u),
      openObject: (id) => void this.openObject(id),
      dm: (u) => void this.dm(u),
    });
    this.composer = new Composer({
      nav: o.nav,
      room: () => self.room(),
      openRoom: (id) => this.openRoom(id, undefined, true),
      openObject: (id) => void this.openObject(id),
      dm: (u, text) => void this.dm(u, text),
      leave: () => { const r = this.room(); if (r) void confirmLeave(r, this.label(r)).then((ok) => { if (ok) this.back(); }).catch((e) => toast(String(e.message), 'warn')); },
    });
    this.viewHost = vh;

    this.ident = h('div', { class: 'cp-ident' });
    this.rail = h('div', { class: 'cp-rail' },
      this.ident,
      this.list.el,
      h('div', { class: 'cp-rail-foot' },
        h('button', { type: 'button', class: 'btn ghost mini', title: 'Start a direct channel', onclick: () => this.show('people') }, '+ DM'),
        h('button', { type: 'button', class: 'btn ghost mini', title: 'Browse channels', onclick: () => this.show('browse') }, 'Browse'),
        h('button', { type: 'button', class: 'btn ghost mini', title: 'Search (⌘F)', onclick: () => this.show('search') }, 'Search')));

    this.roomHead = h('div', { class: 'cp-room-head' });
    this.pins = h('div', { class: 'cp-pins' });
    this.typingEl = h('div', { class: 'cp-typing', 'aria-live': 'polite' });
    this.invite = h('div', { class: 'cp-invite' });
    this.roomBox = h('div', { class: 'cp-roombox' }, this.roomHead, this.pins, h('div', { class: 'cp-tl-wrap' }, this.timeline.el, ...this.timeline.overlays), this.typingEl, this.invite, this.composer.el);
    this.main = h('div', { class: 'cp-main' });
    this.side = h('div', { class: 'cp-side' });
    this.el = h('div', { class: `cp cp-mode-${o.mode}` }, h('div', { class: 'cp-scan', 'aria-hidden': 'true' }), this.rail, this.main, this.side);
    this.el.addEventListener('keydown', (e) => this.key(e));
    container.appendChild(this.el);

    this.timeline.el.addEventListener('scroll', () => { if (this.timeline.atBottom) this.readNow(); }, { passive: true });
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.el);
    if (o.mode === 'full') CommsPanel.full = this;

    comms.start();
    this.offs.push(comms.onChange((d) => {
      // A room asked for before the first sync (a deep link): open (or join) it once live.
      if (this.pendingRoom && comms.state === 'live') {
        const id = this.pendingRoom, ev = this.pendingEvent;
        const here = id.startsWith('#') ? comms.roomByAlias(id) : comms.room(id);
        if (here || !this.pendingJoined) {
          this.pendingRoom = null; this.pendingEvent = null; this.pendingJoined = false;
          this.openRoom(id, ev ?? undefined);
          return;
        }
      }
      // A change in another room only touches the channel list.
      if (d && this.roomId && !d.changed.has(this.roomId) && !d.left.length && !d.joined.length && !d.invited.length && !d.direct) { this.list.render(); return; }
      if (this.roomId && d?.left.includes(this.roomId)) { this.roomId = null; this.show('home'); }
      this.schedule();
    }));
    this.offs.push(comms.onState(() => this.schedule()));
    this.offs.push(store.onCore(() => this.schedule()));
    this.offs.push(onGuilds(() => this.schedule()) as () => void);
    const vis = () => this.markViewing();
    document.addEventListener('visibilitychange', vis);
    this.offs.push(() => document.removeEventListener('visibilitychange', vis));
    this.layout();
    this.renderAll();
  }

  private viewHost: ViewHost;

  room(): Room | null { return this.roomId ? comms.room(this.roomId) : null; }
  private label(r: Room) { return roomLabel(r, comms.me, (u) => comms.nameOf(u, r)); }
  private get signedIn() { return !!comms.session; }

  /* ── Public ────────────────────────────────────────────────────────────── */

  /** Open a room by id or alias (joining a public alias if needed); `eventId` scrolls to a message. */
  /** `asked`: the player chose this room themselves, so an unknown one may be joined without a confirm.
   * Links (URLs, other screens) are not asked: joining tells a stranger's server who you are. */
  openRoom(idOrAlias: string, eventId?: string, asked = false) {
    const pend = (joined = false) => { this.pendingRoom = idOrAlias; this.pendingEvent = eventId ?? null; this.pendingJoined = joined; };
    if (!this.signedIn) { pend(); return; }
    let r = idOrAlias.startsWith('#') ? comms.roomByAlias(idOrAlias) : comms.room(idOrAlias);
    if (!r) {
      if (comms.state !== 'live') { pend(); return; }
      if (this.joining === idOrAlias) return;
      this.joining = idOrAlias;
      const ok = asked ? Promise.resolve(true) : confirmBox('Join channel', `Join ${idOrAlias}? Its server will see your chat id.`, 'Join', 'player');
      void ok.then((yes) => (yes ? comms.join(idOrAlias) : null))
        .then((id) => {
          if (!id) return;
          // The join landed but sync hasn't brought the room yet: open it when it does.
          if (comms.room(id)) this.openRoom(id, eventId, true); else { this.pendingRoom = id; this.pendingEvent = eventId ?? null; this.pendingJoined = true; }
        })
        .catch((e) => toast('Could not open ' + idOrAlias + ': ' + e.message, 'warn', 4500))
        .finally(() => { this.joining = null; });
      return;
    }
    r = r!;
    const changed = this.roomId !== r.id || this.timeline.current !== r;
    this.roomId = r.id;
    this.view = 'room';
    this.pinsOpen = false;
    if (changed) {
      this.composer.setRoom(r);
      this.timeline.open(r);
      this.o.onRoom?.(r);
    }
    this.renderAll();
    if (eventId) requestAnimationFrame(() => { if (!this.timeline.scrollTo(eventId)) toast('That message is further back than what is loaded', 'warn', 2400); });
    this.markViewing();
    if (this.pendingDraft) { this.composer.prefill(this.pendingDraft); this.pendingDraft = ''; }
    this.composer.focus();
  }

  /** Put text in the composer of the open room (or of the next room opened). The person sends it. */
  private pendingDraft = '';
  draft(text: string) {
    if (this.roomId && this.view === 'room') this.composer.prefill(text); else this.pendingDraft = text;
  }

  /** The dock tells the panel when it is on screen (only a visible panel reads messages). */
  setVisible(on: boolean) {
    this.visible = on;
    this.markViewing();
    if (on) { this.renderAll(); this.composer.focus(); }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.offs.splice(0).forEach((f) => f());
    this.signin?.destroy();
    comms.setViewing(this.o.key, undefined);
    if (this.roomId) comms.typing(this.roomId, false);
    if (CommsPanel.full === this) CommsPanel.full = null;
    this.el.remove();
  }

  focusFilter() { if (this.wide || this.view === 'home') this.list.filter.focus(); else { this.show('home'); setTimeout(() => this.list.filter.focus(), 0); } }

  /* ── Navigation ────────────────────────────────────────────────────────── */

  show(v: View) {
    if (v === 'members' && this.wide) { this.showMembers = !this.showMembers; this.sideKey = ''; this.renderRoom(); this.renderSide(); return; }
    this.view = v;
    if (v === 'home' && !this.wide) { this.o.onRoom?.(null); }
    this.renderAll();
    this.markViewing();
  }

  private back() {
    if (this.view !== 'room' && this.view !== 'home' && this.roomId && comms.room(this.roomId)) { this.view = 'room'; this.renderAll(); return; }
    this.view = 'home';
    if (!this.wide) { this.roomId = null; this.o.onRoom?.(null); this.composer.setRoom(null); }
    this.renderAll();
    this.markViewing();
  }

  private async dm(userId: string, text?: string) {
    try {
      toast('Opening a direct channel…', '', 1400);
      const id = await comms.createDM(userId);
      this.openRoom(id, undefined, true);
      if (text) await comms.send(id, { msgtype: 'm.text', body: text, mentions: [] });
    } catch (e) { audio.play('deny'); toast('Could not open a direct channel: ' + (e as Error).message, 'warn', 5000); }
  }

  private async openObject(id: string) {
    try {
      toast(`Tuning to ${id}…`, '', 1600);
      const rid = await comms.openObjectRoom(id);
      this.openRoom(rid, undefined, true);
    } catch (e) { audio.play('deny'); toast(`No channel for ${id}: ${(e as Error).message}`, 'warn', 5000); }
  }

  private readNow() {
    const r = this.room();
    if (!r || !this.visible || document.hidden || this.view !== 'room' || r.membership !== 'join') return;
    if (this.timeline.atBottom) comms.markRead(r.id);
  }

  private markViewing() {
    const viewing = this.visible && this.view === 'room' ? this.roomId : null;
    comms.setViewing(this.o.key, this.visible ? viewing : undefined);
    this.readNow();
  }

  private key(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); this.focusFilter(); return; }
    if (mod && e.key.toLowerCase() === 'f' && this.signedIn) { e.preventDefault(); this.show('search'); return; }
    if (e.key === 'Escape' && !e.defaultPrevented) {
      const t = e.target as HTMLElement;
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return;
      if (this.view !== 'home' && (!this.wide || this.view !== 'room')) { e.preventDefault(); this.back(); }
      else if (this.o.onClose) { e.preventDefault(); this.o.onClose(); }
    }
  }

  /* ── Rendering ─────────────────────────────────────────────────────────── */

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.renderAll(); });
  }

  private layout() {
    const w = this.el.clientWidth;
    const wide = w >= 760;
    const side = w >= 1180;
    this.el.classList.toggle('wide', wide);
    this.el.classList.toggle('narrow', !wide);
    this.el.classList.toggle('roomy', side);
    if (wide !== this.wide) { this.wide = wide; this.renderAll(); }
  }

  private renderAll() {
    const signed = this.signedIn;
    this.el.classList.toggle('signed-out', !signed);
    if (!signed) {
      comms.setViewing(this.o.key, this.visible ? null : undefined);
      if (!this.signin) {
        this.signin = signInCard(this.o.nav);
        this.main.replaceChildren(h('div', { class: 'cp-signin-wrap scroll' }, this.signin.el));
        this.side.replaceChildren();
        this.roomId = null;
        this.view = 'home';
      }
      this.renderIdent();
      return;
    }
    if (this.signin) { this.signin.destroy(); this.signin = null; this.main.replaceChildren(); }
    if (this.roomId && !comms.room(this.roomId)) { this.roomId = null; if (this.view === 'room') this.view = 'home'; }
    this.renderIdent();
    this.list.render();
    const stack = !this.wide && this.view !== 'home';
    this.el.classList.toggle('stack-main', stack);
    let body: HTMLElement;
    switch (this.view) {
      case 'room': body = this.roomBox; this.renderRoom(); break;
      case 'browse': body = this.keep('browse', () => directoryView(this.viewHost)); break;
      case 'search': body = this.keep('search:' + (this.roomId ?? ''), () => searchView(this.viewHost, this.room())); break;
      case 'people': body = this.keep('people', () => peopleView(this.viewHost)); break;
      case 'members': { const r = this.room(); body = r ? membersView(this.viewHost, r) : this.home(); break; }
      default:
        // Wide: the rail is always there, so "home" with a room open is just that room.
        if (this.wide && this.roomId && comms.room(this.roomId)) { this.view = 'room'; this.renderRoom(); body = this.roomBox; } else body = this.home();
    }
    if (this.main.firstChild !== body || this.main.childNodes.length !== 1) this.main.replaceChildren(body);
    this.renderSide();
  }

  /** Secondary views keep their state (typed queries) while the panel re-renders around them. */
  private kept: { kind: string; el: HTMLElement } | null = null;
  private keep(kind: string, make: () => HTMLElement): HTMLElement {
    if (this.kept?.kind !== kind || !this.main.contains(this.kept.el)) this.kept = { kind, el: make() };
    return this.kept.el;
  }

  private renderIdent() {
    const st = comms.state;
    const me = comms.me;
    const lamp = h('span', { class: 'cp-sync ' + st, title: (comms.lastError && st !== 'live' ? comms.lastError + ' — ' : '') + 'Sync: ' + STATE_TEXT[st] }, h('i', null), h('span', { class: 't-label' }, STATE_TEXT[st]));
    if (!me) {
      fill(this.ident, h('div', { class: 'cp-ident-txt' }, h('span', { class: 't-label c-player' }, 'Chat'), h('span', { class: 't-tiny c-hint' }, 'Not signed in')), lamp,
        this.o.onClose ? h('button', { type: 'button', class: 'btn ghost icon mini', title: 'Close', 'aria-label': 'Close', onclick: () => this.o.onClose!() }, '×') : null);
      return;
    }
    const pid = comms.myPlayerId;
    fill(this.ident, 
      face(me, 'cp-face sm'),
      h('div', { class: 'cp-ident-txt' }, h('span', { class: 'cp-ident-name' }, comms.nameOf(me)), h('span', { class: 't-tiny c-hint', title: me }, comms.server)),
      lamp,
      h('button', { type: 'button', class: 'btn ghost icon mini', title: 'Comms menu', 'aria-label': 'Comms menu', onclick: (e: MouseEvent) => popMenu(e.clientX, e.clientY, [
        ...(st === 'stalled' ? [{ label: 'Reconnect now', run: () => comms.reconnect() }] : []),
        ...(pid ? [{ label: 'My commander', run: () => this.o.nav('/player/' + pid) }] : []),
        { label: 'Copy my chat id', run: () => void navigator.clipboard?.writeText(me).then(() => toast('Copied ' + me, 'player', 1600)) },
        { label: 'Sign out of comms', danger: true, run: () => void comms.signOut() },
      ], h('div', { class: 'cp-menu-head t-tiny c-hint' }, me)) }, '⋯'),
      this.o.onClose ? h('button', { type: 'button', class: 'btn ghost icon mini', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => this.o.onClose!() }, '×') : null);
  }

  private renderRoom() {
    const r = this.room();
    if (!r) return;
    // Invite → join and account switches rebuild the Room object: follow the new one.
    if (this.timeline.current !== r) this.timeline.open(r);
    const label = this.label(r);
    const pinned = comms.isPinned(r);
    const muted = comms.chat.muted.has(r.id);
    const n = memberCount(r);
    fill(this.roomHead,
      h('button', { type: 'button', class: 'btn ghost icon cp-back', title: 'Channels', 'aria-label': 'Back to channels', onclick: () => this.back() }, '‹'),
      roomGlyph(r),
      h('div', { class: 'cp-room-title' },
        h('div', { class: 'cp-room-name', title: r.alias || r.id }, label),
        h('div', { class: 'cp-room-topic', title: r.topic ?? '' }, r.topic ? excerpt(r.topic, 140) : r.alias ?? (r.isDirect ? 'Direct channel' : ''))),
      h('div', { class: 'grow' }),
      r.membership === 'join' ? h('button', { type: 'button', class: 'btn ghost mini' + (this.showMembers && this.wide ? ' active' : ''), title: 'Members', onclick: () => this.show('members') }, `◉ ${n}`) : null,
      h('button', { type: 'button', class: 'btn ghost icon mini' + (pinned ? ' active' : ''), title: pinned ? 'Unpin channel' : 'Pin channel', 'aria-label': 'Pin channel', onclick: () => comms.setPinned(r.id, !pinned) }, pinned ? '★' : '☆'),
      h('button', { type: 'button', class: 'btn ghost icon mini', title: 'Channel menu', 'aria-label': 'Channel menu', onclick: (e: MouseEvent) => popMenu(e.clientX, e.clientY, [
        { label: 'Search this channel', run: () => this.show('search') },
        { label: muted ? 'Unmute' : 'Mute', run: () => void comms.setMuted(r.id, !muted).catch((x) => toast(x.message, 'warn')) },
        { label: 'Copy link', run: () => void navigator.clipboard?.writeText(`https://matrix.to/#/${r.alias || r.id}`).then(() => toast('Link copied', 'player', 1400)) },
        { label: 'Leave', danger: true, run: () => void confirmLeave(r, label).then((ok) => { if (ok) this.back(); }).catch((x) => toast(x.message, 'warn')) },
      ], h('div', { class: 'cp-menu-head t-tiny c-hint' }, r.alias || r.id)) }, '⋯'));

    this.renderPins(r);
    this.renderTyping(r);
    if (r.membership === 'invite') {
      this.invite.style.display = '';
      fill(this.invite, 
        r.inviter ? face(r.inviter, 'cp-face big') : null,
        h('div', { class: 'col', style: 'gap:4px' },
          h('div', { class: 't-label c-player' }, 'Incoming hail'),
          h('div', { class: 't-body' }, `${r.inviter ? comms.nameOf(r.inviter, r) : 'Someone'} invites you to ${label}`),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn solid', onclick: () => void comms.join(r.id).then(() => { audio.play('confirm'); this.openRoom(r.id, undefined, true); }).catch((e) => toast(e.message, 'warn')) }, 'Accept'),
            h('button', { type: 'button', class: 'btn ghost', onclick: () => void comms.leave(r.id).then(() => this.back()).catch((e) => toast(e.message, 'warn')) }, 'Decline'))));
    } else { this.invite.style.display = 'none'; this.invite.replaceChildren(); }
    this.timeline.render();
    this.composer.refresh();
    this.composer.el.style.display = r.membership === 'invite' ? 'none' : '';
    this.readNow();
  }

  private renderPins(r: Room) {
    if (!r.pinned.length) { this.pins.style.display = 'none'; return; }
    this.pins.style.display = '';
    const first = r.byId.get(r.pinned[0]);
    const row = (id: string) => {
      const m = r.byId.get(id);
      const b = h('button', { type: 'button', class: 'cp-pin-row', onclick: () => { if (!this.timeline.scrollTo(id)) toast('That message is further back than what is loaded', 'warn', 2200); } },
        h('span', { class: 'cp-pin-who' }, m ? comms.nameOf(m.sender, r) : '…'), h('span', { class: 'cp-pin-text' }, m ? excerpt(m.body, 100) : 'loading'));
      if (!m) void comms.fetchEvent(r.id, id).then((ev) => {
        b.replaceChildren(h('span', { class: 'cp-pin-who' }, ev?.sender ? comms.nameOf(ev.sender, r) : '?'), h('span', { class: 'cp-pin-text' }, ev ? excerpt(String(ev.content?.body ?? 'withdrawn'), 100) : 'out of reach'));
      });
      return b;
    };
    this.pins.replaceChildren(
      h('button', { type: 'button', class: 'cp-pins-head', onclick: () => { this.pinsOpen = !this.pinsOpen; this.renderPins(r); } },
        h('span', { class: 't-label c-neutral' }, `▲ Pinned · ${r.pinned.length}`),
        !this.pinsOpen ? h('span', { class: 'cp-pin-text' }, first ? excerpt(first.body, 90) : '') : null,
        h('span', { class: 'cp-group-caret' }, this.pinsOpen ? '▾' : '▸')),
      ...(this.pinsOpen ? r.pinned.slice(0, 12).map(row) : []));
  }

  private renderTyping(r: Room) {
    const who = r.typing.filter((u) => u !== comms.me);
    if (!who.length) { this.typingEl.classList.remove('on'); this.typingEl.replaceChildren(); return; }
    const names = who.map((u) => comms.nameOf(u, r));
    const text = names.length === 1 ? `${names[0]} is transmitting` : names.length < 4 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are transmitting` : `${names.length} commanders are transmitting`;
    this.typingEl.classList.add('on');
    this.typingEl.replaceChildren(h('span', { class: 'cp-bars' }, h('i'), h('i'), h('i')), h('span', null, text));
  }

  private renderSide() {
    const r = this.room();
    const on = this.wide && this.showMembers && this.view === 'room' && !!r && r.membership === 'join';
    this.el.classList.toggle('with-side', on);
    if (!on) { this.side.replaceChildren(); this.sideKey = ''; return; }
    // Rebuilding resets its scroll: only when who is here (or online) changed.
    const key = `${r!.id}|${[...r!.members.values()].map((m) => m.userId + m.membership).join()}|${comms.chat.presence.size}|${store.players.size}`;
    if (key === this.sideKey && this.side.firstChild) return;
    this.sideKey = key;
    this.side.replaceChildren(membersView({ ...this.viewHost, back: () => { this.showMembers = false; this.renderSide(); this.renderRoom(); } }, r!, { embedded: true }));
  }

  private home(): HTMLElement {
    const rooms = [...comms.chat.rooms.values()];
    const u = comms.unread();
    const missing = DEFAULT_CHANNELS.filter((a) => !comms.roomByAlias(a));
    const recent = rooms.filter((r) => r.membership === 'join' && r.unread > 0).sort((a, b) => b.lastTs - a.lastTs).slice(0, 6);
    const lobby = comms.guildLobby();
    return h('div', { class: 'cp-home scroll' },
      h('div', { class: 'cp-home-mark' }, h('div', { class: 't-label c-hint' }, 'Structs · chat'), h('div', { class: 'cp-home-title' }, 'Chat'),
        h('div', { class: 'cp-home-sub t-tiny c-hint' }, h('span', { class: 'x-only' }, `${comms.me} · ${hostOf(comms.session?.homeserver ?? '')} · `), STATE_TEXT[comms.state])),
      h('div', { class: 'cp-home-stats' },
        stat('Channels', String(rooms.filter((r) => r.membership === 'join' && !r.isDirect).length)),
        stat('Direct', String(rooms.filter((r) => r.isDirect && r.membership === 'join').length)),
        stat('Unread', String(u.count), u.count ? 'warn' : ''),
        stat('Calls for you', String(u.mentions), u.mentions ? 'enemy' : '')),
      recent.length ? h('div', { class: 'cp-home-sec' }, h('div', { class: 't-label c-hint' }, 'Waiting traffic'),
        ...recent.map((r) => h('button', { type: 'button', class: 'cp-chan', onclick: () => this.openRoom(r.id) }, roomGlyph(r), h('span', { class: 'cp-chan-txt' }, h('span', { class: 'cp-chan-name' }, this.label(r))), h('span', { class: 'cp-badge' + (r.highlights || r.isDirect ? ' hot' : '') }, String(r.unread))))) : null,
      h('div', { class: 'cp-home-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => this.show('people') }, 'Message a commander'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => this.show('browse') }, 'Browse channels'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => this.show('search') }, 'Search')),
      missing.length || (lobby && !comms.roomByAlias(lobby)) ? h('div', { class: 'cp-home-sec' }, h('div', { class: 't-label c-hint' }, 'Recommended channels'),
        ...[...(lobby && !comms.roomByAlias(lobby) ? [lobby] : []), ...missing].map((a) => h('div', { class: 'cp-dir-row' }, h('span', { class: 'cp-glyph' }, '#'), h('div', { class: 'grow' }, h('div', { class: 'cp-dir-name' }, a.split(':')[0]), h('div', { class: 't-tiny c-hint' }, a.split(':')[1])),
          h('button', { type: 'button', class: 'btn mini', onclick: () => void comms.join(a).then((id) => this.openRoom(id, undefined, true)).catch((e) => toast('Could not join: ' + e.message, 'warn')) }, 'Join')))) : null,
      h('div', { class: 'cp-home-tips t-tiny c-hint' },
        'Tips: ids like ', h('code', { class: 'cp-code' }, '1-194'), ' or ', h('code', { class: 'cp-code' }, '2-15361'), ' in a message become links — right-click a planet or fleet for its channel. ',
        h('code', { class: 'cp-code' }, '/help'), ' lists commands. ', h('kbd', null, '⌘K'), ' jumps to a channel.'));
  }
}

function stat(label: string, value: string, tone = '') {
  return h('div', { class: 'cp-stat ' + tone }, h('div', { class: 't-label c-hint' }, label), h('div', { class: 'cp-stat-v' }, value));
}

