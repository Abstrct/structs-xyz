/* Power: the acting commander's grid — supply against draw, the substation that shares power
 * out, every allocation in and out, and the brownout: what the chain cuts first when capacity
 * falls, and which structs to switch off to stay online. Also substation and allocation admin. */
import { h } from '../../core/dom';
import { audio } from '../../core/audio';
import { store } from '../../chain/store';
import { empire } from '../../game/empire';
import { wallet } from '../../wallet/wallet';
import { guildLabel } from '../../guild/directory';
import {
  connectionShare, gridHealth, parsePower, whatIf, cascadeOrder, alphaForPower, formatDecimal, decPct,
  type DrawItem, type DrawKind, type GridIn,
} from '../../game/economy';
import { eco, type AllocRow, type Mine, type SubRow } from './data';
import {
  act, alphaText, amount, blank, btn, chip, disclose, empty, enlistCta, field, idLink, kids, M, meter, powerEl, powerText, preview, section, select, tile, type EcoCtx,
} from './kit';
import { icon } from '../icons';

/** The grid's state as one big word; what it means is the hover. */
const STATE_TEXT = { dark: 'Offline', thin: 'Low', healthy: 'Good', spare: 'Plenty' } as const;
const STATE_HINT = { dark: 'Dark: over capacity. Your machines can’t act until supply covers what they use.', thin: 'Thin: little power to spare', healthy: 'Healthy: supply covers use', spare: 'Spare power: lots unused' } as const;
const STATE_TONE = { dark: 'enemy', thin: 'warn', healthy: 'player', spare: 'player' } as const;

/** Other players' grids, read on demand; re-read whenever the galaxy is (Refresh, our own moves). */
const peeked = new Map<string, { at: number; m: Mine | 'loading' | 'missing'; busy: boolean }>();

export function mountPower(ctx: EcoCtx) {
  const g = eco.galaxy;
  // #/economy/power/<1-x> looks at anyone's grid; ours are actionable.
  let subject: Mine | null = ctx.me;
  let readOnly = false;
  if (ctx.arg && /^1-\d+$/.test(ctx.arg) && ctx.arg !== ctx.me?.playerId) {
    const own = eco.minePlayer(ctx.arg);
    if (own) subject = own;
    else {
      const id = ctx.arg, at = g?.loadedAt ?? 0;
      const e = peeked.get(id);
      // The last read keeps showing while a newer one is on its way.
      if (!e || (e.at !== at && !e.busy)) {
        peeked.set(id, { at, m: e?.m ?? 'loading', busy: true });
        void eco.peek(id).then((m) => { peeked.set(id, { at, m: m || 'missing', busy: false }); ctx.repaint(); },
          () => { peeked.set(id, { at, m: e?.m ?? 'missing', busy: false }); ctx.repaint(); });
      }
      const p = peeked.get(id)!.m;
      if (p === 'loading') { ctx.host.replaceChildren(empty('Reading…', `Reading ${ctx.arg}’s grid…`)); return; }
      if (p === 'missing') { ctx.host.replaceChildren(blank('find', `No player ${ctx.arg}`, `No player ${ctx.arg} on chain.`, ['Back', () => ctx.navigate('/economy/power')])); return; }
      subject = p; readOnly = true;
    }
  }
  if (!subject) { ctx.host.replaceChildren(...kids(enlistCta('Your power grid'), g ? galaxyGrid(ctx) : null)); return; }

  const view = { ...ctx, me: readOnly ? null : ctx.me && subject.playerId === ctx.me.playerId ? ctx.me : eco.minePlayer(subject.playerId) };
  ctx.host.replaceChildren(...kids(
    readOnly ? h('div', { class: 'eco-alert vault-alert dct-alert', title: `Viewing ${subject.label}’s grid read-only.` }, h('span', { class: 'dct-alert-ico', html: icon('find', 18) }), h('span', { class: 'grow' }, `${subject.label}’s grid`), btn('Mine', () => ctx.navigate('/economy/power'), 'mini solid')) : null,
    hero(subject),
    h('div', { class: 'eco-cols' },
      h('div', { class: 'eco-col' }, brownoutCard(view, subject), allocationsCard(view, subject)),
      h('div', { class: 'eco-col' }, substationCard(view, subject), mySubstations(view, subject))),
  ));
}

/* ── The hero meter ─────────────────────────────────────────────────────── */

