import { defineConfig, type Plugin } from 'vite';

// The game needs no CORS from its own server (Vite's default would answer every localhost origin),
// and no other site may frame it, where a click could land on something it can't see.
const headers = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };

/** Where the site is published: canonical links, Open Graph URLs, the sitemap. */
export const SITE_URL = (process.env.VITE_SITE_URL || 'https://structs.xyz').replace(/\/+$/, '');
/** The path it lives under: '/' on its own domain, '/<repo>/' as a GitHub project page. Follows
 * SITE_URL's path (scripts/prerender.ts reads it the same way); VITE_BASE overrides. */
export const BASE = ('/' + (process.env.VITE_BASE ?? new URL(SITE_URL).pathname).replace(/^\/+|\/+$/g, '') + '/').replace(/^\/\/$/, '/');
/** The chain endpoint the page talks to first: a preconnect hint in the shell saves it a round trip. */
const LCD_ORIGIN = new URL(process.env.VITE_LCD_URL || 'https://public.testnet.structs.network').origin;

/** %SITE_URL% and %LCD_ORIGIN% in index.html come from the build environment. */
function siteEnvPlugin(): Plugin {
  return {
    name: 'structs-site-env',
    transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', SITE_URL).replaceAll('%LCD_ORIGIN%', LCD_ORIGIN),
  };
}

export default defineConfig({
  // Absolute: screens live at real paths (/codex/5), so asset URLs must not be relative to them.
  // Under a base path the app adds it itself (src/core/base.ts).
  base: BASE,
  plugins: [siteEnvPlugin()],
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // three.js in its own long-cached chunk: the app's code changes every deploy, three.js rarely.
        advancedChunks: { groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }] },
      },
    },
  },
  worker: { format: 'es' },
  server: { port: 5173, host: true, cors: false, headers },
  preview: { cors: false, headers },
});
