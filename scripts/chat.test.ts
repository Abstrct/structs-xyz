/* Comms, offline: message text (ids, links, pills, replies, commands) and the sync reducer. */
import {
  completionsFor, editContent, extractIds, extractPills, formatWithPills, mentionsMe, messageContent, objectRoomLocal, parseInput,
  refRoute, replyContent, resolveMentions, safeMediaType, segment, slug, stripReplyFallback, stripReplyHtml, structReaction,
} from '../src/chat/format';
import { resolveObjectURL } from 'node:buffer';
import { tokenProblem } from '../src/ui/comms/tokenGuard';
import { authorizeUrl, b64url, guildApiRoot, guildLoginProblem, loginForm, matrixScope, newDeviceId, pkceChallenge, readCallback, registrationBody, within } from '../src/chat/oauth';
import { newRoom } from '../src/chat/model';
import {
  TIMELINE_CAP, addEcho, applyMessages, applySync, dmPartner, emptyState, firstUnreadIndex, hiddenRoom, mutedRooms, newestEvent,
  reactionsOf, roomLabel, sectionOf, settleEcho, speakers,
} from '../src/chat/model';

let failures = 0;
const check = (c: unknown, m: string) => { if (!c) { failures++; console.error('FAIL', m); } };
const eq = (a: unknown, b: unknown, m: string) => check(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

/* ── The access-token box never sends a recovery phrase ─────────────────── */
check(tokenProblem('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about') !== null, 'a recovery phrase is refused as a token');
check(tokenProblem('  my words: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about ') !== null, 'a phrase inside other text is refused');
check(tokenProblem('syt_abc def') !== null, 'a token with spaces is refused');
check(tokenProblem('  syt_dXNlcg_AbCdEfGh_0123ab  ') === null, 'a real-looking token passes');

/* ── Wallet sign-in: the desktop app's chain, its pure parts ─────────────── */
{
  // RFC 7636 appendix B: the documented verifier and its S256 challenge.
  eq(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'PKCE S256 matches RFC 7636');
  eq(b64url(new Uint8Array([251, 255, 191])), '-_-_', 'base64url has no + / or padding');
  check(/^[A-Z0-9]{10}$/.test(newDeviceId()), 'a device id is one scope token');
  eq(matrixScope('ABC'), 'urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:ABC', 'the Matrix scope names the device');
  const meta = { issuer: 'https://auth.g.test/', authorization_endpoint: 'https://auth.g.test/authorize?x=1', token_endpoint: 'https://auth.g.test/oauth2/token' };
  const a = new URL(authorizeUrl(meta, { clientId: 'C', redirectUri: 'https://structs.xyz/comms-callback.html', deviceId: 'D1', state: 'S', challenge: 'CH' }));
  eq([a.origin + a.pathname, a.searchParams.get('x'), a.searchParams.get('response_type'), a.searchParams.get('client_id'), a.searchParams.get('redirect_uri'), a.searchParams.get('state'), a.searchParams.get('code_challenge'), a.searchParams.get('code_challenge_method'), a.searchParams.get('scope')?.endsWith('device:D1')],
    ['https://auth.g.test/authorize', '1', 'code', 'C', 'https://structs.xyz/comms-callback.html', 'S', 'CH', 'S256', true], 'the authorize URL carries the code flow with PKCE');
  check(a.searchParams.get('prompt') === null && new URL(authorizeUrl(meta, { clientId: 'C', redirectUri: 'r', deviceId: 'D', state: 'S', challenge: 'CH', prompt: 'login' })).searchParams.get('prompt') === 'login', 'prompt=login only when asked');
  eq(['https://g.test/api/', 'https://g.test', 'https://g.test/api'].map(guildApiRoot), ['https://g.test/api', 'https://g.test/api', 'https://g.test/api'], 'the form login and its pre-check share one API root');
  const ac = new AbortController();
  const w = within(ac.signal, 60_000);
  ac.abort();
  check(w.aborted, 'Cancel aborts a request in flight');
  const reg = registrationBody('https://structs.xyz/', 'https://structs.xyz/comms-callback.html');
  eq([reg.application_type, reg.token_endpoint_auth_method, reg.redirect_uris, reg.grant_types], ['web', 'none', ['https://structs.xyz/comms-callback.html'], ['authorization_code', 'refresh_token']], 'registered as a public web client');
  eq(loginForm({ address: 'structs1a', signature: 'ab', pubkey: 'cd', guild_id: '0-5', unix_timestamp: 123 }, 'https://auth.g.test/authorize?q'),
    { address: 'structs1a', signature: 'ab', pubkey: 'cd', guild_id: '0-5', unix_timestamp: '123', continue: 'https://auth.g.test/authorize?q' }, 'the guild form login: the signed fields and continue');
  eq(readCallback('?code=K&state=S', 'S'), { code: 'K' }, 'the callback gives the code for our state');
  let threw = '';
  try { readCallback('?code=K&state=OTHER', 'S'); } catch (e) { threw = (e as Error).message; }
  check(/not for this sign-in/.test(threw), 'a code for another state is refused');
  threw = '';
  try { readCallback('?error=access_denied&state=S', 'S'); } catch (e) { threw = (e as Error).message; }
  check(/cancelled/.test(threw), 'a refusal reads as cancelled');
  check(guildLoginProblem({ success: true }, 200) === null, 'a guild login that succeeded is no problem');
  eq(guildLoginProblem({ success: false, errors: { signature_validation_failed: 'Invalid signature' } }, 401), 'Invalid signature', 'the guild says why in its own words');
}

/* ── Chain ids ──────────────────────────────────────────────────────────── */
eq(extractIds('raid 2-15361 with 9-61 and 1-194, not 12-345-6, a1-2, x_3-4, 2024-10-09 or 3-1234567890'), ['2-15361', '9-61', '1-194'], 'ids in text');
eq(extractIds('(1-7) 0-5. 5-99;'), ['1-7', '0-5', '5-99'], 'ids next to punctuation');
eq(extractIds('7-12 and 77-1'), [], 'unknown id kinds are ignored');
eq([refRoute('1-12'), refRoute('2-3'), refRoute('0-5'), refRoute('9-4'), refRoute('5-77'), refRoute('8-1')], ['/player/1-12', '/planet/2-3', '/intel/guild/0-5', '/intel/activity/9-4', '/intel/activity/5-77', null], 'id routes');
eq(objectRoomLocal('2-15361'), { kind: 'planet', local: 'planet-2-15361' }, 'planet channel alias');
eq(objectRoomLocal('9-61'), { kind: 'fleet', local: 'fleet-9-61' }, 'fleet channel alias');
check(objectRoomLocal('1-5') === null, 'players have no object channel');
eq(slug('Orbital Hydro'), 'orbital-hydro', 'guild lobby slug');

/* ── Segments ───────────────────────────────────────────────────────────── */
const segs = segment('gm @Alice see https://structs.ai/START. ping 2-15 and `1-9 raw` @1-3:matrix.crew.oh.energy', [{ name: 'Alice', userId: '@1-1:hs.example' }]);
eq(segs.map((s) => s.t), ['text', 'mention', 'text', 'url', 'text', 'id', 'text', 'code', 'text', 'mention'], 'segment kinds');
check(segs.find((s) => s.t === 'url')?.s === 'https://structs.ai/START', 'trailing dot stays out of the link');
check(segs.find((s) => s.t === 'mention')?.s === '@Alice', 'pill matched with its @');
check(segs.at(-1)?.t === 'mention' && (segs.at(-1) as { userId: string }).userId === '@1-3:matrix.crew.oh.energy', 'raw user id is a mention');
eq(segment('see (https://en.wikipedia.org/wiki/Foo_(bar)) ok').filter((s) => s.t === 'url').map((s) => s.s), ['https://en.wikipedia.org/wiki/Foo_(bar)'], 'balanced parens stay in a link');
eq(segment('javascript:alert(1) <b>x</b>').map((s) => s.t), ['text'], 'no fake links, markup is text');

/* ── Mentions and pills ─────────────────────────────────────────────────── */
const cands = [{ name: 'Alice', userId: '@1-1:hs' }, { name: 'Alice Smith', userId: '@1-2:hs' }, { name: 'Bob', userId: '@1-3:hs' }, { name: 'Bobby', userId: '@1-4:hs' }];
eq(resolveMentions('hey @Alice Smith and @bob, not bob@mail', cands).map((p) => p.userId), ['@1-2:hs', '@1-3:hs'], 'longest name wins, case-insensitive');
eq(resolveMentions('@Bobby!', cands).map((p) => p.userId), ['@1-4:hs'], 'Bobby is not Bob');
const html = formatWithPills('<b>@Alice</b> & @Bob\nsee', [cands[0], cands[2]]);
eq(html, '&lt;b&gt;<a href="https://matrix.to/#/@1-1:hs">Alice</a>&lt;/b&gt; &amp; <a href="https://matrix.to/#/@1-3:hs">Bob</a><br>see', 'pills in escaped html');
check(formatWithPills('no mentions', cands) === null, 'no pills, no html');
eq(extractPills('<a href="https://matrix.to/#/%401-9%3Ahs.example">Zed &amp; Co</a> and <a href="https://example.com">x</a>'), [{ name: 'Zed & Co', userId: '@1-9:hs.example' }], 'pills read back from html');
eq(extractPills(html), [{ name: 'Alice', userId: '@1-1:hs' }, { name: 'Bob', userId: '@1-3:hs' }], 'our own pills round-trip');

check(mentionsMe('hi', ['@1-5:hs'], '@1-5:hs', []), 'm.mentions names me');
check(!mentionsMe('hey Nova', [], '@1-5:hs', ['Nova']), 'declared mentions without me: not me');
check(mentionsMe('hey @nova, raid?', undefined, '@1-5:hs', ['Nova']), 'old clients: my name in the text');
check(!mentionsMe('supernova', undefined, '@1-5:hs', ['Nova']), 'not inside a word');

/* ── Replies and edits ──────────────────────────────────────────────────── */
const parent = { roomId: '!r:hs', eventId: '$p', sender: '@1-1:hs', body: '> <@1-0:hs> older\n\nfirst line\nsecond <line>' };
const rc = replyContent(parent, 'answer', null);
eq(rc.body, '> <@1-1:hs> first line\n> second <line>\n\nanswer', 'reply fallback body (nested fallback dropped)');
check(rc.formatted_body.startsWith('<mx-reply><blockquote><a href="https://matrix.to/#/!r:hs/$p">In reply to</a>') && rc.formatted_body.includes('second &lt;line&gt;') && rc.formatted_body.endsWith('</mx-reply>answer'), 'reply fallback html');
eq(stripReplyFallback(rc.body), 'answer', 'fallback stripped');
eq(stripReplyHtml(rc.formatted_body), 'answer', 'html fallback stripped');
eq(stripReplyFallback('> quoting a friend'), '', 'all-quote body strips to nothing (only used on replies)');
const mc = messageContent({ msgtype: 'm.text', body: 'on it @Bob', mentions: [cands[2]], replyTo: parent });
eq(mc['m.relates_to'], { 'm.in_reply_to': { event_id: '$p' } }, 'reply relation');
eq((mc['m.mentions'] as { user_ids: string[] }).user_ids.sort(), ['@1-1:hs', '@1-3:hs'], 'reply mentions the parent sender too');
eq(messageContent({ msgtype: 'm.emote', body: 'waves' }), { msgtype: 'm.emote', body: 'waves', 'm.mentions': { user_ids: [] } }, 'plain emote');
const ec = editContent('$e', { msgtype: 'm.text', body: 'fixed' });
eq(ec, { msgtype: 'm.text', body: '* fixed', 'm.new_content': { msgtype: 'm.text', body: 'fixed', 'm.mentions': { user_ids: [] } }, 'm.mentions': {}, 'm.relates_to': { rel_type: 'm.replace', event_id: '$e' } }, 'edit content');

/* ── Commands ───────────────────────────────────────────────────────────── */
eq(parseInput('/me waves hello'), { kind: 'cmd', name: 'me', arg: 'waves hello', argv: ['waves', 'hello'] }, '/me');
eq(parseInput('//etc/passwd'), { kind: 'text', text: '/etc/passwd' }, '// escapes');
eq(parseInput('/frobnicate x'), { kind: 'unknown', name: 'frobnicate' }, 'unknown command');
eq(parseInput('/LEAVE'), { kind: 'cmd', name: 'leave', arg: '', argv: [] }, 'commands are case-insensitive');
eq(parseInput('hello /me'), { kind: 'text', text: 'hello /me' }, 'not a command mid-line');
eq(completionsFor('/wh', []), ['/who', '/whois'], 'command completion');
eq(completionsFor('@al', ['Bob', 'Alice', 'Sally']), ['@Alice', '@Sally'], 'name completion: prefix, then contains');
check(structReaction(':struct/tank:') === 'tank' && structReaction(':struct/nope:') === null, 'struct reaction art');

/* ── Sync reducer ───────────────────────────────────────────────────────── */
const ME = '@1-5:hs';
const st = emptyState(ME);
let ts = 1_700_000_000_000;
const ev = (type: string, sender: string, content: unknown, extra: Record<string, unknown> = {}) => ({ type, sender, content, event_id: '$' + (++ts), origin_server_ts: ts, ...extra });
const msg = (sender: string, body: string, extra: Record<string, unknown> = {}) => ev('m.room.message', sender, { msgtype: 'm.text', body }, extra);

const m1 = msg('@1-1:hs', 'first');
const m2 = msg('@1-2:hs', 'second');
const m3 = ev('m.room.message', '@1-1:hs', { msgtype: 'm.text', body: '> <@1-2:hs> second\n\nreplying', 'm.relates_to': { 'm.in_reply_to': { event_id: m2.event_id } } });
const edit = ev('m.room.message', '@1-1:hs', { msgtype: 'm.text', body: '* first!', 'm.new_content': { msgtype: 'm.text', body: 'first!' }, 'm.relates_to': { rel_type: 'm.replace', event_id: m1.event_id } });
const forged = ev('m.room.message', '@1-2:hs', { msgtype: 'm.text', body: '* hacked', 'm.new_content': { msgtype: 'm.text', body: 'hacked' }, 'm.relates_to': { rel_type: 'm.replace', event_id: m1.event_id } });
const react = ev('m.reaction', '@1-2:hs', { 'm.relates_to': { rel_type: 'm.annotation', event_id: m1.event_id, key: ':raid:' } });
const react2 = ev('m.reaction', ME, { 'm.relates_to': { rel_type: 'm.annotation', event_id: m1.event_id, key: ':raid:' } });
const redactMine = ev('m.room.redaction', '@1-2:hs', { redacts: m2.event_id });
const sync1 = {
  next_batch: 's1',
  account_data: { events: [{ type: 'm.direct', content: { '@1-9:hs': ['!dm:hs'] } }, { type: 'm.push_rules', content: { global: { room: [{ rule_id: '!muted:other', actions: [] }] } } }] },
  presence: { events: [{ sender: '@1-1:hs', content: { presence: 'online', currently_active: true } }] },
  rooms: {
    join: {
      '!lobby:hs': {
        summary: { 'm.joined_member_count': 3 },
        state: { events: [
          { type: 'm.room.name', state_key: '', sender: '@1-1:hs', content: { name: 'Lobby' } },
          { type: 'm.room.canonical_alias', state_key: '', sender: '@1-1:hs', content: { alias: '#lobby:hs' } },
          { type: 'm.room.member', state_key: '@1-1:hs', sender: '@1-1:hs', content: { membership: 'join', displayname: 'Alice' } },
          { type: 'm.room.member', state_key: '@1-2:hs', sender: '@1-2:hs', content: { membership: 'join' } },
          { type: 'm.room.member', state_key: ME, sender: ME, content: { membership: 'join' } },
        ] },
        timeline: { prev_batch: 'p0', limited: true, events: [m1, m2, m3, edit, forged, react, react2, redactMine, ev('m.room.power_levels', '@1-1:hs', { users: { '@1-1:hs': 100 } }, { state_key: '' })] },
        ephemeral: { events: [{ type: 'm.typing', content: { user_ids: ['@1-2:hs', ME] } }, { type: 'm.receipt', content: { [m1.event_id]: { 'm.read': { '@1-2:hs': { ts: 1 }, [ME]: { ts: 2 } } } } }] },
        unread_notifications: { notification_count: 2, highlight_count: 1 },
      },
      '!dm:hs': {
        state: { events: [{ type: 'm.room.member', state_key: '@1-9:hs', sender: '@1-9:hs', content: { membership: 'join' } }, { type: 'm.room.member', state_key: ME, sender: ME, content: { membership: 'join' } }] },
        timeline: { events: [{ type: 'm.room.create', state_key: '', sender: '@1-9:hs', content: { creator: '@1-9:hs' }, event_id: '$c', origin_server_ts: 1 }, msg('@1-9:hs', 'psst')] },
      },
      '!fed:other': { state: { events: [{ type: 'm.room.canonical_alias', state_key: '', sender: '@x:other', content: { alias: '#sn-corp:other' } }] }, timeline: { prev_batch: 'q', events: [] } },
      '!sim:hs': { state: { events: [{ type: 'm.room.create', state_key: '', sender: '@1-1:hs', content: { type: 'structs.sim.match' } }] }, timeline: { events: [] } },
    },
    invite: { '!inv:hs': { invite_state: { events: [{ type: 'm.room.name', state_key: '', sender: '@1-1:hs', content: { name: 'War room' } }, { type: 'm.room.member', state_key: ME, sender: '@1-1:hs', content: { membership: 'invite', is_direct: false } }] } } },
  },
};
const d1 = applySync(st, sync1, true);
const lobby = st.rooms.get('!lobby:hs')!;
eq(lobby.timeline.map((m) => m.body), ['first!', '', 'replying'], 'timeline: edit applied, redaction blanked, reply fallback stripped');
eq(lobby.timeline.map((m) => m.kind), ['text', 'redacted', 'text'], 'row kinds');
check(lobby.timeline[0].edited && lobby.timeline[0].rev > 0, 'edit marks the row');
eq(lobby.timeline[2].replyTo, m2.event_id, 'reply target kept');
eq(reactionsOf(lobby, m1.event_id, ME), [{ key: ':raid:', count: 2, mine: react2.event_id, who: ['@1-2:hs', ME] }], 'reactions aggregated, mine known');
eq([lobby.unread, lobby.highlights, lobby.joinedCount], [2, 1, 3], 'unread counts and summary');
eq(lobby.typing, ['@1-2:hs'], 'typing excludes me');
eq(lobby.receipts.get('@1-2:hs')?.eventId, m1.event_id, 'receipts');
eq(lobby.prevBatch, 'p0', 'pagination token from the first sync');
check(lobby.timeline[0].before === 'p0', 'the first row carries its page token');
eq(roomLabel(lobby, ME, (u) => u), 'Lobby', 'room name');
eq(sectionOf(lobby, 'hs'), 'local', 'own server is local');
eq(sectionOf(st.rooms.get('!fed:other')!, 'hs'), 'galaxy', 'federated');
const planetRoom = { ...st.rooms.get('!fed:other')!, alias: '#planet-2-15361:matrix.crew.oh.energy' };
eq(roomLabel(planetRoom, ME, (u) => u), 'Planet 2-15361', 'object rooms are named for their object');
const dm = st.rooms.get('!dm:hs')!;
check(dm.isDirect && sectionOf(dm, 'hs') === 'direct', 'm.direct marks DMs');
eq(dmPartner(dm, ME), '@1-9:hs', 'DM partner');
eq(roomLabel(dm, ME, (u) => 'name:' + u), 'name:@1-9:hs', 'DM named after the partner');
check(dm.reachedStart, 'a timeline that starts at m.room.create is complete');
check(hiddenRoom(st.rooms.get('!sim:hs')!), 'sim match rooms are hidden');
const inv = st.rooms.get('!inv:hs')!;
check(inv.membership === 'invite' && inv.inviter === '@1-1:hs' && sectionOf(inv, 'hs') === 'invite', 'invites');
check(st.muted.has('!muted:other'), 'muted from push rules');
check(st.presence.get('@1-1:hs')?.currentlyActive === true, 'presence');
eq(d1.fresh.length, 0, 'initial sync makes nothing fresh');
eq(speakers(lobby), ['@1-1:hs', '@1-2:hs'], 'speakers newest first');
eq(firstUnreadIndex(lobby, ME), 2, 'first unread after my receipt, from someone else');

// Send: local echo, then the server's copy arrives with our transaction id.
const echo = addEcho(lobby, ME, 'tx1', messageContent({ msgtype: 'm.text', body: 'hello @Alice', mentions: [{ name: 'Alice', userId: '@1-1:hs' }] }));
check(echo.pending && lobby.timeline.at(-1) === echo && echo.pills.length === 1, 'echo row');
const mine = msg(ME, 'hello @Alice', { unsigned: { transaction_id: 'tx1' } });
const theirs = msg('@1-2:hs', 'yo @nova', { content: { msgtype: 'm.text', body: 'yo', 'm.mentions': { user_ids: [ME] } } });
const d2 = applySync(st, { next_batch: 's2', rooms: { join: { '!lobby:hs': { timeline: { events: [mine, theirs] } }, '!fed:other': {} }, leave: { '!inv:hs': {} } } });
eq(lobby.timeline.filter((m) => m.body === 'hello @Alice').length, 1, 'echo replaced, not duplicated');
check(!echo.pending && echo.id === mine.event_id && lobby.byId.get(mine.event_id) === echo, 'echo took the real id');
eq(d2.fresh.map((f) => f.msg.body), ['yo'], 'only others’ messages are fresh');
eq(d2.fresh[0].msg.mentions, [ME], 'fresh row keeps m.mentions');
check(!st.rooms.has('!inv:hs') && d2.left.includes('!inv:hs'), 'left rooms go');
eq(newestEvent(lobby)?.id, theirs.event_id, 'newest event for read markers');

// The send's response can beat the sync echo: the row takes its id, then the echo is a duplicate.
addEcho(lobby, ME, 'tx2', { msgtype: 'm.text', body: 'fast' });
settleEcho(lobby, 'tx2', '$fast');
applySync(st, { rooms: { join: { '!lobby:hs': { timeline: { events: [{ type: 'm.room.message', sender: ME, event_id: '$fast', origin_server_ts: ++ts, content: { msgtype: 'm.text', body: 'fast' }, unsigned: { transaction_id: 'tx2' } }] } } } } });
eq(lobby.timeline.filter((m) => m.body === 'fast').length, 1, 'response-first echo not duplicated');

// Back-pagination: older events go in front, duplicates are skipped, an edit to an unloaded event waits for it.
const old1 = msg('@1-1:hs', 'ancient');
const lateEdit = ev('m.room.message', '@1-1:hs', { msgtype: 'm.text', body: '* ancient!', 'm.new_content': { msgtype: 'm.text', body: 'ancient (edited)' }, 'm.relates_to': { rel_type: 'm.replace', event_id: old1.event_id } });
applySync(st, { rooms: { join: { '!lobby:hs': { timeline: { events: [lateEdit] } } } } });
const before = lobby.timeline.length;
const n = applyMessages(st, '!lobby:hs', { chunk: [m1, old1], end: 'p1' });
eq(n, 1, 'one new row (the duplicate is skipped)');
eq(lobby.timeline.length, before + 1, 'prepended');
eq(lobby.timeline[0].body, 'ancient (edited)', 'pending edit applied when its target arrives');
eq([lobby.prevBatch, lobby.reachedStart], ['p1', false], 'next page token');
applyMessages(st, '!lobby:hs', { chunk: [], end: undefined });
check(lobby.reachedStart, 'empty page: beginning of the room');

// The redaction of a reaction removes it.
applySync(st, { rooms: { join: { '!lobby:hs': { timeline: { events: [ev('m.room.redaction', ME, {}, { redacts: react2.event_id })] } } } } });
eq(reactionsOf(lobby, m1.event_id, ME).map((r) => [r.count, r.mine]), [[1, null]], 'unreact');

// A gap (limited) starts the timeline over from the new chunk.
applySync(st, { rooms: { join: { '!lobby:hs': { timeline: { limited: true, prev_batch: 'gap', events: [msg('@1-1:hs', 'after the gap')] } } } } });
eq(lobby.timeline.map((m) => m.body), ['after the gap'], 'limited sync resets the timeline');
eq(lobby.prevBatch, 'gap', 'and paginates from the gap');

// The cap: the oldest rows go, and the first surviving page token takes over.
const many = Array.from({ length: TIMELINE_CAP + 20 }, (_, i) => msg('@1-1:hs', 'n' + i));
applySync(st, { rooms: { join: { '!lobby:hs': { timeline: { events: many.slice(0, 300), prev_batch: 'x1' } } } } });
applySync(st, { rooms: { join: { '!lobby:hs': { timeline: { events: many.slice(300), prev_batch: 'x2' } } } } });
eq(lobby.timeline.length, TIMELINE_CAP, 'timeline capped');
eq(lobby.timeline.at(-1)?.body, 'n' + (TIMELINE_CAP + 19), 'newest kept');
check(lobby.prevBatch === 'x2' && !lobby.byId.has(many[0].event_id), 'trimmed rows forgotten, page token from the surviving page');

// Mute rules in either shape.
const mr = mutedRooms({ global: { room: [{ rule_id: '!a', actions: ['dont_notify'] }, { rule_id: '!b', actions: ['notify'] }], override: [{ rule_id: '!c', actions: [], conditions: [{ kind: 'event_match', key: 'room_id', pattern: '!c' }] }] } });
eq([...mr].sort(), ['!a', '!c'], 'muted rooms');

/* ── Media types ────────────────────────────────────────────────────────── */
eq(['image/png', 'IMAGE/JPEG; charset=x', 'image/gif', 'image/webp'].map(safeMediaType), ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], 'raster thumbnails keep their type');
eq(['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', '', null, undefined, 'image/png+html'].map(safeMediaType), Array(8).fill('application/octet-stream'), 'anything that can script is opaque bytes');

