/* The guild session: this browser signed in to its commander's own guild, so the Guild API's
 * members-only routes (structs, grid, raids, activity, ledgers…) answer it. Every guild's indexer
 * sees the whole chain, so one session on one guild opens the whole galaxy's data.
 *
 * It is the guild webapp's own sign-in: the wallet signs `LOGIN_GUILD{g}ADDRESS{addr}DATETIME{ts}`,
 * POST /api/auth/login sets a PHP session cookie, and later calls carry it (credentials: 'include',
 * which the live guilds now allow per origin). Behind the scenes, like chat:
 *   - first it asks with whatever cookie the browser already has (another tab's sign-in, an earlier
 *     visit): no signature needed while that session lives;
 *   - else, with the vault open, it signs in as a commander of that guild, then checks the cookie
 *     came back (a browser blocking third-party cookies drops it: that is reported, not retried);
 *   - a 401 later (the session expired on the server) signs in again; two failed sign-ins in a row
 *     and it stops for this visit; a locked vault waits for the wallet to open.
 * Callers ask `session.api()` and fall back to the LCD when it is null. */
import { wallet } from '../wallet/wallet';
import { store } from '../chain/store';
import { guildsNow, onGuilds } from './directory';
import { buildLoginRequest, guildApi, type GuildApi, type Envelope } from './api';
import { guildFetch, sendCookies, onUnauthorized, GuildBlockedError } from './transport';
import { safeEach } from '../core/util';

export type SessionState = 'off' | 'checking' | 'signing' | 'open' | 'locked' | 'failed';
export interface SessionStatus {
  state: SessionState;
  /** The guild signed in to (or being tried). */
  guildId: string | null;
  /** The commander that signs (null while the session rides an existing cookie). */
  playerId: string | null;
  /** Why it isn't open, in plain words. */
  why: string;
  /** The guild indexer's block height at the last check. */
  height: number;
}

/** A members-only route that is cheap and says how far the guild's indexer has got. */
const PROBE = 'block';
const KEEPALIVE_MS = 5 * 60_000;
/** Failed sign-ins in a row before giving up for the visit, and sign-ins of any kind per visit (a
 * guild whose sessions keep vanishing mustn't have the wallet signing forever). */
const MAX_SIGNS = 2;
const MAX_SIGNS_PER_VISIT = 6;
/** The least time between two height probes. */
const PROBE_GAP_MS = 1000;

type Fn = (s: SessionStatus) => void;

class GuildSession {
  status: SessionStatus = { state: 'off', guildId: null, playerId: null, why: '', height: 0 };
  private listeners = new Set<Fn>();
  private busy: Promise<void> | null = null;
  private again = false;
  private signs = new Map<string, number>();     // `${guild}|${address}` → failed sign-ins in a row this visit
  private signsTotal = new Map<string, number>(); // `${guild}|${address}` → sign-ins this visit
  private lastOk = 0;
  private started = false;
  /** Guilds that answer this site without cookies: not asked again this visit. */
  private refused = new Set<string>();

  /** The open session's Guild API, else null (read from the LCD instead). */
  api(): GuildApi | null { return this.status.state === 'open' && this.status.guildId ? guildApi(this.status.guildId) : null; }
  get open() { return this.status.state === 'open'; }

  onChange(f: Fn) { this.listeners.add(f); f(this.status); return () => { this.listeners.delete(f); }; }

  private set(p: Partial<SessionStatus>) {
    const prev = this.status;
    const next = { ...prev, ...p };
    // Cookies go to a guild only while its session is open: a guild that answers `*` refuses any
    // credentialed call (chat's, enlisting's), so they're never on before it has proved it takes them.
    // (The checks and the sign-in itself ask with cookies explicitly.)
    if (prev.guildId && prev.guildId !== next.guildId) sendCookies(prev.guildId, false);
    if (next.guildId) sendCookies(next.guildId, next.state === 'open');
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    this.status = next;
    safeEach(this.listeners, (f) => f(this.status));
  }

