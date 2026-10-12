/* The timeline: a scrolling log of transmissions for one room. Rows are cached by
 * (event, revision, grouping), so a sync that adds one message touches one row. Day
 * dividers, an unread marker, grouped runs from one sender, replies, reactions, media,
 * read receipts as faces on the message each reader reached, and infinite scroll up. */
import { h, copyText, toast, confirmBox } from '../../core/dom';
import { audio } from '../../core/audio';
import { store } from '../../chain/store';
import { comms } from '../../chat/matrix';
import { COMMANDS, EMOJI_REACTIONS, QUICK_REACTIONS, REACTION_ART, STRUCT_ART, dayKey, dayLabel, excerpt, playerOfUser, stripReplyFallback, timeHM } from '../../chat/format';
import { canRedactOthers, canState, firstUnreadIndex, reactionsOf, roomLabel, type Msg, type Room } from '../../chat/model';
import { face, fmtBytes, nameplate, popMenu, reactionGlyph, renderBody, toneOf, type Nav } from './rich';

export interface TimelineHost {
  nav: Nav;
  reply(m: Msg): void;
  edit(m: Msg): void;
  mention(userId: string): void;
  openObject(id: string): void;
  dm(userId: string): void;
}

const GROUP_MS = 5 * 60_000;

export class Timeline {
  readonly el: HTMLDivElement;
  private list: HTMLDivElement;
  private top: HTMLDivElement;
  private jump: HTMLButtonElement;
  private latest: HTMLButtonElement;
  private room: Room | null = null;
  private rows = new Map<string, { key: string; el: HTMLElement }>();
  private unreadAt: string | null = null;
  private newBelow = 0;
  private lastCount = 0;
  private seenRows = new Set<HTMLElement>();
  private selected: string | null = null;

  constructor(private host: TimelineHost) {
    this.list = h('div', { class: 'cp-log', role: 'log', 'aria-live': 'polite' });
    this.top = h('div', { class: 'cp-top' });
    this.el = h('div', { class: 'cp-timeline scroll' }, this.top, this.list);
    this.jump = h('button', { type: 'button', class: 'cp-jump up', onclick: () => this.toUnread() }) as HTMLButtonElement;
    this.latest = h('button', { type: 'button', class: 'cp-jump down', onclick: () => this.toBottom(true) }) as HTMLButtonElement;
    this.el.addEventListener('scroll', () => this.onScroll(), { passive: true });
  }

  /** The floating jump buttons live in the panel next to the scroller. */
  get overlays() { return [this.jump, this.latest]; }

  open(room: Room | null) {
    this.room = room;
    this.rows.clear();
    this.list.replaceChildren();
    this.selected = null;
    this.newBelow = 0;
    if (!room) return;
    const i = firstUnreadIndex(room, comms.me);
    this.unreadAt = i >= 0 ? room.timeline[i].id : null;
    this.lastCount = room.timeline.length;
    this.render(true);
    requestAnimationFrame(() => {
      if (this.unreadAt) this.scrollTo(this.unreadAt, false, 'center'); else this.toBottom(false);
      // A short room can't scroll; fetch older history right away so it fills the view.
      if (this.el.scrollHeight <= this.el.clientHeight + 40) void this.older();
    });
  }

  get current() { return this.room; }

  get atBottom() { return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 48; }

