/* Intel · Guilds: every guild on chain as a card (logo, tag, creed, members, reactor power,
 * the services it runs), and a guild's dossier: profile, power, roster, bank, live activity.
 * Members and power come from the LCD (public); the Guild API adds alpha holdings, bank
 * and power stats for members of the reading guild. */
import { h, portrait } from '../../core/dom';
import { audio } from '../../core/audio';
import { store } from '../../chain/store';
import { lcd, type Grid } from '../../chain/lcd';
import { cached } from '../../cache/idb';
import { formatAlpha, formatInt, formatPower } from '../../core/util';
import { guilds, guildLabel, safeUrl, type GuildEntry } from '../../guild/directory';
import { guildApi, type GuildRow, type RosterRow } from '../../guild/api';
import { grass, type GrassEvent } from '../../grass/grass';
import { errorBox, guildLogo, listening, loading, playerLink, section, slot, tile, waiting, type IntelCtx } from './common';
import { cardFeed } from './feedCard';
import { sparkline } from './chart';
import { icon } from '../icons';

/** A reactor's grid (fuel = alpha infused, capacity = power it makes), cached for 2 minutes. */
function reactorGrid(id: string): Promise<Grid | null> {
  if (!id) return Promise.resolve(null);
  return cached(`reactor:${id}`, 120_000, () => lcd.entity<{ gridAttributes?: Grid }>('reactor', id).then((r) => r.gridAttributes || {}), { ns: 'lcd', staleWhileRevalidate: true });
}

const names = { player: (id: string) => store.playerName(id), fleetOwner: (f: string) => store.fleets.get(f)?.owner };

export function mountGuilds(ctx: IntelCtx) {
  if (ctx.arg) return mountGuild(ctx, ctx.arg);
  const grid = h('div', { class: 'gcards', title: 'Pick a guild to see its members, power and bank.' }, loading('Reading the guild registry…'));
  const glance = h('div', { class: 'tiles glance' });
  ctx.body.replaceChildren(
    h('div', { class: 'intro t-tiny c-hint x-only' }, 'Pick a guild to see its members, power and bank. (Profiles come from each guild’s guild.json.)'),
    glance, grid);

  const paintGlance = () => {
    const away = [...store.fleets.values()].filter((f) => f.status === 'away').length;
    const perMin = grass.perMinute(undefined, 5);
    glance.replaceChildren(
      tile('Guilds', formatInt(store.guilds.size || 0), undefined, '', 'flag'),
      tile('Commanders', store.coreLoaded ? formatInt(store.players.size) : waiting(), undefined, '', 'team'),
      tile('Raiding', store.coreLoaded ? formatInt(away) : waiting(), 'fleets out raiding, away from home', away ? 'enemy' : '', 'ship'),
      Object.assign(tile('Block', grass.height ? formatInt(grass.height) : waiting(), 'from GRASS'), { className: 'itile x-only' }),
      Object.assign(tile('Signal', formatInt(perMin[perMin.length - 1] || 0) + '/min', sparkline(grass.perMinute(undefined, 20), undefined, 110, 20)), { className: 'itile x-only' }),
    );
  };
  paintGlance();
  ctx.cleanup.push(store.onCore(paintGlance), grass.onBlock(paintGlance));

  const paint = (list: GuildEntry[]) => {
    if (!ctx.alive()) return;
    // Guilds that publish a profile first, then by members.
    const sorted = [...list].sort((a, b) => (b.meta?.name ? 1 : 0) - (a.meta?.name ? 1 : 0) || store.members(b.id) - store.members(a.id));
    grid.replaceChildren(...sorted.map((g) => card(ctx, g)));
  };
  guilds().then(paint, (e) => grid.replaceChildren(errorBox(e)));
  void store.loadCore().then(() => { paintGlance(); guilds().then(paint).catch(() => { /* painted the error already */ }); }).catch(() => { /* LCD down: cards still show */ });
}

