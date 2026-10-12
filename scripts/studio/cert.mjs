/* Cert: the studio's platform-certification pass, in the spirit of a console maker's checklist.
 * Every screen is opened in headless Chrome at three sizes (TV = the Dreamcast's 640×480, desktop,
 * phone) and measured against studio/budgets.json:
 *
 *   words      visible words on screen (numbers are free: they are the game talking)
 *   minFont    the smallest text a player must read, in CSS px
 *   tiny       buttons and links too small to hit
 *   unnamed    controls a screen reader can't name (icon-only, no label or title)
 *   fps / p95  frame rate and the 95th-percentile frame time over two seconds
 *   tris/calls what one frame costs the GPU (Engine.stats, every pass summed)
 *   heap/dom   memory and DOM size
 *
 * Hard failures (always): an uncaught exception or console.error, a screen that never mounts, a
 * blank 3D view, anything running past the right edge. Budgets warn, except those listed in budgets.json
 * › enforce, which fail; STUDIO_STRICT=1 makes every budget fail.
 *
 * Writes studio/reports/cert/{report.json,index.html,shots/} and compares with the baseline in
 * studio/baseline/cert.json (STUDIO_BASELINE=1 saves this run as the new baseline).
 *
 * usage: node scripts/studio/cert.mjs [route…]   e.g. node scripts/studio/cert.mjs /sim /academy
 *        STUDIO_VIEWS=desktop,tv     which sizes (default desktop,tv,phone)
 *        STUDIO_URL=http://localhost:5173   test a running dev server instead of a fresh build
 *        STUDIO_SETTLE=9000          ms each screen runs before it is measured
 *        STUDIO_JOBS=3               browsers at once */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser, pool, serveSite, sleep, GL } from './cdp.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const BUDGETS = JSON.parse(readFileSync(join(ROOT, 'studio/budgets.json'), 'utf8'));
const OUT = join(ROOT, 'studio/reports/cert');
const SHOTS = join(OUT, 'shots');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const VIEWS = {
  tv: { name: 'tv', w: 640, h: 480 },
  desktop: { name: 'desktop', w: 1440, h: 900 },
  phone: { name: 'phone', w: 390, h: 844, mobile: true },
};
const views = (process.env.STUDIO_VIEWS || 'desktop,tv,phone').split(',').map((v) => VIEWS[v.trim()]).filter(Boolean);
const routes = process.argv.slice(2).length ? process.argv.slice(2) : BUDGETS.routes;
const SETTLE = Number(process.env.STUDIO_SETTLE || 9000);
const JOBS = Number(process.env.STUDIO_JOBS || (GL === 'metal' ? 3 : 2));
const STRICT = !!process.env.STUDIO_STRICT;

/* Measured inside the page. Visible means: laid out, inside the viewport, not clipped away by a
 * scrolling ancestor, not hidden or transparent. */
