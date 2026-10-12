/* In-browser check of pow.ts's GPU lane (not part of the app). Offline: a fake chain height,
 * a stubbed wallet account and autoSubmit off, so nothing is ever signed or sent. */
import { live } from '../../src/chain/live';
import { wallet } from '../../src/wallet/wallet';
import { pow, type PowTask } from '../../src/pow/pow';

const out = document.getElementById('log')!;
const log = (s: string) => { out.textContent += '\n' + s; console.log(s); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const result: Record<string, unknown> = { done: false };
(window as unknown as { __gpuCheck: unknown }).__gpuCheck = result;
const schedule = () => (pow as unknown as { schedule(): void }).schedule();

async function main() {
  pow.save({ autoSubmit: false, threads: 2, engine: 'auto' });
  (wallet as unknown as { account: () => unknown }).account = () => ({ index: 0 });
  live.height = 100000;
  const mk = (id: string, prefix: string, blockStart: number, range: number): PowTask => ({
    id, kind: 'build', objectId: id, blockStart, range, account: 0, playerId: '1-1', label: id, prefix,
    best: null, hashes: 0, rate: 0, workers: 0, status: 'idle', createdAt: Date.now(),
  });
  // req for the next block: hard 8, easy 5.
  pow.tasks.set('hard', mk('hard', '5-431197BUILD3005708NONCE', 100000 - 480, 1000));
  pow.tasks.set('easy', mk('easy', '5-7BUILD99000NONCE', 100000 - 2000, 3200));
  const req = (id: string) => pow.required(pow.tasks.get(id)!);
  log(`required: hard ${req('hard')}, easy ${req('easy')}`);
  schedule();
  const snap = (tag: string) => {
    const s = [...pow.tasks.values()].map((t) => `${t.id}:${t.status} cpu×${t.workers} best ${t.best?.zeros ?? '-'} ${(t.rate / 1e6).toFixed(1)}MH/s`).join(' | ');
    log(`${tag} gpu ${JSON.stringify(pow.gpu)} pool ${(pow.rate / 1e6).toFixed(1)} MH/s :: ${s}`);
  };
  for (let i = 0; i < 6; i++) { await sleep(1000); snap(`t+${i + 1}s`); }
  result.auto = { gpu: { ...pow.gpu }, tasks: [...pow.tasks.values()].map((t) => ({ id: t.id, best: t.best, workers: t.workers, status: t.status })) };
  pow.save({ engine: 'cpu' });
  await sleep(1500);
  snap('engine=cpu');
  result.cpu = { gpuTask: pow.gpu.task, workers: [...pow.tasks.values()].reduce((s, t) => s + t.workers, 0) };
  pow.save({ engine: 'gpu' });
  await sleep(1500);
  snap('engine=gpu');
  result.gpuOnly = { gpuTask: pow.gpu.task, workers: [...pow.tasks.values()].reduce((s, t) => s + t.workers, 0) };
  pow.save({ enabled: false });
  await sleep(500);
  snap('disabled');
  result.disabled = { gpuTask: pow.gpu.task, workers: [...pow.tasks.values()].reduce((s, t) => s + t.workers, 0) };
  // Every best proof must check out against SHA-256 of prefix+nonce.
  const { proofHex, hexZeros } = await import('../../src/pow/gpu');
  result.verified = [...pow.tasks.values()].every((t) => !t.best || (proofHex(t.prefix + t.best.nonce) === t.best.hash && hexZeros(t.best.hash) === t.best.zeros));
  log(`verified ${result.verified}`);
  pow.save({ enabled: true, engine: 'auto' });
  result.done = true;
}
main().catch((e) => { result.error = String(e); result.done = true; log('error ' + e); });
