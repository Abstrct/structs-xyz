/* The proof-of-work engine. Finds every proof your empire owes the chain — structs being
 * built, ore to mine, ore to refine, raids to finish — hashes them on a pool of Web Workers,
 * and submits each proof the moment the chain will accept it.
 *
 * The chain's bar falls with age (64 hex zeros at age 1, one zero at age = range), so the
 * engine keeps the best proof found so far and submits as soon as the bar for the *next*
 * block drops to meet it. Starting early costs nothing but CPU; a lucky proof lands blocks
 * before a patient one would. Workers go to the tasks closest to finishing; a WebGPU device,
 * when there is one (gpu.ts), takes the hardest task it can still finish within a minute. */
import { live } from '../chain/live';
import { empire, type PlayerState } from '../game/empire';
import { txq } from '../wallet/queue';
import { wallet } from '../wallet/wallet';
import { difficultyAt } from './sha';
import { GpuHasher } from './gpu';
import { safeEach } from '../core/util';
import { leader } from '../core/leader';
import { num } from '../chain/lcd';

export type TaskKind = 'build' | 'mine' | 'refine' | 'raid';
export type TaskStatus = 'idle' | 'hashing' | 'submitting' | 'done' | 'failed';

export interface PowTask {
  id: string;
  kind: TaskKind;
  objectId: string;        // struct (build/mine/refine) or fleet (raid)
  planetId?: string;
  blockStart: number;
  range: number;
  account: number;
  playerId: string;
  label: string;
  prefix: string;
  best: { zeros: number; nonce: string; hash: string } | null;
  hashes: number;
  rate: number;            // hashes / s, smoothed
  workers: number;
  status: TaskStatus;
  jobId?: string;
  error?: string;
  /** No auto-submit before this height (after a refusal). */
  holdUntil?: number;
  createdAt: number;
  doneAt?: number;
}

type Fn = () => void;
const SETTINGS = 'structs.pow';

export type PowEngineKind = 'auto' | 'cpu' | 'gpu';
interface PowSettings { enabled: boolean; threads: number; startAt: number; autoSubmit: boolean; engine: PowEngineKind; signers?: Record<string, number> }
/** The GPU lane: `available` once a WebGPU device is up; `error` says why it isn't. */
export interface GpuState { available: boolean; adapter: string; rate: number; task: string | null; error?: string }

class PowEngine {
  tasks = new Map<string, PowTask>();
  private workers: { w: Worker; task: string | null }[] = [];
  private listeners = new Set<Fn>();
  private emitTimer = 0;
  settings: PowSettings;
  totalHashes = 0;
  rate = 0;
  private rateWindow: { t: number; n: number }[] = [];
  gpu: GpuState = { available: false, adapter: '', rate: 0, task: null };
  private gpuHasher: GpuHasher | null = null;
  private gpuOpening = false;

