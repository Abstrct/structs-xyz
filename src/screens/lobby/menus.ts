/* The Concourse windows (dc-concourse.css): dark glass with a fine double line, two soft corners
 * and two tight ones, a tab for a title, the orange cursor bar on the row in focus. Each window is a
 * `.modal-back`, so the pad drives it like any other window (focus moves, A picks, B backs out). */
import { h, toast, portrait } from '../../core/dom';
import { audio } from '../../core/audio';
import { icon } from '../../ui/icons';
import { HUBS } from '../../data/learn';
import { PFP_PARTS, PFP_MAX, familyName, rollAttrs, type PfpAttrs, type PfpPart } from '../../data/droidParts';
import { EMOTES, type Emote } from '../../gfx/droid/actor';
import { STAMPS, PHRASES, stampSvg, decks, type Stamp, type Deck } from './talk';
import type { Station } from './world';

export interface Win { back: HTMLElement; win: HTMLElement; body: HTMLElement; close(): void }

let closeTop: (() => void) | null = null;
export const anyWindow = () => !!document.querySelector('.cw-back');
export function closeWindows() { closeTop?.(); document.querySelectorAll('.cw-back').forEach((b) => b.remove()); closeTop = null; }

/** A window. `place`: where on screen (center, bottom for a counter dialog, ring for menus). */
export function cwWindow(title: string, o: { color?: string; place?: 'center' | 'bottom' | 'ring' | 'left'; cls?: string; onClose?: () => void } = {}): Win {
  closeWindows();
  const body = h('div', { class: 'cw-body' });
  const win = h('div', { class: `cw cw-win ${o.cls ?? ''}`, role: 'dialog', 'aria-label': title, style: o.color ? `--cw-tone:${o.color}` : '' },
    h('span', { class: 'cw-tab' }, title), body);
  const back = h('div', { class: `modal-back cw-back place-${o.place ?? 'center'}` }, win);
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    back.remove();
    window.removeEventListener('keydown', key, true);
    if (closeTop === close) closeTop = null;
    o.onClose?.();
  };
  const key = (e: KeyboardEvent) => {
    const tops = document.querySelectorAll('.modal-back');
    if (tops[tops.length - 1] !== back) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); audio.play('select', 0.5); close(); }
  };
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  window.addEventListener('keydown', key, true);
  closeTop = close;
  document.body.appendChild(back);
  return { back, win, body, close };
}

/** Focus the first control (the pad's cursor always lands somewhere visible). */
export function focusFirst(w: Win) {
  requestAnimationFrame(() => w.body.querySelector<HTMLElement>('button:not([disabled]), input, a[href]')?.focus({ focusVisible: true } as FocusOptions));
}

export const row = (label: string, run: () => void, o: { ico?: string; sub?: string; cls?: string; title?: string } = {}) =>
  h('button', { type: 'button', class: `cw-row ${o.cls ?? ''}`, title: o.title ?? o.sub ?? '', onclick: () => { audio.play('confirm', 0.7); run(); } },
    o.ico ? h('span', { class: 'cw-ico', html: icon(o.ico, 20) }) : null,
    h('span', { class: 'cw-label' }, label),
    o.sub ? h('span', { class: 'cw-sub x-only' }, o.sub) : null);

/* ── A station's dialog: the kiosk lists its hub's places ── */

export interface StationActions {
  go(path: string): void;
  mirror(): void;
  decks(): void;
  palette(): void;
}

export function stationDialog(st: Station, a: StationActions) {
  const w = cwWindow(st.label, { color: st.color, place: 'bottom', cls: 'cw-counter' });
  const list = h('div', { class: 'cw-list' });
  const add = (label: string, run: () => void, ico?: string, sub?: string) => list.append(row(label, () => { w.close(); run(); }, { ico, sub }));
  if (st.kind === 'kiosk') {
    const hub = HUBS.find((x) => x.id === st.hub)!;
    for (const it of hub.items) {
      if (it.path) add(it.label, () => a.go(it.path!), undefined, it.desc);
      else if (it.action === 'palette') add(it.label, () => a.palette(), 'terminal', it.desc);
    }
    if (st.hub === 'base') add('Mirror', () => a.mirror(), 'robot', 'Restyle your droid');
  } else if (st.kind === 'warp') {
    add('Training battle', () => a.go('/sim'), 'target', 'Your fleet against the computer');
    add('Daily challenge', () => a.go('/sim/daily'), 'daily', 'The same battle for everyone today');
    add('Galaxy map', () => a.go('/galaxy'), 'explore', 'Out to the live galaxy');
  } else if (st.kind === 'notice') {
    add('News', () => a.go('/intel'), 'news', 'Live events, raids and rankings');
    add('Replays', () => a.go('/combat'), 'replay', 'Every real attack, shot by shot');
    add('Galaxy map', () => a.go('/galaxy'), 'explore', 'Watch the galaxy live');
  } else if (st.kind === 'academy') {
    add('Lessons', () => a.go('/academy'), 'academy', 'Short lessons with XP');
  } else if (st.kind === 'lift') {
    w.close(); a.decks(); return;
  }
  w.body.append(list);
  focusFirst(w);
}

