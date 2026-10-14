/* Persona lab, sim lane: each persona's pilot fights headless battles up the debrief's ladder, with
 * their habits. That covers their reaction time, how well they read the board (an Ai "brain"),
 * whether they guard or drift, the kid habit of firing with the selected flagship, distraction and
 * fumbled orders, and how many empty bays they fill.
 * Battles run through BattleSession exactly as the soak runs them (60 fps ticks, a block every blockMs).
 *
 * What it measures is what makes a fight fun or not, per persona and per rung:
 *   flow       win rate on their home rung against their band (too easy and too hard both lose)
 *   pacing     battle minutes, the longest stretch with no order of theirs landing (dead air)
 *   tension    lead changes on hull, close finishes, comebacks from behind at half time
 *   agency     orders that went in, attacks that did damage
 *   variety    how many kinds of order and how many different ships they used; stalemates
 *
 *   npx tsx scripts/studio/personas/sim.ts                    every persona, PERSONA_SEEDS seeds a rung (default 16)
 *   PERSONA_ONLY=rookie,streamer PERSONA_SEEDS=40 npx tsx scripts/studio/personas/sim.ts
 * Writes studio/reports/personas/sim.json. Exit 1 only on an exception or an unfinished battle. */
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chain, type Block, type Msg } from '../../../src/sim/chain';
import { Ai, type Difficulty } from '../../../src/sim/ai';
import { BattleSession, OVERTIME_AT } from '../../../src/screens/battle/session';
import { chainSetup, CPU, FLEET_TYPES, fits, layout, type Preset, type Unit, unitId, validate, YOU } from '../../../src/sim/fleets';
import { AMBITS, COMMAND_SHIP_ID, type WeaponSystem } from '../../../src/data/catalogue';
import { rngFor } from '../../../src/core/util';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '../../..');
const CAST = JSON.parse(readFileSync(resolve(ROOT, 'studio/personas.json'), 'utf8'));
const OUT = resolve(ROOT, 'studio/reports/personas/sim.json');
const SEEDS = Math.max(1, Math.floor(Number(process.env.PERSONA_SEEDS) || 16));
const BASE = process.env.PERSONA_SEED || 'personas';
const ONLY = (process.env.PERSONA_ONLY || '').split(',').filter(Boolean);
const FRAME_MS = 1000 / 60, BLOCK_MS = 2000, BLOCK_CAP = 400;
const CHARGE = { player: 9, computer: 9 };   // what the battle screen opens every fight with

interface PilotSpec {
  brain: Difficulty; reactionMs: number; flagshipBias: number; guards: boolean; moves: boolean;
  idle: number; misinput: number; fill: number; rungs: number[]; home: number; band: [number, number]; minutes: [number, number];
}
interface Persona { id: string; handle: string; pilot: PilotSpec }
interface Rung { preset: Preset; difficulty: Difficulty }
const RUNGS: Rung[] = CAST.ladder.rungs;

/* ── A persona at the controls ─────────────────────────────────────────── */
const ATTACK = '/structs.structs.MsgStructAttack';

/** Duck-types the session's autopilot ({ level.reactionMs, rand(), decide(chain) }) with a persona's habits. */
class PersonaPilot {
  readonly level: { reactionMs: number };
  private readonly brain: Ai;
  private readonly r: () => number;
  fumbles = 0; idled = 0; flagshipShots = 0;
  constructor(private p: PilotSpec, seed: string) {
    this.brain = new Ai(YOU.id, p.brain, seed + ':brain');
    // The brain's level object is shared by every Ai of that difficulty: give this one its own copy.
    (this.brain as unknown as { level: object }).level = { ...this.brain.level, guard: p.guards && this.brain.level.guard, move: p.moves && this.brain.level.move };
    this.level = { reactionMs: p.reactionMs };
    this.r = rngFor(seed + ':hands');
  }
  rand() { return this.r(); }
  decide(c: Chain): Msg | null {
    if (this.r() < this.p.idle) { this.idled++; return null; }
    if (this.r() < this.p.misinput) { const m = fumble(c, this.r); if (m) { this.fumbles++; return m; } }
    const m = this.brain.decide(c);
    // The kid habit: the Command Ship is selected first, so it's the one that fires.
    if (m && m['@type'] === ATTACK && this.p.flagshipBias > 0 && this.r() < this.p.flagshipBias) {
      const cmd = Object.values(c.structs).find((s) => s.owner === YOU.id && c.isCommand(s) && !c.isDestroyed(s));
      const target = c.structs[m.targetStructId[0]];
      if (cmd && target && cmd.id !== m.operatingStructId && c.isOnline(cmd)) {
        const ws = (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).find((w) => !c.canAttack(cmd, target, w));
        if (ws) { this.flagshipShots++; return { '@type': ATTACK, operatingStructId: cmd.id, targetStructId: [target.id], weaponSystem: ws }; }
      }
    }
    return m;
  }
}

