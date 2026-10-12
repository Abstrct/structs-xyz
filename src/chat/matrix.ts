/* Comms: the Matrix client. One session at a time, for the comms identity — a wallet account,
 * independent of the account the rest of the client acts as (so switching the Command deck to a
 * replicant leaves chat alone). Signed in on the player's guild's homeserver with a wallet
 * signature (./oauth: the desktop app's chain, with the guild login in a small window), or with an
 * access token from another Matrix client; then talking to the homeserver directly (Synapse answers CORS). Long-poll /sync, rooms
 * reduced by ./model, sends with local echo, refresh tokens handled single-flight.
 *
 * The access token lives in localStorage per account. That is the browser's only place
 * for it; it is scoped to chat (MAS device scope), and signing out revokes it. */
import { wallet } from '../wallet/wallet';
import { looksLikePhrase } from '../wallet/keys';
import { store } from '../chain/store';
import { lcd } from '../chain/lcd';
import { safeEach, sleep } from '../core/util';
import { guildApi, guildInfo, guildTimestamp, homeserverOf, loadGuilds } from './guilds';
import { buildLoginRequest, type LoginRequest } from '../guild/api';
import { asset } from '../core/base';
import {
  CALLBACK_CHANNEL, CALLBACK_FILE, CALLBACK_KEY, SIGNIN_WINDOW, authorizeUrl, b64url, guildLoginProblem, loginForm, newDeviceId, pkceChallenge,
  randomBytes, readCallback, registrationBody, type AuthMeta,
} from './oauth';
import {
  editContent, formatWithPills, hostOf, localpart, mentionsMe, messageContent, objectRoomLocal, playerOfUser, safeMediaType, serverOf, slug,
  type Outgoing, type Pill,
} from './format';
import {
  addEcho, addLocal, applyMessages, applySync, emptyState, failEcho, hiddenRoom, newestEvent, settleEcho,
  type ChatState, type Delta, type Msg, type RawEvent, type Room,
} from './model';

/** Why the wallet sign-in can't run yet for the comms identity, in a few words. */
export type WalletBlock = 'enlist' | 'guild' | 'server' | 'loading' | 'locked';
export const WALLET_BLOCK: Record<WalletBlock, string> = {
  enlist: 'Chat opens when you enlist',
  guild: 'Join a guild to open its chat',
  server: 'Your guild runs no chat server yet',
  loading: 'Finding your guild’s chat server…',
  locked: 'Unlock your wallet to sign in',
};

export type CommsState = 'idle' | 'connecting' | 'live' | 'stalled' | 'expired' | 'signedOut';

export interface MatrixSession {
  homeserver: string; user_id: string; device_id: string;
  access_token: string; refresh_token: string | null; expires_at: number | null;
  client_id: string | null; token_endpoint: string | null;
  guildId: string | null;
  /** Wallet address this session belongs to ('guest' for a pasted token without a wallet). */
  account: string;
}

export interface Unread { count: number; mentions: number }

export class MatrixError extends Error {
  constructor(public status: number, public errcode: string, message: string, public retryAfter?: number) { super(message); this.name = 'MatrixError'; }
}
class SessionDead extends Error {}

const SYNC_FILTER = JSON.stringify({ room: { timeline: { limit: 40 } } });
/** The Structs-wide channels every player gets: they live on SN Corp's homeserver. */
export const DEFAULT_SERVER = 'matrix.beta.playstructs.com';
export const DEFAULT_CHANNELS = ['sn-corp', 'help', 'infrastructure'].map((a) => `#${a}:${DEFAULT_SERVER}`);

export const chatroomMessage = (kind: string, id: string, address: string, ts: string) => `CHATROOM${kind}${id}ADDRESS${address}DATETIME${ts}`;

const enc = encodeURIComponent;
const SKEY_PREFIX = 'structs.comms.session.';
const SKEY = (acct: string) => SKEY_PREFIX + acct;
const DEVICE_PREFIX = 'structs.comms.device.';
/** This site's client id at each guild's auth service, per callback address. */
const CLIENT_PREFIX = 'structs.comms.client.';
/** Signed out on purpose: no automatic sign-in for this account until the player asks again. */
const OPTOUT_PREFIX = 'structs.comms.optout.';
/** The account index chat signs in as (absent: the primary account). */
const IDENTITY_KEY = 'structs.comms.identity';
/** Blob URLs kept for thumbnails and downloads; older ones are revoked past this. */
const MEDIA_CAP = 200;
const read = <T>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage refused */ } };

class Comms {
  session: MatrixSession | null = null;
  state: CommsState = 'idle';
  chat: ChatState = emptyState('');
  /** Why the last sign-in or sync failed, for the UI. */
  lastError = '';
  /** The guild the last session used (to re-sign after expiry). */
  lastGuild: string | null = null;

  private started = false;
  private boundAccount = '';
  private gen = 0;
  private loopAbort: AbortController | null = null;
  private wakeNap: (() => void) | null = null;
  private refreshP: Promise<void> | null = null;
  private txnSeq = 0;
  private sendChain: Promise<unknown> = Promise.resolve();
  private outbox = new Map<string, { roomId: string; content: Record<string, unknown> }>();
  private marked = new Map<string, string>();
  private viewing = new Map<string, string | null>();
  private media = new Map<string, Promise<string>>();
  private events = new Map<string, Promise<RawEvent | null>>();
  private unreadLast = '';

  private stateL = new Set<(s: CommsState) => void>();
  private changeL = new Set<(d: Delta | null) => void>();
  private unreadL = new Set<(u: Unread) => void>();
  private msgL = new Set<(roomId: string, m: Msg, why: { mention: boolean; direct: boolean }) => void>();

  /* ── Lifecycle ─────────────────────────────────────────────────────────── */

