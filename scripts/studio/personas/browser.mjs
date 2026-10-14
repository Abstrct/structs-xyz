/* Persona lab, browser lane: one persona plays the real build in headless Chrome. The browser is set
 * up as their machine: the viewport and density of their device, their GPU path and CPU speed, their
 * network, their OS settings (reduced motion, more contrast), their eyesight (Chrome's colour-vision
 * emulation, which the screenshots carry too), and their saved game state. They press with their own
 * hands: a virtual pad, trusted key events, a mouse with tremor jitter and accidental double clicks,
 * or a finger, at their reaction speed, with their misinput rate.
 *
 * Journeys (studio/personas.json › personas[].journeys):
 *   firstBattle  title → START → Battle door → Start → fight to the debrief, with their input
 *   marathon     three more fights with Again; heap, DOM nodes, listeners and frame rate each time
 *   tour         every hub by mouse or touch (2 tiles each, all with checks.gallery); pad: every cert route
 *   tabwalk      Tab through five screens: focus always shown, in view, never trapped, hubs reachable
 *   reader       the reading screens (Academy, Unit Guide, Economy, Robot Rules)
 *   chaos        160 random taps, keys, swipes, route jumps, Back and rotations; the page must stay alive
 *   offline      first load on slow 3G, then the signal drops and returns: say so, then recover
 *   interrupt    mid-fight: the app is backgrounded, then the phone turns sideways and back
 *
 * Every input is watched: whether the game's state changed after it (else a dead input; three in a
 * row is rage), and how long that took. At each checkpoint the screen is audited (probes.mjs AUDIT),
 * pictured, measured (frames, heap) and, for checks.ax, read as a screen reader would (the AX tree).
 * Writes <outDir>/browser.json and the checkpoint pictures. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAD_STUB, openBrowser, padPress, sleep } from '../cdp.mjs';
import { AUDIT, FINGERPRINT, PROBE_INIT, seedStorage } from './probes.mjs';
import { decodePng, flashes, imageStats, motion, pct } from './metrics.mjs';

/** CDP network profiles (bytes per second, ms). */
const NETWORK = {
  online: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  '4g': { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 100_000 },
  '3g': { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
};
const KEYS = { Enter: [13, '\r'], ' ': [32, ' '], Escape: [27], Tab: [9], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Backspace: [8] };
const SIM = 'window.__structs?.screens?.().sim';
const OVER = `(${SIM}?.phase === 'debrief' || !!document.querySelector('.debrief-back'))`;
const SHOTS = `((${SIM}?.session?.stats?.['1-1']?.attacks || 0) + (${SIM}?.session?.pending ? 1 : 0))`;
const START_BTN = `[...document.querySelectorAll('.setup-panel button')].find((b) => /start/i.test(b.textContent))`;
const TITLE = `!!document.querySelector('.dc-title .dc-press')`;

function rngFor(s) {
  let a = 0; for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 16777619) >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A browser set up as this persona's machine: viewport, GPU, CPU, network, OS media settings, eyesight,
 * saved state and (for a pad player) the virtual pad. Used by playAs and by `STUDIO_PERSONA=id pnpm shoot`. */
export async function openAs(persona, lab, siteBase) {
  const view = { ...lab.views[persona.view] };
  const init = [persona.input === 'pad' ? PAD_STUB : '', PROBE_INIT, seedStorage(persona.storage, persona.settings)].join('\n');
  const b = await openBrowser(view, { siteBase, init, reducedMotion: false, gl: persona.gl });
  const net = (name) => b.send('Network.emulateNetworkConditions', NETWORK[name] || NETWORK.online);
  const problems = [];
  try {
    await b.send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-reduced-motion', value: persona.media?.reducedMotion ? 'reduce' : 'no-preference' },
      ...(persona.media?.contrast ? [{ name: 'prefers-contrast', value: persona.media.contrast }] : []),
    ] });
    if (persona.media?.vision) await b.send('Emulation.setEmulatedVisionDeficiency', { type: persona.media.vision });
    if (persona.cpuThrottle > 1) await b.send('Emulation.setCPUThrottlingRate', { rate: persona.cpuThrottle });
    if (persona.network) await net(persona.network);
    await b.send('Performance.enable');
    if (persona.checks?.ax) await b.send('Accessibility.enable');
  } catch (e) { problems.push('setup: ' + e.message); }
  return { b, view, net, problems };
}

