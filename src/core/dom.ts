/* A tiny DOM kit: hyperscript, toasts, banners and a shared tooltip. */
import { withBase } from './base';

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: Partial<CSSStyleDeclaration> | string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      // false means "absent" for attributes, but it is a real value for element properties (draggable, spellcheck).
      if (v === false && typeof (el as unknown as Record<string, unknown>)[k] !== 'boolean') continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'html') {
        el.innerHTML = String(v);
      } else if ((k === 'href' || k === 'src') && typeof v === 'string' && v.startsWith('/') && !v.startsWith('//')) {
        // Root-relative links and files live under the site's base path (core/base.ts).
        el.setAttribute(k, withBase(v));
      } else if (k in el && typeof v !== 'string') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element) { while (el.firstChild) el.removeChild(el.firstChild); }

export const ui = () => document.getElementById('ui') as HTMLDivElement;

/* ── Toasts ─────────────────────────────────────────────────────────────── */
let toastBox: HTMLDivElement | null = null;
/** Good news waiting for the screen to be ready for it (PRESS START shows the logo alone). Trouble
 * (an enemy or warning toast, an enemy banner: a raid) never waits: it shows, with its sound, at once. */
let held: { run: () => void; big: boolean }[] | null = null;
/** Hold good-news toasts and banners while `on`; letting go plays every banner (a promotion, a badge)
 * and the latest toasts, four in all at most, one by one. */
export function holdNotices(on: boolean) {
  if (on) { held ||= []; return; }
  const q = held;
  held = null;
  if (!q) return;
  const big = q.filter((n) => n.big), small = q.filter((n) => !n.big).slice(-Math.max(1, 4 - big.length));
  [...big, ...small].forEach((n, i) => setTimeout(n.run, 300 + i * 450));
}
/** Run `f` (a sound and the banner it belongs to) now, or with the held notices when they play.
 * `big`: a banner's moment (a promotion, a badge); those are never trimmed away. */
export function whenNoticesShow(f: () => void, big = false) {
  if (!held) { f(); return; }
  held.push({ run: f, big });
  if (held.length > 12) { const i = held.findIndex((n) => !n.big); held.splice(i < 0 ? 0 : i, 1); }
}

/** Rewards (a lesson done, a mission paid) waiting for a fight's results screen. */
let rewardsHeld: (() => void)[] | null = null;
/** A fight keeps its rewards for the results (they printed over the fleets at the first shot); letting
 * go plays the latest three, one by one. */
export function holdRewards(on: boolean) {
  if (on) { rewardsHeld ||= []; return; }
  const q = rewardsHeld;
  rewardsHeld = null;
  q?.slice(-3).forEach((f, i) => setTimeout(f, 700 + i * 450));
}
/** Show a reward (its sound and toast) now, or with the fight's results. */
export function whenRewardsShow(f: () => void) {
  if (!rewardsHeld) { f(); return; }
  rewardsHeld.push(f);
  if (rewardsHeld.length > 8) rewardsHeld.shift();
}

export function toast(text: string, kind: '' | 'player' | 'enemy' | 'warn' = '', ms = 3200, action?: { label: string; run: () => void }) {
  if (held && kind !== 'enemy' && kind !== 'warn') { whenNoticesShow(() => toast(text, kind, ms, action)); return; }
  if (!toastBox || !toastBox.isConnected) { toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastBox); }
  const t = h('div', { class: 'toast ' + kind + (action ? ' has-action' : '') }, text,
    action ? h('button', { class: 'toast-act', onclick: () => { action.run(); t.remove(); } }, action.label) : null);
  toastBox.appendChild(t);
  while (toastBox.children.length > 4) toastBox.firstElementChild?.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, ms);
}

/** Copy text and say so. The async clipboard is missing on plain-http hosts and can be refused,
 * so fall back to a hidden textarea, and as a last resort hand the text over in a prompt. */
export function copyText(text: string, ok: string, ms = 1600) {
  const fallback = () => {
    const ta = h('textarea', { readonly: true, style: 'position:fixed; left:-9999px; top:0; opacity:0' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    ta.remove();
    if (copied) toast(ok, 'player', ms);
    else window.prompt('Copy this:', text);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast(ok, 'player', ms), fallback);
  else fallback();
}

/* ── Banner ─────────────────────────────────────────────────────────────── */
export function banner(big: string, small: string, kind: 'player' | 'enemy' | 'neutral', ms = 2200) {
  const b = h('div', { class: 'banner ' + kind, role: 'status', 'aria-live': 'assertive' }, h('div', { class: 'small' }, small), h('div', { class: 'big' }, big));
  // Held (see holdNotices): it shows later, as a new banner; this one is never shown.
  if (held && kind !== 'enemy') { whenNoticesShow(() => banner(big, small, kind, ms), true); return b; }
  // Two at once (a victory and a promotion) stack rather than print over each other.
  const live = document.querySelectorAll('.banner:not(.out)').length;
  // (--stack too: the title places its banners in its own band, stacked by the same step.)
  if (live) { b.style.top = `calc(38% + ${live * 124}px)`; b.style.setProperty('--stack', `${live * 96}px`); }
  document.body.appendChild(b);
  if (ms > 0) setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 520); }, ms);
  return b;
}

