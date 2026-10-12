/* Help where you are: a short card for each screen (what it is, three things to try, the lesson
 * that teaches it), and glossary words that explain themselves when you hover or tap them.
 * The game speaks for itself first: cards are off unless a player turns screen tips on (Settings)
 * or asks for one with the ? button or key. */
import { h, showTooltip, hideTooltip } from '../core/dom';
import { audio } from '../core/audio';
import { GUIDES, GLOSSARY, termByKey, HUBS, hubFor, lessonById, trackOf, type Term } from '../data/learn';
import { academy } from '../game/academy';
import { icon } from './icons';

const SEEN_KEY = 'structs.guides.seen';
const ON_KEY = 'structs.tips.on';

function seen(): string[] { try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function markSeen(screen: string) { const s = seen(); if (!s.includes(screen)) { s.push(screen); try { localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch { /* ignore */ } } }
export function tipsOn(): boolean { try { return localStorage.getItem(ON_KEY) === '1'; } catch { return false; } }
export function setTips(on: boolean) { try { if (on) localStorage.setItem(ON_KEY, '1'); else localStorage.removeItem(ON_KEY); } catch { /* ignore */ } if (!on) closeGuide(); }
/** Forget which screens were explained and turn the cards on, so every card shows again. */
export function replayTips() { try { localStorage.removeItem(SEEN_KEY); localStorage.setItem(ON_KEY, '1'); } catch { /* ignore */ } }

let card: HTMLElement | null = null;
let pendingTimer = 0;

export function closeGuide() { clearTimeout(pendingTimer); pendingTimer = 0; card?.remove(); card = null; }

/** The card for a screen: on its first visit (after a beat, so it lands after the fade), or now
 * when asked for. `path` picks the hub colour. */
export function showGuide(screen: string, path: string, navigate: (p: string) => void, force = false) {
  closeGuide();
  const g = GUIDES[screen];
  if (!g) return;
  if (!force && (!tipsOn() || seen().includes(screen))) return;
  const open = () => {
    // A welcome or another modal is up: the card waits for the next screen rather than stacking.
    if (!force && document.querySelector('.modal-back, .title-overlay:not(.out)')) return;
    const hub = HUBS.find((x) => x.id === hubFor(path));
    const color = screen === 'academy' ? '#F3C878' : hub?.color || '#43CDB6';
    const lesson = g.lesson ? lessonById.get(g.lesson) : undefined;
    const got = () => { markSeen(screen); audio.play('select'); closeGuide(); };
    card = h('div', { class: 'guide-card panel', role: 'dialog', 'aria-label': `About ${g.title}`, 'data-screen': screen, style: `--hub:${color}` },
      h('div', { class: 'guide-head' },
        h('span', { class: 'guide-ico', html: icon(screen === 'academy' ? 'academy' : hub?.id || 'explore', 18) }),
        h('div', { class: 'col', style: 'gap:1px; min-width:0' },
          h('span', { class: 'guide-where' }, hub ? `${hub.label} · you are here` : 'You are here'),
          h('span', { class: 'guide-title' }, g.title)),
        h('button', { class: 'btn ghost icon guide-x', 'aria-label': 'Close', onclick: got }, '×')),
      h('div', { class: 'guide-what' }, g.what),
      h('div', { class: 'guide-try-h' }, 'Try this'),
      h('ol', { class: 'guide-tries' }, ...g.tries.map((t) => h('li', null, t))),
      h('div', { class: 'guide-foot' },
        h('button', { class: 'btn solid', onclick: got }, 'Got it'),
        lesson ? h('button', { class: 'btn ghost', onclick: () => { got(); navigate(`/academy/${trackOf(lesson.id)?.id || ''}/${lesson.id}`); } }, h('span', { html: icon('academy', 12) }), academy.isDone(lesson.id) ? 'Lesson done ✓' : `Lesson: ${lesson.title}`) : null,
        h('span', { class: 'grow' }),
        h('button', { class: 'guide-off', onclick: () => { markSeen(screen); setTips(false); } }, 'Hide tips')));
    document.body.appendChild(card);
  };
  if (force) open(); else pendingTimer = window.setTimeout(open, 900);
}

/* ── Glossary words ──────────────────────────────────────────────────────── */

/** A word that explains itself: dotted underline, hover or tap for the plain meaning. */
export function term(key: string, label?: string, cls = ''): HTMLElement {
  const t = termByKey.get(key);
  return h('span', { class: 'term' + (cls ? ' ' + cls : ''), 'data-term': key, tabindex: 0, role: 'button', 'aria-label': t ? `${label || t.word}: ${t.short}` : label || key }, label || t?.word || key);
}

function tipFor(t: Term): HTMLElement {
  return h('div', { class: 'term-tip' }, h('div', { class: 't-label c-player' }, t.word), h('div', { class: 't-tiny' }, t.short));
}

let wired = false;
/** One set of listeners for every term on the page, whenever it was made. The tooltip is shared
 * with the 3D screens' hovers, so these only ever hide a tip a term put up. */
export function wireTerms() {
  if (wired) return;
  wired = true;
  let showing = false;
  const at = (el: Element) => { const r = el.getBoundingClientRect(); return [r.left, r.bottom] as const; };
  const show = (el: Element, x?: number, y?: number) => {
    const t = termByKey.get((el as HTMLElement).dataset.term || '');
    if (!t) return;
    const [ax, ay] = x === undefined ? at(el) : [x, y!];
    showTooltip(ax, ay, tipFor(t), 'player');
    showing = true;
    academy.mark('glossary');
  };
  const hide = () => { if (showing) { showing = false; hideTooltip(); } };
  document.addEventListener('pointerover', (e) => { const el = (e.target as Element)?.closest?.('.term'); if (el && e.pointerType === 'mouse') show(el, e.clientX, e.clientY); });
  document.addEventListener('pointerout', (e) => { const el = (e.target as Element)?.closest?.('.term'); if (el && !el.contains(e.relatedTarget as Node)) hide(); });
  document.addEventListener('focusin', (e) => { const el = (e.target as Element)?.closest?.('.term'); if (el) show(el); });
  document.addEventListener('focusout', (e) => { if ((e.target as Element)?.closest?.('.term')) hide(); });
  // A tap on a term shows its meaning instead of clicking whatever it sits in; a tap elsewhere hides it.
  document.addEventListener('click', (e) => { const el = (e.target as Element)?.closest?.('.term'); if (el) { e.stopPropagation(); show(el); } else hide(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

/** The glossary as a list (the Academy's tab and the manual's). `filter` narrows by word or meaning. */
export function glossaryList(filter = '', onLesson?: (lessonId: string) => void): HTMLElement {
  const q = filter.trim().toLowerCase();
  const rows = GLOSSARY.filter((t) => !q || t.word.toLowerCase().includes(q) || t.short.toLowerCase().includes(q));
  return h('div', { class: 'gloss-list' }, ...(rows.length ? rows.map((t) => h('div', { class: 'gloss-row' },
    h('div', { class: 'gloss-word' }, t.word),
    h('div', { class: 'gloss-short' }, t.short),
    t.lesson && onLesson ? h('button', { class: 'gloss-lesson', onclick: () => onLesson(t.lesson!) }, (academy.isDone(t.lesson) ? '✓ ' : '') + 'Lesson: ' + (lessonById.get(t.lesson)?.title || '')) : null))
    : [h('div', { class: 't-tiny c-hint' }, 'No word matches that. Try “alpha”, “charge” or “hash”.')]));
}
