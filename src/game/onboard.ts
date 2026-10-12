/* Becoming a commander: join a guild (the guild's signer creates your player on chain from a
 * signed request), then claim a planet. Also how replicants are born — the same signup at
 * another HD index.
 *
 * Signup goes through the guild API (POST /api/auth/signup with a signature over
 * `GUILD{guildId}ADDRESS{address}NONCE{proxyNonce}`); the guild's transaction agent then
 * broadcasts MsgGuildMembershipJoinProxy. The new player id appears on chain a block or few later. */
import { wallet } from '../wallet/wallet';
import { txq } from '../wallet/queue';
import { lcd, num } from '../chain/lcd';
import { sleep } from '../core/util';
import { guildFetch } from '../guild/transport';
import { guilds } from '../guild/directory';

export interface GuildEntry {
  id: string;
  chain: { owner: string; joinInfusionMinimum: string; entrySubstationId: string; primaryReactorId: string; endpoint: string };
  meta: { name?: string; tag?: string; description?: string; logo?: string; website?: string; webapp?: string } | null;
  services: { guild_api: string | null; grass: string | null; matrix: string | null } | null;
  error: string | null;
}

/** The guild directory (one cache for the whole client: src/guild/directory.ts). */
export function loadGuilds(): Promise<GuildEntry[]> {
  return guilds() as unknown as Promise<GuildEntry[]>;
}

export async function guildCall<T = unknown>(guildId: string, path: string, init: RequestInit = {}): Promise<{ status: number; success: boolean; data: T; errors: Record<string, string> }> {
  const r = await guildFetch(guildId, path, {
    ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
  });
  let j: { success?: boolean; data?: T; errors?: Record<string, string> } = {};
  try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, success: !!j.success, data: j.data as T, errors: (j.errors && typeof j.errors === 'object' && !Array.isArray(j.errors) ? j.errors : {}) };
}

/** Sign up account `index` with guild `guildId` under `username`; resolves with the new player id. */
export async function joinGuild(index: number, guildId: string, username: string, onStep: (s: string) => void = () => {}): Promise<string> {
  const acct = wallet.account(index);
  if (!acct) throw new Error('No such account');
  onStep('Checking the game');
  const known = await lcd.address(acct.address).catch(() => null);
  if (known?.playerId && known.playerId !== '1-0') { wallet.setAccount(index, { playerId: known.playerId }); return known.playerId; }
  // A fresh address has proxyNonce 0; the chain checks the nonce it holds.
  const message = `GUILD${guildId}ADDRESS${acct.address}NONCE0`;
  const sig = wallet.signMessage(index, message);
  onStep('Asking your guild to let you in');
  const r = await guildCall(guildId, 'auth/signup', {
    method: 'POST',
    body: JSON.stringify({ primary_address: sig.address, signature: sig.signature, pubkey: sig.pubkey, guild_id: guildId, username }),
  });
  if (!(r.status === 202 || r.success || /exist/i.test(Object.values(r.errors).join(' ')))) {
    throw new Error('The guild refused the signup: ' + (Object.values(r.errors).join('; ') || `HTTP ${r.status}`));
  }
  onStep('Your guild is creating your commander');
  for (let i = 0; i < 40; i++) {
    await sleep(i < 5 ? 3000 : 6000);
    const a = await lcd.address(acct.address).catch(() => null);
    if (a?.playerId && a.playerId !== '1-0') {
      wallet.setAccount(index, { playerId: a.playerId });
      onStep(`You are ${a.playerId}`);
      return a.playerId;
    }
  }
  throw new Error('The guild accepted the request but no player appeared in 4 minutes. It may still land — check again soon.');
}

/** Claim a fresh planet (a player with none, or whose planet is spent). */
export function explore(index: number, playerId: string) {
  return txq.enqueue({ typeUrl: '/structs.structs.MsgPlanetExplore', value: { playerId } }, { account: index, playerId, label: 'Explore a new planet', source: 'you' });
}

/** Whether the player's current planet still has ore to take. */
export async function planetSpent(planetId: string): Promise<boolean> {
  if (!planetId) return true;
  // A read failure is "don't know", never "spent": exploring on a hiccup abandons a planet.
  const p = await lcd.planet(planetId).catch(() => undefined);
  if (p === undefined) return false;
  return !p || p.Planet.status === 'complete' || num(p.gridAttributes?.ore) <= 0;
}
