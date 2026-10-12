/* The GPU engine: WebGPU SHA-256 proof-of-work, ~100× a CPU thread.
 *
 * Nonce layout. The chain takes any string as the nonce, so the GPU's nonces are shaped to
 * suit SHA-256 rather than a counter: `epoch` (f ≥ 5 fixed digits) then 8 varying digits that
 * land on a whole-word boundary in the message's last block, with room for the padding:
 *
 *     prefix … | epoch digits | DDDD DDDD | 0x80 … length      (last block, 64 bytes)
 *                               w[wi] w[wi+1]
 *
 * So every block before the last is constant per epoch (the CPU compresses it: the midstate),
 * and in the last block rounds 0..wi-1 only read constant words (the CPU runs them too). Each
 * GPU thread owns one `row` (the first 6 varying digits: w[wi] and half of w[wi+1]), does round
 * wi once, then tries the 100 values of the last two digits. An epoch is 10⁶ rows = 10⁸ nonces.
 *
 * Each dispatch reports, per zero count z above the task's best, one index that hit exactly z
 * (slot z; slot 0 holds the max). Any index found in a slot is therefore a real hit, with no
 * read-modify-write race. Every proof is re-hashed on the CPU with @noble/hashes before it is
 * believed; a mismatch switches the engine off. */
import { sha256 } from '@noble/hashes/sha2.js';

/* ── CPU side: layout, precompute, decoding (pure; unit-tested in scripts/gpu.test.ts) ── */

export const ROWS_PER_EPOCH = 1_000_000;
export const PER_ROW = 100;
const MIN_FIXED = 5;

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
const g0 = (x: number) => rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
const g1 = (x: number) => rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10);

/** SHA-256 rounds [from, to) on state `s` (a..h) with schedule `w`, in place. */
function rounds(s: Uint32Array, w: ArrayLike<number>, from: number, to: number) {
  let a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
  for (let i = from; i < to; i++) {
    const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  s[0] = a; s[1] = b; s[2] = c; s[3] = d; s[4] = e; s[5] = f; s[6] = g; s[7] = h;
}

function expand(w16: ArrayLike<number>): Uint32Array {
  const w = new Uint32Array(64);
  for (let i = 0; i < 16; i++) w[i] = w16[i];
  for (let i = 16; i < 64; i++) w[i] = (g1(w[i - 2]) + w[i - 7] + g0(w[i - 15]) + w[i - 16]) | 0;
  return w;
}

function compressBlock(st: Uint32Array, bytes: Uint8Array, off: number) {
  const w16 = new Uint32Array(16);
  for (let i = 0; i < 16; i++) { const j = off + i * 4; w16[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]; }
  const s = st.slice();
  rounds(s, expand(w16), 0, 64);
  for (let i = 0; i < 8; i++) st[i] = (st[i] + s[i]) | 0;
}

export interface GpuLayout {
  prefix: Uint8Array;
  fixed: number;       // epoch digits
  at: number;          // byte offset of the 8 varying digits (multiple of 4)
  wi: number;          // word of the last block holding the first 4 varying digits
  epochs: number;      // distinct epochs worth using
}

/** Where the varying digits go for `prefix`: word-aligned, ≥5 epoch digits before them, and
 *  the 8 digits + 0x80 + 8-byte length all inside one block (offset in block ≤ 44). */
export function gpuLayout(prefix: string): GpuLayout {
  const p = new TextEncoder().encode(prefix);
  let at = Math.ceil((p.length + MIN_FIXED) / 4) * 4;
  if (at % 64 > 44) at = Math.ceil(at / 64) * 64;
  const fixed = at - p.length;
  return { prefix: p, fixed, at, wi: (at % 64) / 4, epochs: fixed >= 9 ? 1e9 : 10 ** fixed };
}

export interface EpochJob {
  epoch: string;       // the fixed digits
  mid: Uint32Array;    // chaining value entering the last block
  pre: Uint32Array;    // a..h after rounds 0..wi-1 of the last block
  tpl: Uint32Array;    // the last block's 16 words (varying words zero)
}

export function epochJob(L: GpuLayout, epoch: number): EpochJob {
  const e = String(epoch).padStart(L.fixed, '0');
  const len = L.at + 8;
  const total = Math.floor(L.at / 64) * 64 + 64;
  const m = new Uint8Array(total);
  m.set(L.prefix, 0);
  for (let i = 0; i < L.fixed; i++) m[L.prefix.length + i] = e.charCodeAt(i);
  m[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, Math.floor(bits / 2 ** 32));
  dv.setUint32(total - 4, bits >>> 0);
  const mid = new Uint32Array(IV);
  for (let o = 0; o + 64 < total; o += 64) compressBlock(mid, m, o);
  const tpl = new Uint32Array(16);
  for (let i = 0; i < 16; i++) tpl[i] = dv.getUint32(total - 64 + i * 4);
  const pre = mid.slice();
  rounds(pre, tpl, 0, L.wi);
  return { epoch: e, mid, pre, tpl };
}

/** Four ASCII digits of x (< 10⁴) as one big-endian word, the way the shader builds them. */
export const ascii4 = (x: number) =>
  ((((x / 1000) | 0) + 48) << 24 | ((((x / 100) | 0) % 10 + 48) << 16) | ((((x / 10) | 0) % 10 + 48) << 8) | (x % 10 + 48)) >>> 0;

/** The varying words for thread `row`, try `k` (0..99). */
export function varWords(row: number, k: number): [number, number] {
  const hi = ascii4((row / 100) | 0);
  const lo = ((((row / 10) | 0) % 10 + 48) << 24 | ((row % 10) + 48) << 16 | (((k / 10) | 0) + 48) << 8 | ((k % 10) + 48)) >>> 0;
  return [hi, lo];
}

export const gpuNonce = (job: EpochJob, row: number, k: number) => job.epoch + String(row * PER_ROW + k).padStart(8, '0');

/** What one GPU thread computes, step for step (pre-state → round wi → rounds wi+1..63). */
export function kernelRef(L: GpuLayout, job: EpochJob, row: number, k: number): Uint32Array {
  const [hi, lo] = varWords(row, k);
  const w16 = job.tpl.slice();
  w16[L.wi] = hi; w16[L.wi + 1] = lo;
  const s = job.pre.slice();
  const w = expand(w16);
  rounds(s, w, L.wi, L.wi + 1);
  rounds(s, w, L.wi + 1, 64);
  for (let i = 0; i < 8; i++) s[i] = (s[i] + job.mid[i]) >>> 0;
  return s;
}

export function zerosOf(st: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < 8; i++) { const c = Math.clz32(st[i]) >>> 2; n += c; if (c < 8) break; }
  return n;
}