/** A fumbled order: the wrong ship, the wrong layer, a guard on the wrong thing. Often illegal; the chain refuses those. */
function fumble(c: Chain, r: () => number): Msg | null {
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const mine = Object.values(c.structs).filter((s) => s.owner === YOU.id && !c.isDestroyed(s));
  const theirs = Object.values(c.structs).filter((s) => s.owner !== YOU.id && !c.isDestroyed(s));
  if (!mine.length) return null;
  const s = pick(mine), roll = r();
  if (roll < 0.6 && theirs.length) return { '@type': ATTACK, operatingStructId: s.id, targetStructId: [pick(theirs).id], weaponSystem: r() < 0.7 ? 'primaryWeapon' : 'secondaryWeapon' };
  if (roll < 0.85) return { '@type': '/structs.structs.MsgStructMove', structId: s.id, locationType: 'fleet', ambit: pick(AMBITS), slot: 0 };
  return { '@type': '/structs.structs.MsgStructDefenseSet', defenderStructId: s.id, protectedStructId: pick(mine).id };
}

/** Bring more ships: fill up to n empty bays on your side (the setup's + bays), as a player who knows to. */
function fillBays(units: Unit[], n: number, seed: string): Unit[] {
  if (n <= 0) return units;
  const r = rngFor(seed + ':fill'), out = units.slice();
  const used = new Set(units.filter((u) => u.side === 'player' && u.type !== COMMAND_SHIP_ID).map((u) => u.ambit + u.slot));
  for (const ambit of AMBITS) for (let slot = 0; slot < 4 && n > 0; slot++) {
    if (used.has(ambit + slot)) continue;
    const types = FLEET_TYPES.filter((t) => t.id !== COMMAND_SHIP_ID && fits(t.id, ambit));
    if (!types.length) continue;
    const type = types[Math.floor(r() * types.length)].id;
    out.push({ id: unitId('player', type, ambit, slot), side: 'player', type, ambit, slot, protects: null });
    used.add(ambit + slot);
    n--;
  }
  return validate(out) ? units : out;
}

/* ── One battle ────────────────────────────────────────────────────────── */
interface Rec {
  rung: number; seed: string; winner: string; stalemate?: string; overtime: boolean; blocks: number; minutes: number;
  orders: number; ok: number; failed: number; attacks: number; damaging: number; kinds: Record<string, number>; operators: number; fielded: number;
  leadChanges: number; margin: number; behindAtHalf: boolean; deadAirS: number; kills: { you: number; cpu: number }; fumbles: number; idled: number; flagshipShots: number;
}

