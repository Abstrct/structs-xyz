/* The page reads each guild.json and calls the Guild API itself. Checked against a mocked network
 * (nothing leaves this process):
 *   - guild.json is read straight from the guild, checked before use (https only, must name the
 *     same guild as the chain, links scrubbed), and a CORS refusal is marked as such;
 *   - Guild API calls go to the API that guild.json names, without cookies;
 *   - a members-only route (401) is 'blocked', and nothing is signed;
 *   - a guild that won't answer this site comes back as a plain 'blocked' error. */
export {};

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: () => null, length: 0 }; };
(globalThis as Record<string, unknown>).localStorage = mem();
(globalThis as Record<string, unknown>).sessionStorage = mem();

const { guilds, okUrl, NOT_SHARED } = await import('../src/guild/directory');
const { canReach } = await import('../src/guild/transport');
const { GuildApi, GuildApiError } = await import('../src/guild/api');
const { guildApi } = await import('../src/chat/guilds');
const { guildCall } = await import('../src/game/onboard');
const { store } = await import('../src/chain/store');
const { wallet } = await import('../src/wallet/wallet');

let fails = 0;
const ok = (cond: unknown, msg: string) => { if (!cond) { fails++; console.error('FAIL', msg); } else console.log('ok  ', msg); };

/* ── Hosts a guild.json may name ────────────────────────────────────────── */
for (const u of ['https://localhost./x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://10.0.0.1/x', 'https://router.local/x', 'https://127.0.0.1.nip.io/x', 'https://a.sslip.io/x', 'http://guild.example/x', 'https://user:pw@guild.example/x', 'javascript:alert(1)'])
  ok(!okUrl(u), `refused: ${u}`);
ok(okUrl('https://guild.example/guild.json') && okUrl('wss://guild.example:1443', ['wss:']), 'a public https host is fine');

const guild = (id: string, endpoint: string) => ({ id, index: id.split('-')[1], endpoint, creator: '', owner: '', joinInfusionMinimum: '0', primaryReactorId: '', entrySubstationId: '', entryRank: '', name: '', pfp: '' });
for (const g of [
  guild('0-5', 'https://guild.example/guild.json'),
  guild('0-1', 'https://nocors.example/guild.json'),
  guild('0-2', 'https://liar.example/guild.json'),
  guild('0-3', 'http://plain.example/guild.json'),
  guild('0-4', 'https://badapi.example/guild.json'),
  guild('0-6', 'http://localhost:8080/guild.json'),
  guild('0-7', 'https://offline.example/guild.json'),
  guild('0-8', 'https://huge.example/guild.json'),
  guild('0-9', 'https://apidown.example/guild.json'),
]) store.guilds.set(g.id, g);

const calls: { url: string; method: string; credentials?: RequestCredentials; mode?: RequestMode; redirect?: RequestRedirect; session: string | null; type: string | null; body?: string }[] = [];
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const hd = new Headers(init?.headers);
  calls.push({ url, method: init?.method || 'GET', credentials: init?.credentials, mode: init?.mode, redirect: init?.redirect, session: hd.get('x-relay-session'), type: hd.get('content-type'), body: init?.body as string | undefined });
  // Down hosts answer nothing, whatever the mode; a no-cors probe of a live host gets an (opaque) reply.
  if (/^https:\/\/(offline|api\.apidown)\.example\//.test(url)) throw new TypeError('Failed to fetch');
  // As browsers do: a no-cors request that doesn't follow redirects is refused outright.
  if (init?.mode === 'no-cors' && init.redirect && init.redirect !== 'follow') throw new TypeError('no-cors requires redirect: follow');
  if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
  if (url === 'https://huge.example/guild.json') return new Response(JSON.stringify({ guild: { id: '0-8', name: 'x'.repeat(100_000) } }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === 'https://apidown.example/guild.json') return reply(200, { guild: { id: '0-9', name: 'API Down', services: { guild_api: 'https://api.apidown.example/api' } } });
  if (url === 'https://guild.example/guild.json') return reply(200, { guild: { id: '0-5', name: 'Good Guild', tag: 'GOOD', logo: 'javascript:alert(1)', website: 'https://guild.example', services: { guild_api: 'https://api.guild.example/api/', matrix: 'https://matrix.guild.example/', grass_nats_websocket: 'wss://guild.example:1443', explorer: 'ftp://x.example' } } });
  if (url === 'https://nocors.example/guild.json') throw new TypeError('Failed to fetch');
  if (url === 'https://liar.example/guild.json') return reply(200, { guild: { id: '0-9', name: 'Not who the chain says', services: { guild_api: 'https://api.liar.example/api' } } });
  if (url === 'https://badapi.example/guild.json') return reply(200, { guild: { id: '0-4', name: 'Bad API', services: { guild_api: 'http://api.badapi.example/api', matrix: 'https://10.0.0.1' } } });
  if (url.startsWith('https://api.guild.example/api/')) {
    const path = url.slice('https://api.guild.example/api/'.length);
    if (path === 'timestamp') return reply(200, { success: true, errors: [], data: { unix_timestamp: 1791517557 } });
    if (path === 'auth/login') return reply(200, { success: true, errors: [], data: null });
    if (path === 'auth/signup') return reply(202, { success: true, errors: [], data: null });
    if (path === 'player/count') return reply(401, { success: false, errors: { authentication_error: 'Login required' }, data: null });
    if (path === 'down') throw new TypeError('Failed to fetch');
  }
  return reply(404, { success: false, errors: { nope: 'unmocked ' + url }, data: null });
}) as typeof fetch;

