/* Player settings: sound levels, bloom, resolution, reduced motion.
 * Persisted per browser; applied to the engine and the audio graph. */
import type { Engine, Look } from './engine';
import { audio } from './audio';
import { h, confirmBox } from './dom';
import { commander } from '../chain/commander';
import { ALERT_KINDS, mutedKinds, setMuted } from '../game/alerts';
import { tipsOn, setTips, replayTips } from '../ui/guide';
import { academy } from '../game/academy';

/** `expert`: show the technical layer (chain links, block heights, raw event names, data sources);
 * off by default so the game reads plainly. Everything stays reachable either way. */
export interface Settings { volume: number; music: number; bloom: boolean; quality: 'high' | 'low'; look: Look; reduceMotion: boolean; expert: boolean; bigText: boolean }
const KEY = 'structs.settings';
const DEFAULTS: Settings = {
  volume: 0.8, music: 0.55, bloom: true, quality: 'high', look: 'dc', expert: false, bigText: false,
  reduceMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
};

export function loadSettings(): Settings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Settings> & { proHud?: boolean };
    // The old "pro status bar" switch became expert mode.
    return { ...DEFAULTS, ...v, expert: v.expert ?? !!v.proHud };
  } catch { return { ...DEFAULTS }; }
}

/** Flip expert mode from anywhere (the More menu, the command line). */
export function setExpert(engine: Engine, on: boolean) {
  // An open Settings window holds its own copy: close it so it can't save the old switch back.
  document.querySelector('.settings-back')?.remove();
  // From storage (another tab may have changed it), unless storage refused this tab's last change.
  const s: Settings = { ...(saveRefused && applied ? applied : loadSettings()), expert: on };
  save(s);
  applySettings(engine, s);
}
/** Whether the last save was refused (then this tab's applied settings are the only copy). */
let saveRefused = false;
function save(s: Settings) { try { localStorage.setItem(KEY, JSON.stringify(s)); saveRefused = false; } catch { saveRefused = true; } }

let applied: Settings | null = null;
export function applySettings(engine: Engine, s: Settings) {
  audio.setVolume(s.volume);
  audio.setMusicVolume(s.music * 0.6);
  // Resolution and bloom reallocate render targets: only on an actual change.
  if (!applied || applied.bloom !== s.bloom) engine.setBloom(s.bloom);
  if (!applied || applied.quality !== s.quality) engine.setQuality(s.quality);
  if (!applied || applied.look !== s.look) engine.setLook(s.look === 'modern' ? 'modern' : 'dc');
  engine.reduceMotion = s.reduceMotion;
  // Expert mode: the technical layer shows (.x-only), the plain stand-ins step aside (.s-only).
  document.body.classList.toggle('expert', !!s.expert);
  if (s.expert) academy.mark('expert');
  // Larger text: the small labels and fine print step up a size.
  document.body.classList.toggle('big-text', !!s.bigText);
  applied = { ...s };
}

