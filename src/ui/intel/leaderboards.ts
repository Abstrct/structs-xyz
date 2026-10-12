/* Intel · Leaderboards. The indexer's boards (players by Alpha, guilds by bank and power,
 * reactors, substations, energy providers) for members of the reading guild; and, for
 * everyone, live boards: guilds by commanders (chain), and who and where is busiest right
 * now, counted off GRASS since this tab opened. */
import { h } from '../../core/dom';
import { audio } from '../../core/audio';
import { store } from '../../chain/store';
import { formatAlpha, formatInt, formatPower } from '../../core/util';
import { grass, type GrassEvent } from '../../grass/grass';
import { groupOf } from '../../grass/describe';
import { guildLabel } from '../../guild/directory';
import type { LeaderboardKind, LeaderRows } from '../../guild/api';
import { section, slot, type IntelCtx } from './common';
import { barList, SERIES } from './chart';
import { keepFocus } from '../keepFocus';
import { icon } from '../icons';

const BOARDS: { kind: LeaderboardKind; label: string }[] = [
  { kind: 'player', label: 'Commanders' }, { kind: 'guild', label: 'Guilds' }, { kind: 'reactor', label: 'Reactors' },
  { kind: 'substation', label: 'Substations' }, { kind: 'provider', label: 'Providers' },
];

export function mountLeaderboards(ctx: IntelCtx) {
  const kind = (BOARDS.find((b) => b.kind === ctx.arg)?.kind || 'player') as LeaderboardKind;
  const pick = (href: string) => { audio.play('select'); ctx.navigate(href); };
  const tabs = h('div', { class: 'subtabs' }, ...BOARDS.map((b) => h('button', { class: 'btn mini' + (b.kind === kind ? ' active' : ''), onclick: () => ctx.navigate('/intel/leaderboards/' + b.kind) }, b.label)));

  const board = slot(ctx, () => ctx.api.leaderboard(kind, { limit: 50 }), (rows) => paintBoard(kind, rows as LeaderRows[typeof kind][], pick), { cta: 'The galaxy leaderboards' });
  const liveGrid = h('div', { class: 'lb-live' });
  ctx.body.replaceChildren(
    section({ text: 'Boards', hint: 'Member boards: the guild indexer’s rankings, for members', icon: 'record' }, tabs, board),
    section({ text: 'Live', hint: 'Live boards: for everyone, counted live while you watch.', icon: 'news' }, h('div', { class: 't-tiny c-hint x-only' }, 'Public: guild sizes from the chain, activity counted off GRASS while you watch.'), liveGrid));

  // The live boards re-count every few seconds; they hold still while pressed or pointed at (a
  // row replaced under the pointer would swallow the click), and a keyboard or pad cursor stays
  // on the same row through a repaint.
  let pressing = false;
  liveGrid.addEventListener('pointerdown', () => { pressing = true; });
  const up = () => { pressing = false; };
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  ctx.cleanup.push(() => { window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); });
  const hover = matchMedia('(hover: hover)');
  const paintLive = (force = false) => {
    if (!ctx.alive()) return;
    if (!force && (pressing || (hover.matches && liveGrid.matches(':hover')))) return;
    const byGuild = new Map<string, number>();
    for (const p of store.players.values()) if (p.guildId) byGuild.set(p.guildId, (byGuild.get(p.guildId) || 0) + 1);
    const active = new Map<string, number>(), hot = new Map<string, number>(), mined = new Map<string, number>(), combat = new Map<string, number>();
    for (const e of grass.recent()) tallyEvent(e, active, hot, mined, combat);
    const top = (m: Map<string, number>, n = 8) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
    // Each live board: an icon and one word; its full name is the hover (and Expert mode).
    const card = (ico: string, word: string, title: string, sub: string, body: HTMLElement) => h('div', { class: 'lb-card panel' },
      h('div', { class: 'panel-head', title: `${title} · ${sub}` }, h('span', { class: 'isec-ico', html: icon(ico, 16) }), h('span', { class: 't-label' }, word), h('span', { class: 't-tiny c-hint x-only' }, `${title} · ${sub}`)), h('div', { class: 'panel-body' }, body));
    const empty = (t: string, words = t) => h('div', { class: 't-tiny c-hint', title: t }, words);
    keepFocus(liveGrid, () => liveGrid.replaceChildren(
      card('team', 'Biggest', 'Guilds by size', 'players', byGuild.size ? barList(top(byGuild).map(([id, v]) => ({ label: guildLabel(id).name, value: v, href: '/intel/guild/' + id })), { onPick: pick }) : empty('Reading the roster…', 'Reading…')),
      card('health', 'Active', 'Most active', 'while you watch', active.size ? barList(top(active).map(([id, v]) => ({ label: store.playerName(id), value: v, href: '/player/' + id, color: SERIES[2] })), { onPick: pick }) : empty('Counting…')),
      card('battle', 'Fights', 'Hottest worlds', 'combat + raids', combat.size ? barList(top(combat).map(([id, v]) => ({ label: id, sub: store.homeOf.get(id) ? store.playerName(store.homeOf.get(id)!) : '', value: v, href: '/planet/' + id, color: SERIES[3] })), { onPick: pick }) : empty('No fighting heard yet. Quiet skies.', 'Quiet skies')),
      card('planet', 'Busiest', 'Busiest worlds', 'all planet activity', hot.size ? barList(top(hot).map(([id, v]) => ({ label: id, sub: store.homeOf.get(id) ? store.playerName(store.homeOf.get(id)!) : '', value: v, href: '/planet/' + id, color: SERIES[0] })), { onPick: pick }) : empty('Counting…')),
      card('ore', 'Miners', 'Top miners', 'ore mined · this session', mined.size ? barList(top(mined).map(([id, v]) => ({ label: store.playerName(id), value: v, href: '/player/' + id, color: SERIES[1] })), { onPick: pick, format: (v) => formatInt(v) + ' ore' }) : empty('No ore mined yet this session.', 'None yet')),
    ));
  };
  paintLive(true);
  void store.loadCore().then(() => paintLive(true)).catch(() => { /* live boards still work */ });
  const timer = setInterval(() => paintLive(), 4000);
  ctx.cleanup.push(() => clearInterval(timer));
}

