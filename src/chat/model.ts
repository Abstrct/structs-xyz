/* The comms model: rooms, timelines, members, reactions and receipts, reduced from
 * /sync responses and /messages pages. Pure (no DOM, no network) so the tests can feed
 * it recorded payloads. The client owns one ChatState and asks this module to fold
 * each response into it; the UI only reads. */
import { extractPills, playerOfUser, localpart, serverOf, stripReplyFallback, stripReplyHtml, type Pill } from './format';

export const TIMELINE_CAP = 500;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface RawEvent {
  type: string; event_id?: string; sender?: string; origin_server_ts?: number; state_key?: string; redacts?: string;
  content?: any; unsigned?: any; room_id?: string;
}

export type MsgKind = 'text' | 'emote' | 'notice' | 'image' | 'file' | 'system' | 'encrypted' | 'redacted' | 'local' | 'other';

export interface Media { mxc: string; w?: number; h?: number; name?: string; mimetype?: string; size?: number }
export interface SysInfo { type: string; target?: string; membership?: string; prev?: string; reason?: string; text?: string; pinned?: number }
export interface Msg {
  id: string; sender: string; ts: number; kind: MsgKind;
  body: string; html?: string; pills: Pill[];
  /** m.mentions.user_ids, or undefined when the sender declared nothing (old clients). */
  mentions?: string[];
  msgtype?: string;
  replyTo?: string; thread?: string;
  edited?: boolean; editTs?: number;
  media?: Media; sys?: SysInfo;
  pending?: boolean; failed?: string; txnId?: string;
  /** Pagination token reaching history older than this event (set on the first event of each page). */
  before?: string;
  /** A local-only card (help, whois…); never sent. */
  local?: { kind: string; data?: unknown };
  /** Bumped on any change, so a renderer can cache rows. */
  rev: number;
}

export interface Member { userId: string; membership: string; displayName?: string; avatar?: string }
export interface Receipt { eventId: string; ts: number }
export interface Presence { presence: string; lastActiveAgo?: number; currentlyActive?: boolean; statusMsg?: string; at: number }

export interface Room {
  id: string;
  membership: 'join' | 'invite';
  name?: string; topic?: string; alias?: string; altAliases: string[]; avatar?: string;
  createType?: string; encrypted: boolean; joinRule?: string;
  tombstone?: { body: string; replacement: string };
  power?: { users?: Record<string, number>; users_default?: number; events?: Record<string, number>; state_default?: number; events_default?: number; redact?: number };
  members: Map<string, Member>;
  heroes: string[]; joinedCount?: number; invitedCount?: number;
  isDirect: boolean;
  inviter?: string; inviteDirect?: boolean;
  timeline: Msg[]; byId: Map<string, Msg>;
  prevBatch?: string | null; reachedStart: boolean;
  unread: number; highlights: number;
  typing: string[];
  receipts: Map<string, Receipt>;
  fullyRead?: string;
  pinned: string[];
  /** target event → key → sender → annotation event id */
  reactions: Map<string, Map<string, Map<string, string>>>;
  annotations: Map<string, { target: string; key: string; sender: string }>;
  pendingEdits: Map<string, RawEvent>;
  pendingRedactions: Set<string>;
  lastTs: number;
  /** Bumped whenever the room changes: list rows and headers re-render on it. */
  rev: number;
  /** Someone is reading old history: don't trim from the top (up to twice the cap). */
  holdCap?: boolean;
}

export interface ChatState {
  me: string;
  rooms: Map<string, Room>;
  direct: Record<string, string[]>;
  presence: Map<string, Presence>;
  muted: Set<string>;
  nextBatch?: string;
}

export interface Fresh { roomId: string; msg: Msg }
export interface Delta { changed: Set<string>; fresh: Fresh[]; left: string[]; joined: string[]; invited: string[]; presence: boolean; direct: boolean }

export function emptyState(me: string): ChatState {
  return { me, rooms: new Map(), direct: {}, presence: new Map(), muted: new Set() };
}

export function newRoom(id: string, membership: Room['membership']): Room {
  return {
    id, membership, altAliases: [], encrypted: false, members: new Map(), heroes: [], isDirect: false,
    timeline: [], byId: new Map(), reachedStart: false, unread: 0, highlights: 0, typing: [], receipts: new Map(),
    pinned: [], reactions: new Map(), annotations: new Map(), pendingEdits: new Map(), pendingRedactions: new Set(), lastTs: 0, rev: 0,
  };
}

