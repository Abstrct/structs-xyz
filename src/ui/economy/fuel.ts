/* Reactors & fuel: every reactor (a guild's validator) with its fuel, commission and health,
 * the commander's infusions and defusing stake, and the verbs: infuse, defuse, migrate between
 * reactors, cancel a defusion, restart a jailed reactor. Yield previews are estimates: 1 ualpha
 * infused is 1 mW, less the reactor's commission. */
import { h } from '../../core/dom';
import { audio } from '../../core/audio';
import { guildLabel } from '../../guild/directory';
import {
  big0, decOf, decPct, formatDecimal, infusionYield, parseAlpha, whatIf, gridHealth,
} from '../../game/economy';
import { eco, amountOf, type Mine, type ReactorRow } from './data';
import { act, alphaEl, alphaNum, alphaText, amount, btn, chip, disclose, empty, enlistCta, field, kids, M, powerEl, powerText, preview, section, select, tile, type EcoCtx } from './kit';
import { empire } from '../../game/empire';
import { drawItems } from './power';
import { icon } from '../icons';

const STATUS: Record<string, [string, '' | 'player' | 'enemy' | 'warn']> = {
  BOND_STATUS_BONDED: ['bonded', 'player'], BOND_STATUS_UNBONDING: ['unbonding', 'warn'], BOND_STATUS_UNBONDED: ['unbonded', 'enemy'],
};

export function mountFuel(ctx: EcoCtx) {
  const me = ctx.me;
  ctx.host.replaceChildren(...kids(
    me ? mine(ctx, me) : enlistCta('Infusing alpha'),
    me ? defusing(ctx, me) : null,
    reactorsSection(ctx),
  ));
}

/** Working reactors as cards; stopped ones fold behind one pill (opened, it stays open). */
function reactorsSection(ctx: EcoCtx) {
  const g = eco.galaxy!;
  const broken = (r: ReactorRow) => !r.val || r.val.jailed || r.val.status !== 'BOND_STATUS_BONDED';
  const working = g.reactors.filter((r) => !broken(r));
  // A reactor holding your fuel always shows, working or not.
  const stopped = g.reactors.filter((r) => broken(r) && !stakeAt(ctx.me, r));
  const held = g.reactors.filter((r) => broken(r) && stakeAt(ctx.me, r));
  const all = ctx.drafts.get('fuel:stopped') === '1';
  return section('Reactors', `${g.reactors.length} reactors · put alpha in one as fuel and you get power back. The % is the share the reactor keeps.`, [
    h('div', { class: 'eco-cards' }, ...[...working, ...held, ...(all ? stopped : [])].map((r) => reactorCard(ctx, r))),
    stopped.length ? h('div', { class: 'row' }, h('button', {
      class: 'btn ghost mini', 'data-k': 'fold:stopped',
      title: all ? 'Hide the reactors that make no power' : `${stopped.length} reactors are stopped (their validator is jailed or not bonded): they make no power`,
      onclick: () => { ctx.drafts.set('fuel:stopped', all ? '0' : '1'); audio.play('select'); ctx.repaint(); },
    }, all ? 'Hide stopped' : `Stopped · ${stopped.length}`)) : null,
  ], { icon: 'fuel' });
}

function stakeAt(me: Mine | null, r: ReactorRow) {
  return me ? eco.infusionsOf(me.address).find((i) => i.destinationId === r.id) ?? null : null;
}

/* ── Your fuel ──────────────────────────────────────────────────────────── */