export function openSettings(engine: Engine) {
  if (document.querySelector('.settings-back')) { document.querySelector<HTMLElement>('.settings-back .panel-head button')?.click(); return; }
  const s = loadSettings();
  const commit = () => { save(s); applySettings(engine, s); };
  const slider = (label: string, key: 'volume' | 'music') => {
    const val = h('span', { class: 'num c-hint' }, Math.round(s[key] * 100) + '%');
    const input = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(s[key] * 100)), class: 'range', 'aria-label': label }) as HTMLInputElement;
    input.addEventListener('input', () => { s[key] = Number(input.value) / 100; val.textContent = input.value + '%'; commit(); });
    return h('div', { class: 'set-row' }, h('span', { class: 't-label c-hint' }, label), input, val);
  };
  const head = (text: string) => h('div', { class: 'set-head' }, text);
  const toggle = (label: string, on: () => boolean, flip: () => void, hint: string) => {
    const b = h('button', { class: 'btn ghost mini' + (on() ? ' active' : '') }, on() ? 'On' : 'Off') as HTMLButtonElement;
    b.addEventListener('click', () => { flip(); b.classList.toggle('active', on()); b.textContent = on() ? 'On' : 'Off'; commit(); });
    // The name on the row; what it does is its title (the screen says it in one or two words).
    return h('div', { class: 'set-row', title: hint }, h('span', { class: 't-label c-hint' }, label), h('div', { class: 'grow' }), b);
  };
  const tipsRow = toggle('Screen tips', () => tipsOn(), () => { setTips(!tipsOn()); }, 'A short guide the first time you open each screen (? brings it back any time)');
  // Where the cursor was: closing hands it back there.
  const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const close = () => {
    back.remove();
    window.removeEventListener('keydown', keys, true);
    if (opener?.isConnected) opener.focus({ preventScroll: true, focusVisible: document.body.classList.contains('pad') } as FocusOptions);
  };
  const back = h('div', { class: 'modal-back settings-back', onclick: (e: Event) => { if (e.target === back) close(); } },
    h('div', { class: 'modal panel player', role: 'dialog', 'aria-label': 'Settings', style: 'width:min(420px, calc(100vw - 32px))' },
      h('div', { class: 'panel-head' }, h('span', { class: 't-label' }, 'Settings'), h('button', { class: 'btn ghost icon', 'aria-label': 'Close', title: 'Close (Esc / B)', onclick: () => close() }, '×')),
      h('div', { class: 'panel-body col scroll', style: 'gap:10px; max-height: calc(var(--vh, 100vh) - 140px)' },
        head('Sound & picture'),
        slider('Sound', 'volume'),
        slider('Music', 'music'),
        toggle('Dreamcast picture', () => s.look !== 'modern', () => { s.look = s.look === 'modern' ? 'dc' : 'modern'; }, '640×480-style drawing in 16-bit colour; off for the full-resolution modern picture'),
        toggle('Glow effects', () => s.bloom, () => { s.bloom = !s.bloom; }, 'Glow on lights, shots and explosions (turn off if the game feels slow)'),
        toggle('Sharp picture', () => s.quality === 'high', () => { s.quality = s.quality === 'high' ? 'low' : 'high'; }, 'Draw at up to twice the pixels (turn off if the game feels slow)'),
        toggle('Reduce motion', () => s.reduceMotion, () => { s.reduceMotion = !s.reduceMotion; }, 'No camera shake, flashes or slow motion'),
        toggle('Larger text', () => s.bigText, () => { s.bigText = !s.bigText; }, 'Bigger labels and small print, easier to read'),
        head('Help & learning'),
        tipsRow,
        toggle('Expert mode', () => s.expert, () => { s.expert = !s.expert; }, 'Show the technical details: chain links and block height in the top bar, raw event names, data sources'),
        h('div', { class: 'set-row', title: 'Show every screen’s guide card again' }, h('span', { class: 't-label c-hint' }, 'Replay tips'), h('div', { class: 'grow' }),
          h('button', { class: 'btn ghost mini', onclick: (e: Event) => {
            replayTips();
            (e.currentTarget as HTMLButtonElement).textContent = 'Done';
            // Replaying turns the tips back on: say so on their toggle.
            const b = tipsRow.querySelector('button');
            if (b) { b.classList.add('active'); b.textContent = 'On'; }
          } }, 'Replay')),
        h('div', { class: 'set-row', title: 'Clear lesson progress, for a new learner on this computer (XP you earned stays)' }, h('span', { class: 't-label c-hint' }, 'Start the Academy over'), h('div', { class: 'grow' }),
          h('button', { class: 'btn ghost mini', onclick: async (e: Event) => {
            const b = e.currentTarget as HTMLButtonElement;
            if (!(await confirmBox('Start over', 'Clear every Academy lesson on this computer? Your rank and XP stay.', 'Start over', 'enemy'))) return;
            academy.reset(); replayTips();
            // A new learner gets the first-battle steps again too.
            try { for (const k of Object.keys(localStorage)) if (k.startsWith('structs.coach.')) localStorage.removeItem(k); } catch { /* ignore */ }
            b.textContent = 'Done';
            const tb = tipsRow.querySelector('button');
            if (tb) { tb.classList.add('active'); tb.textContent = 'On'; }
          } }, 'Reset')),
        head('Alerts for your commanders'),
        ...ALERT_KINDS.map(([k, label]) => {
          const on = () => !mutedKinds().has(k);
          const b = h('button', { class: 'btn ghost mini' + (on() ? ' active' : '') }, on() ? 'On' : 'Off') as HTMLButtonElement;
          b.addEventListener('click', () => { setMuted(k, on()); b.classList.toggle('active', on()); b.textContent = on() ? 'On' : 'Off'; });
          return h('div', { class: 'set-row' }, h('span', { class: 't-label c-hint' }, label), h('div', { class: 'grow' }), b);
        }),
        (() => {
          const b = h('button', { class: 'btn ghost mini' + (commander.desktopAlerts ? ' active' : '') }, commander.desktopAlerts ? 'On' : 'Off') as HTMLButtonElement;
          b.addEventListener('click', () => { void commander.setDesktopAlerts(!commander.desktopAlerts).then((on) => { b.classList.toggle('active', on); b.textContent = on ? 'On' : 'Off'; }); });
          return h('div', { class: 'set-row', title: 'Pop up a notification when your pinned commander is raided or fired on, even in another tab' }, h('span', { class: 't-label c-hint' }, 'Desktop notifications'), h('div', { class: 'grow' }), b);
        })(),
      )));
  document.body.appendChild(back);
  /* Keys while Settings is the window on top (a pad's buttons arrive as these keys): Escape (B)
   * closes it; up and down walk every control in order, sliders included; left and right move a
   * slider in focus (and stay on it); A presses the button in focus (the pad clicks it). */
  const controls = () => [...back.querySelectorAll<HTMLElement>('.panel-body button, .panel-body input, .panel-head button')]
    .filter((el) => el.getClientRects().length && !(el as HTMLButtonElement).disabled);
  const go = (el: HTMLElement | undefined) => { if (!el) return; el.focus({ focusVisible: true } as FocusOptions); el.scrollIntoView({ block: 'nearest' }); audio.play('hover', 0.6); };
  function keys(e: KeyboardEvent) {
    if (!back.isConnected) { window.removeEventListener('keydown', keys, true); return; }
    const backs = document.querySelectorAll('.modal-back');
    if (backs[backs.length - 1] !== back || e.metaKey || e.ctrlKey || e.altKey) return;   // a window above it (Start over's confirm) keeps its keys
    const a = document.activeElement as HTMLElement | null;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    if (!/^Arrow(Up|Down|Left|Right)$/.test(e.key)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (a instanceof HTMLInputElement && a.type === 'range' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const v = Math.max(0, Math.min(100, Number(a.value) + (e.key === 'ArrowRight' ? 5 : -5)));
      if (String(v) !== a.value) { a.value = String(v); a.dispatchEvent(new Event('input', { bubbles: true })); audio.play('tick', 0.5); }
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return;
    const list = [...controls().filter((el) => !el.closest('.panel-head')), ...controls().filter((el) => el.closest('.panel-head'))];
    // The × sits last in the walk (it is up in the head): down from the last row reaches it, up from it comes back.
    const i = a ? list.indexOf(a) : -1;
    go(list[i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]);
  }
  window.addEventListener('keydown', keys, true);
  // The cursor starts on the first control (the Sound slider), so a pad can begin at once.
  requestAnimationFrame(() => controls().find((el) => !el.closest('.panel-head'))?.focus({ preventScroll: true, focusVisible: document.body.classList.contains('pad') } as FocusOptions));
}
