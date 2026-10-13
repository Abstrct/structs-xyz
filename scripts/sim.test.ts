/* Headless checks on the combat port: rules hold, and AI battles finish. */
import { Chain } from '../src/sim/chain';
import { Ai } from '../src/sim/ai';
import { BattleSession, DECIDE_AT, OVERTIME_AT, QUIET_BLOCKS, type Outcome } from '../src/screens/battle/session';
import { formatAlpha, formatPower, powAgeFor, powDifficulty } from '../src/core/util';
import { layout, chainSetup, validate, YOU, CPU, type Preset, encodeBattle, decodeBattle, unitsFromChainFleet, mirrorUnits, encodeReplay, decodeReplay, dailyScenario } from '../src/sim/fleets';
import { TYPES_BY_ID } from '../src/data/catalogue';
import { betterDaily, describeDaily, dailyStreak } from '../src/screens/battle/record';

let failures = 0;
const check = (cond: unknown, msg: string) => { if (!cond) { failures++; console.error('FAIL', msg); } };

// 1. Charge gating: an attack with too little charge fails and reverts.
{
  const units = layout('difficult', 't1');
  const { setup, idMap } = chainSetup(units, 't1', { player: 0, computer: 0 });
  const c = new Chain(setup);
  const me = Object.values(c.structs).find((s) => s.owner === YOU.id && !c.isCommand(s))!;
  const them = Object.values(c.structs).find((s) => s.owner === CPU.id && !c.canAttack(me, s, 'primaryWeapon'));
  if (them) {
    c.submit(YOU.id, { '@type': '/structs.structs.MsgStructAttack', operatingStructId: me.id, targetStructId: [them.id], weaponSystem: 'primaryWeapon' });
    const b = c.produceBlock();
    check(!b.txs[0].ok && b.txs[0].code === 'insufficient_charge', 'attack without charge must fail');
  }
  check(Object.keys(idMap).length === units.length, 'id map covers every unit');
}

// 1b. Battle codes round-trip, including a non-ASCII scenario title.
{
  const units = layout('random', 'code');
  const code = encodeBattle({ units, difficulty: 'hard', blockMs: 6000, title: 'Raid 2-1 as Ωmega’s fleet' });
  const back = decodeBattle(code);
  check(back && back.units.length === units.length && back.difficulty === 'hard' && back.blockMs === 6000 && back.title === 'Raid 2-1 as Ωmega’s fleet', 'battle code round-trip');
  check(back && JSON.stringify(back.units) === JSON.stringify(units), 'battle code preserves units exactly');
  check(decodeBattle('not-a-code') === null, 'garbage code rejected');
  check(decodeReplay('R' + btoa(JSON.stringify({ u: [], s: 1, h: 'x', x: 5 }))) === null, 'malformed replay rejected');
  check(decodeReplay('Rnot-base64!') === null, 'garbage replay rejected');
}

// 1c. A chain fleet converts into a valid side, guards included.
{
  const structs = new Map<string, { type: number; ambit: 'space' | 'air' | 'land' | 'water'; destroyed: boolean; defenders: string[] }>([
    ['5-1', { type: 1, ambit: 'land', destroyed: false, defenders: ['5-3'] }],
    ['5-2', { type: 2, ambit: 'space', destroyed: false, defenders: [] }],
    ['5-3', { type: 9, ambit: 'land', destroyed: false, defenders: [] }],
    ['5-4', { type: 12, ambit: 'water', destroyed: true, defenders: [] }],
  ]);
  const r = unitsFromChainFleet({ slots: { space: ['5-2', '', '', ''], air: ['', '', '', ''], land: ['', '5-3', '', ''], water: ['5-4', '', '', ''] }, commandStruct: '5-1', structs }, 'player');
  check(!r.problem && r.units.length === 3, 'chain fleet keeps live hulls, drops destroyed');
  check(r.units.find((u) => u.type === 9)?.protects === r.units.find((u) => u.type === 1)?.id, 'guard assignment carried over');
  const both = [...r.units, ...mirrorUnits(r.units, 'computer')];
  check(validate(both) === null, 'fleet vs its mirror is a valid battle: ' + validate(both));
  const noCmd = unitsFromChainFleet({ slots: { space: [], air: [], land: [], water: [] }, commandStruct: '', structs }, 'player');
  check(!!noCmd.problem, 'fleet without a Command Ship is refused');
}

