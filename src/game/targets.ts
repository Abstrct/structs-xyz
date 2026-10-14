/* The target board: who is worth raiding right now. Reads every commander's stored ore, last
 * action and every planet's shield: from the galaxy snapshot or the guild's indexer (one exact read
 * each, src/chain/reader.ts), else from the LCD (one page per store, seeking to the right key prefix),
 * then scores what a raid would take against what it would cost:
 *   ore in the hold (all of it is seized on success) · a thin shield (the raid proof's range)
 *   · few defenders on the planet · an owner who hasn't acted lately (no one at the guns). */
import { LCD_URL } from '../chain/lcd';
import { store } from '../chain/store';
import { live } from '../chain/live';
import { empire } from './empire';
import { gridsOfType, planetAttributeAll } from '../chain/reader';

export interface Target { playerId: string; name: string; guildId: string; planetId: string; ore: number; shield: number; structs: number; idle: number; score: number }

let cache: { at: number; list: Target[] } | null = null;

async function page<T>(path: string, field: string): Promise<T[]> {
  const r = await fetch(LCD_URL + path);
  if (!r.ok) throw new Error('LCD ' + r.status);
  return ((await r.json())[field] || []) as T[];
}

type Stores = { ore: Map<string, number>; last: Map<string, number>; shield: Map<string, number> };
const numbers = (m: Map<string, string | undefined>) => new Map([...m].map(([k, v]) => [k, Number(v || 0)]));

/** From the galaxy snapshot, else the guild with a session: three exact reads (absent is 0). */
async function fromIndex(): Promise<Stores | null> {
  const [grid, shields] = await Promise.all([
    gridsOfType('player', ['ore', 'lastAction']),
    planetAttributeAll('planetaryShield'),
  ]);
  if (!grid || !shields) return null;
  return {
    ore: numbers(new Map([...grid].map(([k, g]) => [k, g.ore]))),
    last: numbers(new Map([...grid].map(([k, g]) => [k, g.lastAction]))),
    shield: numbers(shields),
  };
}

/** Grid and attribute stores are keyed "<attr>-<type>-<index>": seek straight to a prefix. */
async function fromLcd(): Promise<Stores> {
  const from = (prefix: string) => encodeURIComponent(btoa(prefix));
  const [oreRecs, lastRecs, shields] = await Promise.all([
    page<{ attributeId: string; value: string }>(`/structs/grid?pagination.limit=8000&pagination.key=${from('0-1-')}`, 'gridRecords'),
    page<{ attributeId: string; value: string }>(`/structs/grid?pagination.limit=8000&pagination.key=${from('11-1-')}`, 'gridRecords'),
    page<{ attributeId: string; value: string }>(`/structs/planet_attribute?pagination.limit=60000&pagination.key=${from('0-2-')}`, 'planetAttributeRecords'),
  ]);
  const ore = new Map<string, number>(), last = new Map<string, number>();
  for (const g of [...oreRecs, ...lastRecs]) {
    const m = /^(\d+)-1-(\d+)$/.exec(g.attributeId);
    if (!m) continue;
    if (m[1] === '0') ore.set('1-' + m[2], Number(g.value));
    if (m[1] === '11') last.set('1-' + m[2], Number(g.value));
  }
  const shield = new Map<string, number>();
  for (const s of shields) { const m = /^0-2-(\d+)$/.exec(s.attributeId); if (m) shield.set('2-' + m[1], Number(s.value)); }
  return { ore, last, shield };
}

export async function targets(force = false): Promise<Target[]> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.list;
  await store.loadCore();
  const { ore, last, shield } = (await fromIndex()) ?? (await fromLcd());
  const mine = new Set([...empire.players.values()].filter((p) => p.account >= 0).map((p) => p.playerId));
  const myGuilds = new Set([...empire.players.values()].filter((p) => p.account >= 0).map((p) => p.guildId));
  const h = live.height;
  const list: Target[] = [];
  for (const [pid, o] of ore) {
    if (o <= 0 || mine.has(pid)) continue;
    const p = store.players.get(pid);
    if (!p?.planetId || myGuilds.has(p.guildId)) continue;
    const sh = shield.get(p.planetId) ?? 0;
    const planet = store.planets.get(p.planetId);
    const idle = h && last.get(pid) ? h - last.get(pid)! : 0;
    // Ore is the prize; shield is the work; defenders and an awake owner are the risk.
    const score = o * 10 / Math.max(1, Math.log10(Math.max(10, sh)) * 2) / (1 + (planet?.structs ?? 0) * 0.15) * (idle > 600 ? 1.5 : 1);
    list.push({ playerId: pid, name: p.name || pid, guildId: p.guildId, planetId: p.planetId, ore: o, shield: sh, structs: planet?.structs ?? 0, idle, score });
  }
  list.sort((a, b) => b.score - a.score);
  cache = { at: Date.now(), list: list.slice(0, 60) };
  return cache.list;
}
