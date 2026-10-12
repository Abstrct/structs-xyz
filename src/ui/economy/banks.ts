/* Guild banks: each guild's token (uguild.<id>) is backed by alpha in a collateral pool. The
 * ratio is collateral ÷ supply. Convert alpha in, redeem tokens out, or swap one guild's token
 * for another's in one atomic step; every trade carries a minimum-out guard computed from the
 * slippage you pick, so a ratio or fee change earlier in the block can't fill you worse. */
import { h } from '../../core/dom';
import { audio } from '../../core/audio';
import {
  convertQuote, convertTokenQuote, decPct, formatDecimal, guardFor, parseAlpha, parseDecimal, ratio, redeemQuote, slippageBps,
} from '../../game/economy';
import { eco, amountOf, type BankRow, type Mine } from './data';
import { act, alphaEl, alphaNum, alphaText, amount, btn, chip, disclose, empty, enlistCta, field, kids, M, preview, select, shortAddr, tile, tokenText, type EcoCtx } from './kit';
import { icon } from '../icons';

const SLIPS = ['0.1', '0.5', '1', '3'];

/** The guard in basis points, or null when the box holds something we can't read: never fall
 * back to a default while the box shows the user's own (different) text. */
function slippage(ctx: EcoCtx): number | null { return slippageBps(ctx.drafts.get('bk:slip') || '0.5'); }
const slipText = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
const SLIP_BAD = 'Slippage must be a percentage from 0 to 100 with at most two decimals (0.5 means 0.5%)';

/** The chain trades from the player's primary account, which may not be the signing one. */
const fromNote = (me: Mine) => (me.primaryAddress !== me.address ? ` Funds move in and out of ${me.player.id}'s primary account ${shortAddr(me.primaryAddress)}, not the signing account.` : '');

export function mountBanks(ctx: EcoCtx) {
  const g = eco.galaxy!;
  const banks = [...g.banks].sort((a, b) => (b.collateral > a.collateral ? 1 : b.collateral < a.collateral ? -1 : 0));
  const pooled = banks.reduce((a, b) => a + b.collateral, 0n);
  const custom = field(ctx, 'bk:slip', { placeholder: '0.5', unit: '%', label: 'Slippage', width: '70px' });
  custom.input.addEventListener('change', () => ctx.repaint());
  const bps = slippage(ctx);
  // The slippage guard is an expert's dial; everyone else trades at the 0.5% default. A guard
  // that can't be read (trades are off until it is) shows to everyone, so it can be fixed.
  const slipBar = h('div', { class: 'row wrap eco-filters' + (bps == null ? '' : ' x-only') },
    h('span', { class: 't-label c-hint' }, 'Guard'),
    ...SLIPS.map((s) => h('button', { class: 'btn ghost mini' + ((ctx.drafts.get('bk:slip') || '0.5') === s ? ' active' : ''), onclick: () => { ctx.drafts.set('bk:slip', s); audio.play('select'); ctx.repaint(); } }, `${s}%`)),
    custom.el,
    bps == null ? h('span', { class: 't-tiny c-enemy' }, SLIP_BAD + '. Trades are off until it reads.')
      : h('span', { class: 't-tiny c-hint' }, `Every trade refuses to fill more than ${slipText(bps)} below its quote.`));
  ctx.host.replaceChildren(...kids(
    h('div', { class: 'eco-tiles' },
      tile('Banks', String(banks.length), `guild banks: ${banks.filter((b) => b.supply > 0n).length} with tokens out`, '', 'bank'),
      tile('Backing', alphaNum(pooled, 2), 'alpha in the banks, backing every guild token', 'player', 'alpha'),
      ctx.me ? tile('Held', String(ctx.me.primary.filter((c) => c.denom.startsWith('uguild.')).length), 'kinds of guild token you hold', '', 'star') : null),
    slipBar,
    ctx.me ? null : enlistCta('Trading guild tokens'),
    banks.length ? h('div', { class: 'eco-banks' }, ...banks.map((b) => bankCard(ctx, b))) : empty('No banks', 'No guild banks on chain.'),
  ));
}