function hero(m: Mine) {
  const gh = gridHealth(m.grid);
  const sub = m.player.substationId ? eco.galaxy?.subs.get(m.player.substationId) : undefined;
  const after1 = sub ? connectionShare(sub.capacity, sub.load, sub.connections + 1n) : 0n;
  const dilution = sub ? m.grid.connectionCapacity - after1 : 0n;
  const commission = eco.galaxy?.reactors.find((r) => r.guildId === m.player.guildId)?.defaultCommission ?? 40_000_000_000_000_000n;
  const toDark = gh.headroom > 0n ? alphaForPower(gh.headroom, commission) : 0n;
  const risk = gh.online
    ? `You run out if your power falls by ${powerText(gh.headroom)}${toDark > 0n ? ` — about ${alphaText(toDark, 1)} of infusion (estimate, after ${decPct(commission)}% commission)` : ''}.`
    : 'Not enough power: your machines can’t act until your supply covers what they use. “If power drops” below shows what switches off first.';
  const tone = gh.state === 'dark' ? 'enemy' : gh.state === 'thin' ? 'warn' : 'player';
  // The grid at a glance: the state as a word, the headroom as a huge number, two meters (make,
  // use) and five numbers with pictures. The sentences are hovers, and written out in Expert mode.
  return h('section', { class: `eco-hero panel ${STATE_TONE[gh.state]}` },
    h('div', { class: 'eco-hero-top' },
      h('div', { class: 'col', style: 'gap:2px; min-width:0' },
        h('span', { class: 't-label c-hint eco-ell', title: `${m.label} · ${m.playerId}${m.player.guildId ? ' · ' + guildLabel(m.player.guildId).name : ''}` }, m.label === m.playerId ? m.playerId : m.label),
        h('span', { class: 'eco-hero-state c-' + tone, title: STATE_HINT[gh.state] }, STATE_TEXT[gh.state])),
      h('div', { class: 'eco-hero-head', title: (gh.headroom < 0n ? 'Short: power missing. ' : 'Headroom: power to spare. ') + risk },
        h('span', { class: 'eco-huge ' + (gh.headroom < 0n ? 'c-enemy' : 'c-player') }, h('span', { html: icon('power', 30) }), powerText(gh.headroom)),
        h('span', { class: 't-label c-hint' }, gh.headroom < 0n ? 'short' : 'spare'))),
    h('div', { class: 'eco-gauge' },
      h('div', { class: 'eco-gauge-row', title: 'Supply: your own capacity plus your substation share' }, h('span', { class: 't-label c-hint' }, 'Make'),
        meter([{ value: m.grid.capacity, cls: 'own', title: 'Your capacity' }, { value: m.grid.connectionCapacity, cls: 'share', title: 'Substation share' }], gh.supply > gh.demand ? gh.supply : gh.demand),
        h('span', { class: 'eco-gauge-v' }, powerText(gh.supply))),
      h('div', { class: 'eco-gauge-row', title: 'Draw: power you share out plus what your machines use. The white line is your supply.' }, h('span', { class: 't-label c-hint' }, 'Use'),
        meter([{ value: m.grid.load, cls: 'alloc', title: 'Allocated out' }, { value: m.grid.structsLoad, cls: 'structs', title: 'Structs' }], gh.supply > gh.demand ? gh.supply : gh.demand, { at: gh.supply, title: 'Capacity line' }),
        h('span', { class: 'eco-gauge-v' }, powerText(gh.demand)))),
    h('div', { class: 'eco-legend t-tiny x-only' },
      h('span', null, h('i', { class: 'own' }), 'own capacity'), h('span', null, h('i', { class: 'share' }), 'substation share'),
      h('span', null, h('i', { class: 'alloc' }), 'allocated out'), h('span', null, h('i', { class: 'structs' }), 'structs')),
    h('div', { class: 'eco-tiles' },
      tile('Own', powerText(m.grid.capacity), 'your own power, from fuel and generators', '', 'fuel'),
      tile('Substation', powerText(m.grid.connectionCapacity), m.player.substationId ? `your share from ${m.player.substationId}` : 'not connected', m.player.substationId ? '' : 'warn', 'station'),
      tile('Shared', powerText(m.grid.load), `shared out; ${powerText(gh.allocatable)} more you could share`, '', 'send'),
      tile('Machines', powerText(m.grid.structsLoad), 'machines use: 25 W base + machines switched on', '', 'chip'),
      tile('Spare', `${gh.marginPct.toFixed(1)}%`, gh.online ? 'of your power unused' : 'not enough power: machines stopped', tone, 'power')),
    h('div', { class: 'eco-risk t-tiny' },
      gh.online ? h('div', { class: 'x-only' }, '▸ ' + risk)
        : h('div', { class: 'c-enemy', title: risk }, '▸ Machines stopped'),
      sub ? h('div', { class: 'x-only' }, `▸ ${sub.id} shares ${powerText(sub.capacity - sub.load > 0n ? sub.capacity - sub.load : 0n)} among ${sub.connections} connections; each newcomer costs you about ${powerText(dilution)}.`) : null));
}

/* ── Brownout ───────────────────────────────────────────────────────────── */

/** A player's online structs as power draws, for the pause plan (null: not one of ours). */
export function drawItems(playerId: string): DrawItem[] | null {
  const p = empire.players.get(playerId);
  if (!p) return null;
  const out: DrawItem[] = [];
  for (const s of p.structs.values()) {
    const t = s.type;
    if (!t || !s.online || s.destroyed) continue;
    // Generators make the power: never switch those off to save it.
    if (t.powerGeneration !== 'noPowerGeneration') continue;
    const kind: DrawKind = t.id === 1 ? 'command' : t.category === 'fleet' ? 'fleet'
      : t.planetaryMining !== 'noPlanetaryMining' || t.planetaryRefinery !== 'noPlanetaryRefinery' ? 'production' : 'planet';
    out.push({ id: s.id, name: t.type, draw: BigInt(t.passiveDraw), kind });
  }
  return out;
}