function card(ctx: IntelCtx, g: GuildEntry): HTMLElement {
  const m = g.meta;
  const label = guildLabel(g.id);
  const members = store.members(g.id);
  const power = h('span', { class: 'num' }, waiting('Reading its reactor…'));
  const fuel = h('span', { class: 'num' }, waiting('Reading its reactor…'));
  reactorGrid(g.chain?.primaryReactorId).then((gr) => { power.textContent = gr ? formatPower(gr.capacity) : '—'; fuel.textContent = gr ? formatAlpha(gr.fuel) : '—'; }, () => { power.textContent = '—'; fuel.textContent = '—'; });
  const svc = g.services;
  const open = () => { audio.play('select'); ctx.navigate('/intel/guild/' + g.id); };
  // A guild card: logo, name and tag, then three numbers with pictures. Its motto is the hover
  // (and the dossier's opening line).
  const desc = m?.description || (g.error ? 'This guild publishes no profile.' : '');
  const el = h('button', { class: 'gcard' + (g.id === ctx.guildId ? ' reading' : ''), style: `--gc:#${store.guildColor(g.id).toString(16).padStart(6, '0')}`, onclick: open, title: `Open ${label.name}${desc ? '\n' + desc : ''}` },
    h('div', { class: 'gcard-top' },
      guildLogo(g.id, m, 'md'),
      h('div', { class: 'col grow', style: 'gap:3px; min-width:0' },
        h('div', { class: 'gcard-name' }, m?.name || label.name),
        // The tag is the logo's monogram (and Expert mode's chip); the name says it in full.
        h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'chip neutral x-only' }, m?.tag || label.tag), h('span', { class: 't-tiny c-hint x-only' }, g.id),
          g.id === ctx.guildId ? h('span', { class: 'chip player', title: 'News & Rankings reads this guild’s live feed' }, h('span', { html: icon('news', 12) })) : null))),
    h('div', { class: 'gcard-desc t-tiny x-only' }, desc),
    h('div', { class: 'gcard-stats' },
      h('div', { title: 'Members' }, h('div', { class: 'dct-num-ico', html: icon('team', 16) }), h('div', { class: 'num' }, store.coreLoaded ? formatInt(members) : waiting())),
      h('div', { title: 'Reactor power' }, h('div', { class: 'dct-num-ico k-power', html: icon('power', 16) }), power),
      h('div', { title: 'Alpha infused' }, h('div', { class: 'dct-num-ico k-fuel', html: icon('fuel', 16) }), fuel)),
    // What the guild offers: in plain words a takes-new-players / chat pair; expert mode names the services.
    h('div', { class: 'gcard-svc' },
      h('span', { class: 'chip s-only dct-svc ' + (svc?.guild_api ? 'player' : ''), title: svc?.guild_api ? 'Open to join: new players can enlist with this guild here' : 'Not taking players here' }, h('span', { html: icon(svc?.guild_api ? 'check' : 'lock', 12) }), svc?.guild_api ? 'Join' : 'Closed'),
      h('span', { class: 'chip s-only dct-svc ' + (svc?.matrix ? 'player' : 'off'), title: svc?.matrix ? 'Has chat' : 'No chat', 'aria-label': svc?.matrix ? 'Has chat' : 'No chat' }, h('span', { html: icon('chat', 12) })),
      h('span', { class: 'chip x-only ' + (svc?.guild_api ? 'player' : ''), title: 'Guild API (indexer)' }, svc?.guild_api ? 'API' : 'No API'),
      h('span', { class: 'chip x-only ' + (svc?.grass ? 'player' : ''), title: 'GRASS live feed' }, svc?.grass ? 'GRASS' : 'No GRASS'),
      h('span', { class: 'chip x-only ' + (svc?.matrix ? 'player' : ''), title: 'Matrix chat' }, svc?.matrix ? 'Comms' : 'No comms')));
  return el;
}

/* ── The dossier ────────────────────────────────────────────────────────── */

