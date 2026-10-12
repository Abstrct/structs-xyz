/* Routes are paths: /galaxy, /planet/2-7, /codex/5, /combat/<hash>. The URL bar shows them as
 * such, so every screen is a real, linkable, indexable page, and the app swaps screens in place
 * (pushState) without reloading. Old #/… links still open: boot rewrites them to the path form.
 *
 * Screens sometimes rewrite their own URL (the attack or codex entry on show) without navigating.
 * They do it through replaceRoute so the router's idea of the current route follows.
 *
 * Under a base path (a GitHub project page, /repo/), routes keep their plain form here and the URL
 * bar shows them under the base (core/base.ts). */
import { stripBase, withBase } from './base';

export const SITE_NAME = 'Structs Command Deck';

/** The current route as a path ('/codex/5'), with any legacy hash form folded in. */
export function currentRoute(): string {
  if (location.hash.startsWith('#/')) return location.hash.slice(1);
  return normalizeRoute(stripBase(location.pathname));
}

/** '/codex/5.html', '#/codex/5', 'codex/5/' and '/codex/5' are all the same route. */
export function normalizeRoute(p: string): string {
  let s = p.replace(/^#/, '').replace(/\.html$/, '').replace(/\/+$/, '');
  if (!s.startsWith('/')) s = '/' + s;
  return s === '/index' ? '/' : s;
}

/** Go to a route (a new history entry). Any module may call this; the router listens. */
export function goTo(path: string) {
  const to = normalizeRoute(path);
  if (currentRoute() !== to || location.hash) history.pushState(null, '', withBase(to));
  window.dispatchEvent(new CustomEvent<string>('structs:navigate', { detail: to }));
}

/** Go somewhere else instead of this route (a redirect): the current entry is replaced, not added
 * to, so Back never bounces into it again. */
export function redirectTo(path: string) {
  const to = normalizeRoute(path);
  history.replaceState(null, '', withBase(to));
  window.dispatchEvent(new CustomEvent<string>('structs:navigate', { detail: to }));
}

/** Rewrite the current entry in place (a screen refining its own URL). */
export function replaceRoute(path: string) {
  const to = normalizeRoute(path);
  if (currentRoute() === to && !location.hash) return;
  history.replaceState(null, '', withBase(to));
  window.dispatchEvent(new CustomEvent<string>('structs:replace-route', { detail: to }));
}

/** An absolute, shareable URL for a route. */
export function routeUrl(path: string): string {
  return location.origin + withBase(normalizeRoute(path));
}

export interface PageMeta { title: string; description?: string; path?: string }

/** The document's title, description, canonical and Open Graph tags for the screen on show.
 * Each route gets its own, so search results and link previews name the page, not the app. */
export function setPageMeta(m: PageMeta) {
  const title = m.title && m.title !== SITE_NAME ? `${m.title} · ${SITE_NAME}` : SITE_NAME;
  document.title = title;
  const url = routeUrl(m.path ?? currentRoute());
  const set = (sel: string, attr: string, value: string | undefined) => {
    if (value === undefined) return;
    const el = document.head.querySelector<HTMLElement>(sel);
    if (el) el.setAttribute(attr, value);
  };
  set('meta[property="og:title"]', 'content', title);
  set('meta[name="twitter:title"]', 'content', title);
  set('meta[name="description"]', 'content', m.description);
  set('meta[property="og:description"]', 'content', m.description);
  set('meta[name="twitter:description"]', 'content', m.description);
  set('meta[property="og:url"]', 'content', url);
  set('link[rel="canonical"]', 'href', url);
}

/** Same-origin links open in place: the app never reloads for a route it can switch to. */
export function interceptLinks() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.target || a.hasAttribute('download') || a.getAttribute('rel')?.includes('external')) return;
    const raw = a.getAttribute('href') || '';
    if (raw.startsWith('#/')) { e.preventDefault(); goTo(raw.slice(1)); return; }
    if (!raw.startsWith('/') || raw.startsWith('//')) return;
    const href = stripBase(raw);
    if (/\.[a-z0-9]{2,5}$/i.test(href) && !href.endsWith('.html')) return;  // a file, not a screen
    e.preventDefault();
    goTo(href);
  });
}
