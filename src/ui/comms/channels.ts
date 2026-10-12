/* The channel list: Pinned, Invitations, Direct, Guild net (rooms on your own server) and
 * Galaxy net (federated), each sorted by last activity, with unread and mention counts,
 * a filter box, collapsible groups and a per-channel menu. */
import { h, toast } from '../../core/dom';
import { audio } from '../../core/audio';
import { comms } from '../../chat/matrix';
import { excerpt, idKind } from '../../chat/format';
import { dmPartner, hiddenRoom, roomLabel, sectionOf, type Room } from '../../chat/model';
import { face, popMenu, presenceDot } from './rich';
import { confirmLeave } from './composer';

type Group = 'pinned' | 'invite' | 'direct' | 'local' | 'galaxy';
const GROUPS: { key: Group; label: string; hint: string }[] = [
  { key: 'pinned', label: 'Pinned', hint: 'Channels kept on top' },
  { key: 'invite', label: 'Invitations', hint: 'Waiting for your answer' },
  { key: 'direct', label: 'Direct', hint: 'One-to-one channels' },
  { key: 'local', label: 'Guild net', hint: 'Channels on your guild’s server' },
  { key: 'galaxy', label: 'Galaxy net', hint: 'Channels on other guilds’ servers' },
];
const FOLD_KEY = 'structs.comms.folded';

export interface ListHost { open(roomId: string): void; active(): string | null }

/** A channel's glyph: planet and fleet rooms by their object kind, else # or a face for DMs. */
export function roomGlyph(r: Room): HTMLElement {
  if (r.isDirect || (r.membership === 'invite' && r.inviteDirect)) {
    const who = dmPartner(r, comms.me);
    if (who) { const f = face(who, 'cp-face xs'); const dot = presenceDot(who); return dot ? h('span', { class: 'cp-glyph-face' }, f, dot) : f; }
  }
  const m = r.alias && /^#(planet|fleet)-(\d+-\d+):/.exec(r.alias);
  if (m) return h('span', { class: 'cp-glyph k-' + (idKind(m[2]) ?? '') }, m[1] === 'planet' ? '◍' : '➤');
  return h('span', { class: 'cp-glyph' }, r.encrypted ? '⌧' : '#');
}

export class ChannelList {
  readonly el: HTMLDivElement;
  readonly filter: HTMLInputElement;
  private list: HTMLDivElement;
  private folded: Set<string>;

