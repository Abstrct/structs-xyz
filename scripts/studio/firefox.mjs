/* The studio's Firefox: headless Firefox driven over WebDriver BiDi (built into Firefox, no geckodriver),
 * behind the same interface as cdp.mjs's openBrowser, so the persona lab's journeys run unchanged.
 *
 * The bots speak Chrome DevTools methods. send() translates the ones they use:
 *   Page.navigate                  browsingContext.navigate
 *   Runtime evaluate (evaluate())  script.evaluate, the result deserialised from BiDi's remote values
 *   Page.captureScreenshot         browsingContext.captureScreenshot (a clip box; no scale, so full size)
 *   Input.dispatchMouse/Touch/Key  input.performActions (a mouse, a finger, a keyboard)
 *   Emulation.setDeviceMetrics…    browsingContext.setViewport (with the device pixel ratio)
 *   Network.emulateNetwork…        emulation.setNetworkConditions (offline only: BiDi has no throttling)
 *   Performance.getMetrics         DOM node count from the page (Firefox exposes no heap size)
 * Reduced motion is a pref set at launch (ui.prefersReducedMotion). Anything else Firefox can't do
 * (colour-vision emulation, CPU throttling, the accessibility tree, screencasts, a forced GC) resolves
 * empty and is listed in `unsupported`, so a report can say what wasn't measured instead of passing it.
 * Uncaught errors, console.error and failed loads of the site's own files land in `problems`, as in cdp.mjs. */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep } from './cdp.mjs';

export const firefoxPath = [
  process.env.FIREFOX,
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/Applications/Firefox Nightly.app/Contents/MacOS/firefox',
  '/usr/bin/firefox', '/usr/bin/firefox-esr', '/snap/bin/firefox', '/opt/homebrew/bin/firefox',
].find((p) => p && existsSync(p) && statSync(p).isFile());

const children = new Set();
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

/** WebDriver key codes for the keys the bots press. (Enter is Return, \uE006: \uE007 is the numpad's Enter, code NumpadEnter.) */
const wd = (n) => String.fromCharCode(0xE000 + n);
const WD_KEY = { Enter: wd(0x06), Escape: wd(0x0C), Tab: wd(0x04), Backspace: wd(0x03), ArrowLeft: wd(0x12), ArrowUp: wd(0x13), ArrowRight: wd(0x14), ArrowDown: wd(0x15), Shift: wd(0x08) };

/** A BiDi remote value as plain JSON (what CDP's returnByValue gives). */
function plain(v) {
  if (!v) return undefined;
  switch (v.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': case 'boolean': return v.value;
    case 'number': return typeof v.value === 'number' ? v.value : v.value === 'NaN' ? NaN : v.value === '-0' ? -0 : v.value === 'Infinity' ? Infinity : -Infinity;
    case 'bigint': return Number(v.value);
    case 'array': case 'set': return (v.value || []).map(plain);
    case 'object': case 'map': return Object.fromEntries((v.value || []).map(([k, x]) => [typeof k === 'string' ? k : plain(k), plain(x)]));
    case 'date': return v.value;
    case 'regexp': return v.value?.pattern;
    default: return v.value !== undefined && typeof v.value !== 'object' ? v.value : {};
  }
}

/** Open Firefox at a viewport. Same shape as cdp.mjs openBrowser: { send, evaluate, shot, problems, close, on, dead },
 * plus engine, version, pid (for CPU and memory) and unsupported. opts: siteBase, init, reducedMotion. */
export async function openFirefox(view, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await launch(view, opts); } catch (e) {
      if (attempt >= 3) throw e;
      console.warn(`studio: Firefox start failed (${e?.message || e}); retrying`);
      await sleep(1500 * attempt);
    }
  }
}

