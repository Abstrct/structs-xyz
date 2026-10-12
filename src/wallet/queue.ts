/* The transaction queue. Every write the client makes — a click, a proof-of-work completion,
 * a replicant's standing order, a hand-built message from the Forge — goes through here.
 *
 *   lanes      'immediate' jobs sign as soon as they reach the front; 'action' jobs (struct
 *              actions that spend charge) also wait for the player's battery and for the
 *              previous action of the same player to land, since two in one block would fail.
 *   per block  up to four txs per account per block (a node takes five free txs per address).
 *   sequence   kept locally per account and pipelined; a mismatch re-reads it from the chain
 *              and re-signs.
 *   hashes     computed before broadcast (sha256 of the tx bytes), so a reload mid-flight can
 *              find out whether the tx landed instead of sending it twice.
 *   gas        simulated, ×1.6; a simulation that fails for a reason that time fixes (charge,
 *              proof) waits and retries, anything else fails the job with the chain's reason.
 * Jobs persist in localStorage (messages only — never keys). */
import { sha256 } from '@noble/hashes/sha2.js';
import { wallet, WalletLockedError } from './wallet';
import { account, broadcast, ChainTxError, stripCosmosTail, chainId, DEFAULT_GAS, FEE_DENOM, GAS_MULTIPLIER, getTx, humanError, signTx, simulate, type TxResult } from './tx';
import { msgName, validateMsg, type Msg } from './encode';
import { toHex } from './keys';
import { live } from '../chain/live';
import { safeEach } from '../core/util';
import { leader } from '../core/leader';

export type JobStatus = 'queued' | 'waiting' | 'signing' | 'pending' | 'success' | 'failed' | 'cancelled';
export type Lane = 'immediate' | 'action';

export interface TxJob {
  id: string;
  account: number;
  label: string;
  msgs: Msg[];
  memo?: string;
  lane: Lane;
  /** Charge this action spends (blocks since the player's last action). */
  chargeCost?: number;
  playerId?: string;
  /** Who asked: 'you', 'pow', 'forge', 'replicant', 'order:<id>'… */
  source: string;
  status: JobStatus;
  waitReason?: string;
  attempts: number;
  maxAttempts: number;
  hash?: string;
  height?: number;
  gasUsed?: number;
  error?: string;
  code?: number;
  createdAt: number;
  updatedAt: number;
  /** Not before (ms epoch): back-off between attempts. */
  notBefore?: number;
  /** The address the job was queued for; a different key at that index never signs it. */
  signer?: string;
  /** The account sequence this job was last signed at, and when it went pending. */
  signedSeq?: string;
  pendingSince?: number;
  /** Events the chain emitted for this tx, once included (type + JSON payloads). */
  events?: { type: string; data: unknown }[];
}

export interface EnqueueOpts {
  account?: number; label?: string; lane?: Lane; chargeCost?: number; playerId?: string;
  source?: string; memo?: string; maxAttempts?: number; front?: boolean;
}

type Fn = (jobs: TxJob[]) => void;
type DoneFn = (job: TxJob) => void;

const KEY = 'structs.txq.v1';
const KEEP_DONE = 200;

/** Battery reader: charge available to a player right now, or null when unknown. */
export type ChargeOf = (playerId: string) => number | null;

class TxQueue {
  jobs: TxJob[] = [];
  paused = false;
  private listeners = new Set<Fn>();
  private doneL = new Set<DoneFn>();
  private seq = new Map<number, { accountNumber: bigint; sequence: bigint }>();
  /** A node takes at most 5 free txs per address per block (ante 2041, CheckTx): send up to 4. */
  private sentAt = new Map<number, { height: number; at: number; n: number }>();
  private running = false;
  private kick: (() => void) | null = null;
  chargeOf: ChargeOf = () => null;

  constructor() {
    if (typeof window === 'undefined') return;
    this.load();
    live.onBlock(() => { if (leader.isLeader) void this.checkPending(); this.wake(); });
    live.onTx((tx) => { if (leader.isLeader && tx.hash && this.jobs.some((j) => j.status === 'pending' && j.hash === tx.hash)) void this.checkPending(); });
    // Only an unlocked tab may sign, and only one: the signer role follows the vault.
    const follow = () => { if (wallet.unlocked) leader.want(); else leader.resign(); };
    wallet.onChange(() => { follow(); this.wake(); });
    follow();
    leader.onChange((on) => { if (on) { this.load(); this.drainInbox(); this.emitLocal(); this.wake(); } });
    // Other tabs: the signer's queue changed (mirror it) or someone handed us moves (sign them).
    window.addEventListener('storage', (e) => {
      if (e.key === KEY && !leader.isLeader) this.mirror();
      if (e.key === INBOX && leader.isLeader) { this.drainInbox(); this.wake(); }
    });
    // Blocks drive confirmation; when the live feed is quiet, poll instead.
    setInterval(() => { if (Date.now() - live.lastBlockAt > 15_000 && this.jobs.some((j) => j.status === 'pending')) void this.checkPending(); }, 6000);
    void this.loop();
  }

