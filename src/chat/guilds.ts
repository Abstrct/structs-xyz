/* Chat's view of the guilds: the directory (src/guild/directory.ts owns the fetch and the cache)
 * and the Guild API (src/guild/transport.ts, straight to each guild). */

import { guilds, guildsNow, onGuilds as onDirectory, NO_DIRECTORY, type GuildEntry } from '../guild/directory';
import { guildFetch } from '../guild/transport';

export type { GuildMeta, GuildServices } from '../guild/directory';
/** A directory entry (one shape, one cache: src/guild/directory.ts). */
export type { GuildEntry };

/** Every guild on chain with its guild.json (the directory's 10-minute cache; `fresh` re-reads).
 * Rejects when only the chain's unnamed fallback is in hand: chat needs the guilds' services. */
export async function loadGuilds(fresh = false): Promise<GuildEntry[]> {
  const list = await guilds({ fresh });
  if (list.length && list.every((g) => !g.services && g.error === NO_DIRECTORY)) throw new Error('Could not read the guild directory');
  return list;
}

/** What is known right now (empty until the directory loads once). */
export const knownGuilds = (): GuildEntry[] => guildsNow() ?? [];
export const guildInfo = (id: string | undefined | null) => (id ? guildsNow()?.find((g) => g.id === id) : undefined);
/** Called on every later directory update (not at once, unlike the directory's own onGuilds). */
export function onGuilds(f: () => void): () => void {
  let ready = false;
  const off = onDirectory(() => { if (ready) f(); });
  ready = true;
  return off;
}

/** The Matrix homeserver a guild publishes, if any. */
export const homeserverOf = (id: string | undefined | null) => guildInfo(id)?.services?.matrix ?? null;

export interface GuildEnvelope<T> { success?: boolean; errors?: Record<string, string> | null; data?: T }

/** A Guild API call. Resolves with status and the parsed envelope (never throws on HTTP errors). */
export async function guildApi<T = unknown>(guildId: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: GuildEnvelope<T> | null }> {
  const r = await guildFetch(guildId, path, {
    method: init.method ?? 'GET',
    headers: { accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: GuildEnvelope<T> | null = null;
  try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, body };
}

/** The guild's clock (signatures are checked against it, valid for 10 minutes). */
export async function guildTimestamp(guildId: string): Promise<string> {
  const r = await guildApi<{ unix_timestamp?: number | string }>(guildId, 'timestamp');
  const ts = r.body?.data?.unix_timestamp;
  if (r.status >= 300 || ts == null) throw new Error(`Guild ${guildId} did not tell the time (${r.status})`);
  return String(ts);
}
