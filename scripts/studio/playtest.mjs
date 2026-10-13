/* Playtest: a bot plays the golden path the way a new player with a controller would, and the
 * studio reads how it went. A virtual gamepad (navigator.getGamepads stubbed in the page) presses
 * real buttons through src/core/pad.ts, so the pad, the title, the battle setup, aiming and the
 * debrief are all exercised end to end.
 *
 *   fresh profile → title → START → right → A (Battle door) → A (Start) → A, A, A… until the debrief
 *   phone only, then by touch: tap Again → tap a weapon → tap an enemy → tap the card's Fire
 *
 * Fails on: an exception or console.error, a step that doesn't happen (the title doesn't open,
 * the Battle door doesn't lead to the battle, Start doesn't start it, no shot within 30 s), or a
 * battle that never ends. Reports the inputs and seconds to the first shot, the battle's length
 * and its result to studio/reports/playtest.json.
 *
 * usage: node scripts/studio/playtest.mjs      (STUDIO_URL to use a running dev server; STUDIO_VIEW=tv|desktop|phone) */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAD_STUB, openBrowser, padPress, serveSite, sleep } from './cdp.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const VIEWS = { tv: { w: 640, h: 480 }, desktop: { w: 1440, h: 900 }, phone: { w: 390, h: 844, mobile: true } };
const viewName = process.env.STUDIO_VIEW || 'desktop';
const view = VIEWS[viewName];
/** Reports and pictures carry the view's name, so the three sizes sit side by side. */
const tag = viewName === 'desktop' ? '' : '-' + viewName;

const report = { at: new Date().toISOString(), view: process.env.STUDIO_VIEW || 'desktop', steps: [], inputs: 0, problems: [] };
const site = await serveSite();
const b = await openBrowser(view, { siteBase: site.base, init: PAD_STUB });
const t0 = Date.now();
const step = (name, ok, extra = {}) => { report.steps.push({ name, ok, s: +((Date.now() - t0) / 1000).toFixed(1), ...extra }); console.log(`${ok ? '✓' : '✗'} ${name}${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`); if (!ok) throw new Error(name); };
/** Press a button once (a pulse the page's pad poll sees exactly once: cdp.mjs PAD_STUB). `unless`
 * (a page expression) skips the press, checked in the same breath, so nothing is pressed into a
 * window that just opened. */
const press = async (name, unless = 'false') => {
  if (!(await padPress(b, name, unless))) return false;
  report.inputs++;
  await sleep(120);
  return true;
};
/** Keep a picture of the moment for the report. */
const snap = async (name) => { const img = await b.shot('jpeg', 80).catch(() => null); if (img) { mkdirSync(join(ROOT, 'studio/reports'), { recursive: true }); writeFileSync(join(ROOT, `studio/reports/${name}${tag}.jpg`), img); } };
const until = async (expr, ms, every = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await b.evaluate(expr).catch(() => false)) return true; await sleep(every); }
  return false;
};

