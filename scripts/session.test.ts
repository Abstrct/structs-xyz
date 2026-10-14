/* The guild session and the reads it opens, against a mocked guild with a browser-like cookie jar
 * (nothing leaves this process):
 *   1. an existing cookie opens the session without signing; none → the wallet signs the guild's
 *      login, the cookie must come back, and only that guild gets cookies;
 *   2. a guild that answers `*` (no credentials) is refused, not retried; a dropped cookie is reported;
 *   3. a 401 later signs in again; two failed sign-ins in a row and it stops for the visit;
 *   4. struct reads: one guild read per owner (Guild rows → the LCD's StructFull, flags and clocks
 *      included), anything missing from the LCD, and the LCD when the guild hasn't indexed the block;
 *   5. bulk grids fill zeros the guild doesn't store;
 *   6. GRASS patches the empire in place only when the value follows from the one held. */
export {};

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: () => null, length: 0 }; };
(globalThis as Record<string, unknown>).localStorage = mem();
(globalThis as Record<string, unknown>).sessionStorage = mem();
// The galaxy snapshot (scripts/galaxy.test.ts) stays off here, as on a small device: this suite
// checks the guild path it falls back to.
Object.defineProperty(globalThis.navigator, 'deviceMemory', { value: 2, configurable: true });

const { guilds } = await import('../src/guild/directory');
const { session } = await import('../src/guild/session');
const { guildApi } = await import('../src/guild/api');
const { structsByIds, structFromRow, gridsFor } = await import('../src/chain/reader');
const { store } = await import('../src/chain/store');
const { live } = await import('../src/chain/live');
const { wallet } = await import('../src/wallet/wallet');
const { empire } = await import('../src/game/empire');
const { parseGrass } = await import('../src/grass/grass');

/** The session's state, read fresh (TypeScript narrows a field across awaits it can't see). */
const state = (): string => session.status.state;
let fails = 0;
const ok = (cond: unknown, msg: string) => { if (!cond) { fails++; console.error('FAIL', msg); } else console.log('ok  ', msg); };

/* ── A guild with a cookie jar ──────────────────────────────────────────── */
type Mode = 'ok' | 'star' | 'drop';
const host = { mode: 'ok' as Mode, valid: new Set<string>(), height: 100, logins: [] as Record<string, unknown>[], blockStatus: 200, workFails: false };
let jar: string | null = null;     // the browser's cookie for api.guild.example
let sid = 0;
const calls: { url: string; credentials?: RequestCredentials; method: string }[] = [];
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const env = (data: unknown) => reply(200, { success: true, errors: [], data });
const unauth = () => reply(401, { success: false, errors: { authentication_error: 'Login required' }, data: null });