  onChange(f: Fn) { this.listeners.add(f); f(this.jobs); return () => this.listeners.delete(f); }
  /** Fires once per job when it lands or fails for good. */
  onSettled(f: DoneFn) { this.doneL.add(f); return () => this.doneL.delete(f); }
  private emit() { this.save(); this.emitLocal(); }
  private emitLocal() { safeEach(this.listeners, (f) => f(this.jobs)); }

  /* ── Tabs: one signer, the others hand it their moves ─────────────── */

  /** Apply a change here and, when another tab is the signer, hand it the same change. */
  private op(o: QueueOp) {
    applyOp(this.jobs, o);
    if (leader.isLeader) { this.emit(); this.wake(); return; }
    try {
      const inbox = JSON.parse(localStorage.getItem(INBOX) || '[]') as QueueOp[];
      inbox.push(o);
      localStorage.setItem(INBOX, JSON.stringify(inbox.slice(-200)));
    } catch { /* storage blocked: this tab's view still shows it */ }
    this.emitLocal();
  }

  private drainInbox() {
    let ops: QueueOp[] = [];
    try { ops = JSON.parse(localStorage.getItem(INBOX) || '[]'); localStorage.removeItem(INBOX); } catch { return; }
    if (!ops.length) return;
    for (const o of ops) applyOp(this.jobs, o);
    this.emit();
  }

  /** Follow the signer tab's queue; settle our own promises and toasts as its jobs finish. */
  private mirror() {
    const before = new Map(this.jobs.map((j) => [j.id, j.status]));
    this.load();
    for (const j of this.jobs) {
      const was = before.get(j.id);
      if (was && was !== j.status && ['success', 'failed', 'cancelled'].includes(j.status)) safeEach(this.doneL, (f) => f(j));
    }
    this.emitLocal();
  }

