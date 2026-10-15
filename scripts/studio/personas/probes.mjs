/* Persona lab: code that runs inside the page.
 *
 *   PROBE_INIT    installed before the game boots: frame times (rAF), long tasks, layout shift, and
 *                 every change to a live region (what a screen reader would announce)
 *   seedStorage   the persona's saved state (settings, an old build's leftovers) before the first load
 *   AUDIT(opts)   one look at the screen as the persona meets it: words, text size, contrast against
 *                 what is really behind the text, targets too small for their hands, unnamed controls,
 *                 controls covered by something else, overflow and clipped text, endless animations,
 *                 whether focus shows, headings and landmarks
 *   FINGERPRINT   the state a press can change; equal before and after a press = a dead input */

export const PROBE_INIT = `(() => {
  if (window.__probe) return;
  const P = window.__probe = { ft: [], last: 0, long: [], cls: 0, live: 0, liveText: [], lastLive: '' };
  const tick = (t) => { if (P.last) { P.ft.push(t - P.last); if (P.ft.length > 6000) P.ft.splice(0, 2000); } P.last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) P.cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch {}
  const LIVE = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]';
  const mo = new MutationObserver((recs) => {
    for (const r of recs) {
      const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      const live = el && el.closest && el.closest(LIVE);
      if (!live) continue;
      const t = (live.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
      if (t && P.lastLive !== t) { P.lastLive = t; P.live++; P.liveText.push(t); if (P.liveText.length > 200) P.liveText.shift(); }
    }
  });
  const start = () => mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
})();`;

/** Once per browser session (sessionStorage remembers), before the game reads them. `settings` merge
 * into structs.settings; `storage` is written raw (an old build's values, corrupt or not). */
export const seedStorage = (storage = {}, settings = {}) => `(() => { try {
  if (sessionStorage.getItem('__persona_seeded')) return;
  sessionStorage.setItem('__persona_seeded', '1');
  for (const [k, v] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(k, v);
  const s = ${JSON.stringify(settings)};
  if (Object.keys(s).length) { let cur = {}; try { cur = JSON.parse(localStorage.getItem('structs.settings') || '{}') || {}; } catch {} localStorage.setItem('structs.settings', JSON.stringify({ ...cur, ...s })); }
} catch {} })();`;

export const FINGERPRINT = `(() => {
  const s = window.__structs?.screens?.().sim, a = document.activeElement;
  return [location.pathname, a && a !== document.body ? (a.className || a.tagName) + '|' + (a.textContent || '').trim().slice(0, 24) : '',
    document.querySelectorAll('.modal-back').length, document.querySelectorAll('.toast').length, !!document.querySelector('.hub-menu'),
    s?.phase || '', s?.targeting?.kind || '', s?.targeting?.ws || '', s?.aimId || '', s?.selected || '', s?.session?.pending?.hash || '',
    s?.session?.stats?.['1-1']?.attacks || 0, !!document.querySelector('.tooltip.on'), document.querySelector('.dc-title')?.className || '',
    document.querySelectorAll('.coach').length, document.querySelectorAll('.palette').length].join('~');
})()`;

