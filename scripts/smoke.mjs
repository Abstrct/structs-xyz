/* End-to-end smoke test. Builds the site into its own directory and serves it. Then it opens
 * every screen in headless Chrome at a desktop and a phone size, again with the testnet
 * unreachable, and once with the testnet coming back mid-visit. A check fails on:
 *   - an uncaught exception, a console.error, or a resource error from the site itself;
 *   - a screen that never mounts;
 *   - a visible element running past the right edge;
 *   - a blank 3D view;
 *   - a live screen that shows no chain data online, doesn't explain an outage offline,
 *     or doesn't recover once the testnet answers again.
 *
 * usage: pnpm smoke                 (typechecks, then runs this)
 *        CHROME=/path/to/chrome      to pick the browser
 *        SMOKE_SHOTS=dir             to keep a screenshot of every check
 *        SMOKE_QUICK=1               desktop online checks only (one per route)
 *        VITE_SITE_URL=https://x.github.io/repo   build and serve under that base path (/repo/):
 *                                    any file the page asks for outside it 404s and fails the check
 * Needs Node 22+ (global WebSocket) and Chrome or Chromium. Without them it skips, which
 * counts as a failure when CI is set. Online checks need the public testnet to be up. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, preview } from 'vite';

const skip = (why) => { console.log(`smoke: ${why}; skipped`); process.exit(process.env.CI ? 1 : 0); };
const chromePath = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
].find((p) => p && existsSync(p) && statSync(p).isFile());
if (!chromePath) skip('no Chrome or Chromium found (set CHROME=/path/to/the/binary)');
if (typeof WebSocket === 'undefined') skip('needs Node 22+ (global WebSocket)');

const HOST = 'public.testnet.structs.network';
/** Each screen: what it shows once the chain answers, and what it says when it can't (null: works offline). */
const ROUTES = [
  // The title is up on arrival: LIVE once the chain answers, "Galaxy not answering" when it can't.
  { hash: '/galaxy', online: /\bLIVE\b/, offline: /not answering/i },
  { hash: '/planet/2-1', online: /shield/i, offline: /no signal/i },
  { hash: '/combat', online: /replays\s+[\d,]+/i, offline: /could not be read/i },
  { hash: '/grid', online: /power grid\s+\d/i, offline: /could not be read/i },
  { hash: '/sim', online: null, offline: null },
  { hash: '/sim/daily', online: null, offline: null },
  { hash: '/codex/5', online: null, offline: null },
  // The commander's screens work with no vault: they invite you to enlist.
  { hash: '/command', online: /enlist/i, offline: /enlist/i },
  // An idle engine shows one line ("Starts when you build"); a busy one its hashrate.
  { hash: '/ops/proofs', online: /hashrate|starts when you build/i, offline: /hashrate|starts when you build/i },
  { hash: '/forge/MsgStructAttack', online: /struct attack/i, offline: /struct attack/i },
  { hash: '/intel/activity', online: /activity/i, offline: /activity/i },
  { hash: '/guild/0-5', online: /roster/i, offline: /registry|roster/i },
  { hash: '/comms', online: /channel/i, offline: /channel/i },
  { hash: '/economy', online: /power/i, offline: /power/i },
  // The Academy is local: its lessons need no chain.
  { hash: '/academy', online: /strategy/i, offline: /strategy/i },
];
const DESKTOP = { name: 'desktop', w: 1440, h: 900, mobile: false };
const PHONE = { name: 'phone', w: 390, h: 844, mobile: true };
const CHECKS = process.env.SMOKE_QUICK ? ROUTES.map((route) => ({ route, view: DESKTOP, mode: 'online' })) : [
  ...ROUTES.map((route) => ({ route, view: DESKTOP, mode: 'online' })),
  ...ROUTES.map((route) => ({ route, view: PHONE, mode: 'online' })),
  ...ROUTES.map((route) => ({ route, view: DESKTOP, mode: 'offline' })),
  // The galaxy retries every 15 s: blocked at first, reachable from 6 s, it must come back by itself.
  { route: ROUTES[0], view: DESKTOP, mode: 'recover' },
];
/** How long each kind of check lets the page run before probing it. Offline outlasts the first 15 s retry. */
const SETTLE = { online: 13000, offline: 21000, recover: 36000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.SMOKE_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

// Chromes still running when this process ends (a crash, Ctrl-C) are killed, not orphaned.
const children = new Set();
const killAll = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } };
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(130); });

