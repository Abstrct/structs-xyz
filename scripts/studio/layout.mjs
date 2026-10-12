/* Layout guard: proof that a change meant for one screen size left another alone. For each route it
 * records where the interface's frame sits (the top bar and its hubs, panels and their heads,
 * buttons, bars, the title's doors) as rounded boxes, then compares against a saved copy.
 *
 *   node scripts/studio/layout.mjs --save            record the baseline (desktop by default)
 *   node scripts/studio/layout.mjs                   compare; exits 1 on any moved box
 *   STUDIO_VIEW=tv|desktop|phone  STUDIO_DIST/STUDIO_URL as for the other studio tools
 *
 * Live data moves numbers and lists, so only the frame is compared, with a 2 px tolerance. Writes
 * studio/reports/layout-<view>.json; the baseline is studio/baseline/layout-<view>.json. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser, pool, serveSite, sleep } from './cdp.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const VIEWS = { tv: { w: 640, h: 480 }, desktop: { w: 1440, h: 900 }, phone: { w: 390, h: 844, mobile: true } };
const viewName = process.env.STUDIO_VIEW || 'desktop';
const view = VIEWS[viewName];
const save = process.argv.includes('--save');
const ROUTES = ['/', '/galaxy#hud', '/planet/2-1', '/command', '/combat', '/grid', '/sim', '/codex/5', '/economy', '/guild', '/comms', '/academy', '/ops/record', '/ops/proofs', '/forge/MsgStructAttack', '/intel/activity'];
/** The frame: chrome that must not move when only the phone layout changes. */
const FRAME = [
  '.topbar', '.topbar .hub', '.topbar .brand', '.wallet-chip', '.vmu', '.cp-dock-btn',
  '.screen > .panel', '.screen .panel-head', '.dc-title .dc-door', '.dc-title .dc-logo', '.setup-panel', '.battle-top', '.action-bar',
  '.cp-signin', '.ops-nav', '.ac-tile', '.codex-detail', '.dct-tab', '.btn.solid', '.modal',
].join(', ');
const STATE = { '/galaxy#hud': `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))` };

const site = await serveSite();
const out = {};
try {
  await pool(ROUTES, 2, async (route) => {
    const b = await openBrowser(view, { siteBase: site.base });
    try {
      const [path, hash] = route.split('#');
      await b.send('Page.navigate', { url: site.base + path });
      for (let end = Date.now() + 45000; Date.now() < end; await sleep(500)) {
        if (await b.evaluate(`!!document.querySelector('#ui .screen') && !document.querySelector('#boot, #seo, .dc-now-loading')`).catch(() => false)) break;
      }
      await sleep(3000);
      if (hash && STATE[route]) { await b.evaluate(STATE[route]); await sleep(1500); }
      out[route] = await b.evaluate(`(() => {
        const seen = new Map();
        for (const el of document.querySelectorAll(${JSON.stringify(FRAME)})) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          const key = el.tagName.toLowerCase() + '.' + [...el.classList].sort().join('.') + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : '');
          const n = (seen.get(key) || 0) + 1; seen.set(key, n);
          seen.set(key + '#' + n, [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), Math.round(parseFloat(cs.fontSize))]);
        }
        return Object.fromEntries([...seen].filter(([k]) => k.includes('#')));
      })()`);
      console.log(`  ${route}: ${Object.keys(out[route]).length} boxes`);
    } finally { await b.close(); }
  });
} finally { await site.close(); }

mkdirSync(join(ROOT, 'studio/reports'), { recursive: true });
writeFileSync(join(ROOT, `studio/reports/layout-${viewName}.json`), JSON.stringify(out, null, 1));
const basePath = join(ROOT, `studio/baseline/layout-${viewName}.json`);
if (save) {
  mkdirSync(join(ROOT, 'studio/baseline'), { recursive: true });
  writeFileSync(basePath, JSON.stringify(out, null, 1));
  console.log(`layout (${viewName}): baseline saved, ${ROUTES.length} routes`);
  process.exit(0);
}
if (!existsSync(basePath)) { console.log(`layout (${viewName}): no baseline (run with --save first)`); process.exit(1); }
const base = JSON.parse(readFileSync(basePath, 'utf8'));
const moved = [];
for (const route of ROUTES) {
  const a = base[route] || {}, b = out[route] || {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    if (!x || !y) { moved.push(`${route} ${k}: ${x ? 'gone' : 'new'}`); continue; }
    if (x.some((v, i) => Math.abs(v - y[i]) > 2)) moved.push(`${route} ${k}: [${x}] → [${y}]`);
  }
}
console.log(moved.length ? `layout (${viewName}): ✗ ${moved.length} boxes moved\n    ` + moved.slice(0, 40).join('\n    ') : `layout (${viewName}): ✓ nothing moved on ${ROUTES.length} routes`);
process.exit(moved.length ? 1 : 0);
