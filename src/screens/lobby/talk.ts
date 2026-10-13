/* Talking on the deck: which channel the plaza is (a deck), the five-line log, the input, and
 * sending (text, /me, stamps, phrases) with the same safety net as the Comms composer: a message
 * that looks like a recovery phrase asks first. Only live lines pop up as balloons; the history
 * fills the log quietly. Players only: a Matrix user with no commander isn't shown here. */
import { comms, DEFAULT_CHANNELS } from '../../chat/matrix';
import { parseInput, excerpt } from '../../chat/format';
import type { Msg, Room } from '../../chat/model';
import { renderBody, toneOf } from '../../ui/comms/rich';
import { h, toast, confirmBox } from '../../core/dom';
import { audio } from '../../core/audio';
import { looksLikePhrase } from '../../wallet/keys';
import { wallet } from '../../wallet/wallet';
import { openVault } from '../../ui/vault';
import { isPlayer, lists } from './crowd';
import { academy } from '../../game/academy';
import type { Emote } from '../../gfx/droid/actor';

/* ── Decks: the plaza is one channel at a time ── */

export interface Deck { key: string; alias: string; name: string }
const DECK_KEY = 'structs.lobby.deck';

export function decks(): Deck[] {
  const out = DEFAULT_CHANNELS.map((alias, i) => ({ key: String(i + 1), alias, name: alias.slice(1).split(':')[0] }));
  const g = comms.guildLobby();
  if (g && !out.some((d) => d.alias === g)) out.push({ key: 'G', alias: g, name: 'Your guild' });
  return out;
}
export function currentDeck(): Deck {
  const all = decks();
  let a: string | null = null;
  try { a = localStorage.getItem(DECK_KEY); } catch { /* ignore */ }
  return all.find((d) => d.alias === a) ?? all[0];
}
export function setDeck(alias: string) { try { localStorage.setItem(DECK_KEY, alias); } catch { /* ignore */ } }

/* ── Stamps: a picture and an emote, readable text for everyone else ── */

