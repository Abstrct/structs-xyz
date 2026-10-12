/* The data layer, offline:
 *   1. the NATS parser over real GRASS frames (scripts/fixtures/grass-frames.json, captured
 *      read-only from wss://beta.playstructs.com:1443), whole and split at every kind of boundary;
 *   2. GRASS payload parsing, subject matching, the ring, and the narration;
 *   3. the cache (memory fallback here: Node has no IndexedDB): TTL, namespaces, single-flight,
 *      stale-while-revalidate;
 *   4. the Guild API sign-in: the exact message, a signature the chain's verifier accepts, and the
 *      401 → sign in → retry flow against a mocked guild (nothing leaves this process), including
 *      late 401s from before the sign-in (no second signature) and a refused timestamp;
 *   5. GRASS's block tip (forward, plausible, self-healing) and the NATS handshake deadline. */
import { readFileSync } from 'node:fs';
import { NatsParser, NatsWs, type NatsOp, type NatsState } from '../src/grass/nats';
import { parseGrass, subjectMatches, grassMatches, Ring, nextTip, MAX_LEAP, RESYNC_AFTER, type GrassEvent } from '../src/grass/grass';
import { describe, statusChange, groupOf, hrefFor } from '../src/grass/describe';
import { cache, cached, saveRoster, loadRoster } from '../src/cache/idb';
import { buildLoginMessage, buildLoginRequest, GuildApi, GuildApiError, qs } from '../src/guild/api';
import { deriveKey, verifyBytes, fromHex, toHex, addressOf, signBytes } from '../src/wallet/keys';

let fails = 0;
const ok = (cond: unknown, msg: string) => { if (!cond) { fails++; console.error('FAIL', msg); } };
const enc = new TextEncoder(), dec = new TextDecoder();

/* ── 1. NATS parser ─────────────────────────────────────────────────────── */
const fx = JSON.parse(readFileSync(new URL('./fixtures/grass-frames.json', import.meta.url), 'utf8')) as { frames: string[] };
const frames = fx.frames.map((b) => Uint8Array.from(Buffer.from(b, 'base64')));
const all = Buffer.concat(frames.map((f) => Buffer.from(f)));

// An independent oracle: walk the text with a regex for headers and slice payloads by length.
const oracle: { subject: string; sid: number; payload: string }[] = [];
{
  let pos = 0;
  const text = all.toString('latin1');   // byte-for-byte
  while (pos < text.length) {
    const eol = text.indexOf('\r\n', pos);
    if (eol < 0) break;
    const line = text.slice(pos, eol);
    const m = /^MSG (\S+) (\d+) (?:(\S+) )?(\d+)$/.exec(line);
    if (m) {
      const n = Number(m[4]);
      oracle.push({ subject: m[1], sid: Number(m[2]), payload: Buffer.from(text.slice(eol + 2, eol + 2 + n), 'latin1').toString('utf8') });
      pos = eol + 2 + n + 2;
    } else pos = eol + 2;
  }
}
const run = (chunks: Uint8Array[]) => { const p = new NatsParser(); const out: NatsOp[] = []; for (const c of chunks) out.push(...p.push(c)); return out; };
const msgs = (ops: NatsOp[]) => ops.filter((o): o is Extract<NatsOp, { op: 'MSG' }> => o.op === 'MSG');
const sameMsgs = (ops: NatsOp[]) => {
  const m = msgs(ops);
  return m.length === oracle.length && m.every((x, i) => x.subject === oracle[i].subject && x.sid === oracle[i].sid && dec.decode(x.payload) === oracle[i].payload);
};

