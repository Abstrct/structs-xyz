/* Intel · Raids: who is raiding whom, right now. Fleets away from home come off the chain
 * (public): each one parked at another commander's world is a raid in progress or a threat.
 * Members also get the indexer's raid table (status, ore seized). Raid news streams live. */
import { h } from '../../core/dom';
import { audio } from '../../core/audio';
import { store } from '../../chain/store';
import { formatInt } from '../../core/util';
import { grass } from '../../grass/grass';
import type { RaidRow } from '../../guild/api';
import { humanize } from '../../core/util';
import { listening, loading, playerLink, idLink, quiet, section, slot, tile, timeOf, waiting, type IntelCtx } from './common';
import { cardFeed } from './feedCard';

const names = { player: (id: string) => store.playerName(id), fleetOwner: (f: string) => store.fleets.get(f)?.owner };
const RAID_CATS = ['raid_status', 'block_raid_start', 'fleet_arrive', 'fleet_depart', 'shield_change', 'struct_attack'];

export function mountRaids(ctx: IntelCtx) {
  const tiles = h('div', { class: 'tiles' });
  const field = h('div', { class: 'raid-grid' }, loading('Reading fleets…'));
  const feed = h('div', { class: 'gfeed' });
  ctx.body.replaceChildren(
    tiles,
    section({ text: 'Raid board', hint: 'Raid board · members', icon: 'battle' }, slot(ctx, async () => {
      const [ongoing, initiated, vulnerable] = await Promise.all(['ongoing', 'initiated', 'shieldsVulnerable'].map((s) => ctx.api.raids(s, 1, 100).then((r) => r.data || [])));
      return [...vulnerable, ...ongoing, ...initiated];
    }, (rows) => raidTable(ctx, rows), { cta: 'The raid board (status, ore seized)' })),
    section({ text: 'Raiding now', hint: 'Fleets out raiding now', icon: 'ship' }, field),
    section({ text: 'Raid news', hint: 'Raid news · live', icon: 'news' }, feed));

  const paintField = () => {
    if (!ctx.alive()) return;
    const away = [...store.fleets.values()].filter((f) => f.status === 'away' && f.locationId);
    const atWorlds = away.filter((f) => f.locationId.startsWith('2-'));
    const targets = new Set(atWorlds.map((f) => f.locationId));
    tiles.replaceChildren(
      tile('Away', store.coreLoaded ? formatInt(away.length) : waiting(), 'fleets off their home world', away.length ? 'enemy' : '', 'ship'),
      tile('Threatened', store.coreLoaded ? formatInt(targets.size) : waiting(), 'worlds with a foreign fleet in orbit', targets.size ? 'enemy' : '', 'planet'),
      tile('Raid news', formatInt(grass.recent({ category: 'raid_status' }).length), 'heard live this session', '', 'news'));
    if (!store.coreLoaded) return;
    if (!atWorlds.length) { field.replaceChildren(quiet('Everyone is home', 'No fleets abroad. Every commander is home.')); return; }
    const byTarget = new Map<string, typeof atWorlds>();
    for (const f of atWorlds) { const l = byTarget.get(f.locationId) || []; l.push(f); byTarget.set(f.locationId, l); }
    const cards = [...byTarget].sort((a, b) => b[1].length - a[1].length).slice(0, 60).map(([planet, fleets]) => {
      const defender = store.homeOf.get(planet);
      return h('button', { class: 'raid-card', onclick: () => { audio.play('select'); ctx.navigate('/planet/' + planet); }, title: 'Open ' + planet },
        h('div', { class: 'spread' }, h('span', { class: 't-label c-enemy' }, fleets.length > 1 ? `${fleets.length} fleets` : 'Raid'), h('span', { class: 't-tiny c-hint' }, planet)),
        h('div', { class: 'raid-vs' },
          h('div', { class: 'col', style: 'gap:2px; min-width:0' }, ...fleets.slice(0, 3).map((f) => h('span', { class: 'c-enemy-hi rname' }, store.playerName(f.owner))), fleets.length > 3 ? h('span', { class: 't-tiny c-hint' }, `+${fleets.length - 3} more`) : null),
          h('span', { class: 'raid-arrow', 'aria-hidden': 'true' }, '»'),
          h('div', { class: 'col', style: 'gap:2px; min-width:0; text-align:right' }, h('span', { class: 'c-player-hi rname' }, defender ? store.playerName(defender) : 'Unclaimed world'), h('span', { class: 't-tiny c-hint' }, 'defending'))));
    });
    field.replaceChildren(...cards);
  };
  paintField();
  void store.loadCore().then(paintField).catch(() => { field.replaceChildren(h('div', { class: 't-tiny c-enemy', title: 'Couldn’t reach the game right now.' }, 'Galaxy not answering')); });
  ctx.cleanup.push(store.onChange((c) => { if (c.kind === 'fleet') schedule(); }));
  let t: ReturnType<typeof setTimeout> | null = null;
  function schedule() { if (!t) t = setTimeout(() => { t = null; paintField(); }, 800); }
  ctx.cleanup.push(() => { if (t) clearTimeout(t); });

  const add = cardFeed(ctx, feed, names, 60);
  const past = grass.recent({ category: RAID_CATS }, 60);
  for (let i = past.length - 1; i >= 0; i--) add(past[i], false);
  if (!feed.children.length) feed.appendChild(listening('Listening for raids, fleet jumps and shield changes…'));
  ctx.cleanup.push(grass.on({ category: RAID_CATS }, (e) => { add(e); if (e.category === 'raid_status') paintField(); }));
}

function raidTable(ctx: IntelCtx, rows: RaidRow[]): HTMLElement {
  if (!rows.length) return quiet('No raids', 'No raids open right now.');
  return h('div', { class: 'itable-wrap' }, h('table', { class: 'itable' },
    h('thead', null, h('tr', null, h('th', null, 'Target'), h('th', null, 'Raider'), h('th', null, 'Status'), h('th', null, 'Seized'), h('th', null, 'Updated'))),
    h('tbody', null, ...rows.map((r) => {
      const raider = r.fleet_owner || store.fleets.get(r.fleet_id)?.owner;
      const owner = r.planet_owner || store.homeOf.get(r.planet_id);
      return h('tr', { class: r.status === 'shieldsVulnerable' ? 'hot' : '' },
        h('td', null, idLink(ctx, r.planet_id, r.planet_id), owner ? h('span', { class: 't-tiny c-hint' }, ' ', store.playerName(owner)) : null),
        h('td', null, raider ? playerLink(ctx, raider) : r.fleet_id),
        h('td', { class: r.status === 'shieldsVulnerable' ? 'c-enemy' : 'c-warn' }, humanize(r.status)),
        h('td', { class: 'num' }, r.seized_ore != null ? formatInt(r.seized_ore) : '—'),
        h('td', { class: 't-tiny c-hint' }, timeOf(r.updated_at)));
    }))));
}
