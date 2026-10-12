/* The energy market: providers sell a substation's spare power for a rate per milliwatt per
 * block; an agreement locks capacity × duration × rate as collateral up front and delivers the
 * power as an allocation you connect to your own substation. Cheapest power first, priced per
 * kW·day (guild tokens converted at their bank's ratio). Provider-side tools sit below. */
import { h } from '../../core/dom';
import { LCD_URL } from '../../chain/lcd';
import { store } from '../../chain/store';
import { guildLabel } from '../../guild/directory';
import { blocksToDuration } from '../../core/util';
import {
  agreementCost, agreementProblems, blocksPerDay, capacityChangeProblems, decOf, decPct, durationIncreaseCost, extendProblems, formatDecimal, guildOfDenom,
  parseDecimal, parsePower, ratePerKwDay, rescaledDuration, termsOf, big0, MW_PER_KW,
} from '../../game/economy';
import { eco, amountOf, balancesOf, type AgreementRow, type Coin, type Mine, type ProviderRow } from './data';
import { act, amount, btn, chip, disclose, empty, field, kids, M, powerText, preview, section, select, shortAddr, tile, enlistCta, type EcoCtx } from './kit';
import { icon } from '../icons';

const POLICY: Record<string, [string, '' | 'player' | 'enemy' | 'warn' | 'neutral']> = { openMarket: ['open', 'player'], guildMarket: ['guild', 'neutral'], closedMarket: ['closed', 'enemy'] };
const POLICY_HINT: Record<string, string> = { openMarket: 'Open: anyone can rent', guildMarket: 'Guild only: players with the provider-open permission', closedMarket: 'Closed: no new rentals' };

/** An amount of `denom` at 6 places with its unit name. */
const amt = (v: bigint, denom: string, maxFrac = 2) => `${formatDecimal(v, 6, { maxFrac, group: true })} ${eco.denomLabel(denom)}`;

/** Alpha per one base unit of a denom (bank ratio), as [numerator, denominator]. */
function alphaRate(denom: string): [bigint, bigint] | null {
  if (denom === 'ualpha') return [1n, 1n];
  const gid = guildOfDenom(denom);
  const b = gid ? eco.bank(gid) : null;
  return b && b.supply > 0n ? [b.collateral, b.supply] : null;
}
const inAlpha = (v: bigint, denom: string) => { const r = alphaRate(denom); return r ? (v * r[0]) / r[1] : null; };

function perDay() { return blocksPerDay(eco.galaxy?.blockSeconds ?? 6); }
/** Collateral comes out of the player's primary account (activePlayer.GetPrimaryAddress()). */
const payNote = (me: Mine) => (me.primaryAddress !== me.address ? ` It is paid from ${me.player.id}'s primary account ${shortAddr(me.primaryAddress)}, not the signing account.` : '');
const freeOn = (p: ProviderRow) => { const sub = eco.galaxy?.subs.get(p.substationId); return sub ? (sub.capacity > sub.load ? sub.capacity - sub.load : 0n) : null; };
const dur = (blocks: bigint) => blocksToDuration(Number(blocks) * (eco.galaxy?.blockSeconds ?? 6) / 6);