function brownoutCard(ctx: EcoCtx, m: Mine) {
  const out = cascadeOrder(eco.allocsFrom(m.playerId));
  const items = drawItems(m.playerId);
  const key = 'brown:' + m.playerId;
  const range = h('input', { type: 'range', class: 'range eco-range', min: '0', max: '100', step: '1', value: ctx.drafts.get(key) ?? '25', 'aria-label': 'Capacity lost' }) as HTMLInputElement;
  const body = h('div', { class: 'col' });
  const pctLabel = h('span', { class: 't-tiny eco-pct' });
  const draw = () => {
    ctx.drafts.set(key, range.value);
    pctLabel.textContent = `${range.value}%`;
    const pct = BigInt(range.value);
    const drop = (m.grid.capacity * pct) / 100n;
    const sub = m.player.substationId ? eco.galaxy?.subs.get(m.player.substationId) ?? null : null;
    const w = whatIf(m.grid, drop, out.map((a) => ({ id: a.id, power: a.power, type: a.type, destinationId: a.destinationId })), items || [], sub);
    body.replaceChildren(...kids(
      h('div', { class: 'spread t-tiny', title: `If your own capacity fell ${range.value}% (−${powerText(drop)})` }, amount('power', `−${powerText(drop)}`), h('span', { title: w.after.online ? 'You stay online' : 'You go dark: machines stop' }, chip(w.after.online ? 'online' : 'dark', w.after.online ? 'player' : 'enemy'))),
      w.cascade.victims.length
        ? h('div', { class: 'col', style: 'gap:3px' }, h('span', { class: 't-label c-hint', title: 'The chain destroys these allocations, in this order' }, 'Cut first'),
          ...w.cascade.victims.map((a, i) => h('div', { class: 'eco-line enemy' }, h('span', { class: 'eco-ord' }, String(i + 1)), h('span', { class: 'grow' }, `${a.id} · ${a.type} → ${a.destinationId || 'unconnected'}`), h('span', null, powerText(a.power)))))
        : out.length ? empty('Nothing cut', 'No allocation is cut: your capacity still covers what you allocate out.') : null,
      w.subLoss > 0n ? h('div', { class: 't-tiny c-warn' }, `${m.player.substationId} loses ${powerText(w.subLoss)} with them: every connection's share, yours too, falls from ${powerText(m.grid.connectionCapacity)} to ${powerText(w.share)}.`) : null,
      !w.after.online
        ? h('div', { class: 'col', style: 'gap:3px' },
          h('span', { class: 't-label c-enemy', title: `Then ${powerText(w.deficit)} short. Switch these off, in order:` }, `−${powerText(w.deficit)} · switch off`),
          ...(items == null ? [h('div', { class: 't-tiny c-hint' }, 'Struct list not loaded for this player.')]
            : w.pause.plan.length ? w.pause.plan.map((s) => h('div', { class: 'eco-line warn' }, h('span', { class: 'eco-ord' }, s.kind === 'fleet' ? 'F' : s.kind === 'production' ? 'P' : 'D'), h('span', { class: 'grow' }, `${s.name} ${s.id}`), h('span', null, powerText(s.draw))))
              : [h('div', { class: 't-tiny c-hint' }, 'Nothing switchable draws power.')]),
          !w.pause.covered ? h('div', { class: 't-tiny c-enemy' }, 'Even with all of those off the Command Ship and base draw do not fit: add capacity (infuse, rent, or join a substation).') : null)
        : null,
    ));
  };
  range.addEventListener('input', draw);
  draw();
  return section('If power drops', 'What if you run short? When load passes capacity the chain sheds allocations in id byte-order (6-10 before 6-2), then a player whose draw still exceeds supply goes offline. Slide to try a drop.', [
    h('div', { class: 'row', title: 'How much of your own capacity is lost' }, h('span', { class: 'eco-sec-ico', html: icon('power', 18) }), range, pctLabel),
    body,
    out.length ? h('div', { class: 't-tiny c-hint x-only' }, `Cascade order of your ${out.length} outgoing allocation${out.length > 1 ? 's' : ''}: ${out.map((a) => a.id).join(' → ')}`) : null,
  ], { tone: 'enemy', cls: 'eco-brown', icon: 'health' });
}

/* ── Substation ─────────────────────────────────────────────────────────── */

function subLabel(s: SubRow) {
  const owner = store.players.get(s.owner);
  const gid = owner?.guildId;
  return `${s.id}${s.name ? ' “' + s.name + '”' : ''} · ${gid ? guildLabel(gid).tag : s.owner} · ${powerText(s.share)}/conn · ${s.connections} conn`;
}