export async function playAs(persona, lab, site, outDir, { routes = [], log = () => {} } = {}) {
  mkdirSync(outDir, { recursive: true });
  const inputKind = persona.input, pad = inputKind === 'pad', kb = inputKind === 'keyboard', touch = inputKind === 'touch';
  const minTap = persona.checks?.minTargetPx ?? (touch ? 40 : 24);
  const minFont = persona.checks?.minFontPx ?? 11;
  const rnd = rngFor(persona.id);
  const hands = { reactionMs: 800, misinput: 0, jitterPx: 0, doubleClick: 0, ...persona.hands };
  const rep = {
    id: persona.id, handle: persona.handle, view: persona.view, input: inputKind, at: new Date().toISOString(), journeys: [], checkpoints: [], battles: [],
    inputs: { n: 0, dead: 0, rage: 0, maxDeadRun: 0, doubles: 0, misinputs: 0, latency: [] },
    boot: null, palette: null, screencasts: [], tabwalk: [], marathon: null, offline: null, interrupt: null, chaos: null, problems: [], live: null,
  };
  const t0 = Date.now();
  const secs = () => +((Date.now() - t0) / 1000).toFixed(1);
  let journey = '';

  const { b, view, net, problems: setup } = await openAs(persona, lab, site.base);
  rep.problems.push(...setup);

  /* ── Looking ─────────────────────────────────────────────────────────── */
  const until = async (expr, ms, every = 200) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) if (await b.evaluate(expr).catch(() => false)) return true;
    return false;
  };
  const fp = () => b.evaluate(FINGERPRINT, 8000).catch(() => 'gone:' + Math.random());
  const centre = (js) => b.evaluate(`(() => { const e = ${js}; if (!e) return null; const r = e.getBoundingClientRect(); return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`).catch(() => null);
  const perf = async (gc = false) => {
    if (gc) await b.send('HeapProfiler.collectGarbage').catch(() => {});
    const r = await b.send('Performance.getMetrics').catch(() => null);
    const m = Object.fromEntries((r?.result?.metrics || []).map((x) => [x.name, x.value]));
    return { heapMB: +((m.JSHeapUsedSize || 0) / 1e6).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, layouts: m.LayoutCount };
  };
  const frameStats = (ft) => {
    if (ft.length < 10) return { n: ft.length };
    const p50 = pct(ft, 0.5), p95 = pct(ft, 0.95);
    return { n: ft.length, fps: +(1000 / p50).toFixed(1), p50: +p50.toFixed(1), p95: +p95.toFixed(1), jank: +(ft.filter((d) => d > Math.max(34, 2 * p50)).length / ft.length).toFixed(3) };
  };
  const step = (name, ok, extra = {}) => {
    const j = rep.journeys[rep.journeys.length - 1];
    j.steps.push({ name, ok: !!ok, s: secs(), ...extra });
    log(`${persona.id} ${ok ? '✓' : '✗'} ${journey}: ${name}${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`);
    if (!ok) throw Object.assign(new Error(name), { journeyStep: true });
  };
  const soft = (name, ok, extra = {}) => { try { step(name, ok, extra); } catch { rep.journeys[rep.journeys.length - 1].soft = true; } return ok; };

  async function axAudit() {
    const r = await b.send('Accessibility.getFullAXTree', {}, 30000).catch(() => null);
    const nodes = (r?.result?.nodes || []).filter((n) => !n.ignored);
    const INTERACTIVE = new Set(['button', 'link', 'checkbox', 'textbox', 'combobox', 'menuitem', 'tab', 'slider', 'switch', 'radio', 'searchbox', 'spinbutton', 'option']);
    const ctrls = nodes.filter((n) => INTERACTIVE.has(n.role?.value));
    const unnamed = ctrls.filter((n) => !String(n.name?.value || '').trim());
    return {
      interactive: ctrls.length, unnamed: unnamed.length, unnamedRoles: [...new Set(unnamed.map((n) => n.role.value))],
      headings: nodes.filter((n) => n.role?.value === 'heading').length,
      landmarks: nodes.filter((n) => ['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region'].includes(n.role?.value)).length,
    };
  }

  async function checkpoint(name, extra = {}) {
    await sleep(350);
    const audit = await b.evaluate(AUDIT({ minTap, minFont, maxText: 120 }), 25000).catch((e) => ({ error: String(e.message || e) }));
    const ft = await b.evaluate('window.__probe ? window.__probe.ft.splice(0) : []').catch(() => []);
    const metrics = await perf();
    let image = null;
    try {
      const png = await b.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: view.w, height: view.h, scale: Math.min(1, 240 / view.w) } }, 30000);
      image = imageStats(decodePng(Buffer.from(png.result.data, 'base64')));
    } catch { /* no picture: the audit still counts */ }
    const file = `${String(rep.checkpoints.length).padStart(2, '0')}-${name.replace(/[^a-z0-9-]+/gi, '_')}.jpg`;
    const jpg = await b.shot('jpeg', 72).catch(() => null);
    if (jpg) writeFileSync(join(outDir, file), jpg);
    const ax = persona.checks?.ax ? await axAudit() : null;
    rep.checkpoints.push({ name, journey, s: secs(), audit, frames: frameStats(ft), metrics, image, shot: jpg ? file : null, ax, ...extra });
  }

  /* ── Hands ───────────────────────────────────────────────────────────── */
  const think = (scale = 1) => sleep(hands.reactionMs * scale * (0.7 + rnd() * 0.6));
  let deadRun = 0;
  /** Do one input and watch what it did: the state's fingerprint changes (latency), or it doesn't (dead). */
  async function input(fn, { watch = true } = {}) {
    const before = watch ? await fp() : '';
    const at = Date.now();
    await fn();
    rep.inputs.n++;
    if (!watch) return true;
    for (const end = at + 1200; Date.now() < end; await sleep(35)) {
      if ((await fp()) !== before) { rep.inputs.latency.push(Date.now() - at); deadRun = 0; return true; }
    }
    rep.inputs.dead++; deadRun++;
    if (deadRun === 3) rep.inputs.rage++;
    rep.inputs.maxDeadRun = Math.max(rep.inputs.maxDeadRun, deadRun);
    return false;
  }
  const padBtn = (name) => padPress(b, name);
  async function key(k, shift = false) {
    const [vk, text] = KEYS[k] || [k.toUpperCase().charCodeAt(0), k];
    const base = { key: k, code: k === ' ' ? 'Space' : k.length === 1 ? 'Key' + k.toUpperCase() : k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
    await b.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  const jitter = (v) => v + (rnd() * 2 - 1) * (hands.jitterPx || 0);
  async function point(x0, y0) {
    const x = jitter(x0), y = jitter(y0);
    if (touch) {
      await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      return;
    }
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    if (hands.doubleClick && rnd() < hands.doubleClick) {
      rep.inputs.doubles++;
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 });
    }
  }
  const pointAt = async (js) => { const c = await centre(js); if (!c) return false; await point(c.x, c.y); return true; };
  /** Keyboard (Tab) or pad (R, which pad.ts sends as Tab) until `js` has focus. */
  async function focusOn(js, max = 60) {
    for (let i = 0; i <= max; i++) {
      if (await b.evaluate(`(() => { const t = ${js}; return !!t && document.activeElement === t; })()`).catch(() => false)) return true;
      if (i < max) { await input(() => (kb ? key('Tab') : padBtn('R')), { watch: false }); await sleep(70); }
    }
    return false;
  }
  /** Press the thing: a click or tap on it, or focus it and Enter / A. */
  async function activate(js) {
    if (pad || kb) {
      if (!(await focusOn(js))) return false;
      return input(() => (kb ? key('Enter') : padBtn('A')));
    }
    const c = await centre(js);
    if (!c) return false;
    return input(() => point(c.x, c.y));
  }
  /** A slip of the hand: the wrong button, a stray click or tap on the field. */
  async function fumble() {
    rep.inputs.misinputs++;
    if (pad) return input(() => padBtn(['B', 'LEFT', 'RIGHT', 'X', 'UP'][Math.floor(rnd() * 5)]));
    if (kb) return input(() => key(['Escape', 'ArrowLeft', 'ArrowRight', 'Tab', 'ArrowUp'][Math.floor(rnd() * 5)]));
    return input(() => point(view.w * (0.2 + rnd() * 0.6), view.h * (0.25 + rnd() * 0.4)));
  }
  /** A window or tip in the way: dismiss it the way this player would. Not the debrief or a confirm the bot needs. */
  async function dismissTips() {
    const t = await b.evaluate(`(() => { const g = document.querySelector('.guide-card'); if (g) return 'guide'; const m = [...document.querySelectorAll('.modal-back')].pop(); if (!m || m.classList.contains('debrief-back')) return null; return 'modal'; })()`).catch(() => null);
    if (!t) return false;
    if (pad) return input(() => padBtn('B'));
    if (kb) return input(() => key('Escape'));
    return input(() => pointAt(`(() => { const s = document.querySelector('.guide-card') || [...document.querySelectorAll('.modal-back')].pop(); return s && ([...s.querySelectorAll('button')].find((x) => /got it|^ok|close|continue|done|×/i.test((x.getAttribute('aria-label') || '') + ' ' + x.textContent.trim())) || s.querySelector('[data-primary]')); })()`));
  }
  async function go(path, waitFor = `!!document.querySelector('#ui .screen') || ${TITLE}`, ms = 30000) {
    await b.send('Page.navigate', { url: site.base + path });
    return until(waitFor, ms);
  }
  const inApp = (path) => b.evaluate(`window.__structs.navigate(${JSON.stringify(path)})`).catch(() => {});

  /* ── Screencast: flashes and lurches ─────────────────────────────────── */
  let cast = null;
  async function castStart() {
    if (cast) return;
    cast = { frames: [], fn: null, set: null, at: Date.now() };
    cast.fn = (m) => {
      if (m.method !== 'Page.screencastFrame') return;
      b.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
      try { cast?.frames.push({ t: m.params.metadata.timestamp, img: decodePng(Buffer.from(m.params.data, 'base64')) }); } catch { /* a bad frame */ }
    };
    cast.set = b.on(cast.fn);
    await b.send('Page.startScreencast', { format: 'png', maxWidth: 256, maxHeight: 160, everyNthFrame: 1 }).catch(() => {});
  }
  async function castStop(label) {
    if (!cast) return;
    await b.send('Page.stopScreencast').catch(() => {});
    cast.set?.delete(cast.fn);
    const frames = cast.frames.sort((x, y) => x.t - y.t);
    rep.screencasts.push({ label, journey, flashes: flashes(frames), motion: motion(frames) });
    cast = null;
  }

  /* ── The fight ───────────────────────────────────────────────────────── */
  async function startFight() {
    for (let tries = 0; tries < 3; tries++) {
      await dismissTips();
      await think();
      // A first: a fresh setup opens with its cursor on Start (playtest.mjs). After the debrief's "Next · Add
      // ships" the cursor is on an empty bay and A adds a ship there, so then START, which fights from anywhere.
      // The ship picker keeps every key while it's open (START too): B closes it first.
      const picker = `!!document.querySelector('.slot-editor')`;
      if (pad) {
        if (tries > 0 && (await b.evaluate(picker).catch(() => false))) { await input(() => padBtn('B')); await think(0.5); }
        await input(() => padBtn(tries === 0 ? 'A' : 'START'));
      } else if (kb) {
        if (await b.evaluate(picker).catch(() => false)) { await input(() => key('Escape')); await think(0.5); }
        // Tab first, as anyone would; when Tab can't reach Start, the key the setup shows for it (Space).
        if (await focusOn(START_BTN, 15)) await input(() => key('Enter'));
        else { soft('Tab reaches Start', false); await input(() => key(' ')); }
      } else if (!(await activate(START_BTN))) continue;
      if (await until(`['battle', 'deploy'].includes(${SIM}?.phase)`, 8000)) return until(`${SIM}?.phase === 'battle'`, 15000);
    }
    return false;
  }
  /** Fight until the debrief (or `shots` shots, then return). The patience rules: no first shot within
   * stuckSec and the player gives up. After that, stretches with no shot are measured (dead air), not quit on. */
  async function fight({ shots: stopAt = Infinity, watchFrames = false } = {}) {
    const started = Date.now(), inputs0 = rep.inputs.n;
    let firstShot = 0, lastShot = Date.now(), count = await b.evaluate(SHOTS).catch(() => 0), quit = null, pausedAt = 0, unstuckAt = 0, noShotMax = 0;
    const stuck = (persona.patience?.stuckSec ?? 60) * 1000;
    await b.evaluate('window.__probe && (window.__probe.ft.length = 0)').catch(() => {});
    for (const end = Date.now() + 7 * 60000; Date.now() < end;) {
      if (await b.evaluate(OVER).catch(() => false)) break;
      if (b.dead) throw new Error(b.dead);
      await think();
      // The clock stopped (a pause the player didn't notice asking for, a guard pick left open): a person
      // looks up, sees the pause and resumes. Counted, so a game that pauses itself often shows up.
      if (await b.evaluate(`${SIM}?.phase === 'battle' && ${SIM}?.session && !${SIM}.session.running && !${SIM}.session.finished`).catch(() => false)) {
        if (!pausedAt) pausedAt = Date.now();
        if (Date.now() - pausedAt > 3000) {
          rep.paused = (rep.paused || 0) + 1;
          pausedAt = 0;
          if (await b.evaluate(`!!${SIM}?.targeting`).catch(() => false)) await input(() => (pad ? padBtn('B') : key('Escape')));
          if (pad) await input(() => padBtn('START'));
          else if (kb || !(await activate(`[...document.querySelectorAll('button')].find((x) => /resume|play|pause/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.title || ''))) || null`))) await input(() => key(' '));
          continue;
        }
      } else pausedAt = 0;
      if (hands.misinput && rnd() < hands.misinput) await fumble();
      else if (pad) await input(() => padBtn('A'));
      else if (kb) await input(() => key('Enter'));
      else {
        const st = await b.evaluate(`(() => { const s = ${SIM}; const vis = (q) => { const e = document.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; };
          let enemy = null;
          if (s?.targeting?.kind === 'attack' && s.view) { const us = [...s.view.units.values()].filter((u) => u.side === 'enemy' && u.targetable && !u.destroyed); const u = us.find((x) => x.id === s.aimId) || us[0]; if (u) enemy = s.view.screenOf(u.id); }
          return vis('.coach .coach-ok') || vis('.tooltip.on .tip-fire') || enemy || vis('.action-bar .btn.action.weapon:not([disabled])'); })()`).catch(() => null);
        if (st) await input(() => point(st.x, st.y)); else await sleep(400);
      }
      const n = await b.evaluate(SHOTS).catch(() => count);
      if (n > count) {
        count = n; lastShot = Date.now();
        if (!firstShot) {
          firstShot = Date.now();
          soft('first shot', true, { seconds: +((firstShot - started) / 1000).toFixed(1), inputs: rep.inputs.n - inputs0 });
          if (persona.checks?.flash || persona.checks?.motion) await castStart();
          await checkpoint('first-shot');
        }
        if (n >= stopAt) break;
      }
      if (cast && Date.now() - cast.at > 6000) await castStop('battle');
      if (!firstShot && Date.now() - started > stuck) { quit = `no shot in ${Math.round(stuck / 1000)} s`; break; }
      // Stuck in a mode (a guard pick from a slip of the thumb, an aim with nothing in reach): after 15 s
      // without a shot a person backs out with B / Escape. Counted: a mode that traps players shows up.
      const idle = Date.now() - (firstShot ? lastShot : started);
      if (idle > 15000 && Date.now() - unstuckAt > 15000) {
        const mode = await b.evaluate(`${SIM}?.targeting?.kind || ''`).catch(() => '');
        if (mode) { (rep.unstuck ||= []).push({ mode, s: secs() }); unstuckAt = Date.now(); await input(() => (pad ? padBtn('B') : key('Escape'))); }
        // A pad's A presses the control in focus. Parked on something else after a slip (Guard re-opens its
        // pick, Pause toggles the clock), every A does that instead of firing. A player sees the cursor and
        // steers it back down to the weapons; recorded with the control that held it.
        const parked = pad ? await b.evaluate(`(() => { const a = document.activeElement; if (!a || a === document.body || a.classList.contains('weapon')) return null; return (a.getAttribute('aria-label') || a.title || a.textContent || a.className).trim().replace(/\\s+/g, ' ').slice(0, 30); })()`).catch(() => null) : null;
        if (parked) {
          (rep.unstuck ||= []).push({ mode: `cursor on "${parked}"`, s: secs() }); unstuckAt = Date.now();
          const onWeapon = `!!document.activeElement?.classList?.contains('weapon')`;
          for (const dir of ['DOWN', 'DOWN', 'DOWN', 'LEFT', 'LEFT']) { if (await b.evaluate(onWeapon).catch(() => false)) break; await input(() => padBtn(dir)); }
        }
      }
      // A long wait with nothing to fire is dead air, not a reason to quit: the fight plays on to its end.
      if (firstShot) noShotMax = Math.max(noShotMax, Date.now() - lastShot);
    }
    if (!quit && !(await b.evaluate(OVER).catch(() => false))) quit = 'the fight never ended (7 min)';
    if (cast) await castStop('battle');
    const ft = watchFrames ? await b.evaluate('window.__probe ? window.__probe.ft.slice() : []').catch(() => []) : [];
    return { seconds: Math.round((Date.now() - started) / 1000), noShotS: Math.round(noShotMax / 1000), firstShotS: firstShot ? +((firstShot - started) / 1000).toFixed(1) : null, shots: count, inputs: rep.inputs.n - inputs0, quit, frames: frameStats(ft) };
  }
  async function debrief(fought) {
    await sleep(2500);
    const result = await b.evaluate(`(() => { const s = ${SIM}; return { phase: s?.phase, title: document.querySelector('.modal .t-display')?.textContent || document.querySelector('.banner .big')?.textContent || '' }; })()`).catch(() => ({}));
    rep.battles.push({ journey, ...fought, result: result.title, phase: result.phase });
    step('the fight ends', result.phase === 'debrief' && !fought.quit, { seconds: fought.seconds, result: result.title, ...(fought.quit ? { quit: fought.quit } : {}) });
    await checkpoint('debrief');
  }

  /* ── Journeys ────────────────────────────────────────────────────────── */
  const J = {
    async firstBattle() {
      const at = Date.now();
      step('title shows', await go('/', TITLE, persona.network === '3g' ? 120000 : 45000));
      rep.boot ??= +((Date.now() - at) / 1000).toFixed(1);
      await sleep(600);
      await checkpoint('title');
      if (!rep.palette) rep.palette = await b.evaluate(`(() => { const cs = getComputedStyle(document.documentElement); return Object.fromEntries(${JSON.stringify(lab.palettePairs.pairs.flat().filter((x) => x.startsWith('--')))}.map((v) => [v, cs.getPropertyValue(v).trim()])); })()`).catch(() => null);
      if (pad) { await b.evaluate(`window.dispatchEvent(new Event('gamepadconnected'))`); await sleep(300); }
      const inputs0 = rep.inputs.n;
      await think();
      await input(() => (pad ? padBtn('START') : kb ? key(' ') : pointAt(`document.querySelector('.dc-title .dc-press')`)));
      step('START opens the doors', await until(`!!document.querySelector('.dc-title.menu')`, 5000));
      await checkpoint('doors');
      const onBattle = `document.activeElement?.classList.contains('dc-door') && /battle/i.test(document.activeElement.textContent)`;
      if (pad || kb) {
        for (let i = 0; i < 6 && !(await until(onBattle, 500)); i++) { await think(0.5); await input(() => (pad ? padBtn('RIGHT') : key('ArrowRight'))); }
        step('the Battle door has focus', await until(onBattle, 1000));
        await think();
        await input(() => (pad ? padBtn('A') : key('Enter')));
      } else {
        await think();
        await input(() => pointAt(`[...document.querySelectorAll('.dc-door')].find((d) => /battle/i.test(d.textContent))`));
      }
      step('the Battle door opens the battle', await until(`location.pathname.endsWith('/sim') && !!document.querySelector('.setup-panel')`, 20000));
      await sleep(2000);
      await checkpoint('setup');
      step('Start starts the fight', await startFight(), { inputs: rep.inputs.n - inputs0 });
      rep.inputsToStart ??= rep.inputs.n - inputs0;
      await debrief(await fight({ watchFrames: true }));
    },

    async marathon() {
      if (!(await b.evaluate(OVER).catch(() => false))) await J.firstBattle();
      const rounds = [{ round: 1, ...(await perf(true)), fps: rep.battles[rep.battles.length - 1]?.frames?.fps ?? null }];
      rep.marathon = { rounds };
      for (let round = 2; round <= 4; round++) {
        await until(`!document.querySelector('.debrief-back .modal[inert]')`, 5000);
        await think();
        if (pad) await input(() => padBtn('A'));    // the debrief opens with its cursor on the primary: Again or Next
        else await activate(`document.querySelector('.debrief-back [data-primary]')`);
        const where = await until(`['battle', 'deploy'].includes(${SIM}?.phase) || (${SIM}?.phase === 'setup' && !document.querySelector('.debrief-back'))`, 15000);
        step(`fight ${round}: Again leads on`, where);
        if (await b.evaluate(`${SIM}?.phase === 'setup'`).catch(() => false)) step(`fight ${round} starts`, await startFight());
        await until(`${SIM}?.phase === 'battle'`, 15000);
        await debrief(await fight({ watchFrames: true }));
        rounds.push({ round, ...(await perf(true)), fps: rep.battles[rep.battles.length - 1]?.frames?.fps ?? null });
      }
    },

    async tour() {
      if (pad || kb) {
        // Past the title by deep link; every cert route; the pad's first press must land focus somewhere visible.
        step('the game opens on a deep link', await go('/academy'));
        if (pad) { await b.evaluate(`window.dispatchEvent(new Event('gamepadconnected'))`); }
        for (const route of routes) {
          await inApp(route);
          await sleep(2200);
          await dismissTips();
          if (pad) { await input(() => padBtn('DOWN')); await sleep(250); }
          await checkpoint('screen', { route });
        }
        return;
      }
      step('the game opens on a deep link', await go('/academy'));
      await sleep(1500);
      const hubs = await b.evaluate(`[...document.querySelectorAll('nav.hubs button.hub')].map((h) => h.getAttribute('aria-label'))`).catch(() => []);
      step('the hubs are on screen', hubs.length > 0, { hubs: hubs.length });
      const all = !!persona.checks?.gallery;
      for (let hi = 0; hi < hubs.length; hi++) {
        const hub = `document.querySelectorAll('nav.hubs button.hub')[${hi}]`;
        const open = async () => {
          if (await b.evaluate(`!!document.querySelector('.hub-menu')`).catch(() => false)) return true;
          await dismissTips();
          await think();
          await input(() => pointAt(hub));
          return until(`!!document.querySelector('.hub-menu')`, 3000);
        };
        if (!soft(`${hubs[hi]}: its menu opens`, await open())) continue;
        const tiles = await b.evaluate(`[...document.querySelectorAll('.hub-menu .hm-item')].map((t) => t.querySelector('.hm-label')?.textContent || t.textContent.trim())`).catch(() => []);
        for (let ti = 0; ti < (all ? tiles.length : Math.min(2, tiles.length)); ti++) {
          if (!(await open())) break;
          await think();
          await input(() => pointAt(`document.querySelectorAll('.hub-menu .hm-item')[${ti}]`));
          const ok = await until(`!document.querySelector('.hub-menu') && (!!document.querySelector('#ui .screen') || !!document.querySelector('.modal-back, .palette'))`, 12000);
          soft(`${hubs[hi]} › ${tiles[ti]}`, ok);
          await sleep(1800);
          await dismissTips();
          await checkpoint('screen', { hub: hubs[hi], tile: tiles[ti] });
          if (await b.evaluate(`!!document.querySelector('.palette')`).catch(() => false)) await input(() => key('Escape'));
        }
      }
    },

    async tabwalk() {
      for (const route of ['/sim', '/academy', '/economy', '/codex/5', '/command']) {
        await go(route);
        await sleep(2500);
        await dismissTips();
        const stops = [];
        for (let i = 0; i < 40; i++) {
          await input(() => key('Tab'), { watch: false });
          await sleep(60);
          stops.push(await b.evaluate(`(() => { const a = document.activeElement; if (!a || a === document.body) return { lost: true };
            const cs = getComputedStyle(a), r = a.getBoundingClientRect();
            return { id: a.tagName + '.' + a.className + '|' + (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 30),
              ring: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none'),
              inView: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && r.width > 0, hub: !!a.closest('nav.hubs') }; })()`).catch(() => ({ lost: true })));
        }
        const real = stops.filter((s) => !s.lost), distinct = new Set(real.map((s) => s.id));
        const w = { route, stops: stops.length, distinct: distinct.size, lost: stops.length - real.length, noRing: real.filter((s) => !s.ring).length,
          outOfView: real.filter((s) => !s.inView).length, hubs: real.some((s) => s.hub), trapped: distinct.size > 0 && distinct.size <= 3 && real.length >= 20,
          noRingNames: [...new Set(real.filter((s) => !s.ring).map((s) => s.id.split('|')[1] || s.id.split('|')[0]))].slice(0, 8) };
        rep.tabwalk.push(w);
        log(`${persona.id} · tabwalk ${route}: ${w.distinct} stops, ${w.noRing} without a ring, ${w.outOfView} out of view${w.trapped ? ', TRAPPED' : ''}${w.hubs ? '' : ', hubs not reached'}`);
        await checkpoint('tab', { route });
      }
    },

    async reader() {
      for (const route of ['/academy', '/codex/5', '/economy', '/ops/orders']) {
        soft(`${route} opens`, await go(route));
        await sleep(2500);
        await dismissTips();
        await checkpoint('read', { route });
      }
    },

    async chaos() {
      step('title shows', await go('/', TITLE));
      const live = routes.length ? routes : ['/', '/sim', '/academy'];
      const keys = ['Enter', ' ', 'Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'g', 'd', '1', 'Backspace'];
      let rotated = false, hang = 0;
      const tally = {};
      for (let i = 0; i < 160; i++) {
        const r = rnd(), x = view.w * rnd(), y = view.h * rnd();
        const kind = r < 0.4 ? 'tap' : r < 0.5 ? 'double' : r < 0.62 ? 'key' : r < 0.7 ? 'route' : r < 0.74 ? 'back' : r < 0.78 ? 'rotate' : r < 0.86 ? 'swipe' : 'control';
        tally[kind] = (tally[kind] || 0) + 1;
        try {
          if (kind === 'tap') await point(x, y);
          else if (kind === 'double') { await point(x, y); await point(x, y); }
          else if (kind === 'key') await key(keys[Math.floor(rnd() * keys.length)]);
          else if (kind === 'route') await inApp(live[Math.floor(rnd() * live.length)].split('#')[0]);
          else if (kind === 'back') await b.evaluate('history.back()');
          else if (kind === 'rotate') {
            rotated = !rotated;
            await b.send('Emulation.setDeviceMetricsOverride', { width: rotated ? view.h : view.w, height: rotated ? view.w : view.h, deviceScaleFactor: view.dpr ?? 2, mobile: !!view.mobile, screenOrientation: rotated ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 } });
          } else if (kind === 'swipe') {
            await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            for (let k = 1; k <= 4; k++) await b.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + k * 40 * (rnd() - 0.5), y: y + k * 30 }] });
            await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          } else {
            const c = await b.evaluate(`(() => { const all = [...document.querySelectorAll('button:not([disabled]), a[href], [role=button]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.bottom > 0 && r.top < innerHeight; }); const e = all[Math.floor(${rnd()} * all.length)]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
            if (c) await point(c.x, c.y);
          }
          rep.inputs.n++;
        } catch (e) { if (b.dead) break; }
        await sleep(hands.reactionMs * (0.5 + rnd()));
        // Back past the first page leaves the game (about:blank): a player would come back in, so do that.
        if (kind === 'back' && !(await b.evaluate(`location.href.startsWith(${JSON.stringify(site.base)})`).catch(() => true))) { tally.leftSite = (tally.leftSite || 0) + 1; await go('/'); }
        if (i % 20 === 19) {
          const alive = await b.evaluate('1 + 1', 8000).catch(() => null);
          if (alive !== 2) { hang++; break; }
          if (i % 40 === 39) await checkpoint('chaos', { action: i + 1 });
        }
      }
      if (rotated) await b.send('Emulation.setDeviceMetricsOverride', { width: view.w, height: view.h, deviceScaleFactor: view.dpr ?? 2, mobile: !!view.mobile }).catch(() => {});
      rep.chaos = { actions: rep.inputs.n, tally, hang, dead: b.dead || null };
      step('the page stays alive through 160 random actions', !hang && !b.dead);
    },

    async offline() {
      const at = Date.now();
      step('the first load finishes', await go('/', TITLE, 150000), { network: persona.network || 'online' });
      rep.boot ??= +((Date.now() - at) / 1000).toFixed(1);
      await checkpoint('title-slow');
      for (const r of ['/galaxy', '/economy']) { await inApp(r); await sleep(6000); }
      await net('offline');
      const seen = [];
      for (const r of ['/galaxy', '/economy', '/grid', '/academy']) {
        await inApp(r);
        await sleep(6000);
        const s = await b.evaluate(`({ route: ${JSON.stringify(r)}, path: location.pathname, mounted: !!document.querySelector('#ui .screen'), says: /no signal|offline|can.?t reach|no connection|reconnect/i.test(document.body.innerText) })`).catch(() => ({ route: r, mounted: false, says: false }));
        seen.push(s);
        await checkpoint('offline', { route: r });
      }
      rep.offline = { boot: rep.boot, seen };
      soft('with no signal every screen still opens', seen.every((s) => s.mounted), { failed: seen.filter((s) => !s.mounted).map((s) => s.route) });
      soft('with no signal the game says so', seen.some((s) => s.says));
      await net(persona.network || 'online');
      const back = await until(`!/no signal/i.test(document.body.innerText)`, 45000, 1000);
      rep.offline.recovered = back;
      step('when the signal returns the game recovers', back);
      await checkpoint('recovered');
    },

    async interrupt() {
      step('the battle setup opens', await go('/sim', `!!document.querySelector('.setup-panel')`));
      await sleep(1500);
      step('Start starts the fight', await startFight());
      await fight({ shots: 2 });
      const before = await b.evaluate(`${SIM}?.session?.chain?.height ?? 0`).catch(() => 0);
      let how = 'lifecycle';
      try {
        await b.send('Page.setWebLifecycleState', { state: 'frozen' });
        await sleep(4000);
        await b.send('Page.setWebLifecycleState', { state: 'active' });
      } catch {
        how = 'visibility';
        await b.evaluate(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'))`);
        await sleep(4000);
        await b.evaluate(`delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))`);
      }
      await sleep(3000);
      const after = await b.evaluate(`({ phase: ${SIM}?.phase, height: ${SIM}?.session?.chain?.height ?? 0 })`).catch(() => ({}));
      step('back from the background, the fight goes on', ['battle', 'debrief'].includes(after.phase), { how, blocksWhileAway: after.height - before });
      await b.send('Emulation.setDeviceMetricsOverride', { width: view.h, height: view.w, deviceScaleFactor: view.dpr ?? 2, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
      await sleep(2500);
      await checkpoint('landscape');
      await b.send('Emulation.setDeviceMetricsOverride', { width: view.w, height: view.h, deviceScaleFactor: view.dpr ?? 2, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
      await sleep(2000);
      await checkpoint('portrait-again');
      rep.interrupt = { how, blocksWhileAway: after.height - before };
      await debrief(await fight());
    },
  };

  for (const name of persona.journeys) {
    if (b.dead) { rep.journeys.push({ name, ok: false, steps: [], error: 'browser gone: ' + b.dead }); continue; }
    journey = name;
    const j = { name, ok: true, steps: [], s0: secs() };
    rep.journeys.push(j);
    const p0 = b.problems.length;
    try {
      if (!J[name]) throw new Error('no such journey');
      await J[name]();
    } catch (e) {
      j.ok = false;
      j.error = String(e?.message || e).split('\n')[0];
      if (!e?.journeyStep) log(`${persona.id} ✗ ${name}: ${j.error}`);
      await checkpoint('failed').catch(() => {});
    }
    if (cast) await castStop('journey-end');
    j.seconds = +(secs() - j.s0).toFixed(1);
    j.problems = b.problems.slice(p0);
  }
  const tail = await b.evaluate(`window.__probe ? { long: window.__probe.long, cls: +window.__probe.cls.toFixed(3), live: window.__probe.live, liveText: window.__probe.liveText.slice(-30) } : null`).catch(() => null);
  rep.longTasks = tail?.long || [];
  rep.cls = tail?.cls ?? null;
  rep.live = tail ? { changes: tail.live, sample: tail.liveText } : null;
  rep.problems.push(...b.problems);
  rep.seconds = secs();
  await b.close();
  writeFileSync(join(outDir, 'browser.json'), JSON.stringify(rep, null, 1));
  return rep;
}