function mountGuild(ctx: IntelCtx, id: string) {
  const head = h('div', { class: 'gdossier-head' }, loading());
  const live = h('div', { class: 'gfeed' });
  const roster = h('div', { class: 'groster' }, loading('Reading the roster…'));
  const power = h('div', { class: 'tiles' }, loading());
  ctx.body.replaceChildren(
    h('button', { class: 'btn ghost mini back', onclick: () => ctx.navigate('/intel/guilds') }, '‹ All guilds'),
    head,
    section('Power', power),
    section('Bank', slot(ctx, () => ctx.api.bank(), (rows) => {
      const mine = rows.filter((r) => r.guild_id === id);
      if (!mine.length) return h('div', { class: 't-tiny c-hint' }, 'This guild has minted no token yet.');
      return h('div', { class: 'tiles' }, ...mine.flatMap((r) => [tile('Collateral', formatAlpha(r.collateral), 'Alpha backing ' + r.denom), tile('Supply', formatInt(Number(r.supply) / 1e6), r.denom.replace(/^uguild\./, '') + ' tokens'), tile('Ratio', String(Number(r.ratio).toFixed(4)), 'alpha per token')]));
    }, { cta: 'The guild bank' })),
    section('Roster', roster),
    section('Live from members', live));

  void (async () => {
    const list = await guilds().catch(() => [] as GuildEntry[]);
    await store.loadCore().catch(() => { /* LCD down: fewer facts */ });
    if (!ctx.alive()) return;
    const g = list.find((x) => x.id === id);
    const chain = g?.chain || store.guilds.get(id);
    if (!g && !chain) { head.replaceChildren(errorBox(new Error(`No guild ${id} on chain`))); return; }
    const m = g?.meta;
    const label = guildLabel(id);
    // A guild's own API describes itself publicly (socials, commission, validator): use it when it has one.
    const own: GuildRow | null = g?.services?.guild_api ? await guildApi(id).thisGuild().catch(() => null) : null;
    if (!ctx.alive()) return;
    let socials: Record<string, string> = { ...(m?.socials || {}) };
    if (own?.socials) { try { socials = { ...socials, ...JSON.parse(own.socials) }; } catch { /* keep guild.json's */ } }
    const links = Object.entries({ website: m?.website || own?.website || '', ...socials })
      .map(([k, v]) => [k, safeUrl(String(v || ''))] as const).filter(([, v]) => v);
    head.replaceChildren(
      guildLogo(id, m || null, 'xl'),
      h('div', { class: 'col grow', style: 'gap:6px; min-width:0' },
        h('div', { class: 'row wrap', style: 'gap:8px' }, h('span', { class: 't-display gd-name' }, m?.name || label.name), h('span', { class: 'chip neutral' }, m?.tag || label.tag), h('span', { class: 't-tiny c-hint' }, id)),
        m?.description ? h('div', { class: 't-body gdesc' }, m.description) : null,
        h('div', { class: 'kv gkv' },
          h('span', null, 'Leader'), chain?.owner ? playerLink(ctx, chain.owner) : h('span', null, '—'),
          h('span', null, 'Members'), h('span', { class: 'num' }, formatInt(store.members(id))),
          h('span', { class: 'x-only' }, 'Primary reactor'), h('span', { class: 'x-only' }, chain?.primaryReactorId || '—'),
          h('span', { class: 'x-only' }, 'Entry substation'), h('span', { class: 'x-only' }, chain?.entrySubstationId || '—'),
          h('span', null, 'Alpha to join'), h('span', null, chain ? formatAlpha(chain.joinInfusionMinimum) : '—'),
          h('span', null, 'Join by asking'), h('span', null, (chain as { joinInfusionMinimumBypassByRequest?: string })?.joinInfusionMinimumBypassByRequest || '—'),
          own ? h('span', { class: 'x-only' }, 'Commission') : null, own ? h('span', { class: 'x-only' }, (Number(own.default_commission) * 100).toFixed(1) + '%') : null),
        links.length ? h('div', { class: 'row wrap glinks' }, ...links.map(([k, v]) => h('a', { class: 'chip', href: v, target: '_blank', rel: 'noopener noreferrer' }, k.replace(/_/g, ' ')))) : null,
        h('div', { class: 'row wrap', style: 'gap:6px' },
          g?.services?.grass && grass.guildId !== id ? h('button', { class: 'btn mini', onclick: async () => { await grass.switchGuild(id); ctx.refresh(); } }, 'Read intel from this guild') : null,
          grass.guildId === id ? h('span', { class: 'chip player', title: 'News & Rankings reads this guild’s live feed' }, 'News source') : null)));

    // Power: the primary reactor from the LCD; the Guild API's member totals when signed in.
    const gr = await reactorGrid(chain?.primaryReactorId || '').catch(() => null);
    if (!ctx.alive()) return;
    const base = [tile('Reactor output', gr ? formatPower(gr.capacity) : '—', chain?.primaryReactorId), tile('Alpha infused', gr ? formatAlpha(gr.fuel) : '—', 'fuel in the reactor'), tile('Reactor load', gr ? formatPower(gr.load) : '—')];
    power.replaceChildren(...base);
    ctx.api.powerStats(id).then((p) => {
      if (!ctx.alive()) return;
      power.replaceChildren(...base, tile('Member capacity', formatPower(p.total_capacity_p ?? p.total_capacity)), tile('Member load', formatPower(p.total_load_p ?? p.total_load)), tile('Avg connection', formatPower(p.avg_connection_capacity_p ?? p.avg_connection_capacity)));
    }, () => { /* public view is enough */ });

    paintRoster(ctx, id, roster);
  })();

  // Live: GRASS events about this guild's members.
  const addLive = cardFeed(ctx, live, names, 40);
  const paintLive = (e: GrassEvent) => {
    if (!e.playerId || store.players.get(e.playerId)?.guildId !== id) return;
    if (e.category === 'lastAction') return;   // too chatty to be news
    addLive(e);
  };
  for (const e of grass.recent(undefined, 600)) paintLive(e);
  if (!live.children.length) live.appendChild(listening('Listening for this guild’s members on GRASS…'));
  ctx.cleanup.push(grass.on(undefined, (e) => { live.querySelector('.empty-live')?.remove(); paintLive(e); }));
}

