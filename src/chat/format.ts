/* Pure text work for comms — no DOM, no network, so the tests can run it in Node:
 * chain-id refs, links and mentions in a message body, mention pills for the HTML
 * we send, reply fallbacks, slash commands, reaction keys, and day/time labels. */

/* ── Ids ─────────────────────────────────────────────────────────────────── */

/** A chain object id in running text (`1-194`, `2-15361`), not part of a longer token. */
export const ID_RE = /(^|[^0-9A-Za-z_-])(\d{1,2}-\d{1,9})(?![0-9-])/g;
export const ID_KINDS: Record<string, string> = {
  '0': 'guild', '1': 'player', '2': 'planet', '3': 'reactor', '4': 'substation', '5': 'struct', '9': 'fleet', '10': 'provider', '11': 'agreement',
};
export const isPlayerId = (s: string) => /^1-\d+$/.test(s);
export const idKind = (id: string) => ID_KINDS[id.split('-')[0]] ?? null;

/** Every distinct chain id in a text, in order of first appearance (known kinds only). */
export function extractIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ID_RE)) if (idKind(m[2]) && !out.includes(m[2])) out.push(m[2]);
  return out;
}

/** Where a chain id opens in the client. Fleets and structs have no screen of their own yet: intel. */
export function refRoute(id: string): string | null {
  const kind = idKind(id);
  if (!kind) return null;
  if (kind === 'player') return '/player/' + id;
  if (kind === 'planet') return '/planet/' + id;
  if (kind === 'guild') return '/intel/guild/' + id;
  // Everything else: its live trail in the activity feed; energy objects on the grid.
  if (kind === 'reactor' || kind === 'substation') return '/grid';
  if (kind === 'provider') return '/economy/market';
  return '/intel/activity/' + id;
}

/* ── Matrix ids ──────────────────────────────────────────────────────────── */

export const localpart = (userId: string) => userId.replace(/^@/, '').split(':')[0];
export const serverOf = (id: string) => { const i = id.indexOf(':'); return i < 0 ? '' : id.slice(i + 1); };
/** The player behind a Matrix user, if its localpart is a player id (`@1-194:server` → `1-194`). */
export const playerOfUser = (userId: string) => { const l = localpart(userId); return isPlayerId(l) ? l : null; };
export const userIdFor = (playerId: string, server: string) => `@${playerId}:${server}`;
export const hostOf = (url: string) => { try { return new URL(url).host; } catch { return ''; } };
/** Guild lobby alias localpart: "Orbital Hydro" → "orbital-hydro". */
export const slug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** Planet and fleet channels: `2-15361` → `planet-2-15361`, `9-61` → `fleet-9-61`. */
export function objectRoomLocal(objectId: string): { kind: 'planet' | 'fleet'; local: string } | null {
  const k = idKind(objectId);
  return k === 'planet' || k === 'fleet' ? { kind: k, local: `${k}-${objectId}` } : null;
}

/* ── HTML in and out ─────────────────────────────────────────────────────── */

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l[0] === '#') { const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[l] ?? '';
  });
}

export interface Pill { name: string; userId: string }

