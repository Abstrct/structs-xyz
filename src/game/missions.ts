/* Missions: the path from a fresh key to a raid won, read from the live game. Each one checks
 * itself against your empire and your service record, says what to do and where, and pays XP
 * once when it is met. */
import { wallet } from '../wallet/wallet';
import { empire, type PlayerState } from './empire';
import { record } from './record';
import { replicants } from './replicants';
import { comms } from '../chat/matrix';
import { toast } from '../core/dom';
import { audio } from '../core/audio';
import { live } from '../chain/live';

export interface Mission { id: string; title: string; brief: string; xp: number; go?: string; done: (p: PlayerState | null) => boolean }

const built = (p: PlayerState | null, typeId: number) => !!p && [...p.structs.values()].some((s) => s.typeId === typeId && s.built && !s.destroyed);
const count = (n: string) => record.r.counts[n] || 0;

export const MISSIONS: Mission[] = [
  { id: 'enlist', title: 'Enlist', brief: 'Make your free commander: a name and a guild.', xp: 25, done: () => wallet.state !== 'empty' },
  { id: 'join', title: 'Join a guild', brief: 'Your guild (team) creates your commander in the game. It takes a few seconds.', xp: 50, done: () => !!wallet.primary?.playerId },
  { id: 'world', title: 'Claim a planet', brief: 'Explore to get your own planet. Every commander needs one.', xp: 50, go: '/command', done: (p) => !!p?.planetId },
  { id: 'extractor', title: 'Build an Ore Extractor', brief: 'Build one on land or water. Your computer solves a puzzle to finish it.', xp: 80, go: '/command', done: (p) => built(p, 14) },
  { id: 'ore', title: 'Mine ore', brief: 'Mine your first ore. Your computer solves the mining puzzle.', xp: 80, go: '/ops/proofs', done: (p) => record.r.ore > 0 || (p?.ore ?? 0) > 0 },
  { id: 'refinery', title: 'Build a refinery', brief: 'Raiders can steal ore, but not alpha. A refinery turns one into the other.', xp: 80, go: '/command', done: (p) => built(p, 15) },
  { id: 'alpha', title: 'Refine alpha', brief: 'Turn your ore into alpha before raiders come.', xp: 120, go: '/ops/proofs', done: () => record.r.alpha > 0 },
  { id: 'fleet', title: 'Arm the fleet', brief: 'Build three ships for your fleet.', xp: 100, go: '/command', done: (p) => !!p && [...p.structs.values()].filter((s) => s.locationType === 'fleet' && s.built && !s.destroyed && s.typeId !== 1).length >= 3 },
  { id: 'cannon', title: 'Defend your planet', brief: 'Build a Planetary Defense Cannon. It fires back at raiders.', xp: 100, go: '/command', done: (p) => built(p, 19) },
  { id: 'comms', title: 'Say hello', brief: 'Sign in to chat with your guild.', xp: 40, go: '/comms', done: () => comms.state === 'live' },
  { id: 'sail', title: 'Set sail', brief: 'Send your fleet to another planet. The target board finds easy ones.', xp: 60, go: '/command', done: () => count('FleetMove') > 0 },
  { id: 'strike', title: 'First strike', brief: 'Fire at an enemy ship or building.', xp: 120, go: '/command', done: () => count('StructAttack') > 0 },
  { id: 'kill', title: 'First kill', brief: 'Destroy an enemy ship or building.', xp: 200, done: () => record.r.kills > 0 },
  { id: 'raid', title: 'Win a raid', brief: 'Beat a planet’s defenders, solve the raid puzzle, and take its ore.', xp: 400, done: () => record.r.raids > 0 },
  { id: 'replicate', title: 'Make a robot helper', brief: 'Create a replicant that mines for you.', xp: 150, go: '/ops/replicants', done: () => replicants.roster.some((a) => a.playerId) },
];

/** The first mission not yet met, and how many are done. */
export function progress(): { next: Mission | null; done: number; total: number } {
  const p = wallet.primary?.playerId ? empire.players.get(wallet.primary.playerId) ?? null : null;
  let done = 0, next: Mission | null = null;
  for (const m of MISSIONS) { if (m.done(p)) done++; else if (!next) next = m; }
  return { next, done, total: MISSIONS.length };
}

let started = false;
/** Watch for missions being met and pay them out (once each, with a moment of ceremony). */
export function startMissions() {
  if (started) return;
  started = true;
  const check = () => {
    const p = wallet.primary?.playerId ? empire.players.get(wallet.primary.playerId) ?? null : null;
    for (const m of MISSIONS) if (m.done(p) && record.award('mission:' + m.id, m.xp)) {
      audio.play('confirm');
      toast(`Mission complete — ${m.title} · +${m.xp} XP`, 'player', 4200);
    }
  };
  wallet.onChange(check); empire.onChange(check); record.onChange(() => setTimeout(check, 0)); live.onBlock((b) => { if (b.height % 5 === 0) check(); });
}