  constructor() {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    this.settings = { enabled: true, threads: Math.max(1, Math.min(8, Math.floor(cores / 2))), startAt: 9, autoSubmit: true, engine: 'auto' };
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem(SETTINGS) || '{}')); } catch { /* defaults */ }
    if (typeof window === 'undefined') return;
    try { this.helping = new Map(JSON.parse(localStorage.getItem('structs.pow.help') || '[]')); } catch { /* none */ }
    for (const pid of this.helping.keys()) empire.watch(pid);
    empire.onChange(() => this.discover());
    leader.onChange(() => this.schedule());
    live.onBlock(() => { this.tick(); });
    txq.onSettled((j) => {
      for (const t of this.tasks.values()) {
        if (t.jobId !== j.id) continue;
        if (j.status === 'success') { t.status = 'done'; t.doneAt = Date.now(); this.release(t.id); }
        else {
          // Keep the proof: a work failure is usually one block early (retry next block); any
          // other refusal (shields up, fleet not first, grid offline) holds the task a while.
          const early = /proof|work|clock moved/i.test(j.error || '');
          t.status = 'idle'; t.error = j.error; t.jobId = undefined;
          t.holdUntil = live.height + (early ? 1 : 12);
        }
        this.emit();
      }
    });
    setInterval(() => this.sampleRate(), 1000);
  }

  onChange(f: Fn) { this.listeners.add(f); f(); return () => this.listeners.delete(f); }
  private emit() {
    if (this.emitTimer) return;
    this.emitTimer = window.setTimeout(() => { this.emitTimer = 0; safeEach(this.listeners, (f) => f()); }, 120);
  }

  save(patch: Partial<PowSettings>) {
    Object.assign(this.settings, patch);
    try { localStorage.setItem(SETTINGS, JSON.stringify(this.settings)); } catch { /* ignore */ }
    if (patch.threads != null) { for (const x of this.workers) x.w.terminate(); this.workers = []; }
    this.schedule();
    this.emit();
  }

  /** The bar a proof must clear if it is included in the next block. */
  required(t: PowTask, height = live.height): number {
    if (!height) return 64;
    return difficultyAt(height + 1 - t.blockStart, t.range);
  }

  /** Blocks from now until the bar falls to `zeros`. */
  blocksUntil(t: PowTask, zeros: number): number {
    if (t.range <= 1) return Infinity;
    const age = Math.ceil(Math.pow(t.range, (64 - zeros) / 63));
    return Math.max(0, t.blockStart + age - (live.height + 1));
  }

  /** Expected seconds for a thread pool at `rate` to find `zeros` leading zeros. */
  etaSeconds(zeros: number, rate = this.rate || 1) { return Math.pow(16, zeros) / Math.max(1, rate); }

  get active() { return [...this.tasks.values()].filter((t) => t.status !== 'done'); }

  /* ── Discovery: what does the empire owe? ─────────────────────────── */

  /** Guildmates whose proofs this browser grinds (player id → our signing account). The chain
   * accepts a proof from anyone the owner granted the matching Hash permission. */
  helping = new Map<string, number>();

  help(playerId: string, signer: number) {
    const fresh = !this.helping.has(playerId);
    this.helping.set(playerId, signer);
    this.saveHelping();
    if (fresh) empire.watch(playerId);
    this.discover();
  }
  stopHelping(playerId: string) {
    this.helping.delete(playerId);
    this.saveHelping();
    empire.unwatch(playerId);
    this.discover();
  }
  /** Sign one player's proofs with another key (a linked field key with the Hash permissions). */
  setSigner(playerId: string, account: number | null) {
    const m = { ...(this.settings.signers || {}) };
    if (account == null) delete m[playerId]; else m[playerId] = account;
    // Tasks already found keep their signer: let them be found again with the new one.
    for (const [id, t] of this.tasks) if (t.playerId === playerId && t.status !== 'submitting') { this.release(id); this.tasks.delete(id); }
    this.save({ signers: m });
    this.discover();
  }
  /** Forget every per-vault setting (crew, signers): they name accounts of a phrase that is gone. */
  resetForVault() {
    for (const pid of [...this.helping.keys()]) this.stopHelping(pid);
    this.save({ signers: {} });
  }
  private saveHelping() { try { localStorage.setItem('structs.pow.help', JSON.stringify([...this.helping])); } catch { /* ignore */ } }

  discover() {
    const seen = new Set<string>();
    for (const p of empire.players.values()) for (const t of tasksFor(p, p.account < 0 ? this.helping.get(p.playerId) : this.settings.signers?.[p.playerId])) {
      seen.add(t.id);
      if (!this.tasks.has(t.id)) this.tasks.set(t.id, t);
    }
    // A task whose condition went away (built, clock reset, raid over) retires.
    for (const [id, t] of this.tasks) {
      if (!seen.has(id) && t.status !== 'submitting') {
        if (t.status !== 'done') { t.status = 'done'; t.doneAt = t.doneAt ?? Date.now(); }
        this.release(id);
        if (Date.now() - (t.doneAt || 0) > 10 * 60_000) this.tasks.delete(id);
      }
    }
    this.schedule();
    this.emit();
  }

  /* ── Each block: submit what's ready, re-plan the workers ─────────── */

  private tick() {
    for (const t of this.tasks.values()) {
      if (t.status === 'done' || t.status === 'submitting' || !t.best) continue;
      if (leader.isLeader && t.best.zeros >= this.required(t) && this.settings.autoSubmit && !(t.holdUntil && live.height < t.holdUntil)) this.submit(t);
    }
    this.schedule();
    this.emit();
  }

  submit(t: PowTask) {
    if (!t.best || !wallet.account(t.account)) return;
    const value: Record<string, unknown> = t.kind === 'raid'
      ? { fleetId: t.objectId, proof: t.best.hash, nonce: t.best.nonce }
      : { structId: t.objectId, proof: t.best.hash, nonce: t.best.nonce };
    const type = { build: 'MsgStructBuildComplete', mine: 'MsgStructOreMinerComplete', refine: 'MsgStructOreRefineryComplete', raid: 'MsgPlanetRaidComplete' }[t.kind];
    try {
      const job = txq.enqueue({ typeUrl: `/structs.structs.${type}`, value }, { account: t.account, playerId: t.playerId, source: 'pow', label: `${t.label} · proof ${t.best.zeros}`, front: true, maxAttempts: 2 });
      t.jobId = job.id;
      t.status = 'submitting';
      this.release(t.id);
    } catch (e) {
      t.error = (e as Error).message;
    }
    this.emit();
  }

  /** Point the worker pool at the most promising tasks. */
  private schedule() {
    // Only the signing tab hashes, and only while its vault is open: a locked vault grinds nothing.
    const active = this.settings.enabled && leader.isLeader;
    const gpuOn = active && this.settings.engine !== 'cpu';
    if (gpuOn) this.openGpu();
    const g = gpuOn ? this.gpuHasher : null;
    const want = active && !(g && this.settings.engine === 'gpu') ? this.settings.threads : 0;
    const height = live.height;
    const candidates = [...this.tasks.values()]
      .filter((t) => (t.status === 'idle' || t.status === 'hashing') && height > 0)
      .filter((t) => wallet.account(t.account))
      .map((t) => ({ t, req: this.required(t, height) }))
      .filter(({ t, req }) => req <= this.settings.startAt || (t.best && t.best.zeros >= req - 1) || req <= this.reachable())
      .sort((a, b) => a.req - b.req || a.t.createdAt - b.t.createdAt);
    // The GPU takes the hardest task it can expect to crack within a minute (else the easiest),
    // leaving the CPU threads the rest; with a single task they share it.
    let gpuTask: string | null = null;
    if (g && candidates.length) {
      const reach = Math.log(Math.max(1e6, g.rate || 5e8) * 60) / Math.log(16);
      const needy = candidates.filter((c) => !c.t.best || c.t.best.zeros < c.req);   // a met bar is waiting on submit
      const pool = needy.length ? needy : candidates;
      gpuTask = (pool.filter((c) => c.req <= reach).pop() ?? pool[0]).t.id;
      if (candidates.length > 1) candidates.splice(candidates.findIndex((c) => c.t.id === gpuTask), 1);
    }
    if (g) {
      if (gpuTask) { const t = this.tasks.get(gpuTask)!; g.run(t.id, t.prefix, t.best?.zeros ?? 0); } else g.stop();
      this.gpu.task = g.task;
    } else if (this.gpuHasher) { this.gpuHasher.stop(); this.gpu.task = null; this.gpu.rate = 0; }
    // Spread threads: each candidate gets ⌊want/n⌋, the closest get the remainder.
    const plan = new Map<string, number>();
    if (candidates.length && want) {
      const n = Math.min(candidates.length, want);
      for (let i = 0; i < want; i++) { const id = candidates[i % n].t.id; plan.set(id, (plan.get(id) || 0) + 1); }
    }
    // Grow or shrink the pool.
    while (this.workers.length < want) this.workers.push({ w: this.spawn(), task: null });
    while (this.workers.length > want) this.workers.pop()!.w.terminate();
    // Keep workers already on a planned task; reassign the rest.
    const have = new Map<string, number>();
    for (const x of this.workers) if (x.task && plan.has(x.task) && (have.get(x.task) || 0) < plan.get(x.task)!) have.set(x.task, (have.get(x.task) || 0) + 1); else if (x.task) { x.w.postMessage({ type: 'stop' }); x.task = null; }
    for (const x of this.workers) {
      if (x.task) continue;
      const next = [...plan].find(([id, k]) => (have.get(id) || 0) < k);
      if (!next) break;
      const t = this.tasks.get(next[0])!;
      have.set(t.id, (have.get(t.id) || 0) + 1);
      x.task = t.id;
      x.w.postMessage({ type: 'start', taskId: t.id, prefix: t.prefix, start: Math.floor(Math.random() * 9e12), floor: t.best?.zeros ?? 0 });
    }
    for (const t of this.tasks.values()) {
      t.workers = this.workers.filter((x) => x.task === t.id).length;
      const busy = t.workers > 0 || this.gpu.task === t.id;
      if (t.status === 'idle' && busy) t.status = 'hashing';
      if (t.status === 'hashing' && !busy) t.status = 'idle';
    }
  }

  /** Zeros the pool can expect to find within about five minutes. */
  private reachable(): number {
    const r = this.rate || this.settings.threads * 2.5e6;
    return Math.floor(Math.log(r * 300) / Math.log(16));
  }

  private release(id: string) {
    for (const x of this.workers) if (x.task === id) { x.w.postMessage({ type: 'stop' }); x.task = null; }
    if (this.gpuHasher && this.gpu.task === id) { this.gpuHasher.stop(); this.gpu.task = null; this.gpu.rate = 0; }
  }

  /** Bring up the GPU lane once; without WebGPU this quietly leaves the CPU pool in charge. */
  private openGpu() {
    if (this.gpuHasher || this.gpuOpening || this.gpu.error) return;
    this.gpuOpening = true;
    void GpuHasher.open().then((g) => {
      this.gpuOpening = false;
      if (!g) { this.gpu.error = 'WebGPU unavailable'; this.emit(); return; }
      this.gpuHasher = g;
      Object.assign(this.gpu, { available: true, adapter: g.adapter });
      g.onProgress = (taskId, n, ms) => {
        this.gpu.rate = g.rate;
        this.progress(taskId, n);
        const t = this.tasks.get(taskId);
        if (t && !t.workers) t.rate = n / (ms / 1000);   // with CPU threads too, their reports add the GPU's rate
        this.emit();
      };
      g.onFound = (f) => {
        const t = this.tasks.get(f.taskId);
        if (!t) return;
        this.found(t, f.zeros, f.nonce, f.hash);
        if (f.zeros >= this.required(t)) this.schedule();   // bar met: move the GPU on now, not next block
      };
      g.onFail = (why) => {
        this.gpuHasher = null;
        Object.assign(this.gpu, { available: false, rate: 0, task: null, error: why });
        this.schedule();
        this.emit();
      };
      this.schedule();
      this.emit();
    });
  }

  private progress(taskId: string, n: number) {
    const t = this.tasks.get(taskId);
    if (t) t.hashes += n;
    this.totalHashes += n;
    this.rateWindow.push({ t: performance.now(), n });
  }

  private found(t: PowTask, zeros: number, nonce: string, hash: string) {
    if (t.best && zeros <= t.best.zeros) return;
    t.best = { zeros, nonce, hash };
    if (leader.isLeader && t.status !== 'submitting' && t.status !== 'done' && zeros >= this.required(t) && this.settings.autoSubmit && !(t.holdUntil && live.height < t.holdUntil)) this.submit(t);
    this.emit();
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; taskId: string; zeros?: number; nonce?: string; hash?: string; hashes?: number; ms?: number };
      const t = this.tasks.get(m.taskId);
      if (!t) return;
      if (m.type === 'progress') {
        this.progress(t.id, m.hashes!);
        const r = m.hashes! / (m.ms! / 1000) * t.workers + (this.gpu.task === t.id ? this.gpu.rate : 0);
        t.rate = t.rate ? t.rate * 0.8 + r * 0.2 : r;
        this.emit();
      } else if (m.type === 'found') this.found(t, m.zeros!, m.nonce!, m.hash!);
    };
    w.onerror = (e) => { console.error('[pow] worker', e.message); };
    return w;
  }

  private sampleRate() {
    const now = performance.now();
    this.rateWindow = this.rateWindow.filter((x) => now - x.t < 4000);
    const n = this.rateWindow.reduce((s, x) => s + x.n, 0);
    this.rate = this.rateWindow.length ? n / 4 : 0;
  }
}