const whole = run(frames);
ok(oracle.length >= 20, `fixture has plenty of MSGs (${oracle.length})`);
ok(sameMsgs(whole), 'frames as captured: every MSG, in order, with exact payload bytes');
ok(whole.some((o) => o.op === 'INFO') && whole.some((o) => o.op === 'PING') && whole.some((o) => o.op === 'PONG'), 'INFO, PING and PONG recognised');
ok(sameMsgs(run([new Uint8Array(all)])), 'all frames in one chunk');
ok(sameMsgs(run(Array.from(all, (b) => Uint8Array.of(b)))), 'one byte at a time (splits mid-line, mid-payload, mid-CRLF)');
// Random splits, repeatable.
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (let trial = 0; trial < 25; trial++) {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < all.length;) { const n = 1 + Math.floor(rnd() * 400); chunks.push(new Uint8Array(all.subarray(i, i + n))); i += n; }
  if (!sameMsgs(run(chunks))) { ok(false, `random split trial ${trial}`); break; }
}
// Multi-byte UTF-8 split across frames: the declared length is bytes, not characters.
{
  const body = enc.encode('{"subject":"structs.player.0-1.1-9","category":"player_consensus","username":"Ünïcødé ✦ 星"}');
  const wire = new Uint8Array([...enc.encode(`MSG structs.player.0-1.1-9 1 ${body.length}\r\n`), ...body, ...enc.encode('\r\nPING\r\n')]);
  const cut = wire.indexOf(0xe2) + 1;   // inside the ✦
  const ops = run([wire.slice(0, cut), wire.slice(cut)]);
  const m = msgs(ops)[0];
  ok(m && JSON.parse(dec.decode(m.payload)).username === 'Ünïcødé ✦ 星' && ops[1]?.op === 'PING', 'UTF-8 payload split mid-character');
}
ok(run([enc.encode('MSG a.b 3 _INBOX.x 2\r\nhi\r\n')]).some((o) => o.op === 'MSG' && o.reply === '_INBOX.x' && dec.decode(o.payload) === 'hi'), 'MSG with a reply subject');
ok(run([enc.encode("-ERR 'Unknown Protocol Operation'\r\n+OK\r\n")]).map((o) => o.op).join() === 'ERR,OK', '-ERR and +OK');

/* ── 2. GRASS payloads ──────────────────────────────────────────────────── */
const events = msgs(whole).map((m) => parseGrass(m.subject, m.payload, 1_000)).filter((e): e is GrassEvent => !!e);
ok(events.length === oracle.length, 'every fixture payload parses');
const block = events.find((e) => e.kind === 'block');
ok(block && block.height! > 3_000_000 && block.category === 'block', 'consensus → block with height');
const planet = events.find((e) => e.kind === 'planet');
ok(planet && /^2-\d+$/.test(planet.planetId!) && /^1-\d+$/.test(planet.playerId!) && planet.seq! > 0 && typeof planet.detail === 'object', 'planet activity: planet, owner, seq, detail');
const grid = events.find((e) => e.kind === 'grid');
ok(grid && /^1-\d+$/.test(grid.objectId!) && grid.playerId === grid.objectId, 'grid: object and owner');
const inv = events.find((e) => e.kind === 'inventory');
ok(inv && inv.category === 'mined' && /^1-\d+$/.test(inv.playerId!) && /^0-\d+$/.test(inv.guildId!), 'inventory: player and guild');
const stub = parseGrass('structs.planet.2-9.1-4', '{"subject":"structs.planet.2-9.1-4","planet_id":"2-9","player_id":"1-4","seq":5,"category":"struct_attack","time":"x","stub":"true"}');
ok(stub?.stub === true && stub.planetId === '2-9' && describe(stub, { player: (id) => id }).stub, 'stub payloads are flagged');
ok(parseGrass('x', 'not json') === null && parseGrass('x', '{"subject":"x"}') === null && parseGrass('x', '[1]') === null, 'junk and category-less payloads are dropped');
const strDetail = parseGrass('structs.planet.2-1.1-1', JSON.stringify({ subject: 'structs.planet.2-1.1-1', category: 'shield_change', detail: JSON.stringify({ planetary_shield: 5, planetary_shield_old: 9 }) }));
ok(strDetail?.detail.planetary_shield === 5, 'a detail sent as a JSON string is parsed');

ok(subjectMatches('structs.planet.', 'structs.planet.2-1.1-1') && !subjectMatches('structs.grid.', 'structs.planet.2-1'), 'prefix match');
ok(subjectMatches('structs.planet.*.1-1', 'structs.planet.2-7.1-1') && !subjectMatches('structs.planet.*.1-1', 'structs.planet.2-7.1-2'), '* matches one token');
ok(subjectMatches('structs.>', 'structs.grid.player.1-1.1-1') && !subjectMatches('structs.>', 'structs') && !subjectMatches('structs.*', 'structs.a.b'), '> matches the rest');
ok(grassMatches({ category: ['ore', 'mined'], kind: 'inventory' }, inv!) && !grassMatches({ category: 'ore', kind: 'grid' }, inv!), 'filters by category and kind');

