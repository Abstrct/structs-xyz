/* In-browser check of the WebGPU hasher (not part of the app): `pnpm vite --port 5183`, open
 * /scripts/gpu-check/ in a WebGPU browser. Grinds several prefix shapes, re-hashes every proof
 * with @noble/hashes, switches tasks mid-flight, and reports the hashrate as window.__gpuCheck. */
import { GpuHasher, gpuLayout, hexZeros, proofHex } from '../../src/pow/gpu';

const out = document.getElementById('log')!;
const log = (s: string) => { out.textContent += '\n' + s; console.log(s); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const result: Record<string, unknown> = { done: false, ok: false };
(window as unknown as { __gpuCheck: unknown }).__gpuCheck = result;

const PREFIXES = [
  '5-431197BUILD3005708NONCE',                      // one block, word 8
  '9-3297@2-50363RAID3001000NONCE',                 // one block, word 9
  'p'.repeat(40),                                   // digits pushed to block 2, word 0
  '5-1BUILD9NONCE' + 'q'.repeat(86),                // two blocks, word 11
];

async function main() {
  const g = await GpuHasher.open({ allowFallback: true });
  if (!g) { result.error = 'no WebGPU adapter'; log('no WebGPU'); result.done = true; return; }
  log(`adapter: ${g.adapter}; self-test passed`);
  const g2 = await GpuHasher.open();
  result.fallbackRefused = g2 === null;
  g2?.destroy();
  result.adapter = g.adapter;
  const found: { taskId: string; zeros: number; nonce: string; hash: string; ok: boolean }[] = [];
  let hashes = 0;
  g.onFound = (f) => {
    const prefix = PREFIXES[+f.taskId];
    const hash = proofHex(prefix + f.nonce);
    const ok = hash === f.hash && hexZeros(hash) === f.zeros;
    found.push({ ...f, ok });
    log(`task ${f.taskId} ${ok ? 'ok ' : 'BAD'} ${f.zeros} zeros  nonce ${f.nonce}  ${f.hash}`);
  };
  g.onProgress = (_t, n) => { hashes += n; };
  g.onFail = (why) => { result.fail = why; log('FAIL ' + why); };
  const per: Record<string, { ms: number; hashes: number; best: number; wi: number }> = {};
  const secs = +(new URLSearchParams(location.search).get('secs') || 4);
  for (let i = 0; i < PREFIXES.length; i++) {
    hashes = 0;
    const t0 = performance.now();
    g.run(String(i), PREFIXES[i], 0);
    await sleep(secs * 1000);
    const ms = performance.now() - t0;
    per[i] = { ms, hashes, best: Math.max(0, ...found.filter((f) => f.taskId === String(i)).map((f) => f.zeros)), wi: gpuLayout(PREFIXES[i]).wi };
    log(`task ${i}: ${(hashes / ms / 1000).toFixed(1)} MH/s over ${(ms / 1000).toFixed(1)} s, best ${per[i].best} zeros (word ${per[i].wi}); engine rate ${(g.rate / 1e6).toFixed(1)} MH/s`);
  }
  // A switch must drop the old task's in-flight results.
  g.run('0', PREFIXES[0], 0);
  await sleep(100);
  g.run('1', PREFIXES[1], 99);
  const before = found.length;
  await sleep(500);
  g.stop();
  await sleep(200);
  const leaked = found.slice(before).filter((f) => f.taskId === '0').length;
  result.per = per;
  result.found = found;
  result.rate = g.rate;
  result.leaked = leaked;
  result.ok = !result.fail && found.length > 0 && found.every((f) => f.ok) && Object.values(per).every((p) => p.best >= 3) && leaked === 0;
  log(`${found.length} proofs, all verified: ${found.every((f) => f.ok)}; leaked after switch: ${leaked}; RESULT ${result.ok ? 'PASS' : 'FAIL'}`);
  result.done = true;
}
main().catch((e) => { result.error = String(e); result.done = true; log('error ' + e); });