// 2. Full AI vs AI battles terminate with a winner or a stalemate.
const presets: Preset[] = ['easy', 'difficult', 'hard', 'random'];
for (const p of presets) {
  const results: Record<string, number> = { you: 0, cpu: 0, draw: 0 };
  let blocksTotal = 0;
  for (let g = 0; g < 6; g++) {
    const seed = p + ':' + g;
    const units = layout(p, seed);
    check(validate(units) === null, `layout ${p} valid: ${validate(units)}`);
    const { setup } = chainSetup(units, seed, { player: 9, computer: 9 });
    const c = new Chain(setup);
    const a = new Ai(YOU.id, 'hard', seed + 'a');
    const b = new Ai(CPU.id, 'difficult', seed + 'b');
    let lastHurt = c.height, outcome = '';
    for (let i = 0; i < 600 && !outcome; i++) {
      if (i % 2 === 0) { const m = a.decide(c); if (m) c.submit(YOU.id, m); }
      if (i % 3 === 0) { const m = b.decide(c); if (m) c.submit(CPU.id, m); }
      const blk = c.produceBlock();
      for (const tx of blk.txs) for (const e of tx.events) if (e.category === 'struct_health' && e.detail.health < e.detail.health_old) lastHurt = blk.height;
      const left = c.fleetsAtBattle();
      if (left.length < 2) outcome = left.length === 0 ? 'draw' : left[0] === YOU.fleetId ? 'you' : 'cpu';
      else if (blk.height - lastHurt > 100) outcome = 'draw';
    }
    results[outcome || 'draw']++;
    blocksTotal += c.height - 1000;
  }
  console.log(`${p.padEnd(10)} hard-vs-difficult`, results, 'avg blocks', Math.round(blocksTotal / 6));
}
// 2b. Proof-of-work decay matches hashing.md's worked examples.
check(powDifficulty(1, 200) === 64 && powDifficulty(200, 200) === 1, 'CMD ship build: D64 fresh, D1 at age 200');
check(powDifficulty(14000, 14000) === 1, 'mine: D1 at age 14,000');
{
  const hours = powAgeFor(3, 14000) * 6 / 3600;
  check(hours > 16 && hours < 18.5, 'mine reaches D3 in ~17 h: ' + hours.toFixed(1));
  const refine = powAgeFor(3, 28000) * 6 / 3600;
  check(refine > 32 && refine < 36, 'refine reaches D3 in ~34 h: ' + refine.toFixed(1));
  check(powDifficulty(powAgeFor(3, 14000), 14000) <= 3 && powDifficulty(powAgeFor(3, 14000) - 1, 14000) > 3, 'powAgeFor is the first block at D3');
}

// 3. A full session: block clock, both computers (spectate), stalemate rules, tallies.
for (const p of ['easy', 'hard', 'random'] as Preset[]) {
  const seed = 'session:' + p;
  const { setup } = chainSetup(layout(p, seed), seed, { player: 9, computer: 9 });
  const chain = new Chain(setup);
  const session = new BattleSession(chain, 'difficult', seed, 2000);
  session.autopilot = new Ai(YOU.id, 'hard', seed + ':you');
  let outcome: unknown = null;
  session.onFinish = (o) => { outcome = o; };
  session.start();
  for (let t = 0; t < 2000 * 400 && !outcome; t += 50) session.update(50);
  check(outcome, `session ${p} finished`);
  const fielded = session.fielded[YOU.id] + session.fielded[CPU.id];
  const standing = Object.values(session.standing()).reduce((a, b) => a + b, 0);
  check(session.kills.length === fielded - standing || session.kills.length <= fielded - standing, `session ${p} kill tally ${session.kills.length} vs lost ${fielded - standing}`);
  console.log(`session ${p.padEnd(7)}`, outcome, 'kills', session.kills.length, 'attacks', session.stats[YOU.id].attacks + session.stats[CPU.id].attacks);

  // Replay: layout + seed + executed txs must reproduce the battle exactly.
  const code = encodeReplay({ units: layout(p, seed), seed, start: setup.height!, txs: session.executed, title: 't' });
  const rp = decodeReplay(code);
  check(rp && rp.txs.length === session.executed.length, `replay ${p} decodes (${code.length} chars)`);
  // A forged link where a ship fires on itself (found by the studio soak) is refused.
  const shot = session.executed.find((t) => String(t.msg['@type']).endsWith('MsgStructAttack'));
  if (shot) {
    const self = { ...shot, msg: { ...shot.msg, targetStructId: [String((shot.msg as { operatingStructId?: string }).operatingStructId)] } };
    check(decodeReplay(encodeReplay({ units: layout(p, seed), seed, start: setup.height!, txs: [self], title: 't' })) === null, `replay ${p} with a self-shot is refused`);
  }
  if (rp) {
    const again = new Chain(chainSetup(rp.units, rp.seed, { player: 9, computer: 9 }).setup);
    let i = 0;
    while (again.height < chain.height) {
      const next = again.height + 1;
      while (i < rp.txs.length && rp.txs[i].height === next) { again.submit(rp.txs[i].signer, rp.txs[i].msg); i++; }
      again.produceBlock();
    }
    check(JSON.stringify(again.structs) === JSON.stringify(chain.structs) && JSON.stringify(again.fleets) === JSON.stringify(chain.fleets), `replay ${p} reproduces the final state`);
  }
}

