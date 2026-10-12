/* The guild directory: every guild on chain with what its guild.json says about itself —
 * name, tag, logo, description, and the services it runs (Guild API, GRASS, Matrix).
 * The page reads each guild.json itself, which works for every guild that serves it with CORS;
 * the file must name the same guild as the chain. Cached for 10 minutes, served stale while
 * it refreshes. If nothing answers, the chain's own list stands in, unnamed. */
import { cached } from '../cache/idb';
import { lcd, LCD_URL, type RawGuild } from '../chain/lcd';
import { store } from '../chain/store';
import { wallet } from '../wallet/wallet';

export interface GuildMeta {
  name: string; tag: string; description: string; logo: string; website: string;
  domain?: string; webapp?: string; socials?: Record<string, string>; denom?: Record<string, string>; baseEnergy?: string;
}
export interface GuildServices { guild_api: string | null; grass: string | null; matrix: string | null; explorer: string | null }
export interface GuildEntry { id: string; chain: RawGuild; meta: GuildMeta | null; services: GuildServices | null; error: string | null }

/** SN Corp: the guild whose infrastructure backs this client by default. */
const ENV = (import.meta as { env?: Record<string, string | undefined> }).env || {};
export const DEFAULT_GUILD = ENV.VITE_DEFAULT_GUILD || '0-5';
/** VITE_GRASS_URL points a devnet client at its own stream; "off" disables GRASS entirely. */
export const FALLBACK_GRASS = ENV.VITE_GRASS_URL || 'wss://beta.playstructs.com:1443';
const TTL = 10 * 60_000;

let last: GuildEntry[] | null = null;
const listeners = new Set<(g: GuildEntry[]) => void>();

/** The latest directory already in hand (null until the first load), for synchronous lookups. */
export function guildsNow(): GuildEntry[] | null { return last; }
export function onGuilds(f: (g: GuildEntry[]) => void) { listeners.add(f); if (last) f(last); return () => { listeners.delete(f); }; }

/** Listeners hear a list that changed, not every read of the same one (every direct Guild API call reads it). */
function publish(list: GuildEntry[]) {
  if (last && (list === last || JSON.stringify(list) === JSON.stringify(last))) return;
  last = list;
  for (const f of listeners) { try { f(list); } catch (e) { console.error(e); } }
}

async function fromChain(): Promise<GuildEntry[]> {
  const list = store.guilds.size ? [...store.guilds.values()] : await lcd.list<RawGuild>('guild', 'Guild');
  return list.map((g) => ({ id: g.id, chain: g, meta: null, services: null, error: NO_DIRECTORY }));
}

/** The mark on entries read from the chain alone (no guild.json reached). */
export const NO_DIRECTORY = 'directory unavailable';
/** The mark on a guild whose guild.json this page may not read (no CORS header). */
export const NOT_SHARED = 'guild.json is not shared with websites';
/** The mark on a guild whose host didn't answer at all (offline, down): not a refusal. */
const UNREACHABLE = 'guild.json unreachable';

/** Which service URLs a guild.json may name: https to a named public host, never an IP literal, a
 * local name or a wildcard-DNS name that resolves to one, so a guild.json can't point players'
 * browsers into their own network. (A page can't check the resolved address, so redirects are
 * refused too.) Loopback is allowed only for a devnet: the page and the chain both on this machine. */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;
const loopbackHost = (u: string) => { try { return LOOPBACK.test(new URL(u).hostname); } catch { return false; } };
const DEVNET = typeof location !== 'undefined' && LOOPBACK.test(location.hostname) && loopbackHost(LCD_URL);
const WILDCARD_DNS = /(^|\.)(nip\.io|sslip\.io|xip\.io|nip\.direct|localtest\.me|lvh\.me|traefik\.me|backname\.io|localhost\.run)$/;
export function okUrl(u: unknown, schemes = ['https:']): u is string {
  if (typeof u !== 'string') return false;
  try {
    const x = new URL(u);
    if (x.username || x.password) return false;
    const host = x.hostname.toLowerCase().replace(/\.$/, '');
    if (LOOPBACK.test(host)) return DEVNET && /^(https?|wss?):$/.test(x.protocol);
    if (!schemes.includes(x.protocol) || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return false;
    return host.includes('.') && !/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host) && !WILDCARD_DNS.test(host);
  } catch { return false; }
}

