/* Rendering helpers shared by the comms views: message bodies as safe DOM (text nodes,
 * chips and links built element by element — never innerHTML), faces and name plates
 * for Matrix users who are players, reaction glyphs, and the small popover menu. */
import { h, portrait } from '../../core/dom';
import { store } from '../../chain/store';
import { comms } from '../../chat/matrix';
import { guildInfo } from '../../chat/guilds';
import { idKind, playerOfUser, REACTION_ART, refRoute, segment, structReaction, type Pill } from '../../chat/format';
import type { Room } from '../../chat/model';

export type Nav = (hash: string) => void;

/** replaceChildren that skips the nulls conditional children leave behind. */
export function fill(el: Element, ...kids: (Node | string | null | undefined | false)[]) {
  el.replaceChildren(...kids.filter((k): k is Node | string => k != null && k !== false));
}

/** A message body: text, links (http/https only), chain-id chips and mention pills. */
export function renderBody(body: string, pills: Pill[], nav: Nav, opts: { onObject?: (id: string) => void } = {}): Node[] {
  const out: Node[] = [];
  for (const s of segment(body, pills)) {
    if (s.t === 'text') out.push(document.createTextNode(s.s));
    else if (s.t === 'code') out.push(h('code', { class: 'cp-code' }, s.s));
    else if (s.t === 'url') {
      let ok = false;
      try { ok = /^https?:$/.test(new URL(s.href).protocol); } catch { ok = false; }
      out.push(ok ? h('a', { class: 'cp-link', href: s.href, target: '_blank', rel: 'noopener noreferrer nofollow' }, s.s) : document.createTextNode(s.s));
    } else if (s.t === 'mention') out.push(mentionPill(s.userId, s.s, nav));
    else if (s.t === 'id') out.push(idChip(s.id, nav, opts.onObject));
  }
  return out;
}

export function mentionPill(userId: string, text: string, nav: Nav): HTMLElement {
  const me = userId === comms.me;
  const pid = playerOfUser(userId);
  const label = pid ? '@' + comms.nameOf(userId) : text.startsWith('@') ? text : '@' + text;
  return h('button', {
    class: 'cp-pill' + (me ? ' me' : ''), title: userId, type: 'button',
    onclick: (e: Event) => { e.stopPropagation(); if (pid) nav('/player/' + pid); },
  }, label);
}

const KIND_GLYPH: Record<string, string> = { guild: '◆', player: '◉', planet: '◍', struct: '▣', fleet: '➤', reactor: '⚛', substation: '⌁', provider: '⇄', agreement: '§' };

/** A chain id as a chip: player/planet/struct/fleet/guild, named when the store knows it. */
export function idChip(id: string, nav: Nav, onObject?: (id: string) => void): HTMLElement {
  const kind = idKind(id) ?? 'object';
  let name = '';
  if (kind === 'player') name = store.players.get(id)?.name || '';
  else if (kind === 'guild') name = guildInfo(id)?.meta?.name || (store.guilds.has(id) ? store.guildName(id) : '');
  else if (kind === 'planet') { const o = store.planets.get(id)?.owner; name = o ? store.playerName(o) + '’s world' : ''; }
  else if (kind === 'fleet') { const o = store.fleets.get(id)?.owner; name = o ? store.playerName(o) + '’s fleet' : ''; }
  const route = refRoute(id);
  const chip = h('button', {
    type: 'button', class: `cp-ref k-${kind}`, title: `${kind} ${id}${name ? ' — ' + name : ''}${onObject && (kind === 'planet' || kind === 'fleet') ? ' · right-click for its channel' : ''}`,
    onclick: (e: Event) => { e.stopPropagation(); if (route) nav(route); },
    oncontextmenu: (e: MouseEvent) => {
      if (!onObject || (kind !== 'planet' && kind !== 'fleet')) return;
      e.preventDefault();
      popMenu(e.clientX, e.clientY, [
        { label: `Open ${kind}`, run: () => route && nav(route) },
        { label: `Open ${kind} channel`, run: () => onObject(id) },
      ]);
    },
  }, h('span', { class: 'g' }, KIND_GLYPH[kind] ?? '•'), h('span', { class: 'id' }, id), name ? h('span', { class: 'nm' }, name) : null);
  return chip;
}