const STRUCT_ROWS = [
  { id: '5-1', index: 1, type: 14, creator: 'c', owner: '1-77', location_type: 'planet', location_id: '2-7', operating_ambit: 'land', slot: 0, is_destroyed: false, destroyed_block: null, created_at: '', updated_at: '', health: 3, status: 7, protected_struct_id: null, defending_struct_ids: '["5-2"]', fuel: 0 },
  { id: '5-2', index: 2, type: 3, creator: 'c', owner: '1-77', location_type: 'fleet', location_id: '9-77', operating_ambit: 'space', slot: 1, is_destroyed: false, destroyed_block: null, created_at: '', updated_at: '', health: 2, status: 1, protected_struct_id: '5-1', defending_struct_ids: [], fuel: 0 },
];
const WORK = [{ object_id: '5-2', player_id: '1-77', target_id: '5-2', category: 'BUILD', block_start: 95, difficulty_target: 700 }, { object_id: '5-1', player_id: '1-77', target_id: '5-1', category: 'MINE', block_start: 90, difficulty_target: 14000 }];
const LCD_STRUCT = (id: string) => ({ Struct: { id, index: id.split('-')[1], type: '1', creator: 'c', owner: '1-77', locationType: 'planet', locationId: '2-7', operatingAmbit: 'water', slot: '2' }, structAttributes: { health: '1', status: '7', isBuilt: true, isOnline: true }, structDefenders: [] });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const cred = init?.credentials;
  calls.push({ url, credentials: cred, method: init?.method || 'GET' });
  if (url === 'https://guild.example/guild.json') return reply(200, { guild: { id: '0-5', name: 'Good Guild', tag: 'GOOD', services: { guild_api: 'https://api.guild.example/api/' } } });
  if (url.startsWith('https://public.testnet.structs.network/structs/struct/')) return reply(200, LCD_STRUCT(url.split('/').pop()!));
  if (url.startsWith('https://api.guild.example/api/')) {
    // Like a browser: a credentialed request to a guild that answers `*` is refused outright.
    if (cred === 'include' && host.mode === 'star') throw new TypeError('Failed to fetch');
    if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
    const cookie = cred === 'include' ? jar : null;
    const authed = !!cookie && host.valid.has(cookie);
    const path = url.slice('https://api.guild.example/api/'.length).split('?')[0];
    if (path === 'timestamp') return env({ unix_timestamp: 1791517557 });
    if (path === 'auth/login') {
      host.logins.push(JSON.parse(String(init?.body || '{}')));
      const id = 'sid' + ++sid;
      host.valid.add(id);
      if (cred === 'include' && host.mode !== 'drop') jar = id;     // Set-Cookie kept only when credentialed
      return env(null);
    }
    if (path === 'auth/logout') { if (cookie) host.valid.delete(cookie); return env(null); }
    if (!authed) return unauth();
    if (path === 'block') return host.blockStatus === 200 ? env({ height: host.height, tip_height: host.height, lag_blocks: 0, status: 'current' }) : reply(host.blockStatus, { success: false, errors: { server: 'busy' }, data: null });
    if (path === 'struct/player/1-77') return env(STRUCT_ROWS);
    if (path === 'work/player/1-77') return host.workFails ? reply(500, { success: false, errors: { server: 'boom' }, data: null }) : env(WORK);
    // The chain's guard links: 5-2 guards 5-1 (together); 5-3 guards 5-1 from a fleet that sailed off.
    if (path === 'struct-defender/all/page/2') return env([]);
    if (path === 'struct-defender/all/page/1') return env([{ defending_struct_id: '5-2', protected_struct_id: '5-1' }, { defending_struct_id: '5-3', protected_struct_id: '5-1' }]);
    const g = /^grid\/attribute-type\/(\w+)\/object-type\/(\w+)\/page\/(\d+)$/.exec(path);
    if (g) return env(g[3] !== '1' ? [] : g[1] === 'capacity' ? [{ object_id: '4-1', val: '5000' }] : g[1] === 'load' ? [{ object_id: '4-2', val: '12.000' }] : []);
  }
  return reply(404, { success: false, errors: { nope: 'unmocked ' + url }, data: null });
}) as typeof fetch;