/** The proofs one player owes, from their live state. */
/** The proofs one player owes, from their live state. `signer` grinds and signs for a player we
 * only watch (crew help); without it, watched players owe us nothing. */
function tasksFor(p: PlayerState, signer?: number): PowTask[] {
  const out: PowTask[] = [];
  if (p.account < 0 && signer == null) return out;
  const now = Date.now();
  const base = { account: signer ?? p.account, playerId: p.playerId, best: null, hashes: 0, rate: 0, workers: 0, status: 'idle' as const, createdAt: now };
  const pa = p.planet?.planetAttributes || {};
  const mineStart = num(pa.blockStartOreMine), refineStart = num(pa.blockStartOreRefine);
  for (const s of p.structs.values()) {
    const t = s.type;
    if (!t || s.destroyed) continue;
    if (s.materialized && !s.built && s.blockStartBuild > 0) {
      out.push({ ...base, id: `build:${s.id}:${s.blockStartBuild}`, kind: 'build', objectId: s.id, blockStart: s.blockStartBuild, range: t.buildDifficulty, label: `Build ${t.type} ${s.id}`, prefix: `${s.id}BUILD${s.blockStartBuild}NONCE` });
    }
    if (s.built && s.online && t.planetaryMining && t.planetaryMining !== 'noPlanetaryMining' && mineStart > 0 && s.locationId === p.planetId) {
      out.push({ ...base, id: `mine:${s.id}:${mineStart}`, kind: 'mine', objectId: s.id, planetId: p.planetId, blockStart: mineStart, range: t.oreMiningDifficulty, label: `Mine ore ${s.id}`, prefix: `${s.id}MINE${mineStart}NONCE` });
    }
    if (s.built && s.online && t.planetaryRefinery && t.planetaryRefinery !== 'noPlanetaryRefinery' && refineStart > 0 && p.ore > 0 && s.locationId === p.planetId) {
      out.push({ ...base, id: `refine:${s.id}:${refineStart}`, kind: 'refine', objectId: s.id, planetId: p.planetId, blockStart: refineStart, range: t.oreRefiningDifficulty, label: `Refine ore ${s.id}`, prefix: `${s.id}REFINE${refineStart}NONCE` });
    }
  }
  // A raid: our fleet away at a planet whose raid clock is running (the chain also wants the
  // defender's command ship down — a proof sent before that is refused and the task waits).
  const tgt = p.target;
  const ta = tgt?.planetAttributes || {};
  const raidStart = num(ta.blockStartRaid), shield = num(ta.planetaryShield);
  if (tgt && p.fleet && p.fleet.status === 'away' && raidStart > 0 && shield > 0) {
    const pid = tgt.Planet.id;
    out.push({ ...base, id: `raid:${p.fleetId}:${pid}:${raidStart}`, kind: 'raid', objectId: p.fleetId, planetId: pid, blockStart: raidStart, range: shield, label: `Raid ${pid}`, prefix: `${p.fleetId}@${pid}RAID${raidStart}NONCE` });
  }
  if (signer != null && p.account < 0) for (const t of out) t.label = `${p.name}: ${t.label}`;
  return out;
}

export const pow = new PowEngine();