const r = new Ring<number>(3);
[1, 2, 3, 4, 5].forEach((x) => r.push(x));
ok(r.toArray().join() === '3,4,5' && r.last() === 5 && r.size === 3, 'ring keeps the newest');

const names = { player: (id: string) => ({ '1-914': 'Vex' } as Record<string, string>)[id] || id };
const text = (e: GrassEvent) => describe(e, names).parts.map((p) => p.text).join('');
for (const e of events) { try { const d = describe(e, names); ok(d.parts.length && text(e).length > 3, 'narrates ' + e.category); } catch (err) { ok(false, `describe threw on ${e.category}: ${err}`); } }
const status = parseGrass('structs.planet.2-50139.1-914', '{"seq":47,"detail":{"status":7,"struct_id":"5-430514","status_old":1},"subject":"structs.planet.2-50139.1-914","category":"struct_status","planet_id":"2-50139","player_id":"1-914"}')!;
ok(/^Vex’s struct 5-430514 finished building and came online on 2-50139$/.test(text(status)), 'struct status narrated: ' + text(status));
ok(describe(status, names).parts.some((p) => p.id === '2-50139') && describe(status, names).parts.some((p) => p.id === '1-914'), 'ids are marked for links');
ok(statusChange(39, 7).text === 'was destroyed' && statusChange(3, 7).text === 'went offline' && statusChange(23, 7).text === 'went into stealth', 'status bit diffs');
ok(/mined 1 ore/.test(text(inv!)), 'inventory narrated: ' + text(inv!));
ok(groupOf(planet!) !== 'grid' && groupOf(grid!) === 'grid' && groupOf(inv!) === 'economy', 'groups');
ok(hrefFor('1-5') === '/player/1-5' && hrefFor('2-5') === '/planet/2-5' && hrefFor('0-5') === '/intel/guild/0-5' && hrefFor('5-5') === null, 'links');
const hit = parseGrass('s', JSON.stringify({ subject: 'structs.planet.2-1.1-914', category: 'struct_health', planet_id: '2-1', player_id: '1-914', detail: { struct_id: '5-1', health: 0, health_old: 3 } }))!;
ok(describe(hit, names).tone === 'enemy' && /took 3 damage \(0 left\)/.test(text(hit)), 'a killing blow reads as one');

/* ── 3. Cache ───────────────────────────────────────────────────────────── */
ok(!(await cache.persistent()), 'no IndexedDB in Node: memory mode');
await cache.set('a', { x: 1 }, 50, 'ns1');
ok((await cache.get<{ x: number }>('a', 'ns1'))?.x === 1 && (await cache.get('a', 'ns2')) === undefined, 'namespaced get');
await new Promise((r2) => setTimeout(r2, 70));
ok((await cache.get('a', 'ns1')) === undefined && (await cache.entry('a', 'ns1'))?.v, 'expired: get misses, entry still has the stale value');
let loads = 0;
const loader = async () => { loads++; await new Promise((r2) => setTimeout(r2, 20)); return 'v' + loads; };
const [x1, x2] = await Promise.all([cached('k', 1000, loader), cached('k', 1000, loader)]);
ok(x1 === 'v1' && x2 === 'v1' && loads === 1, 'concurrent loads share one flight');
ok((await cached('k', 1000, loader)) === 'v1' && loads === 1, 'fresh hit skips the loader');
await cache.set('k', 'old', -1);
let updated = '';
const stale = await cached('k', 1000, loader, { staleWhileRevalidate: true, onUpdate: (v) => { updated = v; } });
await new Promise((r2) => setTimeout(r2, 40));
ok(stale === 'old' && updated === 'v2', 'stale-while-revalidate: stale now, fresh after');
ok((await cached('k2', 1000, async () => [] as number[], { keep: (v) => v.length > 0 })).length === 0 && (await cache.entry('k2')) === null, 'keep() can refuse to store');
await cache.clear('ns1');
ok((await cache.entry('a', 'ns1')) === null, 'clear a namespace');
await saveRoster({ players: [{ id: '1-1' }], fleets: [], guilds: [] });
ok((await loadRoster<{ id: string }, never, never>())?.players[0].id === '1-1' && (await loadRoster(-1)) === null, 'roster snapshot round trip and max age');

