/* How the page reaches a guild's API: straight to the API its guild.json names. That works for a
 * guild that answers this site with CORS, as the live guilds do (Access-Control-Allow-Origin: *).
 * Requests carry no cookies: a wildcard CORS answer is refused by the browser for any request that
 * does, and the guilds' session cookie is SameSite=Lax anyway. So public routes (the clock, guild
 * info, player lookups, signup) work; members-only routes need a session this site can't hold,
 * which the Guild API client reports in plain words. A guild that won't answer this site is a
 * GuildBlockedError; a network that's down is a plain Error that says so. Redirects are refused:
 * the page can't check where they lead. */
import { guildEntry, guildsNow, answers, NOT_SHARED, type GuildEntry } from './directory';
import { store } from '../chain/store';

/** A guild's best name: its guild.json's, else the chain's. */
const nameOf = (id: string) => guildsNow()?.find((g) => g.id === id)?.meta?.name || store.guildName(id) || `Guild ${id}`;

/** The guild won't talk to this site directly. The message is for players; `detail` is for experts. */
export class GuildBlockedError extends Error {
  constructor(readonly guildId: string, readonly detail: string) {
    super(`${nameOf(guildId)} doesn’t let this website connect to it yet.`);
    this.name = 'GuildBlockedError';
  }
}

/** The directory entry in hand, read without re-reading (and re-announcing) the directory. */
async function entry(guildId: string): Promise<GuildEntry | null> {
  return guildsNow()?.find((g) => g.id === guildId) ?? guildEntry(guildId).catch(() => null);
}

/** The Guild API base (…/api) for a guild, from its guild.json, or why there is none. */
async function apiBase(guildId: string): Promise<string> {
  const e = await entry(guildId);
  const api = e?.services?.guild_api;
  if (api) return api.replace(/\/+$/, '').replace(/(\/api)?$/, '/api');
  throw new GuildBlockedError(guildId, e?.error === NOT_SHARED ? 'its guild.json has no CORS header' : e?.error || 'it publishes no guild API');
}

/** A request to `<guild api>/<path>`. Resolves with the Response (any status); rejects when nothing came back. */
export async function guildFetch(guildId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const rel = path.replace(/^\/+/, '');
  const base = await apiBase(guildId);
  const headers = new Headers(init.headers || {});
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  try {
    return await fetch(`${base}/${rel}`, { ...init, headers, mode: 'cors', credentials: 'omit', redirect: 'error' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    // Refused (the host answers, just not to us) or unreachable (offline, down): different news.
    if (await answers(`${base}/timestamp`)) throw new GuildBlockedError(guildId, 'no CORS answer from its API');
    throw new Error(`Couldn’t reach ${nameOf(guildId)}. Check your connection and try again.`);
  }
}

/** Whether this guild's API answers this site at all. Asked once
 * per guild per visit, so enlisting doesn't offer a guild that would refuse only after signing. */
const reach = new Map<string, Promise<boolean>>();
const known = new Map<string, boolean>();
export function canReach(guildId: string): Promise<boolean> {
  let p = reach.get(guildId);
  if (!p) {
    // Being offline isn't the guild's refusal: only a GuildBlockedError rules it out.
    p = guildFetch(guildId, 'timestamp').then(() => true, (e) => !(e instanceof GuildBlockedError));
    void p.then((ok) => known.set(guildId, ok));
    reach.set(guildId, p);
  }
  return p;
}
/** What canReach found, once it has: false only for a guild known to refuse this site. */
export const reachableNow = (guildId: string): boolean | undefined => known.get(guildId);