/* ── Tooltip ────────────────────────────────────────────────────────────── */
let tip: HTMLDivElement | null = null;
let flashTimer = 0;
export function showTooltip(x: number, y: number, content: Node | string, kind = '') {
  // A newer tooltip outlives an older flash's countdown (flashTooltip sets its own after this).
  clearTimeout(flashTimer);
  if (!tip || !tip.isConnected) { tip = h('div', { class: 'tooltip' }); document.body.appendChild(tip); }
  tip.className = 'tooltip on ' + kind;
  clear(tip);
  tip.appendChild(typeof content === 'string' ? document.createTextNode(content) : content);
  const w = tip.offsetWidth, hgt = tip.offsetHeight;
  // Beside the pointer, flipped near an edge, and never off the screen (a phone is narrower than
  // most tooltips are flipped by). The CSS nudges it 14 px right and down, so the clamp allows for that.
  const clamp = (v: number, max: number) => Math.max(-6, Math.min(v, max));
  const px = clamp(x + 14 + w > window.innerWidth ? x - w - 28 : x, window.innerWidth - w - 22);
  const py = clamp(y + 14 + hgt > window.innerHeight ? y - hgt - 28 : y, window.innerHeight - hgt - 22);
  tip.style.left = px + 'px';
  tip.style.top = py + 'px';
}
export function hideTooltip() { if (tip) tip.classList.remove('on'); }
/** Show a tooltip for a few seconds (a touch tap's stand-in for hover). One shared timer, so a newer
 *  bubble is never hidden by an older one's countdown. */
export function flashTooltip(x: number, y: number, content: Node | string, ms = 2800) {
  showTooltip(x, y, content);
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(hideTooltip, ms);
}

/* ── Fade ───────────────────────────────────────────────────────────────── */
export function fade(on: boolean): Promise<void> {
  const f = document.getElementById('fade')!;
  f.classList.toggle('on', on);
  return new Promise((r) => setTimeout(r, on ? 460 : 10));
}

/* ── Portraits ──────────────────────────────────────────────────────────── */
const PFP_PARTS = ['background', 'body', 'arms', 'neck', 'head'] as const;
const PFP_MAX: Record<string, number> = { background: 6, body: 57, arms: 34, neck: 10, head: 87 };
/** Layered pixel portrait from a player's pfpClientRenderAttributes JSON. */
export function portrait(attrs: string | Record<string, number> | null | undefined, cls = '', seed = ''): HTMLDivElement {
  let a: Record<string, number> = {};
  // Player-set data: anything but a plain object (null, a number, an array) counts as no portrait.
  try { const v = typeof attrs === 'string' ? JSON.parse(attrs || '{}') : attrs; a = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {}; } catch { a = {}; }
  if (!Object.keys(a).length) {
    // No portrait on chain: derive one deterministically so the face is stable.
    let n = 2166136261;
    for (const c of seed || 'anon') n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0;
    for (const p of PFP_PARTS) { a[p] = 1 + (n % PFP_MAX[p]); n = Math.imul(n ^ (n >>> 13), 2654435761) >>> 0; }
  }
  const box = h('div', { class: 'pfp ' + cls });
  for (const p of PFP_PARTS) {
    const i = Math.max(1, Math.min(PFP_MAX[p], Number(a[p]) || 1));
    box.appendChild(h('img', { src: `/img/pfp/${p}/pfp_${p}_${i}.webp`, alt: '', draggable: false }));
  }
  return box;
}

/* ── Confirm ────────────────────────────────────────────────────────────── */
const openConfirms = new Set<() => void>();
/** Close every open confirm as "no" (screens call this on exit, so nothing dangles). */
export function dismissConfirms() { [...openConfirms].forEach((f) => f()); }

export function confirmBox(title: string, text: string, ok = 'Confirm', tone: 'player' | 'enemy' = 'enemy'): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      openConfirms.delete(cancel);
      back.remove();
      window.removeEventListener('keydown', key, true);
      resolve(v);
    };
    const cancel = () => done(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); done(false); return; }
      if (e.key !== 'Enter') return;
      e.stopImmediatePropagation();
      // A held key that opened the dialog must not also answer it; a focused button answers for itself.
      if (e.repeat) { e.preventDefault(); return; }
      if (back.contains(document.activeElement) && document.activeElement instanceof HTMLButtonElement) return;
      e.preventDefault();
      done(true);
    };
    const back = h('div', { class: 'modal-back confirm-back', onclick: (e: Event) => { if (e.target === back) done(false); } },
      h('div', { class: 'modal panel ' + tone, style: 'width:min(400px, calc(100vw - 32px))' },
        h('div', { class: 'panel-head' }, h('span', { class: 't-label' }, title)),
        h('div', { class: 'panel-body col' },
          h('div', { class: 't-body' }, text),
          h('div', { class: 'row', style: 'justify-content:flex-end; margin-top:6px' },
            h('button', { class: 'btn ghost', onclick: () => done(false) }, 'Cancel'),
            h('button', { class: 'btn ' + (tone === 'enemy' ? 'danger' : 'solid'), onclick: () => done(true) }, ok)))));
    document.body.appendChild(back);
    // A destructive question starts on Cancel: a stray Enter keeps things as they were.
    if (tone === 'enemy') (back.querySelector('.btn.ghost') as HTMLButtonElement | null)?.focus();
    window.addEventListener('keydown', key, true);
    openConfirms.add(cancel);
  });
}
