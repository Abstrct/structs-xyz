/* The controller: any standard gamepad drives the game the way a Dreamcast pad would.
 *   A      press the control in focus, or Enter (fire the aimed shot, open a door)
 *   B      Escape (back out, cancel aiming)
 *   X / Y  G / D in battle (guard, drift)
 *   L / R  Shift+Tab / Tab (previous / next ship)
 *   Start  Space (PRESS START on the title, pause in battle)
 *   Back   Menu: focus jumps to the hubs in the top bar (from any screen, even one that keeps the
 *          d-pad for itself, like replay stepping); in a window on top it backs out instead
 *   D-pad and left stick: arrow keys. A screen that uses arrows (aiming, menus, the title's doors)
 *   takes them; otherwise focus moves to the nearest control in that direction.
 * Every button becomes a key event, so screens need no pad code of their own. Polling starts with
 * the first connected pad and stops when the last one leaves. */

import { audio } from './audio';

type Btn = { key: string; shift?: boolean };
const MAP: Record<number, Btn> = {
  1: { key: 'Escape' }, 2: { key: 'g' }, 3: { key: 'd' }, 4: { key: 'Tab', shift: true }, 5: { key: 'Tab' },
  9: { key: ' ' }, 12: { key: 'ArrowUp' }, 13: { key: 'ArrowDown' }, 14: { key: 'ArrowLeft' }, 15: { key: 'ArrowRight' },
};
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const REPEAT_DELAY = 320, REPEAT_EVERY = 110, STICK = 0.55;

let polling = 0;
const held = new Map<string, number>();

/* A screen that reads the pad itself (the lobby walks on the sticks). While its function returns
 * true it sees every poll's pads, and this file sends no keys except Back's Menu; a window on top
 * (.modal-back) always gets the pad back. Buttons pressed while captured count as held, so a press
 * that opens a menu doesn't also click the menu's first item when the capture lets go. */
type Capture = (pads: Gamepad[]) => boolean;
let capture: Capture | null = null;
export function capturePad(fn: Capture): () => void {
  capture = fn;
  if (readPads().length && !polling) polling = requestAnimationFrame(poll);
  return () => { if (capture === fn) capture = null; };
}

/** Send a key as if typed, to whatever has focus. Returns false when a handler took it (preventDefault). */
function press(key: string, shift = false): boolean {
  const target = (document.activeElement && document.activeElement !== document.body ? document.activeElement : window) as EventTarget;
  const init: KeyboardEventInit = { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, shiftKey: shift, bubbles: true, cancelable: true };
  const free = target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return free;
}

function visible(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && el.closest('[inert]') === null;
}

/** Move focus to the nearest control in a direction, preferring the open window on top. */
export function moveFocus(dir: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight') {
  const backs = document.querySelectorAll<HTMLElement>('.modal-back');
  const scope = backs[backs.length - 1] || document.body;
  const all = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
  if (!all.length) return;
  const cur = document.activeElement as HTMLElement | null;
  const from = cur && all.includes(cur) ? cur.getBoundingClientRect() : null;
  if (!from) { focus(all[0]); return; }
  const cx = from.left + from.width / 2, cy = from.top + from.height / 2;
  const [dx, dy] = dir === 'ArrowUp' ? [0, -1] : dir === 'ArrowDown' ? [0, 1] : dir === 'ArrowLeft' ? [-1, 0] : [1, 0];
  let best: HTMLElement | null = null, bestScore = Infinity;
  let wide: HTMLElement | null = null, wideScore = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2 - cx, y = r.top + r.height / 2 - cy;
    const along = x * dx + y * dy;
    if (along <= 4) continue;
    // Straight ahead beats off to the side: sideways distance costs twice as much. Something
    // within 45° of the direction pressed always wins over something further round.
    const side = Math.abs(x * dy - y * dx);
    const score = along + 2 * side;
    if (side <= along) { if (score < bestScore) { bestScore = score; best = el; } }
    else if (score < wideScore) { wideScore = score; wide = el; }
  }
  const pick = best ?? wide;
  if (pick) focus(pick);
}