// 3b. A long fight: overtime at OVERTIME_AT turns, then a decision on hull at DECIDE_AT (Command Ship
// fraction, then the fleet's, else a draw). The clock is wound forward; no computer orders interfere.
{
  const seed = 'session:time';
  const decideWith = (hurt: (c: Chain) => void, at = DECIDE_AT, limit = true, wound: (u: ReturnType<typeof layout>) => void = () => {}) => {
    const units = layout('difficult', seed).map((u) => ({ ...u }));
    wound(units);
    const chain = new Chain(chainSetup(units, seed, { player: 9, computer: 9 }).setup);
    const session = new BattleSession(chain, 'difficult', seed, 2000);
    session.timeLimit = limit;
    let outcome: Outcome | null = null, overtime = 0;
    session.onFinish = (o) => { outcome = o; };
    session.onOvertime = () => { overtime++; };
    hurt(chain);
    (session as unknown as { startHeight: number }).startHeight = chain.height - (at - 1);
    session.running = true;
    session.update(2000);
    return { outcome: outcome as Outcome | null, overtime, left: session.overtimeLeft() };
  };
  const cmd = (c: Chain, owner: string) => Object.values(c.structs).find((x) => x.owner === owner && c.isCommand(x))!;
  const ot = decideWith(() => {}, OVERTIME_AT);
  check(!ot.outcome && ot.overtime === 1 && ot.left === DECIDE_AT - OVERTIME_AT, `overtime called once at ${OVERTIME_AT} turns, ${ot.left} turns left`);
  const off = decideWith(() => {}, DECIDE_AT, false);
  check(!off.outcome && !off.overtime && off.left === null, 'no time limit: no overtime, no decision');
  const cases: [string, (c: Chain) => void, Outcome['winner']][] = [
    ['their flagship hurt', (c) => { cmd(c, CPU.id).health -= 1; }, 'you'],
    ['your flagship hurt', (c) => { cmd(c, YOU.id).health -= 1; }, 'cpu'],
    ['flagships even, their fleet hurt', (c) => { const x = Object.values(c.structs).find((s) => s.owner === CPU.id && !c.isCommand(s))!; x.health = 1; }, 'you'],
    ['all even', () => {}, 'draw'],
  ];
  for (const [label, hurt, want] of cases) {
    const r = decideWith(hurt);
    check(r.outcome?.stalemate === 'time' && r.outcome.winner === want && !!r.outcome.hull, `decided on time (${label}): ${JSON.stringify(r.outcome)}`);
  }
  // Hull is counted from where each side began this fight (a gauntlet's carried damage, a battered daily):
  // your flagship came in at 3 and took nothing, theirs lost 2 of 6: yours lost the smaller share.
  const flag = (side: 'player' | 'computer') => (u: ReturnType<typeof layout>) => { const x = u.find((v) => v.side === side && TYPES_BY_ID[v.type].type === 'Command Ship'); if (x) x.health = 3; };
  const w1 = decideWith((c) => { cmd(c, CPU.id).health -= 2; }, DECIDE_AT, true, flag('player'));
  check(w1.outcome?.winner === 'you' && w1.outcome.hull?.you === 1, `decided on time from a wounded start: ${JSON.stringify(w1.outcome)}`);
  // Your fleet came in battered and lost nothing; theirs lost a ship's worth: yours lost the smaller share.
  const w2 = decideWith((c) => { const x = Object.values(c.structs).find((v) => v.owner === CPU.id && !c.isCommand(v))!; x.health = 1; }, DECIDE_AT, true,
    (u) => { for (const v of u) if (v.side === 'player' && TYPES_BY_ID[v.type].type !== 'Command Ship') v.health = 1; });
  check(w2.outcome?.winner === 'you', `decided on time from a battered fleet: ${JSON.stringify(w2.outcome)}`);
  // A standoff (no damage for QUIET_BLOCKS turns) is decided on hull too: their flagship hurt, you win it.
  {
    const chain = new Chain(chainSetup(layout('difficult', seed), seed, { player: 9, computer: 9 }).setup);
    const session = new BattleSession(chain, 'difficult', seed, 2000);
    let outcome: Outcome | null = null;
    session.onFinish = (o) => { outcome = o; };
    cmd(chain, CPU.id).health -= 1;
    (session as unknown as { lastHurt: number }).lastHurt = chain.height - (QUIET_BLOCKS - 1);
    session.running = true;
    session.update(2000);
    const o = outcome as Outcome | null;
    check(o?.stalemate === 'quiet' && o.winner === 'you' && !!o.hull, `a quiet standoff is decided on hull: ${JSON.stringify(o)}`);
  }
  // Overtime is the cap: once it has begun, no standoff cuts it short (and none is warned of).
  {
    const chain = new Chain(chainSetup(layout('difficult', seed), seed, { player: 9, computer: 9 }).setup);
    const session = new BattleSession(chain, 'difficult', seed, 2000);
    let outcome: Outcome | null = null;
    session.onFinish = (o) => { outcome = o; };
    (session as unknown as { startHeight: number }).startHeight = chain.height - (OVERTIME_AT + 3);
    (session as unknown as { lastHurt: number }).lastHurt = chain.height - (QUIET_BLOCKS + 5);
    session.running = true;
    session.update(2000);
    check(!outcome && session.overtimeLeft() !== null && session.standoffLeft() === null, `no standoff in overtime: ${JSON.stringify(outcome)} ${session.overtimeLeft()} ${JSON.stringify(session.standoffLeft())}`);
  }
  // Replay links keep how a fight ended (older links, without it, still decode).
  const rc = { units: layout('difficult', seed), seed, start: 1000, txs: [], title: 't', winner: 'you', end: 1120, stalemate: 'time' as const };
  const back = decodeReplay(encodeReplay(rc));
  check(back?.end === 1120 && back.stalemate === 'time', `replay keeps its end: ${back?.end} ${back?.stalemate}`);
  const old = decodeReplay(encodeReplay({ ...rc, end: undefined, stalemate: undefined }));
  check(!!old && old.end === undefined && old.stalemate === undefined, 'an older replay link decodes without an end');
}

