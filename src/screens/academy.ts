/* The Academy: learn the game by playing it. Three tracks (Strategy, Economics, Technology), each
 * a ladder of short lessons that finish themselves when you do the thing or answer the quiz,
 * plus the commander career (the live game's missions) and the glossary.
 *   /academy                     the next lesson's track
 *   /academy/<track>[/<lesson>]  a track, a lesson opened
 *   /academy/career              the mission ladder
 *   /academy/glossary            every word, explained */
import '../styles/learn.css';
import '../styles/dc-lab.css';
import type { Engine } from '../core/engine';
import { h } from '../core/dom';
import { audio } from '../core/audio';
import { PanelScreen } from './panelScreen';
import { TRACKS, GLOSSARY, lessonById, trackOf, type Lesson, type LessonCheck, type Track } from '../data/learn';
import { academy } from '../game/academy';
import { record, RANKS, xpFor } from '../game/record';
import { MISSIONS, progress } from '../game/missions';
import { wallet } from '../wallet/wallet';
import { empire } from '../game/empire';
import { openVault } from '../ui/vault';
import { glossaryList } from '../ui/guide';
import { icon } from '../ui/icons';
import { replaceRoute } from '../core/nav';
import { keepFocus } from '../ui/keepFocus';
import { togglePalette } from '../ui/palette';
import { dailyScenario } from '../sim/fleets';
import { matchupQuestion, priceQuestion, codeQuestion, type MatchupQuestion, type PriceQuestion, type CodeQuestion } from '../game/practice';
import { dailyBest, dailyStreak } from './battle/record';

type Tab = Track['id'] | 'career' | 'glossary';
/** What the main panel shows in a track: one lesson (by id), or the track's practice game. */
type Pick = string;
const PRACTICE = 'practice';

const TRACK_ICON: Record<Tab, string> = { strategy: 'battle', economics: 'trade', technology: 'lab', career: 'base', glossary: 'book' };
const PRACTICE_NAME: Record<Track['id'], string> = { strategy: 'Who can hit whom?', economics: 'What does it cost?', technology: 'Be the computer' };

const CAREER_COLOR = '#43CDB6';
const GLOSS_COLOR = '#94A4E4';

/** What finishing a "do it" lesson takes, in words. */
function doText(c: LessonCheck): string {
  if ('route' in c) return 'Open the screen and look around.';
  if ('event' in c) return c.event === 'palette' ? 'Open the command line (press the / key).' : c.event === 'glossary' ? 'Hover a dotted word anywhere.' : c.event === 'expert' ? 'Switch on Expert mode (three-dot menu, top right).' : 'Open the field manual.';
  return ({ wins: `Win ${c.min} training battle${c.min > 1 ? 's' : ''}.`, flagships: 'Destroy an enemy Command Ship in a training battle.', dailyWins: 'Win a Daily Challenge.', gauntlet: `Clear ${c.min} Gauntlet rounds in one run.`, battles: `Fight ${c.min} training battles.` } as Record<string, string>)[c.stat];
}