  constructor(private host: ListHost) {
    try { this.folded = new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')); } catch { this.folded = new Set(); }
    this.filter = h('input', { class: 'input cp-filter', placeholder: 'Filter channels  ⌘K', spellcheck: false, autocomplete: 'off', 'aria-label': 'Filter channels' }) as HTMLInputElement;
    this.filter.addEventListener('input', () => this.render());
    this.filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.filter.value = ''; this.render(); this.filter.blur(); }
      if (e.key === 'Enter') { const first = this.list.querySelector<HTMLButtonElement>('.cp-chan'); first?.click(); this.filter.value = ''; this.render(); }
    });
    this.list = h('div', { class: 'cp-chans scroll', role: 'navigation', 'aria-label': 'Channels' });
    this.el = h('div', { class: 'cp-chanbox' }, h('div', { class: 'cp-filter-wrap' }, this.filter), this.list);
  }

  render() {
    const me = comms.me;
    const server = comms.server;
    const q = this.filter.value.trim().toLowerCase();
    const groups = new Map<Group, Room[]>(GROUPS.map((g) => [g.key, []]));
    for (const r of comms.chat.rooms.values()) {
      if (hiddenRoom(r)) continue;
      const label = roomLabel(r, me, (u) => comms.nameOf(u, r));
      if (q && !(label.toLowerCase().includes(q) || (r.alias ?? '').toLowerCase().includes(q) || (r.topic ?? '').toLowerCase().includes(q))) continue;
      const sec = sectionOf(r, server);
      const g: Group = sec !== 'invite' && comms.isPinned(r) ? 'pinned' : sec;
      groups.get(g)!.push(r);
    }
    const kids: HTMLElement[] = [];
    for (const g of GROUPS) {
      const rooms = groups.get(g.key)!;
      if (!rooms.length) continue;
      rooms.sort(g.key === 'pinned' ? (a, b) => comms.pinOrder(a) - comms.pinOrder(b) || b.lastTs - a.lastTs : (a, b) => b.lastTs - a.lastTs);
      const fold = this.folded.has(g.key) && !q;
      const unread = rooms.reduce((n, r) => n + (comms.chat.muted.has(r.id) ? 0 : r.unread), 0);
      kids.push(h('button', { type: 'button', class: 'cp-group' + (fold ? ' folded' : ''), title: g.hint, onclick: () => this.fold(g.key) },
        h('span', { class: 'cp-group-caret' }, fold ? '▸' : '▾'), h('span', { class: 't-label' }, g.label), h('span', { class: 'cp-group-n' }, String(rooms.length)),
        fold && unread ? h('span', { class: 'cp-badge' }, unread > 99 ? '99+' : String(unread)) : null));
      if (!fold) for (const r of rooms) kids.push(this.row(r));
    }
    if (!kids.length) {
      kids.push(h('div', { class: 'cp-empty t-tiny c-hint' }, q ? `Nothing matches “${q}”.`
        : comms.state === 'live' ? 'No channels yet. Browse the directory or message a commander.' : 'Establishing link…'));
    }
    this.list.replaceChildren(...kids);
  }

  private fold(g: string) {
    if (this.folded.has(g)) this.folded.delete(g); else this.folded.add(g);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...this.folded])); } catch { /* ignore */ }
    this.render();
  }

  private row(r: Room): HTMLElement {
    const label = roomLabel(r, comms.me, (u) => comms.nameOf(u, r));
    const muted = comms.chat.muted.has(r.id);
    const active = this.host.active() === r.id;
    const last = [...r.timeline].reverse().find((m) => m.kind !== 'system' && m.kind !== 'local');
    const sub = r.membership === 'invite'
      ? `Invited by ${r.inviter ? comms.nameOf(r.inviter, r) : 'someone'}`
      : last ? (last.kind === 'redacted' ? 'withdrawn' : `${last.sender === comms.me ? 'You' : comms.nameOf(last.sender, r)}: ${last.kind === 'image' ? '[image]' : excerpt(last.body, 60)}`) : (r.topic ? excerpt(r.topic, 60) : '');
    const hot = r.membership === 'invite' || (!muted && (r.highlights > 0 || (r.isDirect && r.unread > 0)));
    const badge = r.membership === 'invite' ? h('span', { class: 'cp-badge hot' }, 'new')
      : !muted && r.unread ? h('span', { class: 'cp-badge' + (hot ? ' hot' : '') }, r.highlights && !r.isDirect ? '@' + r.highlights : r.unread > 99 ? '99+' : String(r.unread)) : null;
    const el = h('button', {
      type: 'button', class: 'cp-chan' + (active ? ' active' : '') + (r.unread && !muted ? ' unread' : '') + (muted ? ' muted' : '') + (hot ? ' hot' : ''),
      title: (r.alias || r.id) + (r.topic ? '\n' + r.topic : ''),
      onclick: () => { audio.play('select'); this.host.open(r.id); },
      oncontextmenu: (e: MouseEvent) => { e.preventDefault(); this.menu(e.clientX, e.clientY, r); },
    }, roomGlyph(r),
    h('span', { class: 'cp-chan-txt' }, h('span', { class: 'cp-chan-name' }, label), sub ? h('span', { class: 'cp-chan-sub' }, sub) : null),
    muted ? h('span', { class: 'cp-muted', title: 'Muted' }, '◌') : null,
    badge);
    // Long-press opens the menu on touch screens.
    let t = 0;
    el.addEventListener('touchstart', (e) => { const p = e.touches[0]; t = window.setTimeout(() => this.menu(p.clientX, p.clientY, r), 550); }, { passive: true });
    el.addEventListener('touchend', () => clearTimeout(t));
    el.addEventListener('touchmove', () => clearTimeout(t), { passive: true });
    return el;
  }

  menu(x: number, y: number, r: Room) {
    const label = roomLabel(r, comms.me, (u) => comms.nameOf(u, r));
    const muted = comms.chat.muted.has(r.id);
    const pinned = comms.isPinned(r);
    const err = (e: Error) => toast(e.message, 'warn');
    popMenu(x, y, r.membership === 'invite' ? [
      { label: 'Accept invitation', run: () => void comms.join(r.id).then(() => this.host.open(r.id)).catch(err) },
      { label: 'Decline', danger: true, run: () => void comms.leave(r.id).catch(err) },
    ] : [
      { label: pinned ? 'Unpin' : 'Pin to top', run: () => comms.setPinned(r.id, !pinned) },
      { label: muted ? 'Unmute' : 'Mute', run: () => void comms.setMuted(r.id, !muted).catch(err) },
      { label: 'Mark read', run: () => comms.markRead(r.id) },
      { label: 'Leave', danger: true, run: () => void confirmLeave(r, label).catch(err) },
    ], h('div', { class: 'cp-menu-head t-tiny c-hint' }, label));
  }
}