function battle(p: Persona, rungIdx: number, k: number): Rec {
  const rung = RUNGS[rungIdx], seed = `${BASE}:${p.id}:${rungIdx}:${k}`;
  const units = fillBays(layout(rung.preset, seed), p.pilot.fill, seed);
  const { setup } = chainSetup(units, seed + ':chain', CHARGE);
  const chain = new Chain(setup);
  const session = new BattleSession(chain, rung.difficulty, seed + ':ai', BLOCK_MS);
  const pilot = new PersonaPilot(p.pilot, seed);
  session.autopilot = pilot as unknown as Ai;
  const kinds: Record<string, number> = {}, operators = new Set<string>();
  let orders = 0, ok = 0, failed = 0, attacks = 0, damaging = 0, leadChanges = 0, lastSign = 0, lastLanded = chain.height, deadAir = 0;
  const leads: number[] = [];
  session.onAutoOrder = () => { orders++; };
  session.onBlock = (b: Block) => {
    for (const tx of b.txs) {
      if (tx.signer !== YOU.id) continue;
      if (!tx.ok) { failed++; continue; }
      ok++;
      lastLanded = b.height;
      const kind = tx.msg['@type'].split('.').pop()!.replace('MsgStruct', '');
      kinds[kind] = (kinds[kind] || 0) + 1;
      const op = (tx.msg as { operatingStructId?: string; structId?: string; defenderStructId?: string });
      operators.add(op.operatingStructId || op.structId || op.defenderStructId || '');
      if (tx.msg['@type'] === ATTACK) {
        attacks++;
        const dmg = tx.events.filter((e) => e.category === 'struct_attack').flatMap((e) => e.detail?.eventAttackShotDetail || []).reduce((a: number, r: { damage?: number }) => a + Number(r.damage || 0), 0);
        if (dmg > 0) damaging++;
      }
    }
    deadAir = Math.max(deadAir, (b.height - lastLanded) * BLOCK_MS / 1000);
    const h = session.hullNow(), lead = h.fleetYou - h.fleetCpu;
    leads.push(lead);
    const sign = lead > 0.05 ? 1 : lead < -0.05 ? -1 : 0;
    if (sign && lastSign && sign !== lastSign) leadChanges++;
    if (sign) lastSign = sign;
  };
  session.start();
  while (!session.finished && chain.height - session.startHeight < BLOCK_CAP) session.update(FRAME_MS);
  const o = session.finished;
  const blocks = chain.height - session.startHeight;
  const end = session.hullNow();
  const half = leads[Math.floor(leads.length / 2)] ?? 0;
  return {
    rung: rungIdx, seed, winner: o ? o.winner : 'none', stalemate: o?.stalemate, overtime: blocks >= OVERTIME_AT, blocks, minutes: +(session.elapsedMs / 60000).toFixed(2),
    orders, ok, failed, attacks, damaging, kinds, operators: operators.size, fielded: session.fielded[YOU.id] || 0,
    leadChanges, margin: +Math.abs(end.fleetYou - end.fleetCpu).toFixed(3), behindAtHalf: half < -0.05, deadAirS: deadAir,
    kills: { you: session.kills.filter((x) => x.owner === CPU.id).length, cpu: session.kills.filter((x) => x.owner === YOU.id).length },
    fumbles: pilot.fumbles, idled: pilot.idled, flagshipShots: pilot.flagshipShots,
  };
}

/* ── Summaries ─────────────────────────────────────────────────────────── */
const median = (a: number[]) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r3 = (n: number) => +n.toFixed(3);

function summarise(recs: Rec[]) {
  const n = recs.length, won = recs.filter((r) => r.winner === 'you');
  const kinds: Record<string, number> = {};
  for (const r of recs) for (const [k, v] of Object.entries(r.kinds)) kinds[k] = (kinds[k] || 0) + v;
  const total = Object.values(kinds).reduce((a, b) => a + b, 0) || 1;
  // Shannon entropy of the order mix, 0..1 over the five kinds a player can send in battle.
  const entropy = -Object.values(kinds).reduce((a, v) => a + (v / total) * Math.log(v / total), 0) / Math.log(5);
  return {
    n, win: r3(won.length / n), draw: r3(recs.filter((r) => r.winner === 'draw').length / n), unfinished: recs.filter((r) => r.winner === 'none').length,
    minutes: r3(median(recs.map((r) => r.minutes))), minutesP90: r3(recs.map((r) => r.minutes).sort((a, b) => a - b)[Math.floor(n * 0.9)] ?? 0),
    deadAirS: median(recs.map((r) => r.deadAirS)),
    tension: r3(recs.filter((r) => r.leadChanges > 0 || r.margin < 0.25).length / n),
    comebacks: r3(won.filter((r) => r.behindAtHalf).length / Math.max(1, recs.filter((r) => r.behindAtHalf).length)),
    agency: r3(mean(recs.map((r) => (r.orders ? r.ok / r.orders : 1)))),
    hitRate: r3(mean(recs.filter((r) => r.attacks).map((r) => r.damaging / r.attacks))),
    ordersPerMin: r3(mean(recs.map((r) => r.ok / Math.max(0.1, r.minutes)))),
    killsPerMin: r3(mean(recs.map((r) => (r.kills.you + r.kills.cpu) / Math.max(0.1, r.minutes)))),
    variety: r3(entropy), shipsUsed: r3(mean(recs.map((r) => r.operators / Math.max(1, r.fielded)))),
    stalemates: r3(recs.filter((r) => r.stalemate === 'moves' || r.stalemate === 'quiet').length / n),
    overtime: r3(recs.filter((r) => r.overtime).length / n),
    mix: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, r3(v / total)])),
    dominant: Object.entries(kinds).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
  };
}