/* Setup chatter that would only clutter a timeline. */
const HIDDEN_STATE = new Set(['m.room.create', 'm.room.power_levels', 'm.room.join_rules', 'm.room.history_visibility', 'm.room.guest_access',
  'm.room.server_acl', 'm.room.encryption', 'm.room.canonical_alias', 'm.space.child', 'm.space.parent', 'm.room.avatar', 'm.room.related_groups',
  'm.room.retention', 'im.vector.modular.widgets', 'structs.pay']);

/* ── Sync ────────────────────────────────────────────────────────────────── */

/** Fold one /sync response into the state. `initial` marks the first sync (nothing counts as fresh). */
export function applySync(st: ChatState, res: any, initial = false): Delta {
  const d: Delta = { changed: new Set(), fresh: [], left: [], joined: [], invited: [], presence: false, direct: false };
  const rooms = res?.rooms ?? {};

  for (const ev of res?.account_data?.events ?? []) {
    if (ev.type === 'm.direct' && ev.content && typeof ev.content === 'object') { st.direct = ev.content; d.direct = true; }
    if (ev.type === 'm.push_rules') { st.muted = mutedRooms(ev.content); for (const id of st.rooms.keys()) d.changed.add(id); }
  }

  for (const [id, j] of Object.entries<any>(rooms.join ?? {})) {
    let r = st.rooms.get(id);
    const fresh = !r || r.membership !== 'join';
    if (!r || r.membership !== 'join') {
      const prev = r;
      r = newRoom(id, 'join');
      if (prev) { r.name = prev.name; r.alias = prev.alias; r.topic = prev.topic; }
      st.rooms.set(id, r);
      if (!initial) d.joined.push(id);
    }
    const s = j.summary ?? {};
    if (Array.isArray(s['m.heroes'])) r.heroes = s['m.heroes'];
    if (typeof s['m.joined_member_count'] === 'number') r.joinedCount = s['m.joined_member_count'];
    if (typeof s['m.invited_member_count'] === 'number') r.invitedCount = s['m.invited_member_count'];
    for (const ev of j.state?.events ?? []) applyState(r, ev);
    const tl = j.timeline ?? {};
    if (tl.limited) resetTimeline(r);
    if (fresh || tl.limited || !r.timeline.some((m) => !m.pending)) {
      r.prevBatch = tl.prev_batch ?? null;
      r.reachedStart = !tl.prev_batch || tl.events?.[0]?.type === 'm.room.create';
    }
    let first = true;
    for (const ev of tl.events ?? []) {
      const m = ingest(r, ev, 'append');
      if (m && first && tl.prev_batch) m.before = tl.prev_batch;
      if (m) first = false;
      if (m && !initial && !m.local && m.sender !== st.me) d.fresh.push({ roomId: id, msg: m });
    }
    capTimeline(r);
    for (const ev of j.ephemeral?.events ?? []) applyEphemeral(st, r, ev);
    for (const ev of j.account_data?.events ?? []) if (ev.type === 'm.fully_read' && ev.content?.event_id) r.fullyRead = ev.content.event_id;
    const un = j.unread_notifications;
    if (un) { r.unread = Number(un.notification_count ?? 0); r.highlights = Number(un.highlight_count ?? 0); }
    r.rev++;
    d.changed.add(id);
  }

  for (const [id, inv] of Object.entries<any>(rooms.invite ?? {})) {
    let r = st.rooms.get(id);
    if (!r || r.membership !== 'invite') { r = newRoom(id, 'invite'); st.rooms.set(id, r); d.invited.push(id); }
    for (const ev of inv.invite_state?.events ?? []) {
      applyState(r, ev);
      if (ev.type === 'm.room.member' && ev.state_key === st.me) {
        r.inviter = ev.sender;
        r.inviteDirect = !!ev.content?.is_direct;
        if (typeof ev.origin_server_ts === 'number') r.lastTs = ev.origin_server_ts;
      }
    }
    if (!r.lastTs) r.lastTs = Date.now();
    r.rev++;
    d.changed.add(id);
  }

  for (const id of Object.keys(rooms.leave ?? {})) {
    if (st.rooms.delete(id)) { d.left.push(id); d.changed.add(id); }
  }

  for (const ev of res?.presence?.events ?? []) {
    if (!ev.sender || !ev.content) continue;
    st.presence.set(ev.sender, { presence: ev.content.presence, lastActiveAgo: ev.content.last_active_ago, currentlyActive: ev.content.currently_active, statusMsg: ev.content.status_msg, at: Date.now() });
    d.presence = true;
  }

  if (d.direct || d.joined.length || d.invited.length || initial) markDirect(st);
  if (typeof res?.next_batch === 'string') st.nextBatch = res.next_batch;
  return d;
}

