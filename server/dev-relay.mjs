/* Dev relay: chat's wallet sign-in for the Vite dev server only (`vite serve`; never in a build).
 *
 * On the published site the sign-in runs in the browser (src/chat/oauth.ts): the guild's form login
 * in a small window, the code back on comms-callback.html. A guild's auth service (MAS) won't take
 * http://localhost as a web app's callback, so on localhost this relay runs the chain the way the
 * desktop app does (structs-universe src-tauri/src/matrix/auth.rs): its own cookie jar, redirects
 * followed by hand, and a loopback redirect that nothing listens on, read instead of visited.
 *
 * The browser still signs: the relay gets the signed guild login (address, pubkey, signature,
 * timestamp), never a key or a phrase. It answers only this machine.
 *
 *   POST /__dev/comms/signin  { homeserver, guildApi, deviceId, login }
 *     → { access_token, refresh_token, expires_in, client_id, token_endpoint }  or  { error } */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const RELAY_PATH = '/__dev/comms/signin';
/** Registered as a native client's loopback redirect. Nothing binds it: the chain is read up to it. */
export const REDIRECT_URI = 'http://127.0.0.1:47412/structs-xyz/comms/callback';
const MAX_HOPS = 12;
const MAX_FORMS = 4;
const TIMEOUT_MS = 25_000;
const CACHE = join(process.cwd(), 'node_modules/.cache/structs-dev-relay.json');

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** Codes and request ids ride in queries: anything said about a URL loses its query first. */
const redact = (u) => { try { const x = new URL(u); x.search = ''; return x.href; } catch { return '(bad url)'; } };
const isLoopback = (host) => host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';