  /** Resume the comms identity's saved session (no signing). Safe to call often. */
  start() {
    if (this.started) return;
    this.started = true;
    // Sessions from before the identity setting followed the active account: keep the one that exists.
    const act = wallet.active;
    if (read<number | null>(IDENTITY_KEY, null) == null && act && act.index !== this.identityIndex
      && read<MatrixSession | null>(SKEY(act.address), null) && !read<MatrixSession | null>(SKEY(this.identity!.address), null)) write(IDENTITY_KEY, act.index);
    // Only the comms identity matters here: the active account switching is not our business.
    wallet.onChange(() => {
      // The chosen account was removed: back to the primary (and forget the index, which a new account may reuse).
      const i = read<number | null>(IDENTITY_KEY, null);
      if (i != null && wallet.accounts.length && !wallet.account(i)) write(IDENTITY_KEY, null);
      if (this.accountKey() !== this.boundAccount) this.resume();
    });
    window.addEventListener('online', () => this.wakeNap?.());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { this.wakeNap?.(); this.emitUnread(true); } });
    void store.loadCore().catch(() => { /* names fall back to ids */ });
    void loadGuilds().then(() => this.emitChange(null)).catch(() => { /* tags fall back */ });
    this.resume();
  }

  /** The wallet account chat signs in as: the chosen one while it exists, else the primary. */
  get identity() {
    const i = read<number | null>(IDENTITY_KEY, null);
    return (i != null ? wallet.account(i) : null) ?? wallet.primary ?? wallet.accounts[0] ?? null;
  }
  get identityIndex(): number { return this.identity?.index ?? 0; }

  /** Choose the comms identity (the sign-in card's "Sign as"): resumes that account's saved session, if any. */
  setIdentity(index: number) {
    write(IDENTITY_KEY, index);
    if (this.started && this.accountKey() !== this.boundAccount) this.resume();
  }

  private accountKey() { return this.identity?.address ?? 'guest'; }

  private resume() {
    const acct = this.accountKey();
    this.boundAccount = acct;
    this.halt();
    const s = read<MatrixSession | null>(SKEY(acct), null);
    if (s?.access_token && s.homeserver && s.user_id) this.begin(s);
    else { this.session = null; this.chat = emptyState(''); this.setState('signedOut'); this.emitChange(null); }
  }

  private begin(s: MatrixSession) {
    this.session = s;
    this.lastGuild = s.guildId;
    this.chat = emptyState(s.user_id);
    this.marked.clear();
    this.emitChange(null);
    this.run();
  }

  private halt() {
    this.gen++;
    this.loopAbort?.abort();
    this.loopAbort = null;
    this.wakeNap?.();
  }

  private expire(why = 'Your comms session expired') {
    if (!this.session) return;
    this.halt();
    // Another tab may have refreshed and saved a newer grant: only clear what is still ours.
    const stored = read<MatrixSession | null>(SKEY(this.session.account), null);
    if (!stored || stored.access_token === this.session.access_token) write(SKEY(this.session.account), null);
    this.lastGuild = this.session.guildId;
    this.lastError = why;
    this.session = null;
    this.setState('expired');
    this.emitChange(null);
  }

  async signOut() {
    const s = this.session;
    this.halt();
    if (s) {
      write(SKEY(s.account), null);
      // On purpose: opening chat no longer signs this account back in by itself.
      write(OPTOUT_PREFIX + s.account, true);
      void logout(s);
    }
    this.clearLocal();
  }

  /** Forget comms entirely (the vault is being forgotten): every saved session on this browser
   * is signed out (best effort) and erased, with every other comms setting. */
  async forget() {
    this.halt();
    // Every comms key goes: sessions (logged out first), devices, pins, sign-out choices, client ids.
    const keys: string[] = [], other: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(SKEY_PREFIX)) keys.push(k); else if (k?.startsWith('structs.comms.')) other.push(k);
      }
    } catch { /* storage refused */ }
    const live = this.session;
    const all = keys.map((k) => read<MatrixSession | null>(k, null)).filter((x): x is MatrixSession => !!x?.access_token && !!x.homeserver);
    if (live && !all.some((x) => x.access_token === live.access_token)) all.push(live);
    for (const k of [...keys, ...other]) write(k, null);
    write(IDENTITY_KEY, null);
    this.boundAccount = '';
    this.lastGuild = null;
    this.lastError = '';
    this.clearLocal();
    await Promise.all(all.map((x) => logout(x)));
  }

  private clearLocal() {
    for (const p of this.media.values()) void p.then((u) => URL.revokeObjectURL(u)).catch(() => { /* none */ });
    this.media.clear();
    this.events.clear();
    this.session = null;
    this.chat = emptyState('');
    this.setState('signedOut');
    this.emitChange(null);
  }

  /* ── Sign-in ───────────────────────────────────────────────────────────── */

  private firstLive(): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error('The homeserver did not answer the first sync')); }, 60_000);
      const off = this.onState((s) => {
        if (s === 'live') { clearTimeout(t); queueMicrotask(off); resolve(); }
        if (s === 'expired' || s === 'signedOut') { clearTimeout(t); queueMicrotask(off); reject(new Error(this.lastError || 'Signed out')); }
      });
    });
  }

  /** Advanced: a homeserver URL and an access token from another client. */
  async signInWithToken(homeserver: string, token: string) {
    // The token leaves as a Bearer header to whatever server was typed: never let a recovery phrase
    // go that way, whichever screen called (the sign-in card checks too; this is the last gate).
    if (looksLikePhrase(token.trim()) || looksLikePhrase(homeserver.trim()) || /\s/.test(token.trim())) throw new Error('That looks like a recovery phrase, not an access token. It was not sent.');
    let hs = homeserver.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(hs)) hs = 'https://' + hs;
    const r = await fetch(hs + '/_matrix/client/v3/account/whoami', { headers: { authorization: 'Bearer ' + token.trim() } });
    const j = await r.json().catch(() => ({})) as { user_id?: string; device_id?: string; error?: string };
    if (!r.ok || !j.user_id) throw new Error(j.error || `The homeserver refused that token (${r.status})`);
    const acct = this.accountKey();
    const s: MatrixSession = { homeserver: hs, user_id: j.user_id, device_id: j.device_id ?? '', access_token: token.trim(), refresh_token: null, expires_at: null, client_id: null, token_endpoint: null, guildId: null, account: acct };
    write(SKEY(acct), s);
    this.halt();
    this.begin(s);
    await this.firstLive();
  }

  /* ── Wallet sign-in: the player's guild is their home server ─────────────── */

  /** A wallet sign-in in flight (Cancel stops it). */
  private signIn: AbortController | null = null;
  /** Opening chat signs in by itself once per visit; after that it waits for a click. */
  private autoTried = false;
  get signingIn() { return !!this.signIn; }

  /** The comms identity's guild and its chat servers, or why the wallet sign-in can't run yet. */
  walletRoute(): { guildId: string; homeserver: string; guildApi: string } | { block: WalletBlock } {
    const acct = this.identity;
    const pid = acct?.playerId;
    if (!acct || !pid) return { block: 'enlist' };
    const p = store.players.get(pid);
    if (!p) return { block: 'loading' };
    if (!p.guildId) return { block: 'guild' };
    const g = guildInfo(p.guildId);
    if (!g) return { block: 'loading' };
    if (!g.services?.matrix || !g.services.guild_api) return { block: 'server' };
    if (wallet.state !== 'unlocked') return { block: 'locked' };
    return { guildId: p.guildId, homeserver: g.services.matrix, guildApi: g.services.guild_api };
  }

  /** Opening chat (a click) signs in by itself: no session, not signed out on purpose, the wallet
   * ready and the guild running chat, and not already tried this visit. Call it from the click. */
  autoSignIn(): boolean {
    const acct = this.identity;
    if (this.session || this.signIn || this.autoTried || !acct || read<boolean>(OPTOUT_PREFIX + acct.address, false)) return false;
    if ('block' in this.walletRoute()) return false;
    this.autoTried = true;
    void this.signInWithWallet().catch(() => { /* lastError carries it to the sign-in card */ });
    return true;
  }

  cancelSignIn() { this.signIn?.abort(); }

  /** Sign in on the comms identity's guild's homeserver with its wallet. Call from a click: on the
   * published site the guild's login runs in a small window that the click opens (a page can't keep
   * the guild's session cookie itself) and comes back through comms-callback.html. On the dev
   * server, server/dev-relay.mjs runs the same chain instead (auth services refuse localhost). */
  async signInWithWallet(): Promise<void> {
    if (this.signIn) { if (import.meta.env?.DEV !== true) window.open('', SIGNIN_WINDOW)?.focus(); return; }
    const route = this.walletRoute();
    if ('block' in route) throw new Error(WALLET_BLOCK[route.block]);
    const acct = this.identity!;
    // The window opens now, while the click still counts with pop-up blockers; the login is posted into it later.
    const win = import.meta.env?.DEV === true ? null : window.open('', SIGNIN_WINDOW, 'popup,width=480,height=720');
    if (import.meta.env?.DEV !== true && !win) { this.lastError = 'Allow pop-ups for this site to sign in to chat'; this.emitChange(null); throw new Error(this.lastError); }
    if (win) waitingPage(win);
    const ac = new AbortController();
    this.signIn = ac;
    const before = this.state;
    this.lastError = '';
    write(OPTOUT_PREFIX + acct.address, null);
    this.setState('connecting');
    try {
      const deviceId = this.deviceFor(acct.address);
      const login = buildLoginRequest(route.guildId, acct.address, Number(await guildTimestamp(route.guildId)), (m) => wallet.signMessage(acct.index, m));
      const tok = import.meta.env?.DEV === true ? await viaDevRelay(route, deviceId, login, ac.signal) : await this.viaWindow(route, deviceId, login, ac.signal);
      if (ac.signal.aborted) throw new Error('Sign-in cancelled');
      const who = await fetch(route.homeserver + '/_matrix/client/v3/account/whoami', { headers: { authorization: 'Bearer ' + tok.access_token } });
      const wj = await who.json().catch(() => ({})) as { user_id?: string; device_id?: string };
      if (!who.ok || !wj.user_id) throw new Error(`The homeserver did not accept the new sign-in (${who.status})`);
      const s: MatrixSession = {
        homeserver: route.homeserver, user_id: wj.user_id, device_id: wj.device_id ?? deviceId,
        access_token: tok.access_token, refresh_token: tok.refresh_token ?? null, expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
        client_id: tok.client_id, token_endpoint: tok.token_endpoint, guildId: route.guildId, account: acct.address,
      };
      write(SKEY(acct.address), s);
      this.signIn = null;
      this.halt();
      this.begin(s);
      await this.firstLive();
    } catch (e) {
      try { win?.close(); } catch { /* severed */ }
      if (this.signIn === ac) {
        this.lastError = (e as Error).message || 'Sign-in failed';
        this.setState(before === 'expired' ? 'expired' : 'signedOut');
        this.emitChange(null);
      }
      throw e;
    } finally {
      if (this.signIn === ac) this.signIn = null;
    }
  }

  /** The published site's way: the guild's form login in the sign-in window, on to its auth
   * service, and the code back from comms-callback.html, redeemed here with this tab's verifier. */
  private async viaWindow(route: { guildId: string; homeserver: string; guildApi: string }, deviceId: string, login: LoginRequest, signal: AbortSignal): Promise<Tokens> {
    const meta = await authMetadata(route.homeserver);
    const redirect = new URL(asset(CALLBACK_FILE), location.href).href;
    const clientId = await this.clientFor(meta, redirect);
    const verifier = b64url(randomBytes(32)), state = b64url(randomBytes(16));
    const authorize = authorizeUrl(meta, { clientId, redirectUri: redirect, deviceId, state, challenge: await pkceChallenge(verifier) });
    // The guild checks the signature first, so a refusal is said here, not as JSON in the window.
    const pre = await guildApi(route.guildId, 'auth/login', { method: 'POST', body: login });
    const refused = guildLoginProblem(pre.body, pre.status);
    if (refused) throw new Error(refused);
    if (signal.aborted) throw new Error('Sign-in cancelled');
    const answer = waitForCallback(state, signal);
    // The guild's login as a form, in the window: its session cookie on its own site, then on to
    // its auth service, which sees that session and sends the code back to comms-callback.html.
    postForm(SIGNIN_WINDOW, route.guildApi + '/auth/login', loginForm(login, authorize));
    const { code } = readCallback(await answer, state);
    return { ...await redeemCode(meta, clientId, redirect, code, verifier), client_id: clientId, token_endpoint: meta.token_endpoint };
  }

  /** This site's client id at a guild's auth service: registered once, then remembered. */
  private async clientFor(meta: AuthMeta, redirect: string): Promise<string> {
    const key = CLIENT_PREFIX + meta.issuer + '|' + redirect;
    const known = read<string | null>(key, null);
    if (known) return known;
    if (!meta.registration_endpoint) throw new Error('Your guild’s sign-in service takes no new apps');
    const r = await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registrationBody(new URL(asset(''), location.href).href, redirect)) });
    const j = await r.json().catch(() => ({})) as { client_id?: string; error?: string; error_description?: string };
    if (!r.ok || !j.client_id) throw new Error(`Your guild’s sign-in service refused this site (${j.error_description || j.error || r.status})`);
    write(key, j.client_id);
    return j.client_id;
  }

  /** One Matrix device per account on this browser, kept across sign-ins (no device pile-up). */
  private deviceFor(address: string): string {
    const k = DEVICE_PREFIX + address;
    let d = read<string | null>(k, null);
    if (!d) { d = newDeviceId(); write(k, d); }
    return d;
  }

  /* ── HTTP ──────────────────────────────────────────────────────────────── */

  private async refresh(): Promise<void> {
    if (this.refreshP) return this.refreshP;
    const s = this.session;
    const run = async () => {
      if (!s?.refresh_token || !s.token_endpoint || !s.client_id) throw new SessionDead('No refresh token');
      // Refresh tokens rotate. Another tab may already have used ours: adopt what it saved.
      const stored = read<MatrixSession | null>(SKEY(s.account), null);
      if (stored && stored.user_id === s.user_id && stored.refresh_token && stored.refresh_token !== s.refresh_token) {
        Object.assign(s, { access_token: stored.access_token, refresh_token: stored.refresh_token, expires_at: stored.expires_at });
        if (!s.expires_at || s.expires_at - Date.now() > 60_000) return;
      }
      const r = await fetch(s.token_endpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id }).toString(),
      });
      // 4xx: the grant is gone (rotated elsewhere, revoked) — a fresh sign-in is the only way back.
      if (r.status >= 400 && r.status < 500) throw new SessionDead('The auth service refused the refresh');
      if (!r.ok) throw new Error('Refresh failed: ' + r.status);
      const j = await r.json() as { access_token: string; refresh_token?: string; expires_in?: number };
      if (this.session !== s) return;
      s.access_token = j.access_token;
      s.refresh_token = j.refresh_token ?? s.refresh_token;
      s.expires_at = j.expires_in ? Date.now() + j.expires_in * 1000 : null;
      write(SKEY(s.account), s);
    };
    const locks = (navigator as Navigator & { locks?: { request: (name: string, f: () => Promise<void>) => Promise<void> } }).locks;
    this.refreshP = (locks ? locks.request('structs-comms-refresh', run) : run()).finally(() => { this.refreshP = null; });
    return this.refreshP;
  }

  private async freshToken() {
    const s = this.session;
    if (!s?.expires_at || !s.refresh_token || s.expires_at - Date.now() > 60_000) return;
    try { await this.refresh(); } catch (e) { if (e instanceof SessionDead) { this.expire(); throw e; } /* transient: try the old one */ }
  }

  /** A client-server API call with the session's token. Refreshes on M_UNKNOWN_TOKEN once; waits out short rate limits once. */
  async api<T = any>(method: string, path: string, o: { query?: Record<string, string | number | string[] | undefined | null>; body?: unknown; timeout?: number; signal?: AbortSignal; retry?: boolean; prefix?: string } = {}): Promise<T> {
    const s = this.session;
    if (!s) throw new MatrixError(0, 'M_NOT_SIGNED_IN', 'Not signed in to comms');
    await this.freshToken();
    const url = new URL(s.homeserver + (o.prefix ?? '/_matrix/client') + path);
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v == null) continue;
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, x); else url.searchParams.set(k, String(v));
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), o.timeout ?? 15_000);
    const fwd = () => ctl.abort();
    o.signal?.addEventListener('abort', fwd);
    let res: Response;
    try {
      res = await fetch(url, {
        method, signal: ctl.signal,
        headers: { authorization: 'Bearer ' + s.access_token, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      throw new MatrixError(0, 'M_NETWORK', ctl.signal.aborted ? 'The homeserver did not answer in time' : 'Could not reach the homeserver');
    } finally { clearTimeout(t); o.signal?.removeEventListener('abort', fwd); }
    if (res.ok) return await res.json().catch(() => ({})) as T;
    const err = await res.json().catch(() => ({})) as { errcode?: string; error?: string; retry_after_ms?: number };
    const e = new MatrixError(res.status, err.errcode ?? 'M_UNKNOWN', err.error ?? `HTTP ${res.status}`, err.retry_after_ms);
    if (res.status === 401 && e.errcode === 'M_UNKNOWN_TOKEN' && o.retry !== false && this.session === s) {
      if (!s.refresh_token) { this.expire(); throw e; }
      try { await this.refresh(); } catch (x) {
        if (x instanceof SessionDead) { this.expire(); throw e; }
        // The auth service hiccuped: back off and try again, the session may well be fine.
        throw new MatrixError(0, 'M_NETWORK', 'Could not refresh the session: ' + String((x as Error).message || x));
      }
      return this.api<T>(method, path, { ...o, retry: false });
    }
    if (res.status === 429 && o.retry !== false && (e.retryAfter ?? 1000) <= 5000) {
      await sleep(e.retryAfter ?? 1000);
      return this.api<T>(method, path, { ...o, retry: false });
    }
    throw e;
  }

  /* ── Sync loop ─────────────────────────────────────────────────────────── */

  private run() {
    const gen = ++this.gen;
    const ctl = new AbortController();
    this.loopAbort = ctl;
    this.setState('connecting');
    void (async () => {
      let backoff = 2000, fails = 0, first = !this.chat.nextBatch;
      while (gen === this.gen && this.session) {
        try {
          const res = await this.api('GET', '/v3/sync', { query: { timeout: first ? 0 : 30_000, filter: SYNC_FILTER, since: this.chat.nextBatch }, timeout: first ? 90_000 : 45_000, signal: ctl.signal });
          if (gen !== this.gen) return;
          const d = applySync(this.chat, res, first);
          fails = 0; backoff = 2000;
          this.setState('live');
          this.emitChange(d);
          this.announce(d);
          if (first) { first = false; void this.afterFirstSync(); }
        } catch (e) {
          if (gen !== this.gen) return;
          const me = e as MatrixError;
          if (me.status === 401 || me.errcode === 'M_UNKNOWN_TOKEN') { this.expire(); return; }
          if (e instanceof SessionDead) return;
          this.lastError = String(me.message || e);
          if (++fails >= 2) this.setState('stalled');
          await this.nap(backoff);
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    })();
  }

  private nap(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this.wakeNap = () => { this.wakeNap = null; done(); };
    });
  }

  /** Retry a stalled sync now. */
  reconnect() { this.wakeNap?.(); }

  private async afterFirstSync() {
    await this.joinDefaults().catch((e) => console.warn('[comms] default channels', e));
  }

  /** The Structs-wide channels and the guild's lobby: joined once (a leave sticks), failures retried daily. */
  private async joinDefaults() {
    const me = this.me;
    // A pasted token is someone's existing Matrix account: never join rooms on it unasked.
    if (!me || !this.session?.client_id) return;
    const key = 'structs.comms.defaults.' + me;
    const memo = read<Record<string, { joined: boolean; next?: number; error?: string }>>(key, {});
    const want = [...DEFAULT_CHANNELS];
    const lobby = this.guildLobby();
    if (lobby) want.unshift(lobby);
    for (const alias of want) {
      const rec = memo[alias];
      if (rec?.joined || (rec?.next && rec.next > Date.now())) continue;
      if (this.roomByAlias(alias)) { memo[alias] = { joined: true }; continue; }
      try { await this.join(alias); memo[alias] = { joined: true }; } catch (e) { memo[alias] = { joined: false, next: Date.now() + 86_400_000, error: String((e as Error).message) }; }
      if (this.me !== me) return;
      write(key, memo);
    }
    write(key, memo);
  }

  /** `#<guild-name-slug>:<own server>` — the guild's lobby channel by convention. */
  guildLobby(): string | null {
    const g = this.session?.guildId ?? this.myGuildId();
    const name = guildInfo(g)?.meta?.name;
    return name && this.server ? `#${slug(name)}:${this.server}` : null;
  }

  /* ── Events out ────────────────────────────────────────────────────────── */

  onState(f: (s: CommsState) => void) { this.stateL.add(f); f(this.state); return () => { this.stateL.delete(f); }; }
  onChange(f: (d: Delta | null) => void) { this.changeL.add(f); return () => { this.changeL.delete(f); }; }
  /** Unread totals for a badge: `count` messages, `mentions` that call for you (mentions, DMs, invites). */
  onUnread(f: (u: Unread) => void) { this.unreadL.add(f); f(this.unread()); return () => { this.unreadL.delete(f); }; }
  /** Every new message from someone else, as it arrives (not history). */
  onMessage(f: (roomId: string, m: Msg, why: { mention: boolean; direct: boolean }) => void) { this.msgL.add(f); return () => { this.msgL.delete(f); }; }

  private setState(s: CommsState) {
    if (this.state === s) return;
    this.state = s;
    safeEach(this.stateL, (f) => f(s));
  }

  emitChange(d: Delta | null) {
    safeEach(this.changeL, (f) => f(d));
    this.emitUnread();
  }

  private emitUnread(force = false) {
    const u = this.unread();
    const k = u.count + '/' + u.mentions;
    if (!force && k === this.unreadLast) return;
    this.unreadLast = k;
    safeEach(this.unreadL, (f) => f(u));
  }

  unread(): Unread {
    let count = 0, mentions = 0;
    for (const r of this.chat.rooms.values()) {
      if (hiddenRoom(r)) continue;
      if (r.membership === 'invite') { mentions++; count++; continue; }
      if (this.chat.muted.has(r.id) || this.isViewing(r.id)) continue;
      count += r.unread;
      mentions += r.isDirect ? r.unread : r.highlights;
    }
    return { count, mentions };
  }

  private announce(d: Delta) {
    if (!d.fresh.length) return;
    const names = this.myNames();
    for (const { roomId, msg } of d.fresh) {
      const r = this.chat.rooms.get(roomId);
      if (!r || hiddenRoom(r) || msg.kind === 'system' || msg.kind === 'redacted') continue;
      const mention = mentionsMe(msg.body, msg.mentions, this.me, names);
      safeEach(this.msgL, (f) => f(roomId, msg, { mention, direct: r.isDirect }));
    }
  }

  /** Panels say which room they show (null: open, no room; undefined: closed). A viewed room makes no alert. */
  setViewing(panel: string, roomId: string | null | undefined) {
    if (roomId === undefined) this.viewing.delete(panel); else this.viewing.set(panel, roomId);
    this.emitUnread();
  }
  isViewing(roomId: string) {
    if (typeof document !== 'undefined' && document.hidden) return false;
    for (const v of this.viewing.values()) if (v === roomId) return true;
    return false;
  }
  get anyPanelOpen() { return this.viewing.size > 0; }

  /* ── Identity ──────────────────────────────────────────────────────────── */

  get me() { return this.chat.me || this.session?.user_id || ''; }
  get server() { return this.session ? serverOf(this.session.user_id) : ''; }
  get myPlayerId() { return playerOfUser(this.me); }
  myGuildId(): string | null { const p = this.myPlayerId; return (p && store.players.get(p)?.guildId) || this.session?.guildId || null; }
  myNames(): string[] { const p = this.myPlayerId; const n = p ? store.players.get(p)?.name : ''; return n ? [n] : []; }

  private playerNames: Set<string> | null = null;
  private playerNamesSize = -1;
  /** A display name for a Matrix user: the chain's name for players, else their Matrix name
   * (flagged with the real id when it borrows a player's name). */
  nameOf(userId: string, room?: Room | null): string {
    const pid = playerOfUser(userId);
    if (pid) return store.players.get(pid)?.name || pid;
    const dn = room?.members.get(userId)?.displayName ?? this.anyDisplayName(userId);
    if (!dn) return localpart(userId);
    if (this.playerNamesSize !== store.players.size) {
      this.playerNames = new Set([...store.players.values()].map((p) => (p.name || '').toLowerCase()).filter(Boolean));
      this.playerNamesSize = store.players.size;
    }
    return this.playerNames!.has(dn.toLowerCase()) ? `${dn} (${localpart(userId)})` : dn;
  }
  private anyDisplayName(userId: string) {
    for (const r of this.chat.rooms.values()) { const m = r.members.get(userId); if (m?.displayName) return m.displayName; }
    return undefined;
  }
  guildOf(userId: string): string | null { const pid = playerOfUser(userId); return (pid && store.players.get(pid)?.guildId) || null; }
  guildTag(guildId: string | null): string | null {
    if (!guildId) return null;
    return guildInfo(guildId)?.meta?.tag || store.guildTag(guildId);
  }

  /** The Matrix id for a player: `@<playerId>:<their guild's homeserver host>`. */
  userIdForPlayer(playerId: string): string | null {
    const g = store.players.get(playerId)?.guildId;
    const hs = homeserverOf(g);
    return hs ? `@${playerId}:${hostOf(hs)}` : null;
  }

  /** Mention candidates: room members first, then every named player with a homeserver. */
  mentionCandidates(room: Room | null): Pill[] {
    const out: Pill[] = [];
    const seen = new Set<string>();
    if (room) for (const m of room.members.values()) {
      if (m.membership !== 'join' || seen.has(m.userId)) continue;
      seen.add(m.userId);
      out.push({ name: this.nameOf(m.userId, room), userId: m.userId });
      const pid = playerOfUser(m.userId);
      if (pid) out.push({ name: pid, userId: m.userId });
    }
    return out;
  }

  /* ── Rooms ─────────────────────────────────────────────────────────────── */

  room(id: string) { return this.chat.rooms.get(id) ?? null; }
  roomByAlias(alias: string): Room | null {
    for (const r of this.chat.rooms.values()) if (r.alias === alias || r.altAliases.includes(alias)) return r;
    return null;
  }

  /** Resolves when a room id shows up through sync (joins and creates land there). */
  private waitRoom(id: string, ms = 12_000): Promise<void> {
    if (this.chat.rooms.get(id)?.membership === 'join') return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { off(); resolve(); }, ms);
      const off = this.onChange(() => { if (this.chat.rooms.get(id)?.membership === 'join') { clearTimeout(t); queueMicrotask(off); resolve(); } });
    });
  }

  async join(idOrAlias: string, via: string[] = []): Promise<string> {
    const known = idOrAlias.startsWith('#') ? this.roomByAlias(idOrAlias) : this.room(idOrAlias);
    if (known?.membership === 'join') return known.id;
    const servers = via.length ? via : idOrAlias.startsWith('!') ? [] : [serverOf(idOrAlias)].filter(Boolean);
    // Federated joins to big rooms can take a while.
    const r = await this.api<{ room_id: string }>('POST', '/v3/join/' + enc(idOrAlias), { query: { server_name: servers.length ? servers : undefined }, body: {}, timeout: 120_000 });
    await this.waitRoom(r.room_id);
    return r.room_id;
  }

  async leave(roomId: string) {
    await this.api('POST', `/v3/rooms/${enc(roomId)}/leave`, { body: {} });
    if (this.chat.rooms.delete(roomId)) this.emitChange(null);
  }

  /** A direct channel with a user: reuse a joined unencrypted one from m.direct, else create it. */
  async createDM(userId: string): Promise<string> {
    if (userId === this.me) throw new Error('That is you');
    const known = Array.isArray(this.chat.direct[userId]) ? this.chat.direct[userId] : [];
    for (const id of known) {
      const r = this.chat.rooms.get(id);
      if (r?.membership === 'join' && !r.encrypted) return id;
    }
    const res = await this.api<{ room_id: string }>('POST', '/v3/createRoom', { body: { is_direct: true, preset: 'trusted_private_chat', invite: [userId] } });
    const next = { ...this.chat.direct, [userId]: [...known, res.room_id] };
    this.chat.direct = next;
    await this.api('PUT', `/v3/user/${enc(this.me)}/account_data/m.direct`, { body: next }).catch((e) => console.warn('[comms] m.direct', e));
    await this.waitRoom(res.room_id);
    const r = this.chat.rooms.get(res.room_id);
    if (r) { r.isDirect = true; r.rev++; }
    return res.room_id;
  }

  async dmPlayer(playerId: string): Promise<string> {
    await loadGuilds().catch(() => { /* checked below */ });
    const uid = this.userIdForPlayer(playerId);
    if (!uid) throw new Error(`${store.playerName(playerId)}'s guild runs no comms server`);
    return this.createDM(uid);
  }

  async setTopic(roomId: string, topic: string) {
    await this.api('PUT', `/v3/rooms/${enc(roomId)}/state/m.room.topic/`, { body: { topic } });
  }

  async setPinnedEvent(roomId: string, eventId: string, on: boolean) {
    const cur = await this.api<{ pinned?: string[] }>('GET', `/v3/rooms/${enc(roomId)}/state/m.room.pinned_events/`).catch(() => ({ pinned: [] as string[] }));
    const list = (cur.pinned ?? []).filter((x) => x !== eventId);
    if (on) list.unshift(eventId);
    await this.api('PUT', `/v3/rooms/${enc(roomId)}/state/m.room.pinned_events/`, { body: { pinned: list } });
  }

  async setMuted(roomId: string, on: boolean) {
    if (on) await this.api('PUT', `/v3/pushrules/global/room/${enc(roomId)}`, { body: { actions: [] } });
    else await this.api('DELETE', `/v3/pushrules/global/room/${enc(roomId)}`).catch((e) => { if ((e as MatrixError).status !== 404) throw e; });
    if (on) this.chat.muted.add(roomId); else this.chat.muted.delete(roomId);
    this.emitChange(null);
  }

  /** Channels pinned to the top of the list, as the desktop app does (structs-universe matrix/pins.rs):
   * the three Structs-wide channels for every player, in their order, until the player unpins one;
   * then whatever the player pinned, in the order they pinned it. Nothing else is pinned for them,
   * the guild lobby included. Kept per Matrix id in this browser. */
  private pinsKey() { return 'structs.comms.pins.' + this.me; }
  private pinsRec() { return read<{ pinned: string[]; unpinned: string[] }>(this.pinsKey(), { pinned: [], unpinned: [] }); }
  isPinned(r: Room): boolean { return this.pinOrder(r) < 999; }
  /** The room's place in the Pinned group (999: not pinned). The defaults rank by their own order
   * (whole alias, SN Corp's server: never a look-alike name), the player's pins after them. */
  pinOrder(r: Room): number {
    const p = this.pinsRec();
    const own = p.pinned.indexOf(r.id);
    if (own >= 0) return DEFAULT_CHANNELS.length + own;
    if (p.unpinned.includes(r.id)) return 999;
    const d = r.alias ? DEFAULT_CHANNELS.indexOf(r.alias) : -1;
    return d >= 0 ? d : 999;
  }
  setPinned(roomId: string, on: boolean) {
    const p = this.pinsRec();
    const r = this.room(roomId);
    // A default goes back to its own place when pinned again; only the player's own pins queue up.
    const isDefault = !!r?.alias && DEFAULT_CHANNELS.includes(r.alias);
    p.pinned = p.pinned.filter((x) => x !== roomId);
    p.unpinned = p.unpinned.filter((x) => x !== roomId);
    if (on && !isDefault) p.pinned.push(roomId);
    if (!on && isDefault) p.unpinned.push(roomId);
    write(this.pinsKey(), p);
    if (r) r.rev++;
    this.emitChange(null);
  }

  /* ── History ───────────────────────────────────────────────────────────── */

  private paging = new Map<string, Promise<number>>();
  /** Older messages for a room. Resolves with how many rows arrived (0 at the beginning). */
  paginate(roomId: string, limit = 40): Promise<number> {
    const r = this.room(roomId);
    if (!r || r.reachedStart || !r.prevBatch) return Promise.resolve(0);
    const busy = this.paging.get(roomId);
    if (busy) return busy;
    const from = r.prevBatch;
    const p = this.api('GET', `/v3/rooms/${enc(roomId)}/messages`, { query: { dir: 'b', limit, from } })
      .then((res) => {
        // A gap sync reset the room meanwhile: this page belongs to history that is no longer shown.
        const now = this.room(roomId);
        if (!now || now.prevBatch !== from) return 0;
        const n = applyMessages(this.chat, roomId, res);
        this.emitChange(null);
        return n;
      })
      .finally(() => this.paging.delete(roomId));
    this.paging.set(roomId, p);
    return p;
  }
  isPaging(roomId: string) { return this.paging.has(roomId); }

  /** One event (a reply's parent, a pinned message) — cached. */
  fetchEvent(roomId: string, eventId: string): Promise<RawEvent | null> {
    const k = roomId + '|' + eventId;
    let p = this.events.get(k);
    if (!p) {
      p = this.api<RawEvent>('GET', `/v3/rooms/${enc(roomId)}/event/${enc(eventId)}`).catch((e) => {
        if ((e as MatrixError).status === 0) this.events.delete(k);   // offline: try again next time
        return null;
      });
      this.events.set(k, p);
    }
    return p;
  }

  /** Full member list (sync's state can be partial after a gap). */
  async loadMembers(roomId: string) {
    const res = await this.api<{ chunk?: RawEvent[] }>('GET', `/v3/rooms/${enc(roomId)}/members`, { query: { membership: 'join' } });
    const r = this.room(roomId);
    if (!r) return;
    for (const ev of res.chunk ?? []) if (ev.state_key) r.members.set(ev.state_key, { userId: ev.state_key, membership: ev.content?.membership ?? 'join', displayName: ev.content?.displayname, avatar: ev.content?.avatar_url });
    r.rev++;
    this.emitChange(null);
  }

  /* ── Sending ───────────────────────────────────────────────────────────── */

  private txn() { return `sx${Date.now().toString(36)}${(++this.txnSeq).toString(36)}`; }

  /** Send a message with local echo. Sends are serialized so they land in the order typed. */
  send(roomId: string, o: Outgoing): Promise<void> {
    const r = this.room(roomId);
    if (!r) return Promise.reject(new Error('Not in that channel'));
    const content = messageContent(o);
    const txn = this.txn();
    addEcho(r, this.me, txn, content);
    this.outbox.set(txn, { roomId, content });
    this.emitChange(null);
    return this.transmit(r, txn);
  }

  private transmit(r: Room, txn: string): Promise<void> {
    const job = this.outbox.get(txn)!;
    const p = this.sendChain.then(() => this.api<{ event_id: string }>('PUT', `/v3/rooms/${enc(job.roomId)}/send/m.room.message/${txn}`, { body: job.content, timeout: 30_000 }))
      .then((res) => { const now = this.room(job.roomId) ?? r; settleEcho(now, txn, res.event_id); this.outbox.delete(txn); this.marked.delete(r.id); })
      .catch((e) => { failEcho(this.room(job.roomId) ?? r, txn, String((e as Error).message || e)); throw e; })
      .finally(() => this.emitChange(null));
    this.sendChain = p.catch(() => { /* the next send goes anyway */ });
    return p;
  }

  /** Try a failed send again (same transaction id: the server de-duplicates). */
  retry(roomId: string, msgId: string) {
    const r = this.room(roomId);
    const m = r?.byId.get(msgId);
    if (!r || !m?.txnId || !this.outbox.has(m.txnId)) return;
    m.failed = undefined; m.pending = true; m.rev++;
    this.emitChange(null);
    void this.transmit(r, m.txnId).catch(() => { /* marked failed again */ });
  }
  discard(roomId: string, msgId: string) {
    const r = this.room(roomId);
    const m = r?.byId.get(msgId);
    if (!r || !m) return;
    r.timeline.splice(r.timeline.indexOf(m), 1);
    r.byId.delete(msgId);
    if (m.txnId) this.outbox.delete(m.txnId);
    r.rev++;
    this.emitChange(null);
  }

  async edit(roomId: string, eventId: string, o: Outgoing) {
    const r = this.room(roomId);
    const m = r?.byId.get(eventId);
    const was = m && { body: m.body, html: m.html, edited: m.edited };
    if (m) {
      // Show it at once; the server's copy of the edit replaces this when it arrives.
      m.body = o.body; m.html = formatWithPills(o.body, o.mentions ?? []) ?? undefined; m.edited = true; m.rev++;
      this.emitChange(null);
    }
    try {
      await this.api('PUT', `/v3/rooms/${enc(roomId)}/send/m.room.message/${this.txn()}`, { body: editContent(eventId, o) });
    } catch (e) {
      if (m && was) { Object.assign(m, was); m.rev++; this.emitChange(null); }
      throw e;
    }
  }

  async redact(roomId: string, eventId: string, reason?: string) {
    await this.api('PUT', `/v3/rooms/${enc(roomId)}/redact/${enc(eventId)}/${this.txn()}`, { body: reason ? { reason } : {} });
  }

  async react(roomId: string, eventId: string, key: string) {
    const r = this.room(roomId);
    if (r?.reactions.get(eventId)?.get(key)?.has(this.me)) return;
    await this.api('PUT', `/v3/rooms/${enc(roomId)}/send/m.reaction/${this.txn()}`, { body: { 'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key } } });
  }
  async unreact(roomId: string, eventId: string, key: string) {
    const ann = this.room(roomId)?.reactions.get(eventId)?.get(key)?.get(this.me);
    if (ann) await this.redact(roomId, ann);
  }
  toggleReaction(roomId: string, eventId: string, key: string) {
    const mine = this.room(roomId)?.reactions.get(eventId)?.get(key)?.has(this.me);
    return mine ? this.unreact(roomId, eventId, key) : this.react(roomId, eventId, key);
  }

  private typingAt = new Map<string, number>();
  /** Typing notices: on at most every 8 s while typing, off when stopped. */
  typing(roomId: string, on: boolean) {
    if (!this.session) return;
    const last = this.typingAt.get(roomId) ?? 0;
    if (on && Date.now() - last < 8000) return;
    if (!on && !last) return;
    this.typingAt.set(roomId, on ? Date.now() : 0);
    void this.api('PUT', `/v3/rooms/${enc(roomId)}/typing/${enc(this.me)}`, { body: on ? { typing: true, timeout: 20_000 } : { typing: false } }).catch(() => { /* cosmetic */ });
  }

  /** Read up to the newest event (once per newest event). */
  markRead(roomId: string) {
    const r = this.room(roomId);
    const m = r && newestEvent(r);
    if (!r || !m) return;
    const had = r.unread || r.highlights;
    r.unread = 0; r.highlights = 0;
    if (had) { r.rev++; this.emitChange(null); }
    if (this.marked.get(roomId) === m.id) return;
    this.marked.set(roomId, m.id);
    r.receipts.set(this.me, { eventId: m.id, ts: Date.now() });
    void this.api('POST', `/v3/rooms/${enc(roomId)}/read_markers`, { body: { 'm.fully_read': m.id, 'm.read': m.id } }).catch(() => { this.marked.delete(roomId); });
  }

  /** A card only this client shows (help, whois, errors from commands). */
  local(roomId: string, kind: string, data: unknown, body = '') {
    const r = this.room(roomId);
    if (!r) return;
    addLocal(r, this.me, kind, data, body);
    this.emitChange(null);
  }

  /* ── Discovery ─────────────────────────────────────────────────────────── */

  async publicRooms(o: { server?: string; term?: string; since?: string; limit?: number } = {}) {
    const query = { server: o.server && o.server !== this.server ? o.server : undefined };
    type Chunk = { room_id: string; name?: string; topic?: string; canonical_alias?: string; num_joined_members: number; avatar_url?: string; join_rule?: string; room_type?: string };
    if (o.term) return this.api<{ chunk: Chunk[]; next_batch?: string; total_room_count_estimate?: number }>('POST', '/v3/publicRooms', { query, body: { limit: o.limit ?? 60, since: o.since, filter: { generic_search_term: o.term } } });
    return this.api<{ chunk: Chunk[]; next_batch?: string; total_room_count_estimate?: number }>('GET', '/v3/publicRooms', { query: { ...query, limit: o.limit ?? 100, since: o.since } });
  }

  resolveAlias(alias: string) { return this.api<{ room_id: string; servers: string[] }>('GET', '/v3/directory/room/' + enc(alias)); }

  async search(term: string, roomId?: string, nextBatch?: string) {
    const res = await this.api<any>('POST', '/v3/search', {
      query: { next_batch: nextBatch },
      body: { search_categories: { room_events: { search_term: term, keys: ['content.body'], order_by: 'recent', event_context: { before_limit: 0, after_limit: 0 }, filter: { ...(roomId ? { rooms: [roomId] } : {}), limit: 30 } } } },
      timeout: 30_000,
    });
    const re = res?.search_categories?.room_events ?? {};
    return { count: Number(re.count ?? 0), next: re.next_batch as string | undefined, results: (re.results ?? []).map((x: { result: RawEvent }) => x.result).filter((e: RawEvent) => e?.event_id) as RawEvent[] };
  }

  /* ── Media ─────────────────────────────────────────────────────────────── */

  /** An authenticated thumbnail as a blob URL (media needs the Bearer token, so <img src> can't fetch it). */
  thumbnail(mxc: string, w = 480, h = 360): Promise<string> {
    const k = `${mxc}|${w}x${h}`;
    let p = this.media.get(k);
    if (p) { this.media.delete(k); this.media.set(k, p); return p; }
    const s = this.session;
    const m = /^mxc:\/\/([^/]+)\/([A-Za-z0-9_-]+)$/.exec(mxc);
    if (!s || !m) return Promise.reject(new Error('bad media'));
    p = (async () => {
      const q = `width=${w}&height=${h}&method=scale`;
      let r = await fetch(`${s.homeserver}/_matrix/client/v1/media/thumbnail/${enc(m[1])}/${enc(m[2])}?${q}`, { headers: { authorization: 'Bearer ' + s.access_token } });
      if (r.status === 404 || r.status === 400) r = await fetch(`${s.homeserver}/_matrix/media/v3/thumbnail/${enc(m[1])}/${enc(m[2])}?${q}`);
      if (!r.ok) throw new Error('media ' + r.status);
      return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: safeMediaType(r.headers.get('content-type')) }));
    })();
    this.remember(k, p);
    return p;
  }

  /** The whole file behind an mxc:// URI, as a blob URL (for downloads and full-size images). */
  download(mxc: string): Promise<string> {
    const k = mxc + '|full';
    let p = this.media.get(k);
    if (p) { this.media.delete(k); this.media.set(k, p); return p; }
    const s = this.session;
    const m = /^mxc:\/\/([^/]+)\/([A-Za-z0-9_-]+)$/.exec(mxc);
    if (!s || !m) return Promise.reject(new Error('bad media'));
    p = fetch(`${s.homeserver}/_matrix/client/v1/media/download/${enc(m[1])}/${enc(m[2])}`, { headers: { authorization: 'Bearer ' + s.access_token } })
      // Re-typed as opaque bytes: a same-origin blob must never render as HTML in the app's origin.
      .then(async (r) => { if (!r.ok) throw new Error('media ' + r.status); return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: 'application/octet-stream' })); });
    this.remember(k, p);
    return p;
  }

  /** Media cache with least-recently-used revocation: a long session must not pin every image ever shown. */
  private remember(k: string, p: Promise<string>) {
    p.catch(() => { if (this.media.get(k) === p) this.media.delete(k); });
    this.media.set(k, p);
    for (const [old, q] of this.media) {
      if (this.media.size <= MEDIA_CAP) break;
      this.media.delete(old);
      void q.then((u) => URL.revokeObjectURL(u)).catch(() => { /* failed: nothing to revoke */ });
    }
  }

  /* ── Planet and fleet channels ─────────────────────────────────────────── */

  /** The channel of a planet or fleet, hosted by its owner's guild: resolve the alias, join;
   * if the room does not exist yet, ask the owner's guild to create it (a signed request). */
  async openObjectRoom(objectId: string): Promise<string> {
    const o = objectRoomLocal(objectId);
    if (!o) throw new Error('Only planets (2-…) and fleets (9-…) have channels');
    await Promise.all([store.loadCore().catch(() => { /* lookups below */ }), loadGuilds()]);
    let owner = o.kind === 'planet' ? store.planets.get(objectId)?.owner : store.fleets.get(objectId)?.owner;
    if (!owner) owner = o.kind === 'planet' ? (await lcd.planet(objectId) as unknown as { Planet: { owner: string } }).Planet.owner : (await lcd.fleet(objectId)).owner;
    const guildId = owner ? store.players.get(owner)?.guildId : undefined;
    const hs = homeserverOf(guildId);
    if (!guildId || !hs) throw new Error(`${objectId}'s owner's guild runs no comms server`);
    const alias = `#${o.local}:${hostOf(hs)}`;
    const known = this.roomByAlias(alias);
    if (known) return known.id;
    try {
      const r = await this.resolveAlias(alias);
      return await this.join(r.room_id, r.servers);
    } catch (e) {
      if ((e as MatrixError).status !== 404) throw e;
    }
    const made = await this.ensureObjectRoom(guildId, o.kind, objectId);
    return this.join(made.room_id, made.server_name ? [made.server_name] : []);
  }

  /** POST {guild_api}/chat/room/ensure, signed `CHATROOM{kind}{id}ADDRESS…DATETIME…`. */
  private async ensureObjectRoom(guildId: string, kind: string, id: string, hop = 0): Promise<{ room_id: string; server_name?: string }> {
    const acct = (this.session && wallet.byAddress(this.session.account)) || this.identity;
    if (!acct) throw new Error('Opening a new channel needs your wallet');
    const ts = await guildTimestamp(guildId);
    const sig = wallet.signMessage(acct.index, chatroomMessage(kind, id, acct.address, ts));
    const r = await guildApi<{ room_id?: string; server_name?: string; owner_guild_id?: string }>(guildId, 'chat/room/ensure', {
      method: 'POST', body: { kind, id, address: sig.address, pubkey: sig.pubkey, signature: sig.signature, unix_timestamp: /^\d+$/.test(ts) ? Number(ts) : ts },
    });
    const d = r.body?.data;
    if ((r.status === 200 || r.status === 201) && d?.room_id) return { room_id: d.room_id, server_name: d.server_name };
    if (r.status === 409 && d?.owner_guild_id && hop === 0) return this.ensureObjectRoom(d.owner_guild_id, kind, id, 1);
    if (r.status === 401 && hop === 0) return this.ensureObjectRoom(guildId, kind, id, 1);
    if (r.status === 404) throw new Error(`${id} no longer exists`);
    throw new Error(Object.values(r.body?.errors ?? {}).join('; ') || `The guild could not open that channel (${r.status})`);
  }
}