function paintRoster(ctx: IntelCtx, id: string, el: HTMLElement) {
  const fromChain = () => [...store.players.values()].filter((p) => p.guildId === id)
    .map((p) => ({ id: p.id, name: p.name || p.id, pfp: p.pfpClientRenderAttributes, alpha: null as string | null }));
  const paint = (rows: { id: string; name: string; pfp: string; alpha: string | null }[], source: string) => {
    if (!ctx.alive()) return;
    if (!rows.length) { el.replaceChildren(h('div', { class: 't-tiny c-hint' }, 'No members.')); return; }
    const sorted = rows.sort((a, b) => (b.alpha != null && a.alpha != null ? Number(b.alpha) - Number(a.alpha) : 0) || a.name.localeCompare(b.name));
    const shown = sorted.slice(0, 240);
    el.replaceChildren(
      h('div', { class: 't-tiny c-hint' }, `${formatInt(rows.length)} members · ${source}${rows.length > shown.length ? ` · showing ${shown.length}` : ''}`),
      h('div', { class: 'roster-grid' }, ...shown.map((r) => h('button', { class: 'rmember', onclick: () => { audio.play('select'); ctx.navigate('/player/' + r.id); }, title: r.id },
        portrait(store.players.get(r.id)?.pfpClientRenderAttributes || r.pfp, 'sm', r.id),
        h('div', { class: 'col', style: 'gap:1px; min-width:0' }, h('span', { class: 'rname' }, r.name), h('span', { class: 't-tiny c-hint' }, r.alpha != null ? formatAlpha(r.alpha) : r.id))))));
  };
  paint(fromChain(), 'from the chain');
  ctx.api.roster(id, (rows) => paint(fromApi(rows), 'from the guild indexer')).then((rows) => paint(fromApi(rows), 'from the guild indexer'), () => { /* the chain's list stands */ });
  function fromApi(rows: RosterRow[]) { return rows.map((r) => ({ id: r.id, name: r.username || r.id, pfp: r.pfp_client_render_attributes, alpha: String(r.alpha_p ?? r.alpha ?? '0') })); }
}