/** A small cookie jar: enough for a PHP session and MAS's own, across one sign-in. */
export class Jar {
  cookies = [];
  take(url, res) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
      let domain = host, hostOnly = true, path = '/', gone = false;
      for (const a of attrs) {
        const i = a.indexOf('=');
        const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase(), v = i < 0 ? '' : a.slice(i + 1).trim();
        if (k === 'domain' && v) {
          const d = v.replace(/^\./, '').toLowerCase();
          // A cookie may only name its own host or a parent of it.
          if (host !== d && !host.endsWith('.' + d)) { gone = true; break; }
          domain = d; hostOnly = false;
        } else if (k === 'path' && v.startsWith('/')) path = v;
        else if (k === 'max-age' && Number(v) <= 0) gone = true;
        else if (k === 'expires' && Date.parse(v) < Date.now()) gone = true;
      }
      this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === domain && c.path === path));
      if (!gone) this.cookies.push({ name, value, domain, hostOnly, path });
    }
  }
  header(url) {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return this.cookies
      .filter((c) => (c.hostOnly ? h === c.domain : h === c.domain || h.endsWith('.' + c.domain)) && u.pathname.startsWith(c.path))
      .map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

async function send(f, jar, url, init = {}) {
  const headers = { 'user-agent': 'StructsXYZ/dev-relay', ...(init.headers || {}) };
  const c = jar?.header(url);
  if (c) headers.cookie = c;
  const res = await f(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  jar?.take(url, res);
  return res;
}

/** Follow Locations by hand; stop at the registered redirect instead of visiting it. */
export async function follow(f, jar, start) {
  let url = start;
  for (let i = 0; i < MAX_HOPS; i++) {
    if (url.startsWith(REDIRECT_URI)) return { callback: url };
    const res = await send(f, jar, url);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`${res.status} without a Location at ${redact(url)}`);
      url = new URL(loc, url).href;
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} at ${redact(url)}`);
    return { page: { url, body: await res.text() } };
  }
  throw new Error(`the redirect chain ran past ${MAX_HOPS} hops`);
}

/** The first form in a page: its action and its inputs (MAS's consent page is an ordinary POST form). */
export function parseForm(body, base) {
  const lower = body.toLowerCase();
  const at = lower.indexOf('<form');
  if (at < 0) return null;
  const end = lower.indexOf('</form>', at);
  if (end < 0) return null;
  const form = body.slice(at, end);
  const attr = (tag, name) => {
    const m = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag);
    return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
  };
  const head = form.slice(0, form.indexOf('>') + 1);
  const action = (attr(head, 'action') || '').trim();
  const fields = [];
  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    const name = attr(m[0], 'name');
    if (name) fields.push([name, attr(m[0], 'value') ?? '']);
  }
  return { action: action ? new URL(action, base).href : base, fields };
}

/** The guild SPA's continue hook (`/?oidc=<request id>`), when the chain parks there. */
export function oidcRequestId(url, body) {
  const q = new URL(url).searchParams.get('oidc');
  if (q) return q;
  const m = /oidcContinueRequestId["']?\s*[:=]\s*["']([^"']+)["']/.exec(body || '');
  return m ? m[1] : null;
}

/** Answer the auth service's own pages (consent, first-time account) the way a click would, only on
 * the auth service's host, until the chain reaches the callback. */
async function answerForms(f, jar, issuer, page) {
  const iss = new URL(issuer).host;
  let cur = page;
  for (let i = 0; i < MAX_FORMS; i++) {
    if (new URL(cur.url).host !== iss) throw new Error(`the sign-in stopped at ${redact(cur.url)}, which is neither the callback nor the auth service`);
    const form = parseForm(cur.body, cur.url);
    if (!form) throw new Error(`${redact(cur.url)} needs a browser to continue`);
    if (new URL(form.action).host !== iss) throw new Error(`a form on the auth service posts to ${redact(form.action)}`);
    const res = await send(f, jar, form.action, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form.fields).toString() });
    const loc = res.headers.get('location');
    if (!(res.status >= 300 && res.status < 400) || !loc) throw new Error(`the auth service answered ${res.status} instead of continuing`);
    const next = await follow(f, jar, new URL(loc, form.action).href);
    if (next.callback) return next.callback;
    cur = next.page;
  }
  throw new Error(`the sign-in stopped at ${redact(cur.url)} instead of returning a code`);
}

function loadClients() { try { return JSON.parse(readFileSync(CACHE, 'utf8')).clients || {}; } catch { return {}; } }
function saveClients(clients) { try { mkdirSync(dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify({ clients }, null, 1)); } catch { /* memory only */ } }

function checkUrl(u, what) {
  let x;
  try { x = new URL(u); } catch { throw new Error(`${what} is not a URL`); }
  if (x.protocol !== 'https:' && !(x.protocol === 'http:' && isLoopback(x.hostname))) throw new Error(`${what} must be https`);
  return x.href.replace(/\/+$/, '');
}

const errorOf = (j, status, what) => j?.error_description || j?.error || (j?.errors && typeof j.errors === 'object' ? Object.values(j.errors).join('; ') : '') || `${what} ${status}`;

/** The whole chain, from a signed guild login to Matrix tokens. `f` is fetch (a test passes its own). */
export async function relaySignIn(input, { f = fetch, clients = loadClients(), save = saveClients } = {}) {
  const homeserver = checkUrl(input?.homeserver, 'homeserver');
  const guildApi = checkUrl(input?.guildApi, 'guildApi');
  const login = input?.login || {};
  for (const k of ['address', 'signature', 'pubkey', 'guild_id', 'unix_timestamp']) if (!login[k]) throw new Error(`login.${k} is missing`);
  const deviceId = /^[A-Za-z0-9]{4,32}$/.test(input?.deviceId || '') ? input.deviceId : b64url(randomBytes(8)).replace(/[-_]/g, 'X');

  // 1 ── who authenticates for this homeserver
  let meta = null, last = '';
  for (const p of ['/_matrix/client/v1/auth_metadata', '/_matrix/client/unstable/org.matrix.msc2965/auth_metadata']) {
    const r = await send(f, null, homeserver + p).catch((e) => ({ ok: false, status: e.message }));
    if (r.ok) { meta = await r.json(); break; }
    last = String(r.status);
  }
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) throw new Error(`${new URL(homeserver).host} has no wallet sign-in (${last || 'no auth metadata'})`);

  // 2 ── this relay as a native client of that auth service (once, then remembered)
  let clientId = clients[meta.issuer];
  if (!clientId) {
    if (!meta.registration_endpoint) throw new Error('the auth service takes no new apps');
    const r = await send(f, null, meta.registration_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Structs Command Deck (dev)', client_uri: 'https://structs.xyz/', application_type: 'native',
        redirect_uris: [REDIRECT_URI], response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none',
      }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.client_id) throw new Error(`client registration refused: ${errorOf(j, r.status, 'HTTP')}`);
    clientId = j.client_id;
    clients[meta.issuer] = clientId;
    save(clients);
  }

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const authorize = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, state, code_challenge: challenge, code_challenge_method: 'S256', response_mode: 'query',
    scope: `urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${deviceId}`,
  })) authorize.searchParams.set(k, v);

  // 3 ── the guild session, in this jar, from the browser's signature
  const jar = new Jar();
  const lr = await send(f, jar, guildApi + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(login) });
  const lj = await lr.json().catch(() => null);
  if (!lr.ok || lj?.success !== true) throw new Error(`guild login: ${errorOf(lj, lr.status, 'HTTP')}`);

  // 4 ── authorize: with the guild session in the jar, the chain comes back to the callback,
  //      after the auth service's own pages (consent) are answered. A guild that parks the request
  //      on its site anyway is resumed, as the desktop app does.
  let land = await follow(f, jar, authorize.href);
  if (land.page) {
    const rid = new URL(land.page.url).host !== new URL(meta.issuer).host ? oidcRequestId(land.page.url, land.page.body) : null;
    if (rid) land = await follow(f, jar, `${new URL(land.page.url).origin}/oauth/resume?request_id=${encodeURIComponent(rid)}`);
  }
  const callback = land.callback || await answerForms(f, jar, meta.issuer, land.page);
  const q = new URL(callback).searchParams;
  if (q.get('state') !== state) throw new Error('the authorization answer did not carry our state');
  if (q.get('error')) throw new Error(`${q.get('error')}${q.get('error_description') ? ': ' + q.get('error_description') : ''}`);
  const code = q.get('code');
  if (!code) throw new Error('the authorization answer carried no code');

  // 5 ── the code, redeemed
  const tr = await send(f, null, meta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }).toString(),
  });
  const tj = await tr.json().catch(() => null);
  if (!tr.ok || !tj?.access_token) throw new Error(`token refused: ${errorOf(tj, tr.status, 'HTTP')}`);
  return { access_token: tj.access_token, refresh_token: tj.refresh_token ?? null, expires_in: tj.expires_in ?? null, client_id: clientId, token_endpoint: meta.token_endpoint, device_id: deviceId };
}

/** The Vite plugin: the endpoint above, on the dev server only, for this machine only. */
export function devRelayPlugin() {
  return {
    name: 'structs-dev-relay',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(RELAY_PATH, (req, res) => {
        const reply = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)); };
        const from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        if (!isLoopback(from)) return reply(403, { error: 'the dev relay answers this machine only' });
        if (req.method !== 'POST') return reply(405, { error: 'POST only' });
        let raw = '';
        req.on('data', (c) => { raw += c; if (raw.length > 16_384) req.destroy(); });
        req.on('end', () => {
          let input;
          try { input = JSON.parse(raw); } catch { return reply(400, { error: 'not JSON' }); }
          relaySignIn(input).then((out) => reply(200, out), (e) => {
            console.warn('[dev-relay] chat sign-in:', e.message);
            reply(502, { error: e.message });
          });
        });
      });
    },
  };
}