/** A stable shuffle per lesson, so the right answer isn't always in the same place. */
function order(id: string, n: number): number[] {
  let s = 2166136261;
  for (const c of id) s = Math.imul(s ^ c.charCodeAt(0), 16777619) >>> 0;
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { s = Math.imul(s ^ (s >>> 15), 2246822507) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export class AcademyScreen extends PanelScreen {
  private tab: Tab = 'strategy';
  /** The lesson (or practice) on show in the track, and the mission on show in the career; null: the next one. */
  private sel: Pick | null = null;
  private msel: string | null = null;
  /** The wrong pick on each quiz this visit (to mark it), and the right one once found. */
  private picked = new Map<string, number>();
  private side!: HTMLElement;
  private main!: HTMLElement;
  private frame!: HTMLElement;
  private filter = '';
  /** The ? button: each panel's explanations (.dc-hint) show while it is pressed. */
  private why = false;
  /** On the next paint, put the cursor on the first answer (a quiz or practice question just opened). */
  private focusQuiz = false;
  /** On the next paint, scroll the answer's result and what to press next (or a new question) into view. */
  private reveal = false;
  /** The card whose wrong answer shakes, on the paint right after the click only (not on every repaint). */
  private shake = '';
  private timer = 0;

  constructor(engine: Engine, navigate: (hash: string) => void) { super(engine, navigate, 'academy', 5.2); }

  protected mount(params: Record<string, string>) {
    academy.check();
    const arg = params.track as Tab | undefined;
    const valid: Tab[] = [...TRACKS.map((t) => t.id), 'career', 'glossary'];
    this.tab = arg && valid.includes(arg) ? arg : (academy.next() ? trackOf(academy.next()!.id)!.id : 'strategy');
    this.picked.clear();
    this.msel = null;
    // The screen instance lives on between visits: a search only carries over when the URL names it.
    this.filter = this.tab === 'glossary' && params.lesson ? params.lesson : '';
    this.sel = params.lesson && (lessonById.has(params.lesson) || params.lesson === PRACTICE) ? params.lesson : null;
    this.side = h('div', { class: 'ac-side panel player scroll' });
    this.main = h('div', { class: 'ac-main panel scroll' });
    this.frame = h('div', { class: 'ac-frame' + (this.why ? ' dc-why' : '') }, this.side, this.main);
    this.root.append(this.frame);
    const paint = () => this.schedule();
    this.cleanup.push(academy.onChange(paint), record.onChange(paint), wallet.onChange(paint), empire.onChange(paint));
    // Answers by number (keys 1–4), and the arrows (a pad's d-pad) stay inside a question's answers.
    const keys = (e: KeyboardEvent) => this.answerKeys(e);
    window.addEventListener('keydown', keys);
    this.cleanup.push(() => window.removeEventListener('keydown', keys));
    this.focusQuiz = true;
    this.paint();
    // A deep link to a lesson brings its card into view.
    if (params.lesson) requestAnimationFrame(() => this.main.querySelector('.ac-lesson, .ac-practice')?.scrollIntoView({ block: 'nearest' }));
  }
  protected unmount() { clearTimeout(this.timer); this.timer = 0; academy.showing(null); }

  private schedule() { if (!this.timer) this.timer = window.setTimeout(() => { this.timer = 0; this.paint(); }, 60); }

  private go(tab: Tab, sel: Pick | null = null) {
    if (tab === this.tab) { if (sel) this.pick(sel); return; }
    this.tab = tab;
    this.sel = sel;
    this.filter = '';
    replaceRoute('/academy/' + tab + (sel ? '/' + sel : ''));
    audio.play('select');
    this.focusQuiz = true;
    this.paint(true);
    this.main.scrollTop = 0;
  }

  /** Open one lesson (or the practice) in the track on show. */
  private pick(id: Pick) {
    this.sel = id;
    replaceRoute(`/academy/${this.tab}/${id}`);
    audio.play('select');
    this.focusQuiz = true;
    this.paint(true);
    // On a stacked (narrow) layout the card sits under the tiles: bring it up.
    requestAnimationFrame(() => this.main.querySelector('.ac-lesson, .ac-practice')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  /** `force`: a press of the player's own (a track, a tile) repaints even while the search box has focus. */
  private paint(force = false) {
    if (!this.root?.isConnected) return;
    // Typing in the glossary search: don't repaint under the cursor.
    if (!force && document.activeElement && this.main.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    // A direct paint replaces a scheduled one (which would redraw without the shake).
    clearTimeout(this.timer); this.timer = 0;
    // The cursor (keyboard, pad) stays on the tile it was on.
    keepFocus(this.frame, () => {
      this.paintSide();
      const top = this.main.scrollTop;
      if (this.tab === 'career') this.paintCareer();
      else if (this.tab === 'glossary') this.paintGlossary();
      else this.paintTrack(TRACKS.find((t) => t.id === this.tab)!);
      this.main.scrollTop = top;
    // An answer disables its choices: the cursor moves on to Next (or Try it, or the lesson's tile).
    }, () => this.main.querySelector<HTMLElement>('[data-k="next"]') || this.main.querySelector<HTMLElement>('[data-k="try"]') || this.main.querySelector<HTMLElement>('.ac-tile.on'));
    this.shake = '';
    // A question just opened: the cursor starts on its first answer (a pad's A then answers it).
    if (this.focusQuiz) {
      this.focusQuiz = false;
      this.answers()[0]?.focus({ preventScroll: true });
    }
    // After an answer the why and the Next button sit below the answers, off a short screen: bring
    // them up (a new practice question brings up its question and first answer instead).
    if (this.reveal) {
      this.reveal = false;
      const why = this.main.querySelector<HTMLElement>('.ac-why');
      const next = this.main.querySelector<HTMLElement>('[data-k="next"]');
      if (why || next) { why?.scrollIntoView({ block: 'nearest' }); next?.scrollIntoView({ block: 'nearest' }); }
      else { this.main.querySelector<HTMLElement>('.ac-practice .ac-q')?.scrollIntoView({ block: 'nearest' }); this.answers()[0]?.scrollIntoView({ block: 'nearest' }); }
    }
  }

  /** The open question's answers that can still be pressed, in the order shown. */
  private answers(): HTMLElement[] {
    return [...this.main.querySelectorAll<HTMLButtonElement>('.ac-quiz .ac-choice, .ac-practice .ac-choice')].filter((b) => !b.disabled);
  }

  /** Keys 1–4 press that answer; on an answer, the arrows step through the answers first. */
  private answerKeys(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || document.querySelector('.modal-back')) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    const list = this.answers();
    if (!list.length) return;
    if (/^[1-4]$/.test(e.key)) {
      const b = list[Number(e.key) - 1];
      if (b) { e.preventDefault(); b.focus({ preventScroll: true }); b.click(); }
      return;
    }
    const at = a ? list.indexOf(a) : -1;
    if (at < 0) return;
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    // Past the first or last answer the key is left free, so the d-pad can still leave the question.
    const to = list[at + step];
    if (!step || !to) return;
    e.preventDefault();
    to.focus();
  }

  /* ── The side: you, your rank, today's challenge, the tracks as tiles ── */

  private paintSide() {
    const rank = record.rank;
    const toNext = rank + 1 < RANKS.length ? xpFor(rank + 1) - record.r.xp : 0;
    const p = wallet.primary?.playerId ? empire.players.get(wallet.primary.playerId) ?? null : null;
    const career = progress();
    // A track is a tile: its picture, its name, a pip per lesson, and the badge star it earns.
    const tile = (id: Tab, label: string, title: string, color: string, extra: (HTMLElement | null)[]) =>
      h('button', { class: 'ac-track' + (this.tab === id ? ' on' : ''), style: `--hub:${color}`, title, 'aria-label': label, 'aria-current': this.tab === id ? 'page' : null, onclick: () => this.go(id) },
        h('span', { class: 'ac-track-ico', html: icon(TRACK_ICON[id], 30) }),
        h('span', { class: 'ac-track-name' }, label), ...extra);
    const whyBtn = h('button', { class: 'btn ghost icon dc-why-btn' + (this.why ? ' active' : ''), 'aria-label': 'Explain', 'aria-pressed': this.why ? 'true' : 'false', title: 'Explain: show the words behind the pictures',
      onclick: () => { this.why = !this.why; this.frame.classList.toggle('dc-why', this.why); audio.play('select'); keepFocus(this.side, () => this.paintSide()); } }, h('span', { html: icon('help', 18) }));
    const intro = 'Learn strategy, economics and technology by playing. Every lesson earns XP toward your rank.';
    this.side.replaceChildren(
      h('div', { class: 'ac-hello', title: intro },
        h('div', { class: 'ac-title' }, h('span', { html: icon('academy', 24) }), h('span', null, 'Academy'), whyBtn),
        h('div', { class: 't-body c-hint dc-hint' }, intro)),
      h('div', { class: 'ac-rank', title: `${record.r.xp} XP · ${toNext > 0 ? `${toNext} XP to ${RANKS[rank + 1]}` : 'Top rank. Legendary.'} · ${academy.doneCount} of ${academy.total} lessons done` },
        h('div', { class: 'spread' },
          h('span', { class: 'ac-rank-name' }, h('span', { html: icon('record', 18) }), RANKS[rank]),
          h('span', { class: 'dc-num dc-big c-neutral', 'aria-label': `${record.r.xp} XP` }, h('span', { html: icon('star', 16) }), String(record.r.xp))),
        h('span', { class: 'ac-meter gold' }, h('i', { style: `width:${record.progress * 100}%` })),
        h('div', { class: 'spread ac-rank-foot' },
          // What is left to earn, then where it leads: "★60 to go ▸ Ensign".
          toNext > 0 ? h('span', { class: 'dc-num c-hint', role: 'img', 'aria-label': `${toNext} XP to go to ${RANKS[rank + 1]}`, title: `${toNext} XP to go to ${RANKS[rank + 1]}` }, h('span', { html: icon('star', 11) }), `${toNext} to go ▸ `, RANKS[rank + 1]) : h('span', { class: 'dc-num c-neutral' }, '★'),
          h('span', { class: 'dc-num c-hint', 'aria-label': `${academy.doneCount} of ${academy.total} lessons done` }, h('span', { html: icon('book', 14) }), `${academy.doneCount}/${academy.total}`))),
      this.dailyCard(),
      h('div', { class: 'ac-tracks' },
        ...TRACKS.map((t) => {
          const got = t.lessons.every((l) => academy.isDone(l.id));
          const pr = academy.trackProgress(t.id);
          return tile(t.id, t.label, `${t.label}: ${t.tagline} · ${pr.done}/${pr.total} lessons · ${t.badge} badge${got ? ': earned' : `: finish every ${t.label} lesson`}`, t.color, [
            h('span', { class: 'ac-track-badge' + (got ? ' got' : ''), 'aria-label': `${t.badge} badge${got ? ' earned' : ''}`, html: icon('star', 14) }),
            h('span', { class: 'lab-pips' }, ...t.lessons.map((l) => h('i', { class: academy.isDone(l.id) ? 'on' : '' })))]);
        }),
        tile('career', 'Career', `Commander career: the live game, from first build to first raid · ${career.done}/${career.total} missions`, CAREER_COLOR, [
          h('span', { class: 'lab-pips' }, ...MISSIONS.map((m) => h('i', { class: m.done(p) ? 'on' : '' })))]),
        tile('glossary', 'Glossary', 'Every game word, explained', GLOSS_COLOR, [h('span', { class: 'ac-track-n' }, String(GLOSSARY.length))])));
  }

  /** Today's Daily Challenge: one battle a day, the same for everyone, and your streak. */
  private dailyCard(): HTMLElement {
    const d = dailyScenario();
    const best = dailyBest(d.key), streak = dailyStreak(d.key);
    const why = [`Today’s challenge: ${d.name}`, `${d.twist.name}: the same battle for everyone today.`, streak > 1 ? `${streak}-day streak. Keep it going!` : best?.won ? 'Won. Come back tomorrow for a new one.' : ''].filter(Boolean).join('\n');
    return h('button', { class: 'ac-daily', title: why, onclick: () => { audio.play('select'); this.navigate('/sim/daily'); } },
      h('span', { class: 'ac-daily-ico', html: icon('daily', 28) }),
      h('span', { class: 'col', style: 'gap:2px; min-width:0; flex:1' },
        h('span', { class: 'ac-daily-k' }, 'Daily', best?.won ? ' ✓' : ''),
        h('span', { class: 'ac-daily-name' }, d.name.replace(/^Operation /, ''))),
      streak > 1 ? h('span', { class: 'dc-num c-enemy', 'aria-label': `${streak}-day streak` }, `${streak}×`) : null,
      h('span', { class: 'dc-face a' }, 'A'));
  }

  /* ── A track: its lessons as numbered tiles, one open beneath them ─── */

  private paintTrack(t: Track) {
    const p = academy.trackProgress(t.id);
    const next = academy.next(t.id);
    const got = p.done === p.total;
    // On show: the lesson picked, else the next one to do, else (all done) the practice game.
    const sel = this.sel && (this.sel === PRACTICE || t.lessons.some((l) => l.id === this.sel)) ? this.sel : next?.id ?? PRACTICE;
    this.main.style.setProperty('--hub', t.color);
    // Tell the lesson keeper what is open here: finishing it on this page needs no toast over the answers.
    academy.showing(sel === PRACTICE ? null : sel);
    const open = t.lessons.findIndex((l) => l.id === sel);
    this.main.replaceChildren(
      h('div', { class: 'ac-head', title: `${t.label} track: ${t.tagline}` },
        h('span', { class: 'ac-head-ico', html: icon(TRACK_ICON[t.id], 34) }),
        h('div', { class: 'col grow', style: 'gap:2px; min-width:0' }, h('span', { class: 'ac-h1' }, t.label), h('span', { class: 'ac-kicker dc-hint' }, t.tagline)),
        // The track's practice game: endless questions, beside the lessons.
        h('button', { class: 'btn ac-practice-btn' + (sel === PRACTICE ? ' active' : ''), 'aria-pressed': sel === PRACTICE ? 'true' : 'false', title: `Practice: ${PRACTICE_NAME[t.id]} Endless questions`, onclick: () => this.pick(PRACTICE) },
          h('span', { html: icon('target', 16) }), h('span', { class: 'ac-practice-word' }, 'Practice')),
        h('div', { class: 'ac-head-n', title: got ? `${t.badge} badge earned` : `Lessons done · finish all for the ${t.badge} badge` },
          h('span', { class: 'ac-track-badge big' + (got ? ' got' : ''), html: icon('star', 22) }), h('span', { class: 'ac-big' }, `${p.done}/${p.total}`))),
      h('div', { class: 'ac-tiles' }, ...t.lessons.map((l, i) => this.lessonTile(l, i, l === next, l.id === sel))),
      sel === PRACTICE ? (t.id === 'strategy' ? this.practice() : t.id === 'economics' ? this.pricePractice() : this.codePractice())
        : this.lesson(t.lessons[open], open, t.lessons[open] === next));
  }

  /** A lesson as a numbered tile: its number (a check once done), quiz or do-it, and a beacon on the next one. */
  private lessonTile(l: Lesson, i: number, isNext: boolean, on: boolean): HTMLElement {
    const done = academy.isDone(l.id);
    return h('button', { class: 'ac-tile' + (done ? ' done' : '') + (isNext && !done ? ' next' : '') + (on ? ' on' : ''), 'data-lesson': l.id, 'aria-pressed': on ? 'true' : 'false', 'aria-label': `${i + 1}. ${l.title}${done ? ' ✓' : ''}`,
      title: `${i + 1}. ${l.title} · ${l.quiz ? 'Quiz' : 'Do it'} · +${l.xp} XP${done ? ' ✓' : isNext ? ' · next up' : ''}`, onclick: () => this.pick(l.id) },
    h('span', { class: 'ac-tile-n' }, ...(done ? [h('span', { html: icon('check', 22) })] : [String(i + 1)])),
    h('span', { class: 'ac-tile-k', 'aria-label': l.quiz ? 'Quiz' : 'Do it', html: icon(l.quiz ? 'help' : 'play', 11) }),
    // Under the ? button the tiles become a list with their names (no hover on a phone).
    h('span', { class: 'ac-tile-t dc-hint' }, l.title),
    isNext && !done ? h('span', { class: 'ac-ping', 'aria-label': 'Next up' }) : null);
  }

  /* ── Practice: endless questions from the real data ──────────────── */
  private pq: MatchupQuestion | null = null;
  private pAnswer: boolean | null = null;
  private pStreak = 0;
  private prq: PriceQuestion | null = null;
  private prPick: number | null = null;
  private prStreak = 0;

  /** A practice game's header: its picture and name, then the streak and the best, as numbers. */
  private practiceHead(name: string, streak: number, best: number, hint: string): HTMLElement[] {
    return [
      h('div', { class: 'spread ac-practice-head', title: hint },
        h('div', { class: 'row', style: 'gap:10px; min-width:0' }, h('span', { class: 'ac-head-ico', html: icon('target', 26) }), h('span', { class: 'ac-h1' }, name)),
        h('div', { class: 'row', style: 'gap:12px' },
          h('span', { class: 'dc-num dc-big', title: 'In a row', 'aria-label': `${streak} in a row` }, h('span', { class: 'c-hub', html: icon('charge', 18) }), String(streak)),
          h('span', { class: 'dc-num c-neutral', title: 'Best streak', 'aria-label': `best ${best}` }, h('span', { html: icon('star', 14) }), String(best)))),
      h('div', { class: 't-tiny c-hint dc-hint' }, hint)];
  }

  /** The buttons after an answer: the next question, and where to see the real thing. */
  private practiceNext(next: () => void, href: string, ico: string, label: string): HTMLElement {
    return h('div', { class: 'row wrap' },
      h('button', { class: 'btn solid', 'data-k': 'next', onclick: next }, h('span', { class: 'dc-face a mini' }, 'A'), 'Next ▸'),
      h('a', { class: 'btn ghost', href, title: label }, h('span', { html: icon(ico, 14) }), label));
  }

  /** Economics practice: what does the energy cost? Same streak idea as the matchups. */
  private pricePractice(): HTMLElement {
    this.prq ??= priceQuestion();
    const q = this.prq;
    const answered = this.prPick !== null;
    const right = answered && this.prPick === q.answer;
    const best = (() => { try { return Number(localStorage.getItem('structs.practice.price') || 0) || 0; } catch { return 0; } })();
    const choose = (i: number) => {
      if (this.prPick !== null) return;
      this.prPick = i;
      if (i === q.answer) { this.prStreak++; audio.play('confirm'); try { if (this.prStreak > best) localStorage.setItem('structs.practice.price', String(this.prStreak)); } catch { /* ignore */ } }
      else { this.prStreak = 0; this.shake = 'prq'; audio.play('deny'); }
      this.reveal = true;
      this.paint();
    };
    const next = () => { this.prq = priceQuestion(); this.prPick = null; audio.play('select'); this.focusQuiz = true; this.reveal = true; this.paint(); };
    return h('div', { class: 'ac-practice' },
      ...this.practiceHead(PRACTICE_NAME.economics, this.prStreak, Math.max(best, this.prStreak), 'Energy on the market is priced per kilowatt per day. Multiply to find the total.'),
      h('div', { class: 'ac-q' }, q.q),
      h('div', { class: 'ac-choices' }, ...q.choices.map((c, i) => h('button', { class: 'ac-choice' + (answered && i === q.answer ? ' right' : answered && i === this.prPick ? (this.shake === 'prq' ? ' wrong shake' : ' wrong') : ''), disabled: answered, 'data-k': `pr:${i}`, onclick: () => choose(i) }, h('span', { class: 'ac-choice-n' }, String(i + 1)), c))),
      answered ? h('div', { class: 'ac-why ' + (right ? 'right' : 'wrong') }, right ? 'Right! ' : 'Not quite. ', q.why) : null,
      answered ? this.practiceNext(next, '/economy/market', 'market', 'Market') : null);
  }

  private cq: CodeQuestion | null = null;
  private cqPick: number | null = null;
  private cqStreak = 0;

  /** Technology practice: run the robots' program in your head. */
  private codePractice(): HTMLElement {
    this.cq ??= codeQuestion();
    const q = this.cq;
    const answered = this.cqPick !== null;
    const right = answered && this.cqPick === q.answer;
    const best = (() => { try { return Number(localStorage.getItem('structs.practice.code') || 0) || 0; } catch { return 0; } })();
    const choose = (i: number) => {
      if (this.cqPick !== null) return;
      this.cqPick = i;
      if (i === q.answer) { this.cqStreak++; audio.play('confirm'); try { if (this.cqStreak > best) localStorage.setItem('structs.practice.code', String(this.cqStreak)); } catch { /* ignore */ } }
      else { this.cqStreak = 0; this.shake = 'cq'; audio.play('deny'); }
      this.reveal = true;
      this.paint();
    };
    const next = () => { this.cq = codeQuestion(); this.cqPick = null; audio.play('select'); this.focusQuiz = true; this.reveal = true; this.paint(); };
    const program = ['if (planet is used up)  return explore()', 'if (a machine is off and power allows)  return switchOn(machine)', 'if (a machine on its list is missing and nothing is being built)  return build(next one)', 'if (job == "raider")  return sail(meeting point, or "home")', 'if (job == "productive" and alpha > keep + 0.1)  return sendHome(alpha − keep)', 'return wait()'];
    return h('div', { class: 'ac-practice' },
      ...this.practiceHead(PRACTICE_NAME.technology, this.cqStreak, Math.max(best, this.cqStreak), 'A simplified copy of your robot helpers’ program (keep = the “send alpha home above” setting). Read it top to bottom: the first rule that fits is the move.'),
      h('div', { class: 'robot-code ac-code', title: 'keep = the “send alpha home above” setting. The first rule that fits is the move.' }, ...program.map((line) => h('div', { class: 'ac-code-line' }, line))),
      h('div', { class: 'ac-q' }, q.q),
      h('div', { class: 'ac-choices' }, ...q.choices.map((c, i) => h('button', { class: 'ac-choice mono' + (answered && i === q.answer ? ' right' : answered && i === this.cqPick ? (this.shake === 'cq' ? ' wrong shake' : ' wrong') : ''), disabled: answered, 'data-k': `cq:${i}`, onclick: () => choose(i) }, h('span', { class: 'ac-choice-n' }, String(i + 1)), c))),
      answered ? h('div', { class: 'ac-why ' + (right ? 'right' : 'wrong') }, right ? 'Right! ' : 'Not quite. ', q.why) : null,
      answered ? this.practiceNext(next, '/ops/orders', 'rules', 'Robot Rules') : null);
  }

  private practiceBest(): number { try { return Number(localStorage.getItem('structs.practice.best') || 0) || 0; } catch { return 0; } }

  private practice(): HTMLElement {
    this.pq ??= matchupQuestion();
    const q = this.pq;
    const answered = this.pAnswer !== null;
    const right = answered && this.pAnswer === q.yes;
    const choose = (yes: boolean) => {
      if (this.pAnswer !== null) return;
      this.pAnswer = yes;
      if (yes === q.yes) {
        this.pStreak++;
        audio.play('confirm');
        try { if (this.pStreak > this.practiceBest()) localStorage.setItem('structs.practice.best', String(this.pStreak)); } catch { /* ignore */ }
      } else { this.pStreak = 0; this.shake = 'pq'; audio.play('deny'); }
      this.reveal = true;
      this.paint();
    };
    const next = () => { this.pq = matchupQuestion(); this.pAnswer = null; audio.play('select'); this.focusQuiz = true; this.reveal = true; this.paint(); };
    return h('div', { class: 'ac-practice' },
      ...this.practiceHead(PRACTICE_NAME.strategy, this.pStreak, Math.max(this.practiceBest(), this.pStreak), 'Endless questions made from the real units, using the same rules as battles. (Stealth left out.)'),
      h('div', { class: 'ac-q' }, q.q),
      h('div', { class: 'ac-practice-row' },
        h('button', { class: 'ac-choice' + (answered && q.yes ? ' right' : answered && this.pAnswer === true ? (this.shake === 'pq' ? ' wrong shake' : ' wrong') : ''), disabled: answered, 'data-k': 'pq:yes', onclick: () => choose(true) }, h('span', { class: 'ac-choice-n' }, '1'), 'Yes'),
        h('button', { class: 'ac-choice' + (answered && !q.yes ? ' right' : answered && this.pAnswer === false ? (this.shake === 'pq' ? ' wrong shake' : ' wrong') : ''), disabled: answered, 'data-k': 'pq:no', onclick: () => choose(false) }, h('span', { class: 'ac-choice-n' }, '2'), 'No')),
      answered ? h('div', { class: 'ac-why ' + (right ? 'right' : 'wrong') }, right ? 'Right! ' : 'Not quite. ', q.why) : null,
      answered ? this.practiceNext(next, '/codex/' + q.attacker, 'book', 'Unit Guide') : null);
  }

  /** The open lesson: its words (lessons are reading), then the quiz or the thing to do, and Try it. */
  private lesson(l: Lesson, i: number, isNext: boolean): HTMLElement {
    const done = academy.isDone(l.id);
    const kind = l.quiz ? 'Quiz' : 'Do it';
    const expertOn = document.body.classList.contains('expert');
    const tryWord = l.go === 'expert' ? (expertOn ? 'Expert mode ✓' : 'Expert mode') : 'Try it';
    return h('div', { class: 'ac-lesson open' + (done ? ' done' : '') + (isNext ? ' next' : ''), 'data-lesson': l.id },
      h('div', { class: 'ac-lesson-head static' },
        h('span', { class: 'ac-num' }, ...(done ? [h('span', { html: icon('check', 14) })] : [String(i + 1)])),
        h('span', { class: 'ac-lesson-title' }, l.title),
        // What kind of lesson, as a plain word: not a button, so nothing that looks pressable.
        h('span', { class: 'ac-kind', title: l.quiz ? 'Answer the quiz to finish' : 'Do it in the game to finish' }, kind),
        h('span', { class: 'ac-xp' + (done ? ' got' : ''), title: `${l.xp} XP` }, h('span', { html: icon(done ? 'check' : 'star', 12) }), `+${l.xp}`)),
      h('div', { class: 'ac-lesson-body' },
        h('p', { class: 'ac-learn' }, l.learn),
        l.quiz ? this.quiz(l, done) : null,
        l.check ? h('div', { class: 'ac-do', title: done ? 'Done' : 'To finish' }, h('span', { class: 'ac-do-ico', html: icon(done ? 'check' : 'flag', 16) }), h('span', { class: 't-body' }, done ? 'You did it.' : doText(l.check))) : null,
        h('div', { class: 'row wrap' },
          // The A badge marks the one thing to do: Try it for a do-it lesson; a quiz is finished by its answers.
          l.go ? h('button', { class: 'btn' + (done || l.quiz ? ' ghost' : ' solid'), 'data-k': 'try', title: l.go === 'expert' ? (expertOn ? 'Expert mode is on (switch it off in the More menu)' : 'Switch Expert mode on') : done ? 'Try it again' : 'Try it', onclick: () => this.tryIt(l) },
            done || l.quiz ? h('span', { html: icon(l.go === 'palette' || l.go === 'expert' ? 'terminal' : 'play', 12) }) : h('span', { class: 'dc-face a mini' }, 'A'), tryWord) : null,
          done ? this.nextButton(l) : null)));
  }

  /** Once a lesson is done: one press to the next one (in this track, else the next unfinished anywhere). */
  private nextButton(l: Lesson): HTMLElement | null {
    const t = trackOf(l.id);
    const next = (t && academy.next(t.id)) || academy.next();
    if (!next || next.id === l.id) return null;
    const nt = trackOf(next.id)!;
    return h('button', { class: 'btn solid', title: `Next lesson: ${next.title}`, onclick: () => {
      if (nt.id !== this.tab) this.go(nt.id, next.id); else this.pick(next.id);
    }, 'data-k': 'next' }, h('span', { class: 'dc-face a mini' }, 'A'), 'Next ▸');
  }

  private tryIt(l: Lesson) {
    // Keep this lesson on show: if trying it finishes it right here, its "You did it" is seen.
    this.sel = l.id;
    audio.play('confirm');
    if (l.go === 'palette') togglePalette(this.navigate);
    // The lesson switches Expert mode ON (structs:expert toggles it, so an already-on mode is only
    // recorded, never turned off).
    else if (l.go === 'expert') { if (document.body.classList.contains('expert')) { academy.mark('expert'); this.paint(true); } else window.dispatchEvent(new Event('structs:expert')); }
    else if (l.go) this.navigate(l.go);
  }

  private quiz(l: Lesson, done: boolean): HTMLElement {
    const q = l.quiz!;
    const wrong = this.picked.get(l.id);
    const misses = academy.misses(l.id);
    const idx = order(l.id, q.choices.length);
    return h('div', { class: 'ac-quiz' },
      h('div', { class: 'ac-q' }, q.q),
      h('div', { class: 'ac-choices' }, ...idx.map((c, k) => {
        const right = c === q.answer;
        const cls = done && right ? ' right' : !done && wrong === c ? (this.shake === 'quiz:' + l.id ? ' wrong shake' : ' wrong') : '';
        return h('button', { class: 'ac-choice' + cls, disabled: done, 'data-k': `q:${l.id}:${c}`, onclick: () => {
          // The answer keeps this lesson on show, so its result is seen before moving on.
          this.sel = l.id;
          if (academy.answer(l.id, c)) this.picked.delete(l.id); else { this.picked.set(l.id, c); this.shake = 'quiz:' + l.id; }
          this.reveal = true;
          this.paint();
        } }, h('span', { class: 'ac-choice-n' }, String(k + 1)), q.choices[c]);
      })),
      done ? h('div', { class: 'ac-why right' }, h('span', { html: icon('check', 12) }), q.why)
        : wrong !== undefined ? h('div', { class: 'ac-why wrong' }, misses >= 2 ? `Not quite. Hint: ${q.why.split(/\.(?:\s|$)/)[0]}.` : 'Not quite. Read the lesson again and have another go.') : null);
  }

  /* ── Career: the live game's missions, as numbered tiles too ──────── */

  private paintCareer() {
    academy.showing(null);
    this.main.style.setProperty('--hub', CAREER_COLOR);
    const { next, done, total } = progress();
    const p = wallet.primary?.playerId ? empire.players.get(wallet.primary.playerId) ?? null : null;
    const keyless = wallet.state === 'empty';
    const sel = MISSIONS.find((m) => m.id === this.msel) || next || MISSIONS[MISSIONS.length - 1];
    const i = MISSIONS.indexOf(sel);
    const ok = sel.done(p);
    const enlist = 'Enlisting makes a free commander in a few seconds. Until then, the Strategy track and training battles need no account at all.';
    this.main.replaceChildren(
      h('div', { class: 'ac-head', title: 'Commander career: from your first build to your first raid' },
        h('span', { class: 'ac-head-ico', html: icon('base', 34) }),
        h('div', { class: 'col grow', style: 'gap:2px; min-width:0' }, h('span', { class: 'ac-h1' }, 'Career'), h('span', { class: 'ac-kicker dc-hint' }, 'From your first build to your first raid')),
        h('div', { class: 'ac-head-n', title: 'Missions done' }, h('span', { class: 'ac-big' }, `${done}/${total}`))),
      ...(keyless ? [h('div', { class: 'ac-cta', title: enlist },
        h('div', { class: 'row', style: 'gap:10px' }, h('span', { class: 'c-player', html: icon('lock', 20) }), h('span', { class: 't-label-lg c-player' }, 'Enlist to start')),
        h('div', { class: 't-body c-hint dc-hint' }, enlist),
        h('div', { class: 'row wrap' }, h('button', { class: 'btn solid', onclick: () => openVault() }, h('span', { class: 'dc-face a mini' }, 'A'), 'Enlist'), h('button', { class: 'btn ghost', title: 'The Strategy track needs no account', onclick: () => this.go('strategy') }, h('span', { html: icon('battle', 14) }), 'Strategy')))] : []),
      h('div', { class: 'ac-tiles' }, ...MISSIONS.map((m, k) => {
        const mdone = m.done(p);
        return h('button', { class: 'ac-tile' + (mdone ? ' done' : '') + (m === next ? ' next' : '') + (m === sel ? ' on' : ''), 'aria-pressed': m === sel ? 'true' : 'false', 'aria-label': `${k + 1}. ${m.title}${mdone ? ' ✓' : ''}`, title: `${k + 1}. ${m.title} · +${m.xp} XP${mdone ? ' ✓' : ''}`,
          onclick: () => { this.msel = m.id; audio.play('select'); this.paint(); } },
        h('span', { class: 'ac-tile-n' }, ...(mdone ? [h('span', { html: icon('check', 22) })] : [String(k + 1)])),
        h('span', { class: 'ac-tile-t dc-hint' }, m.title),
        m === next ? h('span', { class: 'ac-ping', 'aria-label': 'Next up' }) : null);
      })),
      h('div', { class: 'ac-lesson open' + (ok ? ' done' : '') + (sel === next ? ' next' : '') },
        h('div', { class: 'ac-lesson-head static' },
          h('span', { class: 'ac-num' }, ...(ok ? [h('span', { html: icon('check', 14) })] : [String(i + 1)])),
          h('span', { class: 'ac-lesson-title' }, sel.title),
          h('span', { class: 'ac-xp' + (ok ? ' got' : ''), title: `${sel.xp} XP` }, h('span', { html: icon(ok ? 'check' : 'star', 12) }), `+${sel.xp}`)),
        h('div', { class: 'ac-lesson-body' }, h('p', { class: 'ac-learn' }, sel.brief),
          sel.go && sel === next ? h('div', { class: 'row' }, h('button', { class: 'btn solid', onclick: () => this.navigate(sel.go!) }, h('span', { class: 'dc-face a mini' }, 'A'), 'Go')) : null)));
  }

  /* ── Glossary ─────────────────────────────────────────────────────── */

  private paintGlossary() {
    academy.showing(null);
    this.main.style.setProperty('--hub', GLOSS_COLOR);
    const toLesson = (id: string) => { const t = trackOf(id); if (!t) return; this.go(t.id, id); requestAnimationFrame(() => this.main.querySelector('.ac-lesson')?.scrollIntoView({ block: 'nearest' })); };
    const list = h('div', null, glossaryList(this.filter, toLesson));
    const input = h('input', { class: 'input', placeholder: 'Find a word: alpha, charge, hash…', 'aria-label': 'Find a word', spellcheck: false, value: this.filter }) as HTMLInputElement;
    input.addEventListener('input', () => { this.filter = input.value; list.replaceChildren(glossaryList(input.value, toLesson)); });
    const tip = 'Tip: words with a dotted underline explain themselves anywhere in the game. Hover or tap them.';
    this.main.replaceChildren(
      h('div', { class: 'ac-head', title: tip },
        h('span', { class: 'ac-head-ico', html: icon('book', 34) }),
        h('div', { class: 'col grow', style: 'gap:2px; min-width:0' }, h('span', { class: 'ac-h1' }, 'Glossary'), h('span', { class: 'ac-kicker dc-hint' }, 'Every game word, explained')),
        h('div', { class: 'ac-head-n', title: 'Words' }, h('span', { class: 'ac-big' }, String(GLOSSARY.length)))),
      h('div', { class: 't-tiny c-hint dc-hint' }, tip),
      input, list);
  }
}