store.guilds.set('0-5', { id: '0-5', index: '5', endpoint: 'https://guild.example/guild.json', creator: '', owner: '', joinInfusionMinimum: '0', primaryReactorId: '', entrySubstationId: '', entryRank: '', name: '', pfp: '' });
await guilds();
await wallet.create('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'correct horse battery');
wallet.setAccount(0, { playerId: '1-77' });
store.players.set('1-77', { id: '1-77', guildId: '0-5' } as never);
store.coreLoaded = true;
// What session.start() needs from a page: it listens for 'online' (and a 401 hook it registers).
(globalThis as Record<string, unknown>).window = { addEventListener: () => {} };
session.start();

/* ── 1. Sign in, and only that guild gets cookies ───────────────────────── */
calls.length = 0;
await session.kick();
ok(session.status.state === 'open' && session.status.guildId === '0-5', 'no cookie yet: the wallet signs in and the session opens: ' + JSON.stringify(session.status));
const login = host.logins[0] as { address?: string; guild_id?: string; unix_timestamp?: number; signature?: string; pubkey?: string };
ok(host.logins.length === 1 && login.guild_id === '0-5' && login.address === wallet.primary?.address && login.unix_timestamp === 1791517557 && !!login.signature && !!login.pubkey, 'the login is the guild’s own, signed by the commander, on the guild’s clock');
ok(calls.filter((c) => c.url.startsWith('https://api.guild.example/')).every((c) => c.credentials === 'include'), 'the checks and the sign-in carry cookies');
calls.length = 0;
await guildApi('0-5').timestamp();
ok(calls[0]?.credentials === 'include', 'and once it is open, every call to that guild does');
ok(session.status.height === 100, 'the probe learns how far the guild has indexed');
const before = host.logins.length;
session.status.state = 'off';      // a new tab: same browser, same cookie jar
await session.kick();
ok(state() === 'open' && host.logins.length === before, 'a cookie the browser already holds opens the session without signing');

/* ── 4. Struct reads ───────────────────────────────────────────────────── */
const sf = structFromRow(STRUCT_ROWS[1] as never, WORK as never);
ok(sf.Struct.operatingAmbit === 'space' && sf.Struct.slot === '1' && sf.Struct.type === '3', 'a guild row keeps the LCD’s struct fields (strings, as the LCD sends them)');
ok(sf.structAttributes?.isMaterialized && !sf.structAttributes.isBuilt && sf.structAttributes.blockStartBuild === '95' && sf.structAttributes.protectedStructIndex === '1', 'status bits become the LCD’s flags; the build clock comes from the guild’s work list; protecting 5-1 is index 1');
ok(JSON.stringify(structFromRow(STRUCT_ROWS[0] as never, WORK as never).structDefenders) === '["5-2"]' && (structFromRow(STRUCT_ROWS[0] as never, WORK as never).structAttributes as Record<string, unknown>).blockStartOreMine === '90', 'defenders arrive as jsonb text, the mining clock from work');
live.height = 100;
calls.length = 0;
const got = await structsByIds(['5-1', '5-2', '5-9'], ['1-77'], undefined, { fresh: true });
ok(got.size === 3 && got.get('5-1')?.structAttributes?.health === '3' && got.get('5-9')?.Struct.operatingAmbit === 'water', 'two structs from the guild, the one it hasn’t got from the LCD');
ok(calls.filter((c) => c.url.includes('/structs/struct/')).length === 1 && calls.filter((c) => c.url.includes('api.guild.example')).length === 4, 'one guild read each for the structs and the clocks, the guard links in two pages (the second confirms the end); one LCD read for the straggler');
ok(JSON.stringify(got.get('5-1')?.structDefenders) === '["5-2","5-3"]' && got.get('5-2')?.structAttributes?.protectedStructIndex === '1', 'guard links are the chain’s, even for a guard whose fleet sailed off');
host.workFails = true;
calls.length = 0;
const noClocks = await structsByIds(['5-2'], ['1-77'], undefined, { fresh: true });
ok(noClocks.get('5-2')?.Struct.operatingAmbit === 'water' && calls.some((c) => c.url.includes('/structs/struct/5-2')), 'a failed clock read sends the lot to the LCD (never structs without their build clocks)');
host.workFails = false;
live.height = 150;    // the chain is ahead of what the guild has indexed
calls.length = 0;
const t0 = Date.now();
const lagged = await structsByIds(['5-1'], ['1-77'], undefined, { fresh: true });
const probes = calls.filter((c) => c.url.endsWith('/api/block')).length;
ok(lagged.get('5-1')?.Struct.operatingAmbit === 'water' && Date.now() - t0 >= 2500 && probes >= 1 && probes <= 4, `a guild behind the chain is asked how far it got (${probes}×, at most once a second), then the LCD answers`);
calls.length = 0;
const t1 = Date.now();
await structsByIds(['5-1'], ['1-77'], undefined, { fresh: true });
ok(Date.now() - t1 < 500 && !calls.some((c) => c.url.includes('api.guild.example')), 'and for a while after, reads go straight to the LCD without waiting');
live.height = 100;

/* ── 5. Bulk grids ─────────────────────────────────────────────────────── */
const grids = await gridsFor('substation', ['4-1', '4-2', '4-3'], ['capacity', 'load']);
ok(grids?.get('4-1')?.capacity === '5000' && grids?.get('4-1')?.load === '0' && grids?.get('4-2')?.load === '12' && grids?.get('4-3')?.capacity === '0', 'every listed object gets every field; the guild’s missing rows are zeros');

/* ── 3. Expiry: signs in again, twice at most ──────────────────────────── */
host.blockStatus = 503;
(session as unknown as { probedAt: number }).probedAt = 0;
await session.probeHeight();
ok(state() === 'open', 'a busy guild (503 on a probe) doesn’t end an open session');
host.blockStatus = 200;
host.valid.clear();
const nk = host.logins.length;
(session as unknown as { probedAt: number }).probedAt = 0;
await session.probeHeight();
await new Promise((r) => setTimeout(r, 0));
await session.kick();
ok(state() === 'open' && host.logins.length === nk + 1, 'a session that ends on a probe (keep-alive) signs in again by itself');
host.valid.clear();
const n0 = host.logins.length;
await guildApi('0-5').block().catch(() => null);
await new Promise((r) => setTimeout(r, 0));
ok(state() !== 'open' || host.logins.length > n0, 'a 401 on the session’s guild ends the session');
await session.kick();
ok(state() === 'open' && host.logins.length === n0 + 1, 'and it signs in again');
host.mode = 'drop';
host.valid.clear();
session.status.state = 'off';
await session.kick();
ok(state() === 'failed' && /cookie/.test(session.status.why), 'a browser that drops the cookie is told so: ' + session.status.why);
const n1 = host.logins.length;
for (let i = 0; i < 3; i++) await session.kick();
ok(host.logins.length === n1 + 1, 'it tries once more, then stops signing for this visit');

/* ── 2. A guild that answers `*` ───────────────────────────────────────── */
host.mode = 'star';
(session as unknown as { signs: Map<string, number> }).signs.clear();
session.status.state = 'off';
const n2 = host.logins.length;
calls.length = 0;
await session.kick();
ok(state() === 'failed' && /websites/.test(session.status.why) && host.logins.length === n2, 'a guild that won’t take credentials is refused before anything is signed');
calls.length = 0;
await guildApi('0-5').timestamp();
ok(calls[0]?.credentials === 'omit', 'and it is called without cookies from then on');
calls.length = 0;
await session.kick();
ok(!calls.some((c) => c.credentials === 'include'), 'nor asked again with them this visit');

/* ── 6. GRASS patches ──────────────────────────────────────────────────── */
const st = {
  playerId: '1-77', account: 0, address: 'a', name: 'n', pfp: '', guildId: '0-5', substationId: '4-1', planetId: '2-7', fleetId: '9-77',
  alpha: 0n, ore: 5, load: 10n, structsLoad: 0n, capacity: 100n, connectionCapacity: 0n, lastAction: 90, online: true, planet: null, fleet: null, target: null,
  structs: new Map([['5-1', { id: '5-1', health: 3, status: 7, built: true, online: true, destroyed: false, blockStartBuild: 0 } as never]]), readAt: 0, readHeight: 0,
};
empire.players.set('1-77', st as never);
const frame = (o: Record<string, unknown>) => parseGrass(String(o.subject), JSON.stringify(o))!;
ok(empire.applyGrass(frame({ subject: 'structs.grid.player.1-77.1-77', category: 'ore', object_id: '1-77', value_p: 8, value_old_p: 5 })) && st.ore === 8, 'a grid value that follows from ours is patched in place');
ok(empire.applyGrass(frame({ subject: 'structs.grid.player.1-77.1-77', category: 'load', object_id: '1-77', value_p: 200000, value_old_p: 10 })) && st.load === 200000n && !st.online, 'power patches keep the online flag right');
ok(!empire.applyGrass(frame({ subject: 'structs.grid.player.1-77.1-77', category: 'ore', object_id: '1-77', value_p: 20, value_old_p: 11 })) && st.ore === 8, 'a value that doesn’t follow from ours asks for a re-read instead');
ok(empire.applyGrass(frame({ subject: 'structs.grid.substation.4-1', category: 'connectionCapacity', object_id: '4-1', value_p: 500000, value_old_p: 0 })) && st.connectionCapacity === 500000n && st.online, 'the substation’s share patches its players');
ok(empire.applyGrass(frame({ subject: 'structs.planet.2-7.1-77', category: 'struct_health', planet_id: '2-7', detail: { struct_id: '5-1', health: 2, health_old: 3 } })) && (st.structs.get('5-1') as unknown as { health: number }).health === 2, 'a struct’s health patches in place');
ok(!empire.applyGrass(frame({ subject: 'structs.planet.2-7.1-77', category: 'struct_status', planet_id: '2-7', detail: { struct_id: '5-1', status: 39, status_old: 7 } })), 'a struct that fell asks for a re-read');
ok(!empire.applyGrass(frame({ subject: 'structs.planet.2-7.1-77', category: 'struct_block_ore_mine_start', planet_id: '2-7', detail: { block: 101, planet_id: '2-7' } })), 'a mining start (no struct id in it) asks for a re-read');
ok(!empire.applyGrass(frame({ subject: 'structs.planet.2-7.1-77', category: 'struct_health', planet_id: '2-7', stub: 'true' })), 'a stub asks for a re-read');

if (fails) { console.error(`session: ${fails} failure(s)`); process.exit(1); }
console.log('session: all checks passed');
process.exit(0);