export interface Stamp { id: string; label: string; text: string; emote: Emote; glyph: string }
export const STAMPS: Stamp[] = [
  { id: 'hi', label: 'Hi', text: 'waves', emote: 'wave', glyph: '<path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V10"/><path d="M10 10V4.5a1.5 1.5 0 0 1 3 0V10"/><path d="M13 10V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M16 11V8.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-2.7L3.4 14a1.5 1.5 0 0 1 2.6-1.5L7 14"/>' },
  { id: 'thanks', label: 'Thanks', text: 'says thanks', emote: 'bow', glyph: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>' },
  { id: 'yes', label: 'Yes', text: 'nods yes', emote: 'yes', glyph: '<path d="M5 12l5 5 9-10"/>' },
  { id: 'no', label: 'No', text: 'shakes no', emote: 'no', glyph: '<path d="M6 6l12 12M18 6L6 18"/>' },
  { id: 'help', label: 'Help', text: 'needs help', emote: 'shrug', glyph: '<path d="M9 9a3 3 0 1 1 4.5 2.6c-.9.5-1.5 1.2-1.5 2.4"/><path d="M12 18h.01"/>' },
  { id: 'battle', label: 'Battle?', text: 'wants to battle', emote: 'cheer', glyph: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>' },
  { id: 'gg', label: 'GG', text: 'says good game', emote: 'bow', glyph: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>' },
  { id: 'follow', label: 'Follow', text: 'says follow me', emote: 'point', glyph: '<path d="M5 12h14M13 6l6 6-6 6"/>' },
];
export const stampSvg = (s: Stamp, size = 26) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${s.glyph}</svg>`;
export const stampOf = (id?: string) => STAMPS.find((s) => s.id === id) ?? null;

/** The phrase builder's pieces: quick on a pad, and safe for young players. */
export const PHRASES = ['Hi!', 'Need help', 'Let\'s battle', 'Good game', 'Thanks', 'Follow me', 'Where is', 'my planet', 'my fleet', 'ore', 'Alpha', 'the Academy'];

/** Is this line one the lobby shows (players, text-ish, not blocked)? */
export function showable(m: Msg): boolean {
  if (m.kind !== 'text' && m.kind !== 'emote' && m.kind !== 'notice') return false;
  if (lists.blocked.has(m.sender)) return false;
  return m.sender === comms.me || !!isPlayer(m.sender);
}

export interface TalkHooks {
  /** A new live line from someone (me included). */
  onLine(m: Msg, room: Room): void;
  /** The deck room changed (members, typing, state). */
  onRoom(room: Room | null): void;
  navigate(path: string): void;
}

export class Talk {
  readonly el: HTMLElement;
  private log: HTMLElement;
  private input: HTMLInputElement;
  private note: HTMLElement;
  private seen = new WeakSet<Msg>();
  private roomRef: Room | null = null;
  private since = Date.now() - 4000;
  private stop: (() => void)[] = [];
  deck: Deck = currentDeck();
  private joining = false;

  constructor(private hooks: TalkHooks) {
    this.log = h('div', { class: 'cl-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Deck chat' });
    this.input = h('input', { id: 'cl-say', class: 'cl-input', type: 'text', maxlength: 500, autocomplete: 'off', enterkeyhint: 'send', placeholder: 'Talk to the deck' }) as HTMLInputElement;
    this.note = h('div', { class: 'cl-note' });
    const label = h('label', { class: 'cl-say-label', for: 'cl-say' }, 'Say');
    const form = h('form', { class: 'cl-say cw', onsubmit: (e: Event) => { e.preventDefault(); void this.submit(); } }, label, this.input, this.note);
    this.el = h('div', { class: 'cl-chat' }, h('div', { class: 'cl-logwin cw' }, this.log), form);
    this.input.addEventListener('input', () => { const r = this.room(); if (r && this.input.value) void comms.typing(r.id, true); });
    this.input.addEventListener('blur', () => { const r = this.room(); if (r) void comms.typing(r.id, false); });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.input.blur(); }
    });
  }

  start() {
    this.since = Date.now() - 4000;
    this.stop.push(comms.onChange(() => this.refresh()));
    this.stop.push(comms.onState(() => { this.paintNote(); void this.ensureJoined(); this.refresh(); }));
    this.stop.push(wallet.onChange(() => this.paintNote()));
    void this.ensureJoined();
    this.refresh();
  }

  dispose() {
    for (const f of this.stop.splice(0)) f();
    comms.setViewing('lobby', undefined);
  }

  room(): Room | null {
    const r = comms.roomByAlias(this.deck.alias);
    return r && r.membership === 'join' ? r : null;
  }

  async switchTo(d: Deck) {
    if (d.alias === this.deck.alias) return;
    this.deck = d;
    setDeck(d.alias);
    this.roomRef = null;
    this.since = Date.now() - 4000;
    await this.ensureJoined();
    this.refresh();
  }

  private async ensureJoined() {
    if (comms.state !== 'live' || this.room() || this.joining) return;
    this.joining = true;
    try { await comms.join(this.deck.alias); } catch { /* the note says why */ } finally { this.joining = false; }
    this.refresh();
  }

  private refresh() {
    const r = this.room();
    if (r !== this.roomRef) {
      // A new deck, or the chat reconnected (rooms are rebuilt): what's there is history.
      this.roomRef = r;
      if (r) for (const m of r.timeline) this.seen.add(m);
      comms.setViewing('lobby', r?.id);
    } else if (r) {
      for (const m of r.timeline) {
        if (this.seen.has(m)) continue;
        this.seen.add(m);
        if (m.ts >= this.since && showable(m)) this.hooks.onLine(m, r);
      }
      comms.markRead(r.id);
    }
    this.hooks.onRoom(r);
    this.paintLog(r);
    this.paintNote();
  }

  private paintLog(r: Room | null) {
    if (!r) { this.log.replaceChildren(h('div', { class: 'cl-line cl-sys' }, this.deckLabel())); return; }
    const lines = r.timeline.filter(showable).slice(-5);
    this.log.replaceChildren(...(lines.length ? lines.map((m) => this.line(m, r)) : [h('div', { class: 'cl-line cl-sys' }, `◆ ${this.deck.name}: quiet for now`)]));
  }

  private deckLabel() {
    if (comms.state === 'connecting' || comms.signingIn) return '◆ Chat is connecting…';
    if (comms.state !== 'live') return '◆ Chat is offline';
    return `◆ Joining ${this.deck.name}…`;
  }

  private line(m: Msg, r: Room): HTMLElement {
    const name = comms.nameOf(m.sender, r);
    const tone = toneOf(m.sender);
    const who = h('b', { class: `cl-who ${tone}` }, name);
    const st = stampOf(m.stamp);
    if (st) return h('div', { class: 'cl-line' }, h('span', { class: 'cl-stamp', html: stampSvg(st, 16) }), who, ' ', st.text);
    if (m.kind === 'emote') return h('div', { class: 'cl-line cl-emote' }, '* ', who, ' ', ...renderBody(m.body, m.pills, this.hooks.navigate));
    return h('div', { class: `cl-line${m.failed ? ' failed' : m.pending ? ' pending' : ''}`, title: m.failed ? 'Not sent: ' + m.failed : '' }, who, ' ', ...renderBody(m.body, m.pills, this.hooks.navigate));
  }

  private paintNote() {
    const live = comms.state === 'live' && !!this.room();
    this.input.disabled = !live;
    this.note.replaceChildren();
    if (live) { this.input.placeholder = `Talk to ${this.deck.name}`; return; }
    if (wallet.state === 'locked') {
      this.input.placeholder = 'Open your vault to talk';
      this.note.append(h('button', { type: 'button', class: 'cl-note-btn', onclick: () => openVault() }, 'Open vault'));
    } else this.input.placeholder = comms.state === 'connecting' || comms.signingIn ? 'Connecting…' : 'Chat is offline';
  }

  focus() { if (!this.input.disabled) this.input.focus(); }
  get typing() { return document.activeElement === this.input; }

  /** Send what's in the box: a command, or text. */
  private async submit() {
    const raw = this.input.value.trim();
    const r = this.room();
    if (!raw || !r) return;
    const p = parseInput(raw);
    if (p.kind === 'unknown') { toast(`/${p.name} isn't a command`, 'warn'); return; }
    if (p.kind === 'cmd' && !['me', 'shrug', 'notice'].includes(p.name)) {
      // The rest of the commands live in the full Comms panel.
      const dock = (await import('../../ui/comms/dock')).mountCommsDock(this.hooks.navigate);
      dock.open(r.id); dock.draft(raw);
      this.input.value = '';
      return;
    }
    const body = p.kind === 'cmd' ? (p.name === 'shrug' ? `${p.arg} ¯\\_(ツ)_/¯`.trim() : p.arg) : p.text;
    if (!body) return;
    if (!(await this.safe(body, raw))) return;
    this.input.value = '';
    void comms.typing(r.id, false);
    await this.send({ msgtype: p.kind === 'cmd' && p.name === 'me' ? 'm.emote' : p.kind === 'cmd' && p.name === 'notice' ? 'm.notice' : 'm.text', body });
  }

  /** The phrase guard: a recovery phrase asks before it goes. */
  private async safe(body: string, raw: string): Promise<boolean> {
    if (!looksLikePhrase(body)) return true;
    const go = await confirmBox('That looks like a recovery phrase', 'Anyone with these words controls your commander. Nobody honest will ever ask for them. Send anyway?', 'Send anyway', 'enemy');
    return go && this.input.value.trim() === raw;
  }

  async send(o: { msgtype: 'm.text' | 'm.emote' | 'm.notice'; body: string; stamp?: string }) {
    const r = this.room();
    if (!r) { toast('Chat is offline', 'warn'); return; }
    if (looksLikePhrase(o.body)) return;
    audio.play('select', 0.6);
    try { await comms.send(r.id, o); academy.mark('concourse'); } catch (e) { toast('Not sent: ' + excerpt(String((e as Error).message || e), 60), 'enemy'); }
  }

  stamp(s: Stamp) { void this.send({ msgtype: 'm.emote', body: s.text, stamp: s.id }); }
}