function focus(el: HTMLElement) {
  audio.play('hover', 0.6);
  el.focus({ preventScroll: false, focusVisible: true } as FocusOptions);
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function down(name: string, fire: () => void) {
  const now = performance.now();
  const since = held.get(name);
  if (since === undefined) { held.set(name, now); fire(); return; }
  // Held: repeat, as a key would, but only for the directions.
  if (name.startsWith('Arrow') && now - since > REPEAT_DELAY) { held.set(name, now - REPEAT_DELAY + REPEAT_EVERY); fire(); }
}

function poll() {
  polling = 0;
  // Counted for the studio's pad bots (scripts/studio/cdp.mjs PAD_STUB): a bot's press is seen by
  // exactly one poll, however slow the frames, so it can never become a held, repeating d-pad.
  const w = window as unknown as { __padPolls?: number };
  w.__padPolls = (w.__padPolls ?? 0) + 1;
  const pads = readPads();
  // The last pad left: a screen reading the sticks hears it (or its droid walks on forever).
  if (!pads.length) { held.clear(); capture?.([]); return; }
  const now = new Set<string>();
  for (const p of pads) {
    p.buttons.forEach((b, i) => { if (b.pressed) now.add(i === 0 ? 'A' : i === 8 ? 'MENU' : MAP[i] ? `${MAP[i].key}${MAP[i].shift ? '+shift' : ''}#${i}` : ''); });
    const [ax = 0, ay = 0] = p.axes;
    if (ax < -STICK) now.add('ArrowLeft#s'); if (ax > STICK) now.add('ArrowRight#s');
    if (ay < -STICK) now.add('ArrowUp#s'); if (ay > STICK) now.add('ArrowDown#s');
  }
  now.delete('');
  const taken = !!capture && !document.querySelector('.modal-back') && capture(pads);
  if (taken && now.size) document.body.classList.add('pad');
  for (const name of now) {
    // Kept fresh while the screen has it: a stick still pushed when the capture lets go mustn't
    // count as long-held and auto-repeat into the window that just opened.
    if (taken && name !== 'MENU') { held.set(name, performance.now()); continue; }
    down(name, () => {
      document.body.classList.add('pad');
      if (name === 'MENU') {
        // A window on top: back out of it. Otherwise the hubs: the current screen's, or the first.
        if (document.querySelector('.modal-back')) { press('Escape'); return; }
        const hub = document.querySelector<HTMLElement>('.topbar .hub.active') || document.querySelector<HTMLElement>('.topbar .hub');
        if (hub) focus(hub);
        return;
      }
      if (name === 'A') {
        const el = document.activeElement as HTMLElement | null;
        if (el && el !== document.body && el.matches('button, a[href], [role="button"], summary, input[type="checkbox"], input[type="radio"]')) el.click();
        else press('Enter');
        return;
      }
      const [key, shift] = name.split('#')[0].split('+');
      const free = press(key, !!shift);
      if (free && key.startsWith('Arrow')) moveFocus(key as 'ArrowUp');
    });
  }
  for (const name of [...held.keys()]) if (!now.has(name)) held.delete(name);
  polling = requestAnimationFrame(poll);
}

/** The connected pads; none where the page may not read them (a frame without allow="gamepad" throws). */
function readPads(): Gamepad[] {
  try { return navigator.getGamepads ? [...navigator.getGamepads()].filter((p): p is Gamepad => !!p && p.connected) : []; } catch { return []; }
}

/** The Jump Pack: a hit or a blast rumbles every connected pad that can (strength 0..1+). */
export function rumble(strength: number) {
  if (!polling) return;
  const k = Math.min(1, Math.max(0, strength));
  for (const p of readPads()) {
    const act = (p as Gamepad & { vibrationActuator?: { playEffect?: (t: string, o: object) => Promise<unknown> } }).vibrationActuator;
    act?.playEffect?.('dual-rumble', { duration: Math.round(60 + k * 220), strongMagnitude: k, weakMagnitude: Math.min(1, k * 0.6 + 0.1) })?.catch(() => { /* not this pad */ });
  }
}

/** Listen for pads; the first one to connect starts the polling loop. */
export function startPad() {
  window.addEventListener('gamepadconnected', () => { if (!polling) polling = requestAnimationFrame(poll); });
  // A pad already plugged in before the page loaded shows up on its first button press.
  if (readPads().length && !polling) polling = requestAnimationFrame(poll);
  // The mouse or a touch takes over: the pad's focus rings step back.
  window.addEventListener('pointerdown', () => document.body.classList.remove('pad'), { passive: true });
}