/** User pills in a formatted_body: `<a href="https://matrix.to/#/@1-12:hs">Name</a>`. Read, never rendered. */
export function extractPills(html: string | undefined | null): Pill[] {
  if (!html) return [];
  const out: Pill[] = [];
  const re = /<a\b[^>]*?href\s*=\s*["']https:\/\/matrix\.to\/#\/((?:@|%40)[^"'?/]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    let userId = m[1];
    try { userId = decodeURIComponent(userId); } catch { /* keep raw */ }
    const name = decodeEntities(m[2].replace(/<[^>]*>/g, '')).trim();
    if (name && /^@[^:\s]+:[^\s]+$/.test(userId) && !out.some((p) => p.userId === userId && p.name === name)) out.push({ name, userId });
  }
  return out;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `@Name` mentions in a draft, matched against who could be meant (longest name first, whole words). */
export function resolveMentions(body: string, candidates: Pill[]): Pill[] {
  const out: Pill[] = [];
  const sorted = [...candidates].filter((c) => c.name).sort((a, b) => b.name.length - a.name.length);
  let rest = body;
  for (const c of sorted) {
    const re = new RegExp('@' + escRe(c.name) + '(?![\\w-])', 'gi');
    if (re.test(rest)) {
      if (!out.some((p) => p.userId === c.userId)) out.push(c);
      rest = rest.replace(re, ' ');    // a longer name claims its text before a shorter prefix can
    }
  }
  return out;
}

/** The org.matrix.custom.html body for a draft with mentions: escaped text, `@Name` → pill. Null if nothing to pill. */
export function formatWithPills(body: string, mentions: Pill[]): string | null {
  if (!mentions.length) return null;
  const names = [...mentions].sort((a, b) => b.name.length - a.name.length);
  const re = new RegExp('@(' + names.map((m) => escRe(m.name)).join('|') + ')(?![\\w-])', 'gi');
  let out = '', last = 0, hit = false;
  for (const m of body.matchAll(re)) {
    const p = names.find((n) => n.name.toLowerCase() === m[1].toLowerCase())!;
    out += escapeHtml(body.slice(last, m.index)) + `<a href="https://matrix.to/#/${escapeHtml(p.userId)}">${escapeHtml(p.name)}</a>`;
    last = m.index! + m[0].length;
    hit = true;
  }
  if (!hit) return null;
  return (out + escapeHtml(body.slice(last))).replace(/\n/g, '<br>');
}

/* ── Replies ─────────────────────────────────────────────────────────────── */

/** Drop the `> <@sender> …` quote a reply carries for clients that can't render replies. */
export function stripReplyFallback(body: string): string {
  if (!body.startsWith('> ')) return body;
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++;
  if (i < lines.length && lines[i] === '') i++;
  return lines.slice(i).join('\n');
}
export const stripReplyHtml = (html: string) => html.replace(/^\s*<mx-reply>[\s\S]*?<\/mx-reply>/i, '');

export interface ReplyParent { roomId: string; eventId: string; sender: string; body: string; html?: string | null }

/** Body and formatted body of a reply, fallback quote included (older clients still show context). */
export function replyContent(parent: ReplyParent, body: string, html: string | null): { body: string; formatted_body: string } {
  const pBody = stripReplyFallback(parent.body);
  const lines = pBody.split('\n');
  const quote = [`> <${parent.sender}> ${lines[0]}`, ...lines.slice(1).map((l) => `> ${l}`)].join('\n');
  const pHtml = parent.html ? stripReplyHtml(parent.html) : escapeHtml(pBody).replace(/\n/g, '<br>');
  const head = `<mx-reply><blockquote><a href="https://matrix.to/#/${escapeHtml(parent.roomId)}/${escapeHtml(parent.eventId)}">In reply to</a> ` +
    `<a href="https://matrix.to/#/${escapeHtml(parent.sender)}">${escapeHtml(parent.sender)}</a><br>${pHtml}</blockquote></mx-reply>`;
  return { body: `${quote}\n\n${body}`, formatted_body: head + (html ?? escapeHtml(body).replace(/\n/g, '<br>')) };
}

/* ── Outgoing content ────────────────────────────────────────────────────── */

export type MsgType = 'm.text' | 'm.emote' | 'm.notice';
export interface Outgoing { msgtype: MsgType; body: string; mentions?: Pill[]; replyTo?: ReplyParent | null }

export function messageContent(o: Outgoing): Record<string, unknown> {
  const mentions = o.mentions ?? [];
  const html = formatWithPills(o.body, mentions);
  const c: Record<string, unknown> = { msgtype: o.msgtype, body: o.body };
  const ids = [...new Set(mentions.map((m) => m.userId))];
  if (o.replyTo) ids.push(o.replyTo.sender);
  // m.mentions is always present: an empty one tells servers not to guess from the body.
  c['m.mentions'] = { user_ids: [...new Set(ids)] };
  if (o.replyTo) {
    const r = replyContent(o.replyTo, o.body, html);
    c.body = r.body;
    c.format = 'org.matrix.custom.html';
    c.formatted_body = r.formatted_body;
    c['m.relates_to'] = { 'm.in_reply_to': { event_id: o.replyTo.eventId } };
  } else if (html) {
    c.format = 'org.matrix.custom.html';
    c.formatted_body = html;
  }
  return c;
}

export function editContent(eventId: string, o: Outgoing): Record<string, unknown> {
  const fresh = messageContent({ ...o, replyTo: null });
  const c: Record<string, unknown> = {
    msgtype: o.msgtype, body: '* ' + o.body,
    'm.new_content': fresh,
    'm.mentions': {},
    'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
  };
  if (fresh.formatted_body) { c.format = 'org.matrix.custom.html'; c.formatted_body = '* ' + fresh.formatted_body; }
  return c;
}

/* ── Segments: how a body renders ───────────────────────────────────────── */

export type Seg =
  | { t: 'text'; s: string }
  | { t: 'id'; s: string; id: string }
  | { t: 'url'; s: string; href: string }
  | { t: 'mention'; s: string; userId: string }
  | { t: 'code'; s: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const USER_RE = /@[a-z0-9._=\-/+]+:[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?/gi;

/** Split a plain body into text, links, chain ids, mentions and `code`. Rendered as text nodes and
 * elements by the UI, never as HTML. `pills` are the mention names the sender's formatted body named. */
export function segment(body: string, pills: Pill[] = []): Seg[] {
  const out: Seg[] = [];
  const parts = body.split(/(`[^`\n]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) { out.push({ t: 'code', s: part.slice(1, -1) }); continue; }
    out.push(...segmentPlain(part, pills));
  }
  return mergeText(out);
}

function segmentPlain(text: string, pills: Pill[]): Seg[] {
  const found: { a: number; b: number; seg: Seg }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let s = m[0];
    // Trailing punctuation belongs to the sentence, and a closing paren only if it opened inside.
    while (/[.,;:!?'")\]]$/.test(s) && !(s.endsWith(')') && (s.match(/\(/g) || []).length >= (s.match(/\)/g) || []).length)) s = s.slice(0, -1);
    found.push({ a: m.index!, b: m.index! + s.length, seg: { t: 'url', s, href: s } });
  }
  for (const p of [...pills].sort((x, y) => y.name.length - x.name.length)) {
    for (const needle of ['@' + p.name, p.name]) {
      const re = new RegExp('(^|[^\\w@])(' + escRe(needle) + ')(?![\\w-])', 'g');
      for (const m of text.matchAll(re)) {
        const a = m.index! + m[1].length;
        found.push({ a, b: a + m[2].length, seg: { t: 'mention', s: m[2], userId: p.userId } });
      }
    }
  }
  for (const m of text.matchAll(USER_RE)) found.push({ a: m.index!, b: m.index! + m[0].length, seg: { t: 'mention', s: m[0], userId: m[0] } });
  for (const m of text.matchAll(ID_RE)) {
    if (!idKind(m[2])) continue;
    const a = m.index! + m[1].length;
    found.push({ a, b: a + m[2].length, seg: { t: 'id', s: m[2], id: m[2] } });
  }
  // Earliest first, longest first at a tie; then take what doesn't overlap.
  found.sort((x, y) => x.a - y.a || (y.b - y.a) - (x.b - x.a));
  const out: Seg[] = [];
  let at = 0;
  for (const f of found) {
    if (f.a < at) continue;
    if (f.a > at) out.push({ t: 'text', s: text.slice(at, f.a) });
    out.push(f.seg);
    at = f.b;
  }
  if (at < text.length) out.push({ t: 'text', s: text.slice(at) });
  return out;
}

function mergeText(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (s.t === 'text' && last?.t === 'text') last.s += s.s; else out.push({ ...s });
  }
  return out;
}

/** Does a message speak to me? m.mentions first (intentional mentions), else my names in the text. */
export function mentionsMe(body: string, mentionIds: string[] | undefined, me: string, myNames: string[]): boolean {
  if (mentionIds?.includes(me)) return true;
  if (mentionIds) return false;   // the sender declared their mentions, and I am not one
  const low = body.toLowerCase();
  return [localpart(me), ...myNames].some((n) => n && n.length > 2 && new RegExp('(^|[^\\w-])@?' + escRe(n.toLowerCase()) + '(?![\\w-])').test(low));
}

/* ── Slash commands ──────────────────────────────────────────────────────── */

export interface Command { name: string; args: string; help: string }
export const COMMANDS: Command[] = [
  { name: 'me', args: '<action>', help: 'Send an action: * you wave' },
  { name: 'msg', args: '<player> [message]', help: 'Open a direct channel with a player' },
  { name: 'join', args: '<#channel:server>', help: 'Join a channel by alias or id' },
  { name: 'leave', args: '', help: 'Leave the channel you are in' },
  { name: 'topic', args: '[new topic]', help: 'Show (or set) what this channel is about' },
  { name: 'who', args: '', help: 'Who has spoken here' },
  { name: 'whois', args: '<player>', help: 'Look a player up on chain' },
  { name: 'chan', args: '<planet|fleet id>', help: 'Open the channel of a planet (2-…) or fleet (9-…)' },
  { name: 'notice', args: '<text>', help: 'Send a notice (no pings)' },
  { name: 'shrug', args: '[text]', help: 'Append ¯\\_(ツ)_/¯' },
  { name: 'help', args: '', help: 'This list' },
];

export type Parsed =
  | { kind: 'text'; text: string }
  | { kind: 'cmd'; name: string; arg: string; argv: string[] }
  | { kind: 'unknown'; name: string };

/** `/cmd args` → a command; `//text` → the literal `/text`; anything else → text. */
export function parseInput(input: string): Parsed {
  if (input.startsWith('//')) return { kind: 'text', text: input.slice(1) };
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(input);
  if (!input.startsWith('/') || !m) return { kind: 'text', text: input };
  const name = m[1].toLowerCase();
  if (!COMMANDS.some((c) => c.name === name)) return { kind: 'unknown', name };
  const arg = (m[2] ?? '').trim();
  return { kind: 'cmd', name, arg, argv: arg ? arg.split(/\s+/) : [] };
}

/** Tab completion: commands after `/`, names after `@`. Returns matches for the word at the caret. */
export function completionsFor(word: string, names: string[]): string[] {
  if (/^\/[a-z]*$/i.test(word)) return COMMANDS.map((c) => '/' + c.name).filter((c) => c.startsWith(word.toLowerCase()));
  if (word.startsWith('@')) {
    const q = word.slice(1).toLowerCase();
    const starts = names.filter((n) => n.toLowerCase().startsWith(q));
    const has = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
    return [...new Set([...starts, ...has])].slice(0, 8).map((n) => '@' + n);
  }
  return [];
}

/* ── Reactions ───────────────────────────────────────────────────────────── */

/** The game's quick reactions (the desktop's keys), shown as glyphs here. */
export const QUICK_REACTIONS = [':okay:', ':blocked:', ':detected:', ':alert:', ':raid:', ':defend:', ':mine:', ':wreckage:'] as const;
export const EMOJI_REACTIONS = ['👍', '🔥', '😂', '👀', '🫡', '💀', '❤️', '🎯'];
export const REACTION_ART: Record<string, { glyph: string; label: string; tone: 'player' | 'enemy' | 'warn' | 'neutral' | 'hint' }> = {
  ':okay:': { glyph: '✓', label: 'Okay', tone: 'player' },
  ':blocked:': { glyph: '⊘', label: 'Blocked', tone: 'enemy' },
  ':detected:': { glyph: '◉', label: 'Detected', tone: 'warn' },
  ':alert:': { glyph: '!', label: 'Alert', tone: 'enemy' },
  ':raid:': { glyph: '⚔', label: 'Raid', tone: 'enemy' },
  ':defend:': { glyph: '⛨', label: 'Defend', tone: 'player' },
  ':mine:': { glyph: '⛏', label: 'Mine', tone: 'neutral' },
  ':wreckage:': { glyph: '✸', label: 'Wreckage', tone: 'hint' },
};
export const STRUCT_ART = ['cmd-ship', 'battleship', 'cruiser', 'destroyer', 'frigate', 'interceptor', 'pursuit-fighter', 'starfighter', 'stealth-bomber',
  'submersible', 'tank', 'mobile-artillery', 'sam-launcher', 'pdc', 'orb-shield', 'jamming-sat', 'extractor', 'refinery', 'generator', 'ore-bunker'];
/** `:struct/tank:` → `tank` (a struct portrait), anything else → null. */
export function structReaction(key: string): string | null {
  const m = /^:struct\/([a-z-]+):$/.exec(key);
  return m && STRUCT_ART.includes(m[1]) ? m[1] : null;
}
/** `:raid` typed in the composer expands to the reaction/glyph key. */
export function shortcodeMatches(q: string): string[] {
  const low = q.toLowerCase();
  return [...QUICK_REACTIONS, ...STRUCT_ART.map((s) => `:struct/${s}:`)].filter((k) => k.startsWith(low));
}

/* ── Time ────────────────────────────────────────────────────────────────── */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayKey = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
export function dayLabel(ts: number, now = Date.now()): string {
  if (dayKey(ts) === dayKey(now)) return 'Today';
  if (dayKey(ts) === dayKey(now - 86_400_000)) return 'Yesterday';
  const d = new Date(ts);
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ' ' + d.getFullYear() : '';
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}
export function timeHM(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** A one-line excerpt for previews, toasts and reply quotes. */
export function excerpt(body: string, max = 90): string {
  const one = stripReplyFallback(body).replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/** Media types a thumbnail blob may keep. Anything else (SVG, HTML, unknown) becomes opaque
 * bytes: a same-origin blob URL opened in a tab would otherwise run script as the app. */
const SAFE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;
export function safeMediaType(contentType: string | null | undefined): string {
  const t = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return SAFE_IMAGE.test(t) ? t : 'application/octet-stream';
}
