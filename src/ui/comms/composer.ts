/* The composer: a transmit line with slash commands, @-completion (pills on send),
 * replies and edits, per-room drafts, input history, and typing notices.
 * Enter sends, Shift+Enter breaks the line, ↑ on an empty line edits your last message,
 * Tab completes, Esc backs out (suggestions → reply → edit). */
import { h, toast, confirmBox } from '../../core/dom';
import { audio } from '../../core/audio';
import { store } from '../../chain/store';
import { comms } from '../../chat/matrix';
import { COMMANDS, completionsFor, excerpt, isPlayerId, objectRoomLocal, parseInput, resolveMentions, type MsgType, type Pill } from '../../chat/format';
import { powerOf, speakers, type Msg, type Room } from '../../chat/model';
import { face, fill, type Nav } from './rich';
import { looksLikePhrase } from '../../wallet/keys';

export interface ComposerHost {
  nav: Nav;
  room(): Room | null;
  openRoom(id: string): void;
  openObject(id: string): void;
  dm(userId: string, text?: string): void;
  leave(): void;
}

/** A player id from what someone typed: `1-12`, `12`, `@1-12:hs`, or a name (exact, then unique prefix). */
export function findPlayer(q: string): string | null {
  const s = q.trim().replace(/^@/, '');
  if (!s) return null;
  if (isPlayerId(s)) return s;
  if (/^\d+$/.test(s)) return '1-' + s;
  const m = /^(1-\d+):/.exec(s);
  if (m) return m[1];
  const low = s.toLowerCase();
  for (const p of store.players.values()) if (p.name && p.name.toLowerCase() === low) return p.id;
  const pre = [...store.players.values()].filter((p) => p.name && p.name.toLowerCase().startsWith(low));
  return pre.length === 1 ? pre[0].id : null;
}

export class Composer {
  readonly el: HTMLDivElement;
  private ta: HTMLTextAreaElement;
  private ctx: HTMLDivElement;
  private sugg: HTMLDivElement;
  private send: HTMLButtonElement;
  private replyTo: Msg | null = null;
  private editing: Msg | null = null;
  private picks: Pill[] = [];
  private drafts = new Map<string, string>();
  private history: string[] = [];
  private hIdx = -1;
  private options: { label: string; value: string; hint?: string; userId?: string }[] = [];
  private cursor = 0;
  private idle = 0;
  private roomId: string | null = null;

  constructor(private host: ComposerHost) {
    this.ta = h('textarea', { class: 'input cp-ta', rows: 1, placeholder: 'Write a message…', spellcheck: true, 'aria-label': 'Message', enterkeyhint: 'send' }) as HTMLTextAreaElement;
    this.ctx = h('div', { class: 'cp-ctx' });
    this.sugg = h('div', { class: 'cp-sugg panel', role: 'listbox' });
    this.send = h('button', { type: 'button', class: 'btn solid cp-send', title: 'Send (Enter)', onclick: () => void this.submit() }, h('span', { class: 'cp-send-l' }, 'Transmit'), h('span', { class: 'cp-send-g' }, '➤')) as HTMLButtonElement;
    this.el = h('div', { class: 'cp-compose' }, this.sugg, this.ctx, h('div', { class: 'cp-compose-row' }, this.ta, this.send),
      // Always on show, even where the key hints fold away.
      h('div', { class: 'cp-compose-safe t-tiny' }, 'Be kind. Never share your recovery phrase.'),
      h('div', { class: 'cp-compose-hint t-tiny c-hint' }, h('kbd', null, 'Enter'), ' send · ', h('kbd', null, 'Shift+Enter'), ' new line · ', h('kbd', null, '/'), ' commands · ', h('kbd', null, '@'), ' mention · ', h('kbd', null, '↑'), ' edit last'));
    this.ta.addEventListener('keydown', (e) => this.key(e));
    this.ta.addEventListener('input', () => this.input());
    this.ta.addEventListener('blur', () => setTimeout(() => this.closeSugg(), 150));
    this.paintSugg();
  }

  setRoom(r: Room | null) {
    // An edit in progress is not a draft: keeping it would send it again as a new message.
    if (this.roomId) { if (!this.editing) this.drafts.set(this.roomId, this.ta.value); comms.typing(this.roomId, false); }
    this.roomId = r?.id ?? null;
    this.replyTo = null; this.editing = null; this.picks = [];
    this.ta.value = r ? this.drafts.get(r.id) ?? '' : '';
    this.refresh();
    this.grow();
  }