  enqueue(msgs: Msg | Msg[], o: EnqueueOpts = {}): TxJob {
    const list = Array.isArray(msgs) ? msgs : [msgs];
    const idx = o.account ?? wallet.activeIndex;
    const acct = wallet.account(idx);
    // Fill the signer in, so callers can leave `creator` out.
    for (const m of list) if (acct && !m.value.creator) m.value.creator = acct.address;
    const errs = list.flatMap(validateMsg);
    if (errs.length) throw new Error(errs[0]);
    const now = Date.now();
    const job: TxJob = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 7),
      account: idx, label: o.label || list.map((m) => humanMsg(m.typeUrl)).join(' + '),
      msgs: list, memo: o.memo, lane: o.lane ?? 'immediate', chargeCost: o.chargeCost, playerId: o.playerId ?? acct?.playerId,
      source: o.source ?? 'you', status: 'queued', attempts: 0, maxAttempts: o.maxAttempts ?? 4, createdAt: now, updatedAt: now,
    };
    job.signer = acct?.address;
    this.op({ op: 'add', job, front: !!o.front });
    return job;
  }

  /** Enqueue and resolve when the tx lands (or reject when it fails). */
  submit(msgs: Msg | Msg[], o: EnqueueOpts = {}): Promise<TxJob> {
    const job = this.enqueue(msgs, o);
    return this.waitFor(job.id);
  }

  waitFor(id: string): Promise<TxJob> {
    return new Promise((resolve, reject) => {
      const check = (j: TxJob) => {
        if (j.id !== id) return false;
        off();
        if (j.status === 'success') resolve(j); else reject(new Error(j.error || j.status));
        return true;
      };
      const off = this.onSettled((j) => { check(j); });
      const now = this.jobs.find((j) => j.id === id);
      if (now && (now.status === 'success' || now.status === 'failed' || now.status === 'cancelled')) check(now);
    });
  }

  cancel(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || !['queued', 'waiting'].includes(j.status)) return false;
    this.op({ op: 'cancel', id });
    safeEach(this.doneL, (f) => f(j));
    return true;
  }

  retry(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || !['failed', 'cancelled'].includes(j.status)) return;
    this.op({ op: 'retry', id });
  }

  move(id: string, delta: number) { this.op({ op: 'move', id, delta }); }

  clearDone() { this.op({ op: 'clear' }); }

  /** Which tab signs: this one, another one, or none (every vault locked). */
  get signerHere() { return leader.isLeader; }

  setPaused(p: boolean) { this.paused = p; this.emit(); this.wake(); }

  get active() { return this.jobs.filter((j) => ['queued', 'waiting', 'signing', 'pending'].includes(j.status)); }

  /* ── The pump ─────────────────────────────────────────────────────── */

  private wake() { this.kick?.(); }

  private async loop() {
    if (this.running) return;
    this.running = true;
    for (;;) {
      let worked = false;
      try { worked = await this.step(); } catch (e) { console.error('[txq]', e); }
      if (!worked) await new Promise<void>((r) => { this.kick = r; setTimeout(r, 3000); });
      this.kick = null;
    }
  }

  /** Picks the first job that can go now and sends it. True if it did anything. */
  private async step(): Promise<boolean> {
    // Another tab signs; this one only shows the queue.
    if (!leader.isLeader) return false;
    if (this.paused || !wallet.unlocked) {
      for (const j of this.jobs) if (j.status === 'queued' && !wallet.unlocked) this.set(j, { status: 'waiting', waitReason: 'wallet locked' });
      return false;
    }
    const now = Date.now();
    for (const j of this.jobs) {
      if (j.status !== 'queued' && j.status !== 'waiting') continue;
      if (j.notBefore && j.notBefore > now) continue;
      // Queued for a key that has since left the vault (forgotten, replaced): never sign it with another.
      const acct = wallet.account(j.account);
      if (j.signer && acct && acct.address !== j.signer) { this.fail(j, 'Queued for a key that is no longer this account — not signing it'); continue; }
      const why = this.blockedBy(j);
      if (why) { if (j.waitReason !== why || j.status !== 'waiting') this.set(j, { status: 'waiting', waitReason: why }); continue; }
      await this.send(j);
      return true;
    }
    return false;
  }

  private blockedBy(j: TxJob): string | null {
    if (!wallet.account(j.account)) return 'account not in this wallet';
    // One signer at a time per account: earlier jobs of the same account go first.
    const earlier = this.jobs.slice(0, this.jobs.indexOf(j));
    if (earlier.some((x) => x.account === j.account && x.status === 'signing')) return 'signing';
    const sent = this.sentAt.get(j.account);
    // Without a live height (socket down) a block is about 6 s; wait that long instead.
    if (sent && sent.n >= PER_BLOCK && (live.height ? sent.height >= live.height : Date.now() - sent.at < 7000)) return 'next block';
    if (j.lane === 'action') {
      if (earlier.some((x) => x.account === j.account && x.lane === 'action' && ['queued', 'waiting', 'signing'].includes(x.status))) return 'behind another action';
      if (this.jobs.some((x) => x !== j && x.account === j.account && x.lane === 'action' && x.status === 'pending')) return 'previous action landing';
      if (j.chargeCost && j.playerId) {
        const c = this.chargeOf(j.playerId);
        if (c != null && c < j.chargeCost) return `charging ${c}/${j.chargeCost}`;
      }
    }
    return null;
  }

  private async send(j: TxJob) {
    this.set(j, { status: 'signing', waitReason: undefined, attempts: j.attempts + 1 });
    let sent = false;
    try {
      const key = wallet.key(j.account);
      const cid = await chainId();
      let s = this.seq.get(j.account);
      if (!s) {
        const a = await account(key.address);
        if (!a.exists) throw new ChainTxError(-1, 'client', 'This account has no funds or history on chain yet, so it cannot sign. Join a guild or receive alpha first.');
        s = { accountNumber: a.accountNumber, sequence: a.sequence };
        this.seq.set(j.account, s);
      }
      const fee0 = { amount: [{ denom: FEE_DENOM, amount: '0' }], gas: DEFAULT_GAS };
      let gas = DEFAULT_GAS;
      // Proofs are judged at the inclusion height, but simulation runs a block behind and would
      // refuse a proof that is valid next block. Their gas is small and fixed; skip the dry run.
      if (!j.msgs.some((m) => PROOF_MSGS.has(msgName(m.typeUrl)))) try {
        const used = await simulate(signTx(key, j.msgs, { chainId: cid, ...s }, fee0, j.memo));
        gas = Math.max(200_000, Math.ceil(used * GAS_MULTIPLIER));
      } catch (e) {
        const msg = (e as Error).message || '';
        const m = /expected (\d+), got (\d+)/.exec(msg);
        if (m) { s.sequence = BigInt(m[1]); throw new RetryNow(); }
        // The ante handler or the message itself refused: the same reason the real tx would fail with.
        throw new ChainTxError(-2, 'simulate', stripCosmosTail(msg.replace(/^.*?message index: \d+: /, '').replace(/: unknown request$/, '')));
      }
      const bytes = signTx(key, j.msgs, { chainId: cid, ...s }, { ...fee0, gas }, j.memo);
      const hash = toHex(sha256(bytes)).toUpperCase();
      this.set(j, { hash, signedSeq: s.sequence.toString() });
      const prev = this.sentAt.get(j.account);
      const same = prev && (live.height ? prev.height === live.height : Date.now() - prev.at < 7000);
      this.sentAt.set(j.account, { height: live.height, at: same ? prev!.at : Date.now(), n: same ? prev!.n + 1 : 1 });
      sent = true;
      await broadcast(bytes);
      s.sequence += 1n;
      this.set(j, { status: 'pending', pendingSince: Date.now() });
    } catch (e) {
      if (e instanceof RetryNow) { this.set(j, { status: 'queued', attempts: j.attempts - 1, hash: undefined }); return; }
      if (e instanceof WalletLockedError) { this.set(j, { status: 'waiting', waitReason: 'wallet locked', attempts: j.attempts - 1 }); return; }
      const ce = e instanceof ChainTxError ? e : null;
      if (ce?.expectedSequence != null) {
        const s = this.seq.get(j.account);
        if (s) s.sequence = ce.expectedSequence;
        this.set(j, { status: 'queued', hash: undefined, attempts: j.attempts - 1 });
        return;
      }
      if (ce && ce.code === 19) { this.set(j, { status: 'pending', pendingSince: Date.now() }); return; }   // already in the mempool
      // The broadcast may have reached the node even though we never heard back: never re-sign
      // blind. Treat it as pending; confirmation (or the account's sequence) decides.
      if (!ce && sent && j.hash) { this.seq.delete(j.account); this.set(j, { status: 'pending', pendingSince: Date.now() }); return; }
      const msg = ce ? ce.message : (e as Error).message || String(e);
      const proof = j.msgs.some((m) => PROOF_MSGS.has(msgName(m.typeUrl)));
      const transient = !ce || isTransient(ce.log || msg, ce.code, proof);
      // A failed simulation leaves the sequence alone; a network failure might not have.
      if (!ce) this.seq.delete(j.account);
      if (transient && j.attempts < j.maxAttempts) {
        this.set(j, { status: 'waiting', waitReason: msg, hash: undefined, notBefore: Date.now() + backoff(j.attempts) });
      } else {
        this.fail(j, msg, ce?.code);
      }
    }
  }

  private fail(j: TxJob, error: string, code?: number) {
    this.set(j, { status: 'failed', error, code });
    safeEach(this.doneL, (f) => f(j));
  }

  private checking = false;
  private async checkPending() {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const j of this.jobs.filter((x) => x.status === 'pending' && x.hash)) {
        let r: TxResult | null = null;
        try { r = await getTx(j.hash!); } catch { continue; }
        if (!r) {
          // Not found for 90 s. Re-sign only if its sequence is still unused — otherwise something
          // signed at that number landed (perhaps this very move under another hash) and a re-send
          // could do it twice.
          if (Date.now() - (j.pendingSince ?? j.updatedAt) > 90_000) {
            this.seq.delete(j.account);
            const addr = wallet.account(j.account)?.address;
            if (!addr) { this.fail(j, 'Its account left this vault; outcome unknown'); continue; }
            const a = await account(addr).catch(() => null);
            if (!a) continue;
            if (j.signedSeq != null && a.sequence > BigInt(j.signedSeq)) this.fail(j, 'Not found, but its slot in the account sequence was used — it may have landed; not re-sending');
            else if (j.attempts < j.maxAttempts) this.set(j, { status: 'queued', hash: undefined, signedSeq: undefined });
            else this.fail(j, 'Dropped from the mempool');
          }
          continue;
        }
        const events = r.events.filter((e) => e.type.startsWith('structs.structs.')).map((e) => {
          const a = e.attributes.find((x) => x.key !== 'msg_index');
          let data: unknown = a?.value;
          try { data = JSON.parse(String(a?.value)); } catch { /* raw */ }
          return { type: e.type.slice('structs.structs.'.length), data };
        });
        if (r.code === 0) {
          this.set(j, { status: 'success', height: r.height, gasUsed: r.gasUsed, events });
          safeEach(this.doneL, (f) => f(j));
        } else {
          this.set(j, { height: r.height, gasUsed: r.gasUsed });
          const msg = humanError(r.code, '', r.log);
          if (isTransient(r.log, r.code, j.msgs.some((m) => PROOF_MSGS.has(msgName(m.typeUrl)))) && j.attempts < j.maxAttempts) this.set(j, { status: 'waiting', waitReason: msg, hash: undefined, notBefore: Date.now() + backoff(j.attempts) });
          else this.fail(j, msg, r.code);
        }
      }
    } finally {
      this.checking = false;
      this.wake();
    }
  }

  private set(j: TxJob, patch: Partial<TxJob>) {
    Object.assign(j, patch, { updatedAt: Date.now() });
    this.emit();
  }

  private save() {
    // Only the signer writes the shared queue; other tabs hand it changes through the inbox.
    if (!leader.isLeader && leader.supported) return;
    try {
      const done = this.jobs.filter((j) => ['success', 'failed', 'cancelled'].includes(j.status));
      const keep = new Set(done.slice(-KEEP_DONE));
      this.jobs = this.jobs.filter((j) => !['success', 'failed', 'cancelled'].includes(j.status) || keep.has(j));
      localStorage.setItem(KEY, JSON.stringify(this.jobs));
    } catch { /* storage full or blocked: the queue still works this session */ }
  }

  private load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as TxJob[];
      // A tab closed mid-sign: if the hash was computed it may have landed — check it; else re-queue.
      for (const j of raw) {
        if (j.status === 'signing') { j.status = j.hash ? 'pending' : 'queued'; j.updatedAt = Date.now(); }
        if (j.status === 'pending') j.pendingSince = Date.now();
      }
      this.jobs = raw;
    } catch { this.jobs = []; }
  }
}