/** One /rooms/{id}/messages page (dir=b): older history in front of what is loaded. */
export function applyMessages(st: ChatState, roomId: string, res: any): number {
  const r = st.rooms.get(roomId);
  if (!r) return 0;
  for (const ev of res?.state ?? []) if (ev.type === 'm.room.member') applyState(r, ev, true);
  const chunk: RawEvent[] = Array.isArray(res?.chunk) ? [...res.chunk].reverse() : [];
  const rows: Msg[] = [];
  for (const ev of chunk) {
    const m = ingest(r, ev, 'prepend');
    if (m) rows.push(m);
  }
  if (rows.length && res?.end) rows[0].before = res.end;
  r.timeline = rows.concat(r.timeline);
  r.prevBatch = res?.end ?? null;
  if (!res?.end || !chunk.length) r.reachedStart = true;
  r.rev++;
  return rows.length;
}

function resetTimeline(r: Room) {
  // A gap: the server skipped events. Start over from what it sent; scrolling up fills the rest.
  r.timeline = r.timeline.filter((m) => m.pending);
  r.byId = new Map(r.timeline.map((m) => [m.id, m]));
  r.reachedStart = false;
}

function capTimeline(r: Room) {
  const over = r.timeline.length - TIMELINE_CAP;
  if (over <= 0 || (r.holdCap && r.timeline.length < TIMELINE_CAP * 2)) return;
  for (const m of r.timeline.splice(0, over)) r.byId.delete(m.id);
  // The page token of the first surviving page reaches what we just dropped (duplicates are skipped).
  const withToken = r.timeline.find((m) => m.before);
  r.prevBatch = withToken?.before ?? null;
  r.reachedStart = false;
}

/* ── Events ──────────────────────────────────────────────────────────────── */

/** One timeline event. Returns the new row, if it made one. */
export function ingest(r: Room, ev: RawEvent, mode: 'append' | 'prepend'): Msg | null {
  if (!ev || typeof ev.type !== 'string') return null;
  const id = ev.event_id;
  if (id && r.byId.has(id)) {
    const known = r.byId.get(id)!;
    if (known.pending) { known.pending = false; known.rev++; }
    return null;
  }
  const ts = typeof ev.origin_server_ts === 'number' ? ev.origin_server_ts : Date.now();
  if (mode === 'append' && ts > r.lastTs) r.lastTs = ts;
  const c = ev.content ?? {};
  const rel = c['m.relates_to'] ?? {};

  if (ev.type === 'm.room.redaction') {
    const target = c.redacts ?? ev.redacts;
    if (target) redact(r, target);
    return null;
  }
  if (ev.type === 'm.reaction') {
    if (ev.unsigned?.redacted_because || rel.rel_type !== 'm.annotation' || !rel.event_id || typeof rel.key !== 'string' || !id || !ev.sender) return null;
    if (r.pendingRedactions.delete(id)) return null;
    addReaction(r, id, rel.event_id, rel.key, ev.sender);
    return null;
  }
  if (ev.type === 'm.room.message' && rel.rel_type === 'm.replace' && rel.event_id) {
    applyEdit(r, rel.event_id, ev);
    return null;
  }

  // An echo of something we sent: the local row becomes the real one.
  const txn = ev.unsigned?.transaction_id;
  if (txn && mode === 'append') {
    const local = r.timeline.find((m) => m.txnId === txn);
    if (local) {
      if (local.id !== id) r.byId.delete(local.id);
      const rev = local.rev;
      Object.assign(local, rowFor(ev, ts) ?? {}, { pending: false, failed: undefined, txnId: txn, rev });
      if (id) { local.id = id; r.byId.set(id, local); }
      local.rev++;
      return null;
    }
  }

  if (ev.state_key !== undefined && mode === 'append') applyState(r, ev);
  const m = rowFor(ev, ts);
  if (!m) return null;
  if (m.id && r.pendingRedactions.delete(m.id)) toRedacted(m);
  const edit = r.pendingEdits.get(m.id);
  if (edit) { r.pendingEdits.delete(m.id); applyEditTo(m, edit); }
  r.byId.set(m.id, m);
  if (mode === 'append') r.timeline.push(m);
  return m;
}

