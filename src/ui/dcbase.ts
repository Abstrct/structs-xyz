/* The DC base kit, shared by My Base (screens/command.ts) and the planet dossier (screens/planet.ts):
 *   vital   an icon and a big number; its name and what it means show on hover, focus or tap
 *   head    a panel titled by an icon and a word or two
 *   face    the round A/B/X/Y badge that marks a button's verb
 * Explanations live in the tips, never on the screen itself. */
import '../styles/dc-base.css';
import { h, hideTooltip, showTooltip } from '../core/dom';
import { icon } from './icons';

type Kid = Node | string | null | undefined | false;

/** The element whose tip is up. Pointing or tapping anywhere else puts it away (and a repaint that
 * replaced it under a still pointer: the next move lands outside it). */
let owner: Element | null = null;
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  const away = (e: Event) => { if (owner && !(owner.isConnected && owner.contains(e.target as Node))) { owner = null; hideTooltip(); } };
  document.addEventListener('pointerover', away, true);
  document.addEventListener('pointerdown', away, true);
}

let seq = 0;
/** Its name, and what it means, in the shared tooltip: on hover, on keyboard focus, on a tap. For a
 * screen reader the name is the element's label (a plain element reads as one picture) and the
 * meaning its description, kept in a hidden child. */
export function tip<T extends HTMLElement>(el: T, label: string, hint = '', kind = 'player'): T {
  wire();
  el.setAttribute('aria-label', label);
  if (!el.getAttribute('role') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el.setAttribute('role', 'img');
  if (hint) { const id = 'dcb-d' + ++seq; el.setAttribute('aria-describedby', id); el.append(h('span', { id, hidden: true }, hint)); }
  const body = h('div', { class: 'dcb-tip' }, h('div', { class: 't-label' }, label), hint ? h('div', { class: 't-tiny' }, hint) : null);
  const at = (x: number, y: number) => { owner = el; showTooltip(x, y, body, kind); };
  const below = () => { const r = el.getBoundingClientRect(); at(r.left, r.bottom + 4); };
  el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') at(e.clientX, e.clientY); });
  el.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && owner === el) at(e.clientX, e.clientY); });
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && owner === el) { owner = null; hideTooltip(); } });
  el.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') below(); });
  el.addEventListener('focus', below);
  el.addEventListener('blur', () => { if (owner === el) { owner = null; hideTooltip(); } });
  return el;
}

/** A vital: icon + big number (+ an optional meter after it). `cls` tints it: c-player, c-enemy, hot…
 * Its name says the number too ("Alpha 12.5 g"), unless the label already does. */
export function vital(ico: string, value: string | Node, label: string, hint = '', cls = '', ...after: Kid[]): HTMLElement {
  const name = typeof value === 'string' && /\d/.test(value) && !label.includes(value.replace(/^→\s*/, '')) ? `${label} ${value}` : label;
  // Where nothing hovers (touch, a pad in hand) the icon gets its word, small, after the number
  // (dc-base.css shows it). A dash means "nothing to show": Expert keeps it, everyone else skips it.
  const empty = value === '—' ? ' empty' : '';
  return tip(h('span', { class: 'dcb-vital ' + cls + empty, tabindex: 0 },
    h('span', { class: 'dcb-ico', html: icon(ico, 20) }), h('b', { class: 'dcb-n' }, value), h('span', { class: 'dcb-cap', 'aria-hidden': 'true' }, label.split(':')[0]),
    ...after.filter((x): x is Node | string => !!x)), name, hint);
}

/** A panel's title bar: an icon and a word or two (`hint` in its tip), then anything on its right. */
export function head(ico: string, label: string | Node, hint = '', ...right: Kid[]): HTMLElement {
  const t = h('span', { class: 'dcb-head-t' }, h('span', { class: 'dcb-ico', html: icon(ico, 18) }), h('span', { class: 't-label' }, label));
  return h('div', { class: 'panel-head dcb-head' }, hint ? tip(t, typeof label === 'string' ? label : label.textContent || '', hint) : t,
    ...right.filter((x): x is Node | string => !!x));
}

/** A pill button: icon and (maybe) one word; its full meaning on hover. */
export function pill(ico: string, word: string, title: string, onclick: (e: MouseEvent) => void, cls = 'btn ghost'): HTMLButtonElement {
  return h('button', { class: cls + ' dcb-pill' + (word ? '' : ' only'), title, 'aria-label': word ? null : title, onclick },
    h('span', { class: 'dcb-ico', html: icon(ico, 18) }), word ? h('span', null, word) : null);
}

/** The round face-button badge. */
export const face = (k: 'a' | 'b' | 'x' | 'y') => h('span', { class: 'dc-face ' + k, 'aria-hidden': 'true' }, k.toUpperCase());

/** The advisor's picture for each piece of advice (advisor.ts ids). */
export function adviceIcon(id: string): string {
  const base = id.split(':')[0];
  return ({ offline: 'power', away: 'ship', 'ore-risk': 'ore', 'ore-refining': 'alpha', explore: 'explore', mine: 'mine', power: 'power', building: 'build', idle: 'charge', pdc: 'shield' } as Record<string, string>)[base] || 'star';
}
