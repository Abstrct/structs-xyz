// A minimal Guild API for the devnet guild — just the routes the client uses to bring players in
// and sign them in — plus the guild.json the guild directory reads. No dependencies.
//
//   STRUCTSD=… DEVNET_HOME=… node scripts/devnet/mock-guild.mjs [port=31318]
//
//   GET  /guild.json                                   the devnet guild's self-description
//   GET  /api/timestamp                                {unix_timestamp}
//   GET  /api/guild/this                               the guild row (from the LCD)
//   POST /api/auth/signup                              202, then the guild's job: the owner key broadcasts
//                                                      MsgGuildMembershipJoinProxy (structsd CLI, v0.21 args:
//                                                      [address] [proof pubkey] [proof signature] --player-name)
//   POST /api/auth/login                               checks the address is this guild's player; sets a session cookie
//   GET  /api/auth/logout
//   GET  /api/auth/player-address/<addr>/guild/<g>/player-id
//   anything else                                      404 in the API's envelope
//
// Signatures are not checked here: the chain checks the signup proof, and a mock session gates nothing.
//
// Like a guild that lets websites in, it answers CORS (credentials allowed) for any page on this
// machine, so the client calls it directly. Its session cookie is SameSite=Lax, as the real one is:
// the browser sends it only to the same site, so open the devnet page on 127.0.0.1 (as this listens),
// not localhost. Ports don't count, so http://127.0.0.1:5186 and this are the same site.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.MOCK_GUILD_PORT || 31318);
const STRUCTSD = process.env.STRUCTSD || 'structsd';
const HOME = process.env.DEVNET_HOME || join(here, '.home');
const CHAIN_ID = process.env.CHAIN_ID || 'structs-devnet-1';
const NODE = process.env.NODE_RPC || 'tcp://127.0.0.1:36657';
const LCD = process.env.LCD || 'http://127.0.0.1:31317';
const GUILD_ID = process.env.GUILD_ID || '0-1';
const SIGNER = process.env.GUILD_SIGNER || 'alice';     // the guild owner's key in the devnet keyring
const BASE = `http://127.0.0.1:${PORT}`;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const lcd = async (p) => { const r = await fetch(LCD + p); if (!r.ok) throw new Error(`LCD ${r.status} ${p}`); return r.json(); };
const sessions = new Map();     // cookie → { playerId, address }

