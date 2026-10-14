/* Docshots: the README's pictures, retaken from the game as it is now (docs/*.jpg, 1440×900).
 *   node scripts/studio/docshots.mjs            every picture (serves a fresh build)
 *   node scripts/studio/docshots.mjs battle deck   just these
 * Each shot opens a route in headless Chrome, lets it settle, runs its setup, and saves a JPEG. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser, pool, serveSite, sleep } from './cdp.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const clickText = (re) => `[...document.querySelectorAll('button, a')].find((b) => ${re}.test(b.textContent))?.click()`;
const SHOTS = {
  title: { route: '/', wait: 10 },
  lobby: { route: '/lobby', wait: 14, run: `document.querySelector('.dc-press')?.click()`, after: 4000 },
  galaxy: { route: '/galaxy', wait: 12, run: `document.querySelector('.dc-press')?.click()`, after: 1500 },
  hubs: { route: '/galaxy', wait: 12, run: `document.querySelector('.dc-press')?.click(); setTimeout(() => document.querySelectorAll('.topbar .hub')[1]?.click(), 400)`, after: 1500 },
  battle: { route: '/sim', wait: 8, run: `document.querySelector('.setup-panel .dc-start')?.click()`, after: 9000 },
  battlefield: { route: '/sim', wait: 8, run: `document.querySelector('.setup-panel .dc-start')?.click(); setTimeout(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' })), 8000)`, after: 9500 },
  deck: { route: '/command/1-142', wait: 12 },
  planet: { route: '/planet/2-1', wait: 12 },
  combat: { route: '/combat', wait: 14 },
  grid: { route: '/grid', wait: 14 },
  economy: { route: '/economy/fuel', wait: 12 },
  intel: { route: '/intel/guilds', wait: 12 },
  forge: { route: '/forge/MsgStructAttack', wait: 8 },
  robots: { route: '/ops/orders', wait: 8 },
  record: { route: '/ops/record', wait: 8 },
  academy: { route: '/academy', wait: 8 },
  codex: { route: '/codex/5', wait: 10 },
};
const pick = process.argv.slice(2);
const names = pick.length ? pick.filter((n) => SHOTS[n]) : Object.keys(SHOTS);
const site = await serveSite();
try {
  await pool(names, 3, async (name) => {
    const s = SHOTS[name];
    const b = await openBrowser({ w: 1440, h: 900 }, { siteBase: site.base, reducedMotion: false });
    try {
      await b.send('Page.navigate', { url: site.base + s.route });
      await sleep(s.wait * 1000);
      if (s.run) { await b.evaluate(s.run); await sleep(s.after || 1000); }
      const img = await b.shot('jpeg', 84);
      if (img) writeFileSync(join(ROOT, 'docs', name + '.jpg'), img);
      console.log((b.problems.length ? '△ ' : '✓ ') + 'docs/' + name + '.jpg' + (b.problems.length ? '  ' + b.problems.slice(0, 2).join(' · ') : ''));
    } finally { await b.close(); }
  });
} finally { await site.close(); }