  /** Start watching for the moment a session can open: wallet, roster and directory. */
  start() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    wallet.onChange(() => this.kick());
    store.onCore(() => this.kick());
    onGuilds(() => this.kick());
    onUnauthorized((g) => { if (g === this.status.guildId && this.status.state === 'open') { this.set({ state: 'off', why: 'The guild ended the session' }); this.kick(); } });
    window.addEventListener('online', () => this.kick());
    setInterval(() => { if (this.open && Date.now() - this.lastOk > KEEPALIVE_MS - 30_000) void this.check(this.status.guildId!); }, KEEPALIVE_MS);
    this.kick();
  }

  /** Try to open (or keep) the session now. Safe to call often. */
  kick(): Promise<void> {
    if (this.busy) { this.again = true; return this.busy; }
    this.busy = this.ensure().catch((e) => { console.warn('[guild session]', e); }).finally(() => {
      this.busy = null;
      if (this.again) { this.again = false; void this.kick(); }
    });
    return this.busy;
  }

  /** The commander to sign as and their guild: the active account first, then the others. */
  private route(): { guildId: string; playerId: string; index: number; address: string } | { why: string } {
    const accts = [wallet.active, ...wallet.accounts].filter((a, i, all) => a && a.playerId && all.indexOf(a) === i);
    if (!accts.length) return { why: wallet.state === 'empty' ? 'No commander in this browser' : 'No commander yet' };
    if (!store.coreLoaded) return { why: 'Loading the roster' };
    const dir = guildsNow();
    if (!dir) return { why: 'Loading the guild directory' };
    for (const a of accts) {
      const g = store.players.get(a!.playerId!)?.guildId;
      if (!g) continue;
      if (dir.find((e) => e.id === g)?.services?.guild_api) return { guildId: g, playerId: a!.playerId!, index: a!.index, address: a!.address };
    }
    return { why: 'Your guild runs no Guild API this site can reach' };
  }

  private async ensure() {
    const r = this.route();
    if ('why' in r) {
      // Keep a session that is already open (the roster reloading doesn't end it).
      if (this.open) return;
      this.drop();
      this.set({ state: 'off', why: r.why, playerId: null });
      return;
    }
    if (this.open && this.status.guildId === r.guildId) return;
    if (this.status.guildId && this.status.guildId !== r.guildId) this.drop();
    if (this.refused.has(r.guildId)) { this.set({ state: 'failed', guildId: r.guildId, why: 'This guild doesn’t accept sign-ins from websites yet' }); return; }
    this.set({ state: 'checking', guildId: r.guildId, why: '' });
    // 1. A cookie the browser already holds (another tab, an earlier visit).
    const first = await this.check(r.guildId);
    if (first !== 'login') return;
    // 2. Sign in: needs the vault open, and a limit per visit.
    if (wallet.state !== 'unlocked') { this.set({ state: 'locked', playerId: r.playerId, why: 'Open your vault to sign in to your guild' }); return; }
    const key = `${r.guildId}|${r.address}`;
    const n = this.signs.get(key) ?? 0, total = this.signsTotal.get(key) ?? 0;
    if (n >= MAX_SIGNS || total >= MAX_SIGNS_PER_VISIT) { this.set({ state: 'failed', playerId: r.playerId, why: this.status.why || 'Sign-in didn’t hold; reload to try again' }); return; }
    this.signs.set(key, n + 1);
    this.signsTotal.set(key, total + 1);
    this.set({ state: 'signing', playerId: r.playerId, why: '' });
    const problem = await login(r.guildId, r.address, r.index);
    if (this.status.guildId !== r.guildId) return;   // the route moved on mid-sign-in
    if (problem) { this.set({ state: 'failed', why: problem }); return; }
    // 3. The cookie must come back: a browser that blocks third-party cookies drops it.
    const after = await this.check(r.guildId);
    if (after === 'open') this.signs.delete(key);      // the cap counts failures in a row, not sign-ins
    else if (this.status.guildId === r.guildId && this.status.state !== 'failed') {
      this.set({ state: 'failed', why: 'Your browser didn’t keep the guild’s sign-in cookie (third-party cookies blocked?)' });
    }
  }

  /** Ask a members-only route with this browser's cookies. */
  private async check(guildId: string): Promise<'open' | 'login' | 'refused' | 'down'> {
    try {
      const res = await guildFetch(guildId, PROBE, { credentials: 'include' });
      if (this.status.guildId !== guildId) return 'down';
      if (res.status === 401) {
        // An open session that ended (keep-alive, a height probe): sign in again behind the scenes.
        if (this.open) { this.set({ state: 'off', why: 'Session expired' }); queueMicrotask(() => void this.kick()); }
        return 'login';
      }
      const body = await res.json().catch(() => null) as Envelope<{ height?: number }> | null;
      if (this.status.guildId !== guildId) return 'down';        // the route moved on while it parsed
      // A busy or restarting guild (5xx, 429) doesn't end an open session; it just isn't news.
      if (!res.ok || !body?.success) { if (!this.open) this.set({ state: 'failed', why: `The guild answered ${res.status}` }); return 'down'; }
      this.lastOk = Date.now();
      this.set({ state: 'open', why: '', height: Number(body.data?.height) || this.status.height });
      return 'open';
    } catch (e) {
      if (this.status.guildId !== guildId) return 'down';
      if (e instanceof GuildBlockedError) {
        // It answers this site, but not with cookies (Access-Control-Allow-Origin: *).
        this.refused.add(guildId);
        this.set({ state: 'failed', why: 'This guild doesn’t accept sign-ins from websites yet' });
        return 'refused';
      }
      this.set({ state: this.open ? 'open' : 'failed', why: this.open ? '' : String((e as Error).message || e) });
      return 'down';
    }
  }

  /** End the guild session (the vault was forgotten): the guild drops it, and nothing signs in again
   * until a commander is back. */
  async signOut() {
    // Whatever the state: a sign-in may have set the cookie moments ago.
    const g = this.status.guildId;
    if (g && !this.refused.has(g)) await guildFetch(g, 'auth/logout', { credentials: 'include' }).catch(() => null);
    this.drop();
    this.signs.clear();
    this.signsTotal.clear();
  }

  /** Let go of the guild (set() stops its cookies). */
  private drop() {
    this.set({ state: 'off', guildId: null, height: 0 });
  }

  /** The indexer's height, asked now (at most once a second, one at a time; GRASS on the same guild
   * usually knows without asking). */
  private probing: Promise<number> | null = null;
  private probedAt = 0;
  probeHeight(): Promise<number> {
    const g = this.status.guildId;
    if (!g || !this.open) return Promise.resolve(0);
    if (this.probing) return this.probing;
    if (Date.now() - this.probedAt < PROBE_GAP_MS) return Promise.resolve(this.status.height);
    this.probedAt = Date.now();
    this.probing = this.check(g).then(() => this.status.height, () => this.status.height).finally(() => { this.probing = null; });
    return this.probing;
  }
}

/** The guild's own sign-in. Returns null on success, else the guild's reason in plain words. */
async function login(guildId: string, address: string, index: number): Promise<string | null> {
  try {
    const clock = await guildFetch(guildId, 'timestamp', { credentials: 'include' });
    const ts = Number((await clock.json().catch(() => null) as { data?: { unix_timestamp?: number } } | null)?.data?.unix_timestamp);
    if (!clock.ok || !Number.isFinite(ts)) return `Your guild didn’t tell the time (${clock.status})`;
    const body = buildLoginRequest(guildId, address, ts, (m) => wallet.signMessage(index, m));
    const res = await guildFetch(guildId, 'auth/login', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const env = await res.json().catch(() => null) as Envelope<unknown> | null;
    if (res.ok && env?.success) return null;
    const e = env?.errors;
    const words = e && !Array.isArray(e) ? Object.values(e).filter((x) => typeof x === 'string').join('; ') : '';
    return words || `The guild refused the sign-in (${res.status})`;
  } catch (e) {
    return String((e as Error).message || e);
  }
}

export const session = new GuildSession();
