/* The comms dock: a right-side drawer holding a narrow CommsPanel, and a ready-made
 * top-bar button with the unread badge. Mounting it resumes a saved comms session and
 * starts the alerts; the panel itself is built on first open. */
import { h } from '../../core/dom';
import { audio } from '../../core/audio';
import { comms, type Unread } from '../../chat/matrix';
import { CommsPanel } from './panel';
import { setCommsOpener, startCommsAlerts } from './alerts';
import type { Nav } from './rich';
import { goTo } from '../../core/nav';

export interface CommsDock {
  /** The drawer (already in the document). */
  el: HTMLElement;
  /** A top-bar button that toggles the drawer, with the unread badge on it. */
  button: HTMLButtonElement;
  toggle(): void;
  open(roomId?: string): void;
  /** Open the drawer with `text` waiting in the composer (nothing is sent until the person sends it). */
  draft(text: string): void;
  close(): void;
  isOpen(): boolean;
}

let dock: CommsDock | null = null;

export function mountCommsDock(navigate: Nav = (path) => { goTo(path); }): CommsDock {
  if (dock) return dock;
  startCommsAlerts();
  const el = h('aside', { class: 'cp-dock', 'aria-label': 'Comms', 'aria-hidden': 'true' });
  document.body.appendChild(el);
  let panel: CommsPanel | null = null;
  let isOpen = false;

  const badge = h('span', { class: 'cp-dock-badge' });
  const button = h('button', {
    type: 'button', class: 'btn ghost icon cp-dock-btn', title: 'Chat with your guild (C)', 'aria-label': 'Chat',
    onclick: () => { audio.play('select'); d.toggle(); },
    html: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1 2h12v8H6l-3 3v-3H1z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 5h6M4 7h4" stroke="currentColor" stroke-width="1.2"/></svg>',
  }) as HTMLButtonElement;
  button.appendChild(badge);
  const paint = (u: Unread) => {
    const n = u.mentions || u.count;
    badge.textContent = n ? (n > 99 ? '99+' : String(n)) : '';
    badge.classList.toggle('on', n > 0);
    badge.classList.toggle('hot', u.mentions > 0);
    button.title = n ? `Chat — ${u.count} unread${u.mentions ? `, ${u.mentions} for you` : ''} (C)` : 'Chat with your guild (C)';
  };
  comms.onUnread(paint);
  comms.onState((s) => button.classList.toggle('cp-dock-live', s === 'live'));

  const d: CommsDock = {
    el, button,
    isOpen: () => isOpen,
    open(roomId?: string) {
      // The full comms screen is up: it takes the room instead of a second panel.
      if (CommsPanel.full) { if (roomId) CommsPanel.full.openRoom(roomId); return; }
      if (!panel) panel = new CommsPanel(el, { mode: 'dock', nav: (hash) => { d.close(); navigate(hash); }, key: 'dock', onClose: () => d.close() });
      if (!isOpen) {
        isOpen = true;
        el.classList.add('open');
        el.setAttribute('aria-hidden', 'false');
        button.classList.add('active');
        panel.setVisible(true);
      }
      if (roomId) panel.openRoom(roomId);
    },
    draft(text: string) {
      if (CommsPanel.full) { CommsPanel.full.draft(text); return; }
      d.open();
      panel?.draft(text);
    },
    close() {
      if (!isOpen) return;
      isOpen = false;
      el.classList.remove('open');
      el.setAttribute('aria-hidden', 'true');
      button.classList.remove('active');
      panel?.setVisible(false);
    },
    // Opening chat signs the commander in to their guild's chat server too, if nothing has yet
    // (it already tries by itself as soon as the wallet is open), unless they signed out on purpose.
    toggle() { if (isOpen) d.close(); else { d.open(); comms.autoSignIn(); } },
  };
  setCommsOpener((id) => { if (CommsPanel.full) CommsPanel.full.openRoom(id); else d.open(id); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen && !e.defaultPrevented && !el.contains(e.target as Node)) d.close(); });
  dock = d;
  return d;
}
