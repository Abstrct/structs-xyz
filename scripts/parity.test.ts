/* Lockstep parity: the TypeScript combat port against the original
 * structs-universe simulator-chain.js / simulator-ai.js. Every block, every
 * event and every AI decision must match. Skips if structs-universe is not
 * checked out beside this repo (or at $STRUCTS_UNIVERSE). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { Chain } from '../src/sim/chain';
import { Ai, type Difficulty } from '../src/sim/ai';
import { layout, chainSetup, YOU, CPU, type Preset } from '../src/sim/fleets';

const root = process.env.STRUCTS_UNIVERSE || path.resolve(process.cwd(), '../structs-universe');
const dir = path.join(root, 'frontend');
if (!fs.existsSync(path.join(dir, 'simulator-chain.js'))) { console.log('parity: structs-universe not found at', root, '— skipped'); process.exit(0); }
vm.runInThisContext(fs.readFileSync(path.join(dir, 'simulator-chain.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(dir, 'simulator-ai.js'), 'utf8'));
const JSChain = (globalThis as any).SimulatorChain;
const JSAi = (globalThis as any).SimulatorAi;

// The port adds `msg` to tx results and trims error suffixes; nothing else may differ.
const DROP = new Set(['msg', 'error']);
const norm = (x: any): any => Array.isArray(x) ? x.map(norm) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().filter((k) => !DROP.has(k)).map((k) => [k, norm(x[k])])) : x;

let mismatches = 0, blocks = 0, txs = 0, decisions = 0, aiMismatch = 0;
for (const p of ['easy', 'difficult', 'hard', 'random'] as Preset[]) for (let g = 0; g < 10; g++) {
  const seed = 'parity' + p + g;
  const { setup } = chainSetup(layout(p, seed), seed, { player: 9, computer: 9 });
  const a = new Chain(JSON.parse(JSON.stringify(setup)));
  const b = new JSChain(JSON.parse(JSON.stringify(setup)));
  const lvl = (['easy', 'difficult', 'hard'] as Difficulty[])[g % 3];
  const ais = [[new Ai(YOU.id, 'hard', seed + 'a'), new JSAi(YOU.id, 'hard', seed + 'a')], [new Ai(CPU.id, lvl, seed + 'b'), new JSAi(CPU.id, lvl, seed + 'b')]] as const;
  let rng = g * 7 + 1;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  for (let i = 0; i < 300; i++) {
    for (const [ta, ja] of ais) {
      if (rand() < 0.5) {
        const m1 = ta.decide(a), m2 = ja.decide(b); decisions++;
        if (JSON.stringify(m1) !== JSON.stringify(m2)) aiMismatch++;
        if (m1) { a.submit(ta.pid, m1); b.submit(ta.pid, m1); }
      }
    }
    if (rand() < 0.3) {   // noise: stealth, (de)activation, defense clears, moves (some invalid)
      const ids = Object.keys(a.structs); const id = ids[Math.floor(rand() * ids.length)]; const s = a.structs[id];
      const kinds = ['MsgStructStealthActivate', 'MsgStructDeactivate', 'MsgStructActivate', 'MsgStructDefenseClear', 'MsgStructMove'];
      const k = '/structs.structs.' + kinds[Math.floor(rand() * kinds.length)];
      const msg: any = k.endsWith('DefenseClear') ? { '@type': k, defenderStructId: id } : k.endsWith('Move') ? { '@type': k, structId: id, locationType: 'fleet', ambit: ['space', 'air', 'land', 'water', 'local'][Math.floor(rand() * 5)], slot: Math.floor(rand() * 4) } : { '@type': k, structId: id };
      a.submit(s.owner, msg); b.submit(s.owner, msg);
    }
    const ba = a.produceBlock(), bb = b.produceBlock(); blocks++; txs += ba.txs.length;
    const same = JSON.stringify(norm({ txs: ba.txs, events: ba.events })) === JSON.stringify(norm({ txs: bb.txs, events: bb.events }))
      && JSON.stringify(norm({ s: a.structs, p: a.players, f: a.fleets, d: a.defenders, q: a.destructionQueue })) === JSON.stringify(norm({ s: b.structs, p: b.players, f: b.fleets, d: b.defenders, q: b.destructionQueue }));
    if (!same) { mismatches++; console.error('parity: block mismatch', p, g, ba.height); break; }
    if (a.fleetsAtBattle().length < 2) break;
  }
}
console.log('parity:', { blocks, txs, decisions, mismatches, aiMismatch });
if (mismatches || aiMismatch) process.exit(1);