function mine(ctx: EcoCtx, me: Mine) {
  const inf = eco.infusionsOf(me.address);
  // Reactor infusions are stake (reversible); struct ones are alpha burned in a generator.
  const staked = inf.filter((i) => i.destinationType === 'reactor');
  const burned = inf.filter((i) => i.destinationType !== 'reactor');
  const sum = (l: typeof inf, f: (i: (typeof inf)[number]) => bigint) => l.reduce((a, i) => a + f(i), 0n);
  const yours = sum(inf, (i) => infusionYield(big0(i.power), decOf(i.commission)).player);
  const defusing = me.defusions.reduce((a, d) => a + d.balance, 0n);
  const liquid = amountOf(me.balances, 'ualpha');
  return section('My fuel', `${me.label} · ${me.playerId}`, [
    h('div', { class: 'eco-tiles' },
      tile('Fuel', alphaNum(sum(staked, (i) => big0(i.fuel)), 1), `alpha in ${staked.length} reactor${staked.length === 1 ? '' : 's'} · you can take it back out`, 'player', 'fuel'),
      burned.length ? tile('Burned', alphaNum(sum(burned, (i) => big0(i.fuel)), 1), `alpha burned in ${burned.length} generator${burned.length === 1 ? '' : 's'} · permanent`, 'neutral', 'fuel') : null,
      tile('Power', powerText(yours), 'the power it makes, after commission (est.)', 'player', 'power'),
      tile('Returning', alphaNum(defusing, 1), `alpha coming back out: ${me.defusions.length ? `${me.defusions.length} entr${me.defusions.length === 1 ? 'y' : 'ies'}` : 'none'}`, defusing ? 'warn' : '', 'clock'),
      tile('Wallet', alphaNum(liquid, 1), 'alpha in your wallet, ready to infuse', '', 'alpha')),
    staked.length ? h('div', { class: 'col', style: 'gap:6px' }, ...staked.map((i) => {
      const r = eco.reactor(i.destinationId);
      const y = infusionYield(big0(i.power), decOf(i.commission));
      const df = r ? disclose(ctx, 'df:' + r.id, 'Defuse', () => defuseForm(ctx, me, r, big0(i.fuel)), 'ghost mini danger') : null;
      const mg = r ? disclose(ctx, 'mg:' + r.id, 'Migrate', () => migrateForm(ctx, me, r, big0(i.fuel))) : null;
      const more = r ? disclose(ctx, 'if:' + r.id + ':mine', 'Infuse', () => infuseForm(ctx, me, r), 'solid mini') : null;
      return h('div', { class: 'eco-item' },
        h('div', { class: 'spread' },
          h('div', { class: 'row wrap', style: 'gap:6px; min-width:0' }, h('span', { class: 'eco-id' }, i.destinationId),
            h('span', { class: 't-tiny c-hint eco-ell' }, r ? (r.guildId ? guildLabel(r.guildId).name : r.val?.moniker || r.validator.slice(0, 18)) : '')),
          alphaEl(big0(i.fuel), 3, 'eco-num c-player')),
        h('div', { class: 'dct-stats' },
          powerEl(y.player, 'c-player', 'Power to you'), amount('power', `${powerText(y.reactor)} · ${decPct(decOf(i.commission))}%`, 'Power the reactor keeps (its commission)'),
          big0(i.defusing) ? h('span', { title: 'Alpha on its way back out' }, chip(`${formatDecimal(big0(i.defusing), 6, { maxFrac: 2 })} defusing`, 'warn')) : null),
        h('div', { class: 'row wrap eco-row-acts' }, ...kids(more?.button, df?.button, mg?.button)),
        more?.holder, df?.holder, mg?.holder);
    })) : empty('No fuel yet', 'No alpha infused in a reactor yet. Pick one below: your guild’s is usually the right home.'),
    ...burned.map((i) => {
      const t = empire.players.get(me.playerId)?.structs.get(i.destinationId)?.type;
      return h('div', { class: 'eco-item' },
        h('div', { class: 'spread' },
          h('div', { class: 'row wrap', style: 'gap:6px; min-width:0' }, h('span', { class: 'eco-id' }, i.destinationId), h('span', { class: 't-tiny c-hint', title: t ? `${t.generatingRate} kW per alpha` : null }, t ? t.type : 'Generator'),
            h('span', { title: 'Burned alpha cannot be defused, and a raider who destroys the generator takes the power with it.' }, chip('permanent', 'neutral'))),
          alphaEl(big0(i.fuel), 3, 'eco-num c-neutral')),
        h('div', { class: 'dct-stats' }, powerEl(big0(i.power), 'c-player', 'Power to you')));
    }),
  ], { tone: 'player', icon: 'fuel' });
}