class RetryNow extends Error {}

const INBOX = 'structs.txq.inbox';
type QueueOp = { op: 'add'; job: TxJob; front: boolean } | { op: 'cancel'; id: string } | { op: 'retry'; id: string } | { op: 'move'; id: string; delta: number } | { op: 'clear' };

/** The queue's changes as data, so a tab that doesn't sign can hand them to the one that does. */
function applyOp(jobs: TxJob[], o: QueueOp) {
  const now = Date.now();
  if (o.op === 'add') { if (!jobs.some((j) => j.id === o.job.id)) { if (o.front) jobs.unshift(o.job); else jobs.push(o.job); } return; }
  if (o.op === 'clear') { const keep = jobs.filter((j) => !['success', 'failed', 'cancelled'].includes(j.status)); jobs.splice(0, jobs.length, ...keep); return; }
  const i = jobs.findIndex((j) => j.id === o.id);
  if (i < 0) return;
  const j = jobs[i];
  if (o.op === 'cancel' && ['queued', 'waiting'].includes(j.status)) Object.assign(j, { status: 'cancelled', error: 'Cancelled', updatedAt: now });
  if (o.op === 'retry' && ['failed', 'cancelled'].includes(j.status)) Object.assign(j, { status: 'queued', attempts: 0, error: undefined, code: undefined, hash: undefined, notBefore: undefined, signedSeq: undefined, updatedAt: now });
  if (o.op === 'move') { const k = i + o.delta; if (k >= 0 && k < jobs.length) [jobs[i], jobs[k]] = [jobs[k], jobs[i]]; }
}

