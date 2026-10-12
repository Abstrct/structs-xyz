/* The simulator's service record: lifetime tallies and daily-engagement
 * results. Kept in this browser only (localStorage); nothing is sent anywhere. */

export interface ServiceRecord { battles: number; wins: number; losses: number; draws: number; kills: number; flagships: number; lost: number }
export interface DailyResult { won: boolean; draw?: boolean; blocks: number; standing: number; fielded: number; enemyLeft: number }

const RECORD_KEY = 'structs.record';
const DAILY_KEY = (key: string) => 'structs.daily.' + key;
const DAILY_WINS = 'structs.daily.wins';

function read<T>(k: string, fallback: T): T {
  try { const v = localStorage.getItem(k); return v ? { ...fallback, ...JSON.parse(v) } : fallback; } catch { return fallback; }
}
function write(k: string, v: unknown) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: keep going */ }
  // The Academy listens: a first win or a daily cleared can finish a lesson.
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('structs:progress'));
}

export function loadRecord(): ServiceRecord {
  return read<ServiceRecord>(RECORD_KEY, { battles: 0, wins: 0, losses: 0, draws: 0, kills: 0, flagships: 0, lost: 0 });
}

export function addBattle(r: { winner: 'you' | 'cpu' | 'draw'; kills: number; flagship: boolean; lost: number }) {
  const rec = loadRecord();
  rec.battles++;
  if (r.winner === 'you') rec.wins++; else if (r.winner === 'cpu') rec.losses++; else rec.draws++;
  rec.kills += r.kills;
  rec.lost += r.lost;
  if (r.flagship) rec.flagships++;
  write(RECORD_KEY, rec);
  return rec;
}

/** Better = a win beats anything else; then fewer blocks; then more hulls standing. A loss that lasts longer beats a quick one. */
export function betterDaily(a: DailyResult, b: DailyResult | null): boolean {
  if (!b) return true;
  if (a.won !== b.won) return a.won;
  if (a.won) return a.blocks !== b.blocks ? a.blocks < b.blocks : a.standing > b.standing;
  return a.enemyLeft !== b.enemyLeft ? a.enemyLeft < b.enemyLeft : a.blocks > b.blocks;
}

export function dailyBest(key: string): DailyResult | null {
  try { const v = localStorage.getItem(DAILY_KEY(key)); return v ? JSON.parse(v) as DailyResult : null; } catch { return null; }
}

/** Store a daily result if it beats today's best; returns whether it did. */
export function saveDaily(key: string, r: DailyResult): boolean {
  const best = dailyBest(key);
  if (r.won) {
    const wins = new Set(read<{ keys: string[] }>(DAILY_WINS, { keys: [] }).keys);
    wins.add(key);
    write(DAILY_WINS, { keys: [...wins].sort().slice(-120) });
  }
  if (!betterDaily(r, best)) return false;
  write(DAILY_KEY(key), r);
  return true;
}

/** Consecutive days with a daily victory, counting back from today (or yesterday, if today is not won yet). */
export function dailyStreak(today: string): number {
  const wins = new Set(read<{ keys: string[] }>(DAILY_WINS, { keys: [] }).keys);
  const d = new Date(today + 'T12:00:00Z');
  if (!wins.has(today)) d.setUTCDate(d.getUTCDate() - 1);
  let n = 0;
  while (wins.has(d.toISOString().slice(0, 10))) { n++; d.setUTCDate(d.getUTCDate() - 1); }
  return n;
}

export function describeDaily(r: DailyResult): string {
  return r.won
    ? `Victory in ${r.blocks} turns · ${r.standing}/${r.fielded} ships standing`
    : `${r.draw ? 'Stalemate' : 'Defeat'} after ${r.blocks} turns · ${r.enemyLeft} enemy ship${r.enemyLeft === 1 ? '' : 's'} left`;
}
