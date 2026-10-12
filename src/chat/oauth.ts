/* Chat sign-in with the wallet, behind the scenes: the guild API hands back the Matrix session.
 *
 * A guild's webapp is the identity provider for its homeserver's auth service (MAS). The desktop
 * app walks that sign-in chain itself, with its own cookie jar (structs-universe
 * src-tauri/src/matrix/auth.rs). A web page can't: the chain needs the guild's session cookie and
 * redirects across three sites. So the guild API walks it on its side. The page posts the same
 * wallet-signed login as /api/auth/login and gets Matrix tokens back. No window, no redirect, no cookie.
 *
 *   POST {guild_api}/auth/matrix  { address, pubkey, signature, guild_id, unix_timestamp, device_id }
 *     → { success: true, data: { user_id, device_id, access_token, refresh_token, expires_in,
 *                                  client_id, token_endpoint, revocation_endpoint } }
 *
 * client_id is a public MAS client (no secret): this page refreshes and revokes at MAS itself. */

export const MATRIX_SESSION_PATH = 'auth/matrix';

/** What the guild hands back: the Matrix tokens, and where to refresh and revoke them. */
export interface MatrixGrant {
  access_token: string;
  refresh_token: string | null;
  expires_in: number | null;
  client_id: string;
  token_endpoint: string;
  revocation_endpoint: string | null;
  user_id?: string;
  device_id?: string;
}

export interface SignedLogin { address: string; signature: string; pubkey: string; guild_id: string; unix_timestamp: number | string }

/** A Matrix device id: ten letters and digits, one scope token (as the desktop app makes them). */
export function newDeviceId(): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => A[b % A.length]).join('');
}

/** The request: the guild's own login fields, and this browser's device for the Matrix session. */
export function matrixSessionBody(login: SignedLogin, deviceId: string) {
  return { address: login.address, signature: login.signature, pubkey: login.pubkey, guild_id: login.guild_id, unix_timestamp: login.unix_timestamp, device_id: deviceId };
}

/** The guild's errors, in its own words (`{errors: {key: message}}`). */
export function guildLoginProblem(body: { success?: boolean; errors?: Record<string, string> | unknown[] | null } | null, status: number): string | null {
  if (body?.success === true) return null;
  const e = body?.errors;
  const words = e && !Array.isArray(e) ? Object.values(e).filter((x) => typeof x === 'string').join('; ') : '';
  return words || `The guild refused the chat sign-in (${status})`;
}

const httpsUrl = (u: unknown): u is string => { try { return typeof u === 'string' && new URL(u).protocol === 'https:'; } catch { return false; } };

/** The guild's answer, checked: a refusal in its own words, else tokens with https endpoints. */
export function readGrant(body: unknown, status: number): MatrixGrant {
  const env = body as { success?: boolean; errors?: Record<string, string> | null; data?: Record<string, unknown> | null } | null;
  const refused = guildLoginProblem(env, status);
  if (refused) throw new Error(refused);
  const d = env?.data ?? {};
  if (typeof d.access_token !== 'string' || !d.access_token) throw new Error('The guild answered without a chat token');
  if (typeof d.client_id !== 'string' || !d.client_id || !httpsUrl(d.token_endpoint)) throw new Error('The guild’s chat sign-in left out where to refresh it');
  if (d.revocation_endpoint != null && !httpsUrl(d.revocation_endpoint)) throw new Error('The guild’s chat sign-in names an unsafe sign-out address');
  return {
    access_token: d.access_token,
    refresh_token: typeof d.refresh_token === 'string' ? d.refresh_token : null,
    expires_in: typeof d.expires_in === 'number' ? d.expires_in : null,
    client_id: d.client_id,
    token_endpoint: d.token_endpoint,
    revocation_endpoint: typeof d.revocation_endpoint === 'string' ? d.revocation_endpoint : null,
    user_id: typeof d.user_id === 'string' ? d.user_id : undefined,
    device_id: typeof d.device_id === 'string' ? d.device_id : undefined,
  };
}

/** Ask the guild for the session. Resolves `null` when the guild has no such route (404). */
export async function requestGrant(guildApi: string, login: SignedLogin, deviceId: string, signal: AbortSignal, f: typeof fetch = fetch): Promise<MatrixGrant | null> {
  const r = await f(`${guildApi}/${MATRIX_SESSION_PATH}`, {
    method: 'POST', credentials: 'omit', signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(matrixSessionBody(login, deviceId)),
  });
  if (r.status === 404) return null;
  return readGrant(await r.json().catch(() => null), r.status);
}

/** A guild's API root, the way src/guild/transport.ts reaches it (`…/api`). */
export function guildApiRoot(guildApi: string): string {
  return guildApi.replace(/\/+$/, '').replace(/(\/api)?$/, '/api');
}

/** One signal for a request: the sign-in's Cancel, or `ms` passing, whichever comes first. */
export function within(signal: AbortSignal, ms: number): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any([signal, AbortSignal.timeout(ms)]);
  const c = new AbortController();
  const stop = () => c.abort();
  if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  setTimeout(stop, ms);
  return c.signal;
}