try {
  await b.send('Page.navigate', { url: site.base + '/' });
  step('title shows PRESS START', await until(`!!document.querySelector('.dc-title .dc-press')`, 30000));
  await b.evaluate(`window.dispatchEvent(new Event('gamepadconnected'))`);
  await sleep(300);
  await press('START');
  step('START opens the doors', await until(`!!document.querySelector('.dc-title.menu')`, 3000));
  // A visitor's cursor starts on Battle; if it doesn't, one step right finds it.
  const onBattle = `document.activeElement?.classList.contains('dc-door') && /battle/i.test(document.activeElement.textContent)`;
  if (!(await until(onBattle, 800))) await press('RIGHT');
  step('the Battle door has focus', await until(onBattle, 2000));
  await press('A');
  step('A opens the battle', await until(`location.pathname.endsWith('/sim') && !!document.querySelector('.setup-panel')`, 20000));
  await sleep(2500);
  await press('A');
  const started = Date.now();
  const fought = await until(`window.__structs.screens().sim?.phase === 'battle'`, 15000);
  step('A starts the fight', fought, fought ? {} : { focus: await b.evaluate(`(document.activeElement?.outerHTML || '').slice(0, 120)`), phase: await b.evaluate(`window.__structs.screens().sim?.phase`) });
  const inputsToStart = report.inputs;
  // Fight: A arms the first weapon with something in reach and aims; A again fires.
  let firstShot = 0;
  const shotsFired = `(window.__structs.screens().sim?.session?.stats?.['1-1']?.attacks || 0) + (window.__structs.screens().sim?.session?.pending ? 1 : 0)`;
  const end = Date.now() + 6 * 60000;
  while (Date.now() < end) {
    const over = `window.__structs.screens().sim?.phase === 'debrief' || !!document.querySelector('.debrief-back')`;
    if (!(await press('A', over))) break;
    if (!firstShot && (await b.evaluate(shotsFired)) > 0) {
      firstShot = Date.now();
      await snap('playtest-battle');
      step('first shot', true, { seconds: +((firstShot - started) / 1000).toFixed(1), inputs: report.inputs });
    }
    if (!firstShot && Date.now() - started > 30000) step('first shot within 30 s', false);
    await sleep(350);
  }
  await sleep(2800);
  await snap('playtest-debrief');
  const result = await b.evaluate(`(() => { const s = window.__structs.screens().sim; const o = s?.session; return { phase: s?.phase, attacks: o?.stats?.['1-1']?.attacks, damage: o?.stats?.['1-1']?.damage, banner: document.querySelector('.banner .big')?.textContent || '', title: document.querySelector('.modal .t-display')?.textContent || '' }; })()`);
  step('the battle ends', result.phase === 'debrief', { seconds: Math.round((Date.now() - started) / 1000), result: result.title || result.banner, attacks: result.attacks, damage: result.damage });
  Object.assign(report, { inputsToStart, firstShotSeconds: firstShot ? +((firstShot - started) / 1000).toFixed(1) : null, battleSeconds: Math.round((Date.now() - started) / 1000), result: result.title || result.banner });

  // On the phone, the pad is put down and a finger plays a round too: tap Again, tap a weapon, tap an
  // enemy in reach (its card opens), tap the card's Fire. The shot must go in.
  if (viewName === 'phone') {
    const tap = async (x, y) => {
      await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      report.inputs++;
      await sleep(450);
    };
    const centre = (sel) => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await until(`!document.querySelector('.debrief-back .modal[inert]')`, 3000);
    const again = await centre('.debrief-back [data-primary]');
    if (again) await tap(again.x, again.y);
    step('touch: Again starts a fight', await until(`window.__structs.screens().sim?.phase === 'battle' && !document.body.classList.contains('pad')`, 15000));
    await sleep(1500);
    await b.evaluate(`document.querySelector('.coach .coach-ok')?.click()`);
    const weapon = await centre('.action-bar .btn.action:not([disabled])');
    if (weapon) await tap(weapon.x, weapon.y);
    step('touch: a weapon arms', await until(`window.__structs.screens().sim?.targeting?.kind === 'attack'`, 3000));
    // A weapon's first tap also aims (their guard, else their flagship) and pins that target's card.
    step('touch: the aimed card offers Fire', !!(await centre('.tooltip.on .tip-fire')));
    // A tap on another enemy in reach moves the aim there and opens its card. (Not the ringed one, whose
    // tap fires, nor their Command Ship, whose tap goes at its guard while one stands.)
    const enemy = await b.evaluate(`(() => { const s = window.__structs.screens().sim; const u = [...s.view.units.values()].find((u) => u.side === 'enemy' && u.targetable && !u.command && u.id !== s.aimId); return u ? s.view.screenOf(u.id) : null; })()`);
    if (enemy) await tap(enemy.x, enemy.y);
    const fire = await centre('.tooltip.on .tip-fire');
    step('touch: the enemy card offers Fire', !!fire);
    const before = await b.evaluate(shotsFired);
    await tap(fire.x, fire.y);
    step('touch: Fire sends the shot', await until(`(${shotsFired}) > ${before}`, 4000));
    await snap('playtest-touch');
  }
} catch (e) {
  report.problems.push(String(e?.message || e));
} finally {
  report.problems.push(...b.problems);
  await b.close();
  await site.close();
}
mkdirSync(join(ROOT, 'studio/reports'), { recursive: true });
writeFileSync(join(ROOT, `studio/reports/playtest${tag}.json`), JSON.stringify(report, null, 1));
console.log(report.problems.length ? `playtest (${viewName}): ✗ ${report.problems.join(' · ')}` : `playtest (${viewName}): ✓ ${report.result} · ${report.inputsToStart} inputs to start · first shot ${report.firstShotSeconds} s · ${report.battleSeconds} s battle`);
process.exit(report.problems.length ? 1 : 0);