/** A guild.json is small: capped at 64 KB (a hostile one can't stall every tab). */
const GUILD_JSON_MAX = 64 * 1024;
async function readCapped(r: Response, max: number): Promise<string> {
  if (Number(r.headers.get('content-length') || 0) > max) throw new Error('too large');
  if (!r.body) return '';
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { void reader.cancel(); throw new Error('too large'); }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p2 of parts) { all.set(p2, o); o += p2.length; }
  return new TextDecoder().decode(all);
}

/** After a failed CORS read: did the host answer at all? An opaque no-cors reply means yes (so it
 * refused this site); a second failure means the network or the host is down. */
export async function answers(url: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  // A no-cors request must follow redirects (the browser refuses anything else); nothing is read from it.
  try { await fetch(url, { mode: 'no-cors', credentials: 'omit', signal: AbortSignal.timeout(6000) }); return true; } catch { return false; }
}

/* A guild.json that refused this site is asked again after an hour, not on every refresh: each
 * refusal is a red line in the console and a wasted request. Per browser, in localStorage. */
const REFUSED_KEY = 'structs.guildjson.refused';
const REFUSED_FOR = 3_600_000;
function refusals(): Record<string, number> {
  try { const v = JSON.parse(localStorage.getItem(REFUSED_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function noteRefusal(endpoint: string, refused: boolean) {
  try {
    const m = refusals();
    if (refused) m[endpoint] = Date.now(); else delete m[endpoint];
    for (const [k, t] of Object.entries(m)) if (Date.now() - t > REFUSED_FOR) delete m[k];
    localStorage.setItem(REFUSED_KEY, JSON.stringify(m));
  } catch { /* storage refused: just ask again next time */ }
}

/** The directory: the chain's list, then each guild's own file. */
async function fromDirect(fresh: boolean): Promise<GuildEntry[]> {
  const list = store.guilds.size ? [...store.guilds.values()] : await lcd.list<RawGuild>('guild', 'Guild');
  const refused = refusals();
  return Promise.all(list.slice(0, 80).map(async (g): Promise<GuildEntry> => {
    const entry: GuildEntry = { id: g.id, chain: g, meta: null, services: null, error: null };
    if (!okUrl(g.endpoint)) return { ...entry, error: 'no endpoint' };
    if (!fresh && Date.now() - (refused[g.endpoint] || 0) < REFUSED_FOR) return { ...entry, error: NOT_SHARED };
    let doc: Record<string, unknown> | undefined;
    let r: Response;
    try {
      r = await fetch(g.endpoint, { credentials: 'omit', redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    } catch (e) {
      // A CORS refusal, a redirect and an unreachable host all look the same here (a TypeError):
      // only a host that answers a no-cors request has refused us, and only that is remembered.
      if (e instanceof TypeError && await answers(g.endpoint)) { noteRefusal(g.endpoint, true); return { ...entry, error: NOT_SHARED }; }
      return { ...entry, error: UNREACHABLE };
    }
    if (refused[g.endpoint]) noteRefusal(g.endpoint, false);
    try { doc = r.ok ? (JSON.parse(await readCapped(r, GUILD_JSON_MAX)) as { guild?: Record<string, unknown> })?.guild : undefined; } catch { doc = undefined; }
    if (!doc || typeof doc !== 'object') return { ...entry, error: 'guild.json unreadable' };
    if (doc.id !== g.id) return { ...entry, error: 'guild.json names another guild' };
    const sv = (doc.services && typeof doc.services === 'object' ? doc.services : {}) as Record<string, unknown>;
    const str = (v: unknown, n = 400) => (typeof v === 'string' ? v.slice(0, n) : '');
    return clean({
      ...entry,
      meta: { name: str(doc.name, 80), tag: str(doc.tag, 12), description: str(doc.description, 600), logo: str(doc.logo), website: str(doc.website), domain: str(doc.domain, 120), webapp: str(doc.webapp, 120),
        socials: doc.socials as Record<string, string>, denom: doc.denom as Record<string, string>, baseEnergy: str(doc.baseEnergy, 30) },
      services: {
        guild_api: okUrl(sv.guild_api) ? sv.guild_api.replace(/\/+$/, '') : null,
        grass: okUrl(sv.grass_nats_websocket, ['wss:']) ? sv.grass_nats_websocket : null,
        matrix: okUrl(sv.matrix) ? sv.matrix.replace(/\/+$/, '') : null,
        explorer: okUrl(sv.explorer) ? sv.explorer : null,
      },
    });
  }));
}

/** Whatever arrives is still a third party's self-description: keep strings strings. */
function clean(g: GuildEntry): GuildEntry {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const m = g.meta;
  return {
    id: s(g.id), chain: g.chain, error: g.error ? s(g.error) : null,
    meta: m ? { name: s(m.name), tag: s(m.tag), description: s(m.description), logo: safeUrl(s(m.logo)), website: safeUrl(s(m.website)), domain: s(m.domain), webapp: s(m.webapp),
      socials: m.socials && typeof m.socials === 'object' ? m.socials : {}, denom: m.denom && typeof m.denom === 'object' ? m.denom : {}, baseEnergy: s(m.baseEnergy) } : null,
    services: g.services ? { guild_api: g.services.guild_api || null, grass: g.services.grass || null, matrix: g.services.matrix || null, explorer: g.services.explorer || null } : null,
  };
}

/** Only http(s) links leave this module: a guild.json can't smuggle javascript: into an href/src. */
export function safeUrl(u: string): string {
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : ''; } catch { return ''; }
}

/** Every guild on chain with its directory entry. */
export async function guilds(opts: { fresh?: boolean } = {}): Promise<GuildEntry[]> {
  try {
    const list = await cached('guilds-direct', TTL, () => fromDirect(!!opts.fresh), {
      ns: 'directory', staleWhileRevalidate: true, force: opts.fresh, onUpdate: publish,
      // A list where no guild answered (offline) isn't kept: the next read tries again.
      keep: (v) => v.length > 0 && !v.every((g) => g.error === UNREACHABLE || g.error === 'no endpoint'),
    });
    publish(list);
    return list;
  } catch {
    const list = await fromChain();
    if (!last) publish(list);
    return list;
  }
}

export async function guildEntry(id: string): Promise<GuildEntry | null> {
  return (await guilds()).find((g) => g.id === id) ?? null;
}

/** Name, tag, logo and description, with sensible fallbacks for guilds that publish nothing. */
export async function guildMeta(id: string): Promise<GuildMeta> {
  const e = await guildEntry(id).catch(() => null);
  return e?.meta?.name ? e.meta : fallbackMeta(id, e?.chain);
}

export function fallbackMeta(id: string, chain?: RawGuild): GuildMeta {
  return { name: chain?.name || store.guildName(id), tag: store.guildTag(id), description: '', logo: '', website: '' };
}

/** Synchronous best name for a guild: directory, then the store's fallback. */
export function guildLabel(id: string): { name: string; tag: string } {
  const e = last?.find((g) => g.id === id);
  if (e?.meta?.name) return { name: e.meta.name, tag: e.meta.tag || store.guildTag(id) };
  return { name: store.guildName(id), tag: store.guildTag(id) };
}

export async function servicesFor(id: string): Promise<GuildServices | null> {
  return (await guildEntry(id).catch(() => null))?.services ?? null;
}

/** The guild of the player this browser acts as: the wallet's active account, else the pinned commander. */
export async function homeGuild(): Promise<string | null> {
  // The pinned commander's key (chain/commander.ts), read directly: that module drags in audio and the DOM.
  let pinned: string | null = null;
  try { pinned = localStorage.getItem('structs.commander'); } catch { /* none */ }
  const ids = [wallet.active?.playerId, pinned].filter((x): x is string => !!x);
  for (const pid of ids) {
    const known = store.players.get(pid)?.guildId;
    if (known) return known;
    try {
      const p = await Promise.race([lcd.player(pid), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
      if (p.Player.guildId) return p.Player.guildId;
    } catch { /* try the next */ }
  }
  return null;
}