/* ── 4. Guild API sign-in ───────────────────────────────────────────────── */
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const key = deriveKey(PHRASE, 0);
// The wallet's format: secp256k1 over sha256(utf8), r‖s then a recovery byte, as hex (only r‖s is checked).
const signer = (m: string) => ({ address: key.address, pubkey: toHex(key.pubKey), signature: toHex(new Uint8Array([...signBytes(key.privKey, enc.encode(m)), 0])) });

ok(buildLoginMessage('0-5', 'structs1abc', 1791517557) === 'LOGIN_GUILD0-5ADDRESSstructs1abcDATETIME1791517557', 'login message, exact');
const req = buildLoginRequest('0-5', key.address, 1791517557, signer);
ok(req.guild_id === '0-5' && req.unix_timestamp === 1791517557 && req.address === key.address && req.pubkey.length === 66 && req.signature.length === 130, 'login request shape');
// What structsd's validate_signature does: pubkey → address, then verify sig[:64] over sha256(message).
ok(addressOf(fromHex(req.pubkey)) === req.address, 'pubkey derives the address');
ok(verifyBytes(fromHex(req.pubkey), enc.encode(buildLoginMessage('0-5', req.address, req.unix_timestamp)), fromHex(req.signature).slice(0, 64)), 'signature verifies like the chain verifies it');
let threw = false;
try { buildLoginRequest('0-5', 'structs1someoneelse', 1, signer); } catch { threw = true; }
ok(threw, 'a signer for another address is refused');
ok(qs({ a: 1, b: undefined, c: '', d: true, e: 'x y' }) === '?a=1&d=1&e=x+y' && qs({}) === '', 'query strings drop empties');

// Guild API calls against a mocked guild: public routes answer; members-only routes (401) come back
// as 'blocked' without signing anything, since the guild's session is a cookie this site can't use.
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: () => null, length: 0 }; };
(globalThis as Record<string, unknown>).localStorage = mem();
(globalThis as Record<string, unknown>).sessionStorage = mem();
const { wallet } = await import('../src/wallet/wallet');
const { store } = await import('../src/chain/store');
const { guilds } = await import('../src/guild/directory');
// The guild on chain, whose guild.json names its API: the page calls that API directly.
store.guilds.set('0-5', { id: '0-5', index: '5', endpoint: 'https://guild5.example/guild.json', creator: '', owner: '', joinInfusionMinimum: '0', primaryReactorId: '', entrySubstationId: '', entryRank: '', name: '', pfp: '' } as never);
const calls: { url: string; method: string; credentials?: RequestCredentials }[] = [];
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === 'https://guild5.example/guild.json') return reply(200, { guild: { id: '0-5', name: 'Guild 5', services: { guild_api: 'https://api.guild.example/api' } } });
  calls.push({ url, method: init?.method || 'GET', credentials: init?.credentials });
  if (url.endsWith('/api/timestamp')) return reply(200, { success: true, errors: [], data: { unix_timestamp: 1791517557 } });
  if (url.endsWith('/api/auth/login')) return reply(200, { success: true, errors: [], data: null });
  if (url.includes('/api/player/count')) return reply(401, { success: false, errors: { authentication_error: 'Login required' }, data: null });
  return reply(404, { success: false, errors: { nope: 'unmocked ' + url }, data: null });
}) as typeof fetch;

