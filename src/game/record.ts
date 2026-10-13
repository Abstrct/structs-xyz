/* Service record: every move of yours that lands earns experience, and experience earns
 * rank. Kept per browser (it counts what this client did), across all your players. */
import { txq, type TxJob } from '../wallet/queue';
import { banner, whenNoticesShow } from '../core/dom';
import { audio } from '../core/audio';
import { safeEach } from '../core/util';

const KEY = 'structs.record.v1';

export const RANKS = ['Cadet', 'Ensign', 'Lieutenant', 'Commander', 'Captain', 'Commodore', 'Rear Admiral', 'Vice Admiral', 'Admiral', 'Fleet Admiral', 'Grand Struct'];
const STEP = 120;
/** XP needed to reach rank i (i ≥ 1): gentle at first, then steeper. */
export const xpFor = (i: number) => Math.round(STEP * i * i * 0.9 + STEP * i * 0.6);

export interface ServiceStats { xp: number; counts: Record<string, number>; kills: number; damage: number; raids: number; ore: number; alpha: number; missions?: string[]; credited?: string[] }

type Fn = (r: ServiceStats) => void;

class ServiceRecord {
  r: ServiceStats = { xp: 0, counts: {}, kills: 0, damage: 0, raids: 0, ore: 0, alpha: 0 };
  private listeners = new Set<Fn>();
  /** Storage refused a write (blocked site data, a full quota): from then on this tab's copy is the
   * record, so a re-read can't wind progress back and pay the same mission twice. */
  private memOnly = false;

  constructor() {
    this.load();
    if (typeof window === 'undefined') return;
    txq.onSettled((j) => { if (j.status === 'success') this.credit(j); });
    // Another tab earned XP: take its record, so neither tab writes over the other's.
    window.addEventListener('storage', (e) => { if (e.key === KEY) { this.load(); safeEach(this.listeners, (f) => f(this.r)); } });
  }

  /** The stored record, read fresh (every write starts from it: other tabs share the key). */
  private load() {
    if (this.memOnly) return;
    const fresh: ServiceStats = { xp: 0, counts: {}, kills: 0, damage: 0, raids: 0, ore: 0, alpha: 0 };
    try { Object.assign(fresh, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* fresh */ }
    this.r = fresh;
  }

  private save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.r)); } catch { this.memOnly = true; }
  }

  onChange(f: Fn) { this.listeners.add(f); f(this.r); return () => this.listeners.delete(f); }

  get rank() { let i = 0; while (i + 1 < RANKS.length && this.r.xp >= xpFor(i + 1)) i++; return i; }
  get progress() { const i = this.rank; const a = xpFor(i) * (i ? 1 : 0), b = xpFor(i + 1); return Math.min(1, (this.r.xp - a) / (b - a)); }

  /** Award a one-time bonus (a mission). Returns false if it was already awarded. */
  award(id: string, xp: number): boolean {
    this.load();
    const done = (this.r.missions ||= []);
    if (done.includes(id)) return false;
    done.push(id);
    this.add(xp);
    return true;
  }

  /** XP for something done again and again (a battle fought): no id, so it pays every time. */
  gain(xp: number) {
    if (!(xp > 0)) return;
    this.load();
    this.add(xp);
  }

  private add(xp: number) {
    const before = this.rank;
    this.r.xp += xp;
    this.save();
    // The fanfare and its banner together (at PRESS START both wait for the doors).
    if (this.rank > before) { const rank = RANKS[this.rank]; whenNoticesShow(() => { audio.stinger('secure', 0.8); banner(rank.toUpperCase(), 'PROMOTED', 'player', 2800); }, true); }
    safeEach(this.listeners, (f) => f(this.r));
  }

  private credit(j: TxJob) {
    this.load();
    // Every open tab hears a job settle (the others mirror the signer's queue); only the first to
    // credit it counts, and the rest see its id in the shared record.
    const seen = (this.r.credited ||= []);
    if (seen.includes(j.id)) return;
    seen.push(j.id);
    if (seen.length > 300) seen.splice(0, seen.length - 300);
    const before = this.rank;
    let xp = 0;
    for (const m of j.msgs) {
      const n = m.typeUrl.split('.').pop()!.replace(/^Msg/, '');
      this.r.counts[n] = (this.r.counts[n] || 0) + 1;
      xp += ({ StructBuildInitiate: 10, StructBuildComplete: 25, StructOreMinerComplete: 20, StructOreRefineryComplete: 30, PlanetExplore: 30, StructAttack: 15, PlanetRaidComplete: 200, FleetMove: 8, PlayerSend: 2 } as Record<string, number>)[n] ?? 3;
    }
    for (const e of j.events || []) {
      const d = (e.data || {}) as Record<string, any>;
      if (e.type === 'EventAttack') {
        const shots = (d.eventAttackShotDetail || d.eventAttackDetail?.eventAttackShotDetail || []) as Record<string, any>[];
        const kills = shots.filter((s) => s.targetDestroyed).length;
        const dmg = shots.reduce((n, s) => n + Number(s.damage || 0), 0);
        this.r.kills += kills; this.r.damage += dmg; xp += kills * 60 + dmg * 4;
      }
      if (e.type === 'EventRaid' && String((d.eventRaidDetail || d).status) === 'raidSuccessful') this.r.raids++;
      if (e.type === 'EventOreMine') this.r.ore += Number((d.eventOreMineDetail || d).amount || 0);
      if (e.type === 'EventAlphaRefine') this.r.alpha += Number((d.eventAlphaRefineDetail || d).amount || 0);
    }
    this.r.xp += xp;
    this.save();
    const after = this.rank;
    if (after > before) { const rank = RANKS[after]; whenNoticesShow(() => { audio.stinger('secure', 0.8); banner(rank.toUpperCase(), 'PROMOTED', 'player', 2800); }, true); }
    safeEach(this.listeners, (f) => f(this.r));
  }
}

export const record = new ServiceRecord();
