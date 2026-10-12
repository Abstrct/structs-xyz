/* The secondary comms views: the channel directory (any guild's server), server-side
 * search, a commander finder for direct channels, and a room's member list. */
import { h, toast } from '../../core/dom';
import { audio } from '../../core/audio';
import { store } from '../../chain/store';
import { comms, DEFAULT_CHANNELS, DEFAULT_SERVER, type MatrixError } from '../../chat/matrix';
import { excerpt, hostOf, playerOfUser, stripReplyFallback, timeHM, dayLabel } from '../../chat/format';
import { knownGuilds } from '../../chat/guilds';
import { powerOf, roomLabel, type Room } from '../../chat/model';
import { face, nameplate, popMenu, presenceDot, renderBody, guildTagChip, type Nav } from './rich';

export interface ViewHost { nav: Nav; openRoom(id: string, eventId?: string): void; dm(userId: string): void; mention(userId: string): void; back(): void }

const head = (title: string, host: ViewHost, ...extra: (HTMLElement | null)[]) =>
  h('div', { class: 'cp-view-head' },
    h('button', { type: 'button', class: 'btn ghost icon cp-back', title: 'Back (Esc)', 'aria-label': 'Back', onclick: () => host.back() }, '‹'),
    h('span', { class: 't-label-lg' }, title), h('div', { class: 'grow' }), ...extra);

const errText = (e: unknown) => {
  const m = e as MatrixError;
  if (m.errcode === 'M_FORBIDDEN') return 'That server does not share its directory with yours.';
  return String(m.message || e);
};

/* ── Directory ───────────────────────────────────────────────────────────── */