let localSeq = 0;
function rowFor(ev: RawEvent, ts: number): Msg | null {
  const id = ev.event_id ?? `~${++localSeq}`;
  const sender = ev.sender ?? '';
  const c = ev.content ?? {};
  const base: Msg = { id, sender, ts, kind: 'other', body: '', pills: [], rev: 0 };
  if (ev.unsigned?.redacted_because && (ev.type === 'm.room.message' || ev.type === 'm.sticker' || ev.type === 'm.room.encrypted')) return toRedacted(base);

  if (ev.state_key !== undefined) {
    if (HIDDEN_STATE.has(ev.type)) return null;
    if (ev.type === 'm.room.member') {
      const prev = ev.unsigned?.prev_content?.membership;
      const mem = c.membership;
      // Name and avatar changes are noise; only arrivals, departures and invitations show.
      if (mem === prev && mem === 'join') return null;
      return { ...base, kind: 'system', sys: { type: ev.type, target: ev.state_key, membership: mem, prev, reason: c.reason }, body: '' };
    }
    if (ev.type === 'm.room.topic') return { ...base, kind: 'system', sys: { type: ev.type, text: String(c.topic ?? '') } };
    if (ev.type === 'm.room.name') return { ...base, kind: 'system', sys: { type: ev.type, text: String(c.name ?? '') } };
    if (ev.type === 'm.room.pinned_events') return { ...base, kind: 'system', sys: { type: ev.type, pinned: Array.isArray(c.pinned) ? c.pinned.length : 0 } };
    if (ev.type === 'm.room.tombstone') return { ...base, kind: 'system', sys: { type: ev.type, text: String(c.body ?? 'This channel moved') } };
    return null;
  }
  if (ev.type === 'm.room.encrypted') return { ...base, kind: 'encrypted', body: 'Encrypted transmission — this client cannot read it' };
  if (ev.type !== 'm.room.message' && ev.type !== 'm.sticker') return null;
  if (typeof c.body !== 'string' && !c.msgtype) return toRedacted(base);
  fillContent(base, c, ev.type === 'm.sticker' ? 'm.image' : c.msgtype);
  const rel = c['m.relates_to'] ?? {};
  if (rel['m.in_reply_to']?.event_id) {
    base.replyTo = rel['m.in_reply_to'].event_id;
    base.body = stripReplyFallback(base.body);
    if (base.html) base.html = stripReplyHtml(base.html);
  }
  if (rel.rel_type === 'm.thread' && rel.event_id) base.thread = rel.event_id;
  return base;
}

/** A positive finite number from untrusted content, or undefined (it ends up in style strings). */
const dim = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e9 ? v : undefined);

function fillContent(m: Msg, c: any, msgtype: string | undefined) {
  m.msgtype = msgtype;
  m.body = typeof c.body === 'string' ? c.body : '';
  m.html = c.format === 'org.matrix.custom.html' && typeof c.formatted_body === 'string' ? c.formatted_body : undefined;
  m.pills = extractPills(m.html);
  const mm = c['m.mentions'];
  m.mentions = mm && typeof mm === 'object' ? (Array.isArray(mm.user_ids) ? mm.user_ids.filter((x: unknown) => typeof x === 'string') : []) : undefined;
  m.media = undefined;
  switch (msgtype) {
    case 'm.text': m.kind = 'text'; break;
    case 'm.emote': m.kind = 'emote'; break;
    case 'm.notice': m.kind = 'notice'; break;
    case 'm.image':
      m.kind = 'image';
      if (typeof c.url === 'string') m.media = { mxc: c.url, w: dim(c.info?.w), h: dim(c.info?.h), name: m.body, mimetype: String(c.info?.mimetype ?? ''), size: dim(c.info?.size) };
      break;
    case 'm.file': case 'm.video': case 'm.audio':
      m.kind = 'file';
      if (typeof c.url === 'string') m.media = { mxc: c.url, name: String(c.filename || m.body), mimetype: String(c.info?.mimetype ?? ''), size: dim(c.info?.size) };
      break;
    default: m.kind = m.body ? 'text' : 'other';
  }
}