function substationCard(ctx: EcoCtx, m: Mine) {
  const g = eco.galaxy;
  const sub = m.player.substationId ? g?.subs.get(m.player.substationId) : undefined;
  const subs = [...(g?.subs.values() || [])].sort((a, b) => (b.share > a.share ? 1 : b.share < a.share ? -1 : 0));
  const can = !!ctx.me;
  const connectForm = () => {
    const guildEntry = m.player.guildId ? g?.guilds.get(m.player.guildId)?.entrySubstationId : '';
    const s = select(ctx, 'conn:sub', subs.map((x) => [x.id, subLabel(x)]), { label: 'Substation', value: guildEntry || subs[0]?.id, hint: 'Pick the substation to plug into' });
    const go = btn('Connect', () => {
      const target = g?.subs.get(s.sel.value);
      if (!target) return;
      void act(ctx, {
        title: 'Connect to substation', label: `Connect ${m.playerId} to ${target.id}`,
        text: `${m.label} (${m.playerId}) plugs into substation ${target.id}. Its free power (${powerText(target.capacity - target.load)}) is split ${target.connections + 1n} ways, so you would draw about ${powerText(connectionShare(target.capacity, target.load, target.connections + 1n))}. Needs connection permission (bit 1024) on both the substation and the player.`,
        msgs: [M('MsgSubstationPlayerConnect', { substationId: target.id, playerId: m.playerId })],
      });
    }, 'solid mini');
    const pv = preview([s.sel], () => {
      const t = g?.subs.get(s.sel.value);
      if (!t) return { lines: ['Pick a substation'], ok: false };
      const share = connectionShare(t.capacity, t.load, t.connections + (t.id === m.player.substationId ? 0n : 1n));
      const after = gridHealth({ ...m.grid, connectionCapacity: share });
      return { lines: [`Your share would be ≈ ${powerText(share)} (est.) → headroom ${powerText(after.headroom)}`], ok: t.id !== m.player.substationId, tone: after.online ? '' : 'warn' };
    }, go);
    return h('div', { class: 'eco-form' }, s.el, pv, h('div', { class: 'row' }, go));
  };
  const migrateForm = () => {
    const mine = eco.minePlayers();
    const s = select(ctx, 'mig:sub', subs.map((x) => [x.id, subLabel(x)]), { label: 'Move to', value: sub?.id, hint: 'The substation your players move onto' });
    const boxes = mine.map((p) => {
      const key = 'mig-cb:' + p.playerId;
      const cb = h('input', { type: 'checkbox', checked: (ctx.drafts.get(key) ?? (p.playerId === m.playerId ? '1' : '0')) === '1' }) as HTMLInputElement;
      cb.addEventListener('change', () => ctx.drafts.set(key, cb.checked ? '1' : '0'));
      return { cb, p, el: h('label', { class: 'eco-check' }, cb, `${p.label} (${p.playerId}) · on ${p.player.substationId || 'none'}`) };
    });
    // The chain checks targetPlayer.CanManageSubstationConnectionBy(signer) for every player in the
    // message, so each player moves in its own transaction signed by its own account.
    const go = btn('Migrate', () => {
      const picked = boxes.filter((b) => b.cb.checked).map((b) => b.p);
      if (!picked.length) return;
      void act(ctx, {
        title: 'Migrate players', label: `Migrate ${picked.length} to ${s.sel.value}`,
        text: `Move ${picked.map((p) => p.playerId).join(', ')} onto substation ${s.sel.value}: one transaction per player, each signed by that player's own account. Every signer needs connection permission on ${s.sel.value}.`,
        msgs: [],
        each: picked.map((p) => ({ as: { account: p.account, playerId: p.playerId }, label: `Migrate ${p.playerId} to ${s.sel.value}`, msgs: [M('MsgSubstationPlayerMigrate', { substationId: s.sel.value, playerId: [p.playerId] })] })),
      });
    }, 'solid mini');
    return h('div', { class: 'eco-form' }, s.el, h('div', { class: 'col', style: 'gap:4px' }, ...boxes.map((b) => b.el)), h('div', { class: 'row' }, go));
  };
  const tools = can ? h('div', { class: 'row wrap' }) : null;
  const cf = can ? disclose(ctx, 'connect', sub ? 'Switch' : 'Connect', connectForm, sub ? 'ghost mini' : 'solid mini') : null;
  const mf = can && eco.minePlayers().length > 1 ? disclose(ctx, 'migrate', 'Migrate', migrateForm) : null;
  if (cf && sub) cf.button.title = 'Switch substation';
  if (mf) mf.button.title = 'Move several of your players to one substation';
  if (tools) tools.append(...kids(cf?.button, mf?.button,
    sub ? btn('Disconnect', () => void act(ctx, {
      title: 'Disconnect from substation', tone: 'enemy', ok: 'Disconnect', label: `Disconnect ${m.playerId} from ${sub.id}`,
      text: `${m.label} leaves substation ${sub.id} and loses its ${powerText(m.grid.connectionCapacity)} share. Supply would fall to ${powerText(m.grid.capacity)} against a draw of ${powerText(m.grid.load + m.grid.structsLoad)}${m.grid.capacity < m.grid.load + m.grid.structsLoad ? ' — you would go dark' : ''}.`,
      msgs: [M('MsgSubstationPlayerDisconnect', { playerId: m.playerId })],
    }), 'ghost mini danger') : null));

  if (!sub) return section('Substation', 'Not connected: you run on your own capacity alone.', [tools, cf?.holder, mf?.holder, !can ? empty('Not connected', 'This player has no substation.') : null], { tone: 'neutral', icon: 'station' });

  const ins = eco.allocsInto(sub.id).sort((a, b) => (b.power > a.power ? 1 : -1));
  const outs = cascadeOrder(eco.allocsFrom(sub.id));
  const conn = eco.connected(sub.id);
  const owner = store.players.get(sub.owner);
  return section(`Substation ${sub.id}`, `${sub.name ? '“' + sub.name + '” · ' : ''}owned by ${owner?.name || sub.owner}${owner?.guildId ? ' · ' + guildLabel(owner.guildId).name : ''}`, [
    tools, cf?.holder, mf?.holder,
    h('div', { class: 'eco-tiles' },
      tile('Capacity', powerText(sub.capacity), `${ins.length} allocations in`, '', 'power'),
      tile('Out', powerText(sub.load), `allocated out: ${outs.length} allocations`, '', 'send'),
      tile('Players', String(sub.connections), `connections${store.coreLoaded ? `: ${conn.length} on the roster` : ''}`, '', 'team'),
      tile('Each', powerText(sub.share), 'per connection: everyone draws this', 'player', 'power')),
    meter([{ value: sub.load, cls: 'alloc', title: 'Allocated out' }, { value: sub.capacity - sub.load > 0n ? sub.capacity - sub.load : 0n, cls: 'share', title: 'Shared among connections' }], sub.capacity),
    h('span', { class: 't-label c-hint', title: 'Power allocated into this substation' }, 'In'),
    ins.length ? h('div', { class: 'eco-list' }, ...ins.map((a) => allocLine(ctx, a, 'in'))) : empty('Nothing in', 'Nothing allocated in.'),
    outs.length ? h('span', { class: 't-label c-hint', title: 'Power out, in cascade order (what is cut first)' }, 'Out') : null,
    outs.length ? h('div', { class: 'eco-list' }, ...outs.map((a) => allocLine(ctx, a, 'out'))) : null,
    conn.length ? h('span', { class: 't-label c-hint', title: 'Connected players' }, `Players · ${conn.length}`) : null,
    conn.length ? h('div', { class: 'row wrap eco-conn' }, ...conn.slice(0, 40).map((p) => h('a', {
      class: 'chip ' + (wallet.byPlayer(p.id) ? 'player' : ''), href: '/economy/power/' + p.id,
      onclick: (e: Event) => { e.preventDefault(); ctx.navigate('/economy/power/' + p.id); },
    }, p.name || p.id)), conn.length > 40 ? chip(`+${conn.length - 40} more`) : null) : null,
  ], { tone: 'player', icon: 'station' });
}

