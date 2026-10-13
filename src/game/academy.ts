/* Academy progress: which lessons are finished, which screens you have seen, which quizzes you
 * answered. A lesson finishes itself when its check comes true (a screen visited, a battle won,
 * the command line opened) or when its quiz is answered right. Each pays XP into the service
 * record once, so learning ranks you up just like playing does; a finished track pays a badge.
 * Kept in this browser only. */
import { TRACKS, LESSONS, lessonById, trackOf, BADGE_XP, type Lesson, type LessonCheck } from '../data/learn';
import { record } from './record';
import { loadRecord } from '../screens/battle/record';
import { toast, banner, whenNoticesShow } from '../core/dom';
import { audio } from '../core/audio';
import { safeEach } from '../core/util';
import { goTo } from '../core/nav';

const KEY = 'structs.academy.v1';
const MAX_SEEN = 400;

/** `fresh`: started over (a reset), so badges from before don't fill tracks back in. */
interface State { done: string[]; seen: string[]; events: string[]; tries: Record<string, number>; fresh?: boolean; base?: Partial<Record<Stat, number>>; dailyLast?: string }
type Stat = 'wins' | 'flagships' | 'dailyWins' | 'gauntlet' | 'battles';

type Fn = () => void;

function readNum(k: string): number { try { return Number(localStorage.getItem(k) || 0) || 0; } catch { return 0; } }
function dailyKeys(): string[] {
  try { const v = JSON.parse(localStorage.getItem('structs.daily.wins') || '{}') as { keys?: unknown }; return Array.isArray(v.keys) ? v.keys.filter((k): k is string => typeof k === 'string') : []; } catch { return []; }
}
function dailyWins(): number { return dailyKeys().length; }

/** A battle tally as it stands now (the simulator's record, the daily wins, the best Gauntlet run). */
function statNow(k: Stat): number {
  const r = loadRecord();
  return k === 'wins' ? r.wins : k === 'flagships' ? r.flagships : k === 'battles' ? r.battles : k === 'dailyWins' ? dailyWins() : readNum('structs.gauntlet.best');
}

class Academy {
  private s: State = { done: [], seen: [], events: [], tries: {} };
  private listeners = new Set<Fn>();
  /** The lesson the Academy page has open ('' for none): finished there, it needs no toast, because
   * the page itself shows the tick and the XP (and a toast would cover the answer just tapped). */
  private onScreen = '';

  constructor() {
    this.load();
    if (typeof window === 'undefined') return;
    // Another tab's progress: show it. (A battle another tab won is checked there, where it was won:
    // re-checking here could pay a lesson that tab is still writing.)
    window.addEventListener('storage', (e) => { if (e.key === KEY) { this.load(); this.emit(); } });
    // This tab's simulator says so when it writes a result.
    window.addEventListener('structs:progress', () => this.check());
  }

