/* Shoot: quick screenshots for art review. Each argument is route[@view][+seconds].
 *   STUDIO_URL=http://localhost:5173 node scripts/studio/shoot.mjs /@desktop /sim@tv+12 /academy@phone
 * Views: tv (640×480), desktop (1440×900), phone (390×844), small (360×640, a small phone). Pictures land in studio/reports/shots/.
 * STUDIO_EVAL runs a page expression after the wait and before the picture (e.g. to open a menu);
 * (STUDIO_AFTER ms later; default 800); STUDIO_MOTION=1 keeps animations (reduced motion is emulated by default).
 * STUDIO_PERSONA=<id> shoots as a persona lab player (studio/personas.json): their screen, eyesight, OS
 * settings, game settings, saved data, GPU and network; the @view is ignored and names gain the id.
 * STUDIO_ENGINE=firefox (with STUDIO_PERSONA) shoots in Firefox instead (scripts/studio/firefox.mjs). */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser, pool, serveSite, sleep } from './cdp.mjs';
import { openAs } from './personas/browser.mjs';

const VIEWS = { tv: { w: 640, h: 480 }, desktop: { w: 1440, h: 900 }, phone: { w: 390, h: 844, mobile: true }, small: { w: 360, h: 640, mobile: true } };
const OUT = join(new URL('../../', import.meta.url).pathname, 'studio/reports/shots');
mkdirSync(OUT, { recursive: true });
const LAB = process.env.STUDIO_PERSONA ? JSON.parse(readFileSync(join(OUT, '../../personas.json'), 'utf8')) : null;
const persona = LAB?.personas.find((p) => p.id === process.env.STUDIO_PERSONA);
if (LAB && !persona) { console.error(`shoot: no persona ${process.env.STUDIO_PERSONA}`); process.exit(2); }
const shots = process.argv.slice(2).map((a) => {
  const m = /^([^@+]*)(?:@(\w+))?(?:\+(\d+))?$/.exec(a) || [];
  return { route: m[1] || '/', view: m[2] || 'desktop', secs: Number(m[3] || 8) };
});
const site = await serveSite();
try {
  await pool(shots, 3, async ({ route, view, secs }) => {
    const b = persona ? (await openAs(persona, LAB, site.base, process.env.STUDIO_ENGINE || 'chrome')).b : await openBrowser(VIEWS[view] || VIEWS.desktop, { siteBase: site.base, reducedMotion: !process.env.STUDIO_MOTION });
    try {
      await b.send('Page.navigate', { url: site.base + route });
      await sleep(secs * 1000);
      if (process.env.STUDIO_EVAL) { await b.evaluate(process.env.STUDIO_EVAL); await sleep(Number(process.env.STUDIO_AFTER || 800)); }
      const img = await b.shot('png');
      const file = join(OUT, `${route.slice(1).replace(/\//g, '_') || 'title'}-${persona ? persona.id + (process.env.STUDIO_ENGINE === 'firefox' ? '-firefox' : '') : view}.png`);
      if (img) writeFileSync(file, img);
      console.log((b.problems.length ? '✗ ' : '✓ ') + file + (b.problems.length ? '\n    ' + b.problems.join('\n    ') : ''));
    } finally { await b.close(); }
  });
} finally { await site.close(); }