function bankCard(ctx: EcoCtx, b: BankRow) {
  const me = ctx.me;
  const held = me ? amountOf(me.primary, b.denom) : 0n;
  const worth = held > 0n ? redeemQuote(held, b) : null;
  const live = b.supply > 0n && b.collateral > 0n;
  const isOwner = !!me && me.playerId === b.owner;
  const r = ratio(b);
  const cv = me && live ? disclose(ctx, 'cv:' + b.guildId, 'Buy', () => convertForm(ctx, b), 'solid mini') : null;
  const rd = me && live && held > 0n ? disclose(ctx, 'rd:' + b.guildId, 'Redeem', () => redeemForm(ctx, b, held)) : null;
  const sw = me && live && held > 0n ? disclose(ctx, 'sw:' + b.guildId, 'Swap', () => swapForm(ctx, b, held)) : null;
  const mt = isOwner ? disclose(ctx, 'mt:' + b.guildId, 'Mint', () => mintForm(ctx, b), 'ghost mini') : null;
  if (cv) cv.button.title = `Convert alpha in: buy ${b.unit}`;
  if (rd) rd.button.title = `Redeem ${b.unit} for alpha`;
  if (sw) sw.button.title = `Swap ${b.unit} for another guild’s token`;
  const unitName = h('span', { class: 'eco-bank-unit' }, b.unit);
  // A bank card: the guild and its coin, the exchange rate as "1 COIN = ◆ n", then the numbers
  // behind it with pictures (the words are their hovers).
  return h('div', { class: 'eco-bank panel' + (me?.player.guildId === b.guildId ? ' home' : '') },
    h('div', { class: 'spread' },
      h('div', { class: 'col', style: 'gap:1px; min-width:0' },
        h('span', { class: 'eco-bank-name', title: `${b.name} · ${b.tag} · ${b.guildId} · ${b.denom}` }, b.name),
        h('span', { class: 't-label c-hint x-only' }, `${b.tag} · ${b.guildId} · ${b.denom}`)),
      isOwner ? h('span', { title: 'Your guild’s treasury' }, chip('treasury', 'neutral')) : null),
    // Tiny ratios read better upside down: "1 alpha = 52,930 BLEEP" beats "1 BLEEP = 0.0000189 alpha".
    h('div', { class: 'eco-ratio', title: !live ? 'No exchange rate yet' : `Exchange rate: ${r.toPrecision(4)} alpha per ${b.unit}` }, ...(!live ? [h('span', { class: 'eco-big c-hint' }, '—'), unitName]
      : r >= 0.01 ? [h('span', { class: 'eco-big' }, '1'), unitName, h('span', { class: 'eco-eq' }, '='), alphaEl(BigInt(Math.round(r * 1e6)), r >= 100 ? 1 : 3, 'eco-big c-player')]
      : [h('span', { class: 'eco-big' }, h('span', { class: 'eco-tile-ico k-alpha', html: icon('alpha', 20) }), '1'), h('span', { class: 'eco-eq' }, '='), h('span', { class: 'eco-big c-player' }, formatDecimal((b.supply * 1_000_000n) / b.collateral, 6, { maxFrac: 0, group: true })), unitName])),
    h('div', { class: 'dct-stats' },
      amount('alpha', alphaNum(b.collateral, 3), `Collateral: ${alphaText(b.collateral, 6)} backs the tokens`),
      amount('bank', tokenText(b.supply, b.unit, 2), 'Supply: tokens in circulation'),
      amount('send', `${decPct(b.inFee)}% · ${decPct(b.outFee)}%`, `Fees: in ${decPct(b.inFee)}% · out ${decPct(b.outFee)}%`)),
    me ? h('div', { class: 'dct-stats c-player', title: 'You hold' }, amount('star', held ? `${tokenText(held, b.unit, 3)}${worth?.ok ? ` ≈ ${alphaNum(worth.alpha)}` : ''}` : '—', `You hold${worth?.ok ? `: worth ${alphaText(worth.alpha)}` : ''}`)) : null,
    !live ? h('span', { title: b.supply > 0n ? 'Tokens exist but no collateral backs them: nothing to redeem.' : 'Not opened yet: the guild mints the first tokens to set the ratio.' }, chip(b.supply > 0n ? 'unbacked' : 'not open', 'warn')) : null,
    me ? h('div', { class: 'row wrap eco-row-acts' }, ...kids(cv?.button, rd?.button, sw?.button, mt?.button)) : null,
    cv?.holder, rd?.holder, sw?.holder, mt?.holder);
}

