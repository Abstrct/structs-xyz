/* The welcome: the logo and four doors to walk through (a practice battle, the Academy, the live
 * galaxy, a base of their own), as on the title. The More menu brings it back. */
import { h } from '../core/dom';
import { audio } from '../core/audio';
import { icon, MARK } from './icons';
import { openVault } from './vault';

const KEY = 'structs.welcome.v1';

export function welcomed(): boolean { try { return localStorage.getItem(KEY) === '1'; } catch { return true; } }
export function markWelcomed() { try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } }

export function showWelcome(navigate: (p: string) => void) {
  if (document.querySelector('.welcome-back')) return;
  const done = () => { markWelcomed(); back.remove(); window.removeEventListener('keydown', key, true); };
  // Escape is the welcome's only while it is the window on top (the vault or palette may open over it).
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const modals = document.querySelectorAll('.modal-back');
    if (modals[modals.length - 1] !== back) return;
    e.stopImmediatePropagation(); done();
  };
  // The title's four doors, each a picture and a word; what each is lives in its title.
  const door = (tone: string, ico: string, word: string, title: string, run: () => void, primary = false) =>
    h('button', { class: 'dc-door ' + tone + (primary ? ' primary' : ''), title, onclick: () => { audio.play('confirm'); done(); run(); } },
      h('span', { class: 'dc-door-ico', html: icon(ico, 56) }), h('span', { class: 'dc-door-word' }, word));
  const back = h('div', { class: 'modal-back welcome-back', onclick: (e: Event) => { if (e.target === back) done(); } },
    h('div', { class: 'modal panel player welcome dc-welcome', role: 'dialog', 'aria-label': 'Welcome to Structs',
      title: 'A galaxy full of robot commanders, all racing for Alpha Matter. Every move is real: it is saved on a blockchain anyone can read.' },
      h('div', { class: 'dc-logo' }, h('span', { class: 'dc-mark', html: MARK }), h('span', { class: 'wl-title' }, 'STRUCTS')),
      h('div', { class: 'dc-doors wl-doors' },
        door('enemy', 'target', 'Battle', 'Fight a practice battle: no account needed', () => navigate('/sim'), true),
        door('academy', 'academy', 'Learn', 'The Academy: short lessons with XP', () => navigate('/academy')),
        door('secondary', 'explore', 'Watch', 'The live galaxy and real battles', () => navigate('/galaxy')),
        door('player', 'base', 'Enlist', 'Start your own base: free', () => { navigate('/command'); openVault(); })),
      h('div', { class: 'wl-foot' },
        h('span', { class: 't-tiny c-hint', title: 'This is the practice network: its tokens are for playing, not real money.' }, 'Practice network · no real money'),
        h('button', { class: 'btn ghost', onclick: done }, h('span', { class: 'dc-face b' }, 'B'), 'Skip'))));
  document.body.appendChild(back);
  window.addEventListener('keydown', key, true);
  (back.querySelector('.dc-door.primary') as HTMLElement | null)?.focus({ preventScroll: true });
}