const PROBE = `(async () => {
  const W = innerWidth, H = innerHeight;
  const styleOk = (el) => { for (let a = el; a && a !== document.documentElement; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false; } return true; };
  const clipOf = (el) => { let r = { l: 0, t: 0, r: W, b: H }; for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { const q = a.getBoundingClientRect(); r = { l: Math.max(r.l, q.left), t: Math.max(r.t, q.top), r: Math.min(r.r, q.right), b: Math.min(r.b, q.bottom) }; } } return r; };
  const seen = (rect, c) => rect.width > 0 && rect.height > 0 && rect.right > c.l + 1 && rect.left < c.r - 1 && rect.bottom > c.t + 1 && rect.top < c.b - 1;
  const label = (el) => { const c = (typeof el.className === 'string' && el.className.trim()) ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''; return el.tagName.toLowerCase() + c; };
  let words = 0, minFont = 99;
  const blocks = new Map(), small = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) {
    const t = n.textContent.replace(/\\s+/g, ' ').trim();
    if (!t) continue;
    const el = n.parentElement;
    if (!el || el.closest('#boot, script, style, noscript, title')) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const c = clipOf(el);
    if (![...range.getClientRects()].some((r) => seen(r, c))) continue;
    if (!styleOk(el)) continue;
    const w = (t.match(/[A-Za-z\\u00C0-\\u024F][A-Za-z\\u00C0-\\u024F'’-]*/g) || []).length;
    if (!w) continue;
    words += w;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < minFont) minFont = fs;
    if (fs < ${BUDGETS.minFontPx}) small.push(label(el) + ' ' + fs + 'px "' + t.slice(0, 30) + '"');
    // Group by the nearest block-level container, so the report names the wordiest panels.
    let box = el; while (box.parentElement && box.parentElement !== document.body && getComputedStyle(box).display.startsWith('inline')) box = box.parentElement;
    const k = box.parentElement && box.parentElement !== document.body ? box.parentElement : box;
    const b = blocks.get(k) || { sel: label(k), words: 0, sample: '' };
    b.words += w; if (b.sample.length < 80) b.sample = (b.sample + ' ' + t).trim().slice(0, 80);
    blocks.set(k, b);
  }
  // Tap targets: anything clickable that is on screen and smaller than the budget in either side.
  const minTap = matchMedia('(pointer: coarse)').matches ? ${BUDGETS.minTapCoarse} : ${BUDGETS.minTapFine};
  const tiny = [];
  for (const el of document.querySelectorAll('a[href], button, [role=button], input, select, summary')) {
    const r = el.getBoundingClientRect();
    if (!seen(r, clipOf(el)) || !styleOk(el) || el.disabled) continue;
    if (Math.min(r.width, r.height) < minTap) tiny.push(label(el) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
  }
  // Controls a screen reader can't name: icon-only buttons and links with no text, label or title.
  const unnamed = [];
  for (const el of document.querySelectorAll('a[href], button, [role=button], input:not([type=hidden]), select')) {
    const r = el.getBoundingClientRect();
    if (!seen(r, clipOf(el)) || !styleOk(el)) continue;
    const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('placeholder') || '').trim()
      || (el.id && document.querySelector('label[for="' + el.id + '"]')?.textContent?.trim()) || el.closest('label')?.textContent?.trim()
      || (el.getAttribute('aria-labelledby') || '').split(' ').map((id) => document.getElementById(id)?.textContent || '').join('').trim();
    if (!name) unnamed.push(label(el));
  }
  // Right-edge overflow, as the smoke test defines it.
  const wide = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.tags-layer, .grid-label, .colcap, .tooltip, .toasts, #boot')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= W + 1) continue;
    if (!styleOk(el)) continue;
    let clipped = false;
    for (let a = el.parentElement; a && !clipped; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== 'visible' && !a.matches('html, body, #ui, #ui > .screen') && a.getBoundingClientRect().right <= W + 1) clipped = true; }
    if (!clipped) { wide.push(label(el) + ' to ' + Math.round(r.right) + 'px'); if (wide.length >= 3) break; }
  }
  // Two seconds of frames.
  const dts = [];
  await new Promise((done) => { let last = performance.now(); const t0 = last; const f = (now) => { dts.push(now - last); last = now; if (now - t0 < 2000) requestAnimationFrame(f); else done(); }; requestAnimationFrame(f); });
  dts.shift();
  const sorted = [...dts].sort((a, b) => a - b);
  const avg = dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length);
  const s = window.__structs?.engine?.stats || {};
  const canvas = document.querySelector('canvas#gl');
  const png = canvas ? await new Promise((r) => requestAnimationFrame(() => r(canvas.toDataURL('image/png').length))) : 0;
  return {
    mounted: !!document.querySelector('#ui .screen'),
    words, minFont: minFont === 99 ? null : minFont, small: small.slice(0, 6),
    blocks: [...blocks.values()].sort((a, b) => b.words - a.words).slice(0, 6),
    tiny: tiny.length, tinySample: tiny.slice(0, 6), wide, unnamed: unnamed.length, unnamedSample: unnamed.slice(0, 6),
    fps: Math.round(1000 / avg), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0),
    tris: s.triangles || 0, calls: s.calls || 0, points: s.points || 0, textures: s.textures || 0,
    res: s.width ? s.width + '×' + s.height : '',
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    dom: document.getElementsByTagName('*').length, png,
  };
})()`;

const budgetFor = (route) => ({ ...BUDGETS.default, ...(BUDGETS.screens[route] || {}) });

