/* Proof-of-work hasher checks: the midstate SHA-256 matches a reference implementation for
 * prefixes that leave one or two tail blocks, nonce editing is exact, and difficulty follows
 * structsd's CalculateDifficulty. */
import { sha256 } from '@noble/hashes/sha2.js';
import { bumpNonce, difficultyAt, digestHex, makeJob, nonceString, setNonce, tryNonce, NONCE_WIDTH } from '../src/pow/sha';

let fails = 0;
const ok = (c: unknown, m: string) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

for (const prefix of ['5-12BUILD3007073NONCE', '9-3297@2-50363RAID3001000NONCE', 'x'.repeat(40), 'y'.repeat(50), 'z'.repeat(64), 'w'.repeat(100), 'v'.repeat(119)]) {
  const job = makeJob(prefix);
  const out = new Int32Array(8);
  let good = true;
  setNonce(job, 999_999_990);
  for (let i = 0; i < 25; i++) {
    tryNonce(job, out);
    const n = nonceString(job);
    if (digestHex(out) !== hex(sha256(new TextEncoder().encode(prefix + n)))) good = false;
    bumpNonce(job);
  }
  ok(good, `midstate hash matches reference (prefix ${prefix.length} bytes)`);
}
const j = makeJob('a'); setNonce(j, 42); ok(nonceString(j) === '42'.padStart(NONCE_WIDTH, '0'), 'nonce digits written exactly');
ok(difficultyAt(1, 200) === 64 && difficultyAt(200, 200) === 1 && difficultyAt(100, 200) === 64 - Math.floor(Math.log10(100) / Math.log10(200) * 63), 'difficulty curve');

// Speed sample.
const job = makeJob('5-431197BUILD3005708NONCE');
const t0 = performance.now(); let n = 0;
while (performance.now() - t0 < 500) { for (let i = 0; i < 10000; i++) { tryNonce(job); bumpNonce(job); } n += 10000; }
console.log(`     ${(n / ((performance.now() - t0) / 1000) / 1e6).toFixed(2)} MH/s on one thread`);
if (fails) process.exit(1);
console.log('pow: all checks passed');