function convertForm(ctx: EcoCtx, b: BankRow) {
  const me = ctx.me!;
  const liquid = amountOf(me.primary, 'ualpha');
  const f = field(ctx, 'cv-v:' + b.guildId, { placeholder: '0', unit: 'alpha', label: 'Alpha in', hint: `Alpha you put in to get ${b.unit}` });
  const go = btn('Convert', () => {
    const a = parseAlpha(f.input.value);
    const q = a ? convertQuote(a, b) : null;
    const bps = slippage(ctx);
    if (!a || !q?.ok || bps == null) return;
    const min = guardFor(q.tokens, bps);
    void act(ctx, {
      title: `Buy ${b.unit}`, label: `Convert ${alphaText(a, 6)} → ${b.unit}`,
      text: `${alphaText(a, 6)} (${a} ualpha) goes into ${b.name}'s collateral pool (fee ${alphaText(q.fee, 6)} stays there). You receive ${tokenText(q.tokens, b.unit, 6)} at today's ratio, and with your ${slipText(bps)} slippage guard the trade fails rather than give you under ${tokenText(min, b.unit, 6)}.${fromNote(me)}`,
      msgs: [M('MsgGuildBankConvert', { guildId: b.guildId, amountAlpha: a.toString(), minAmountToken: min.toString() })],
    });
  }, 'solid mini');
  const pv = preview([f.input], () => {
    const a = parseAlpha(f.input.value);
    if (a == null || a <= 0n) return { lines: ['Alpha to convert'], ok: false };
    if (a > liquid) return { lines: [`You hold ${alphaText(liquid)}`], ok: false, tone: 'enemy' };
    const q = convertQuote(a, b);
    if (!q.ok) return { lines: [q.reason], ok: false, tone: 'enemy' };
    const bps = slippage(ctx);
    if (bps == null) return { lines: [`→ ${tokenText(q.tokens, b.unit, 6)}`, SLIP_BAD], ok: false, tone: 'enemy' };
    return { lines: [`→ ${tokenText(q.tokens, b.unit, 6)}`, `guard (${slipText(bps)}): at least ${tokenText(guardFor(q.tokens, bps), b.unit, 6)}${q.fee ? ` · fee ${alphaText(q.fee)}` : ''}`], ok: true };
  }, go);
  return h('div', { class: 'eco-form inline' }, f.el, pv, go);
}

function tokenField(ctx: EcoCtx, key: string, b: BankRow, held: bigint) {
  const f = field(ctx, key, { placeholder: '0', unit: b.unit, label: `${b.unit} in`, hint: `How many ${b.unit} you put in` });
  const max = btn('Max', () => { f.input.value = formatDecimal(held, 6); ctx.drafts.set(key, f.input.value); f.input.dispatchEvent(new Event('input')); }, 'ghost mini');
  return { input: f.input, el: h('div', { class: 'row', style: 'align-items:flex-end' }, f.el, max) };
}

function redeemForm(ctx: EcoCtx, b: BankRow, held: bigint) {
  const f = tokenField(ctx, 'rd-v:' + b.guildId, b, held);
  const go = btn('Redeem', () => {
    const t = parseDecimal(f.input.value, 6);
    const q = t ? redeemQuote(t, b) : null;
    const bps = slippage(ctx);
    if (!t || !q?.ok || bps == null) return;
    const min = guardFor(q.alpha, bps);
    void act(ctx, {
      title: `Redeem ${b.unit}`, label: `Redeem ${tokenText(t, b.unit, 6)} → alpha`,
      text: `Burn ${tokenText(t, b.unit, 6)} for its share of ${b.name}'s collateral: ${alphaText(q.alpha, 6)} to you${q.fee ? ` after a ${alphaText(q.fee, 6)} out fee` : ''}. With your ${slipText(bps)} slippage guard the trade fails rather than pay under ${alphaText(min, 6)}.${fromNote(ctx.me!)}`,
      msgs: [M('MsgGuildBankRedeem', { amountToken: { denom: b.denom, amount: t.toString() }, minAmountAlpha: min.toString() })],
    });
  }, 'solid mini');
  const pv = preview([f.input], () => {
    const t = parseDecimal(f.input.value, 6);
    if (t == null || t <= 0n) return { lines: [`${b.unit} to redeem`], ok: false };
    if (t > held) return { lines: [`You hold ${tokenText(held, b.unit, 6)}`], ok: false, tone: 'enemy' };
    const q = redeemQuote(t, b);
    if (!q.ok) return { lines: [q.reason], ok: false, tone: 'enemy' };
    const bps = slippage(ctx);
    if (bps == null) return { lines: [`→ ${alphaText(q.alpha, 6)}`, SLIP_BAD], ok: false, tone: 'enemy' };
    return { lines: [`→ ${alphaText(q.alpha, 6)}`, `guard (${slipText(bps)}): at least ${alphaText(guardFor(q.alpha, bps), 6)}`], ok: true };
  }, go);
  return h('div', { class: 'eco-form inline' }, f.el, pv, go);
}