/** opts: { minTap, minFont, maxText } */
export const AUDIT = (opts) => `(() => {
  const O = ${JSON.stringify(opts)};
  const W = innerWidth, H = innerHeight;
  const rgba = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (top, a, under) => [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a));
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= H || r.left >= W) return null;
    if (el.closest('[inert], [aria-hidden="true"]')) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return null;
    let op = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    return op < 0.05 ? null : { r, cs, op };
  };
  // The window on top, if one is open: only its controls can be used, so only they are judged.
  const backs = [...document.querySelectorAll('.modal-back')].filter((b) => shown(b));
  const scope = backs[backs.length - 1] || document.body;

  /* Text: words, sizes, contrast against what is really underneath (the stack at the text's centre). */
  const tw = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, { acceptNode: (n) => /\\S/.test(n.nodeValue) ? 1 : 2 });
  const els = new Map();
  for (let n; (n = tw.nextNode());) { const el = n.parentElement; if (el && !els.has(el)) els.set(el, ''); if (el) els.set(el, els.get(el) + n.nodeValue); }
  let words = 0, minFont = 99, checked = 0, unknown = 0;
  const texts = [], fails = [], small = [], clipped = [];
  for (const [el, raw] of els) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;
    const s = shown(el); if (!s) continue;
    const text = raw.trim().replace(/\\s+/g, ' ');
    const w = (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
    words += w;
    if (w && texts.length < 400) texts.push(text.slice(0, 200));
    const fs = parseFloat(s.cs.fontSize);
    if (w) { minFont = Math.min(minFont, fs); if (fs < O.minFont && small.length < 12) small.push({ text: text.slice(0, 40), px: fs }); }
    if (el.scrollWidth > el.clientWidth + 2 && /hidden|clip/.test(s.cs.overflowX) && s.cs.textOverflow !== 'ellipsis' && clipped.length < 12) clipped.push(text.slice(0, 40));
    if (!w || checked >= 350) continue;
    const fg = rgba(s.cs.color); if (!fg) continue;
    const cx = Math.min(W - 1, Math.max(0, s.r.left + s.r.width / 2)), cy = Math.min(H - 1, Math.max(0, s.r.top + s.r.height / 2));
    const stack = document.elementsFromPoint(cx, cy);
    let i = stack.indexOf(el); if (i < 0) i = 0;
    const layers = []; let cover = 0, onCanvas = false;
    for (; i < stack.length && cover < 0.99; i++) {
      const e = stack[i];
      if (e.tagName === 'CANVAS' || e.tagName === 'VIDEO' || e.tagName === 'IMG') { onCanvas = true; break; }
      const bg = rgba(getComputedStyle(e).backgroundColor);
      if (bg && bg[3] > 0) { layers.push(bg); cover = 1 - (1 - cover) * (1 - bg[3]); }
    }
    if (onCanvas && cover < 0.9) { unknown++; continue; }
    let bg = [0, 0, 0];
    for (let k = layers.length - 1; k >= 0; k--) bg = over(layers[k], layers[k][3], bg);
    const col = over(fg, fg[3] * s.op, bg);
    const big = fs >= 24 || (fs >= 18.66 && Number(s.cs.fontWeight) >= 700);
    const r = ratio(col, bg), need = big ? 3 : 4.5;
    checked++;
    if (r < need && fails.length < 25) fails.push({ text: text.slice(0, 40), ratio: +r.toFixed(2), need, px: fs, fg: 'rgb(' + col.map(Math.round) + ')', bg: 'rgb(' + bg.map(Math.round) + ')' });
  }

  /* Controls: size for these hands, a name, and whether a press at their centre reaches them. */
  const CTRL = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=slider], [tabindex]:not([tabindex="-1"])';
  const name = (e) => (e.getAttribute('aria-label') || (e.getAttribute('aria-labelledby') || '').split(' ').map((id) => document.getElementById(id)?.textContent || '').join(' ') || e.getAttribute('title') || e.textContent || e.querySelector('img[alt]')?.alt || e.value || (e.id && document.querySelector('label[for="' + e.id + '"]')?.textContent) || '').trim();
  const ctrls = [...scope.querySelectorAll(CTRL)].map((e) => ({ e, s: shown(e) })).filter((x) => x.s && x.s.cs.pointerEvents !== 'none');
  const tiny = [], unnamed = [], covered = [];
  for (const { e, s } of ctrls) {
    const label = name(e).replace(/\\s+/g, ' ').slice(0, 40);
    if (!label) unnamed.push((e.tagName.toLowerCase() + '.' + [...e.classList].slice(0, 2).join('.')).slice(0, 50));
    if ((s.r.width < O.minTap || s.r.height < O.minTap) && !e.matches('input[type=range]')) tiny.push({ name: label || e.className.slice(0, 30), w: Math.round(s.r.width), h: Math.round(s.r.height) });
    const cx = s.r.left + s.r.width / 2, cy = s.r.top + s.r.height / 2;
    if (cx >= 0 && cy >= 0 && cx < W && cy < H) { const top = document.elementFromPoint(cx, cy); if (top && top !== e && !e.contains(top) && !top.contains(e) && covered.length < 12) covered.push({ name: label || e.className.slice(0, 30), by: (top.className && typeof top.className === 'string' ? top.className : top.tagName).slice(0, 40) }); }
  }

  /* Page frame: sideways scroll, things past the right edge, endless animations, focus, structure. */
  const sc = document.scrollingElement || document.documentElement;
  const offscreen = ctrls.filter(({ s }) => s.r.right > W + 1 || s.r.left < -1).length;
  const anims = document.getAnimations ? document.getAnimations().filter((a) => a.playState === 'running') : [];
  const infinite = anims.filter((a) => a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity).length;
  const a = document.activeElement;
  let focus = null;
  if (a && a !== document.body && a !== document.documentElement) {
    const cs = getComputedStyle(a), r = a.getBoundingClientRect();
    const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
    focus = { name: name(a).slice(0, 40), ring: !!ring, inView: r.bottom > 0 && r.right > 0 && r.top < H && r.left < W && r.width > 0, focusVisible: a.matches(':focus-visible') };
  }
  return {
    path: location.pathname, modal: backs.length > 0, words, minFont: minFont === 99 ? null : minFont, small, texts: texts.slice(0, O.maxText || 120),
    contrast: { checked, unknown, fails }, controls: ctrls.length, tiny, unnamed, covered, clipped, offscreen,
    overflowX: sc.scrollWidth > W + 1, infinite, running: anims.length, focus,
    headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]').length,
    landmarks: document.querySelectorAll('main,nav,header,footer,aside,[role=main],[role=navigation],[role=banner],[role=complementary],[role=region]').length,
    reduceMotion: window.__structs?.engine?.reduceMotion ?? null,
  };
})()`;