  render(opening = false) {
    const r = this.room;
    if (!r) return;
    const wasBottom = opening || this.atBottom;
    const fromBottom = this.el.scrollHeight - this.el.scrollTop;
    const firstBefore = this.list.querySelector('.cp-msg, .cp-sys')?.getAttribute('data-id');

    this.paintTop(r);
    const kids: Element[] = [];
    let prev: Msg | null = null;
    const now = Date.now();
    const keep = new Set<string>();
    for (const m of r.timeline) {
      if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) kids.push(h('div', { class: 'cp-day' }, h('span', null, dayLabel(m.ts, now))));
      if (m.id === this.unreadAt) kids.push(h('div', { class: 'cp-unread-mark' }, h('span', null, 'New transmissions')));
      const grouped = !!prev && prev.sender === m.sender && m.ts - prev.ts < GROUP_MS && dayKey(prev.ts) === dayKey(m.ts)
        && isChat(prev) && isChat(m) && m.kind !== 'emote' && prev.kind !== 'emote' && m.id !== this.unreadAt;
      const key = `${m.rev}|${grouped ? 1 : 0}|${m.id === this.selected ? 1 : 0}|${store.players.size}`;
      let row = this.rows.get(m.id);
      if (!row || row.key !== key) {
        row = { key, el: this.row(r, m, grouped) };
        this.rows.set(m.id, row);
      }
      keep.add(m.id);
      kids.push(row.el);
      prev = m;
    }
    for (const id of [...this.rows.keys()]) if (!keep.has(id)) this.rows.delete(id);
    // Same rows in the same order (typing, receipts): leave the DOM alone, so selection and focus survive.
    const cur = this.list.children;
    if (cur.length !== kids.length || kids.some((k, i) => cur[i] !== k)) {
      // Day dividers and the unread mark are rebuilt each time; reuse the old ones when the text matches.
      for (let i = 0; i < kids.length; i++) {
        const old = cur[i] as HTMLElement | undefined;
        if (old && old !== kids[i] && !old.hasAttribute('data-id') && old.className === kids[i].className && old.textContent === kids[i].textContent) kids[i] = old;
      }
      if (cur.length !== kids.length || kids.some((k, i) => cur[i] !== k)) this.list.replaceChildren(...kids);
    }
    this.paintSeen(r);

    const firstNow = this.list.querySelector('.cp-msg, .cp-sys')?.getAttribute('data-id');
    if (wasBottom) this.toBottom(false);
    else if (firstBefore && firstNow !== firstBefore) this.el.scrollTop = this.el.scrollHeight - fromBottom;