const PER_BLOCK = 4;

/** Messages judged on proof-of-work (ante ProofMessages). */
const PROOF_MSGS = new Set(['MsgStructBuildComplete', 'MsgStructOreMinerComplete', 'MsgStructOreRefineryComplete', 'MsgPlanetRaidComplete']);

const backoff = (attempt: number) => Math.min(60_000, 4000 * 2 ** Math.max(0, attempt - 1));

/** Reasons that time (a block, a recharge) can fix. The structs ante handler's per-block
 * limits (one charge action, one proof per object, five txs per address) clear next block. */
function isTransient(log: string, code?: number, proof = false): boolean {
  if (code != null && [2021, 2022, 2031, 2033, 2040, 2041, 2043].includes(code)) return true;
  // A proof refused for work is usually a block early; the proof engine re-checks the clock.
  if (/work failure/i.test(log)) return proof;
  return /insufficient charge|charge|timed out|timeout|ECONN|fetch|network|503|502|429|mempool is full|sequence|took too long|this block/i.test(log);
}

/** "/structs.structs.MsgStructBuildInitiate" → "Struct build initiate" */
export function humanMsg(typeUrl: string): string {
  const n = msgName(typeUrl).replace(/^Msg/, '');
  return n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^(.)/, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_, c: string) => ' ' + c.toLowerCase());
}

export const txq = new TxQueue();
