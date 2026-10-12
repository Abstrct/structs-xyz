/* GPU engine checks that run without a GPU: the nonce layout keeps the varying digits
 * word-aligned inside one final block, the CPU precompute (midstate + early rounds) plus the
 * shader's per-thread algorithm (mirrored in kernelRef) reproduce SHA-256 of prefix+nonce
 * exactly, readbacks decode, and the generated WGSL has the shape the kernel expects. The
 * shader itself is verified in a real browser by scripts/gpu-check/ (see its README line). */
import { sha256 } from '@noble/hashes/sha2.js';
import { ascii4, decodeSlots, epochJob, gpuLayout, gpuNonce, hexZeros, kernelRef, proofHex, shaderSource, varWords, zerosOf, PER_ROW, ROWS_PER_EPOCH } from '../src/pow/gpu';

let fails = 0;
const ok = (c: unknown, m: string) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const hex = (w: ArrayLike<number>) => Array.from(w, (x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
const ref = (s: string) => Array.from(sha256(new TextEncoder().encode(s)), (x) => x.toString(16).padStart(2, '0')).join('');

ok(ascii4(0) === 0x30303030 && ascii4(1234) === 0x31323334 && ascii4(9999) === 0x39393939, 'ascii4 packs big-endian digits');
{
  const [hi, lo] = varWords(123456, 78);
  ok(hi === 0x31323334 && lo === 0x35363738, 'row 123456, try 78 → digits 12345678');
}

// Every prefix length from 0 to 140 bytes: layout invariants and exact hashes.
let layoutsOk = true, hashesOk = true, maxNonce = 0;
const wis = new Set<number>();
for (let n = 0; n <= 140; n++) {
  const prefix = ('5-431197BUILD3005708NONCE' + 'x'.repeat(200)).slice(0, n);
  const L = gpuLayout(prefix);
  wis.add(L.wi);
  maxNonce = Math.max(maxNonce, L.fixed + 8);
  if (L.at % 4 || L.fixed < 5 || L.at % 64 > 44 || L.at !== n + L.fixed || L.wi !== (L.at % 64) / 4) layoutsOk = false;
  const job = epochJob(L, 31337 % L.epochs);
  for (const [row, k] of [[0, 0], [1, 7], [99, 99], [123456, 42], [ROWS_PER_EPOCH - 1, PER_ROW - 1]]) {
    const nonce = gpuNonce(job, row, k);
    if (nonce.length !== L.fixed + 8 || !/^\d+$/.test(nonce)) hashesOk = false;
    if (hex(kernelRef(L, job, row, k)) !== ref(prefix + nonce)) { hashesOk = false; console.error('  mismatch at prefix length', n, row, k); }
  }
}
ok(layoutsOk, 'layout: word-aligned, ≥5 epoch digits, digits+padding fit the last block (lengths 0–140)');
ok(hashesOk, 'kernel mirror (midstate + pre-rounds + per-thread rounds) equals SHA-256(prefix+nonce)');
console.log(`     word indices used: ${[...wis].sort((a, b) => a - b).join(',')}; longest nonce ${maxNonce} chars`);

// The real prefixes from the brief, a whole epoch boundary apart.
for (const prefix of ['5-431197BUILD3005708NONCE', '9-3297@2-50363RAID3001000NONCE']) {
  const L = gpuLayout(prefix);
  const a = epochJob(L, 0), b = epochJob(L, L.epochs - 1);
  const good = [a, b].every((j) => hex(kernelRef(L, j, 4242, 17)) === ref(prefix + gpuNonce(j, 4242, 17)));
  ok(good && a.epoch !== b.epoch, `${prefix}: ${L.fixed}+8 digit nonces, word ${L.wi}, first and last epoch hash right`);
}

// A brute-force hit at low difficulty, found the way the shader finds it.
{
  const prefix = '9-3297@2-50363RAID3001000NONCE';
  const L = gpuLayout(prefix), job = epochJob(L, 7);
  let best = { z: 0, idx: -1 };
  for (let row = 0; row < 200 && best.z < 4; row++) for (let k = 0; k < PER_ROW; k++) {
    const z = zerosOf(kernelRef(L, job, row, k));
    if (z > best.z) best = { z, idx: row * PER_ROW + k };
  }
  const nonce = gpuNonce(job, Math.floor(best.idx / PER_ROW), best.idx % PER_ROW);
  ok(best.z >= 3 && hexZeros(proofHex(prefix + nonce)) === best.z, `search finds a ${best.z}-zero proof, CPU re-hash agrees`);
}

// Readback decoding.
{
  const a = new Uint32Array(65);
  ok(decodeSlots(a) === null, 'empty readback → no hit');
  a[0] = 6; a[6] = 1001; a[5] = 77;
  const d = decodeSlots(a);
  ok(d?.zeros === 6 && d.index === 1000, 'readback → best zeros and its index');
  a[6] = 0;
  ok(decodeSlots(a) === null, 'max without an index is ignored');
}

// Shader shape: every word declared once, rounds wl..63 inside the loop, constant word index.
for (const wi of [0, 6, 7, 11]) {
  const src = shaderSource(wi);
  const decl = [...src.matchAll(/let w(\d+) =/g)].map((m) => +m[1]);
  const once = decl.length === 64 && new Set(decl).size === 64;
  const rounds = (src.match(/t1 = h \+ S1/g) || []).length;
  ok(once && rounds === 64 - wi && src.includes(`let w${wi} = hiw;`), `shader for word ${wi}: 64 words, ${64 - wi} rounds`);
}

if (fails) process.exit(1);
console.log('gpu: all checks passed');