/** Best hit in a readback: [maxZeros, idx+1 for z=1..64]. */
export function decodeSlots(a: Uint32Array): { zeros: number; index: number } | null {
  const z = a[0];
  if (!z || z > 64 || !a[z]) return null;
  return { zeros: z, index: a[z] - 1 };
}

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const proofHex = (preimage: string) => hexOf(sha256(new TextEncoder().encode(preimage)));
export const hexZeros = (hex: string) => { let n = 0; while (n < hex.length && hex[n] === '0') n++; return n; };

/* ── The shader, generated per `wi` so every word index is a constant ─────────────────── */

const XYZW = 'xyzw';
const u = (n: number) => `0x${(n >>> 0).toString(16)}u`;

export function shaderSource(wi: number): string {
  const wl = wi + 1;
  // Which schedule words move with the last two digits (word wl)? The rest are per thread.
  const dep = new Array<boolean>(64).fill(false);
  dep[wl] = true;
  for (let j = 16; j < 64; j++) dep[j] = dep[j - 2] || dep[j - 7] || dep[j - 15] || dep[j - 16];
  const word = (i: number) => (i < 16 ? `let w${i} = P[${4 + (i >> 2)}].${XYZW[i & 3]};` : `let w${i} = g1(w${i - 2}) + w${i - 7} + g0(w${i - 15}) + w${i - 16};`);
  const round = (i: number) => `t1 = h + S1(e) + ch(e, f, g) + ${u(K[i])} + w${i}; t2 = S0(a) + mj(a, b, c); h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;`;
  const outer: string[] = [], inner: string[] = [];
  for (let i = 0; i < 64; i++) {
    if (i === wi) outer.push(`let w${i} = hiw;`);
    else if (i === wl) inner.push(`let w${i} = low | ((k / 10u + 48u) << 8u) | (k % 10u + 48u);`);
    else if (i < 16 || !dep[i]) outer.push(word(i));
    else inner.push(word(i));
  }
  for (let i = wl; i < 64; i++) inner.push(round(i));
  return /* wgsl */ `
@group(0) @binding(0) var<uniform> P: array<vec4<u32>, 9>;   // pre(2) mid(2) tpl(4) ctl(base, rows, floor, -)
@group(0) @binding(1) var<storage, read_write> best: array<atomic<u32>, 65>;

fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }
fn S0(x: u32) -> u32 { return rotr(x, 2u) ^ rotr(x, 13u) ^ rotr(x, 22u); }
fn S1(x: u32) -> u32 { return rotr(x, 6u) ^ rotr(x, 11u) ^ rotr(x, 25u); }
fn g0(x: u32) -> u32 { return rotr(x, 7u) ^ rotr(x, 18u) ^ (x >> 3u); }
fn g1(x: u32) -> u32 { return rotr(x, 17u) ^ rotr(x, 19u) ^ (x >> 10u); }
fn ch(x: u32, y: u32, z: u32) -> u32 { return (x & y) ^ (~x & z); }
fn mj(x: u32, y: u32, z: u32) -> u32 { return (x & y) ^ (x & z) ^ (y & z); }
fn ascii4(x: u32) -> u32 {
  return ((x / 1000u + 48u) << 24u) | (((x / 100u) % 10u + 48u) << 16u) | (((x / 10u) % 10u + 48u) << 8u) | (x % 10u + 48u);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ctl = P[8];
  let t = gid.x;
  if (t >= ctl.y) { return; }
  let row = ctl.x + t;
  let hiw = ascii4(row / 100u);
  let low = (((row / 10u) % 10u + 48u) << 24u) | ((row % 10u + 48u) << 16u);
  ${outer.join('\n  ')}
  var a = P[0].x; var b = P[0].y; var c = P[0].z; var d = P[0].w;
  var e = P[1].x; var f = P[1].y; var g = P[1].z; var h = P[1].w;
  var t1: u32; var t2: u32;
  ${round(wi)}
  let A = a; let B = b; let C = c; let D = d; let E = e; let F = f; let G = g; let H = h;
  for (var k = 0u; k < ${PER_ROW}u; k++) {
    a = A; b = B; c = C; d = D; e = E; f = F; g = G; h = H;
    ${inner.join('\n    ')}
    let h0 = P[2].x + a;
    var z = countLeadingZeros(h0) >> 2u;
    if (z == 8u) {
      var o = array<u32, 8>(h0, P[2].y + b, P[2].z + c, P[2].w + d, P[3].x + e, P[3].y + f, P[3].z + g, P[3].w + h);
      for (var i = 1u; i < 8u; i++) { let n = countLeadingZeros(o[i]) >> 2u; z += n; if (n < 8u) { break; } }
    }
    if (z > ctl.z) { atomicMax(&best[0], z); atomicStore(&best[z], t * ${PER_ROW}u + k + 1u); }
  }
}`;
}