export function directoryView(host: ViewHost): HTMLElement {
  const servers = new Map<string, string>();
  servers.set(comms.server, 'Your server');
  if (DEFAULT_SERVER !== comms.server) servers.set(DEFAULT_SERVER, 'SN Corp (Structs-wide)');
  for (const g of knownGuilds()) if (g.services?.matrix) { const host_ = hostOf(g.services.matrix); if (!servers.has(host_)) servers.set(host_, g.meta?.name || g.id); }
  const sel = h('select', { class: 'input', 'aria-label': 'Server' }, ...[...servers].map(([s, label]) => h('option', { value: s }, `${label} · ${s}`))) as HTMLSelectElement;
  const q = h('input', { class: 'input', placeholder: 'Search channels…', spellcheck: false, 'aria-label': 'Search channels' }) as HTMLInputElement;
  const alias = h('input', { class: 'input', placeholder: '#channel:server or !roomid', spellcheck: false, 'aria-label': 'Channel alias' }) as HTMLInputElement;
  const list = h('div', { class: 'cp-dir-list col' });
  let since: string | undefined;
  let seq = 0;

  const load = async (more = false) => {
    const my = ++seq;
    if (!more) { since = undefined; list.replaceChildren(h('div', { class: 'cp-loading' }, h('i', { class: 'cp-spin' }), h('span', { class: 't-label' }, 'Scanning the directory'))); }
    try {
      const res = await comms.publicRooms({ server: sel.value, term: q.value.trim() || undefined, since });
      if (my !== seq) return;
      since = res.next_batch;
      if (!more) list.replaceChildren();
      list.querySelector('.cp-more')?.remove();
      const chunk = Array.isArray(res.chunk) ? res.chunk : [];
      for (const c of chunk) list.appendChild(dirRow(c));
      if (!chunk.length && !more) list.appendChild(h('div', { class: 'cp-empty t-tiny c-hint' }, q.value ? 'No channel matches.' : 'This server lists no public channels. Try an alias below, or the Structs-wide ones.'));
      if (since) list.appendChild(h('button', { type: 'button', class: 'btn ghost mini cp-more', onclick: () => void load(true) }, 'More'));
    } catch (e) {
      if (my !== seq) return;
      const note = h('div', { class: 'cp-empty t-tiny c-warn' }, errText(e));
      if (more) { list.querySelector('.cp-more')?.remove(); list.appendChild(note); } else list.replaceChildren(note);
    }
    if (!more) for (const a of DEFAULT_CHANNELS) if (!comms.roomByAlias(a) && sel.value === DEFAULT_SERVER) list.prepend(defaultRow(a));
  };

  const dirRow = (c: { room_id: string; name?: string; topic?: string; canonical_alias?: string; num_joined_members: number }) => {
    const joined = comms.room(c.room_id)?.membership === 'join';
    const btn = h('button', { type: 'button', class: 'btn mini' + (joined ? ' ghost' : ''), onclick: async () => {
      if (joined) { host.openRoom(c.room_id); return; }
      btn.disabled = true;
      try { const id = await comms.join(c.canonical_alias || c.room_id, [sel.value]); audio.play('confirm'); host.openRoom(id); } catch (e) { toast('Could not join: ' + errText(e), 'warn'); btn.disabled = false; }
    } }, joined ? 'Open' : 'Join') as HTMLButtonElement;
    return h('div', { class: 'cp-dir-row' },
      h('span', { class: 'cp-glyph' }, '#'),
      h('div', { class: 'grow col', style: 'gap:2px' },
        h('div', { class: 'cp-dir-name' }, c.name || c.canonical_alias || c.room_id),
        c.canonical_alias ? h('div', { class: 't-tiny c-hint' }, c.canonical_alias) : null,
        c.topic ? h('div', { class: 't-tiny cp-dir-topic' }, excerpt(c.topic, 160)) : null),
      h('span', { class: 'chip' }, `${c.num_joined_members} ◉`), btn);
  };
  const defaultRow = (a: string) => h('div', { class: 'cp-dir-row pinned' },
    h('span', { class: 'cp-glyph' }, '★'), h('div', { class: 'grow' }, h('div', { class: 'cp-dir-name' }, a.split(':')[0]), h('div', { class: 't-tiny c-hint' }, 'Structs-wide channel')),
    h('button', { type: 'button', class: 'btn mini', onclick: async () => { try { host.openRoom(await comms.join(a)); } catch (e) { toast('Could not join: ' + errText(e), 'warn'); } } }, 'Join'));

  let t = 0;
  q.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(() => void load(), 350); });
  sel.addEventListener('change', () => void load());
  const joinAlias = async () => {
    let v = alias.value.trim();
    if (!v) return;
    if (!/^[#!]/.test(v)) v = '#' + v;
    if (v.startsWith('#') && !v.includes(':')) v += ':' + sel.value;
    try { const id = await comms.join(v); audio.play('confirm'); alias.value = ''; host.openRoom(id); } catch (e) { toast('Could not join ' + v + ': ' + errText(e), 'warn'); }
  };
  alias.addEventListener('keydown', (e) => { if (e.key === 'Enter') void joinAlias(); });
  void load();
  return h('div', { class: 'cp-view' },
    head('Channel directory', host),
    h('div', { class: 'cp-view-body col' },
      h('div', { class: 'row' }, sel), q,
      list,
      h('div', { class: 'cp-dir-alias' }, h('div', { class: 't-label c-hint' }, 'Join by alias'), h('div', { class: 'row' }, alias, h('button', { type: 'button', class: 'btn', onclick: () => void joinAlias() }, 'Join')))));
}

/* ── Search ──────────────────────────────────────────────────────────────── */

export function searchView(host: ViewHost, room: Room | null): HTMLElement {
  const q = h('input', { class: 'input', placeholder: 'Search transmissions…  (Enter)', spellcheck: false, 'aria-label': 'Search messages' }) as HTMLInputElement;
  let scopeRoom = !!room;
  const scope = h('button', { type: 'button', class: 'btn ghost mini', onclick: () => { scopeRoom = !scopeRoom && !!room; paintScope(); if (q.value.trim()) void run(); } }) as HTMLButtonElement;
  const paintScope = () => { scope.textContent = scopeRoom && room ? 'In: ' + roomLabel(room, comms.me, (u) => comms.nameOf(u, room)) : 'In: all channels'; scope.disabled = !room; };
  paintScope();
  const out = h('div', { class: 'cp-search-list col' }, h('div', { class: 'cp-empty t-tiny c-hint' }, 'Searches the server’s copy of every channel you are in.'));
  let next: string | undefined;
  const run = async (more = false) => {
    const term = q.value.trim();
    if (!term) return;
    if (!more) out.replaceChildren(h('div', { class: 'cp-loading' }, h('i', { class: 'cp-spin' }), h('span', { class: 't-label' }, 'Searching')));
    try {
      const res = await comms.search(term, scopeRoom && room ? room.id : undefined, more ? next : undefined);
      next = res.next;
      if (!more) out.replaceChildren(h('div', { class: 't-tiny c-hint' }, `${res.count} result${res.count === 1 ? '' : 's'}`));
      out.querySelector('.cp-more')?.remove();
      for (const ev of res.results) {
        const r = comms.room(ev.room_id ?? '');
        const body = stripReplyFallback(String(ev.content?.body ?? ''));
        out.appendChild(h('button', { type: 'button', class: 'cp-hit', onclick: () => host.openRoom(ev.room_id!, ev.event_id) },
          face(ev.sender ?? '', 'cp-face sm'),
          h('div', { class: 'grow col', style: 'gap:2px; min-width:0' },
            h('div', { class: 'row', style: 'gap:6px' }, nameplate(ev.sender ?? '', r, host.nav), h('span', { class: 't-tiny c-hint' }, `${r ? roomLabel(r, comms.me, (u) => comms.nameOf(u, r)) : ev.room_id} · ${dayLabel(ev.origin_server_ts ?? 0)} ${timeHM(ev.origin_server_ts ?? 0)}`)),
            h('div', { class: 'cp-hit-body' }, ...renderBody(excerpt(body, 240), [], host.nav)))));
      }
      if (next) out.appendChild(h('button', { type: 'button', class: 'btn ghost mini cp-more', onclick: () => void run(true) }, 'More'));
    } catch (e) {
      out.replaceChildren(h('div', { class: 'cp-empty t-tiny c-warn' }, 'Search failed: ' + errText(e)));
    }
  };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') void run(); if (e.key === 'Escape') host.back(); });
  setTimeout(() => q.focus(), 30);
  return h('div', { class: 'cp-view' }, head('Search', host, scope), h('div', { class: 'cp-view-body col' }, q, out));
}

/* ── People: start a direct channel ──────────────────────────────────────── */

export function peopleView(host: ViewHost): HTMLElement {
  const q = h('input', { class: 'input', placeholder: 'Commander name, 1-… id, or @user:server', spellcheck: false, autocomplete: 'off', 'aria-label': 'Find a commander' }) as HTMLInputElement;
  const out = h('div', { class: 'cp-people col' });
  const paint = () => {
    const s = q.value.trim().toLowerCase();
    const rows: HTMLElement[] = [];
    if (/^@[^:\s]+:[^\s]+$/.test(q.value.trim())) {
      const uid = q.value.trim();
      rows.push(h('div', { class: 'cp-person' }, face(uid, 'cp-face sm'), h('div', { class: 'grow' }, uid), h('button', { type: 'button', class: 'btn mini', onclick: () => host.dm(uid) }, 'Message')));
    }
    const mine = comms.myPlayerId;
    const matches = [...store.players.values()].filter((p) => p.id !== mine && (!s ? false : (p.name || '').toLowerCase().includes(s) || p.id === s || p.id === '1-' + s));
    matches.sort((a, b) => Number(!(a.name || '').toLowerCase().startsWith(s)) - Number(!(b.name || '').toLowerCase().startsWith(s)) || (a.name || '').localeCompare(b.name || ''));
    for (const p of matches.slice(0, 60)) {
      const uid = comms.userIdForPlayer(p.id);
      rows.push(h('div', { class: 'cp-person' },
        face('@' + p.id + ':x', 'cp-face sm'),
        h('div', { class: 'grow col', style: 'gap:1px; min-width:0' },
          h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'cp-person-name' }, p.name || p.id), uid ? guildTagChip(uid) : null),
          h('div', { class: 't-tiny c-hint' }, `${p.id} · ${store.guildName(p.guildId)}${uid ? '' : ' · no chat server'}`)),
        h('button', { type: 'button', class: 'btn ghost mini', onclick: () => host.nav('/player/' + p.id) }, 'View'),
        h('button', { type: 'button', class: 'btn mini', disabled: !uid, title: uid ?? 'Their guild runs no chat server', onclick: () => uid && host.dm(uid) }, 'Message')));
    }
    if (!rows.length) {
      // Nothing typed: the direct channels you already have.
      const dms = [...comms.chat.rooms.values()].filter((r) => r.isDirect && r.membership === 'join').sort((a, b) => b.lastTs - a.lastTs).slice(0, 20);
      rows.push(h('div', { class: 't-tiny c-hint' }, s ? 'No commander matches.' : store.coreLoaded ? 'Type a name or id to find any commander in the galaxy.' : 'Reading the galaxy roster…'));
      for (const r of dms) rows.push(h('button', { type: 'button', class: 'cp-person', onclick: () => host.openRoom(r.id) }, face([...r.members.keys()].find((u) => u !== comms.me) ?? '', 'cp-face sm'), h('div', { class: 'grow' }, roomLabel(r, comms.me, (u) => comms.nameOf(u, r))), h('span', { class: 't-tiny c-hint' }, 'open')));
    }
    out.replaceChildren(...rows);
  };
  q.addEventListener('input', paint);
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') host.back(); });
  paint();
  setTimeout(() => q.focus(), 30);
  return h('div', { class: 'cp-view' }, head('New direct channel', host), h('div', { class: 'cp-view-body col' }, q, out));
}