function allocLine(ctx: EcoCtx, a: AllocRow, dir: 'in' | 'out') {
  const other = dir === 'in' ? a.sourceObjectId : a.destinationId;
  const name = /^1-/.test(other) ? store.playerName(other) : other;
  return h('div', { class: 'eco-line' },
    chip(a.type === 'providerAgreement' ? 'rented' : a.type, a.type === 'providerAgreement' ? 'neutral' : ''),
    h('span', { class: 'grow eco-ell' }, `${a.id} ${dir === 'in' ? '←' : '→'} `, other ? idLink(ctx, other, name === other ? other : `${name} (${other})`) : 'unconnected'),
    h('span', { class: 'eco-num' }, powerText(a.power)));
}

/* ── Allocations ────────────────────────────────────────────────────────── */

function allocationsCard(ctx: EcoCtx, m: Mine) {
  const g = eco.galaxy;
  const ownedSubs = [...(g?.subs.values() || [])].filter((s) => s.owner === m.playerId);
  const sources = new Set([m.playerId, ...ownedSubs.map((s) => s.id)]);
  const list = (g?.allocs || []).filter((a) => sources.has(a.sourceObjectId) || a.controller === m.playerId);
  const ordered = cascadeOrder(list);
  const gh = gridHealth(m.grid);
  const can = !!ctx.me;
  const subs = [...(g?.subs.values() || [])];

  const createForm = () => {
    const src = select(ctx, 'ac:src', [[m.playerId, `${m.label} (${m.playerId}) · ${powerText(gh.allocatable)} free`], ...ownedSubs.map((s): [string, string] => [s.id, `Substation ${s.id} · ${powerText(s.capacity - s.load)} free`])], { label: 'From', hint: 'Where the power comes from' });
    const type = select(ctx, 'ac:type', [['static', 'Static — fixed power'], ['dynamic', 'Dynamic — adjustable'], ['automated', 'Automated — sized to all free capacity']], { label: 'Type', value: 'dynamic', hint: 'Static is fixed, dynamic can be resized or deleted, automated follows all your free capacity' });
    const pw = field(ctx, 'ac:power', { placeholder: 'e.g. 5', unit: 'kW', label: 'Power' });
    const ctl = field(ctx, 'ac:ctl', { placeholder: m.playerId, value: m.playerId, mode: 'text', label: 'Owner', hint: 'Controller: the player who may resize, move or delete it' });
    const go = btn('Create', () => {
      const power = type.sel.value === 'automated' ? 0n : parsePower(pw.input.value) ?? 0n;
      void act(ctx, {
        title: 'Create allocation', label: `Allocate ${type.sel.value === 'automated' ? 'all free' : powerText(power)} from ${src.sel.value}`,
        text: `${src.sel.value} commits ${type.sel.value === 'automated' ? 'all its free capacity (resized automatically)' : powerText(power)} as a ${type.sel.value} allocation controlled by ${ctl.input.value.trim() || m.playerId}. It carries no power anywhere until you connect it to a substation.`,
        msgs: [M('MsgAllocationCreate', { sourceObjectId: src.sel.value, allocationType: type.sel.value, power: power.toString(), controller: ctl.input.value.trim() || m.playerId })],
      });
    }, 'solid mini');
    const pv = preview([src.sel, type.sel, pw.input, ctl.input], () => {
      const auto = type.sel.value === 'automated';
      pw.input.disabled = auto;
      const free = src.sel.value === m.playerId ? gh.allocatable : (() => { const s = g?.subs.get(src.sel.value); return s ? s.capacity - s.load : 0n; })();
      if (!/^1-\d+$/.test(ctl.input.value.trim() || m.playerId)) return { lines: ['The controller must be a player id (1-…)'], ok: false, tone: 'enemy' };
      if (auto) return { lines: [`Takes all ${powerText(free)} free now and follows your capacity as it changes.`], ok: free > 0n };
      const p = parsePower(pw.input.value);
      if (p == null || p <= 0n) return { lines: ['Enter power, e.g. 2.5 (kW), 800 W or 1 MW'], ok: false };
      const left = free - p;
      return { lines: [`${powerText(p)} of ${powerText(free)} allocatable · ${powerText(left > 0n ? left : 0n)} left`, left < 0n ? 'More than this source has free: the chain will refuse it.' : ''], ok: left >= 0n, tone: left < 0n ? 'enemy' : '' };
    }, go);
    return h('div', { class: 'eco-form' }, h('div', { class: 'eco-form-grid' }, src.el, type.el, pw.el, ctl.el), pv, h('div', { class: 'row' }, go));
  };
  const cf = can ? disclose(ctx, 'alloc-create', 'New', createForm, 'solid mini') : null;
  if (cf) cf.button.title = 'New allocation';

  const row = (a: AllocRow) => {
    const editable = can && (a.controller === m.playerId || sources.has(a.sourceObjectId));
    // Only dynamic allocations can be resized or deleted (SetDynamicPower / immutable_type).
    const dynamic = a.type === 'dynamic';
    const pw = editable && dynamic ? disclosePower(ctx, a) : null;
    const cn = editable && !a.destinationId ? discloseConnect(ctx, a, subs) : null;
    const tr = editable ? discloseTransfer(ctx, a) : null;
    const actions = editable ? h('div', { class: 'row wrap eco-row-acts' }, ...kids(pw?.button, cn?.button,
      a.destinationId ? btn('Disconnect', () => void act(ctx, {
        title: 'Disconnect allocation', tone: 'enemy', ok: 'Disconnect', label: `Disconnect ${a.id}`,
        text: `${a.id} stops feeding ${a.destinationId}: that substation loses ${powerText(a.power)}, and every player on it loses a share of that.`,
        msgs: [M('MsgSubstationAllocationDisconnect', { allocationId: a.id })],
      }), 'ghost mini') : null,
      tr?.button,
      dynamic ? btn('Delete', () => void act(ctx, {
        title: 'Delete allocation', tone: 'enemy', ok: 'Delete', label: `Delete ${a.id}`,
        text: `Destroy ${a.id} (${powerText(a.power)} ${a.type}${a.destinationId ? ' feeding ' + a.destinationId : ''}). The power returns to ${a.sourceObjectId}'s free capacity.`,
        msgs: [M('MsgAllocationDelete', { allocationId: a.id })],
      }), 'ghost mini danger') : null)) : null;
    const forms = [pw?.holder, cn?.holder, tr?.holder];
    return h('div', { class: 'eco-item' },
      h('div', { class: 'spread' },
        h('div', { class: 'row wrap', style: 'gap:6px; min-width:0' },
          h('span', { class: 'eco-id' }, a.id), chip(a.type === 'providerAgreement' ? 'rented' : a.type, a.type === 'automated' ? 'player' : a.type === 'providerAgreement' ? 'neutral' : ''),
          h('span', { class: 't-tiny c-hint eco-ell', title: a.controller !== m.playerId ? 'controlled by ' + a.controller : null }, `${a.sourceObjectId} → ${a.destinationId || 'unconnected'}`)),
        powerEl(a.power, 'eco-num c-player')),
      actions, ...forms);
  };
  return section('Power flows', 'Allocations: capacity you route to substations. Only dynamic ones can be resized or deleted; static ones are fixed, automated ones track all your free capacity.', [
    can ? h('div', { class: 'row wrap' }, cf?.button) : null, cf?.holder,
    ordered.length ? h('div', { class: 'col', style: 'gap:6px' }, ...ordered.map(row)) : empty('No flows', 'No allocations from or controlled by this player.'),
  ], { icon: 'send' });
}