function defusing(ctx: EcoCtx, me: Mine) {
  if (!me.defusions.length) return null;
  return section('Returning', 'Taking fuel back out: alpha on its way back to your wallet. Cancel to put it straight back into the reactor.', [
    h('div', { class: 'col', style: 'gap:6px' }, ...me.defusions.map((d) => {
      const r = eco.reactorByValidator(d.validator);
      const left = Date.parse(d.completionTime) - Date.now();
      // The chain refuses to cancel an entry already due (already_processed) or at a jailed validator.
      const jailed = !!(r?.val ?? eco.galaxy?.validators.get(d.validator))?.jailed;
      return h('div', { class: 'eco-item' },
        h('div', { class: 'spread' },
          h('span', { class: 'eco-id', title: `started at block ${d.creationHeight}` }, r?.id || d.validator.slice(0, 18)),
          alphaEl(d.balance, 3, 'eco-num c-warn')),
        h('div', { class: 'spread t-tiny c-hint' },
          left > 0 ? amount('clock', fmtLeft(left), `Returns ${new Date(d.completionTime).toLocaleString()}`) : chip('due now', 'player'),
          left <= 0 ? null : jailed ? h('span', { title: 'The validator is jailed: this defusion cannot be cancelled' }, chip('jailed', 'enemy')) : btn('Cancel', () => void act(ctx, {
            title: 'Cancel defusion', label: `Re-infuse ${alphaText(d.balance, 6)} at ${r?.id || 'reactor'}`,
            text: `Stop the defusion started at block ${d.creationHeight}: ${alphaText(d.balance, 6)} (${d.balance} ualpha) goes back into ${r?.id || d.validator} as fuel, restoring about ${powerText(infusionYield(d.balance, r?.defaultCommission ?? 0n).player)} of your capacity (estimate).`,
            msgs: [M('MsgReactorCancelDefusion', { delegator_address: me.address, validator_address: d.validator, amount: { denom: 'ualpha', amount: d.balance.toString() }, creation_height: d.creationHeight })],
          }), 'mini')));
    })),
  ], { tone: 'neutral', icon: 'clock' });
}

