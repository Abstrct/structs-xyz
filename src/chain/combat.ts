/* The combat archive: every MsgStructAttack ever executed is searchable on
 * the LCD (tx search by message action), and each carries structsd's full
 * EventAttack — attacker, every shot row, blocks, evasions, counters, health
 * before and after. Enough to stage the fight again without another query. */
import { LCD_URL } from './lcd';

/** EventAttack as the chain emits it (uint64s as strings). */
export interface RawShot {
  targetStructId: string; targetPlayerId: string; targetStructTypeId: string; targetStructType: string;
  targetStructLocationType: string; targetStructLocationId: string; targetStructOperatingAmbit: string; targetStructSlot: string;
  evaded: boolean; evadedCause: string; evadedByPlanetaryDefenses: boolean; evadedByPlanetaryDefensesCause: string;
  blocked: boolean; blockedByStructId: string; blockedByStructType: string; blockedByStructTypeId: string;
  blockedByStructLocationType: string; blockedByStructLocationId: string; blockedByStructOperatingAmbit: string; blockedByStructSlot: string;
  blockerDestroyed: boolean; blockerHealthBefore: string; blockerHealthAfter: string; blockerHealthMax: string;
  eventAttackDefenderCounterDetail: RawCounter[];
  damageDealt: string; damageReduction: string; damageReductionCause: string; damage: string;
  targetCountered: boolean; targetCounteredDamage: string; targetCounterDestroyedAttacker: boolean;
  targetDestroyed: boolean; postDestructionDamageToAttacker: boolean; postDestructionDamage: string;
  targetHealthBefore: string; targetHealthAfter: string; targetHealthMax: string; armourPiercing: boolean;
}
export interface RawCounter {
  counterByStructId: string; counterByStructTypeId: string; counterByStructType: string; counterByStructLocationType: string;
  counterByStructLocationId: string; counterByStructOperatingAmbit: string; counterByStructSlot: string; counterDamage: string; counterDestroyedAttacker: boolean;
}
export interface RawAttack {
  attackerStructId: string; attackerStructTypeId: string; attackerStructType: string; attackerStructLocationType: string;
  attackerStructLocationId: string; attackerStructOperatingAmbit: string; attackerStructSlot: string;
  weaponSystem: string; weaponControl: string; activeWeaponry: string; eventAttackShotDetail: RawShot[];
  recoilDamageToAttacker: boolean; recoilDamage: string; recoilDamageDestroyedAttacker: boolean;
  planetaryDefenseCannonDamageToAttacker: boolean; planetaryDefenseCannonDamage: string; planetaryDefenseCannonDamageDestroyedAttacker: boolean;
  attackerPlayerId: string; attackerHealthBefore: string; attackerHealthAfter: string; attackerHealthMax: string;
}
export interface CombatRecord {
  hash: string; height: number; time: string; attack: RawAttack; signer: string;
  /** Index of this attack among the transaction's attacks (a tx may batch several). */
  evt?: number;
}

export interface TxResponse { height: string; txhash: string; timestamp: string; code: number; events: { type: string; attributes: { key: string; value: string }[] }[] }

export function recordsOf(t: TxResponse): CombatRecord[] {
  if (t.code) return [];
  const out: CombatRecord[] = [];
  let signer = '';
  for (const e of t.events || []) {
    if (e.type === 'message') signer = e.attributes.find((a) => a.key === 'sender')?.value || signer;
    if (e.type !== 'structs.structs.EventAttack') continue;
    const raw = e.attributes.find((a) => a.key === 'eventAttackDetail')?.value;
    if (!raw) continue;
    try { out.push({ hash: t.txhash, height: Number(t.height), time: t.timestamp, attack: JSON.parse(raw) as RawAttack, signer, evt: out.length }); } catch { /* skip a malformed row */ }
  }
  return out;
}

/* ── Order inside a block ───────────────────────────────────────────────
 * Tx search sorts by height, and a descending search also reverses the transactions inside a
 * block, so positions from different queries can't be compared. When two attacks share a block,
 * the block itself says which ran first: its transactions, hashed, in execution order. */
const blockTxs = new Map<number, Promise<string[]>>();

/** A block's transaction hashes (uppercase hex) in execution order; cached, and forgotten on failure. */
export function blockOrder(height: number): Promise<string[]> {
  let p = blockTxs.get(height);
  if (!p) {
    p = (async () => {
      const subtle = globalThis.crypto?.subtle;
      if (!subtle) return []; // not a secure context: keep the order the queries gave
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      try {
        const res = await fetch(`${LCD_URL}/cosmos/base/tendermint/v1beta1/blocks/${Math.floor(height)}`, { signal: ctl.signal });
        if (!res.ok) throw new Error(`LCD ${res.status}`);
        const body = await res.json() as { block?: { data?: { txs?: string[] } } };
        const out: string[] = [];
        for (const b64 of body.block?.data?.txs || []) {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
          out.push(Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase());
        }
        return out;
      } finally { clearTimeout(timer); }
    })();
    blockTxs.set(height, p);
    p.catch(() => blockTxs.delete(height));
  }
  return p;
}

/** Chain order: height, then place in the block where `order` knows it, then place in the transaction. */
export function chainSort(recs: CombatRecord[], order: Map<number, string[]>): CombatRecord[] {
  const at = (r: CombatRecord) => order.get(r.height)?.indexOf(r.hash.toUpperCase()) ?? -1;
  return [...recs].sort((a, b) => a.height - b.height || at(a) - at(b) || (a.hash === b.hash ? (a.evt ?? 0) - (b.evt ?? 0) : 0));
}