/* ── Deck select ── */

export function deckWindow(current: Deck, counts: (d: Deck) => number | null, pick: (d: Deck) => void) {
  const w = cwWindow('Decks', { place: 'center', cls: 'cw-decks' });
  const list = h('div', { class: 'cw-list' });
  for (const d of decks()) {
    const n = counts(d);
    list.append(h('button', { type: 'button', class: `cw-row${d.alias === current.alias ? ' on' : ''}`, onclick: () => { audio.play('confirm', 0.7); w.close(); pick(d); } },
      h('span', { class: 'cw-key' }, d.key), h('span', { class: 'cw-label' }, d.name), h('span', { class: 'cw-count', title: 'Here now' }, n === null ? '' : String(n))));
  }
  w.body.append(list);
  focusFirst(w);
}

/* ── The ring menu (Y), stamps (X), emotes, phrases ── */

export interface RingSlot { label: string; ico?: string; html?: string; run(): void }

export function ringWindow(title: string, slots: RingSlot[]) {
  const w = cwWindow(title, { place: 'ring', cls: 'cw-ring' });
  const ring = h('div', { class: 'cr' });
  const label = h('span', { class: 'cr-mid' }, title);
  ring.append(label);
  slots.forEach((s, i) => {
    const a = (i / slots.length) * Math.PI * 2;
    const b = h('button', {
      type: 'button', class: 'cr-slot', 'aria-label': s.label, title: s.label,
      style: `--x:${(Math.sin(a) * 104).toFixed(1)}px; --y:${(-Math.cos(a) * 104).toFixed(1)}px`,
      onclick: () => { audio.play('confirm', 0.7); w.close(); s.run(); },
      onfocus: () => { label.textContent = s.label; },
    }, s.html ? h('span', { class: 'cr-ico', html: s.html }) : s.ico ? h('span', { class: 'cr-ico', html: icon(s.ico, 24) }) : null, h('span', { class: 'cr-word' }, s.label));
    ring.append(b);
  });
  w.body.append(ring);
  focusFirst(w);
  return w;
}

export function stampWindow(send: (s: Stamp) => void) {
  return ringWindow('Stamp', STAMPS.map((s) => ({ label: s.label, html: stampSvg(s, 26), run: () => send(s) })));
}

const EMOTE_LABEL: Record<Emote, string> = { wave: 'Wave', bow: 'Bow', cheer: 'Cheer', shrug: 'Shrug', point: 'Point', sit: 'Sit', yes: 'Nod', no: 'Shake' };
export function emoteWindow(play: (e: Emote) => void) {
  return ringWindow('Emote', EMOTES.map((e) => ({ label: EMOTE_LABEL[e], ico: 'robot', run: () => play(e) })));
}

export function phraseWindow(send: (text: string) => void) {
  const w = cwWindow('Phrase', { place: 'center', cls: 'cw-phrase' });
  const picked: string[] = [];
  const preview = h('div', { class: 'cw-preview', 'aria-live': 'polite' });
  const sendBtn = h('button', { type: 'button', class: 'cw-btn primary', disabled: true, onclick: () => { w.close(); send(picked.join(' ')); } }, h('span', { class: 'dc-face a' }, 'A'), 'Send') as HTMLButtonElement;
  const paint = () => { preview.textContent = picked.length ? picked.join(' ') : 'Pick up to three'; sendBtn.disabled = !picked.length; };
  const grid = h('div', { class: 'cw-grid' }, ...PHRASES.map((p) => h('button', { type: 'button', class: 'cw-chip', onclick: () => { if (picked.length < 3) { picked.push(p); audio.play('tick', 0.6); paint(); } } }, p)));
  const clear = h('button', { type: 'button', class: 'cw-btn', onclick: () => { picked.length = 0; paint(); } }, 'Clear');
  w.body.append(preview, grid, h('div', { class: 'cw-actions' }, clear, sendBtn));
  paint();
  focusFirst(w);
}