function tallyEvent(e: GrassEvent, active: Map<string, number>, hot: Map<string, number>, mined: Map<string, number>, combat: Map<string, number>) {
  const inc = (m: Map<string, number>, k: string | undefined, by = 1) => { if (k) m.set(k, (m.get(k) || 0) + by); };
  if (e.category === 'lastAction') inc(active, e.playerId);
  if (e.kind === 'planet') inc(hot, e.planetId);
  if (groupOf(e) === 'combat') inc(combat, e.planetId);
  if (e.kind === 'inventory' && e.category === 'mined' && e.data.denom === 'ore') inc(mined, e.playerId, Number(e.data.amount_p ?? e.data.amount) || 1);
}

function paintBoard(kind: LeaderboardKind, rows: LeaderRows[LeaderboardKind][], pick: (href: string) => void): HTMLElement {
  if (!rows.length) return h('div', { class: 't-tiny c-hint', title: 'The board is empty.' }, 'Empty');
  const num = (v: unknown) => Number(v ?? 0) || 0;
  switch (kind) {
    case 'player': return barList((rows as LeaderRows['player'][]).map((r) => ({ label: r.username || store.playerName(r.player_id), sub: guildLabel(r.guild_id).tag, value: num(r.alpha_value_p ?? r.alpha_balance_p), href: '/player/' + r.player_id })), { onPick: pick, format: (v) => formatAlpha(v) });
    case 'guild': return barList((rows as LeaderRows['guild'][]).map((r) => ({ label: r.name || r.onchain_name || guildLabel(r.guild_id).name, sub: `${formatInt(r.player_count)} cmdrs`, value: num(r.collateral_p), href: '/intel/guild/' + r.guild_id, color: SERIES[1] })), { onPick: pick, format: (v) => formatAlpha(v) });
    case 'reactor': return barList((rows as LeaderRows['reactor'][]).map((r) => ({ label: r.reactor_id, sub: formatAlpha(r.fuel_p) + ' fuel', value: num(r.power_p), color: SERIES[0] })), { format: (v) => formatPower(v) });
    case 'substation': return barList((rows as LeaderRows['substation'][]).map((r) => ({ label: r.substation_id, sub: `${formatInt(r.player_count)} connected`, value: num(r.member_capacity_p), color: SERIES[2] })), { format: (v) => formatPower(v) });
    case 'provider': return barList((rows as LeaderRows['provider'][]).map((r) => ({ label: r.provider_id, sub: `${r.rate_amount_p} ${r.rate_denom}`, value: num(r.agreement_count), color: SERIES[4] })), { format: (v) => formatInt(v) + ' deals' });
  }
}