function swapForm(ctx: EcoCtx, src: BankRow, held: bigint) {
  const targets = (eco.galaxy?.banks || []).filter((x) => x.guildId !== src.guildId && x.supply > 0n && x.collateral > 0n);
  if (!targets.length) return empty('Nothing to swap into', 'No other guild bank is open to swap into.');
  const to = select(ctx, 'sw-to:' + src.guildId, targets.map((x) => [x.guildId, `${x.unit} · ${x.name}`]), { label: 'Into' });
  const f = tokenField(ctx, 'sw-v:' + src.guildId, src, held);
  const target = () => targets.find((x) => x.guildId === to.sel.value)!;
  const go = btn('Swap', () => {
    const t = parseDecimal(f.input.value, 6);
    const dst = target();
    const q = t ? convertTokenQuote(t, src, dst) : null;
    const bps = slippage(ctx);
    if (!t || !q?.ok || bps == null) return;
    const min = guardFor(q.tokens, bps);
    void act(ctx, {
      title: `Swap ${src.unit} → ${dst.unit}`, label: `Swap ${tokenText(t, src.unit, 6)} → ${dst.unit}`,
      text: `In one transaction: redeem ${tokenText(t, src.unit, 6)} at ${src.name} (≈ ${alphaText(q.bridge, 6)}), then convert that alpha at ${dst.name} for ${tokenText(q.tokens, dst.unit, 6)}. With your ${slipText(bps)} slippage guard it fails rather than deliver under ${tokenText(min, dst.unit, 6)}.${fromNote(ctx.me!)}`,
      msgs: [M('MsgGuildBankConvertToken', { amountToken: { denom: src.denom, amount: t.toString() }, guildId: dst.guildId, minAmountToken: min.toString() })],
    });
  }, 'solid mini');
  const pv = preview([f.input, to.sel], () => {
    const t = parseDecimal(f.input.value, 6);
    if (t == null || t <= 0n) return { lines: [`${src.unit} to swap`], ok: false };
    if (t > held) return { lines: [`You hold ${tokenText(held, src.unit, 6)}`], ok: false, tone: 'enemy' };
    const dst = target();
    const q = convertTokenQuote(t, src, dst);
    if (!q.ok) return { lines: [q.reason], ok: false, tone: 'enemy' };
    const bps = slippage(ctx);
    if (bps == null) return { lines: [`→ ${tokenText(q.tokens, dst.unit, 6)} (via ${alphaText(q.bridge, 6)})`, SLIP_BAD], ok: false, tone: 'enemy' };
    return { lines: [`→ ${tokenText(q.tokens, dst.unit, 6)} (via ${alphaText(q.bridge, 6)})`, `guard (${slipText(bps)}): at least ${tokenText(guardFor(q.tokens, bps), dst.unit, 6)}`], ok: true };
  }, go);
  return h('div', { class: 'eco-form inline' }, to.el, f.el, pv, go);
}

function mintForm(ctx: EcoCtx, b: BankRow) {
  const a = field(ctx, 'mt-a:' + b.guildId, { placeholder: '0', unit: 'alpha', label: 'Alpha in', hint: 'Alpha deposited as collateral' });
  const t = field(ctx, 'mt-t:' + b.guildId, { placeholder: '0', unit: b.unit, label: `${b.unit} out`, hint: `${b.unit} minted to you` });
  const go = btn('Mint', () => {
    const al = parseAlpha(a.input.value), tk = parseDecimal(t.input.value, 6);
    if (!al || !tk) return;
    void act(ctx, {
      title: `Mint ${b.unit}`, label: `Mint ${tokenText(tk, b.unit, 6)} for ${alphaText(al, 6)}`,
      text: `Guild treasury action: deposit ${alphaText(al, 6)} as collateral and mint ${tokenText(tk, b.unit, 6)} to yourself, at a ratio you set (${formatRatio(al, tk)} alpha per ${b.unit}). Needs the guild's token-mint permission.${fromNote(ctx.me!)}`,
      msgs: [M('MsgGuildBankMint', { guildId: b.guildId, amountAlpha: al.toString(), amountToken: tk.toString() })],
    });
  }, 'solid mini');
  const pv = preview([a.input, t.input], () => {
    const al = parseAlpha(a.input.value), tk = parseDecimal(t.input.value, 6);
    if (!al || !tk) return { lines: ['Alpha deposited and tokens minted'], ok: false };
    const liquid = amountOf(ctx.me?.primary, 'ualpha');
    if (al > liquid) return { lines: [`The primary account holds ${alphaText(liquid)}`], ok: false, tone: 'enemy' };
    const mintR = Number((al * 1_000_000_000n) / tk) / 1e9;
    const cur = ratio(b);
    const dilutes = cur > 0 && mintR < cur;
    return { lines: [`Mint ratio ${formatRatio(al, tk)} vs bank ${cur ? cur.toPrecision(4) : '—'}`, dilutes ? 'Below the current ratio: this dilutes every holder.' : ''], ok: true, tone: dilutes ? 'warn' : '' };
  }, go);
  return h('div', { class: 'eco-form inline' }, a.el, t.el, pv, go);
}

const formatRatio = (alpha: bigint, token: bigint) => (Number((alpha * 1_000_000_000n) / token) / 1e9).toPrecision(4);