async function launch(view, opts) {
  if (!firefoxPath) throw new Error('no Firefox found (set FIREFOX=/path/to/firefox)');
  const profile = mkdtempSync(join(tmpdir(), 'structs-studio-ff-'));
  const prefs = {
    'focusmanager.testmode': true,                    // a headless window holds focus: :focus-visible and rings show
    'ui.prefersReducedMotion': opts.reducedMotion === false ? 0 : 1,
    'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0,
    'dom.disable_beforeunload': true, 'dom.gamepad.enabled': true,
    'browser.shell.checkDefaultBrowser': false, 'browser.aboutwelcome.enabled': false, 'browser.startup.homepage_override.mstone': 'ignore',
    'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.reportingpolicy.firstRun': false, 'app.update.disabledForTesting': true,
    'browser.tabs.warnOnClose': false, 'browser.sessionstore.resume_from_crash': false, 'network.captive-portal-service.enabled': false,
  };
  writeFileSync(join(profile, 'user.js'), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));
  // --new-instance: with another Firefox already running (a player's, another tool's), macOS otherwise hands the
  // launch to it, and this process exits under the bots.
  const ff = spawn(firefoxPath, ['--headless', '--no-remote', '--new-instance', '--profile', profile, '--remote-debugging-port=0', `--width=${view.w}`, `--height=${view.h}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(ff);
  const exited = new Promise((r) => ff.once('exit', r));
  const problems = [], unsupported = new Set(), listeners = new Set(), pending = new Map();
  let ws, dead = '', id = 0, context = '', version = '';
  const failAll = (why) => { dead ||= why; for (const p of pending.values()) p.reject(new Error(why)); pending.clear(); };
  // Firefox's last words, for when it goes: its stderr tail, exit code and signal.
  let errTail = '';
  ff.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
  ff.once('exit', (code, signal) => { if (!closing) { problems.push(`browser exited (code ${code}, signal ${signal})`); failAll(`Firefox exited (code ${code}, signal ${signal}): ${errTail.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)}`); } });
  let closing = false;
  const fail = async (e) => { try { ff.kill('SIGKILL'); } catch { /* gone */ } children.delete(ff); await Promise.race([exited, sleep(2000)]); try { rmSync(profile, { recursive: true, force: true }); } catch { /* temp */ } throw e; };

  // Firefox prints the BiDi address on stderr once its remote agent listens.
  const url = await new Promise((resolve) => {
    let buf = '';
    const t = setTimeout(() => resolve(null), 30000);
    const take = (d) => { buf += d; const m = /WebDriver BiDi listening on (ws:\/\/[\d.:]+)/.exec(buf); if (m) { clearTimeout(t); resolve(m[1]); } };
    ff.stderr.on('data', take); ff.stdout.on('data', take);
    ff.once('exit', () => { clearTimeout(t); resolve(null); });
  });
  if (!url) return fail(new Error('Firefox did not open WebDriver BiDi'));
  ws = new WebSocket(url + '/session');
  try { await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('BiDi socket failed')), { once: true }); }); } catch (e) { return fail(e); }
  // (A moment's grace, so the process's own exit, with its code, signal and last stderr lines, names the cause.)
  ws.addEventListener('close', () => setTimeout(() => failAll('BiDi connection closed' + (closing ? '' : ` (Firefox ${ff.exitCode != null || ff.signalCode ? `exited: code ${ff.exitCode}, signal ${ff.signalCode}` : 'still running'}; stderr: ${errTail.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 240)})`)), 500));
  const site = opts.siteBase || '';
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.type === 'error') p.reject(new Error(`${m.error}: ${m.message}`)); else p.resolve(m.result); return; }
    if (m.type !== 'event') return;
    for (const l of listeners) l(m);
    const p = m.params || {};
    if (m.method === 'log.entryAdded') {
      if (p.type === 'javascript') problems.push('uncaught: ' + String(p.text || '').split('\n')[0].slice(0, 200));
      else if (p.level === 'error') problems.push('console.error: ' + String(p.text || (p.args || []).map((a) => plain(a)).join(' ')).slice(0, 160));
    }
    if (m.method === 'network.fetchError' && site && String(p.request?.url || '').startsWith(site)) problems.push('log: failed to load ' + p.request.url.slice(site.length) + ' (' + p.errorText + ')');
    if (m.method === 'network.responseCompleted' && site && String(p.request?.url || '').startsWith(site) && p.response?.status >= 400) problems.push(`log: ${p.response.status} ${p.request.url.slice(site.length)}`);
  });
  const bidi = (method, params = {}, ms = 30000) => new Promise((resolve, reject) => {
    if (dead) { reject(new Error(dead)); return; }
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); reject(new Error(`${method} timed out`)); }, ms);
    pending.set(i, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  try {
    const s = await bidi('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true, unhandledPromptBehavior: { default: 'accept' } } } });
    version = s?.capabilities?.browserVersion || '';
    context = (await bidi('browsingContext.getTree', {})).contexts[0].context;
    await bidi('session.subscribe', { events: ['log.entryAdded', 'network.fetchError', 'network.responseCompleted'] });
    await bidi('browsingContext.setViewport', { context, viewport: { width: view.w, height: view.h }, devicePixelRatio: view.dpr ?? (view.mobile ? 2 : 1) });
    // __ffKey: the last key event as the page's handlers left it (see the key activation below).
    const init = 'window.alert = () => {}; window.prompt = () => null; window.confirm = () => false; addEventListener(\'keydown\', (e) => { window.__ffKey = e; }, true); addEventListener(\'keyup\', (e) => { window.__ffKeyUp = e; }, true);' + (opts.init || '');
    await bidi('script.addPreloadScript', { functionDeclaration: `() => { ${init}\n }` });
  } catch (e) { return fail(e); }

  /** Headless Firefox doesn't give its window focus: keys reach the page, but Enter and Space never press
   * a focused button and document.hasFocus() is false. Activating the context focuses it. */
  const activate = () => bidi('browsingContext.activate', { context }).catch(() => {});
  await activate();
  const evaluate = async (expression, ms = 30000) => {
    const r = await bidi('script.evaluate', { expression, target: { context }, awaitPromise: true, resultOwnership: 'none', serializationOptions: { maxObjectDepth: 12, maxDomDepth: 0 } }, ms);
    if (r.type === 'exception') throw new Error('evaluate: ' + String(r.exceptionDetails?.text || 'exception').split('\n')[0]);
    return plain(r.result);
  };
  const shot = async (format = 'png', quality) => {
    const r = await bidi('browsingContext.captureScreenshot', { context, origin: 'viewport', format: { type: 'image/' + format, ...(quality ? { quality: quality / 100 } : {}) } }, 45000);
    return r?.data ? Buffer.from(r.data, 'base64') : null;
  };
  const act = (actions) => bidi('input.performActions', { context, actions });
  const pt = (n) => Math.max(0, Math.round(n));
  let touching = false;

  /** The CDP methods the bots use, in BiDi. Results come back CDP-shaped ({ result }). */
  async function send(method, p = {}) {
    switch (method) {
      case 'Page.navigate':
        await bidi('browsingContext.navigate', { context, url: p.url, wait: 'none' });
        await activate();
        return { result: {} };
      case 'Page.captureScreenshot': {
        const c = p.clip;
        const r = await bidi('browsingContext.captureScreenshot', { context, origin: 'viewport', format: { type: 'image/' + (p.format || 'png'), ...(p.quality ? { quality: p.quality / 100 } : {}) }, ...(c ? { clip: { type: 'box', x: c.x, y: c.y, width: c.width, height: c.height } } : {}) }, 45000);
        return { result: { data: r.data } };
      }
      case 'Input.dispatchMouseEvent': {
        const move = { type: 'pointerMove', x: pt(p.x), y: pt(p.y), duration: 0 };
        const steps = p.type === 'mouseMoved' ? [move] : p.type === 'mousePressed' ? [move, { type: 'pointerDown', button: 0 }] : [{ type: 'pointerUp', button: 0 }];
        await act([{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: steps }]);
        return { result: {} };
      }
      case 'Input.dispatchTouchEvent': {
        const tp = p.touchPoints?.[0];
        let steps;
        if (p.type === 'touchStart') { steps = [{ type: 'pointerMove', x: pt(tp.x), y: pt(tp.y), duration: 0 }, { type: 'pointerDown', button: 0 }]; touching = true; }
        else if (p.type === 'touchMove') steps = [{ type: 'pointerMove', x: pt(tp.x), y: pt(tp.y), duration: 16 }];
        else { steps = touching ? [{ type: 'pointerUp', button: 0 }] : []; touching = false; }
        if (steps.length) await act([{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: steps }]);
        return { result: {} };
      }
      case 'Input.dispatchKeyEvent': {
        const value = WD_KEY[p.key] || (p.key === ' ' ? ' ' : p.key);
        const shift = p.modifiers & 8;
        const down = p.type !== 'keyUp';
        const steps = [...(shift && down ? [{ type: 'keyDown', value: WD_KEY.Shift }] : []), { type: down ? 'keyDown' : 'keyUp', value }, ...(shift && !down ? [{ type: 'keyUp', value: WD_KEY.Shift }] : [])];
        await act([{ type: 'key', id: 'keyboard', actions: steps }]);
        // Headless Firefox on macOS never holds OS focus, so a focused button ignores Enter and Space (a
        // focused Firefox presses it). Do that one native step here: Enter on keydown, Space on keyup, and
        // only when no handler of the game prevented the key. A key the game swallows stays swallowed.
        const native = (p.key === 'Enter' && down) || (p.key === ' ' && !down);
        if (native) {
          // (Space as Firefox does it: the press began on this button with a keydown nobody cancelled.)
          const pressed = await evaluate(`(() => { const e = ${down ? 'window.__ffKey' : 'window.__ffKeyUp'}, d = window.__ffKey, a = document.activeElement;
            if (document.hasFocus() || !e || e.defaultPrevented || e.target !== a || ${down ? "e.key !== 'Enter'" : "e.key !== ' ' || !d || d.key !== ' ' || d.defaultPrevented || d.target !== a"} || !a || !a.matches('button:not([disabled]), input[type=button]:not([disabled]), input[type=submit]:not([disabled])${down ? ", a[href], summary" : ''}')) return false;
            a.click(); return true; })()`).catch(() => false);
          if (pressed) unsupported.add('window focus (Enter/Space on a focused button pressed by the driver, as a focused Firefox does)');
        }
        return { result: {} };
      }
      case 'Emulation.setDeviceMetricsOverride':
        await bidi('browsingContext.setViewport', { context, viewport: { width: p.width, height: p.height }, devicePixelRatio: p.deviceScaleFactor || 1 });
        return { result: {} };
      case 'Emulation.setEmulatedMedia':
        // Reduced motion is the launch pref; contrast can't be emulated.
        if ((p.features || []).some((f) => f.name === 'prefers-contrast')) unsupported.add('prefers-contrast');
        return { result: {} };
      case 'Network.emulateNetworkConditions':
        if (p.offline || p.latency || (p.downloadThroughput ?? -1) >= 0) {
          if (!p.offline) { unsupported.add('network throttling'); return { result: {} }; }
        }
        try { await bidi('emulation.setNetworkConditions', { networkConditions: p.offline ? { type: 'offline' } : null, contexts: [context] }); }
        catch { unsupported.add('offline emulation'); }
        return { result: {} };
      case 'Performance.getMetrics': {
        const nodes = await evaluate('document.getElementsByTagName("*").length').catch(() => null);
        unsupported.add('JS heap size');
        return { result: { metrics: nodes == null ? [] : [{ name: 'Nodes', value: nodes }] } };
      }
      case 'Page.setWebLifecycleState':
        throw new Error('firefox: no lifecycle states');   // the bots fall back to visibilitychange
      case 'Performance.enable': case 'Page.screencastFrameAck': case 'Page.stopScreencast':
        return { result: {} };
      default: {
        const name = { 'Emulation.setEmulatedVisionDeficiency': 'colour-vision emulation', 'Emulation.setCPUThrottlingRate': 'CPU throttling', 'Accessibility.enable': 'accessibility tree', 'Accessibility.getFullAXTree': 'accessibility tree', 'Page.startScreencast': 'screencast (flashes, motion)', 'HeapProfiler.collectGarbage': 'forced GC' }[method] || method;
        unsupported.add(name);
        return { result: method === 'Accessibility.getFullAXTree' ? { nodes: [] } : {} };
      }
    }
  }
  const close = async () => {
    closing = true;
    failAll('closed');
    try { await Promise.race([bidi('browser.close', {}, 3000), sleep(3000)]); } catch { /* closing anyway */ }
    try { ws.close(); } catch { /* closing anyway */ }
    ff.kill();
    await Promise.race([exited, sleep(5000)]);
    if (ff.exitCode === null && ff.signalCode === null) { ff.kill('SIGKILL'); await Promise.race([exited, sleep(2000)]); }
    children.delete(ff);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left for the OS */ }
  };
  // Never holds OS window focus headless: :focus-visible never matches, so focus rings can't be judged here.
  unsupported.add('window focus (focus rings and :focus-visible)');
  return { engine: 'firefox', version, pid: ff.pid, send, evaluate, shot, problems, close, unsupported, on: (fn) => listeners.add(fn), get dead() { return dead; } };
}
