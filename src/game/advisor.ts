/* The advisor: what this player should do next, most urgent first, each with the one move
 * that fixes it. Pure reading of empire state — the deck shows it, the palette can run it. */
import { empire, type PlayerState } from './empire';
import { act, buildBlock, exploreConfirmed, reservedSlots } from './actions';
import { typeOf } from '../data/catalogue';
import { num } from '../chain/lcd';
import { pow } from '../pow/pow';

export interface Advice { id: string; tone: 'enemy' | 'warn' | 'player'; title: string; detail: string; action?: { label: string; run: () => unknown; cost?: number }; go?: string }

export function advise(p: PlayerState): Advice[] {
  const out: Advice[] = [];
  const structs = [...p.structs.values()].filter((s) => !s.destroyed);
  const has = (id: number) => structs.some((s) => s.typeId === id);
  const freeSlot = (ambits: string[]) => {
    const pl = p.planet?.Planet as unknown as Record<string, string[] | string> | undefined;
    if (!pl) return null;
    const held = reservedSlots(p.playerId);
    for (const a of ambits) { const sl = (pl[a] as string[]) || []; const n = Math.max(num(pl[a + 'Slots'] as string), sl.length); for (let i = 0; i < n; i++) if (!sl[i] && !held.has(`planet:${a}:${i}`)) return { a, i }; }
    return null;
  };
  const cap = p.capacity + p.connectionCapacity, load = p.load + p.structsLoad;
  const charge = empire.charge(p);
  const groundOre = num(p.planet?.gridAttributes?.ore);

  if (!p.online) out.push({ id: 'offline', tone: 'enemy', title: 'Not enough power', detail: `Your machines use ${fmtW(load)} but you only have ${fmtW(cap)}, so nothing can act. Switch something off, connect to a substation, or burn alpha in a generator.`, go: '/economy' });
  if (p.fleet?.status === 'away' && p.target) out.push({ id: 'away', tone: 'warn', title: `Fleet away at ${p.target.Planet.id}`, detail: 'Your fleet is away, so it isn’t defending home. Raid, or bring it home.', action: { label: 'Return home', run: () => act.fleetMove(p, p.planetId) } });
  if (p.ore > 0 && !has(15)) {
    const slot = freeSlot(['land', 'water']);
    out.push({ id: 'ore-risk', tone: 'enemy', title: `${p.ore} ore at risk`, detail: 'Stored ore can be stolen by any raider. A refinery turns it into alpha, which can’t be.', action: slot && !buildBlock(p, typeOf(15)) ? { label: 'Build Ore Refinery', cost: 8, run: () => act.build(p, typeOf(15)!, slot.a, slot.i) } : undefined });
  } else if (p.ore > 0) out.push({ id: 'ore-refining', tone: 'warn', title: `${p.ore} ore waiting to refine`, detail: 'Your refinery solves one puzzle per ore. Each finishes when its puzzle gets easy enough.', go: '/ops/proofs' });
  // Only advise exploring on a planet we actually read (a failed read looks like zero ore).
  if (!p.planetId || (p.planet && groundOre <= 0 && p.ore === 0)) out.push({ id: 'explore', tone: 'player', title: p.planetId ? 'Planet used up' : 'No planet yet', detail: 'Explore to claim a fresh planet you can mine.', action: { label: 'Explore', run: () => exploreConfirmed(p) } });
  if (groundOre > 0 && !has(14)) {
    const slot = freeSlot(['land', 'water']);
    out.push({ id: 'mine', tone: 'player', title: `${groundOre} ore in the ground`, detail: 'An Ore Extractor digs it up, one puzzle per ore.', action: slot && !buildBlock(p, typeOf(14)) ? { label: 'Build Ore Extractor', cost: 8, run: () => act.build(p, typeOf(14)!, slot.a, slot.i) } : undefined });
  }
  for (const s of structs) {
    if (s.built && !s.online && s.type && load + BigInt(s.type.passiveDraw) <= cap) {
      out.push({ id: 'power:' + s.id, tone: 'warn', title: `${s.type.type} is switched off`, detail: `You have enough power to run it (it needs ${fmtW(BigInt(s.type.passiveDraw))}).`, action: { label: 'Switch on', cost: s.type.activateCharge, run: () => act.activate(p, s) } });
      break;
    }
  }
  const building = structs.filter((s) => !s.built);
  if (building.length) {
    const tasks = [...pow.tasks.values()].filter((t) => t.playerId === p.playerId && t.kind === 'build' && t.status !== 'done');
    const soonest = tasks.map((t) => pow.blocksUntil(t, Math.min(pow.settings.startAt, pow.required(t)))).sort((a, b) => a - b)[0];
    out.push({ id: 'building', tone: 'player', title: `${building.length} being built`, detail: soonest != null && soonest > 0 ? `Your computer starts the puzzle in about ${soonest} blocks and finishes the build for you.` : 'Your computer is solving the puzzle now.', go: '/ops/proofs' });
  }
  if (charge >= 8 && p.online && !building.length && structs.length < 8) out.push({ id: 'idle', tone: 'player', title: 'Charge full', detail: `Charge ${charge}: enough for any move. Build, move or attack.`, go: '/command' });
  if (!has(19) && structs.length >= 3) {
    const slot = freeSlot(['land', 'water']);
    if (slot && !buildBlock(p, typeOf(19))) out.push({ id: 'pdc', tone: 'warn', title: 'No planetary defense', detail: 'A Planetary Defense Cannon fires back at raiders.', action: { label: 'Build cannon', cost: 8, run: () => act.build(p, typeOf(19)!, slot.a, slot.i) } });
  }
  const rank = { enemy: 0, warn: 1, player: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]).slice(0, 6);
}

function fmtW(mw: bigint) { const n = Number(mw); return n >= 1e6 ? `${(n / 1e6).toFixed(1)} kW` : `${(n / 1e3).toFixed(0)} W`; }