  /** Room state may have changed (encryption, power): enable or explain. */
  refresh() {
    const r = this.host.room();
    let why = '';
    if (!r) why = 'No channel open';
    else if (r.membership === 'invite') why = 'Accept the invitation to talk here';
    else if (r.encrypted) why = 'Encrypted channel — this client can only read plain channels';
    else if (r.power && powerOf(r, comms.me) < (r.power.events?.['m.room.message'] ?? r.power.events_default ?? 0)) why = 'Read-only channel';
    this.ta.disabled = !!why;
    this.send.disabled = !!why;
    this.ta.placeholder = why || (r ? `Message ${r.name || r.alias?.split(':')[0] || 'this channel'}…` : 'Write a message…');
    this.paintCtx();
  }

  focus() { if (!this.ta.disabled && matchMedia('(hover: hover)').matches) this.ta.focus(); }

  reply(m: Msg) { this.editing = null; this.replyTo = m; this.paintCtx(); this.ta.focus(); }
  edit(m: Msg) {
    this.replyTo = null;
    this.editing = m;
    this.ta.value = m.body;
    this.picks = [...m.pills];
    this.paintCtx(); this.grow();
    this.ta.focus();
    this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length);
  }
  mention(userId: string) {
    const r = this.host.room();
    const name = comms.nameOf(userId, r);
    this.picks.push({ name, userId });
    const pre = this.ta.value && !/\s$/.test(this.ta.value) ? ' ' : '';
    this.ta.value += `${pre}@${name} `;
    this.grow();
    this.ta.focus();
  }
  prefill(text: string) { this.ta.value = text; this.grow(); this.ta.focus(); }

  private paintCtx() {
    const m = this.replyTo ?? this.editing;
    if (!m) { this.ctx.replaceChildren(); this.ctx.style.display = 'none'; return; }
    const r = this.host.room();
    this.ctx.style.display = '';
    fill(this.ctx, 
      h('span', { class: 't-label ' + (this.editing ? 'c-warn' : 'c-player') }, this.editing ? 'Editing' : 'Replying to'),
      this.replyTo ? face(m.sender, 'cp-face xs') : null,
      this.replyTo ? h('span', { class: 'cp-ctx-who' }, comms.nameOf(m.sender, r)) : null,
      h('span', { class: 'cp-ctx-text' }, excerpt(m.body, 80)),
      h('button', { type: 'button', class: 'btn ghost icon mini', title: 'Cancel (Esc)', 'aria-label': 'Cancel', onclick: () => this.cancelCtx() }, '×'));
  }

  private cancelCtx() {
    if (this.editing) this.ta.value = '';
    this.replyTo = null; this.editing = null;
    this.paintCtx(); this.grow();
  }

  private grow() {
    this.ta.style.height = 'auto';
    this.ta.style.height = Math.min(160, this.ta.scrollHeight + 2) + 'px';
  }

  /* ── Keys and suggestions ─────────────────────────────────────────────── */

  private key(e: KeyboardEvent) {
    if (e.isComposing) return;
    const open = this.options.length > 0;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      this.cursor = (this.cursor + (e.key === 'ArrowDown' ? 1 : -1) + this.options.length) % this.options.length;
      this.paintSugg();
      return;
    }
    if (open && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
      const o = this.options[this.cursor];
      // Enter on a word that is already complete (/help, a full @name) sends rather than completing again.
      const done = e.key === 'Enter' && o && this.word()?.word.toLowerCase() === o.value.trim().toLowerCase();
      if (!done) { e.preventDefault(); this.accept(o); return; }
      this.closeSugg();
    }
    if (e.key === 'Tab' && !e.shiftKey && this.ta.value) {
      // Tab with nothing open: open the completions for the word at the caret.
      if (this.suggest()) { e.preventDefault(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.submit(); return; }
    if (e.key === 'Escape') {
      if (open) { this.closeSugg(); e.preventDefault(); e.stopPropagation(); return; }
      if (this.replyTo || this.editing) { this.cancelCtx(); e.preventDefault(); e.stopPropagation(); return; }
      this.ta.blur();
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && this.history.length && (e.ctrlKey || e.altKey)) {
      e.preventDefault();
      this.hIdx = Math.max(-1, Math.min(this.history.length - 1, this.hIdx + (e.key === 'ArrowUp' ? 1 : -1)));
      this.ta.value = this.hIdx < 0 ? '' : this.history[this.history.length - 1 - this.hIdx];
      this.grow();
      return;
    }
    if (e.key === 'ArrowUp' && !this.ta.value) {
      const r = this.host.room();
      const last = r && [...r.timeline].reverse().find((m) => m.sender === comms.me && m.id.startsWith('$') && (m.kind === 'text' || m.kind === 'emote' || m.kind === 'notice'));
      if (last) { e.preventDefault(); this.edit(last); }
      return;
    }
  }

  private input() {
    this.grow();
    this.suggest();
    const r = this.host.room();
    if (!r) return;
    if (this.ta.value.trim() && !this.ta.value.startsWith('/')) {
      comms.typing(r.id, true);
      clearTimeout(this.idle);
      this.idle = window.setTimeout(() => comms.typing(r.id, false), 5000);
    } else comms.typing(r.id, false);
  }

  private word(): { word: string; start: number } | null {
    const pos = this.ta.selectionStart ?? this.ta.value.length;
    const before = this.ta.value.slice(0, pos);
    const m = /(^|\s)([/@][^\s]*)$/.exec(before);
    if (!m) return null;
    const start = pos - m[2].length;
    if (m[2].startsWith('/') && start !== 0) return null;
    return { word: m[2], start };
  }

  private suggest(): boolean {
    const w = this.word();
    const r = this.host.room();
    this.options = [];
    if (w?.word.startsWith('/')) {
      for (const c of completionsFor(w.word, [])) {
        const cmd = COMMANDS.find((x) => '/' + x.name === c)!;
        this.options.push({ label: `${c} ${cmd.args}`.trim(), value: c + ' ', hint: cmd.help });
      }
    } else if (w?.word.startsWith('@') && r) {
      const q = w.word.slice(1).toLowerCase();
      const seen = new Set<string>();
      const add = (userId: string, name: string, hint: string) => {
        if (seen.has(userId) || this.options.length >= 8) return;
        if (q && !name.toLowerCase().includes(q) && !userId.toLowerCase().includes(q)) return;
        seen.add(userId);
        this.options.push({ label: '@' + name, value: '@' + name + ' ', hint, userId });
      };
      for (const u of speakers(r)) if (u !== comms.me) add(u, comms.nameOf(u, r), 'spoke here');
      for (const m of r.members.values()) if (m.membership === 'join' && m.userId !== comms.me) add(m.userId, comms.nameOf(m.userId, r), 'member');
      if (q.length >= 2) {
        for (const p of store.players.values()) {
          if (this.options.length >= 8) break;
          if (!p.name || !(p.name.toLowerCase().startsWith(q) || p.id === q)) continue;
          const uid = comms.userIdForPlayer(p.id);
          if (uid) add(uid, p.name, p.id);
        }
      }
    }
    this.cursor = 0;
    this.paintSugg();
    return this.options.length > 0;
  }

  private accept(o: { value: string; label: string; userId?: string } | undefined) {
    const w = this.word();
    if (!o || !w) { this.closeSugg(); return; }
    const pos = this.ta.selectionStart ?? this.ta.value.length;
    this.ta.value = this.ta.value.slice(0, w.start) + o.value + this.ta.value.slice(pos);
    const at = w.start + o.value.length;
    this.ta.setSelectionRange(at, at);
    if (o.userId) this.picks.push({ name: o.value.trim().slice(1), userId: o.userId });
    this.closeSugg();
    this.grow();
  }

  private closeSugg() { this.options = []; this.paintSugg(); }

  private paintSugg() {
    this.sugg.style.display = this.options.length ? '' : 'none';
    this.sugg.replaceChildren(...this.options.map((o, i) => h('div', {
      class: 'cp-sg' + (i === this.cursor ? ' on' : ''), role: 'option',
      onmousedown: (e: Event) => { e.preventDefault(); this.accept(o); },
    }, o.userId ? face(o.userId, 'cp-face xs') : null, h('span', { class: 'cp-sg-l' }, o.label), o.hint ? h('span', { class: 't-tiny c-hint' }, o.hint) : null)));
  }

  /* ── Sending and commands ─────────────────────────────────────────────── */

  private mentionsFor(text: string, r: Room): Pill[] {
    const cands: Pill[] = [...this.picks, ...comms.mentionCandidates(r)];
    const low = text.toLowerCase();
    if (low.includes('@')) {
      for (const p of store.players.values()) {
        if (!p.name || !low.includes('@' + p.name.toLowerCase()) && !low.includes('@' + p.id)) continue;
        const uid = comms.userIdForPlayer(p.id);
        if (uid) cands.push({ name: p.name, userId: uid }, { name: p.id, userId: uid });
      }
    }
    return resolveMentions(text, cands);
  }

  async submit() {
    const r = this.host.room();
    const raw = this.ta.value.replace(/\s+$/, '');
    if (!r || !raw.trim() || this.ta.disabled) return;
    // A recovery phrase is never meant for chat: stop and ask before it leaves (Cancel is the default).
    if (looksLikePhrase(raw)) {
      const go = await confirmBox('Wait! Is that a recovery phrase?', 'This message looks like a recovery phrase. Anyone who sees those words can take your commander and everything it owns, and nobody honest will ever ask for them. Send it anyway?', 'Send anyway', 'enemy');
      // Anything that changed while the question was open (another room, other text) means: don't send.
      if (!go || this.host.room()?.id !== r.id || this.ta.value.replace(/\s+$/, '') !== raw) { audio.play('deny'); this.ta.focus(); return; }
    }
    comms.typing(r.id, false);
    clearTimeout(this.idle);
    const editing = this.editing;
    const reply = this.replyTo;
    const done = () => {
      this.history.push(raw); if (this.history.length > 50) this.history.shift();
      this.hIdx = -1;
      this.ta.value = ''; this.picks = []; this.replyTo = null; this.editing = null;
      this.drafts.delete(r.id);
      this.paintCtx(); this.grow(); this.closeSugg();
    };

    if (editing) {
      done();
      if (raw === editing.body) return;
      audio.play('confirm');
      return comms.edit(r.id, editing.id, { msgtype: (editing.msgtype as MsgType) || 'm.text', body: raw, mentions: this.mentionsFor(raw, r) }).catch((e) => toast('Edit refused: ' + e.message, 'warn'));
    }

    const p = parseInput(raw);
    const say = (msgtype: MsgType, body: string) => {
      if (!body.trim()) return;
      audio.play('confirm');
      const parent = reply ? { roomId: r.id, eventId: reply.id, sender: reply.sender, body: reply.body, html: reply.html } : null;
      void comms.send(r.id, { msgtype, body, mentions: msgtype === 'm.notice' ? [] : this.mentionsFor(body, r), replyTo: parent }).catch(() => audio.play('deny'));
    };
    if (p.kind === 'text') { done(); say('m.text', p.text); return; }
    if (p.kind === 'unknown') { comms.local(r.id, 'error', null, `No command /${p.name}. Try /help.`); audio.play('deny'); return; }
    done();
    const { name, arg, argv } = p;
    try {
      switch (name) {
        case 'me': say('m.emote', arg); break;
        case 'notice': say('m.notice', arg); break;
        case 'shrug': say('m.text', (arg + ' ¯\\_(ツ)_/¯').trim()); break;
        case 'help': comms.local(r.id, 'help', null); break;
        case 'who': comms.local(r.id, 'who', speakers(r)); break;
        case 'topic':
          if (arg) { await comms.setTopic(r.id, arg); audio.play('confirm'); }
          else comms.local(r.id, 'info', null, r.topic ? `Topic: ${r.topic}` : 'This channel has no topic.');
          break;
        case 'whois': {
          const pid = findPlayer(arg);
          if (!pid) comms.local(r.id, 'error', null, `No player matches “${arg}”.`);
          else comms.local(r.id, 'whois', pid);
          break;
        }
        case 'msg': {
          if (!argv.length) { comms.local(r.id, 'error', null, 'Usage: /msg <player> [message]'); break; }
          if (argv[0].startsWith('@') && argv[0].includes(':')) { this.host.dm(argv[0], argv.slice(1).join(' ')); break; }
          // Names can have spaces: take the longest run of words that names a player.
          for (let k = argv.length; k >= 1; k--) {
            const pid = findPlayer(argv.slice(0, k).join(' '));
            if (!pid) continue;
            const uid = comms.userIdForPlayer(pid);
            if (!uid) { comms.local(r.id, 'error', null, `${store.playerName(pid)}'s guild runs no comms server.`); return; }
            this.host.dm(uid, argv.slice(k).join(' '));
            return;
          }
          comms.local(r.id, 'error', null, `No player matches “${arg}”.`);
          break;
        }
        case 'join': {
          let target = argv[0] ?? '';
          if (!target) { comms.local(r.id, 'error', null, 'Usage: /join #channel:server'); break; }
          if (!/^[#!]/.test(target)) target = '#' + target;
          if (target.startsWith('#') && !target.includes(':')) target += ':' + comms.server;
          const id = await comms.join(target);
          audio.play('confirm');
          this.host.openRoom(id);
          break;
        }
        case 'leave': this.host.leave(); break;
        case 'chan': {
          if (!argv[0] || !objectRoomLocal(argv[0])) { comms.local(r.id, 'error', null, 'Usage: /chan 2-123 (a planet) or /chan 9-45 (a fleet)'); break; }
          this.host.openObject(argv[0]);
          break;
        }
      }
    } catch (e) {
      comms.local(r.id, 'error', null, `/${name}: ${(e as Error).message}`);
      audio.play('deny');
    }
  }
}

/** Leave with a confirm (used by /leave and the room menu). */
export async function confirmLeave(r: Room, label: string): Promise<boolean> {
  const ok = await confirmBox('Leave channel', `Leave ${label}? You can rejoin public channels from the directory.`, 'Leave');
  if (!ok) return false;
  await comms.leave(r.id);
  return true;
}