// A private build directory: a concurrent `pnpm build` or smoke run can't swap files underneath.
const outDir = mkdtempSync(join(tmpdir(), 'structs-smoke-dist-'));
await build({ build: { outDir, emptyOutDir: true }, logLevel: 'warn' });
const server = await preview({ build: { outDir }, preview: { port: 4317 }, logLevel: 'silent' });
// The build reads each guild's guild.json itself (no relay), and every check is a fresh browser: 46
// checks would ask the guilds' own hosts hundreds of times a run (a pastebin among them rate-limits).
// Those exact files are blocked instead; the page treats them as unreachable, which it handles.
const GUILD_FILES = await fetch(`https://${HOST}/structs/guild?pagination.limit=500`, { signal: AbortSignal.timeout(15000) })
  .then((r) => r.json()).then((j) => (j.Guild || []).map((g) => g.endpoint).filter((u) => /^https?:\/\//.test(u || ''))).catch(() => []);
const base = server.resolvedUrls.local[0];

async function run({ route, view, mode }) {
  const problems = [];
  const profile = mkdtempSync(join(tmpdir(), 'structs-smoke-'));
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--window-size=1600,1000', '--disable-dev-shm-usage',
  ];
  if (process.getuid?.() === 0) args.push('--no-sandbox'); // containers run as root
  // Offline means unresolvable: the LCD and the WebSocket both fail, as in a real outage.
  if (mode === 'offline') args.push(`--host-resolver-rules=MAP ${HOST} ~NOTFOUND`);
  args.push('about:blank');
  const chrome = spawn(chromePath, args, { stdio: 'ignore' });
  children.add(chrome);
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.once('error', (e) => problems.push('could not start Chrome: ' + e.message));
  let ws;
  const pending = new Map();
  let dead = '';
  const failAll = (why) => { dead ||= why; for (const p of pending.values()) p.reject(new Error(why)); pending.clear(); };
  try {
    // The OS picks the port and Chrome writes it here, so parallel runs never attach to each other.
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || 0; } catch { /* not yet */ }
      if (!port) await sleep(100);
    }
    if (!port) throw new Error('Chrome did not open a debugging port');
    for (let i = 0; i < 50 && !ws; i++) {
      try {
        const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
        if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
      } catch { /* not ready */ }
      if (!ws) await sleep(200);
    }
    if (!ws) throw new Error('no page target');
    await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('DevTools socket failed')), { once: true }); });
    ws.addEventListener('close', () => failAll('DevTools connection closed'));
    let id = 0;
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); return; }
      if (m.method === 'Inspector.targetCrashed') { problems.push('renderer crashed'); failAll('renderer crashed'); }
      if (m.method === 'Runtime.exceptionThrown') problems.push('uncaught: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160));
      // Resource errors from the site itself (404s, CSP). The testnet's own failures are the outage under test,
      // and a guild refusing this site its guild.json (no CORS: the build reads guilds directly) is the guild's choice.
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        const { text = '', url = '' } = m.params.entry;
        const thirdParty = /blocked by CORS policy/.test(text) || (/net::ERR_(FAILED|BLOCKED_BY_CLIENT)/.test(text) && url && !url.startsWith(base));
        if (!(url + ' ' + text).includes(HOST) && !thirdParty) problems.push('log: ' + text.slice(0, 160));
      }
    });
    // Every command has a deadline, so a wedged renderer fails the check instead of hanging the run.
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
    await send('Emulation.setDeviceMetricsOverride', { width: view.w, height: view.h, deviceScaleFactor: view.mobile ? 2 : 1, mobile: view.mobile });
    if (view.mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    // Reduced motion skips camera intros, so every screen is settled by the time it is probed.
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    if (mode === 'recover') await send('Network.setBlockedURLs', { urls: [`*${HOST}*`, ...GUILD_FILES] });
    else if (GUILD_FILES.length) await send('Network.setBlockedURLs', { urls: GUILD_FILES });
    await send('Page.navigate', { url: base.replace(/\/$/, '') + route.hash });
    if (mode === 'recover') { await sleep(6000); await send('Network.setBlockedURLs', { urls: GUILD_FILES }); await sleep(SETTLE.recover - 6000); }
    else await sleep(SETTLE[mode]);
    const probe = await send('Runtime.evaluate', {
      awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        const canvas = document.querySelector('canvas');
        const png = canvas ? await new Promise((r) => requestAnimationFrame(() => r(canvas.toDataURL('image/png').length))) : 0;
        // Anything visible past the right edge, unless an inner container clips it on purpose (a scroll
        // area, an ellipsis row). Clipped by the page or the screen itself, it is simply cut off: that
        // counts. 3D-anchored labels, toasts and the tooltip are allowed to sit off screen.
        const W = innerWidth + 1, wide = [];
        for (const el of document.querySelectorAll('body *')) {
          if (el.closest('.tags-layer, .grid-label, .colcap, .tooltip, .toasts, #boot')) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || r.right <= W) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
          let clipped = false;
          for (let a = el.parentElement; a && !clipped; a = a.parentElement) {
            const o = getComputedStyle(a).overflowX;
            if (o !== 'visible' && !a.matches('html, body, #ui, #ui > .screen') && a.getBoundingClientRect().right <= W) clipped = true;
          }
          if (!clipped) wide.push((el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName.toLowerCase()) + ' to ' + Math.round(r.right) + 'px');
          if (wide.length >= 3) break;
        }
        return { mounted: !!document.querySelector('#ui .screen'), wide, png, text: document.body.innerText };
      })()`,
    });
    const v = probe.result?.result?.value;
    if (!v) problems.push('probe failed: ' + JSON.stringify(probe.result?.exceptionDetails?.text || probe.error || null));
    else {
      if (!v.mounted) problems.push('no screen mounted');
      if (v.wide.length) problems.push('runs past the right edge: ' + v.wide.join(', '));
      if (v.png < 40000) problems.push(`3D view looks blank (${v.png} B png)`);
      const expect = mode === 'offline' ? route.offline : route.online;
      if (expect && !expect.test(v.text)) problems.push(mode === 'offline' ? `outage not explained (expected ${expect})` : `no chain data shown (expected ${expect}; is the testnet up?)`);
      if (mode === 'recover' && route.offline?.test(v.text)) problems.push('still reports the outage after the testnet came back');
    }
    if (shots && !dead) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (shot.result?.data) writeFileSync(join(shots, `${route.hash.slice(1).replace(/\//g, '_')}-${view.name}${mode === 'online' ? '' : '-' + mode}.png`), Buffer.from(shot.result.data, 'base64'));
    }
  } catch (e) {
    problems.push('harness: ' + (e?.message || e));
  } finally {
    failAll('check finished');
    try { ws?.close(); } catch { /* closing anyway */ }
    chrome.kill();
    // Chrome writes to its profile while it shuts down: wait for it (then insist) before removing it.
    await Promise.race([exited, sleep(5000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await Promise.race([exited, sleep(2000)]); }
    children.delete(chrome);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left for the OS to clean */ }
  }
  return problems;
}

// Three browsers at a time: SwiftShader is CPU-bound.
const results = new Array(CHECKS.length);
let next = 0;
try {
  await Promise.all([0, 1, 2].map(async () => {
    while (next < CHECKS.length) {
      const i = next++;
      results[i] = await run(CHECKS[i]);
      const c = CHECKS[i];
      const label = `${c.route.hash.padEnd(14)} ${c.view.name.padEnd(7)} ${c.mode}`;
      console.log((results[i].length ? '✗ ' : '✓ ') + label + (results[i].length ? '\n    ' + [...new Set(results[i])].join('\n    ') : ''));
    }
  }));
} finally {
  await server.close();
  try { rmSync(outDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp */ }
}
const failed = results.filter((r) => r.length).length;
console.log(failed ? `smoke: ${failed} of ${CHECKS.length} checks failed` : `smoke: all ${CHECKS.length} checks passed`);
process.exit(failed ? 1 : 0);
