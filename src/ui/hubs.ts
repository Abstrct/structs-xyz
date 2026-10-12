/* The top bar's six hubs. Every screen lives in one: Base (yours), Battle (tactics), Explore
 * (the live galaxy), Trade (economics), Team (guilds and chat) and Lab (code, robots, the
 * engine). A hub opens a menu of its screens, each with a line on what you do there, so a new
 * player never has to guess what "Forge" or "Ops" means. Every menu item is a real link. */
import { h } from '../core/dom';
import { audio } from '../core/audio';
import { HUBS, hubFor, TRACKS, type Hub, type HubId } from '../data/learn';
import { wallet } from '../wallet/wallet';
import { icon, ITEM_ICONS } from './icons';
import { academy } from '../game/academy';
import { loadRecord } from '../screens/battle/record';

export interface HubNav { el: HTMLElement; setActive(path: string, closeMenu?: boolean): void; close(): void }

export function buildHubNav(openPalette: () => void): HubNav {
  const buttons = new Map<HubId, HTMLButtonElement>();
  let menu: HTMLElement | null = null;
  let openId: HubId | null = null;
  let current = '';

  const close = () => {
    menu?.remove(); menu = null;
    if (openId) buttons.get(openId)?.setAttribute('aria-expanded', 'false');
    openId = null;
  };

  const open = (hub: Hub) => {
    if (openId === hub.id) { close(); return; }
    close();
    openId = hub.id;
    const btn = buttons.get(hub.id)!;
    btn.setAttribute('aria-expanded', 'true');
    const track = hub.track ? TRACKS.find((t) => t.id === hub.track) : undefined;
    const keyless = wallet.state === 'empty';
    const firstTimer = loadRecord().battles === 0;
    // The item for the screen on show: the longest path that the current route sits under.
    const herePath = hub.items.reduce<string>((best, it) => it.path && (current === it.path || current.startsWith(it.path + '/')) && it.path.length > best.length ? it.path : best, '');
    // Tiles, Dreamcast-menu style: a picture and a name. What each screen does is one hover away (title).
    const items = hub.items.map((it, i) => {
      const here = !!it.path && it.path === herePath;
      const body = [
        h('span', { class: 'hm-n' }, String(i + 1)),
        h('span', { class: 'hm-tile-ico', html: icon(ITEM_ICONS[it.path || it.action || ''] || hub.id, 34) }),
        h('span', { class: 'hm-text' }, h('span', { class: 'hm-label' }, it.label)),
        it.needsKeys && keyless ? h('span', { class: 'hm-lock', title: 'Needs a commander', html: icon('lock', 14) }) : null,
        // A first battle is the easiest way in: a beacon on it until one is fought.
        it.path === '/sim' && !here && firstTimer ? h('span', { class: 'hm-start', 'aria-label': 'Start here' }) : null,
      ];
      const title = it.desc;
      if (it.action === 'palette') return h('button', { class: 'hm-item', role: 'menuitem', title, onclick: () => { close(); openPalette(); } }, ...body);
      return h('a', { class: 'hm-item' + (here ? ' here' : ''), role: 'menuitem', title, href: it.path!, 'aria-current': here ? 'page' : null, onclick: () => { audio.play('select'); close(); } }, ...body);
    });
    // tabindex -1: a click on the menu's header keeps focus inside it, so its keys keep working.
    menu = h('div', { class: 'hub-menu panel', role: 'menu', tabindex: -1, 'aria-label': hub.label, style: `--hub:${hub.color}` },
      h('div', { class: 'hm-head' }, h('span', { class: 'hm-ico', html: icon(hub.id, 28) }), h('span', { class: 'hm-title' }, hub.label)),
      h('div', { class: 'hm-items' }, ...items),
      track ? (() => {
        const p = academy.trackProgress(track.id);
        return h('a', { class: 'hm-learn', href: '/academy/' + track.id, title: `${track.label} lessons in the Academy`, onclick: () => { audio.play('select'); close(); } },
          h('span', { html: icon('academy', 20) }), h('span', null, track.label), h('span', { class: 'hm-learn-n' }, p.done >= p.total ? '★' : `${p.done}/${p.total}`));
      })() : null);
    document.body.appendChild(menu);
    // Under its button, kept on screen.
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + 'px';
    audio.play('select');
    (menu.querySelector('.hm-item') as HTMLElement | null)?.focus({ preventScroll: true });
  };

  const nav = h('nav', { class: 'hubs', 'aria-label': 'Places' }, ...HUBS.map((hub) => {
    const b = h('button', { class: 'hub', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': hub.label, style: `--hub:${hub.color}`, onclick: () => open(hub) },
      h('span', { class: 'hub-ico', html: icon(hub.id, 20) })) as HTMLButtonElement;
    buttons.set(hub.id, b);
    return b;
  }));

  // Clicks elsewhere, focus moving elsewhere (a palette, the vault, chat opened from the keyboard),
  // Escape, a resize or a navigation close the menu; arrows walk it; 1–9 pick. Keys only count
  // while the menu (or its hub button) has focus, so they never reach into a window on top.
  const ours = (n: Node | null) => !!n && (!!menu?.contains(n) || [...buttons.values()].some((b) => b.contains(n)));
  document.addEventListener('pointerdown', (e) => { if (menu && !ours(e.target as Node)) close(); }, true);
  document.addEventListener('focusin', (e) => { if (menu && !ours(e.target as Node)) close(); });
  window.addEventListener('resize', close);
  // A window opening on top (the palette, the vault, a confirm) takes over: the menu steps aside.
  new MutationObserver((recs) => { if (menu && recs.some((r) => [...r.addedNodes].some((n) => n instanceof HTMLElement && n.classList.contains('modal-back')))) close(); })
    .observe(document.body, { childList: true });
  window.addEventListener('keydown', (e) => {
    if (!menu || !ours(document.activeElement)) return;
    const items = [...menu.querySelectorAll<HTMLElement>('.hm-item')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    // The tiles are a grid: left and right step one, up and down a whole row.
    const cols = Math.max(1, getComputedStyle(menu.querySelector('.hm-items')!).gridTemplateColumns.split(' ').filter(Boolean).length);
    const step = (d: number) => { e.preventDefault(); e.stopImmediatePropagation(); items[at < 0 ? 0 : (at + d + items.length) % items.length]?.focus(); };
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); const b = openId ? buttons.get(openId) : null; close(); b?.focus(); }
    else if (e.key === 'ArrowDown') step(cols);
    else if (e.key === 'ArrowUp') step(-cols);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) { const it = items[Number(e.key) - 1]; if (it) { e.preventDefault(); e.stopImmediatePropagation(); it.click(); } }
  }, true);

  return {
    el: nav,
    close,
    /** The hub of the route on show. A real navigation closes the menu; a screen refining its own
     * URL (an autoplaying replay) only moves the highlight. */
    setActive(path: string, closeMenu = true) {
      current = path;
      const id = hubFor(path);
      for (const [k, b] of buttons) b.classList.toggle('active', k === id);
      if (closeMenu) close();
    },
  };
}
