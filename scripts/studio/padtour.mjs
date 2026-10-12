/* Pad tour: proof that a controller reaches every screen. A bot holding a virtual gamepad (the same
 * stub as the playtest) starts at the title and, using only the d-pad, A and B, walks to each hub in
 * the top bar, opens its menu, steps to each tile and presses A. Every tile must land on the screen
 * its link names (or, for the command line, open it), with no errors along the way.
 *
 * usage: node scripts/studio/padtour.mjs     (STUDIO_URL / STUDIO_DIST as for the other studio tools)
 * Writes studio/reports/padtour.json. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAD_STUB, openBrowser, padPress, serveSite, sleep } from './cdp.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const report = { at: new Date().toISOString(), tiles: [], problems: [] };
const site = await serveSite();
const b = await openBrowser({ w: 1440, h: 900 }, { siteBase: site.base, init: PAD_STUB });
/** One press, seen by exactly one pad poll at any frame rate (cdp.mjs PAD_STUB), then a beat for the screen. */
const press = async (name) => { await padPress(b, name); await sleep(140); };
const focused = () => b.evaluate(`(() => { const e = document.activeElement; return e && e !== document.body ? (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 40) : ''; })()`);
/** Get to hub `hi` with the pad: Back (Menu) to the hub row, then the d-pad along it. */
async function gotoHub(hi) {
  for (let guard = 0; guard < 40; guard++) {
    const where = await b.evaluate(`(() => {
      const hs = [...document.querySelectorAll('.topbar .hub')], e = document.activeElement;
      const at = hs.indexOf(e);
      if (at >= 0) return { at };
      if (e && e.closest && e.closest('.topbar')) return { at: -1, bar: e.getBoundingClientRect().left < hs[0].getBoundingClientRect().left ? 'left' : 'right' };
      return { at: -1 };
    })()`);
    if (where.at === hi) return true;
    if (where.at >= 0) await press(where.at < hi ? 'RIGHT' : 'LEFT');
    else if (where.bar) await press(where.bar === 'left' ? 'RIGHT' : 'LEFT');
    // Out in a screen: Back (the pad's Menu) jumps to the hubs, whatever the screen does with arrows.
    else await press('BACK');
  }
  return false;
}
const until = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await b.evaluate(expr).catch(() => false)) return true; await sleep(200); } return false; };

try {
  await b.send('Page.navigate', { url: site.base + '/' });
  if (!(await until(`!!document.querySelector('.dc-title .dc-press')`, 30000))) throw new Error('title never showed');
  await b.evaluate(`window.dispatchEvent(new Event('gamepadconnected'))`);
  await sleep(300);
  await press('START');
  await press('B');   // just watch: the title steps aside
  await sleep(800);
  const hubs = await b.evaluate(`[...document.querySelectorAll('.topbar .hub')].map((h) => h.getAttribute('aria-label'))`);
  for (let hi = 0; hi < hubs.length; hi++) {
    if (!(await gotoHub(hi))) { report.problems.push(`could not reach the ${hubs[hi]} hub by d-pad (focus on "${await focused()}")`); continue; }
    await press('A');
    if (!(await until(`!!document.querySelector('.hub-menu')`, 3000))) { report.problems.push(`A on ${hubs[hi]} did not open its menu`); continue; }
    const tiles = await b.evaluate(`[...document.querySelectorAll('.hub-menu .hm-item')].map((t) => ({ label: t.querySelector('.hm-label')?.textContent || '', href: t.getAttribute('href') }))`);
    for (let ti = 0; ti < tiles.length; ti++) {
      // Reopen the menu for each tile (a pick closes it), then step right to the tile.
      if (!(await b.evaluate(`!!document.querySelector('.hub-menu')`))) {
        if (!(await gotoHub(hi))) { report.problems.push(`could not get back to the ${hubs[hi]} hub by d-pad (focus on "${await focused()}")`); break; }
        await press('A');
        if (!(await until(`!!document.querySelector('.hub-menu')`, 3000))) { report.problems.push(`${hubs[hi]} menu would not reopen`); break; }
      }
      for (let k = 0; k < ti; k++) await press('RIGHT');
      const want = tiles[ti];
      const on = await b.evaluate(`document.activeElement?.querySelector?.('.hm-label')?.textContent || ''`);
      if (on !== want.label) { report.problems.push(`${hubs[hi]} › ${want.label}: d-pad landed on "${on}"`); continue; }
      const before = await b.evaluate('location.pathname');
      await press('A');
      let ok;
      if (want.href) {
        const path = new URL(want.href, site.base + '/').pathname;
        // (A screen may settle its address under the tile's own: the Unit Guide opens on /codex/1.)
        ok = await until(`(location.pathname === ${JSON.stringify(path)} || location.pathname.startsWith(${JSON.stringify(path + '/')})) && !!document.querySelector('#ui .screen')`, 15000);
        if (!ok) report.problems.push(`${hubs[hi]} › ${want.label}: A went to ${await b.evaluate('location.pathname')} (wanted ${path}, was ${before})`);
      } else {
        ok = await until(`!!document.querySelector('.modal-back, .palette')`, 4000);
        if (!ok) report.problems.push(`${hubs[hi]} › ${want.label}: A opened nothing`);
        await press('B');
      }
      report.tiles.push({ hub: hubs[hi], tile: want.label, ok });
      console.log(`${ok ? '✓' : '✗'} ${hubs[hi]} › ${want.label}`);
      await sleep(600);
    }
  }
} catch (e) {
  report.problems.push(String(e?.message || e));
} finally {
  report.problems.push(...b.problems);
  await b.close();
  await site.close();
}
mkdirSync(join(ROOT, 'studio/reports'), { recursive: true });
writeFileSync(join(ROOT, 'studio/reports/padtour.json'), JSON.stringify(report, null, 1));
const ok = report.tiles.filter((t) => t.ok).length;
console.log(report.problems.length ? `padtour: ✗ ${ok}/${report.tiles.length} tiles · ${report.problems.slice(0, 6).join(' · ')}` : `padtour: ✓ all ${ok} tiles reached by pad`);
process.exit(report.problems.length ? 1 : 0);
