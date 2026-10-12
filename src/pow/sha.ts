/* Proof-of-work hashing, as structsd checks it (x/structs/types/work.go):
 *   proof = hex(sha256(prefix + nonce)), valid when its first D hex characters are '0',
 *   D = CalculateDifficulty(age, range) = 64 − ⌊log10(age)/log10(range) × 63⌋ (≥1; 64 at age ≤1).
 * The prefix is fixed per job ("5-12BUILD3007073NONCE", "9-4@2-7RAID3001000NONCE"), so the
 * whole 64-byte blocks of it are compressed once (the midstate) and only the tail block that
 * carries the nonce is hashed per try. The nonce is a fixed-width decimal counter edited in
 * place. Plain SHA-256 otherwise; checked against @noble/hashes in the tests. */

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const W = new Int32Array(64);

/** One SHA-256 compression of `block` (64 bytes at `off`) into `st` (8 words), in place. */
export function compress(st: Int32Array, block: Uint8Array, off = 0) {
  for (let i = 0; i < 16; i++) {
    const j = off + i * 4;
    W[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const x = W[i - 15], y = W[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = st[0], b = st[1], c = st[2], d = st[3], e = st[4], f = st[5], g = st[6], h = st[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  st[0] = (st[0] + a) | 0; st[1] = (st[1] + b) | 0; st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
  st[4] = (st[4] + e) | 0; st[5] = (st[5] + f) | 0; st[6] = (st[6] + g) | 0; st[7] = (st[7] + h) | 0;
}

/** Leading hex zeros of a digest held as 8 words. */
export function leadingZeros(st: Int32Array): number {
  let n = 0;
  for (let i = 0; i < 8; i++) {
    const w = st[i];
    if (w === 0) { n += 8; continue; }
    return n + (Math.clz32(w) >>> 2);
  }
  return n;
}

export function digestHex(st: Int32Array): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += (st[i] >>> 0).toString(16).padStart(8, '0');
  return s;
}

export const NONCE_WIDTH = 13;

export interface HashJob {
  mid: Int32Array;     // state after the prefix's whole blocks
  tail: Uint8Array;    // remaining prefix + nonce + padding, 64 or 128 bytes
  nonceAt: number;     // where the nonce digits sit in `tail`
}

/** Precompute a job for `prefix`; nonces are NONCE_WIDTH decimal digits. */
export function makeJob(prefix: string): HashJob {
  const p = new TextEncoder().encode(prefix);
  const whole = Math.floor(p.length / 64) * 64;
  const mid = new Int32Array(IV);
  for (let o = 0; o < whole; o += 64) compress(mid, p, o);
  const rest = p.length - whole;
  const msgLen = p.length + NONCE_WIDTH;
  const tailLen = rest + NONCE_WIDTH + 9 <= 64 ? 64 : 128;
  const tail = new Uint8Array(tailLen);
  tail.set(p.subarray(whole), 0);
  tail.fill(48, rest, rest + NONCE_WIDTH);      // '0' digits
  tail[rest + NONCE_WIDTH] = 0x80;
  const bits = msgLen * 8;
  const dv = new DataView(tail.buffer);
  dv.setUint32(tailLen - 8, Math.floor(bits / 2 ** 32));
  dv.setUint32(tailLen - 4, bits >>> 0);
  return { mid, tail, nonceAt: rest };
}

/** Writes `n` as NONCE_WIDTH digits into the job's tail. */
export function setNonce(job: HashJob, n: number) {
  let x = n;
  for (let i = NONCE_WIDTH - 1; i >= 0; i--) { job.tail[job.nonceAt + i] = 48 + (x % 10); x = Math.floor(x / 10); }
}

/** Adds one to the decimal counter in place (fast path: only the digits that roll). */
export function bumpNonce(job: HashJob) {
  const t = job.tail;
  for (let i = job.nonceAt + NONCE_WIDTH - 1; i >= job.nonceAt; i--) {
    if (t[i] !== 57) { t[i]++; return; }
    t[i] = 48;
  }
}

export function nonceString(job: HashJob): string {
  return String.fromCharCode(...job.tail.subarray(job.nonceAt, job.nonceAt + NONCE_WIDTH));
}

const scratch = new Int32Array(8);
/** Hash the job's current nonce; returns its leading zero count (digest left in `out`). */
export function tryNonce(job: HashJob, out: Int32Array = scratch): number {
  out.set(job.mid);
  compress(out, job.tail, 0);
  if (job.tail.length === 128) compress(out, job.tail, 64);
  return leadingZeros(out);
}

/** structsd's CalculateDifficulty. */
export function difficultyAt(age: number, range: number): number {
  if (age <= 1) return 64;
  const d = 64 - Math.floor((Math.log10(age) / Math.log10(range)) * 63);
  return d < 1 ? 1 : d;
}