/** Best effort: tell the server the device is gone, so the token dies with it. */
/* ── Wallet sign-in helpers ───────────────────────────────────────────────── */

/* On the dev server (localhost) the sign-in goes through server/dev-relay.mjs; a build never does.
 * The check is written out where it is used (`import.meta.env?.DEV === true`): a build replaces it
 * with false in place, so the relay call and its branches drop out of the bundle entirely. */
interface Tokens { access_token: string; refresh_token?: string | null; expires_in?: number | null; client_id: string; token_endpoint: string }

async function viaDevRelay(route: { homeserver: string; guildApi: string }, deviceId: string, login: LoginRequest, signal: AbortSignal): Promise<Tokens> {
  const r = await fetch('/__dev/comms/signin', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ homeserver: route.homeserver, guildApi: route.guildApi, deviceId, login }) });
  const j = await r.json().catch(() => ({})) as Partial<Tokens> & { error?: string };
  if (!r.ok || !j.access_token || !j.client_id || !j.token_endpoint) throw new Error(j.error || `The dev relay could not sign in (${r.status})`);
  return j as Tokens;
}

/** The homeserver's auth service (MAS): the stable path, then MSC2965's. */
async function authMetadata(hs: string): Promise<AuthMeta> {
  let last = '';
  for (const p of ['/_matrix/client/v1/auth_metadata', '/_matrix/client/unstable/org.matrix.msc2965/auth_metadata']) {
    try {
      const r = await fetch(hs + p);
      if (r.ok) { const j = await r.json() as AuthMeta; if (j.authorization_endpoint && j.token_endpoint) return j; }
      last = 'HTTP ' + r.status;
    } catch (e) { last = (e as Error).message; }
  }
  throw new Error(`${hostOf(hs)} has no wallet sign-in (${last})`);
}

