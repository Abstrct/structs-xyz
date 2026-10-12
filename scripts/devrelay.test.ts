/* The dev relay's chat sign-in chain (server/dev-relay.mjs), end to end against fake servers: a
 * homeserver, its auth service (MAS) and a guild webapp. No network: the relay takes a fetch. */
import { createHash } from 'node:crypto';
import { Jar, REDIRECT_URI, oidcRequestId, parseForm, relaySignIn } from '../server/dev-relay.mjs';

let failures = 0;
const check = (c: unknown, m: string) => { if (!c) { failures++; console.error('FAIL', m); } };

const HS = 'https://matrix.g.test', MAS = 'https://auth.g.test', GUILD = 'https://g.test';
const login = { address: 'structs1abc', signature: 'aa', pubkey: 'bb', guild_id: '0-5', unix_timestamp: 1700000000 };

/** The fake world. `consentPages` MAS pages to click through; `park` makes the guild park the
 * request at its SPA (?oidc=) even with a session, so the relay must resume it. */
function world(o: { consentPages?: number; park?: boolean; loginOk?: boolean; formHost?: string } = {}) {
  const seen: { url: string; method: string; cookie: string | null }[] = [];
  let pending: { state: string; challenge: string; redirect: string } | null = null;
  let consents = o.consentPages ?? 1;
  let parked = !!o.park;
  const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });
  const go = (loc: string, headers: [string, string][] = []) => new Response(null, { status: 302, headers: [['location', loc], ...headers] });
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const cookie = (init.headers as Record<string, string> | undefined)?.cookie ?? null;
    seen.push({ url: url.href, method, cookie });
    const hasSession = !!cookie && /PHPSESSID=s3cret/.test(cookie);
    if (url.href === HS + '/_matrix/client/v1/auth_metadata')
      return json({ issuer: MAS + '/', authorization_endpoint: MAS + '/authorize', token_endpoint: MAS + '/oauth2/token', registration_endpoint: MAS + '/oauth2/registration' });
    if (url.href === MAS + '/oauth2/registration') {
      const b = JSON.parse(String(init.body));
      check(b.application_type === 'native' && b.redirect_uris[0] === REDIRECT_URI && b.token_endpoint_auth_method === 'none', 'registered as a native public client with the loopback redirect');
      return json({ client_id: 'CLIENT1' }, 201);
    }
    if (url.href === GUILD + '/api/auth/login') {
      const b = JSON.parse(String(init.body));
      check(b.signature === 'aa' && b.guild_id === '0-5' && b.unix_timestamp === 1700000000, 'the browser’s signed login reaches the guild untouched');
      if (o.loginOk === false) return json({ success: false, errors: { signature_validation_failed: 'Invalid signature' } }, 401);
      return json({ success: true }, 200, { 'set-cookie': 'PHPSESSID=s3cret; path=/; secure; HttpOnly; SameSite=Lax' });
    }
    if (url.origin + url.pathname === MAS + '/authorize') {
      const q = url.searchParams;
      check(q.get('client_id') === 'CLIENT1' && q.get('code_challenge_method') === 'S256' && /device:DEV42$/.test(q.get('scope') || ''), 'authorize carries the client, PKCE and the device');
      pending = { state: q.get('state')!, challenge: q.get('code_challenge')!, redirect: q.get('redirect_uri')! };
      return go(GUILD + '/oauth/authorize?req=R1');
    }
    if (url.origin + url.pathname === GUILD + '/oauth/authorize') {
      if (!hasSession || parked) return go(GUILD + '/?oidc=R1');
      return go(MAS + '/upstream/callback');
    }
    if (url.href === GUILD + '/?oidc=R1') return new Response('<html><script>var oidcContinueRequestId="R1"</script></html>', { status: 200 });
    if (url.origin + url.pathname === GUILD + '/oauth/resume') {
      check(url.searchParams.get('request_id') === 'R1' && hasSession, 'a parked request is resumed with the guild session');
      parked = false;
      return go(MAS + '/upstream/callback');
    }
    if (url.href === MAS + '/upstream/callback' || url.href === MAS + '/consent/next') {
      if (consents > 0) {
        const action = o.formHost ? `https://${o.formHost}/consent` : '/consent';
        return new Response(`<html><form method="post" action="${action}"><input type="hidden" name="csrf" value="tok&amp;1"><button>Continue</button></form></html>`, { status: 200, headers: { 'set-cookie': 'mas=1; Path=/' } });
      }
      return go(`${pending!.redirect}?code=CODE9&state=${pending!.state}`);
    }
    if (url.href === MAS + '/consent' && method === 'POST') {
      check(String(init.body) === 'csrf=tok%261' && /mas=1/.test(cookie || ''), 'the consent form is posted back with its field and the auth service’s cookie');
      consents--;
      return go('/consent/next');
    }
    if (url.href === MAS + '/oauth2/token') {
      const b = new URLSearchParams(String(init.body));
      const ok = b.get('code') === 'CODE9' && b.get('client_id') === 'CLIENT1' && b.get('redirect_uri') === REDIRECT_URI
        && createHash('sha256').update(b.get('code_verifier')!).digest('base64url') === pending!.challenge;
      return ok ? json({ access_token: 'mat_A', refresh_token: 'mar_R', expires_in: 300 }) : json({ error: 'invalid_grant' }, 400);
    }
    return new Response('not here: ' + url.href, { status: 404 });
  }) as typeof fetch;
  return { f, seen };
}

