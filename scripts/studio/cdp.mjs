/* The studio's headless browser. One Chrome per call, driven over the DevTools protocol, with
 * every console error, uncaught exception and crash collected as it happens.
 *
 * GPU: on a Mac the real GPU is used (ANGLE Metal), which renders a scene in real time; anywhere
 * else, or with STUDIO_GL=swiftshader, the software rasteriser CI has. Both are what players run:
 * the engine has a lighter path for software GL (core/engine.ts softwareGL). */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, preview } from 'vite';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const chromePath = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
].find((p) => p && existsSync(p) && statSync(p).isFile());

export const GL = process.env.STUDIO_GL || (process.platform === 'darwin' && !process.env.CI ? 'metal' : 'swiftshader');

/** Chromes still running when this process ends are killed, not orphaned. */
const children = new Set();
const killAll = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } };
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(130); });

/** A site to test: STUDIO_URL (a running dev server), STUDIO_DIST (a build already made), or a private production build served on a free port. */
export async function serveSite() {
  if (process.env.STUDIO_URL) return { base: process.env.STUDIO_URL.replace(/\/$/, ''), close: async () => {} };
  // A build made earlier in the same pipeline run: serve it as it is.
  if (process.env.STUDIO_DIST) {
    const server = await preview({ build: { outDir: process.env.STUDIO_DIST }, preview: { port: 0 }, logLevel: 'silent' });
    return { base: server.resolvedUrls.local[0].replace(/\/$/, ''), close: async () => { await server.close(); } };
  }
  const outDir = mkdtempSync(join(tmpdir(), 'structs-studio-dist-'));
  await build({ build: { outDir, emptyOutDir: true }, logLevel: 'warn' });
  const server = await preview({ build: { outDir }, preview: { port: 0 }, logLevel: 'silent' });
  return {
    base: server.resolvedUrls.local[0].replace(/\/$/, ''),
    outDir,
    close: async () => { await server.close(); try { rmSync(outDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp */ } },
  };
}

/**
 * Open a browser at a viewport. Returns { send, evaluate, shot, problems, close }.
 * view: { w, h, mobile?, dpr? }. opts.flags: extra Chrome flags. opts.reducedMotion (default true). opts.gl: 'metal' | 'swiftshader'.
 * opts.siteBase: only resource errors from this origin count as problems (third-party failures are
 * the network's business, not the build's).
 */
export async function openBrowser(view, opts = {}) {
  // A loaded machine sometimes fails a Chrome's DevTools socket on start: try again before giving up.
  for (let attempt = 1; ; attempt++) {
    try { return await launch(view, opts); } catch (e) {
      if (attempt >= 3) throw e;
      console.warn(`studio: browser start failed (${e?.message || e}); retrying`);
      await sleep(1500 * attempt);
    }
  }
}

async function launch(view, opts) {
  if (!chromePath) throw new Error('no Chrome or Chromium found (set CHROME=/path/to/the/binary)');
  const problems = [];
  const profile = mkdtempSync(join(tmpdir(), 'structs-studio-'));
  // opts.gl: one browser on another GPU path (a persona on an old laptop draws in software).
  const gl = (opts.gl || GL) === 'metal'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    ...gl, '--hide-scrollbars', '--window-size=1600,1000', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', ...(opts.flags || [])];
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  args.push('about:blank');
  const chrome = spawn(chromePath, args, { stdio: 'ignore' });
  children.add(chrome);
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.once('error', (e) => problems.push('could not start Chrome: ' + e.message));
  let ws, dead = '', id = 0;
  const pending = new Map();
  const listeners = new Set();
  const failAll = (why) => { dead ||= why; for (const p of pending.values()) p.reject(new Error(why)); pending.clear(); };

  const fail = async (e) => {
    try { chrome.kill('SIGKILL'); } catch { /* gone */ }
    children.delete(chrome);
    await Promise.race([exited, sleep(2000)]);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* the OS cleans up */ }
    throw e;
  };
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || 0; } catch { /* not yet */ }
    if (!port) await sleep(100);
  }
  if (!port) return fail(new Error('Chrome did not open a debugging port'));
  for (let i = 0; i < 50 && !ws; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* not ready */ }
    if (!ws) await sleep(200);
  }
  if (!ws) return fail(new Error('no page target'));
  try {
    await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('DevTools socket failed')), { once: true }); });
  } catch (e) { return fail(e); }
  ws.addEventListener('close', () => failAll('DevTools connection closed'));
  const site = opts.siteBase || '';
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); return; }
    for (const l of listeners) l(m);
    if (m.method === 'Inspector.targetCrashed') { problems.push('renderer crashed'); failAll('renderer crashed'); }
    if (m.method === 'Runtime.exceptionThrown') problems.push('uncaught: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const { text = '', url = '' } = m.params.entry;
      // Only the site's own resources: the testnet, guilds and fonts failing are the network's business.
      if (url && site && url.startsWith(site) && !/blocked by CORS/.test(text)) problems.push('log: ' + text.slice(0, 160));
    }
  });
  const send = (method, params = {}, ms = 30000) => new Promise((resolve, reject) => {
    if (dead) { reject(new Error(dead)); return; }
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); reject(new Error(`${method} timed out`)); }, ms);
    pending.set(i, { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Inspector.enable');
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: view.w, height: view.h, deviceScaleFactor: view.dpr ?? (view.mobile ? 2 : 1), mobile: !!view.mobile });
  if (view.mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // A headless page never holds window focus, so :focus and the cursor ring would never show: act focused.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // STUDIO_CPU_THROTTLE=12 slows the page's CPU (CDP), to reproduce CI's software-GPU frame rates here.
  if (Number(process.env.STUDIO_CPU_THROTTLE) > 1) await send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.STUDIO_CPU_THROTTLE) });
  if (opts.reducedMotion !== false) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  // Prompts and alerts would block every later evaluate: the studio never answers them.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.alert = () => {}; window.prompt = () => null; window.confirm = () => false;' + (opts.init || '') });

  /** Evaluate an expression (may be async) and return its value; throws on an exception. */
  const evaluate = async (expression, ms = 30000) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms);
    if (r.result?.exceptionDetails) throw new Error('evaluate: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).split('\n')[0]);
    return r.result?.result?.value;
  };
  const shot = async (format = 'png', quality) => {
    const r = await send('Page.captureScreenshot', { format, ...(quality ? { quality } : {}) }, 45000);
    return r.result?.data ? Buffer.from(r.result.data, 'base64') : null;
  };
  const close = async () => {
    failAll('closed');
    try { ws?.close(); } catch { /* closing anyway */ }
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await Promise.race([exited, sleep(2000)]); }
    children.delete(chrome);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left for the OS */ }
  };
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).then((v) => String(v.Browser || '').split('/')[1] || '').catch(() => '');
  // engine, version, pid and unsupported match firefox.mjs, so the persona lab can run either and compare.
  return { engine: 'chrome', version, pid: chrome.pid, unsupported: new Set(), send, evaluate, shot, problems, close, on: (fn) => listeners.add(fn), get dead() { return dead; } };
}