function disclosePower(ctx: EcoCtx, a: AllocRow) {
  return disclose(ctx, 'pw:' + a.id, 'Resize', () => {
    const f = field(ctx, 'pw-v:' + a.id, { placeholder: formatDecimal(a.power, 6), unit: 'kW', label: 'New power' });
    const go = btn('Update', () => {
      const p = parsePower(f.input.value);
      if (p == null || p <= 0n || p === a.power) return;
      void act(ctx, {
        title: 'Resize allocation', label: `${a.id} → ${powerText(p)}`,
        text: `${a.id} goes from ${powerText(a.power)} to ${powerText(p)}${a.destinationId ? `; ${a.destinationId} ${p > a.power ? 'gains' : 'loses'} ${powerText(p > a.power ? p - a.power : a.power - p)}` : ''}.`,
        msgs: [M('MsgAllocationUpdate', { allocationId: a.id, power: p.toString() })],
      });
    }, 'solid mini');
    const pv = preview([f.input], () => {
      const p = parsePower(f.input.value);
      if (p == null) return { lines: ['Enter the new power (kW)'], ok: false };
      if (p <= 0n) return { lines: ['Power must stay above zero: delete the allocation instead'], ok: false, tone: 'enemy' };
      return { lines: [`${powerText(a.power)} → ${powerText(p)}`], ok: p !== a.power };
    }, go);
    return h('div', { class: 'eco-form inline' }, f.el, pv, go);
  });
}