/** Whose side is this user on, from where I stand: me, my guild, or anyone else. */
export function toneOf(userId: string): 'me' | 'ally' | 'other' {
  if (userId === comms.me) return 'me';
  const mine = comms.myGuildId();
  const theirs = comms.guildOf(userId);
  return mine && theirs === mine ? 'ally' : 'other';
}

export function face(userId: string, cls = 'cp-face'): HTMLElement {
  const pid = playerOfUser(userId);
  const attrs = pid ? store.players.get(pid)?.pfpClientRenderAttributes : null;
  const t = toneOf(userId);
  return portrait(attrs, `${cls} ${t === 'me' || t === 'ally' ? 'player' : ''}`, userId);
}

export function guildTagChip(userId: string): HTMLElement | null {
  const g = comms.guildOf(userId);
  const tag = comms.guildTag(g);
  return tag ? h('span', { class: 'cp-tag', title: g ? `${store.guildName(g)} (${g})` : '' }, tag) : null;
}

export function nameplate(userId: string, room: Room | null, nav: Nav): HTMLElement {
  const t = toneOf(userId);
  const pid = playerOfUser(userId);
  return h('span', { class: 'cp-plate' },
    h('button', { type: 'button', class: 'cp-name t-' + t, title: userId, onclick: (e: Event) => { e.stopPropagation(); if (pid) nav('/player/' + pid); } }, comms.nameOf(userId, room)),
    guildTagChip(userId));
}

/** Presence lamp: nothing if the server never said. */
export function presenceDot(userId: string): HTMLElement | null {
  const p = comms.chat.presence.get(userId);
  if (!p) return null;
  const s = p.currentlyActive ? 'online' : p.presence;
  return h('i', { class: 'cp-lamp ' + s, title: s + (p.statusMsg ? ' — ' + p.statusMsg : '') });
}

/** A reaction key as a glyph: the game's shortcodes, struct portraits, or the key itself (emoji). */
export function reactionGlyph(key: string): HTMLElement {
  const art = REACTION_ART[key];
  if (art) return h('span', { class: 'cp-rg tone-' + art.tone, title: art.label }, art.glyph);
  const st = structReaction(key);
  if (st) return h('img', { class: 'cp-rg-img', src: `/img/structs/${st}/${st}-struct-base.webp`, alt: st, title: st, draggable: false });
  return h('span', { class: 'cp-rg emoji' }, key.length > 12 ? key.slice(0, 12) + '…' : key);
}

/* ── Popover menu ────────────────────────────────────────────────────────── */
let openMenu: HTMLElement | null = null;
export interface MenuItem { label: string; run: () => void; danger?: boolean; hint?: string }
export function closeMenu() { openMenu?.remove(); openMenu = null; }
export function popMenu(x: number, y: number, items: MenuItem[], content?: HTMLElement) {
  closeMenu();
  const m = h('div', { class: 'cp-menu panel', role: 'menu' },
    content ?? null,
    ...items.map((it) => h('button', { type: 'button', role: 'menuitem', class: 'cp-mi' + (it.danger ? ' danger' : ''), onclick: () => { closeMenu(); it.run(); } },
      h('span', null, it.label), it.hint ? h('span', { class: 'c-hint t-tiny' }, it.hint) : null)));
  document.body.appendChild(m);
  const w = m.offsetWidth, hh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, window.innerHeight - hh - 8)) + 'px';
  openMenu = m;
  const off = (e: Event) => {
    if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
    if (e.type === 'pointerdown' && m.contains(e.target as Node)) return;
    closeMenu();
    window.removeEventListener('pointerdown', off, true);
    window.removeEventListener('keydown', off, true);
  };
  setTimeout(() => { window.addEventListener('pointerdown', off, true); window.addEventListener('keydown', off, true); }, 0);
  return m;
}

/** Bytes for humans. */
export function fmtBytes(n?: number) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
