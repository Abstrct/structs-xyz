/* Where the site lives: '/' on its own domain, '/<repo>/' as a GitHub project page. Vite bakes it in
 * as BASE_URL from `base` in vite.config.ts, which follows VITE_SITE_URL's path.
 *
 * Routes stay '/codex/5' everywhere in the code. Only what leaves for the browser carries the base:
 * the URL bar (core/nav.ts), link and image URLs (h() in core/dom.ts adds it to root-relative href
 * and src), and fetched files (sounds, art, the service worker). */

export interface Base {
  /** '/' or '/repo/' (always ends in a slash). */
  base: string;
  /** A public file's URL: '/img/x.webp' → '/repo/img/x.webp'. */
  asset(path: string): string;
  /** A root-relative path as this site's URL path: '/codex/5' → '/repo/codex/5', '/' → '/repo/'.
   * Idempotent: a path already under the base is left alone. */
  withBase(path: string): string;
  /** A URL path back to a route: '/repo/codex/5' → '/codex/5', '/repo' → '/'. Other paths pass through. */
  stripBase(path: string): string;
}

export function makeBase(raw: string | undefined): Base {
  const base = ('/' + String(raw || '/').replace(/^\/+|\/+$/g, '') + '/').replace(/^\/\/$/, '/');
  const root = base.slice(0, -1);   // '' or '/repo'
  const under = (p: string) => p === root || p.startsWith(base);
  return {
    base,
    asset: (p) => base + p.replace(/^\/+/, ''),
    withBase: (p) => (!root || under(p) ? p : root + p),
    stripBase: (p) => (!root ? p : p === root ? '/' : p.startsWith(base) ? p.slice(root.length) : p),
  };
}

export const { base: BASE, asset, withBase, stripBase } = makeBase((import.meta as { env?: Record<string, string | undefined> }).env?.BASE_URL);