function discloseConnect(ctx: EcoCtx, a: AllocRow, subs: SubRow[]) {
  return disclose(ctx, 'cn:' + a.id, 'Connect', () => {
    const s = select(ctx, 'cn-v:' + a.id, subs.map((x) => [x.id, subLabel(x)]), { label: 'Feed', value: ctx.me?.player.substationId, hint: 'The substation this allocation feeds' });
    const go = btn('Connect', () => void act(ctx, {
      title: 'Connect allocation', label: `Connect ${a.id} → ${s.sel.value}`,
      text: `${a.id} starts feeding ${powerText(a.power)} into substation ${s.sel.value}, raising every connected player's share. Needs connection permission on the substation.`,
      msgs: [M('MsgSubstationAllocationConnect', { allocationId: a.id, destinationId: s.sel.value })],
    }), 'solid mini');
    return h('div', { class: 'eco-form inline' }, s.el, go);
  }, 'solid mini');
}

function discloseTransfer(ctx: EcoCtx, a: AllocRow) {
  return disclose(ctx, 'tr:' + a.id, 'Transfer', () => {
    const f = field(ctx, 'tr-v:' + a.id, { placeholder: '1-…', mode: 'text', label: 'New owner', hint: 'The player who takes control of it' });
    const go = btn('Transfer', () => void act(ctx, {
      title: 'Transfer allocation', tone: 'enemy', ok: 'Transfer', label: `Hand ${a.id} to ${f.input.value.trim()}`,
      text: `Control of ${a.id} (${powerText(a.power)}) passes to ${f.input.value.trim()} (${store.playerName(f.input.value.trim())}). They will be able to resize, reconnect or delete it.`,
      msgs: [M('MsgAllocationTransfer', { allocationId: a.id, controller: f.input.value.trim() })],
    }), 'danger mini');
    const pv = preview([f.input], () => {
      const v = f.input.value.trim();
      return /^1-\d+$/.test(v) ? { lines: [store.players.get(v)?.name || v], ok: v !== a.controller } : { lines: ['A player id, like 1-194'], ok: false };
    }, go);
    return h('div', { class: 'eco-form inline' }, f.el, pv, go);
  });
}

/* ── Substations you own ────────────────────────────────────────────────── */