await guilds();
const api = new GuildApi('0-5');
ok((await api.timestamp()).unix_timestamp === 1791517557, 'a public route answers');
// A member with an unlocked wallet still isn't signed in: nothing this site holds would carry the session.
await wallet.create(PHRASE, 'correct horse battery');
wallet.setAccount(0, { playerId: '1-77' });
store.players.set('1-77', { id: '1-77', guildId: '0-5' } as never);
calls.length = 0;
const err = await api.playerCount().then(() => null, (e) => e);
ok(err instanceof GuildApiError && err.code === 'blocked' && /members-only/.test(err.message) && /cookie/.test(err.errors.detail || ''), 'a members-only route is blocked, in plain words: ' + String(err?.message));
ok(calls.length === 1 && !calls.some((c) => c.url.endsWith('/auth/login')), 'and nothing is signed or sent to sign in');
ok(calls.every((c) => c.url.startsWith('https://api.guild.example/api/') && c.credentials === 'omit'), 'calls go straight to the guild’s API, without cookies');

/* ── 5. Block tip and NATS handshake ────────────────────────────────────── */
{
  let t = { tip: 0, refused: 0, advanced: false, resync: false };
  const feed = (h2: number | undefined) => (t = nextTip(t.tip, h2, t.refused));
  feed(100); ok(t.tip === 100 && t.advanced, 'first height sets the tip');
  feed(101); ok(t.tip === 101 && t.advanced, 'next height advances');
  feed(101); ok(t.tip === 101 && !t.advanced && t.refused === 0, 'a repeat is not news');
  feed(undefined); feed(0); ok(t.tip === 101 && !t.advanced, 'no height: no change');
  feed(101 + MAX_LEAP + 1); ok(t.tip === 101 && !t.advanced && t.refused === 1, 'an implausible leap is refused');
  feed(102); ok(t.tip === 102 && t.refused === 0, 'real blocks carry on after it');
  // A bogus huge first height (or a server that went back): the feed's own count wins after a few.
  t = { tip: 9_999_999_999, refused: 0, advanced: false, resync: false };
  for (let i = 0; i < RESYNC_AFTER - 1; i++) feed(200 + i);
  ok(t.tip === 9_999_999_999 && t.refused === RESYNC_AFTER - 1, 'lower heights refused for a while');
  feed(210); ok(t.tip === 210 && t.advanced && t.resync && t.refused === 0, 'then the tip resyncs to the feed');
  feed(211); ok(t.tip === 211 && !t.resync, 'and advances normally again');
}
{
  // A socket that opens and never answers: dropped at the handshake deadline and dialled again.
  const sockets: FakeWs[] = [];
  class FakeWs {
    readyState = 0; binaryType = ''; sent: string[] = []; closed = false;
    onopen: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
    constructor(readonly url: string) { sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 1); }
    send(b: Uint8Array) { this.sent.push(dec.decode(b)); }
    close() { this.closed = true; this.readyState = 3; setTimeout(() => this.onclose?.(), 1); }
  }
  const states: NatsState[] = [];
  const n = new NatsWs({ url: 'wss://example.invalid', WebSocket: FakeWs as never, handshakeMs: 40 });
  n.onState((s2) => states.push(s2));
  n.connect();
  await new Promise((r2) => setTimeout(r2, 20));
  ok(sockets.length === 1 && n.state === 'connecting' && /^CONNECT /.test(sockets[0].sent[0] || ''), 'dials and says hello');
  await new Promise((r2) => setTimeout(r2, 60));
  ok(sockets[0].closed && n.state === 'down', `a silent server is dropped at the deadline (${n.state})`);
  for (let i = 0; i < 150 && sockets.length < 2; i++) await new Promise((r2) => setTimeout(r2, 10));   // first backoff is 1 s
  ok(sockets.length === 2, `and dialled again (${sockets.length} sockets)`);
  // This one answers: live, and the deadline no longer applies.
  await new Promise((r2) => setTimeout(r2, 5));
  sockets[1].onmessage?.({ data: enc.encode('INFO {}\r\nPONG\r\n') });
  await new Promise((r2) => setTimeout(r2, 80));
  ok(n.state === 'live' && !sockets[1].closed && sockets.length === 2, `an answering server goes live and stays (${n.state})`);
  n.close();
  ok(n.state === 'closed' && states.join() === 'down,connecting,live,closed', 'state trail: ' + states.join());
}

if (fails) { console.error(`${fails} failure(s)`); process.exit(1); }
console.log('data ok', oracle.length, 'msgs');