/* ── A droid's card ── */

export interface CardActions { reply(): void; open(): void; mute(): boolean; block(): boolean; muted: boolean; blocked: boolean }

export function profileCard(name: string, guild: string | null, attrs: unknown, seed: string, a: CardActions) {
  const w = cwWindow(name, { place: 'center', cls: 'cw-card' });
  const muteBtn = row(a.muted ? 'Unmute' : 'Mute', () => { const on = a.mute(); toast(on ? `${name} muted: no balloons` : `${name} unmuted`, 'player', 2200); w.close(); }, { ico: 'mute', sub: 'Hide their balloons' });
  const blockBtn = row(a.blocked ? 'Unblock' : 'Block', () => { const on = a.block(); toast(on ? `${name} blocked` : `${name} unblocked`, 'player', 2200); w.close(); }, { ico: 'lock', sub: 'Hide their droid and lines' });
  w.body.append(
    h('div', { class: 'cw-who' }, portrait(attrs as string, 'cw-face', seed), h('div', { class: 'cw-who-text' }, h('b', null, name), guild ? h('span', { class: 'cw-sub' }, guild) : null)),
    h('div', { class: 'cw-list' },
      row('Reply', () => { w.close(); a.reply(); }, { ico: 'chat' }),
      row('Commander', () => { w.close(); a.open(); }, { ico: 'eye', sub: 'Their planet, fleet and record' }),
      muteBtn, blockBtn));
  focusFirst(w);
}

/* ── The part picker (the Mirror, and setup's first step) ── */

export const PART_LABEL: Record<PfpPart, string> = { head: 'Head', neck: 'Neck', body: 'Body', arms: 'Arms', background: 'Sky' };
export const PART_ORDER: PfpPart[] = ['head', 'neck', 'body', 'arms', 'background'];

/** Rows of ◀ value ▶, one per layer, plus Roll. `onChange` gets the new attributes. */
export function partRows(attrs: PfpAttrs, onChange: (a: PfpAttrs) => void): { el: HTMLElement; set(a: PfpAttrs): void } {
  let cur = { ...attrs };
  const vals = new Map<PfpPart, HTMLElement>();
  const step = (p: PfpPart, d: number) => {
    cur = { ...cur, [p]: ((cur[p] - 1 + d + PFP_MAX[p]) % PFP_MAX[p]) + 1 };
    audio.play('tick', 0.6);
    paint(); onChange(cur);
  };
  const paint = () => { for (const [p, el] of vals) el.textContent = `${familyName(p, cur[p])} · ${cur[p]}`; };
  const rows = PART_ORDER.map((p) => {
    const v = h('span', { class: 'pr-val' });
    vals.set(p, v);
    return h('div', { class: 'pr-row', 'data-part': p },
      h('span', { class: 'pr-name' }, PART_LABEL[p]),
      h('button', { type: 'button', class: 'pr-step', 'aria-label': `Previous ${PART_LABEL[p].toLowerCase()}`, onclick: () => step(p, -1), html: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>' }),
      v,
      h('button', { type: 'button', class: 'pr-step', 'aria-label': `Next ${PART_LABEL[p].toLowerCase()}`, onclick: () => step(p, 1), html: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>' }));
  });
  const roll = h('button', { type: 'button', class: 'cw-btn pr-roll', 'data-act': 'roll', onclick: () => { cur = rollAttrs(); audio.play('confirm', 0.7); paint(); onChange(cur); } }, h('span', { class: 'dc-face x' }, 'X'), 'Roll');
  const el = h('div', { class: 'pr' }, ...rows, roll);
  // Left/right on a row steps that part (a pad's d-pad, or arrow keys).
  el.addEventListener('keydown', (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>('.pr-row');
    if (!r || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    step(r.dataset.part as PfpPart, e.key === 'ArrowLeft' ? -1 : 1);
  });
  paint();
  return { el, set(a) { cur = { ...a }; paint(); } };
}

export { PFP_PARTS };