    // Count arrivals while scrolled up, for the ↓ button.
    const grew = r.timeline.length - this.lastCount;
    if (!wasBottom && grew > 0 && !opening) this.newBelow += grew;
    this.lastCount = r.timeline.length;
    this.paintJumps();
  }

  private paintTop(r: Room) {
    const label = roomLabel(r, comms.me, (u) => comms.nameOf(u, r));
    if (r.reachedStart) {
      this.top.replaceChildren(h('div', { class: 'cp-origin' },
        h('div', { class: 't-label c-hint' }, 'Channel origin'),
        h('div', { class: 'cp-origin-name' }, label),
        r.topic ? h('div', { class: 't-tiny c-hint' }, r.topic) : null,
        r.encrypted ? h('div', { class: 't-tiny c-warn' }, 'End-to-end encrypted: this client cannot read or send here.') : null));
    } else if (comms.isPaging(r.id)) {
      this.top.replaceChildren(h('div', { class: 'cp-loading' }, h('i', { class: 'cp-spin' }), h('span', { class: 't-label' }, 'Retrieving older transmissions')));
    } else if (r.prevBatch) {
      this.top.replaceChildren(h('button', { type: 'button', class: 'btn ghost mini', onclick: () => void this.older() }, 'Load older'));
    } else {
      this.top.replaceChildren(h('div', { class: 't-tiny c-hint cp-loading' }, 'Older history was unloaded — reopen the channel to read further back'));
    }
  }

  private async older() {
    const r = this.room;
    if (!r || r.reachedStart || comms.isPaging(r.id)) return;
    const p = comms.paginate(r.id);
    this.keepAnchor(() => this.paintTop(r));
    try { await p; } catch (e) { toast('Could not load older messages: ' + (e as Error).message, 'warn'); }
    if (this.room === r) this.keepAnchor(() => this.paintTop(r));
  }

  /** Change something above the view without moving what the reader is looking at. */
  private keepAnchor(f: () => void) {
    const fromBottom = this.el.scrollHeight - this.el.scrollTop;
    const bottom = this.atBottom;
    f();
    if (!bottom) this.el.scrollTop = this.el.scrollHeight - fromBottom;
  }

  private onScroll() {
    if (this.el.scrollTop < 300) void this.older();
    if (this.room) this.room.holdCap = !this.atBottom;
    if (this.atBottom) this.newBelow = 0;
    this.paintJumps();
  }

  private paintJumps() {
    const r = this.room;
    const unreadEl = this.unreadAt ? this.rows.get(this.unreadAt)?.el : null;
    const above = !!unreadEl && unreadEl.offsetTop < this.el.scrollTop;
    this.jump.style.display = above ? '' : 'none';
    if (above && r) {
      const i = r.timeline.findIndex((m) => m.id === this.unreadAt);
      const n = i < 0 ? 0 : r.timeline.length - i;
      this.jump.textContent = `↑ ${n} new · jump`;
    }
    const far = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight > this.el.clientHeight * 0.6;
    this.latest.style.display = far ? '' : 'none';
    this.latest.textContent = this.newBelow ? `↓ ${this.newBelow} new` : '↓ Latest';
    this.latest.classList.toggle('hot', this.newBelow > 0);
  }

  toBottom(smooth: boolean) {
    this.el.scrollTo({ top: this.el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    this.newBelow = 0;
    this.paintJumps();
  }

  private toUnread() { if (this.unreadAt) this.scrollTo(this.unreadAt, true, 'center'); }

  /** Scroll to an event and flash it. Returns false if it isn't loaded. */
  scrollTo(id: string, smooth = true, block: ScrollLogicalPosition = 'center'): boolean {
    const row = this.rows.get(id)?.el;
    if (!row) return false;
    row.scrollIntoView({ block, behavior: smooth ? 'smooth' : 'auto' });
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
    return true;
  }

  /** Clear the unread marker (the room was read while open). */
  clearUnreadMark() {
    if (!this.unreadAt) return;
    this.unreadAt = null;
    this.list.querySelector('.cp-unread-mark')?.remove();
    this.paintJumps();
  }

  /* ── Rows ──────────────────────────────────────────────────────────────── */

  private row(r: Room, m: Msg, grouped: boolean): HTMLElement {
    if (m.kind === 'system') return this.sysRow(r, m);
    if (m.kind === 'local') return this.localRow(r, m);
    const nav = this.host.nav;
    const tone = toneOf(m.sender);
    const mine = m.sender === comms.me;
    const mentioned = !mine && (m.mentions?.includes(comms.me) || m.pills.some((p) => p.userId === comms.me));
    const cls = ['cp-msg', 'k-' + m.kind, 't-' + tone];
    if (grouped) cls.push('grouped');
    if (mentioned) cls.push('mention');
    if (m.pending) cls.push('pending');
    if (m.failed) cls.push('failed');
    if (m.id === this.selected) cls.push('sel');

    const content = h('div', { class: 'cp-content' });
    if (!grouped) content.appendChild(h('div', { class: 'cp-head' }, nameplate(m.sender, r, nav), h('time', { class: 'cp-time', title: new Date(m.ts).toLocaleString() }, timeHM(m.ts))));
    if (m.replyTo) content.appendChild(this.quote(r, m.replyTo));

    const body = h('div', { class: 'cp-body' });
    if (m.kind === 'redacted') body.appendChild(h('span', { class: 'cp-redacted' }, 'Transmission withdrawn'));
    else if (m.kind === 'encrypted') body.appendChild(h('span', { class: 'cp-redacted' }, '⌧ ' + m.body));
    else if (m.kind === 'emote') body.append(h('span', { class: 'cp-emote-who' }, '* ' + comms.nameOf(m.sender, r) + ' '), ...renderBody(m.body, m.pills, nav, { onObject: this.host.openObject }));
    else if (m.kind === 'image' && m.media) body.appendChild(this.image(m));
    else if (m.kind === 'file' && m.media) body.appendChild(this.file(m));
    else body.append(...renderBody(m.body, m.pills, nav, { onObject: this.host.openObject }));
    if (m.edited && m.kind !== 'redacted') body.appendChild(h('span', { class: 'cp-edited', title: m.editTs ? 'Edited ' + new Date(m.editTs).toLocaleString() : 'Edited' }, ' (edited)'));
    content.appendChild(body);

    if (m.failed) content.appendChild(h('div', { class: 'cp-fail' },
      h('span', { class: 'c-enemy t-tiny' }, 'Not sent: ' + m.failed), ' ',
      h('button', { type: 'button', class: 'btn mini', onclick: () => comms.retry(r.id, m.id) }, 'Retry'),
      h('button', { type: 'button', class: 'btn ghost mini', onclick: () => comms.discard(r.id, m.id) }, 'Discard')));

    const reacts = reactionsOf(r, m.id, comms.me);
    if (reacts.length) {
      content.appendChild(h('div', { class: 'cp-reacts' }, ...reacts.map((x) => h('button', {
        type: 'button', class: 'cp-react' + (x.mine ? ' mine' : ''),
        title: x.who.map((u) => comms.nameOf(u, r)).join(', ') + (REACTION_ART[x.key] ? ' — ' + REACTION_ART[x.key].label : ` — ${x.key}`),
        onclick: (e: Event) => { e.stopPropagation(); audio.play('tick'); void comms.toggleReaction(r.id, m.id, x.key).catch((err) => toast(String(err.message), 'warn')); },
      }, reactionGlyph(x.key), h('span', { class: 'n' }, String(x.count)))),
      h('button', { type: 'button', class: 'cp-react add', title: 'React', onclick: (e: MouseEvent) => { e.stopPropagation(); this.picker(e, r, m); } }, '+')));
    }
    content.appendChild(h('div', { class: 'cp-seen' }));

    const gutter = grouped
      ? h('div', { class: 'cp-gutter' }, h('time', { class: 'cp-time ghost' }, timeHM(m.ts)))
      : h('div', { class: 'cp-gutter' }, (() => {
        const f = face(m.sender);
        const pid = playerOfUser(m.sender);
        if (pid) { f.classList.add('link'); f.addEventListener('click', (e) => { e.stopPropagation(); nav('/player/' + pid); }); }
        return f;
      })());

    const el = h('div', { class: cls.join(' '), 'data-id': m.id, onclick: (e: Event) => this.toggleSelect(e, m) }, gutter, content, this.actions(r, m));
    return el;
  }

  private toggleSelect(e: Event, m: Msg) {
    // Touch screens have no hover: a tap shows the message's actions.
    if ((e.target as HTMLElement).closest('a, button, .cp-ref, .cp-img')) return;
    if (!matchMedia('(hover: none), (pointer: coarse)').matches) return;
    this.selected = this.selected === m.id ? null : m.id;
    this.render();
  }

  private actions(r: Room, m: Msg): HTMLElement {
    if (m.pending || m.failed || m.kind === 'redacted' || !m.id.startsWith('$')) return h('div', { class: 'cp-acts' });
    const mine = m.sender === comms.me;
    const canText = m.kind === 'text' || m.kind === 'emote' || m.kind === 'notice';
    const b = (glyph: string, title: string, run: (e: MouseEvent) => void, cls = '') =>
      h('button', { type: 'button', class: 'cp-act ' + cls, title, 'aria-label': title, onclick: (e: MouseEvent) => { e.stopPropagation(); run(e); } }, glyph);
    return h('div', { class: 'cp-acts' },
      ...QUICK_REACTIONS.slice(4, 7).map((k) => b(REACTION_ART[k].glyph, REACTION_ART[k].label, () => { audio.play('tick'); void comms.toggleReaction(r.id, m.id, k).catch((e) => toast(String(e.message), 'warn')); }, 'tone-' + REACTION_ART[k].tone)),
      b('☺', 'React', (e) => this.picker(e, r, m)),
      r.encrypted ? null : b('↩', 'Reply', () => this.host.reply(m)),
      mine && canText ? b('✎', 'Edit', () => this.host.edit(m)) : null,
      b('⋯', 'More', (e) => this.more(e, r, m)));
  }

  private more(e: MouseEvent, r: Room, m: Msg) {
    const mine = m.sender === comms.me;
    const pinned = r.pinned.includes(m.id);
    const items = [
      { label: 'Copy text', run: () => copyText(m.body, 'Copied') },
      { label: 'Copy link', run: () => copyText(`https://matrix.to/#/${r.alias || r.id}/${m.id}`, 'Link copied') },
      ...(m.sender !== comms.me ? [{ label: 'Mention ' + comms.nameOf(m.sender, r), run: () => this.host.mention(m.sender) }, { label: 'Direct message', run: () => this.host.dm(m.sender) }] : []),
      ...(canState(r, comms.me, 'm.room.pinned_events') ? [{ label: pinned ? 'Unpin' : 'Pin to channel', run: () => void comms.setPinnedEvent(r.id, m.id, !pinned).catch((x) => toast('Pin refused: ' + x.message, 'warn')) }] : []),
      ...(mine || canRedactOthers(r, comms.me) ? [{
        label: 'Delete', danger: true, run: () => void confirmBox('Withdraw transmission', 'Delete this message for everyone? This cannot be undone.', 'Delete').then((ok) => {
          if (ok) void comms.redact(r.id, m.id).then(() => audio.play('confirm')).catch((x) => toast('Delete refused: ' + x.message, 'warn'));
        }),
      }] : []),
    ];
    popMenu(e.clientX, e.clientY, items, h('div', { class: 'cp-menu-head t-tiny c-hint' }, `${comms.nameOf(m.sender, r)} · ${new Date(m.ts).toLocaleString()}`));
  }

  picker(e: MouseEvent, r: Room, m: Msg) {
    const pick = (k: string) => () => { audio.play('tick'); void comms.toggleReaction(r.id, m.id, k).catch((x) => toast(String(x.message), 'warn')); };
    const grid = h('div', { class: 'cp-picker' },
      h('div', { class: 't-label c-hint' }, 'Signals'),
      h('div', { class: 'cp-pick-row' }, ...QUICK_REACTIONS.map((k) => h('button', { type: 'button', class: 'cp-pick', title: REACTION_ART[k].label + ' ' + k, onclick: pick(k) }, reactionGlyph(k)))),
      h('div', { class: 't-label c-hint' }, 'Structs'),
      h('div', { class: 'cp-pick-row' }, ...STRUCT_ART.map((s) => h('button', { type: 'button', class: 'cp-pick', title: s, onclick: pick(`:struct/${s}:`) }, reactionGlyph(`:struct/${s}:`)))),
      h('div', { class: 't-label c-hint' }, 'Emoji'),
      h('div', { class: 'cp-pick-row' }, ...EMOJI_REACTIONS.map((k) => h('button', { type: 'button', class: 'cp-pick', onclick: pick(k) }, reactionGlyph(k)))));
    // Clicking a pick closes the menu (popMenu closes on its own items only), so close by hand.
    const menu = popMenu(e.clientX, e.clientY, [], grid);
    grid.addEventListener('click', (ev) => { if ((ev.target as HTMLElement).closest('.cp-pick')) menu.remove(); });
  }

  private quote(r: Room, parentId: string): HTMLElement {
    const q = h('button', { type: 'button', class: 'cp-quote', onclick: (e: Event) => { e.stopPropagation(); if (!this.scrollTo(parentId)) toast('That message is further back than what is loaded', 'warn', 2200); } });
    const fill = (sender: string, body: string, redacted = false) => q.replaceChildren(
      h('span', { class: 'cp-quote-arrow' }, '↳'), h('span', { class: 'cp-quote-who t-' + toneOf(sender) }, comms.nameOf(sender, r)),
      h('span', { class: 'cp-quote-text' }, redacted ? 'withdrawn' : excerpt(body, 120)));
    const p = r.byId.get(parentId);
    if (p) fill(p.sender, p.kind === 'image' ? '[image]' : p.body, p.kind === 'redacted');
    else {
      q.replaceChildren(h('span', { class: 'cp-quote-arrow' }, '↳'), h('span', { class: 'cp-quote-text c-hint' }, '…'));
      void comms.fetchEvent(r.id, parentId).then((ev) => {
        if (!ev) { q.replaceChildren(h('span', { class: 'cp-quote-arrow' }, '↳'), h('span', { class: 'cp-quote-text c-hint' }, 'a message out of reach')); return; }
        const body = typeof ev.content?.body === 'string' ? stripReplyFallback(ev.content.body) : '';
        fill(ev.sender ?? '', body, !ev.content?.body);
      });
    }
    return q;
  }

  private image(m: Msg): HTMLElement {
    const media = m.media!;
    const w = media.w || 320, hh = media.h || 240;
    const s = Math.min(1, 320 / w, 240 / hh);
    const box = h('button', { type: 'button', class: 'cp-img', title: m.body, style: `width:${Math.round(w * s)}px; aspect-ratio:${w} / ${hh}` }) as HTMLButtonElement;
    void comms.thumbnail(media.mxc, 640, 480).then((url) => box.appendChild(h('img', { src: url, alt: m.body, draggable: false }))).catch(() => box.appendChild(h('span', { class: 't-tiny c-hint' }, 'image unavailable')));
    box.addEventListener('click', (e) => { e.stopPropagation(); lightbox(media.mxc, m.body); });
    return box;
  }

  private file(m: Msg): HTMLElement {
    const media = m.media!;
    return h('button', {
      type: 'button', class: 'cp-file', title: 'Download',
      onclick: (e: Event) => {
        e.stopPropagation();
        void comms.download(media.mxc).then((url) => { const a = h('a', { href: url, download: media.name || 'file' }); document.body.appendChild(a); a.click(); a.remove(); })
          .catch(() => toast('Download failed', 'warn'));
      },
    }, h('span', { class: 'g' }, '⇩'), h('span', null, media.name || m.body || 'file'), media.size ? h('span', { class: 'c-hint t-tiny' }, fmtBytes(media.size)) : null);
  }

  private sysRow(r: Room, m: Msg): HTMLElement {
    const s = m.sys!;
    const who = comms.nameOf(m.sender, r);
    let text = '';
    if (s.type === 'm.room.member') {
      const tgt = comms.nameOf(s.target ?? '', r);
      const self = s.target === m.sender;
      if (s.membership === 'join') text = `${tgt} joined`;
      else if (s.membership === 'invite') text = `${who} invited ${tgt}`;
      else if (s.membership === 'leave') text = self ? (s.prev === 'invite' ? `${tgt} declined the invitation` : `${tgt} left`) : s.prev === 'ban' ? `${who} lifted the ban on ${tgt}` : `${who} removed ${tgt}`;
      else if (s.membership === 'ban') text = `${who} banned ${tgt}`;
      else text = `${tgt}: ${s.membership}`;
      if (s.reason) text += ` — ${s.reason}`;
    } else if (s.type === 'm.room.topic') text = `${who} set the topic: ${s.text}`;
    else if (s.type === 'm.room.name') text = `${who} renamed the channel to ${s.text}`;
    else if (s.type === 'm.room.pinned_events') text = `${who} changed the pinned messages (${s.pinned})`;
    else if (s.type === 'm.room.tombstone') text = `This channel moved: ${s.text}`;
    return h('div', { class: 'cp-sys', 'data-id': m.id }, h('span', { class: 'cp-sys-dot' }), h('span', null, text), h('time', { class: 'cp-time' }, timeHM(m.ts)));
  }

  private localRow(r: Room, m: Msg): HTMLElement {
    const nav = this.host.nav;
    const l = m.local!;
    let body: HTMLElement;
    if (l.kind === 'help') {
      body = h('div', { class: 'col', style: 'gap:2px' }, h('div', { class: 't-label c-player' }, 'Comms commands'),
        ...COMMANDS.map((c) => h('div', { class: 'cp-help-row' }, h('code', { class: 'cp-code' }, `/${c.name}${c.args ? ' ' + c.args : ''}`), h('span', { class: 'c-hint' }, c.help))),
        h('div', { class: 't-tiny c-hint' }, 'Start a line with // to send a literal slash. Enter sends · Shift+Enter new line · ↑ edits your last · Tab completes · Esc cancels.'));
    } else if (l.kind === 'whois') {
      const pid = String(l.data);
      const p = store.players.get(pid);
      const g = p?.guildId;
      body = h('div', { class: 'cp-whois' },
        face('@' + pid + ':' + comms.server, 'cp-face big'),
        h('div', { class: 'col', style: 'gap:3px; min-width:0' },
          h('div', { class: 't-label c-player' }, 'Dossier'),
          h('div', { class: 'cp-whois-name' }, p?.name || pid),
          h('div', { class: 'row wrap', style: 'gap:6px' },
            ...renderBody([pid, g, p?.planetId, p?.fleetId].filter(Boolean).join(' '), [], nav, { onObject: this.host.openObject })),
          !p ? h('div', { class: 't-tiny c-warn' }, 'Not in the loaded roster.') : null,
          h('div', { class: 'row', style: 'gap:6px; margin-top:4px' },
            h('button', { type: 'button', class: 'btn mini', onclick: () => nav('/player/' + pid) }, 'View'),
            h('button', { type: 'button', class: 'btn ghost mini', onclick: () => { const uid = comms.userIdForPlayer(pid); if (uid) this.host.dm(uid); else toast('Their guild runs no comms server', 'warn'); } }, 'Message'))));
    } else if (l.kind === 'who') {
      const ids = (l.data as string[]) ?? [];
      body = h('div', { class: 'col', style: 'gap:4px' }, h('div', { class: 't-label c-player' }, `Spoke here (${ids.length})`),
        ids.length ? h('div', { class: 'row wrap', style: 'gap:6px' }, ...ids.map((u) => nameplate(u, r, nav))) : h('div', { class: 'c-hint t-tiny' }, 'Nobody in what is loaded.'));
    } else {
      body = h('div', { class: (l.kind === 'error' ? 'c-enemy' : 'c-hint') + ' t-tiny' }, m.body);
    }
    return h('div', { class: 'cp-local', 'data-id': m.id }, h('span', { class: 'cp-local-tag t-label' }, 'local'), body);
  }

  /** Read receipts: each reader's face sits on the last message they read. */
  private paintSeen(r: Room) {
    for (const el of this.seenRows) el.querySelector('.cp-seen')?.replaceChildren();
    this.seenRows.clear();
    const at = new Map<string, string[]>();
    for (const [user, rc] of r.receipts) {
      if (user === comms.me) continue;
      const list = at.get(rc.eventId) ?? [];
      list.push(user);
      at.set(rc.eventId, list);
    }
    for (const [eventId, users] of at) {
      const row = this.rows.get(eventId)?.el;
      const slot = row?.querySelector('.cp-seen');
      if (!row || !slot) continue;
      const others = users.filter((u) => u !== r.byId.get(eventId)?.sender);
      if (!others.length) continue;
      slot.replaceChildren(...others.slice(0, 6).map((u) => { const f = face(u, 'cp-face xs'); f.title = 'Seen by ' + comms.nameOf(u, r); return f; }),
        others.length > 6 ? h('span', { class: 't-tiny c-hint' }, '+' + (others.length - 6)) : '');
      slot.setAttribute('title', 'Seen by ' + others.map((u) => comms.nameOf(u, r)).join(', '));
      this.seenRows.add(row);
    }
  }
}

const isChat = (m: Msg) => m.kind !== 'system' && m.kind !== 'local';

/** A full-size look at an image (fetched with the token, shown from a blob URL). */
function lightbox(mxc: string, alt: string) {
  const img = h('img', { alt, draggable: false });
  const back = h('div', { class: 'modal-back cp-lightbox', onclick: () => back.remove() }, img, h('div', { class: 't-tiny c-hint' }, alt));
  document.body.appendChild(back);
  void comms.thumbnail(mxc, 1600, 1200).then((u) => { img.src = u; }).catch(() => back.remove());
}