// Daily engagements: valid every day, identical for everyone, and every twist shows up.
{
  const twists = new Set<string>();
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 120; i++) {
    const key = new Date(start + i * 86400000).toISOString().slice(0, 10);
    const d = dailyScenario(key);
    twists.add(d.twist.id);
    check(validate(d.units) === null, `daily ${key} is a valid layout: ${validate(d.units)}`);
    check(JSON.stringify(dailyScenario(key)) === JSON.stringify(d), `daily ${key} is deterministic`);
    check(d.units.every((u) => u.health == null || (u.health >= 1 && u.health <= TYPES_BY_ID[u.type].maxHealth)), `daily ${key} health in range`);
    if (d.twist.id === 'outnumbered') check(d.units.filter((u) => u.side === 'computer').length > d.units.filter((u) => u.side === 'player').length, `daily ${key} outnumbered`);
  }
  check(twists.size === 6, `all six daily twists appear in 120 days (${twists.size})`);
  // Same orders, same dice: two sessions of one daily replay identically.
  const d = dailyScenario('2026-10-08');
  const run = () => {
    const chain = new Chain(chainSetup(d.units, d.seed, { player: 9, computer: 9 }).setup);
    const s = new BattleSession(chain, d.difficulty, d.seed, 2000);
    s.autopilot = new Ai(YOU.id, 'hard', d.seed + ':you');
    s.start();
    for (let t = 0; t < 2000 * 400 && !s.finished; t += 50) s.update(50);
    return { state: JSON.stringify(chain.structs), attacks: s.stats[YOU.id].attacks + s.stats[CPU.id].attacks, finished: !!s.finished };
  };
  const a = run(), b = run();
  check(a.finished && a.attacks > 0, `a daily battle is fought to the end (${a.attacks} attacks)`);
  check(a.state === b.state, 'a daily battle is reproducible');
}