/* ── The engine ───────────────────────────────────────────────────────────────────────── */

export interface GpuFound { taskId: string; zeros: number; nonce: string; hash: string }

interface Task { id: string; prefix: string; layout: GpuLayout; epoch: number; job: EpochJob; row: number; floor: number }
interface Slot { uni: GPUBuffer; res: GPUBuffer; read: GPUBuffer; bind: GPUBindGroup }
interface Flight { slot: Slot; task: Task; job: EpochJob; base: number; rows: number; done: Promise<Uint32Array> }

const TARGET_MS = 40;
const MIN_ROWS = 16;
// Usage flags (lib.dom has the types but not the GPUBufferUsage constants).
const MAP_READ = 1, COPY_SRC = 4, COPY_DST = 8, UNIFORM = 64, STORAGE = 128, COMPUTE = 4;

export class GpuHasher {
  adapter = '';
  rate = 0;              // hashes / s, smoothed
  task: string | null = null;
  error = '';
  onFound: (f: GpuFound) => void = () => {};
  onProgress: (taskId: string, hashes: number, ms: number) => void = () => {};
  onFail: (why: string) => void = () => {};

  private pipes = new Map<number, Promise<GPUComputePipeline>>();
  private layout: GPUBindGroupLayout;
  private slots: Slot[];
  private cur: Task | null = null;
  private rows = 256;
  private spinning = false;
  private dead = false;
  private acc = { n: 0, t: 0 };