const input = { homeserver: HS, guildApi: GUILD + '/api', deviceId: 'DEV42', login };

{
  // The whole chain: metadata, registration (remembered), guild login in the jar, authorize, one
  // consent page, the code at the loopback (never visited), PKCE checked at the token endpoint.
  const w = world();
  const saved: Record<string, string>[] = [];
  const out = await relaySignIn(input, { f: w.f, clients: {}, save: (c) => saved.push({ ...c }) });
  check(out.access_token === 'mat_A' && out.refresh_token === 'mar_R' && out.client_id === 'CLIENT1' && out.token_endpoint === MAS + '/oauth2/token' && out.device_id === 'DEV42', 'the chain ends in Matrix tokens');
  check(saved.length === 1 && saved[0][MAS + '/'] === 'CLIENT1', 'the client id is remembered per auth service');
  check(!w.seen.some((s) => s.url.startsWith(REDIRECT_URI)), 'the loopback redirect is read, never visited');
  const toGuild = w.seen.find((s) => s.url.startsWith(GUILD + '/oauth/authorize'));
  check(!!toGuild && /PHPSESSID=s3cret/.test(toGuild.cookie || ''), 'the guild session cookie rides along to its OAuth step');
  check(!w.seen.some((s) => s.url.startsWith(MAS) && /PHPSESSID/.test(s.cookie || '')), 'the guild’s cookie never goes to the auth service');
}

{
  // A known client is not registered again; a guild that parks the request anyway is resumed.
  const w = world({ park: true, consentPages: 0 });
  const out = await relaySignIn(input, { f: w.f, clients: { [MAS + '/']: 'CLIENT1' }, save: () => { throw new Error('should not save'); } });
  check(out.access_token === 'mat_A', 'a parked request still signs in (resume)');
  check(!w.seen.some((s) => s.url.endsWith('/oauth2/registration')), 'a remembered client skips registration');
}

{
  // Refusals say why.
  const w = world({ loginOk: false });
  let err = '';
  try { await relaySignIn(input, { f: w.f, clients: {}, save: () => {} }); } catch (e) { err = (e as Error).message; }
  check(/guild login: Invalid signature/.test(err), 'a refused guild login says why: ' + err);

  const w2 = world({ formHost: 'evil.test' });
  err = '';
  try { await relaySignIn(input, { f: w2.f, clients: {}, save: () => {} }); } catch (e) { err = (e as Error).message; }
  check(/posts to https:\/\/evil\.test/.test(err) && !w2.seen.some((s) => s.url.includes('evil.test')), 'a form that posts off the auth service is refused, unvisited');

  err = '';
  try { await relaySignIn({ ...input, homeserver: 'http://matrix.g.test' }, { f: world().f, clients: {}, save: () => {} }); } catch (e) { err = (e as Error).message; }
  check(/must be https/.test(err), 'plain http is refused (except loopback)');
}

{
  // The small parts.
  const jar = new Jar();
  jar.take('https://a.g.test/x', new Response(null, { headers: [['set-cookie', 'k=1; Domain=g.test; Path=/'], ['set-cookie', 'evil=1; Domain=other.test'], ['set-cookie', 'old=1; Max-Age=0']] }));
  check(jar.header('https://b.g.test/y') === 'k=1' && jar.header('https://other.test/') === '', 'cookies follow their domain, and a foreign Domain is dropped');
  const form = parseForm('<FORM method="post" action="/c?x=1&amp;y=2"><input name="a" value="1"><input type="hidden" name="b"></form>', 'https://auth.g.test/page');
  check(form?.action === 'https://auth.g.test/c?x=1&y=2' && JSON.stringify(form?.fields) === '[["a","1"],["b",""]]', 'a form’s action and fields are read');
  check(oidcRequestId('https://g.test/?oidc=abc', '') === 'abc' && oidcRequestId('https://g.test/', 'oidcContinueRequestId = "zz"') === 'zz', 'the guild SPA’s continue id is found');
}

if (failures) { console.error(`devrelay: ${failures} failure(s)`); process.exit(1); }
console.log('devrelay: ok');