/** Run jobs with at most n in flight; results in order. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/* ── The bots' gamepad ───────────────────────────────────────────────────── */

/** A virtual gamepad (navigator.getGamepads stubbed in the page) for the playtest and pad-tour bots.
 * A press is a pulse: the button reads pressed during exactly one of pad.ts's polls (it counts them
 * in window.__padPolls) and released after. Holding a button for "two frames" instead turned into a
 * held, auto-repeating d-pad (pad.ts repeats arrows after 320 ms) once CI's software GPU drew at
 * 1–3 fps, and the tour overshot tiles. */
export const PAD_STUB = `
  window.__pad = { id: 'studio-bot', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  window.__padPulse = null;
  window.__padPress = (i) => { window.__padPulse = { button: i, at: (window.__padPolls || 0) + 1 }; };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => {
    const p = window.__pad, q = window.__padPulse, n = window.__padPolls || 0;
    const on = q && n === q.at ? q.button : -1;
    if (q && n > q.at) window.__padPulse = null;
    for (let i = 0; i < p.buttons.length; i++) { const b = p.buttons[i]; b.pressed = b.touched = i === on; b.value = i === on ? 1 : 0; }
    p.timestamp = n;
    return [p];
  } });
`;
export const PAD_BUTTON = { A: 0, B: 1, X: 2, Y: 3, L: 4, R: 5, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

/** Press a pad button once and wait until the page has seen it pressed and let go. `unless` (a page
 * expression) is checked in the same breath and skips the press. Resolves false when skipped. */
export async function padPress(b, name, unless = 'false') {
  const pressed = await b.evaluate(`(() => { if (${unless}) return false; window.__padPress(${PAD_BUTTON[name]}); return true; })()`);
  if (!pressed) return false;
  for (let end = Date.now() + 30000; Date.now() < end; await sleep(40)) {
    if (await b.evaluate('window.__padPulse === null').catch(() => false)) return true;
  }
  throw new Error(`the page never read the pad's ${name} (no pad polls for 30 s)`);
}