/* ── The comms client against a stubbed browser and homeserver ──────────── */
// Comms has its own identity: acting as another account leaves chat alone, and chat never switches who the client acts as.
{
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
  const g = globalThis as Record<string, unknown>;
  g.localStorage = mem();
  g.window = Object.assign(new EventTarget(), { setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout });
  g.document = Object.assign(new EventTarget(), { hidden: false });
  const calls: { url: string; method: string; auth: string | null; body?: string }[] = [];
  let thumbType = 'text/html';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET';
    calls.push({ url, method, auth: new Headers(init?.headers).get('authorization'), body: typeof init?.body === 'string' ? init.body : undefined });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/structs/guild/0-5')) return json({ Guild: { id: '0-5', index: '5', endpoint: 'https://sn.test/guild.json' } });
    if (url === 'https://sn.test/guild.json') return json({ guild: { id: '0-5', name: 'SN Corp', tag: 'SN', services: { matrix: 'https://hs.test' } } });
    if (url.includes('/v3/sync')) { await new Promise((r) => setTimeout(r, 5)); return json({ next_batch: 's' + calls.length, rooms: {} }); }
    if (url.includes('/media/thumbnail/')) return new Response('<script>alert(1)</script>', { headers: { 'content-type': thumbType } });
    if (url.endsWith('/logout')) return json({});
    return json({ message: 'not stubbed' }, 404);
  }) as typeof fetch;
  const { wallet } = await import('../src/wallet/wallet');
  const { comms } = await import('../src/chat/matrix');
  await wallet.create('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'correct horse battery');
  const alt = wallet.addAccount(1, 'Replicant', 'productive');
  const primary = wallet.primary!;
  const sess = (account: string, user: string, token: string) => ({ homeserver: 'https://hs.test', user_id: user, device_id: 'D', access_token: token, refresh_token: null, expires_at: null, client_id: null, token_endpoint: null, guildId: '0-5', account });
  localStorage.setItem('structs.comms.session.' + primary.address, JSON.stringify(sess(primary.address, '@1-1:hs.test', 'tok-primary')));
  localStorage.setItem('structs.comms.session.' + alt.address, JSON.stringify(sess(alt.address, '@1-2:hs.test', 'tok-alt')));
  const settle = () => new Promise((r) => setTimeout(r, 30));

  comms.start();
  await settle();
  check(comms.identityIndex === 0 && comms.session?.user_id === '@1-1:hs.test', 'comms resumes the primary account by default');
  wallet.setActive(1);
  await settle();
  check(comms.session?.user_id === '@1-1:hs.test' && comms.state === 'live', 'acting as a replicant leaves the chat session alone');
  comms.setIdentity(1);
  await settle();
  check(comms.session?.user_id === '@1-2:hs.test' && wallet.activeIndex === 1, 'choosing the comms identity resumes its session');
  wallet.setActive(0);
  await settle();
  check(comms.session?.user_id === '@1-2:hs.test' && wallet.activeIndex === 0, 'and switching back the acting account still leaves it alone');
  wallet.removeAccount(1);
  await settle();
  check(comms.identityIndex === 0 && comms.session?.user_id === '@1-1:hs.test' && localStorage.getItem('structs.comms.identity') == null, 'a removed identity falls back to the primary');

  // Thumbnails: a hostile Content-Type never reaches the blob URL; the cache stays bounded.
  const typeOf = (u: string) => resolveObjectURL(u)?.type;
  const html = await comms.thumbnail('mxc://hs.test/evil');
  eq(typeOf(html), 'application/octet-stream', 'an html "thumbnail" becomes opaque bytes');
  thumbType = 'image/png';
  const first = await comms.thumbnail('mxc://hs.test/img0');
  eq(typeOf(first), 'image/png', 'a png thumbnail stays a png');
  for (let i = 1; i <= 200; i++) await comms.thumbnail('mxc://hs.test/img' + i);
  await settle();
  check(!resolveObjectURL(html) && !resolveObjectURL(first), 'the oldest media blobs are revoked past the cap');
  check(!!resolveObjectURL(await comms.thumbnail('mxc://hs.test/img200')), 'recent media stays');

  // Pins, as the desktop app: the three Structs-wide channels in their order, then the player's own.
  const room = (id: string, alias?: string) => { const r = newRoom(id, 'join'); if (alias) r.alias = alias; comms.chat.rooms.set(id, r); return r; };
  const [sn, help, infra] = ['sn-corp', 'help', 'infrastructure'].map((a, i) => room('!d' + i, `#${a}:matrix.beta.playstructs.com`));
  const fake = room('!fake', '#sn-corp-official:matrix.beta.playstructs.com');
  const lobby = room('!lobby', '#sn-corp-lobby:hs.test');
  const mine = room('!mine');
  eq([sn, help, infra].map((r) => comms.pinOrder(r)), [0, 1, 2], 'the three default channels are pinned in their order');
  check(!comms.isPinned(fake) && !comms.isPinned(lobby) && !comms.isPinned(mine), 'look-alikes, the guild lobby and other rooms are not pinned for you');
  comms.setPinned('!mine', true);
  eq(comms.pinOrder(mine), 3, 'a room you pin goes after the defaults');
  comms.setPinned('!d1', false);
  check(!comms.isPinned(help) && comms.pinOrder(infra) === 2, 'a default can be unpinned');
  const upgraded = room('!d1-new', '#help:matrix.beta.playstructs.com');
  check(!comms.isPinned(upgraded), 'an unpinned default stays out after its room is upgraded (kept by alias)');
  comms.setPinned('!d1', true);
  eq([comms.pinOrder(help), comms.pinOrder(upgraded)], [1, 1], 'pinned again, a default goes back to its own place');
  // Signing out on purpose stops the automatic sign-in for that account.
  const before = comms.session!.account;
  await comms.signOut();
  check(localStorage.getItem('structs.comms.optout.' + before) === 'true' && comms.autoSignIn() === false, 'after signing out, opening chat does not sign back in by itself');
  localStorage.setItem('structs.comms.session.' + primary.address, JSON.stringify(sess(primary.address, '@1-1:hs.test', 'tok-primary')));

  // forget(): every stored session logged out and erased, with the identity choice.
  localStorage.setItem('structs.comms.session.structs1other', JSON.stringify(sess('structs1other', '@1-9:hs.test', 'tok-other')));
  // A wallet sign-in's session: revoked at its auth service, never sent to /logout (which MAS homeservers lack).
  localStorage.setItem('structs.comms.session.structs1wallet', JSON.stringify({ ...sess('structs1wallet', '@1-7:hs.test', 'tok-wallet'), refresh_token: 'ref-wallet', client_id: 'CW', token_endpoint: 'https://auth.hs.test/oauth2/token', revocation_endpoint: 'https://auth.hs.test/oauth2/revoke' }));
  comms.setIdentity(0);
  calls.length = 0;
  await comms.forget();
  const outs = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/logout')).map((c) => c.auth).sort();
  eq(outs, ['Bearer tok-alt', 'Bearer tok-other', 'Bearer tok-primary'], 'forget logs out every stored session');
  const revoked = calls.filter((c) => c.method === 'POST' && c.url === 'https://auth.hs.test/oauth2/revoke').map((c) => new URLSearchParams(c.body).get('token')).sort();
  eq(revoked, ['ref-wallet', 'tok-wallet'], 'a wallet session is revoked at the auth service (refresh and access token)');
  const left: string[] = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.startsWith('structs.comms.')) left.push(k); }
  eq(left, [], 'forget leaves no comms keys');
  check(!comms.session && comms.state === 'signedOut', 'forget signs out');
}

if (failures) { console.error(`chat: ${failures} failure(s)`); process.exit(1); }
console.log('chat: ok');