function mySubstations(ctx: EcoCtx, m: Mine) {
  const g = eco.galaxy;
  if (!g) return null;
  const owned = [...g.subs.values()].filter((s) => s.owner === m.playerId);
  const can = !!ctx.me;
  const loose = g.allocs.filter((a) => !a.destinationId && (a.sourceObjectId === m.playerId || a.controller === m.playerId) && a.type !== 'providerAgreement');
  const createForm = () => {
    const s = select(ctx, 'sc:alloc', loose.map((a) => [a.id, `${a.id} · ${a.type} · ${powerText(a.power)}`]), { label: 'Powered by', hint: 'The founding allocation: an unconnected one of yours' });
    const go = btn('Create', () => void act(ctx, {
      title: 'Create substation', label: `Substation from ${s.sel.value}`,
      text: `A new substation owned by ${m.label} (${m.playerId}), powered by allocation ${s.sel.value}. You can then connect players to it and sell its power on the market.`,
      msgs: [M('MsgSubstationCreate', { owner: m.playerId, allocationId: s.sel.value })],
    }), 'solid mini');
    go.disabled = !loose.length;
    return h('div', { class: 'eco-form' }, loose.length ? s.el : empty('Make a flow first', 'A substation is born from an unconnected allocation. Create one first (Power flows).'), go);
  };
  const cf = can ? disclose(ctx, 'sub-create', 'New', createForm) : null;
  if (cf) cf.button.title = 'New substation';
  const others = [...g.subs.values()];
  return section('My substations', owned.length ? 'Substations you own' : 'Own a substation to share power with your replicants or sell it on the market.', [
    cf ? h('div', { class: 'row' }, cf.button) : null, cf?.holder,
    ...owned.map((s) => {
      const del = can ? disclose(ctx, 'sd:' + s.id, 'Delete', () => {
        // '' is the chain's "nowhere": the players are simply disconnected.
        const to = select(ctx, 'sd-v:' + s.id, [...others.filter((o) => o.id !== s.id).map((o): [string, string] => [o.id, subLabel(o)]), ['', 'Nowhere: disconnect them']], { label: 'Players to', hint: 'Where its connected players move' });
        const go = btn('Delete', () => {
          const dest = to.sel.value;
          void act(ctx, {
            title: 'Delete substation', tone: 'enemy', ok: 'Delete', label: `Delete ${s.id}`,
            text: `Substation ${s.id} is destroyed. ${s.connections > 0n ? (dest ? `Its ${s.connections} connected players move to ${dest} (needs connection permission there)` : `Its ${s.connections} connected players are disconnected and run on their own capacity alone`) : 'Nobody is connected to it'}; allocations into it disconnect.`,
            msgs: [M('MsgSubstationDelete', { substationId: s.id, migrationSubstationId: dest })],
          });
        }, 'danger mini');
        return h('div', { class: 'eco-form inline' }, to.el, go);
      }, 'ghost mini danger') : null;
      const ren = can ? disclose(ctx, 'sn:' + s.id, 'Rename', () => {
        const f = field(ctx, 'sn-v:' + s.id, { placeholder: s.name || 'Name', mode: 'text', label: 'Name' });
        const go = btn('Rename', () => void act(ctx, { title: 'Rename substation', label: `Name ${s.id}`, text: `Substation ${s.id} will be called “${f.input.value.trim()}”.`, msgs: [M('MsgSubstationUpdateName', { substationId: s.id, name: f.input.value.trim() })] }), 'solid mini');
        return h('div', { class: 'eco-form inline' }, f.el, go);
      }) : null;
      return h('div', { class: 'eco-item' },
        h('div', { class: 'spread' }, h('span', { class: 'eco-id' }, `${s.id}${s.name ? ' “' + s.name + '”' : ''}`),
          h('span', { class: 'dct-stats', title: `${powerText(s.capacity)} · ${s.connections} connections · ${powerText(s.share)} each` }, powerEl(s.capacity), amount('team', String(s.connections)), amount('power', powerText(s.share), 'Each player gets'))),
        meter([{ value: s.load, cls: 'alloc' }, { value: s.capacity - s.load > 0n ? s.capacity - s.load : 0n, cls: 'share' }], s.capacity),
        can ? h('div', { class: 'row wrap eco-row-acts' }, ren?.button, h('button', { class: 'btn ghost mini', title: 'Sell its power on the market', onclick: () => { audio.play('select'); ctx.navigate('/economy/market'); } }, 'Sell'), del?.button) : null,
        ren?.holder, del?.holder);
    }),
  ], { icon: 'station' });
}

/* ── Read-only: the galaxy's substations ────────────────────────────────── */

function galaxyGrid(ctx: EcoCtx) {
  const g = eco.galaxy!;
  const subs = [...g.subs.values()].sort((a, b) => (b.capacity > a.capacity ? 1 : -1));
  const total = (k: (s: SubRow) => bigint) => subs.reduce((a, s) => a + k(s), 0n);
  const gridIn: GridIn = { capacity: total((s) => s.capacity), load: total((s) => s.load), structsLoad: 0n, connectionCapacity: 0n };
  // The biggest few show; the rest fold behind one button (kept open across repaints).
  const all = ctx.drafts.get('grid:all') === '1';
  const shown = all ? subs : subs.slice(0, 4);
  return section('Galaxy grid', `${subs.length} substations share ${powerText(gridIn.capacity)} among ${total((s) => s.connections)} players. Fewer players on a substation means more power each.`, [
    h('div', { class: 'dct-stats', title: `${subs.length} substations share ${powerText(gridIn.capacity)} among ${total((s) => s.connections)} players` },
      amount('station', String(subs.length), 'Substations'), powerEl(gridIn.capacity, '', 'Power shared'), amount('team', String(total((s) => s.connections)), 'Players connected')),
    h('div', { class: 'eco-table' },
      // Each column says what it is: a picture and one word.
      h('div', { class: 'eco-tr head t-label' }, ...([['station', 'Station', 'Substation: shares power out to players'], ['team', 'Guild', 'The guild that owns it'], ['power', 'Power', 'Power it shares'],
        ['team', 'Players', 'Players connected'], ['power', 'Each', 'Power each player gets']] as const).map(([ico, word, tip]) => h('span', { class: 'eco-th', title: tip }, h('span', { html: icon(ico, 14) }), word))),
      ...shown.map((s) => {
        const owner = store.players.get(s.owner);
        const gl = owner?.guildId ? guildLabel(owner.guildId) : null;
        return h('div', { class: 'eco-tr', title: `${s.id}${s.name ? ' “' + s.name + '”' : ''}${gl ? ' · ' + gl.name : ''}: ${powerText(s.capacity)} shared by ${s.connections}, ${powerText(s.share)} each` },
          h('span', { class: 'eco-id' }, s.id), h('span', { class: 'eco-ell' }, gl ? gl.tag : idLink(ctx, s.owner)),
          h('span', null, powerText(s.capacity)), h('span', null, String(s.connections)), h('span', { class: 'c-player' }, powerText(s.share)));
      })),
    subs.length > shown.length || all ? h('div', { class: 'row' }, h('button', { class: 'btn ghost mini', 'data-k': 'fold:grid', title: all ? 'Show the biggest few' : 'Show every substation',
      onclick: () => { ctx.drafts.set('grid:all', all ? '0' : '1'); audio.play('select'); ctx.repaint(); } }, all ? 'Less' : `All ${subs.length}`)) : null,
  ], { icon: 'station' });
}