function toRedacted(m: Msg): Msg {
  m.kind = 'redacted'; m.body = ''; m.html = undefined; m.pills = []; m.media = undefined; m.replyTo = undefined;
  m.rev++;
  return m;
}

function redact(r: Room, target: string) {
  const ann = r.annotations.get(target);
  if (ann) {
    r.annotations.delete(target);
    const byKey = r.reactions.get(ann.target);
    const who = byKey?.get(ann.key);
    if (who?.get(ann.sender) === target) who.delete(ann.sender);
    if (who && !who.size) byKey!.delete(ann.key);
    const m = r.byId.get(ann.target);
    if (m) m.rev++;
    return;
  }
  const m = r.byId.get(target);
  if (m) { toRedacted(m); r.reactions.delete(target); return; }
  r.pendingRedactions.add(target);
}

function addReaction(r: Room, annId: string, target: string, key: string, sender: string) {
  r.annotations.set(annId, { target, key, sender });
  let byKey = r.reactions.get(target);
  if (!byKey) { byKey = new Map(); r.reactions.set(target, byKey); }
  let who = byKey.get(key);
  if (!who) { who = new Map(); byKey.set(key, who); }
  if (!who.has(sender)) who.set(sender, annId);
  const m = r.byId.get(target);
  if (m) m.rev++;
}

function applyEdit(r: Room, target: string, ev: RawEvent) {
  const m = r.byId.get(target);
  if (!m) {
    const prev = r.pendingEdits.get(target);
    if (!prev || (prev.origin_server_ts ?? 0) <= (ev.origin_server_ts ?? 0)) r.pendingEdits.set(target, ev);
    return;
  }
  applyEditTo(m, ev);
}

function applyEditTo(m: Msg, ev: RawEvent) {
  // Only the author may edit, and only the newest edit counts.
  if (ev.sender !== m.sender || m.kind === 'redacted') return;
  const ts = ev.origin_server_ts ?? Date.now();
  if (m.editTs && m.editTs > ts) return;
  const nc = ev.content?.['m.new_content'];
  if (!nc || typeof nc.body !== 'string') return;
  const replyTo = m.replyTo, thread = m.thread;
  fillContent(m, nc, nc.msgtype ?? m.msgtype);
  m.replyTo = replyTo; m.thread = thread;
  m.edited = true;
  m.editTs = ts;
  m.rev++;
}

/* ── State ───────────────────────────────────────────────────────────────── */

export function applyState(r: Room, ev: RawEvent, membersOnly = false) {
  const c = ev.content ?? {};
  if (ev.type === 'm.room.member' && ev.state_key) {
    r.members.set(ev.state_key, { userId: ev.state_key, membership: c.membership ?? 'leave', displayName: typeof c.displayname === 'string' ? c.displayname : undefined, avatar: typeof c.avatar_url === 'string' ? c.avatar_url : undefined });
    return;
  }
  if (membersOnly) return;
  switch (ev.type) {
    case 'm.room.name': r.name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : undefined; break;
    case 'm.room.topic': r.topic = typeof c.topic === 'string' ? c.topic : undefined; break;
    case 'm.room.canonical_alias': r.alias = typeof c.alias === 'string' ? c.alias : undefined; r.altAliases = Array.isArray(c.alt_aliases) ? c.alt_aliases.filter((x: unknown) => typeof x === 'string') : []; break;
    case 'm.room.avatar': r.avatar = typeof c.url === 'string' ? c.url : undefined; break;
    case 'm.room.create': r.createType = typeof c.type === 'string' ? c.type : undefined; break;
    case 'm.room.encryption': r.encrypted = !!c.algorithm; break;
    case 'm.room.join_rules': r.joinRule = c.join_rule; break;
    case 'm.room.pinned_events': r.pinned = Array.isArray(c.pinned) ? c.pinned.filter((x: unknown) => typeof x === 'string') : []; break;
    case 'm.room.power_levels': r.power = c; break;
    case 'm.room.tombstone': if (c.replacement_room) r.tombstone = { body: String(c.body ?? ''), replacement: c.replacement_room }; break;
  }
}