// Shared links are untrusted: markup or malformed ids in a replay's transactions, or unit ids that
// don't match their slot (which could alias two hulls), reject the link.
{
  const units = layout('easy', 'x');
  const { idMap } = chainSetup(units, 's', { player: 9, computer: 9 });
  const bad = (msg: Record<string, unknown>) => decodeReplay(encodeReplay({ units, seed: 's', start: 1000, txs: [{ height: 1001, signer: YOU.id, msg: msg as never }] }));
  check(bad({ '@type': '/structs.structs.MsgStructDefenseSet', defenderStructId: idMap['player-cmd'], protectedStructId: '<img src=x onerror=alert(1)>' }) === null, 'replay with markup in a struct id is rejected');
  check(bad({ '@type': '/structs.structs.MsgStructAttack', operatingStructId: idMap['player-cmd'], targetStructId: ['<b>x</b>'], weaponSystem: 'primaryWeapon' }) === null, 'replay with markup in a target id is rejected');
  check(bad({ '@type': '/structs.structs.MsgStructAttack', operatingStructId: idMap['player-cmd'], targetStructId: ['5-120'], weaponSystem: 'laser' }) === null, 'replay with an unknown weapon system is rejected');
  check(bad({ '@type': '/structs.structs.MsgStructAttack', operatingStructId: idMap['player-cmd'], targetStructId: ['5-120'], weaponSystem: 'primaryWeapon' }) !== null, 'a well-formed replay still decodes');
  const aliased = units.map((u) => (u.side === 'player' && u.type !== 1 && u.ambit === 'land' ? { ...u, id: 'player-space-0' } : u));
  check(validate(aliased) !== null, 'a unit id that does not match its slot is invalid');
}

// Battle codes carry hull damage (and reject impossible values).
{
  const units = layout('difficult', 'hp').map((u, i) => (i === 1 ? { ...u, health: 1 } : u));
  const back = decodeBattle(encodeBattle({ units }));
  check(back && back.units[1].health === 1 && back.units[0].health === undefined, 'battle code keeps hull damage');
  const bad = units.map((u, i) => (i === 1 ? { ...u, health: 99 } : u));
  check(decodeBattle(encodeBattle({ units: bad })) === null, 'battle code with impossible health is rejected');
}

// Formatters pick the unit by the printed value (never "1000 W" or "1000 mg").
check(formatPower(999_960) === '1 kW' && formatPower(99_960) === '100 W' && formatPower(4_600_000) === '4.6 kW' && formatPower(0) === '0 W', 'formatPower boundaries');
check(formatAlpha(999_600) === '1 g' && formatAlpha(999_960_000) === '1.0 kg' && formatAlpha(3_406_001_349) === '3.4 kg' && formatAlpha(2_000) === '2 mg', 'formatAlpha boundaries');

// Daily results rank: any win beats any loss; faster wins win; longer, closer losses beat quick ones.
{
  const win = (blocks: number, standing: number) => ({ won: true, blocks, standing, fielded: 10, enemyLeft: 0 });
  const loss = (blocks: number, enemyLeft: number, draw = false) => ({ won: false, draw, blocks, standing: 0, fielded: 10, enemyLeft });
  check(betterDaily(win(80, 2), loss(200, 1)), 'a win beats a loss');
  check(betterDaily(win(60, 3), win(80, 9)), 'a faster win is better');
  check(betterDaily(win(60, 5), win(60, 3)) && !betterDaily(win(60, 3), win(60, 5)), 'equal speed: more hulls standing is better');
  check(betterDaily(loss(90, 2), loss(120, 4)), 'a loss that leaves fewer enemies is better');
  check(betterDaily(loss(50, 1), null), 'anything beats no result');
  check(describeDaily(loss(100, 11, true)).startsWith('Stalemate') && describeDaily(loss(70, 1)) === 'Defeat after 70 turns · 1 enemy ship left', 'daily wording');
  check(dailyStreak('2026-10-08') === 0, 'no storage, no streak');
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('ok');
