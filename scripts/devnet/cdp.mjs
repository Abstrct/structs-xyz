// A long-lived headless Chrome for driving the client step by step over CDP.
//
//   node scripts/devnet/cdp.mjs [port=9555]          # starts Chrome + a tiny control server
//   curl -s localhost:9555/nav -d 'http://127.0.0.1:5186/command'
//   curl -s localhost:9555/eval -d 'window.__structs.wallet.state'      # awaits promises, returns JSON
//   curl -s localhost:9555/shot -d /path/out.png
//   curl -s localhost:9555/logs                                          # console errors/warnings since last call
//   curl -s localhost:9555/cdp -d '{"method":"Network.setBlockedURLs","params":{"urls":["*/cosmos/tx/v1beta1/txs"]}}'
//   curl -s localhost:9555/reload ;  curl -s localhost:9555/quit
//
// The profile dir persists across /reload (localStorage = the vault and the tx queue), which is
// what the reload-mid-flight check needs. Reduced motion keeps the three.js scenes cheap.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 9555);
const W = Number(process.env.W || 1440), H = Number(process.env.H || 900);
const dir = process.env.PROFILE || mkdtempSync(join(tmpdir(), 'structs-devnet-chrome-'));
const dbg = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${dir}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--enable-unsafe-webgpu', '--no-first-run', '--hide-scrollbars', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 50; i++) { try { list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json(); if (list.length) break; } catch { /* starting */ } await sleep(200); }
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); let logs = [];
const stamp = () => new Date().toISOString().slice(11, 23);
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(`${stamp()} ${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push(`${stamp()} EXC: ` + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Network.webSocketCreated') logs.push(`${stamp()} WS ${m.params.url}`);
  if (m.method === 'Network.loadingFailed' && !m.params.canceled) logs.push(`${stamp()} NETFAIL: ${m.params.errorText} ${reqs.get(m.params.requestId) || ''}`);
  if (m.method === 'Network.requestWillBeSent') { reqs.set(m.params.requestId, m.params.request.method + ' ' + m.params.request.url); if (/127\.0\.0\.1:3|localhost:3|public\.testnet|structs\.network/.test(m.params.request.url) && m.params.request.method === 'POST') logs.push(`${stamp()} POST ${m.params.request.url}`); if (/public\.testnet|structs\.network|playstructs/.test(m.params.request.url)) logs.push(`${stamp()} EXTERNAL ${m.params.request.method} ${m.params.request.url}`); }
});
const reqs = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 500 });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await send('Page.enable');

const body = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); });
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const b = await body(req);
  let out;
  try {
    if (path === '/nav') { await send('Page.navigate', { url: b }); out = { ok: true }; }
    else if (path === '/reload') { await send('Page.reload', { ignoreCache: false }); out = { ok: true }; }
    else if (path === '/eval') {
      const r = await send('Runtime.evaluate', { expression: b, awaitPromise: true, returnByValue: true, timeout: 600000 });
      out = r.result?.exceptionDetails ? { error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text } : r.result?.result?.value ?? r.result?.result;
    }
    else if (path === '/shot') { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(b, Buffer.from(s.result.data, 'base64')); out = { ok: b }; }
    else if (path === '/cdp') { const { method, params } = JSON.parse(b); out = (await send(method, params)).result; }   // raw CDP, e.g. Network.setBlockedURLs
    else if (path === '/logs') { out = logs; logs = []; }
    else if (path === '/quit') { res.end('{"bye":true}'); ws.close(); chrome.kill('SIGKILL'); process.exit(0); }
    else out = { error: 'unknown ' + path };
  } catch (e) { out = { error: String(e) }; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(out, null, 1));
}).listen(PORT, '127.0.0.1', () => console.log(`cdp driver on http://127.0.0.1:${PORT} (chrome profile ${dir})`));
process.on('SIGTERM', () => { chrome.kill('SIGKILL'); process.exit(0); });