/** Attacks in execution order, reading only the blocks where two of them share a height. */
export async function inChainOrder(recs: CombatRecord[]): Promise<CombatRecord[]> {
  const hashes = new Map<number, Set<string>>();
  for (const r of recs) { const s = hashes.get(r.height) || new Set<string>(); s.add(r.hash); hashes.set(r.height, s); }
  const order = new Map<number, string[]>();
  const reads = Promise.all([...hashes].filter(([, s]) => s.size > 1).map(([h]) => blockOrder(h).then((o) => { order.set(h, o); }, () => { /* keep query order */ })));
  // A slow node mustn't hold a replay hostage: after 4 s, whatever blocks have answered decide.
  let timer = 0;
  await Promise.race([reads, new Promise<void>((r) => { timer = setTimeout(r, 4000) as unknown as number; })]);
  clearTimeout(timer);
  return chainSort(recs, order);
}

const ACTION = "message.action='/structs.structs.MsgStructAttack'";

/** The newest attacks on the chain, newest first; `sender` narrows them to one address. `page` counts from 1. */
export async function recentAttacks(limit = 20, page = 1, sender?: string): Promise<{ records: CombatRecord[]; total: number }> {
  if (sender && !/^structs1[0-9a-z]{20,90}$/.test(sender)) throw new Error('Not a Structs address');
  const query = encodeURIComponent(sender ? `message.sender='${sender}' AND ${ACTION}` : ACTION);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(`${LCD_URL}/cosmos/tx/v1beta1/txs?query=${query}&order_by=ORDER_BY_DESC&limit=${limit}&page=${page}`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`LCD ${res.status}`);
    const body = await res.json() as { tx_responses?: TxResponse[]; total?: string };
    return { records: (body.tx_responses || []).flatMap(recordsOf), total: Number(body.total || 0) };
  } finally { clearTimeout(timer); }
}

/** The newest 100 attacks, shared and cached for two minutes (planet maps look up their last fight here). */
let latest: { at: number; p: Promise<CombatRecord[]> } | null = null;
export function latestAttacks(force = false): Promise<CombatRecord[]> {
  if (force || !latest || Date.now() - latest.at > 120000) {
    const entry = { at: Date.now(), p: recentAttacks(100).then((r) => r.records) };
    entry.p.catch(() => { if (latest === entry) latest = null; });
    latest = entry;
  }
  return latest.p;
}

/** Every attack (both sides) between two heights, up to `max` transactions. When the window
 * holds more, `order` decides which end is read: newest first (desc) or oldest first (asc). */
export async function attacksBetween(from: number, to: number, max = 200, order: 'asc' | 'desc' = 'desc'): Promise<CombatRecord[]> {
  const query = encodeURIComponent(`${ACTION} AND tx.height>=${Math.max(1, Math.floor(from))} AND tx.height<=${Math.floor(to)}`);
  const out: CombatRecord[] = [];
  for (let page = 1; page <= Math.ceil(max / 100); page++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    let body: { tx_responses?: TxResponse[]; total?: string };
    try {
      const res = await fetch(`${LCD_URL}/cosmos/tx/v1beta1/txs?query=${query}&order_by=${order === 'asc' ? 'ORDER_BY_ASC' : 'ORDER_BY_DESC'}&limit=100&page=${page}`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`LCD ${res.status}`);
      body = await res.json() as { tx_responses?: TxResponse[]; total?: string };
    } finally { clearTimeout(timer); }
    const txs = body.tx_responses || [];
    out.push(...txs.flatMap(recordsOf));
    if (txs.length < 100 || page * 100 >= Number(body.total || 0)) break;
  }
  return out;
}

/** Every attack in one transaction (a tx may batch several). */
export async function attacksInTx(hash: string): Promise<CombatRecord[]> {
  if (!/^[0-9A-Fa-f]{64}$/.test(hash)) throw new Error('Not a transaction hash');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  let body: { tx_response: TxResponse };
  try {
    const res = await fetch(`${LCD_URL}/cosmos/tx/v1beta1/txs/${hash.toUpperCase()}`, { signal: ctl.signal });
    if (!res.ok) throw new Error(res.status === 404 ? 'No such transaction on this chain' : `LCD ${res.status}`);
    body = await res.json() as { tx_response: TxResponse };
  } finally { clearTimeout(timer); }
  return recordsOf(body.tx_response);
}

/** One line for a list: who hit what, and how it went. */
export function summarize(a: RawAttack, name: (playerId: string) => string): { title: string; result: string; tone: 'kill' | 'hit' | 'miss' } {
  const shots = a.eventAttackShotDetail || [];
  const first = shots[0];
  const target = first ? `${first.targetStructType} of ${name(first.targetPlayerId)}` : 'nothing';
  let dmg = 0, kills = 0, evaded = 0, blocked = 0;
  for (const s of shots) { dmg += Number(s.damage || 0); if (s.targetDestroyed) kills++; if (s.evaded) evaded++; if (s.blocked) blocked++; }
  const bits: string[] = [];
  if (dmg) bits.push(`${dmg} damage`);
  if (evaded) bits.push(evaded === shots.length ? 'evaded' : `${evaded} evaded`);
  if (blocked) bits.push('blocked');
  if (kills) bits.push('destroyed');
  if (a.attackerHealthAfter === '0' || a.recoilDamageDestroyedAttacker) bits.push('attacker lost');
  return {
    title: `${name(a.attackerPlayerId)}’s ${a.attackerStructType} → ${target}`,
    result: bits.join(' · ') || 'no effect',
    tone: kills ? 'kill' : dmg ? 'hit' : 'miss',
  };
}
