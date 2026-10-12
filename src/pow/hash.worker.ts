/* One hashing thread. Searches nonces for one prefix at a time and reports its best proof
 * (most leading hex zeros) as soon as it improves, plus a hash count a few times a second. */
import { bumpNonce, digestHex, makeJob, nonceString, setNonce, tryNonce, type HashJob } from './sha';

type In = { type: 'start'; taskId: string; prefix: string; start: number; floor: number } | { type: 'stop' };

let job: HashJob | null = null;
let taskId = '';
let token = 0;
const out = new Int32Array(8);

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

self.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  token++;
  if (m.type === 'stop') { job = null; return; }
  job = makeJob(m.prefix);
  taskId = m.taskId;
  setNonce(job, m.start);
  void run(token, m.floor);
};

async function run(my: number, floor: number) {
  let best = floor;        // only report proofs better than what the engine already holds
  let count = 0;
  let lastReport = performance.now();
  while (my === token && job) {
    const j = job;
    for (let i = 0; i < 40000; i++) {
      const z = tryNonce(j, out);
      if (z > best) {
        best = z;
        (self as unknown as Worker).postMessage({ type: 'found', taskId, zeros: z, nonce: nonceString(j), hash: digestHex(out) });
      }
      bumpNonce(j);
    }
    count += 40000;
    const now = performance.now();
    if (now - lastReport > 250) {
      (self as unknown as Worker).postMessage({ type: 'progress', taskId, hashes: count, ms: now - lastReport });
      count = 0;
      lastReport = now;
      await yieldNow();
    }
  }
}