const fmtLeft = (ms: number) => { const s = Math.round(ms / 1000); return s >= 86400 ? `${(s / 86400).toFixed(1)}d` : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.max(1, Math.round(s / 60))}m`; };

/* ── Reactor cards ──────────────────────────────────────────────────────── */

function reactorCard(ctx: EcoCtx, r: ReactorRow) {
  const v = r.val;
  const [st, tone] = v ? (v.jailed ? ['jailed', 'enemy'] as const : STATUS[v.status] || [v.status, '']) : ['no validator', 'warn'] as const;
  const stake = stakeAt(ctx.me, r);
  const myGuild = ctx.me?.player.guildId;
  const home = !!myGuild && r.guildId === myGuild;
  const primary = [...(eco.galaxy?.guilds.values() || [])].some((gd) => gd.primaryReactorId === r.id);
  const inf = ctx.me ? disclose(ctx, 'if:' + r.id, 'Infuse', () => infuseForm(ctx, ctx.me!, r), home ? 'solid mini' : 'mini') : null;
  const restart = ctx.me && v && (v.jailed || v.status !== 'BOND_STATUS_BONDED');
  const broken = !v || v.jailed || v.status !== 'BOND_STATUS_BONDED';
  // A reactor card: whose it is, whether it works, and three numbers with pictures: its fuel,
  // the power it makes and the share it keeps.
  return h('div', { class: 'eco-card' + (home ? ' home' : '') + (broken ? ' broken' : ''), title: `${r.id}${primary ? ' · a guild’s primary reactor' : ''} · ${v?.moniker || r.validator} · ${r.guildId ? guildLabel(r.guildId).name : 'unaffiliated'}` },
    h('div', { class: 'spread' },
      h('div', { class: 'col', style: 'gap:1px; min-width:0' },
        h('span', { class: 't-label-lg eco-ell' }, r.guildId ? guildLabel(r.guildId).name : v?.moniker || r.id),
        h('span', { class: 't-tiny c-hint eco-ell x-only' }, `${r.id}${primary ? ' · primary' : ''} · ${v?.moniker || r.validator.slice(0, 20)}`)),
      // Expert mode names the validator state; plain mode shows whether the reactor is making power.
      h('span', { class: 'x-only' }, chip(st, tone)),
      h('span', { class: 's-only dct-state ' + (broken ? 'off' : 'on'), title: broken ? 'Stopped: makes no power' : 'Working: makes power', 'aria-label': broken ? 'Stopped' : 'Working', html: icon(broken ? 'mute' : 'check', 14) })),
    h('div', { class: 'dct-stats' },
      amount('fuel', alphaNum(r.fuel, 1), `Fuel: ${alphaText(r.fuel, 6)}`),
      powerEl(r.capacity, '', 'Power it makes'),
      amount('bank', `${decPct(r.defaultCommission)}%`, 'Reactor keeps this share of the power'),
      h('span', { class: 'x-only' }, amount('lock', v ? `${decPct(v.commission)}%` : '—', 'Validator fee')),
      stake ? alphaEl(big0(stake.fuel), 3, 'c-player') : null),
    h('div', { class: 'row wrap eco-row-acts' }, ...kids(inf?.button, restart ? btn('Restart', () => void act(ctx, {
      title: 'Restart reactor', label: `Restart ${r.id}`,
      text: `Reconcile ${r.id}'s infusions with the validator's live staking state. Anyone may send this: it only writes what staking already says, so it restores energy to a validator that unjailed but was never rebonded (or gates a jailed one).`,
      msgs: [M('MsgReactorRestart', { validator_address: r.validator })],
    }), 'ghost mini') : null)),
    inf?.holder);
}

/* ── Forms ──────────────────────────────────────────────────────────────── */

function amountField(ctx: EcoCtx, key: string, max: bigint, label = 'Put in', hint = 'Alpha to put in') {
  const f = field(ctx, key, { placeholder: '0', unit: 'alpha', label, hint });
  const maxBtn = btn('Max', () => { f.input.value = formatDecimal(max, 6); ctx.drafts.set(key, f.input.value); f.input.dispatchEvent(new Event('input')); }, 'ghost mini');
  return { ...f, el: h('div', { class: 'row', style: 'align-items:flex-end' }, f.el, maxBtn) };
}

function infuseForm(ctx: EcoCtx, me: Mine, r: ReactorRow) {
  const liquid = amountOf(me.balances, 'ualpha');
  const a = amountField(ctx, 'if-v:' + r.id, liquid);
  const go = btn('Infuse', () => {
    const u = parseAlpha(a.input.value);
    if (!u) return;
    const y = infusionYield(u, r.defaultCommission);
    const jailed = !!r.val?.jailed;
    void act(ctx, {
      title: 'Infuse alpha', label: `Infuse ${alphaText(u, 6)} → ${r.id}`, tone: jailed ? 'enemy' : 'player',
      text: `${me.label} stakes ${alphaText(u, 6)} (${u} ualpha) with ${r.val?.moniker || r.validator} (reactor ${r.id}). ${jailed
        ? `Warning: this validator is jailed, and the chain gives a jailed reactor's infusions no energy: you gain no capacity until it unjails and the reactor is restarted (then about +${powerText(y.player)}).`
        : `Estimated: +${powerText(y.player)} capacity for you, ${powerText(y.reactor)} kept by the reactor (${decPct(r.defaultCommission)}%).`} Getting it back takes a defusion of about ${Math.round((eco.galaxy?.unbondingSeconds ?? 345600) / 86400)} days.`,
      msgs: [M('MsgReactorInfuse', { delegator_address: me.address, validator_address: r.validator, amount: { denom: 'ualpha', amount: u.toString() } })],
    });
  }, 'solid mini');
  const pv = preview([a.input], () => {
    const u = parseAlpha(a.input.value);
    if (u == null || u <= 0n) return { lines: ['Alpha to infuse: 2.5, 250 mg, 1 kg…'], ok: false };
    if (u > liquid) return { lines: [`You hold ${alphaText(liquid)}`], ok: false, tone: 'enemy' };
    const y = infusionYield(u, r.defaultCommission);
    const after = gridHealth({ ...me.grid, capacity: me.grid.capacity + y.player });
    // Energy is zeroed for jailed validators only (reactor_energy.go); unbonded-but-free still yields.
    const jailed = !!r.val?.jailed;
    return { lines: jailed ? ['This reactor’s validator is jailed: the infusion yields no capacity until it unjails and is restarted.', `(then ≈ +${powerText(y.player)})`]
      : [`≈ +${powerText(y.player)} capacity (estimate) → headroom ${powerText(after.headroom)}`], ok: true, tone: jailed ? 'warn' : '' };
  }, go);
  return h('div', { class: 'eco-form inline' }, a.el, pv, go);
}

function defuseForm(ctx: EcoCtx, me: Mine, r: ReactorRow, staked: bigint) {
  const a = amountField(ctx, 'df-v:' + r.id, staked, 'Take out', 'Alpha to take out');
  const outs = eco.allocsFrom(me.playerId).map((x) => ({ id: x.id, power: x.power, type: x.type, destinationId: x.destinationId }));
  const items = drawItems(me.playerId) || [];
  const go = btn('Defuse', () => {
    const u = parseAlpha(a.input.value);
    if (!u) return;
    const loss = infusionYield(u, r.defaultCommission).player;
    const w = whatIf(me.grid, loss, outs, items, me.player.substationId ? eco.galaxy?.subs.get(me.player.substationId) ?? null : null);
    void act(ctx, {
      title: 'Defuse alpha', tone: 'enemy', ok: 'Defuse', label: `Defuse ${alphaText(u, 6)} from ${r.id}`,
      text: `Withdraw ${alphaText(u, 6)} (${u} ualpha) from reactor ${r.id}. It returns to your wallet in about ${Math.round((eco.galaxy?.unbondingSeconds ?? 345600) / 86400)} days. Your capacity drops by about ${powerText(loss)} now${w.cascade.victims.length ? `; the chain then destroys allocation${w.cascade.victims.length > 1 ? 's' : ''} ${w.cascade.victims.map((v) => v.id).join(', ')}` : ''}${w.after.online ? '.' : ' and you go dark (structs halted).'}`,
      msgs: [M('MsgReactorDefuse', { delegator_address: me.address, validator_address: r.validator, amount: { denom: 'ualpha', amount: u.toString() } })],
    });
  }, 'danger mini');
  const pv = preview([a.input], () => {
    const u = parseAlpha(a.input.value);
    if (u == null || u <= 0n) return { lines: ['Alpha to defuse'], ok: false };
    if (u > staked) return { lines: [`Only ${alphaText(staked)} infused here`], ok: false, tone: 'enemy' };
    const loss = infusionYield(u, r.defaultCommission).player;
    const w = whatIf(me.grid, loss, outs, items, me.player.substationId ? eco.galaxy?.subs.get(me.player.substationId) ?? null : null);
    return {
      lines: [`≈ −${powerText(loss)} capacity (estimate) → headroom ${powerText(w.after.headroom)}`,
        w.cascade.victims.length ? `Brownout: allocation${w.cascade.victims.length > 1 ? 's' : ''} ${w.cascade.victims.map((v) => v.id).join(', ')} would be destroyed` : '',
        !w.after.online ? `You would go dark ${powerText(w.deficit)} short: power down ${w.pause.plan.map((p) => p.name).join(', ') || 'structs'} first` : ''],
      ok: true, tone: !w.after.online || w.cascade.victims.length ? 'enemy' : '',
    };
  }, go);
  return h('div', { class: 'eco-form inline' }, a.el, pv, go);
}

function migrateForm(ctx: EcoCtx, me: Mine, from: ReactorRow, staked: bigint) {
  const others = (eco.galaxy?.reactors || []).filter((r) => r.id !== from.id && r.val && !r.val.jailed);
  const to = select(ctx, 'mg-to:' + from.id, others.map((r) => [r.id, `${r.id} · ${r.val?.moniker || ''} · ${r.guildId ? guildLabel(r.guildId).tag : '—'} · keeps ${decPct(r.defaultCommission)}%`]), { label: 'To', hint: 'The reactor that takes the fuel' });
  const a = amountField(ctx, 'mg-v:' + from.id, staked, 'Move', 'Alpha to move');
  const go = btn('Migrate', () => {
    const u = parseAlpha(a.input.value);
    const dst = others.find((r) => r.id === to.sel.value);
    if (!u || !dst) return;
    void act(ctx, {
      title: 'Migrate fuel', label: `Migrate ${alphaText(u, 6)} ${from.id} → ${dst.id}`,
      text: `Move ${alphaText(u, 6)} (${u} ualpha) of infusion from ${from.id} to ${dst.id} without defusing (a redelegation): no waiting period, no capacity gap. The new reactor keeps ${decPct(dst.defaultCommission)}% instead of ${decPct(from.defaultCommission)}%.`,
      msgs: [M('MsgReactorBeginMigration', { delegator_address: me.address, validator_src_address: from.validator, validator_dst_address: dst.validator, amount: { denom: 'ualpha', amount: u.toString() } })],
    });
  }, 'solid mini');
  const pv = preview([a.input, to.sel], () => {
    const u = parseAlpha(a.input.value);
    const dst = others.find((r) => r.id === to.sel.value);
    if (!dst) return { lines: ['No other reactor accepts fuel'], ok: false };
    if (u == null || u <= 0n) return { lines: ['Alpha to move'], ok: false };
    if (u > staked) return { lines: [`Only ${alphaText(staked)} infused here`], ok: false, tone: 'enemy' };
    const d = infusionYield(u, dst.defaultCommission).player - infusionYield(u, from.defaultCommission).player;
    return { lines: [`Capacity change ≈ ${d >= 0n ? '+' : '−'}${powerText(d >= 0n ? d : -d)} (estimate)`], ok: true };
  }, go);
  return h('div', { class: 'eco-form inline' }, to.el, a.el, pv, go);
}