  private load() {
    if (this.memOnly) return;
    const s: State = { done: [], seen: [], events: [], tries: {} };
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<State>;
      for (const k of ['done', 'seen', 'events'] as const) if (Array.isArray(v[k])) s[k] = v[k]!.filter((x): x is string => typeof x === 'string');
      if (v.tries && typeof v.tries === 'object' && !Array.isArray(v.tries)) s.tries = { ...v.tries };
      if (v.fresh === true) s.fresh = true;
      if (v.base && typeof v.base === 'object') s.base = { ...v.base };
      if (typeof v.dailyLast === 'string') s.dailyLast = v.dailyLast;
    } catch { /* fresh */ }
    // A badge already earned stays earned when a lesson is added to its track later: count the new
    // lesson as done (it has no XP to pay; the badge was paid). Not after a deliberate fresh start.
    if (!s.fresh) for (const t of TRACKS) if (record.r.missions?.includes('badge:' + t.id)) for (const l of t.lessons) if (!s.done.includes(l.id)) s.done.push(l.id);
    this.s = s;
  }

  onChange(f: Fn) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  private emit() { safeEach(this.listeners, (f) => f()); }
  /** Storage refused a write: this tab's copy is the progress from then on (see record.ts). */
  private memOnly = false;
  private save() { try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch { this.memOnly = true; } }

  isDone(id: string) { return this.s.done.includes(id); }
  get doneCount() { return LESSONS.filter((l) => this.isDone(l.id)).length; }
  get total() { return LESSONS.length; }
  trackProgress(trackId: string) {
    const t = TRACKS.find((x) => x.id === trackId);
    if (!t) return { done: 0, total: 0 };
    return { done: t.lessons.filter((l) => this.isDone(l.id)).length, total: t.lessons.length };
  }
  /** The first lesson not yet done in a track (or overall). */
  next(trackId?: string): Lesson | null {
    const list = trackId ? TRACKS.find((t) => t.id === trackId)?.lessons || [] : LESSONS;
    return list.find((l) => !this.isDone(l.id)) || null;
  }
  /** Wrong answers so far on a quiz (a hint after a miss, never a penalty). */
  misses(id: string) { return this.s.tries[id] || 0; }

  /** A screen was shown (the router calls this, and again when a screen refines its URL). */
  visit(path: string) {
    this.load();
    if (!path || this.s.seen.includes(path)) { this.check(); return; }
    this.s.seen.push(path);
    if (this.s.seen.length > MAX_SEEN) this.s.seen.splice(0, this.s.seen.length - MAX_SEEN);
    this.save();
    this.check();
  }

  /** Something happened worth a lesson (the command line opened, the glossary read). */
  mark(event: 'palette' | 'glossary' | 'help' | 'expert') {
    this.load();
    if (!this.s.events.includes(event)) { this.s.events.push(event); this.save(); }
    this.check();
  }

  private met(c: LessonCheck): boolean {
    if ('route' in c) return this.s.seen.some((p) => c.route.endsWith('/') ? p.startsWith(c.route) && p.length > c.route.length : p === c.route || p.startsWith(c.route + '/'));
    if ('event' in c) return this.s.events.includes(c.event);
    const n = statNow(c.stat);
    const base = this.s.base?.[c.stat] ?? 0;
    // After a fresh start, battles fought before it don't count: only what was done since. (A best
    // Gauntlet run can't be counted again: one already at the goal stands.)
    if (c.stat === 'gauntlet') return n >= c.min && (n > base || base >= c.min);
    // Daily wins are a capped list of dates: after a fresh start, count wins dated after it.
    if (c.stat === 'dailyWins' && this.s.dailyLast !== undefined) { const last = this.s.dailyLast; return dailyKeys().filter((k) => k > last).length >= c.min; }
    return n - base >= c.min;
  }

  /** Finish every lesson whose check has come true. */
  check() {
    for (const l of LESSONS) if (l.check && !this.isDone(l.id) && this.met(l.check)) this.complete(l.id);
  }

  /** The Academy page says which lesson it has open (null: none, or the page closed). */
  showing(id: string | null) { this.onScreen = id || ''; }

  /** Answer a quiz: right finishes the lesson, wrong counts a miss. */
  answer(id: string, choice: number): boolean {
    const l = lessonById.get(id);
    if (!l?.quiz) return false;
    if (choice === l.quiz.answer) { this.complete(id); return true; }
    this.load();
    this.s.tries[id] = (this.s.tries[id] || 0) + 1;
    this.save();
    audio.play('deny');
    this.emit();
    return false;
  }

  private complete(id: string) {
    const l = lessonById.get(id);
    this.load();
    if (!l || this.isDone(id)) return;
    this.s.done.push(id);
    this.save();
    // A lesson finished again after a fresh start pays nothing twice, and says so honestly.
    const paid = record.award('academy:' + id, l.xp);
    const shown = this.onScreen === id && typeof location !== 'undefined' && location.pathname.includes('/academy');
    this.announce(l, paid ? l.xp : 0, shown);
    const t = trackOf(id);
    if (t && t.lessons.every((x) => this.isDone(x.id)) && record.award('badge:' + t.id, BADGE_XP)) {
      // After any promotion banner the XP just raised has had its moment.
      const celebrate = () => { audio.stinger('secure', 0.7); banner(t.badge.toUpperCase(), `${t.label} badge earned · +${BADGE_XP} XP`, 'player', 3200); };
      // A badge's fanfare and banner together: at PRESS START both wait for the doors.
      whenNoticesShow(() => { if (document.querySelector('.banner:not(.out)')) setTimeout(celebrate, 2900); else celebrate(); }, true);
    }
    this.emit();
  }

  /* Lessons finished in the same moment (a returning player's check() can finish several at once)
   * are said once: one sound and one toast ("2 lessons done · +60 XP"), through the same hold as
   * every other piece of good news, so PRESS START and the board keep the screen to themselves. */
  private told: { l: Lesson; xp: number; shown: boolean }[] = [];
  private announce(l: Lesson, xp: number, shown: boolean) {
    this.told.push({ l, xp, shown });
    if (this.told.length > 1) return;
    setTimeout(() => {
      const all = this.told.splice(0);
      const say = all.filter((x) => !x.shown);
      // A lesson finished on its own page has its moment there: the chime now, no toast.
      if (!say.length) { audio.play('confirm'); return; }
      // The toast speaks only for the lessons it names (and their XP); its chime waits with it.
      const xp = say.reduce((a, x) => a + x.xp, 0);
      const one = say.length === 1 ? say[0].l : null;
      const text = one ? `★ ${one.title}${xp ? ` · +${xp} XP` : ''}` : `★ ${say.length} lessons done${xp ? ` · +${xp} XP` : ''}`;
      const go = one ? `/academy/${trackOf(one.id)?.id || ''}/${one.id}` : '/academy';
      if (say.length < all.length) audio.play('confirm');
      whenNoticesShow(() => { audio.play('confirm'); toast(text, 'player', 4200, { label: '▸', run: () => goTo(go) }); });
    }, 0);
  }

  /** Start the Academy over (a shared computer, a new learner). The service record keeps its XP:
   * lessons finished again pay nothing twice. */
  reset() {
    const base: Partial<Record<Stat, number>> = {};
    for (const k of ['wins', 'flagships', 'dailyWins', 'gauntlet', 'battles'] as Stat[]) base[k] = statNow(k);
    this.s = { done: [], seen: [], events: [], tries: {}, fresh: true, base, dailyLast: dailyKeys().sort().pop() ?? '' };
    this.save();
    this.emit();
  }

  /** Badges earned (a finished track each). */
  get badges() { return TRACKS.filter((t) => t.lessons.every((l) => this.isDone(l.id))); }
}

export const academy = new Academy();