/* The guild's transaction agent: one broadcast at a time, followed into a block. */
let chain = Promise.resolve();
function agent(args) {
  const run = () => new Promise((resolve) => {
    execFile(STRUCTSD, ['tx', ...args, '--from', SIGNER, '--home', HOME, '--keyring-backend', 'test', '--chain-id', CHAIN_ID, '--node', NODE,
      '--gas', 'auto', '--gas-adjustment', '1.5', '--output', 'json', '--yes'], { timeout: 60_000 }, async (err, stdout, stderr) => {
      const line = String(stdout).split('\n').filter((l) => l.startsWith('{')).pop();
      let res = null; try { res = JSON.parse(line); } catch { /* none */ }
      if (!res?.txhash) { log('agent: refused before broadcast:', (stderr || String(err || stdout)).trim().split('\n').pop()); return resolve(null); }
      if (res.code) { log('agent: CheckTx refused', res.code, res.raw_log); return resolve(null); }
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const t = await fetch(`${LCD}/cosmos/tx/v1beta1/txs/${res.txhash}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (t?.tx_response) { log(`agent: ${args[1]} ${args[2]} ${t.tx_response.code ? 'FAILED ' + t.tx_response.raw_log : 'ok'} h=${t.tx_response.height} ${res.txhash}`); return resolve(t.tx_response); }
      }
      log('agent: never landed', res.txhash); resolve(null);
    });
  });
  chain = chain.then(run, run);
  return chain;
}

/** CORS for a page on this machine (any port), with credentials: what a guild that allows the site sends. */
function cors(req) {
  const o = String(req.headers.origin || '');
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(o)
    ? { 'access-control-allow-origin': o, 'access-control-allow-credentials': 'true', vary: 'origin' } : {};
}
function send(res, status, data, errors = [], extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...res.cors, ...extra });
  res.end(JSON.stringify({ success: status < 400, errors, data }));
}
const body = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r(null); } }); });
const cookie = (req) => /(?:^|;\s*)PHPSESSID=([^;]+)/.exec(req.headers.cookie || '')?.[1];

async function guildRow() {
  const g = (await lcd(`/structs/guild/${GUILD_ID}`)).Guild;
  return { id: g.id, endpoint: g.endpoint, join_infusion_minimum: g.joinInfusionMinimum, join_infusion_minimum_bypass_by_request: g.joinInfusionMinimumBypassByRequest, join_infusion_minimum_bypass_by_invite: g.joinInfusionMinimumBypassByInvite,
    primary_reactor_id: g.primaryReactorId, entry_substation_id: g.entrySubstationId, creator: g.creator, owner: g.owner, name: 'Devnet Guild', description: 'The local devnet guild (mock Guild API).', tag: 'DEV', logo: '',
    socials: '{}', website: '', this_infrastructure: true, status: 'online', default_commission: '0', validator: '', reactor_ratio: '1000' };
}

createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname;
  log(req.method, p);
  res.cors = cors(req);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...res.cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, accept', 'access-control-max-age': '600' });
      return res.end();
    }
    if (p === '/guild.json') {
      return res.writeHead(200, { 'content-type': 'application/json', ...res.cors }), res.end(JSON.stringify({ guild: { id: GUILD_ID, name: 'Devnet Guild', tag: 'DEV', description: 'The local devnet guild (mock Guild API).',
        services: { guild_api: `${BASE}/api`, grass_nats_websocket: null, matrix: null } } }));
    }
    if (p === '/api/timestamp') return send(res, 200, { unix_timestamp: Math.floor(Date.now() / 1000) });
    if (p === '/api/guild/this') return send(res, 200, await guildRow());
    if (p === '/api/auth/signup' && req.method === 'POST') {
      const b = await body(req);
      for (const k of ['primary_address', 'signature', 'pubkey', 'guild_id']) if (!b?.[k]) return send(res, 400, null, { [k]: `${k} is required` });
      if (b.guild_id !== GUILD_ID) return send(res, 400, null, { guild_id: 'not this guild' });
      const known = await lcd(`/structs/address/${b.primary_address}`).catch(() => null);
      if (known?.playerId && known.playerId !== '1-0') return send(res, 409, null, { resource_already_exists: 'player exists' });
      const args = ['structs', 'guild-membership-join-proxy', b.primary_address, b.pubkey, b.signature];
      if (b.username) args.push('--player-name', String(b.username));
      if (b.pfp_client_render_attributes) args.push('--player-pfp-client-render-attributes', String(b.pfp_client_render_attributes));
      void agent(args);
      return send(res, 202, null);
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const b = await body(req);
      if (!b?.address || !b.signature || !b.pubkey || b.guild_id !== GUILD_ID) return send(res, 401, null, { signature_validation_failed: 'bad request' });
      if (Math.abs(Date.now() / 1000 - Number(b.unix_timestamp)) > 600) return send(res, 401, null, { signature_validation_failed: 'stale timestamp' });
      const a = await lcd(`/structs/address/${b.address}`).catch(() => null);
      if (!a?.playerId || a.playerId === '1-0') return send(res, 401, null, { player_address_does_not_exists: 'unknown address' });
      const pl = (await lcd(`/structs/player/${a.playerId}`)).Player;
      if (pl.guildId !== GUILD_ID) return send(res, 401, null, { player_does_not_exists: 'not in this guild' });
      const sid = randomBytes(16).toString('hex');
      sessions.set(sid, { playerId: a.playerId, address: b.address });
      return send(res, 200, null, [], { 'set-cookie': `PHPSESSID=${sid}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (p === '/api/auth/logout') { sessions.delete(cookie(req)); return send(res, 200, null, [], { 'set-cookie': 'PHPSESSID=deleted; Path=/; Max-Age=0' }); }
    const m = /^\/api\/auth\/player-address\/([a-z0-9]+)\/guild\/([0-9-]+)\/player-id$/.exec(p);
    if (m) {
      const a = await lcd(`/structs/address/${m[1]}`).catch(() => null);
      const pl = a?.playerId && a.playerId !== '1-0' ? (await lcd(`/structs/player/${a.playerId}`)).Player : null;
      return send(res, 200, pl && pl.guildId === m[2] ? { player_id: pl.id } : null);
    }
    if (p.startsWith('/api/') && !sessions.has(cookie(req))) return send(res, 401, null, { authentication_error: 'Login required' });
    return send(res, 404, null, { not_found: `the mock guild API does not implement ${p}` });
  } catch (e) {
    return send(res, 500, null, { mock: String(e.message || e) });
  }
}).listen(PORT, '127.0.0.1', () => log(`mock guild API for ${GUILD_ID} on ${BASE} (signer ${SIGNER}, home ${HOME})`));