async function certify(route, view, base) {
  let b;
  try { b = await openBrowser(view, { siteBase: base }); } catch (e) {
    return { route, view: view.name, problems: ['harness: ' + (e?.message || e)], warnings: [], pass: false };
  }
  const r = { route, view: view.name, problems: b.problems, warnings: [] };
  try {
    // A route may name a state after '#' (budgets.json › states): an action run once the screen has
    // settled, so in-play screens (a battle mid-fight, the galaxy without its title) are measured too.
    const [path, state] = route.split('#');
    await b.send('Page.navigate', { url: base + path });
    await sleep(SETTLE);
    // On a loaded machine boot can outlast the settle: wait until the boot screen, the prerendered
    // page text and NOW LOADING are gone, so we measure the game and not its loading screen.
    for (let end = Date.now() + 45000; Date.now() < end; await sleep(500)) {
      if (await b.evaluate(`!!document.querySelector('#ui .screen') && !document.querySelector('#boot, #seo, .dc-now-loading')`).catch(() => false)) break;
    }
    const st = state ? (BUDGETS.states || {})[route] : null;
    if (state && !st) throw new Error(`no state "${route}" in budgets.json › states`);
    if (st) { await b.evaluate(st.before); await sleep(st.after ?? 3000); }
    Object.assign(r, await b.evaluate(PROBE, 40000));
    const file = `${route.slice(1).replace(/[/#]/g, '_') || 'title'}-${view.name}.jpg`;
    const img = await b.shot('jpeg', 72);
    if (img) { writeFileSync(join(SHOTS, file), img); r.shot = 'shots/' + file; }
  } catch (e) {
    b.problems.push('harness: ' + (e?.message || e));
  } finally {
    await b.close();
  }
  if (r.mounted === false) r.problems.push('no screen mounted');
  if (r.wide?.length) r.problems.push('runs past the right edge: ' + r.wide.join(', '));
  if (r.png !== undefined && r.png < 20000) r.problems.push(`3D view looks blank (${r.png} B png)`);
  const bud = budgetFor(route);
  const over = (k, v, lim, cmp = (a, c) => a > c) => { if (v != null && lim != null && cmp(v, lim)) r.warnings.push(`${k} ${v} (budget ${lim})`); };
  if (view.name === 'desktop' || view.name === 'tv') over('words', r.words, bud.words);
  over('minFont', r.minFont, BUDGETS.minFontPx, (a, c) => a < c);
  over('tiny', r.tiny, bud.tiny);
  over('unnamed', r.unnamed, bud.unnamed ?? 0);
  over('tris', r.tris, bud.tris);
  over('calls', r.calls, bud.calls);
  if (view.name === 'desktop') over('fps', r.fps, bud.fps, (a, c) => a < c);
  // Budgets the studio has promoted to gates (budgets.json › enforce) fail like any problem.
  for (const w of r.warnings) if ((BUDGETS.enforce || []).includes(w.split(' ')[0])) r.problems.push('over budget: ' + w);
  r.problems = [...new Set(r.problems)];
  r.pass = !r.problems.length && (!STRICT || !r.warnings.length);
  return r;
}

const t0 = Date.now();
const site = await serveSite();
const jobs = routes.flatMap((route) => views.map((view) => ({ route, view })));
console.log(`cert: ${jobs.length} checks (${routes.length} screens × ${views.map((v) => v.name).join('/')}), GL ${GL}, ${JOBS} at a time`);
let results;
try {
  results = await pool(jobs, JOBS, async ({ route, view }) => {
    const r = await certify(route, view, site.base);
    const mark = r.pass ? (r.warnings.length ? '△' : '✓') : '✗';
    console.log(`${mark} ${route.padEnd(24)} ${view.name.padEnd(7)} words ${String(r.words ?? '?').padStart(4)}  fps ${String(r.fps ?? '?').padStart(3)}  tris ${String(r.tris ?? '?').padStart(7)}  calls ${String(r.calls ?? '?').padStart(4)}`
      + (r.problems.length ? '\n    ✗ ' + r.problems.join('\n    ✗ ') : '') + (r.warnings.length ? '\n    △ ' + r.warnings.join(' · ') : ''));
    return r;
  });
} finally {
  await site.close();
}

