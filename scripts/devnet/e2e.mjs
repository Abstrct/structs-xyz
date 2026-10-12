// The write-path walk-through, scripted: drives the client in the cdp.mjs Chrome through the
// real UI against the devnet and prints each transaction's journey (queued → signing → pending
// → success, with heights). Needs: setup.sh all, the devnet Vite server, and cdp.mjs running.
//
//   node scripts/devnet/e2e.mjs [mnemonic-file] [--wait-proof]
//
// A fresh devnet (or a fresh Chrome profile) is assumed: the vault import step expects no vault.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CDP = process.env.CDP || 'http://127.0.0.1:9555';
const APP = process.env.APP || 'http://127.0.0.1:5186/';
const LCD = process.env.LCD || 'http://127.0.0.1:31317';
const mnemonicFile = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) || join(here, '.home/test-mnemonic.txt');
const waitProof = process.argv.includes('--wait-proof');
const PASS = 'devnet-pass-123';

const post = async (path, body) => (await fetch(CDP + path, { method: 'POST', body })).json();
const ev = async (js) => { const r = await post('/eval', js); if (r && r.error) throw new Error(r.error); return r; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lcd = async (p) => (await fetch(LCD + p)).json();
const step = (s) => console.log(`\n== ${s}`);
/** Wait for the newest job whose label matches, print its trace. */
const settle = (labelRe, ms = 90000) => ev(`(async()=>{ const e=window.e2e; await e.waitFor(()=>{ const j=[...window.__structs.txq.jobs].reverse().find(j=>${labelRe}.test(j.label)); return j && ['success','failed'].includes(j.status); }, ${ms});
  const j=[...window.__structs.txq.jobs].reverse().find(j=>${labelRe}.test(j.label));
  return { label: j.label, status: j.status, height: j.height, hash: j.hash, error: j.error, path: e.trace.filter(x=>x.id===j.id).map(x=>x.h+':'+x.status+(x.why?'('+x.why+')':'')).join(' → ') }; })()`);

const mnemonic = readFileSync(mnemonicFile, 'utf8').trim();
await post('/nav', APP + '/command');
await sleep(8000);
await ev(readFileSync(join(here, 'helpers.js'), 'utf8'));

step('Vault: import the test phrase and seal it');
console.log(await ev(`(async()=>{ const e=window.e2e; e.click('.wallet-chip'); await e.sleep(400); e.click(/Import phrase/); await e.sleep(300);
  e.type('.phrase-input', ${JSON.stringify(mnemonic)}); e.click(/^\\s*Continue\\s*$/); await e.sleep(300);
  const pw=document.querySelectorAll('.vault input[type=password]'); e.type(pw[0], '${PASS}'); e.type(pw[1], '${PASS}'); e.click(/Seal the vault/);
  await e.waitFor(()=>window.__structs.wallet.state==='unlocked', 20000); await e.sleep(3000); document.querySelector('.vault-back')?.click(); e.traceJobs();
  return window.__structs.wallet.accounts.map(a=>a.address+' → '+(a.playerId||'no player')); })()`));
const pid = await ev('window.__structs.wallet.active.playerId');
if (!pid) throw new Error('the imported key has no player: run setup.sh bootstrap');

step('Explore a planet (if none)');
const player = await lcd(`/structs/player/${pid}`);
if (!player.Player.planetId) {
  await ev(`(async()=>{ const e=window.e2e; await e.waitFor(()=>e.all('.cd-quick button', /^Explore$/)[0], 20000); e.all('.cd-quick button', /^Explore$/)[0].click(); })()`);
  console.log(await settle('/Explore/'));
  await sleep(3000);
} else console.log('has planet', player.Player.planetId);

step('Build: Ore Extractor (empty land slot → pick type), then a charge-gated Ore Refinery');
console.log(await ev(`(async()=>{ const e=window.e2e; await e.waitFor(()=>document.querySelector('.cd-board'), 20000);
  // Distinct slots on purpose: the deck does not mark a slot taken until the first build lands.
  const pick=async(name, i)=>{ const board=document.querySelectorAll('.cd-board')[0]; const row=[...board.querySelectorAll('.cd-row')].find(r=>/land/i.test(r.querySelector('.cd-ambit').textContent));
    row.querySelectorAll('.cd-cell.empty')[i].click(); await e.sleep(400); const b=[...document.querySelectorAll('.cd-buildopt')].find(b=>b.textContent.includes(name)); b.click(); await e.sleep(200); };
  await pick('Ore Extractor', 0); await pick('Ore Refinery', 1); return 'queued two builds'; })()`));
console.log(await settle('/Build Ore Extractor ·/'));
console.log(await settle('/Build Ore Refinery ·/', 120000));

step('Vault → Send alpha (0.5 to HD index 2)');
const to = await ev(`(async()=>{ const { deriveKey } = await import('/src/wallet/keys.ts'); return deriveKey(${JSON.stringify(mnemonic)}, 2).address; })()`);
await ev(`(async()=>{ const e=window.e2e; e.click('.wallet-chip'); await e.sleep(500); e.click(/^Send alpha$/, document.querySelector('.vault')); await e.sleep(400);
  const ins=[...document.querySelectorAll('.vault input')]; e.type(ins[0], '${to}'); ins[0].dispatchEvent(new Event('blur')); e.type(ins[1], '0.5'); await e.sleep(300);
  e.click(/^Send$/, document.querySelector('.vault')); await e.confirm(3000); })()`);
console.log(await settle('/^Send/'));

step('Forge: MsgPlayerUpdateName');
await ev(`(async()=>{ const e=window.e2e; window.__structs.navigate('/forge/MsgPlayerUpdateName'); await e.sleep(1500); const ins=[...document.querySelectorAll('.fg-fields input')]; e.type(ins[1], 'DevnetE2E'); await e.sleep(200); await e.forgeQueue(); })()`);
console.log(await settle('/Update Name/'));
console.log('name on chain:', (await lcd(`/structs/player/${pid}`)).Player.name);

if (waitProof) {
  step('Proof engine: wait for the Ore Extractor build proof (needs the chain clock to bring the bar down to ~7 zeros: ~375 blocks)');
  const t0 = Date.now();
  // Poll from here: one long-running eval would outlive fetch's 300 s header timeout.
  for (;;) {
    const s = await ev(`(()=>{ const j=[...window.__structs.txq.jobs].reverse().find(j=>/Build Ore Extractor .* proof/.test(j.label)); const t=[...window.__structs.pow.tasks.values()].find(t=>t.kind==='build');
      return { h: window.__structs.live.height, job: j && { label: j.label, status: j.status, height: j.height, hash: j.hash, error: j.error }, task: t && { status: t.status, best: t.best && t.best.zeros, need: window.__structs.pow.required(t), rate: Math.round(window.__structs.pow.rate) } }; })()`);
    if (s.job && ['success', 'failed'].includes(s.job.status)) { console.log(s.job); break; }
    console.log(JSON.stringify(s));
    if (Date.now() - t0 > 30 * 60_000) throw new Error('no proof within 30 min');
    await sleep(20000);
  }
  console.log(`proof landed after ${Math.round((Date.now() - t0) / 1000)} s`);
}
console.log('\nlogs:', (await (await fetch(CDP + '/logs')).json()).filter((l) => !/vite|POST/.test(l)).slice(0, 20));