function applyEphemeral(st: ChatState, r: Room, ev: RawEvent) {
  if (ev.type === 'm.typing') r.typing = (ev.content?.user_ids ?? []).filter((u: string) => u !== st.me);
  if (ev.type === 'm.receipt') {
    for (const [eventId, recs] of Object.entries<any>(ev.content ?? {})) {
      for (const kind of ['m.read', 'm.read.private']) {
        for (const [user, info] of Object.entries<any>(recs?.[kind] ?? {})) {
          if (kind === 'm.read.private' && user !== st.me) continue;
          if (info?.thread_id && info.thread_id !== 'main') continue;
          const prev = r.receipts.get(user);
          const ts = Number(info?.ts ?? Date.now());
          if (!prev || prev.ts <= ts) r.receipts.set(user, { eventId, ts });
        }
      }
    }
  }
}

function markDirect(st: ChatState) {
  const ids = new Set<string>();
  for (const list of Object.values(st.direct)) if (Array.isArray(list)) for (const id of list) ids.add(id);
  for (const r of st.rooms.values()) {
    const was = r.isDirect;
    r.isDirect = ids.has(r.id) || (r.membership === 'invite' && !!r.inviteDirect);
    if (was !== r.isDirect) r.rev++;
  }
}

/** Rooms whose push rules make no noise: room rules or override rules without a notify action. */
export function mutedRooms(rules: any): Set<string> {
  const out = new Set<string>();
  const g = rules?.global ?? {};
  for (const r of g.room ?? []) if (r.enabled !== false && !(r.actions ?? []).includes('notify')) out.add(r.rule_id);
  for (const r of g.override ?? []) {
    if (r.enabled === false || (r.actions ?? []).includes('notify')) continue;
    const cond = (r.conditions ?? []).find((c: any) => c.kind === 'event_match' && c.key === 'room_id');
    if (cond?.pattern && r.rule_id === cond.pattern) out.add(cond.pattern);
  }
  return out;
}

/* ── Local echo ──────────────────────────────────────────────────────────── */

export function addEcho(r: Room, me: string, txnId: string, content: any): Msg {
  const m: Msg = { id: 'pending-' + txnId, sender: me, ts: Date.now(), kind: 'text', body: '', pills: [], rev: 0, pending: true, txnId };
  fillContent(m, content, content.msgtype);
  const rel = content['m.relates_to'] ?? {};
  if (rel['m.in_reply_to']?.event_id) { m.replyTo = rel['m.in_reply_to'].event_id; m.body = stripReplyFallback(m.body); if (m.html) m.html = stripReplyHtml(m.html); }
  r.timeline.push(m);
  r.byId.set(m.id, m);
  r.lastTs = m.ts;
  r.rev++;
  return m;
}

/** The send landed: the row takes its real id (unless the sync echo already replaced it). */
export function settleEcho(r: Room, txnId: string, eventId: string) {
  const m = r.timeline.find((x) => x.txnId === txnId && x.pending);
  if (!m) return;
  if (r.byId.has(eventId) && r.byId.get(eventId) !== m) {
    // The sync echo arrived as its own row (no transaction id on it): drop the local copy.
    r.timeline.splice(r.timeline.indexOf(m), 1);
    r.byId.delete(m.id);
  } else {
    r.byId.delete(m.id);
    m.id = eventId;
    m.pending = false;
    r.byId.set(eventId, m);
    m.rev++;
  }
  r.rev++;
}

export function failEcho(r: Room, txnId: string, why: string) {
  const m = r.timeline.find((x) => x.txnId === txnId);
  if (m) { m.failed = why; m.pending = false; m.rev++; r.rev++; }
}

export function addLocal(r: Room, me: string, kind: string, data: unknown, body = ''): Msg {
  const m: Msg = { id: 'local-' + (++localSeq), sender: me, ts: Date.now(), kind: 'local', body, pills: [], rev: 0, local: { kind, data } };
  r.timeline.push(m);
  r.byId.set(m.id, m);
  r.rev++;
  return m;
}

/* ── Reading the model ───────────────────────────────────────────────────── */

export interface ReactionView { key: string; count: number; mine: string | null; who: string[] }
export function reactionsOf(r: Room, eventId: string, me: string): ReactionView[] {
  const byKey = r.reactions.get(eventId);
  if (!byKey) return [];
  const out: ReactionView[] = [];
  for (const [key, who] of byKey) if (who.size) out.push({ key, count: who.size, mine: who.get(me) ?? null, who: [...who.keys()] });
  return out;
}