// Compare with the baseline: the studio's memory of how the game used to measure.
const basePath = join(ROOT, 'studio/baseline/cert.json');
const baseline = existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')) : null;
const key = (r) => r.route + '@' + r.view;
const before = new Map((baseline?.results || []).map((r) => [key(r), r]));
const sum = (rs, k) => rs.reduce((a, r) => a + (r[k] || 0), 0);
const desk = results.filter((r) => r.view === 'desktop');
const summary = {
  at: new Date().toISOString(), gl: GL, ms: Date.now() - t0,
  checks: results.length, failed: results.filter((r) => !r.pass).length, warned: results.filter((r) => r.warnings.length).length,
  words: sum(desk, 'words'), wordsBefore: baseline ? sum((baseline.results || []).filter((r) => r.view === 'desktop' && routes.includes(r.route)), 'words') : null,
};
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ summary, budgets: BUDGETS, results }, null, 1));
if (process.env.STUDIO_BASELINE) {
  mkdirSync(join(ROOT, 'studio/baseline'), { recursive: true });
  copyFileSync(join(OUT, 'report.json'), basePath);
  console.log('cert: saved as the new baseline');
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const delta = (r, k, better = 'down') => {
  const b = before.get(key(r));
  if (!b || b[k] == null || r[k] == null || b[k] === r[k]) return '';
  const d = r[k] - b[k];
  const good = better === 'down' ? d < 0 : d > 0;
  return ` <span class="${good ? 'good' : 'bad'}">${d > 0 ? '+' : ''}${d}</span>`;
};
const card = (r) => {
  const bud = budgetFor(r.route);
  const wpct = Math.min(100, Math.round(((r.words || 0) / Math.max(1, bud.words)) * 100));
  return `<figure class="${r.pass ? (r.warnings.length ? 'warn' : 'ok') : 'fail'}">
  ${r.shot ? `<a href="${r.shot}"><img src="${r.shot}" loading="lazy" alt="${esc(r.route)} at ${r.view}"></a>` : '<div class="noshot">no picture</div>'}
  <figcaption>
    <b>${esc(r.route)}</b> <i>${r.view}</i>
    <div class="bar"><span style="width:${wpct}%"></span></div>
    <div class="m">words ${r.words ?? '?'}${delta(r, 'words')} / ${bud.words} · fps ${r.fps ?? '?'}${delta(r, 'fps', 'up')} · tris ${r.tris ?? '?'}${delta(r, 'tris')} · calls ${r.calls ?? '?'} · ${esc(r.res)}</div>
    <div class="m">min text ${r.minFont ?? '–'}px · tiny targets ${r.tiny ?? '?'} · unnamed ${r.unnamed ?? '?'} · dom ${r.dom ?? '?'} · heap ${r.heapMB ?? '?'} MB</div>
    ${r.problems.map((p) => `<div class="p">✗ ${esc(p)}</div>`).join('')}
    ${r.warnings.map((p) => `<div class="w">△ ${esc(p)}</div>`).join('')}
    ${(r.blocks || []).slice(0, 3).map((b) => `<div class="blk">${b.words}w <code>${esc(b.sel)}</code> ${esc(b.sample)}</div>`).join('')}
  </figcaption></figure>`;
};
writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cert report</title>
<style>
:root{--bg:#0B1240;--card:#16297F;--ink:#fff;--dim:#C9D6FF;--ok:#2DB34A;--warn:#F5C518;--fail:#FF3D5A;--accent:#FF6A13}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif;padding:24px}
h1{font:italic 900 34px/1 system-ui;margin:0 0 6px}.sum{color:var(--dim);margin-bottom:20px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
figure{margin:0;background:var(--card);border-radius:16px;overflow:hidden;border:3px solid transparent}
figure.fail{border-color:var(--fail)}figure.warn{border-color:var(--warn)}figure.ok{border-color:var(--ok)}
img{width:100%;display:block;background:#000;aspect-ratio:16/10;object-fit:contain}figcaption{padding:10px 12px}
i{color:var(--dim)}.m{color:var(--dim);font-size:12px}.p{color:var(--fail)}.w{color:var(--warn);font-size:12px}
.blk{font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar{height:6px;background:rgba(255,255,255,.12);border-radius:3px;margin:6px 0}.bar span{display:block;height:6px;background:var(--accent);border-radius:3px}
.good{color:var(--ok);font-weight:700}.bad{color:var(--fail);font-weight:700}.noshot{aspect-ratio:16/10;display:grid;place-items:center;color:var(--dim)}
code{color:#fff}
</style>
<h1>CERT</h1>
<div class="sum">${summary.checks} checks · ${summary.failed} failed · ${summary.warned} over budget · desktop words ${summary.words}${summary.wordsBefore != null ? ` (baseline ${summary.wordsBefore})` : ''} · GL ${GL} · ${Math.round(summary.ms / 1000)} s · ${summary.at}</div>
<main>${results.map(card).join('\n')}</main>`);
console.log(`cert: ${summary.failed ? summary.failed + ' failed' : 'all passed'}, ${summary.warned} over budget · desktop words ${summary.words}${summary.wordsBefore != null ? ` (baseline ${summary.wordsBefore})` : ''} · report studio/reports/cert/index.html`);
process.exit(summary.failed ? 1 : 0);
