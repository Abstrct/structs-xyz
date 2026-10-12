/* Menus that repaint themselves (the Academy's tiles, the Code Lab's list, the ops pages) replace
 * the very button that has focus. A keyboard or pad player would then find the cursor back at the
 * top of the page, so the cursor is put back where it was in the new paint:
 *   1. a control with a stable key (data-k, e.g. "job:12:cancel") goes back to the same key;
 *   2. failing that, to the same thing's other control ("job:12:retry" once 12 is cancelled);
 *   3. failing that, to the caller's fallback (after a quiz answer, its Next button);
 *   4. an unkeyed control (a tile, a tab) goes back to the same place among the unkeyed ones.
 * A keyed control is never landed on by position, so a press can't hit another move's Cancel. */

const CONTROLS = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Focusable now: not disabled, not hidden, laid out. */
const usable = (el: HTMLElement) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0;
const unkeyed = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(CONTROLS)].filter((el) => !el.dataset.k && usable(el));

/** Run `repaint` over `root`, keeping focus as above if it was inside. */
export function keepFocus(root: HTMLElement, repaint: () => void, fallback?: () => HTMLElement | null) {
  const was = document.activeElement as HTMLElement | null;
  if (!was || was === root || !root.contains(was)) { repaint(); return; }
  const key = was.dataset.k || '';
  const place = key ? -1 : unkeyed(root).indexOf(was);
  repaint();
  const now = document.activeElement;
  if (now && now !== document.body && root.contains(now)) return;
  const find = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)].find(usable) ?? null;
  let to: HTMLElement | null = null;
  if (key) {
    to = find(`[data-k="${CSS.escape(key)}"]`);
    const group = key.includes(':') ? key.slice(0, key.lastIndexOf(':') + 1) : '';
    if (!to && group) to = find(`[data-k^="${CSS.escape(group)}"]`);
    if (!to && fallback) { const f = fallback(); if (f && usable(f)) to = f; }
  } else if (place >= 0) {
    const list = unkeyed(root);
    to = list[Math.min(place, list.length - 1)] ?? null;
  }
  to?.focus({ preventScroll: true });
}