function runPersona(p: Persona) {
  const t0 = performance.now();
  const recs: Rec[] = [];
  for (const rung of p.pilot.rungs) for (let k = 0; k < SEEDS; k++) recs.push(battle(p, rung, k));
  const byRung = Object.fromEntries(p.pilot.rungs.map((r) => [r, { ...RUNGS[r], ...summarise(recs.filter((x) => x.rung === r)) }]));
  return { id: p.id, pilot: p.pilot, all: summarise(recs), home: byRung[p.pilot.home] || null, byRung, ms: Math.round(performance.now() - t0) };
}

/** The ladder here must match the game's: read LADDER out of battle.ts and compare the pairs. */
function ladderDrift(): string | null {
  const src = readFileSync(resolve(ROOT, 'src/screens/battle/battle.ts'), 'utf8');
  const m = /const LADDER[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
  if (!m) return 'LADDER not found in battle.ts';
  const game = [...m[1].matchAll(/preset:\s*'(\w+)',\s*difficulty:\s*'(\w+)'/g)].map((x) => x[1] + '/' + x[2]).join(' ');
  const ours = RUNGS.map((r) => r.preset + '/' + r.difficulty).join(' ');
  return game === ours ? null : `personas.json ladder (${ours}) differs from battle.ts LADDER (${game})`;
}

/* ── Workers: one persona per child process ────────────────────────────── */
if (process.argv[2] === '--worker') {
  process.on('message', (id: string) => {
    const p = CAST.personas.find((x: Persona) => x.id === id);
    try { process.send!({ ok: true, result: runPersona(p) }); } catch (e) { process.send!({ ok: false, id, error: String((e as Error)?.stack || e) }); }
  });
} else {
  const cast: Persona[] = CAST.personas.filter((p: Persona) => !ONLY.length || ONLY.includes(p.id));
  const workers = Math.max(1, Math.min(cast.length, Math.floor(Number(process.env.PERSONA_SIM_WORKERS) || Math.min(6, availableParallelism() - 1))));
  const t0 = Date.now();
  const results: Record<string, unknown> = {}, errors: string[] = [];
  const drift = ladderDrift();
  let next = 0;
  await Promise.all(Array.from({ length: workers }, () => new Promise<void>((done) => {
    const child = fork(SELF, ['--worker'], { execArgv: process.execArgv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const feed = () => { if (next < cast.length) child.send(cast[next++].id); else { child.kill(); done(); } };
    child.on('message', (m: { ok: boolean; result?: { id: string; all: { win: number; n: number; minutes: number; unfinished: number }; home: { win: number } | null; ms: number }; id?: string; error?: string }) => {
      if (m.ok && m.result) {
        const r = m.result;
        results[r.id] = r;
        console.log(`  ${r.id.padEnd(16)} ${String(r.all.n).padStart(4)} battles · win ${Math.round(r.all.win * 100)}% (home rung ${r.home ? Math.round(r.home.win * 100) + '%' : '–'}) · ${r.all.minutes} min median · ${(r.ms / 1000).toFixed(1)} s`);
        if (r.all.unfinished) errors.push(`${r.id}: ${r.all.unfinished} battles never finished`);
      } else errors.push(`${m.id}: ${m.error}`);
      feed();
    });
    child.on('exit', (code) => { if (code && next <= cast.length) { errors.push(`a sim worker exited with ${code}`); done(); } });
    feed();
  })));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), seeds: SEEDS, seed: BASE, blockMs: BLOCK_MS, ladderDrift: drift, wallMs: Date.now() - t0, personas: results, errors }, null, 1));
  if (drift) console.warn('  ⚠ ' + drift);
  console.log(`sim: ${Object.keys(results).length} personas in ${((Date.now() - t0) / 1000).toFixed(1)} s${errors.length ? ' · ✗ ' + errors.join(' · ') : ''}`);
  process.exit(errors.length ? 1 : 0);
}