/* ── Members ─────────────────────────────────────────────────────────────── */

export function membersView(host: ViewHost, r: Room, opts: { embedded?: boolean } = {}): HTMLElement {
  const members = [...r.members.values()].filter((m) => m.membership === 'join' || m.membership === 'invite');
  const rank = (u: string) => powerOf(r, u);
  const live = (u: string) => { const p = comms.chat.presence.get(u); return p?.currentlyActive || p?.presence === 'online' ? 0 : p?.presence === 'unavailable' ? 1 : 2; };
  members.sort((a, b) => rank(b.userId) - rank(a.userId) || live(a.userId) - live(b.userId) || comms.nameOf(a.userId, r).localeCompare(comms.nameOf(b.userId, r)));
  const list = h('div', { class: 'cp-members col' }, ...members.map((m) => {
    const p = rank(m.userId);
    const pid = playerOfUser(m.userId);
    return h('button', {
      type: 'button', class: 'cp-member' + (m.membership === 'invite' ? ' invited' : ''), title: m.userId,
      onclick: (e: MouseEvent) => popMenu(e.clientX, e.clientY, [
        ...(pid ? [{ label: 'View commander', run: () => host.nav('/player/' + pid) }] : []),
        ...(m.userId !== comms.me ? [{ label: 'Direct message', run: () => host.dm(m.userId) }, { label: 'Mention', run: () => host.mention(m.userId) }] : []),
      ], h('div', { class: 'cp-menu-head t-tiny c-hint' }, m.userId)),
    }, h('span', { class: 'cp-glyph-face' }, face(m.userId, 'cp-face sm'), presenceDot(m.userId)),
    h('span', { class: 'grow col', style: 'gap:1px; min-width:0; align-items:flex-start' }, nameplate(m.userId, r, host.nav), m.membership === 'invite' ? h('span', { class: 't-tiny c-hint' }, 'invited') : null),
    p >= 100 ? h('span', { class: 'chip neutral' }, 'Admin') : p >= 50 ? h('span', { class: 'chip player' }, 'Mod') : null);
  }));
  const count = r.joinedCount ?? members.filter((m) => m.membership === 'join').length;
  return h('div', { class: 'cp-view' + (opts.embedded ? ' embedded' : '') },
    head(`Members · ${count}`, host, h('button', { type: 'button', class: 'btn ghost mini', title: 'Reload the full list', onclick: () => void comms.loadMembers(r.id).catch((e) => toast(String(e.message), 'warn')) }, '↻')),
    h('div', { class: 'cp-view-body' }, list));
}