async function redeemCode(meta: AuthMeta, clientId: string, redirect: string, code: string, verifier: string) {
  const r = await fetch(meta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier }).toString(),
  });
  const j = await r.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(`Your guild’s sign-in service refused the code (${j.error_description || j.error || r.status})`);
  return j as { access_token: string; refresh_token?: string; expires_in?: number };
}

/** The sign-in window's first moment, before the guild's page arrives. */
function waitingPage(win: Window) {
  try {
    const d = win.document;
    d.title = 'Structs · chat sign-in';
    d.body.style.cssText = 'margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0B1240;color:#fff;font:600 16px system-ui,sans-serif';
    d.body.textContent = 'Connecting to your guild…';
  } catch { /* a window from an earlier try, on another site */ }
}

function postForm(target: string, action: string, fields: Record<string, string>) {
  const f = document.createElement('form');
  f.method = 'POST';
  f.action = action;
  f.target = target;
  f.style.display = 'none';
  for (const [k, v] of Object.entries(fields)) {
    const i = document.createElement('input');
    i.type = 'hidden'; i.name = k; i.value = v;
    f.appendChild(i);
  }
  document.body.appendChild(f);
  f.submit();
  f.remove();
}

/** The callback page's answer for this sign-in's state: by BroadcastChannel, the opener, or a
 * storage event (whichever survives the sign-in pages' opener policy). */