  private constructor(private device: GPUDevice, adapter: string) {
    this.adapter = adapter;
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: COMPUTE, buffer: { type: 'storage' } },
    ] });
    this.slots = [0, 1].map(() => {
      const uni = device.createBuffer({ size: 144, usage: UNIFORM | COPY_DST });
      const res = device.createBuffer({ size: 65 * 4, usage: STORAGE | COPY_SRC | COPY_DST });
      const read = device.createBuffer({ size: 65 * 4, usage: MAP_READ | COPY_DST });
      const bind = device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: { buffer: uni } }, { binding: 1, resource: { buffer: res } }] });
      return { uni, res, read, bind };
    });
    device.lost.then((info) => { if (!this.dead) this.fail(`device lost: ${info.message || info.reason}`); });
    device.addEventListener('uncapturederror', (e) => this.fail(`webgpu: ${(e as GPUUncapturedErrorEvent).error.message}`));
  }

  /** A hasher on the best GPU, or null where WebGPU isn't there (never throws). A software
   *  fallback adapter (SwiftShader) would only steal cores from the CPU workers, so it's
   *  refused unless `allowFallback` (the browser check page uses it). */
  static async open(opts: { allowFallback?: boolean } = {}): Promise<GpuHasher | null> {
    try {
      const gpu = (typeof navigator !== 'undefined' && navigator.gpu) || null;
      if (!gpu) return null;
      const ad = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!ad) return null;
      const fallback = (ad.info as { isFallbackAdapter?: boolean } | undefined)?.isFallbackAdapter || (ad as { isFallbackAdapter?: boolean }).isFallbackAdapter;
      if (fallback && !opts.allowFallback) return null;
      const dev = await ad.requestDevice();
      const i = ad.info;
      const name = [i?.vendor, i?.architecture, i?.device || i?.description].filter(Boolean).join(' ') || 'WebGPU';
      const h = new GpuHasher(dev, name);
      if (!(await h.selfTest())) { h.fail('self-test: GPU hashes disagree with the CPU'); return null; }
      return h.dead ? null : h;
    } catch (e) {
      console.info('[pow] no GPU engine:', (e as Error).message);
      return null;
    }
  }

  /** Grind `prefix` for proofs better than `floor` zeros (switches immediately). */
  run(taskId: string, prefix: string, floor: number) {
    if (this.dead) return;
    if (this.cur?.id === taskId) { this.cur.floor = Math.max(this.cur.floor, floor); return; }
    const layout = gpuLayout(prefix);
    const epoch = Math.floor(Math.random() * layout.epochs);
    this.cur = { id: taskId, prefix, layout, epoch, job: epochJob(layout, epoch), row: 0, floor };
    this.task = taskId;
    this.acc = { n: 0, t: performance.now() };
    void this.pipeline(layout.wi);
    if (!this.spinning) { this.spinning = true; void this.spin(); }
  }

  stop() { this.cur = null; this.task = null; }

  destroy() {
    this.stop();
    this.dead = true;
    this.device.destroy();
  }

  private pipeline(wi: number): Promise<GPUComputePipeline> {
    let p = this.pipes.get(wi);
    if (!p) {
      p = this.device.createComputePipelineAsync({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        compute: { module: this.device.createShaderModule({ code: shaderSource(wi) }), entryPoint: 'main' },
      });
      p.catch((e) => this.fail(`shader: ${(e as Error).message}`));
      this.pipes.set(wi, p);
    }
    return p;
  }

  /* Two dispatches in flight: the GPU never waits on a readback, and a task switch lands
   * within one dispatch (~40 ms). Results for a task that's no longer current are dropped. */
  private async spin() {
    const flights: Flight[] = [];
    let lastDone = 0, measured = false;
    let win = { n: 0, t: 0 };
    try {
      while (!this.dead && (this.cur || flights.length)) {
        while (this.cur && flights.length < 2 && !this.dead) {
          const free = this.slots.find((s) => !flights.some((f) => f.slot === s))!;
          const f = await this.dispatch(free, this.cur);
          if (!f) break;
          if (!flights.length) { lastDone = performance.now(); win = { n: 0, t: lastDone }; }
          flights.push(f);
        }
        const f = flights.shift();
        if (!f) continue;     // the task switched mid-dispatch: go again with the new one
        let a: Uint32Array;
        try { a = await f.done; } catch (e) { this.fail(`readback: ${(e as Error).message}`); break; }
        const now = performance.now();
        const gap = now - lastDone;
        lastDone = now;
        const hashes = f.rows * PER_ROW;
        // Size dispatches to TARGET_MS from throughput over half-second windows (completions
        // can land in the same tick, so single gaps lie); before the first window, ramp up.
        win.n += hashes;
        if (now - win.t >= 500) {
          const perMs = win.n / (now - win.t);
          this.rate = measured ? this.rate * 0.7 + perMs * 300 : perMs * 1000;
          this.rows = Math.round(Math.min(ROWS_PER_EPOCH, Math.max(MIN_ROWS, (perMs * TARGET_MS) / PER_ROW)));
          win = { n: 0, t: now };
          measured = true;
        } else if (!measured && gap < TARGET_MS / 2) this.rows = Math.min(ROWS_PER_EPOCH, this.rows * 2);
        if (f.task !== this.cur) continue;
        this.acc.n += hashes;
        if (now - this.acc.t > 250) { this.onProgress(f.task.id, this.acc.n, now - this.acc.t); this.acc = { n: 0, t: now }; }
        const hit = decodeSlots(a);
        if (hit && hit.zeros > f.task.floor) this.report(f, hit.zeros, hit.index);
      }
    } finally {
      this.spinning = false;   // synchronous with the exit, so run() can never miss a stopped loop
    }
  }

  private async dispatch(slot: Slot, task: Task): Promise<Flight | null> {
    const pipe = await this.pipeline(task.layout.wi).catch(() => null);
    if (!pipe || this.dead || task !== this.cur) return null;
    const job = task.job, base = task.row;
    const rows = Math.min(this.rows, ROWS_PER_EPOCH - base);
    const done = this.launch(slot, pipe, job, base, rows, task.floor);
    task.row += rows;
    if (task.row >= ROWS_PER_EPOCH) {
      task.epoch = (task.epoch + 1) % task.layout.epochs;
      task.job = epochJob(task.layout, task.epoch);
      task.row = 0;
    }
    return { slot, task, job, base, rows, done };
  }

  /** One dispatch over rows [base, base+rows) of `job`; resolves to the readback slots. */
  private launch(slot: Slot, pipe: GPUComputePipeline, job: EpochJob, base: number, rows: number, floor: number): Promise<Uint32Array> {
    const u = new Uint32Array(36);
    u.set(job.pre, 0); u.set(job.mid, 8); u.set(job.tpl, 16);
    u[32] = base; u[33] = rows; u[34] = floor;
    this.device.queue.writeBuffer(slot.uni, 0, u);
    const enc = this.device.createCommandEncoder();
    enc.clearBuffer(slot.res);
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, slot.bind);
    pass.dispatchWorkgroups(Math.ceil(rows / 64));
    pass.end();
    enc.copyBufferToBuffer(slot.res, 0, slot.read, 0, 65 * 4);
    this.device.queue.submit([enc.finish()]);
    return slot.read.mapAsync(1).then(() => {
      const a = new Uint32Array(slot.read.getMappedRange()).slice();
      slot.read.unmap();
      return a;
    });
  }

  /** A small dispatch checked against the CPU mirror before the engine is trusted: the max
   *  must match a full CPU search of the same 4000 nonces (so no thread skipped work or ran
   *  past its bound), and every slot's nonce must hash to exactly its zero count. */
  private async selfTest(): Promise<boolean> {
    const prefix = '5-431197BUILD3005708NONCE', L = gpuLayout(prefix), job = epochJob(L, 4242), rows = 40;
    const a = await this.launch(this.slots[0], await this.pipeline(L.wi), job, 0, rows, 0);
    let max = 0;
    for (let r = 0; r < rows; r++) for (let k = 0; k < PER_ROW; k++) max = Math.max(max, zerosOf(kernelRef(L, job, r, k)));
    if (a[0] !== max) return false;
    for (let z = 1; z <= 64; z++) {
      if (!a[z]) continue;
      const i = a[z] - 1;
      if (z > max || i >= rows * PER_ROW || hexZeros(proofHex(prefix + gpuNonce(job, Math.floor(i / PER_ROW), i % PER_ROW))) !== z) return false;
    }
    return true;
  }

  /** Re-hash on the CPU before believing anything the GPU says. */
  private report(f: Flight, zeros: number, index: number) {
    const row = f.base + Math.floor(index / PER_ROW), k = index % PER_ROW;
    if (row - f.base >= f.rows) { this.fail(`index ${index} outside dispatch of ${f.rows} rows`); return; }
    const nonce = gpuNonce(f.job, row, k);
    const hash = proofHex(f.task.prefix + nonce);
    if (hexZeros(hash) !== zeros) { this.fail(`proof mismatch: GPU claimed ${zeros} zeros, CPU got ${hash} for nonce ${nonce}`); return; }
    f.task.floor = zeros;
    this.onFound({ taskId: f.task.id, zeros, nonce, hash });
  }

  private fail(why: string) {
    if (this.dead) return;
    console.warn('[pow] GPU engine disabled:', why);
    this.error = why;
    this.dead = true;
    this.cur = null; this.task = null; this.rate = 0;
    try { this.device.destroy(); } catch { /* already gone */ }
    this.onFail(why);
  }
}