/** The user a direct room is with (first other member, or hero). */
export function dmPartner(r: Room, me: string): string | null {
  for (const m of r.members.values()) if (m.userId !== me && (m.membership === 'join' || m.membership === 'invite')) return m.userId;
  const hero = r.heroes.find((h) => h !== me);
  if (hero) return hero;
  if (r.membership === 'invite' && r.inviter) return r.inviter;
  return null;
}

/** What to call a room: its name, its alias, who it is with. `nameOf` turns user ids into names. */
export function roomLabel(r: Room, me: string, nameOf: (userId: string) => string): string {
  if (r.name) return r.name;
  const obj = r.alias && /^#(planet|fleet)-(\d+-\d+):/.exec(r.alias);
  if (obj) return `${obj[1] === 'planet' ? 'Planet' : 'Fleet'} ${obj[2]}`;
  if (r.alias) return r.alias.split(':')[0];
  const others = [...r.members.values()].filter((m) => m.userId !== me && (m.membership === 'join' || m.membership === 'invite')).map((m) => m.userId);
  const who = others.length ? others : r.heroes.filter((h) => h !== me);
  if (!who.length && r.membership === 'invite' && r.inviter) who.push(r.inviter);
  if (who.length === 1) return nameOf(who[0]);
  if (who.length) return who.slice(0, 3).map(nameOf).join(', ') + (who.length > 3 ? ` +${who.length - 3}` : '');
  return 'Empty channel';
}

export type Section = 'invite' | 'direct' | 'local' | 'galaxy';
export function sectionOf(r: Room, myServer: string): Section {
  if (r.membership === 'invite') return 'invite';
  if (r.isDirect) return 'direct';
  const home = r.alias ? serverOf(r.alias) : serverOf(r.id);
  return home === myServer ? 'local' : 'galaxy';
}

/** Rooms nobody should see in the channel list: sim match rooms, the work bus. */
export function hiddenRoom(r: Room): boolean {
  return r.createType === 'structs.sim.match' || r.createType === 'm.space' || (!!r.alias && /^#bus:/.test(r.alias));
}

export const joinedMembers = (r: Room) => [...r.members.values()].filter((m) => m.membership === 'join');
export const memberCount = (r: Room) => r.joinedCount ?? joinedMembers(r).length;

/** Power level of a user, and whether they may do a thing. */
export function powerOf(r: Room, userId: string): number {
  const p = r.power;
  if (!p) return 0;
  return p.users?.[userId] ?? p.users_default ?? 0;
}
export function canState(r: Room, userId: string, type: string): boolean {
  if (!r.power) return true;
  return powerOf(r, userId) >= (r.power.events?.[type] ?? r.power.state_default ?? 50);
}
export function canRedactOthers(r: Room, userId: string): boolean {
  return powerOf(r, userId) >= (r.power?.redact ?? 50);
}

/** Senders seen in a room's loaded timeline (newest first) — /who and @-completion. */
export function speakers(r: Room): string[] {
  const out: string[] = [];
  for (let i = r.timeline.length - 1; i >= 0; i--) {
    const m = r.timeline[i];
    if (m.kind !== 'system' && m.kind !== 'local' && m.sender && !out.includes(m.sender)) out.push(m.sender);
  }
  return out;
}

/** The newest real event in a room (what a read marker should point at). */
export function newestEvent(r: Room): Msg | null {
  for (let i = r.timeline.length - 1; i >= 0; i--) {
    const m = r.timeline[i];
    if (!m.pending && !m.local && m.id.startsWith('$')) return m;
  }
  return null;
}

/** Index of the first message after my read receipt from someone else, or -1. */
export function firstUnreadIndex(r: Room, me: string): number {
  const mine = r.receipts.get(me)?.eventId ?? r.fullyRead;
  if (!mine) return -1;
  const at = r.timeline.findIndex((m) => m.id === mine);
  if (at < 0) return -1;
  for (let i = at + 1; i < r.timeline.length; i++) {
    const m = r.timeline[i];
    if (m.sender !== me && m.kind !== 'system' && m.kind !== 'local' && m.kind !== 'redacted') return i;
  }
  return -1;
}

export { localpart, playerOfUser };
