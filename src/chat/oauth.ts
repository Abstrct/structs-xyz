/* Chat sign-in with the wallet, the pure parts: the same chain as the desktop app
 * (structs-universe src-tauri/src/matrix/auth.rs), shaped for a web page.
 *
 *   guild.json services.matrix                 → the homeserver
 *   GET  {hs}/_matrix/client/v1/auth_metadata  → its auth service (MAS): issuer and endpoints
 *   POST {mas}/oauth2/registration             → this site's client id (a public web client, PKCE)
 *   POST {guild_api}/auth/login  (a form, in the sign-in window: the wallet signature, and
 *        `continue` = the MAS authorize URL)  → the guild's session cookie, set on its own site;
 *        then 302 on to MAS, which sees the guild session and comes straight back
 *   GET  {site}/comms-callback.html?code&state → the code, handed to the game tab
 *   POST {mas}/oauth2/token  (code + verifier) → the Matrix access and refresh tokens
 *
 * A page can't keep another site's cookie, so the guild login runs as a top-level form post in a
 * small window rather than as a request from the page: that is the one difference from desktop. */

export interface AuthMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
}

/** The sign-in window's name: the guild's form login is posted into it. */
export const SIGNIN_WINDOW = 'structs-comms-signin';
/** Where the callback page announces the code (and its localStorage fallback key). */
export const CALLBACK_CHANNEL = 'structs-comms-auth';
export const CALLBACK_KEY = 'structs.comms.callback';
/** The callback page: a static file next to the app (public/comms-callback.html). */
export const CALLBACK_FILE = 'comms-callback.html';

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** RFC 7636 S256: the challenge is base64url(sha256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** A Matrix device id: ten letters and digits, one scope token (as the desktop app makes them). */
export function newDeviceId(): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(randomBytes(10), (b) => A[b % A.length]).join('');
}

/** MSC2967's scope for a Matrix client: the whole client API, and this one device. */
export function matrixScope(deviceId: string): string {
  return `urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${deviceId}`;
}

/** This site registered as a public web client: its address, its callback, code + refresh, no secret. */
export function registrationBody(siteUrl: string, redirectUri: string) {
  return {
    client_name: 'Structs Command Deck',
    client_uri: siteUrl,
    application_type: 'web',
    redirect_uris: [redirectUri],
    response_types: ['code'],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
  };
}

/** `prompt: 'login'` makes the auth service sign in again rather than reuse its own session cookie
 * in this browser, which may belong to another commander (the desktop app gets the same from a
 * fresh cookie jar on every run). */
export function authorizeUrl(meta: AuthMeta, o: { clientId: string; redirectUri: string; deviceId: string; state: string; challenge: string; prompt?: string }): string {
  const u = new URL(meta.authorization_endpoint);
  const q = u.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', o.clientId);
  q.set('redirect_uri', o.redirectUri);
  q.set('scope', matrixScope(o.deviceId));
  q.set('state', o.state);
  q.set('code_challenge', o.challenge);
  q.set('code_challenge_method', 'S256');
  q.set('response_mode', 'query');
  if (o.prompt) q.set('prompt', o.prompt);
  return u.href;
}

/** The guild's form login: the signed fields, and where to go once the session is set. */
export function loginForm(login: { address: string; signature: string; pubkey: string; guild_id: string; unix_timestamp: number | string }, continueUrl: string): Record<string, string> {
  return {
    address: login.address, signature: login.signature, pubkey: login.pubkey,
    guild_id: login.guild_id, unix_timestamp: String(login.unix_timestamp),
    continue: continueUrl,
  };
}

/** The callback's answer, checked: the state must be the one this sign-in sent (that is what stops
 * a code we did not ask for from being redeemed as ours). */
export function readCallback(search: string, state: string): { code: string } {
  const q = new URLSearchParams(search);
  if (q.get('state') !== state) throw new Error('The sign-in answer was not for this sign-in');
  const err = q.get('error');
  if (err) throw new Error(err === 'access_denied' ? 'Sign-in was cancelled' : `Sign-in stopped: ${q.get('error_description') || err}`);
  const code = q.get('code');
  if (!code) throw new Error('The sign-in answer carried no code');
  return { code };
}

/** The guild's login errors, in its own words (`{errors: {key: message}}`). */
export function guildLoginProblem(body: { success?: boolean; errors?: Record<string, string> | unknown[] | null } | null, status: number): string | null {
  if (body?.success === true) return null;
  const e = body?.errors;
  const words = e && !Array.isArray(e) ? Object.values(e).filter((x) => typeof x === 'string').join('; ') : '';
  return words || `The guild refused the sign-in (${status})`;
}

/** A guild's API root, the way src/guild/transport.ts reaches it (`…/api`): the form login and its
 * pre-check must post to the same place. */
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