/* ── The directory, read by the page ────────────────────────────────────── */
const list = await guilds();
const by = (id: string) => list.find((g) => g.id === id);
const good = by('0-5');
ok(good?.meta?.name === 'Good Guild' && good.meta.tag === 'GOOD', 'a guild that shares guild.json is named from it');
ok(good?.services?.guild_api === 'https://api.guild.example/api' && good.services.matrix === 'https://matrix.guild.example' && good.services.grass === 'wss://guild.example:1443', 'its services are read (trailing slashes trimmed)');
ok(good?.meta?.logo === '' && good.services?.explorer === null, 'a javascript: logo and a non-https explorer are dropped');
ok(by('0-1')?.error === NOT_SHARED && !by('0-1')?.services, 'a guild.json without CORS is marked as not shared');
const refused = JSON.parse(localStorage.getItem('structs.guildjson.refused') || '{}') as Record<string, number>;
ok(Object.keys(refused).join() === 'https://nocors.example/guild.json', 'the refusal is remembered (asked again in an hour, not on every refresh)');
ok(by('0-2')?.error === 'guild.json names another guild' && !by('0-2')?.meta, 'a guild.json naming another guild is refused');
ok(by('0-3')?.error === 'no endpoint' && !calls.some((c) => c.url.startsWith('http://plain.example')), 'a plain-http endpoint is never fetched');
ok(by('0-6')?.error === 'no endpoint' && !calls.some((c) => c.url.includes('localhost')), 'a loopback endpoint is refused while the page isn’t on loopback');
ok(by('0-4')?.services?.guild_api === null && by('0-4')?.services?.matrix === null, 'a plain-http API and an IP-literal homeserver are refused');
ok(by('0-7')?.error === 'guild.json unreachable' && !Object.keys(JSON.parse(localStorage.getItem('structs.guildjson.refused') || '{}')).includes('https://offline.example/guild.json'), 'an unreachable host is not mistaken for a refusal (nothing remembered)');
ok(by('0-8')?.error === 'guild.json unreadable' && !by('0-8')?.meta, 'a guild.json over 64 KB is not read');
ok(calls.filter((c) => c.mode !== 'no-cors').every((c) => c.credentials === 'omit' && c.redirect === 'error'), 'guild.json is read without credentials, refusing redirects');

/* ── The Guild API, called directly ─────────────────────────────────────── */
calls.length = 0;
const api = new GuildApi('0-5');
const ts = await api.timestamp();
ok(ts.unix_timestamp === 1791517557, 'a public route answers');
ok(calls.length === 1 && calls[0].url === 'https://api.guild.example/api/timestamp' && calls[0].credentials === 'omit' && calls[0].mode === 'cors' && calls[0].redirect === 'error', 'it goes straight to the guild’s API, without cookies, refusing redirects');

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
await wallet.create(PHRASE, 'correct horse battery');
wallet.setAccount(0, { playerId: '1-77' });
store.players.set('1-77', { id: '1-77', guildId: '0-5' } as never);
// Members-only: the guild's session is a cookie this site can't use, so a 401 is final and plain.
calls.length = 0;
const why = await api.playerCount().then(() => null, (e) => e);
ok(why instanceof GuildApiError && why.code === 'blocked' && /cookie/.test(why.errors.detail || ''), 'a members-only route is blocked, the reason kept for experts: ' + String(why?.message));
ok(calls.length === 1 && !calls.some((c) => c.url.endsWith('/auth/login')), 'nothing is signed and no sign-in is attempted');
ok(calls.every((c) => c.url.startsWith('https://api.guild.example/api/') && c.session === null && c.credentials === 'omit'), 'every call goes to the guild itself, without cookies or a session header of ours');

/* ── Guilds that won't answer this site ─────────────────────────────────── */
calls.length = 0;
const blocked = await new GuildApi('0-1').timestamp().then(() => null, (e) => e);
ok(blocked instanceof GuildApiError && blocked.code === 'blocked' && /CORS/.test(blocked.errors.detail || '') && !/CORS/.test(blocked.message), 'a guild whose guild.json has no CORS: blocked, in plain words, the reason kept for experts');
ok(calls.length === 0, 'and nothing is sent to a guessed API address');
const liar = await new GuildApi('0-2').timestamp().then(() => null, (e) => e);
ok(liar instanceof GuildApiError && liar.code === 'blocked', 'a guild whose guild.json lied: blocked');
const down = await api.get('down').then(() => null, (e) => e);
ok(down instanceof GuildApiError && down.code === 'blocked', 'an API that gives no CORS answer: blocked');
const gone = await new GuildApi('0-9').timestamp().then(() => null, (e) => e);
ok(gone instanceof GuildApiError && gone.code === 'network' && /connection/.test(gone.message), 'an API that answers nothing at all: a network error, not a refusal: ' + String(gone?.message));
ok(await canReach('0-5') && !(await canReach('0-1')) && await canReach('0-9'), 'enlisting offers guilds that answer, drops one that refuses, and doesn’t drop one that is merely down');

/* ── Chat's and enlisting's Guild API calls ─────────────────────────────── */
calls.length = 0;
const c = await guildApi<{ unix_timestamp: number }>('0-5', 'timestamp');
ok(c.status === 200 && c.body?.data?.unix_timestamp === 1791517557 && calls[0]?.url === 'https://api.guild.example/api/timestamp', 'chat’s guild calls go direct');
calls.length = 0;
const s = await guildCall('0-5', 'auth/signup', { method: 'POST', body: JSON.stringify({ username: 'Nova' }) });
ok(s.status === 202 && calls[0]?.url === 'https://api.guild.example/api/auth/signup' && calls[0].type === 'application/json', 'enlisting’s signup goes direct');

if (fails) { console.error(`direct: ${fails} failure(s)`); process.exit(1); }
console.log('direct: all checks passed');