function waitForCallback(state: string, signal: AbortSignal, ms = 5 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CALLBACK_CHANNEL) : null;
    const take = (m: unknown) => {
      const search = (m as { search?: unknown } | null)?.search;
      if (typeof search !== 'string' || new URLSearchParams(search).get('state') !== state) return;
      finish();
      resolve(search);
    };
    const onBc = (e: MessageEvent) => take(e.data);
    const onMsg = (e: MessageEvent) => { if (e.origin === location.origin) take((e.data as { structsCommsAuth?: unknown } | null)?.structsCommsAuth); };
    const onStore = (e: StorageEvent) => { if (e.key === CALLBACK_KEY && e.newValue) { try { take(JSON.parse(e.newValue)); } catch { /* not ours */ } } };
    const onAbort = () => { finish(); reject(new Error('Sign-in cancelled')); };
    const t = setTimeout(() => { finish(); reject(new Error('The sign-in window took too long')); }, ms);
    const finish = () => {
      clearTimeout(t);
      bc?.close();
      window.removeEventListener('message', onMsg);
      window.removeEventListener('storage', onStore);
      signal.removeEventListener('abort', onAbort);
    };
    bc?.addEventListener('message', onBc);
    window.addEventListener('message', onMsg);
    window.addEventListener('storage', onStore);
    signal.addEventListener('abort', onAbort);
  });
}

function logout(s: MatrixSession): Promise<void> {
  return fetch(s.homeserver + '/_matrix/client/v3/logout', { method: 'POST', headers: { authorization: 'Bearer ' + s.access_token, 'content-type': 'application/json' }, body: '{}' })
    .then(() => undefined, () => { /* offline */ });
}

export const comms = new Comms();
export type { Comms };