export function mountMarket(ctx: EcoCtx) {
  const g = eco.galaxy!;
  const pd = perDay();
  const filter = ctx.drafts.get('mk:filter') || 'all';
  const myGuild = ctx.me?.player.guildId;
  const rows = g.providers
    .filter((p) => filter === 'all' || (filter === 'open' && p.accessPolicy === 'openMarket') || (filter === 'guild' && p.accessPolicy === 'guildMarket' && !!myGuild && guildOf(p) === myGuild))
    .map((p) => ({ p, price: inAlpha(ratePerKwDay(big0(p.rate.amount), pd), p.rate.denom) }))
    .sort((a, b) => (a.price == null ? 1 : b.price == null ? -1 : a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  const best = rows.find((r) => r.price != null && r.p.accessPolicy !== 'closedMarket');
  const free = g.providers.reduce((a, p) => { const s = g.subs.get(p.substationId); return a + (s && s.capacity > s.load ? s.capacity - s.load : 0n); }, 0n);

  const filters = h('div', { class: 'row wrap eco-filters' }, ...(['all', 'open', 'guild'] as const).map((f) => h('button', {
    class: 'btn ghost mini' + (filter === f ? ' active' : ''), title: f === 'all' ? 'Every offer' : f === 'open' ? 'Open to everyone' : 'My guild’s offers', 'data-k': 'filter:' + f,
    onclick: () => { ctx.drafts.set('mk:filter', f); ctx.repaint(); },
  }, f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Guild')));

  ctx.host.replaceChildren(...kids(
    h('div', { class: 'eco-tiles' },
      tile('Best price', best?.price != null ? formatDecimal(best.price, 6, { maxFrac: 3, group: true }) : '—', best ? `the cheapest open offer, ${best.p.id}: alpha per kW·day` : 'no open offers', 'player', 'alpha'),
      tile('Sellers', String(g.providers.length), `${g.providers.filter((p) => p.accessPolicy === 'openMarket').length} open to all`, '', 'market'),
      tile('Rented', String(g.agreements.length), `rentals running now: ${powerText(g.agreements.reduce((a, x) => a + x.capacity, 0n))} under contract`, '', 'queue'),
      Object.assign(tile('Blocks per day', pd.toLocaleString(), `${(g.blockSeconds).toFixed(2)} s each, measured`, '', 'clock'), { className: 'eco-tile x-only' })),
    section('Power shop', `Offers, cheapest first. Prices are in alpha per kilowatt per day. Sellers have ${powerText(free)} to spare right now.`, [
      filters,
      rows.length ? h('div', { class: 'eco-cards' }, ...rows.map(({ p, price }) => offerCard(ctx, p, price))) : empty('No offers', 'No offers match this filter.'),
    ], { tone: 'player', icon: 'market', tools: h('span', { class: 'dct-chip', title: 'Prices are alpha per kilowatt of power per day' }, h('span', { html: icon('alpha', 14) }), '/ kW·day') }),
    ctx.me ? myAgreements(ctx) : enlistCta('Renting power'),
    ctx.me ? myProviders(ctx) : null,
    ctx.me ? becomeProvider(ctx) : null,
  ));
}

const guildOf = (p: ProviderRow) => store.players.get(p.owner)?.guildId || '';

/** The Market's shape while the galaxy is still being read: the tiles, the shop and its cards as
 * dim placeholders, so the screen is never an empty "Reading…". */
export function marketSkeleton(): HTMLElement {
  const ghost = () => h('div', { class: 'eco-card offer dct-skel', 'aria-hidden': 'true' }, h('i', { class: 'w60' }), h('i', { class: 'big w40' }), h('i', { class: 'w30' }));
  return h('div', { class: 'col', style: 'gap:14px', title: 'Reading the market…' },
    h('div', { class: 'eco-tiles' },
      tile('Best price', '…', 'the cheapest open offer: alpha per kW·day', 'player', 'alpha'), tile('Sellers', '…', null, '', 'market'), tile('Rented', '…', 'rentals running now', '', 'queue')),
    section('Power shop', 'Offers, cheapest first. Prices are in alpha per kilowatt per day.', [
      h('div', { class: 'eco-loading dct-skel-note' }, h('span', { class: 'dot pulse c-player' }), 'Reading…'),
      h('div', { class: 'eco-cards' }, ghost(), ghost(), ghost(), ghost()),
    ], { tone: 'player', icon: 'market' }));
}

/* ── Offers ─────────────────────────────────────────────────────────────── */

function offerCard(ctx: EcoCtx, p: ProviderRow, price: bigint | null) {
  const g = eco.galaxy!;
  const sub = g.subs.get(p.substationId);
  const avail = sub ? (sub.capacity > sub.load ? sub.capacity - sub.load : 0n) : null;
  const t = termsOf(p);
  const [pol, tone] = POLICY[p.accessPolicy] || [p.accessPolicy, ''];
  const owner = store.players.get(p.owner);
  const mine = ctx.me?.playerId === p.owner;
  const rent = ctx.me && !mine && p.accessPolicy !== 'closedMarket' ? disclose(ctx, 'rent:' + p.id, 'Rent', () => rentForm(ctx, p), 'solid mini') : null;
  const terms = `Capacity ${powerText(t.capMin)} – ${powerText(t.capMax)} · duration ${dur(t.durMin)} – ${dur(t.durMax)} · sold ${powerText(p.load)} · cancel penalties: provider ${decPct(p.providerPenalty)}%, you ${decPct(p.consumerPenalty)}%`;
  // A shop card: the seller, the price big, and what is free now. The terms are its hover (and Expert mode).
  return h('div', { class: 'eco-card offer' + (mine ? ' home' : ''), title: terms },
    h('div', { class: 'spread' },
      h('div', { class: 'col', style: 'gap:1px; min-width:0' },
        h('span', { class: 't-label-lg eco-ell', title: `${owner?.name || p.owner}${guildOf(p) ? ' · ' + guildLabel(guildOf(p)).name : ''} · offer ${p.id} on substation ${p.substationId}` }, owner?.name || p.owner),
        h('span', { class: 't-tiny c-hint x-only' }, `${p.id} · ${p.substationId}${guildOf(p) ? ' · ' + guildLabel(guildOf(p)).name : ''}`)),
      // Who may rent, as a badge: open (a tick), guild only (the team), closed (a lock).
      h('span', { class: 'dct-policy ' + tone, title: POLICY_HINT[p.accessPolicy] || pol, 'aria-label': pol, html: icon(p.accessPolicy === 'openMarket' ? 'check' : p.accessPolicy === 'guildMarket' ? 'team' : 'lock', 15) })),
    h('div', { class: 'eco-price', title: 'Alpha per kilowatt per day' },
      h('span', { class: 'eco-big c-player' }, h('span', { class: 'eco-tile-ico k-alpha', html: icon('alpha', 20) }), price != null ? formatDecimal(price, 6, { maxFrac: 3, group: true }) : '?'),
      // The token price is a detail beside an alpha price, but the only price when there is none.
      p.rate.denom !== 'ualpha' ? h('span', { class: 't-tiny c-hint' + (price != null ? ' x-only' : '') }, `paid in ${eco.denomLabel(p.rate.denom)}: ${amt(ratePerKwDay(t.rate, perDay()), p.rate.denom)} per kW·day`) : null),
    h('div', { class: 'dct-stats' },
      amount('power', avail == null ? '—' : powerText(avail), 'Free now', avail === 0n ? 'c-enemy' : ''),
      h('span', { class: 'x-only' }, amount('power', `${powerText(t.capMin)} – ${powerText(t.capMax)}`, 'Capacity')),
      h('span', { class: 'x-only' }, amount('clock', `${dur(t.durMin)} – ${dur(t.durMax)}`, 'Duration'))),
    rent ? h('div', { class: 'row eco-row-acts' }, rent.button) : null, rent?.holder);
}

function rentForm(ctx: EcoCtx, p: ProviderRow) {
  const me = ctx.me!;
  const t = termsOf(p);
  const pd = perDay();
  const sub = eco.galaxy?.subs.get(p.substationId);
  const avail = sub ? (sub.capacity > sub.load ? sub.capacity - sub.load : 0n) : null;
  const bal = amountOf(me.primary, p.rate.denom);
  const cap = field(ctx, 'rent-c:' + p.id, { placeholder: formatDecimal(t.capMin > MW_PER_KW ? t.capMin : MW_PER_KW, 6), unit: 'kW', label: 'Power', hint: `How much power: ${powerText(t.capMin)} – ${powerText(t.capMax)}` });
  const days = field(ctx, 'rent-d:' + p.id, { placeholder: '1', unit: 'days', label: 'Time', hint: `For how long: ${dur(t.durMin)} – ${dur(t.durMax)}` });
  const blocksOf = () => { const d = parseDecimal(days.input.value, 4); return d == null ? null : (d * pd) / 10_000n; };
  const go = btn('Rent it', () => {
    const c = parsePower(cap.input.value), b = blocksOf();
    if (!c || !b) return;
    const cost = agreementCost(c, b, t.rate);
    void act(ctx, {
      title: 'Open agreement', label: `Rent ${powerText(c)} from ${p.id} for ${dur(b)}`,
      text: `Rent ${powerText(c)} from provider ${p.id} for ${b.toLocaleString()} blocks (≈ ${dur(b)}). ${amt(cost, p.rate.denom, 6)} leaves your wallet now as collateral and is paid out to the provider as the blocks pass. The power arrives as a new allocation: connect it to a substation from the Power tab. Closing early forfeits ${decPct(p.consumerPenalty)}% of what remains.${payNote(me)}`,
      msgs: [M('MsgAgreementOpen', { providerId: p.id, duration: b.toString(), capacity: c.toString() })],
    });
  }, 'solid mini');
  const pv = preview([cap.input, days.input], () => {
    const c = parsePower(cap.input.value), b = blocksOf();
    if (c == null || b == null) return { lines: ['Capacity (kW) and duration (days)'], ok: false };
    const probs = agreementProblems(t, c, b, avail, p.accessPolicy, bal);
    const cost = agreementCost(c, b, t.rate);
    const alpha = inAlpha(cost, p.rate.denom);
    return {
      lines: [`${b.toLocaleString()} blocks · quote ${amt(cost, p.rate.denom, 6)}${alpha != null && p.rate.denom !== 'ualpha' ? ` (≈ ${formatDecimal(alpha, 6, { maxFrac: 3, group: true })} alpha)` : ''}`,
        `You hold ${amt(bal, p.rate.denom)}`, ...probs],
      ok: !probs.length, tone: probs.length ? 'enemy' : '',
    };
  }, go);
  return h('div', { class: 'eco-form' }, h('div', { class: 'eco-form-grid' }, cap.el, days.el), pv, h('div', { class: 'row' }, go));
}

/* ── Your agreements ────────────────────────────────────────────────────── */

function myAgreements(ctx: EcoCtx) {
  const me = ctx.me!;
  const g = eco.galaxy!;
  const list = g.agreements.filter((a) => a.owner === me.playerId);
  return section('Renting', list.length ? 'Power you rent. Capacity changes keep your collateral and re-price the time left.' : 'Power you rent shows here.', [
    list.length ? h('div', { class: 'col', style: 'gap:6px' }, ...list.map((a) => agreementRow(ctx, a))) : empty('No rentals', 'You rent no power. Pick an offer above.'),
  ], { icon: 'power' });
}

function agreementRow(ctx: EcoCtx, a: AgreementRow) {
  const g = eco.galaxy!;
  const p = eco.provider(a.providerId);
  const rate = p ? big0(p.rate.amount) : 0n;
  const denom = p?.rate.denom || 'ualpha';
  const h0 = BigInt(Math.max(g.height, 0));
  const remaining = a.endBlock > h0 ? a.endBlock - h0 : 0n;
  const held = remaining * a.capacity * rate;
  const alloc = g.allocs.find((x) => x.id === a.allocationId);
  // "End", not "Close": the forms' own ✕ sits beside it, and this one costs a penalty.
  const close = btn('End', () => void act(ctx, {
    title: 'End agreement', tone: 'enemy', ok: 'End it', label: `End ${a.id}`,
    text: `End ${a.id} early. Of the ≈ ${amt(held, denom, 6)} collateral left, the provider keeps ${p ? decPct(p.consumerPenalty) : '?'}% as the cancellation penalty and the rest comes back to you. Allocation ${a.allocationId} (${powerText(a.capacity)}) disappears.`,
    msgs: [M('MsgAgreementClose', { agreementId: a.id })],
  }), 'ghost mini danger');
  const capF = disclose(ctx, 'ag-c:' + a.id, 'Resize', () => {
    const f = field(ctx, 'ag-cv:' + a.id, { placeholder: formatDecimal(a.capacity, 6), unit: 'kW', label: 'New power', hint: 'New capacity for this rental' });
    const go = btn('Apply', () => {
      const c = parsePower(f.input.value);
      if (!c || c === a.capacity || (p && capacityChangeProblems(termsOf(p), a.capacity, c, remaining, freeOn(p)).length)) return;
      const up = c > a.capacity;
      const nd = rescaledDuration(remaining, a.capacity, c);
      void act(ctx, {
        title: up ? 'Increase capacity' : 'Decrease capacity', label: `${a.id} → ${powerText(c)}`,
        text: `${a.id} goes from ${powerText(a.capacity)} to ${powerText(c)}. No new collateral: the ${remaining.toLocaleString()} blocks left re-price to about ${nd.toLocaleString()} blocks (≈ ${dur(nd)}).`,
        msgs: [M(up ? 'MsgAgreementCapacityIncrease' : 'MsgAgreementCapacityDecrease', { agreementId: a.id, [up ? 'capacityIncrease' : 'capacityDecrease']: (up ? c - a.capacity : a.capacity - c).toString() })],
      });
    }, 'solid mini');
    const pv = preview([f.input], () => {
      const c = parsePower(f.input.value);
      if (c == null || c <= 0n) return { lines: ['New capacity'], ok: false };
      if (!p) return { lines: [`Provider ${a.providerId} is gone`], ok: false, tone: 'enemy' };
      const probs = capacityChangeProblems(termsOf(p), a.capacity, c, remaining, freeOn(p));
      return { lines: [`Time left becomes ≈ ${dur(rescaledDuration(remaining, a.capacity, c))} (estimate)`, ...probs], ok: !probs.length, tone: probs.length ? 'enemy' : '' };
    }, go);
    return h('div', { class: 'eco-form inline' }, f.el, pv, go);
  });
  const durF = disclose(ctx, 'ag-d:' + a.id, 'Extend', () => {
    const f = field(ctx, 'ag-dv:' + a.id, { placeholder: '1', unit: 'days', label: 'Add', hint: 'Days to add to this rental' });
    const blocks = () => { const d = parseDecimal(f.input.value, 4); return d == null ? null : (d * perDay()) / 10_000n; };
    const bal = amountOf(ctx.me?.primary, denom);
    const probsOf = (b: bigint) => (p ? extendProblems(termsOf(p), a.startBlock, a.endBlock, b) : [`Provider ${a.providerId} is gone`]);
    const go = btn('Extend', () => {
      const b = blocks();
      if (!b || probsOf(b).length) return;
      void act(ctx, {
        title: 'Extend agreement', label: `Extend ${a.id} by ${dur(b)}`,
        text: `Add ${b.toLocaleString()} blocks (≈ ${dur(b)}) to ${a.id} at ${powerText(a.capacity)}: ${amt(durationIncreaseCost(a.capacity, b, rate), denom, 6)} more collateral leaves your wallet now.${ctx.me ? payNote(ctx.me) : ''}`,
        msgs: [M('MsgAgreementDurationIncrease', { agreementId: a.id, durationIncrease: b.toString() })],
      });
    }, 'solid mini');
    const pv = preview([f.input], () => {
      const b = blocks();
      if (b == null || b <= 0n) return { lines: ['Days to add'], ok: false };
      const cost = durationIncreaseCost(a.capacity, b, rate);
      const probs = [...probsOf(b), ...(cost > bal ? [`Not enough balance: the primary account holds ${amt(bal, denom, 6)}`] : [])];
      return { lines: [`${b.toLocaleString()} blocks · ${amt(cost, denom, 6)}`, ...probs], ok: !probs.length, tone: probs.length ? 'enemy' : '' };
    }, go);
    return h('div', { class: 'eco-form inline' }, f.el, pv, go);
  });
  return h('div', { class: 'eco-item' },
    h('div', { class: 'spread' }, h('span', { class: 'eco-id' }, `${a.id} · from ${a.providerId}`), h('span', { class: 'eco-num c-player' }, powerText(a.capacity))),
    h('div', { class: 'dct-stats' },
      remaining > 0n ? amount('clock', dur(remaining), `Time left (ends at block ${a.endBlock})`) : chip('expired', 'warn'),
      amount('lock', `≈ ${amt(held, denom)}`, 'Collateral left'),
      alloc ? (alloc.destinationId ? amount('send', alloc.destinationId, `Allocation ${alloc.id} feeds substation ${alloc.destinationId}`) : h('span', { title: `${alloc.id} is not connected: connect it on the Power tab` }, chip('not connected', 'warn'))) : null),
    h('div', { class: 'row wrap eco-row-acts' }, capF.button, durF.button, Object.assign(close, { title: 'End this rental early: the provider keeps a penalty' })), capF.holder, durF.holder);
}

/* ── Provider side ──────────────────────────────────────────────────────── */

type Pools = { earnings: Coin[]; collateral: Coin[]; earningsAddr: string };
/** Provider pool balances, re-read whenever the galaxy is (after our own transactions settle,
 * on Refresh, and when the chain reports economic changes); the old figures show meanwhile. */
const pools = new Map<string, { data: Pools | null; at: number; loading: boolean }>();
async function readPools(id: string) {
  const addr = async (kind: string) => {
    const r = await fetch(`${LCD_URL}/structs/${kind}/${encodeURIComponent(id)}`).then((x) => x.json()) as { internalAddressAssociation?: { address: string }[] };
    return r.internalAddressAssociation?.[0]?.address || '';
  };
  const [e, c] = await Promise.all([addr('provider_earnings_address'), addr('provider_collateral_address')]);
  const [earnings, collateral] = await Promise.all([e ? balancesOf(e) : [], c ? balancesOf(c) : []]);
  return { earnings, collateral, earningsAddr: e };
}

function myProviders(ctx: EcoCtx) {
  const me = ctx.me!;
  const g = eco.galaxy!;
  const list = g.providers.filter((p) => p.owner === me.playerId);
  if (!list.length) return null;
  return section('Selling', 'Power you sell. Earnings accrue as agreements run; withdraw them to your wallet.', [
    h('div', { class: 'col', style: 'gap:8px' }, ...list.map((p) => {
      const entry = pools.get(p.id);
      if (!entry || (entry.at !== g.loadedAt && !entry.loading)) {
        const at = g.loadedAt;
        pools.set(p.id, { data: entry?.data ?? null, at, loading: true });
        void readPools(p.id).then((r) => { pools.set(p.id, { data: r, at, loading: false }); ctx.repaint(); })
          .catch(() => { pools.set(p.id, { data: entry?.data ?? null, at, loading: false }); });
      }
      const pool = pools.get(p.id)?.data ?? null;
      const earned = pool ? amountOf(pool.earnings, p.rate.denom) : null;
      const escrow = pool ? amountOf(pool.collateral, p.rate.denom) : null;
      const ags = g.agreements.filter((a) => a.providerId === p.id);
      const t = termsOf(p);
      const upd = (key: string, label: string, short: string, msg: string, fieldName: string, unit: 'kW' | 'days', current: bigint) => disclose(ctx, key + p.id, short, () => {
        const f = field(ctx, key + 'v:' + p.id, { placeholder: unit === 'kW' ? formatDecimal(current, 6) : (Number(current) / Number(perDay())).toFixed(2), unit, label: short, hint: label });
        const value = () => (unit === 'kW' ? parsePower(f.input.value) : (() => { const d = parseDecimal(f.input.value, 4); return d == null ? null : (d * perDay()) / 10_000n; })());
        const go = btn('Update', () => {
          const v = value();
          if (v == null) return;
          void act(ctx, { title: label, label: `${p.id}: ${label.toLowerCase()} → ${unit === 'kW' ? powerText(v) : dur(v)}`, text: `Provider ${p.id}'s ${label.toLowerCase()} becomes ${unit === 'kW' ? powerText(v) : `${v.toLocaleString()} blocks (≈ ${dur(v)})`}. Running agreements keep their terms.`, msgs: [M(msg, { providerId: p.id, [fieldName]: v.toString() })] });
        }, 'solid mini');
        const pv = preview([f.input], () => { const v = value(); return v == null ? { lines: [unit === 'kW' ? 'Power' : 'Days'], ok: false } : { lines: [unit === 'kW' ? powerText(v) : `${v.toLocaleString()} blocks`], ok: true }; }, go);
        return h('div', { class: 'eco-form inline' }, f.el, pv, go);
      });
      const cmin = upd('pv-cmin:', 'Minimum capacity', 'Min kW', 'MsgProviderUpdateCapacityMinimum', 'newMinimumCapacity', 'kW', t.capMin);
      const cmax = upd('pv-cmax:', 'Maximum capacity', 'Max kW', 'MsgProviderUpdateCapacityMaximum', 'newMaximumCapacity', 'kW', t.capMax);
      const dmin = upd('pv-dmin:', 'Minimum duration', 'Min days', 'MsgProviderUpdateDurationMinimum', 'newMinimumDuration', 'days', t.durMin);
      const dmax = upd('pv-dmax:', 'Maximum duration', 'Max days', 'MsgProviderUpdateDurationMaximum', 'newMaximumDuration', 'days', t.durMax);
      [cmin, cmax, dmin, dmax].forEach((d, i) => { d.button.title = 'Change the ' + ['minimum capacity', 'maximum capacity', 'minimum duration', 'maximum duration'][i]; });
      const pol = select(ctx, 'pv-pol:' + p.id, [['openMarket', 'Open market'], ['guildMarket', 'Guild market'], ['closedMarket', 'Closed']], { value: p.accessPolicy, label: 'Access', hint: 'Who may rent from this provider' });
      pol.sel.addEventListener('change', () => {
        // Not a draft: the select always shows the policy the chain has, never a pending wish.
        ctx.drafts.delete('pv-pol:' + p.id);
        if (pol.sel.value === p.accessPolicy) return;
        void act(ctx, { title: 'Access policy', label: `${p.id} → ${pol.sel.value}`, text: `Provider ${p.id} becomes ${POLICY[pol.sel.value]?.[0] || pol.sel.value}. ${pol.sel.value === 'guildMarket' ? 'Only players holding the provider-open permission can rent.' : pol.sel.value === 'closedMarket' ? 'No new agreements; running ones continue.' : 'Any player can rent.'}`, msgs: [M('MsgProviderUpdateAccessPolicy', { providerId: p.id, accessPolicy: pol.sel.value })] })
          .then((ok) => { if (!ok) pol.sel.value = p.accessPolicy; });
      });
      return h('div', { class: 'eco-item' },
        h('div', { class: 'spread' }, h('span', { class: 'eco-id' }, `${p.id} · sells ${p.substationId}`), chip((POLICY[p.accessPolicy] || [p.accessPolicy])[0], (POLICY[p.accessPolicy] || ['', ''])[1])),
        h('div', { class: 'eco-tiles' },
          tile('Earned', earned == null ? '…' : amt(earned, p.rate.denom), 'swept so far · more accrues each block', earned ? 'player' : '', 'star'),
          tile('Escrow', escrow == null ? '…' : amt(escrow, p.rate.denom), 'consumers’ collateral', '', 'lock'),
          tile('Rentals', String(ags.length), `agreements running: ${powerText(p.load)}`, '', 'queue'),
          tile('Rate', amt(ratePerKwDay(t.rate, perDay()), p.rate.denom), 'per kW·day', '', 'market')),
        h('div', { class: 'row wrap eco-row-acts' },
          btn('Withdraw', () => void act(ctx, {
            title: 'Withdraw earnings', label: `Withdraw ${p.id} earnings`,
            text: `Sweep provider ${p.id}'s earnings to ${me.address}: at least ${earned != null ? amt(earned, p.rate.denom, 6) : 'what the earnings pool holds'}, plus whatever has accrued from running agreements since the last checkpoint (the chain sweeps that first).`,
            msgs: [M('MsgProviderWithdrawBalance', { providerId: p.id, destinationAddress: me.address })],
          }), earned ? 'solid mini' : 'mini'),
          pol.el, cmin.button, cmax.button, dmin.button, dmax.button,
          btn('Delete', () => void act(ctx, {
            title: 'Delete provider', tone: 'enemy', ok: 'Delete', label: `Delete ${p.id}`,
            text: `Retire provider ${p.id}.${ags.length ? ` Its ${ags.length} running agreement${ags.length > 1 ? 's end' : ' ends'} and consumers are refunded with the ${decPct(p.providerPenalty)}% provider penalty.` : ''} Withdraw earnings first.`,
            msgs: [M('MsgProviderDelete', { providerId: p.id })],
          }), 'ghost mini danger')),
        cmin.holder, cmax.holder, dmin.holder, dmax.holder,
        ags.length ? h('div', { class: 't-tiny c-hint' }, ags.map((a) => `${a.id}: ${powerText(a.capacity)} to ${store.playerName(a.owner)} until ${a.endBlock}`).join(' · ')) : null);
    })),
  ], { tone: 'neutral' });
}

function becomeProvider(ctx: EcoCtx) {
  const me = ctx.me!;
  const g = eco.galaxy!;
  const owned = [...g.subs.values()].filter((s) => s.owner === me.playerId);
  const f = disclose(ctx, 'prov-new', 'Start selling', () => {
    const sub = select(ctx, 'pn:sub', owned.map((s) => [s.id, `${s.id} · ${powerText(s.capacity - s.load > 0n ? s.capacity - s.load : 0n)} free`]), { label: 'Substation', hint: 'The substation whose spare power you sell' });
    const denoms: [string, string][] = [['ualpha', 'alpha (ualpha)'], ...g.banks.filter((b) => b.supply > 0n).map((b): [string, string] => [b.denom, `${b.unit} (${b.denom})`])];
    const denom = select(ctx, 'pn:denom', denoms, { label: 'Paid in', value: me.player.guildId ? `uguild.${me.player.guildId}` : 'ualpha' });
    const rate = field(ctx, 'pn:rate', { placeholder: '1', mode: 'numeric', unit: 'per mW·block', label: 'Rate', hint: 'Rate in base units of the coin, per milliwatt per block' });
    const pol = select(ctx, 'pn:pol', [['openMarket', 'Open market'], ['guildMarket', 'Guild market'], ['closedMarket', 'Closed (set up first)']], { label: 'Access', hint: 'Who may rent' });
    const pp = field(ctx, 'pn:pp', { placeholder: '0', unit: '%', label: 'Your penalty', hint: 'What you forfeit if you cancel a rental early' });
    const cp = field(ctx, 'pn:cp', { placeholder: '0', unit: '%', label: 'Their penalty', hint: 'What a renter forfeits if they cancel early' });
    const cmin = field(ctx, 'pn:cmin', { placeholder: '1', unit: 'kW', label: 'Min capacity' });
    const cmax = field(ctx, 'pn:cmax', { placeholder: '1000', unit: 'kW', label: 'Max capacity' });
    const dmin = field(ctx, 'pn:dmin', { placeholder: '0.1', unit: 'days', label: 'Min duration' });
    const dmax = field(ctx, 'pn:dmax', { placeholder: '30', unit: 'days', label: 'Max duration' });
    const days = (v: string) => { const d = parseDecimal(v, 4); return d == null ? null : (d * perDay()) / 10_000n; };
    /** "5" (%) → "0.05" (LegacyDec fraction); null outside 0–100. */
    const frac = (v: string) => { const x = parseDecimal(v || '0', 16); return x == null || x > 10n ** 18n ? null : formatDecimal(x, 18) || '0'; };
    const read = () => ({
      r: /^\d+$/.test(rate.input.value.trim()) ? BigInt(rate.input.value.trim()) : null,
      p1: frac(pp.input.value), p2: frac(cp.input.value),
      c1: parsePower(cmin.input.value || '1'), c2: parsePower(cmax.input.value || '1000'), d1: days(dmin.input.value || '0.1'), d2: days(dmax.input.value || '30'),
    });
    const go = btn('Create provider', () => {
      const v = read();
      if (!v.r || v.p1 == null || v.p2 == null || !v.c1 || !v.c2 || !v.d1 || !v.d2) return;
      void act(ctx, {
        title: 'Create provider', label: `Sell ${sub.sel.value} at ${v.r} ${denom.sel.value}/mW·block`,
        text: `Offer substation ${sub.sel.value}'s spare power at ${v.r} ${denom.sel.value} per mW per block (${amt(ratePerKwDay(v.r, perDay()), denom.sel.value)} per kW·day), ${POLICY[pol.sel.value]?.[0]} access, ${powerText(v.c1)}–${powerText(v.c2)} for ${dur(v.d1)}–${dur(v.d2)}. Cancel penalties: yours ${decPct(decOf(v.p1))}%, consumers' ${decPct(decOf(v.p2))}%.`,
        msgs: [M('MsgProviderCreate', {
          substationId: sub.sel.value, rate: { denom: denom.sel.value, amount: v.r.toString() }, accessPolicy: pol.sel.value,
          providerCancellationPenalty: v.p1, consumerCancellationPenalty: v.p2,
          capacityMinimum: v.c1.toString(), capacityMaximum: v.c2.toString(), durationMinimum: v.d1.toString(), durationMaximum: v.d2.toString(),
        })],
      });
    }, 'solid mini');
    const pv = preview([sub.sel, denom.sel, rate.input, pp.input, cp.input, cmin.input, cmax.input, dmin.input, dmax.input], () => {
      if (!owned.length) return { lines: ['You need a substation of your own to sell from (Power tab).'], ok: false, tone: 'warn' };
      const v = read();
      const errs: string[] = [];
      if (!v.r || v.r <= 0n) errs.push('Rate: a whole number ≥ 1 (base units per mW per block)');
      if (v.p1 == null || v.p2 == null) errs.push('Penalties are percentages from 0 to 100');
      if (!v.c1 || !v.c2 || v.c1 > v.c2) errs.push('Capacity range: min ≤ max');
      if (!v.d1 || !v.d2 || v.d1 > v.d2) errs.push('Duration range: min ≤ max');
      const priced = v.r ? inAlpha(ratePerKwDay(v.r, perDay()), denom.sel.value) : null;
      return { lines: [v.r ? `${amt(ratePerKwDay(v.r, perDay()), denom.sel.value)} per kW·day${priced != null && denom.sel.value !== 'ualpha' ? ` ≈ ${formatDecimal(priced, 6, { maxFrac: 3, group: true })} alpha` : ''}` : '', ...errs], ok: !errs.length, tone: errs.length ? 'enemy' : '' };
    }, go);
    return h('div', { class: 'eco-form' }, h('div', { class: 'eco-form-grid' }, sub.el, denom.el, rate.el, pol.el, pp.el, cp.el, cmin.el, cmax.el, dmin.el, dmax.el), pv, h('div', { class: 'row' }, go));
  }, 'mini');
  return section('Sell power', owned.length ? `You own ${owned.length} substation${owned.length > 1 ? 's' : ''}: list one on the market.` : 'Selling needs a substation of your own (create one on the Power tab).', [h('div', { class: 'row' }, f.button), f.holder], { icon: 'market' });
}
