/* Transfers: what every account in this wallet holds, a sender for any denom between your own
 * accounts or to anyone (by address or player id), and the alpha unit ladder. Amounts typed in
 * alpha become ualpha through exact decimal parsing, never a float. */
import { h, copyText } from '../../core/dom';
import { store } from '../../chain/store';
import { lcd } from '../../chain/lcd';
import { wallet } from '../../wallet/wallet';
import { isAddress } from '../../wallet/keys';
import { alphaLadder, formatDecimal, guildOfDenom, parseAlpha, parseDecimal, redeemQuote } from '../../game/economy';
import { eco, amountOf, type Coin } from './data';
import { act, alphaNum, alphaText, amount, btn, chip, empty, enlistCta, field, kids, M, powerText, preview, section, select, tile, tokenText, type EcoCtx } from './kit';

/** Base units for a typed amount of `denom`: alpha accepts the whole ladder (mg, g, kg). */
function parseAmount(v: string, denom: string): bigint | null {
  if (denom === 'ualpha') return parseAlpha(v);
  if (guildOfDenom(denom)) return parseDecimal(v, 6);
  return /^\s*\d+\s*$/.test(v) ? BigInt(v.trim()) : null;
}
function showAmount(v: bigint, denom: string, maxFrac = 6): string {
  if (denom === 'ualpha') return alphaText(v, maxFrac);
  if (guildOfDenom(denom)) return tokenText(v, eco.denomLabel(denom), maxFrac);
  return `${v.toLocaleString()} ${denom}`;
}
/** Alpha a holding is worth (guild tokens at their bank's redemption value). */
function alphaWorth(c: Coin): bigint | null {
  const a = BigInt(c.amount || '0');
  if (c.denom === 'ualpha') return a;
  const gid = guildOfDenom(c.denom);
  const b = gid ? eco.bank(gid) : null;
  const q = b ? redeemQuote(a, b) : null;
  return q?.ok ? q.alpha : null;
}

const resolved = new Map<string, string | null>();

export function mountTransfers(ctx: EcoCtx) {
  const accts = wallet.accounts;
  const totals = new Map<string, bigint>();
  for (const a of accts) for (const c of eco.wallets.get(a.address) || []) totals.set(c.denom, (totals.get(c.denom) || 0n) + BigInt(c.amount || '0'));
  const worth = [...totals].reduce((s, [denom, amount]) => s + (alphaWorth({ denom, amount: amount.toString() }) ?? 0n), 0n);
  ctx.host.replaceChildren(...kids(
    accts.length ? h('div', { class: 'eco-tiles' },
      tile('Alpha', alphaNum(totals.get('ualpha') || 0n, 1), `alpha across ${accts.length} account${accts.length > 1 ? 's' : ''}`, 'player', 'alpha'),
      tile('Worth', alphaNum(worth, 1), 'everything, in alpha: guild tokens at redemption value', '', 'star'),
      tile('Coins', String(totals.size), `kinds of coin held: ${[...totals.keys()].map((d) => eco.denomLabel(d)).join(' · ') || '—'}`, '', 'bank')) : enlistCta('Sending alpha'),
    h('div', { class: 'eco-cols' },
      h('div', { class: 'eco-col' },
        accts.length ? section('Accounts', 'Everything this vault holds, account by account.', [h('div', { class: 'col', style: 'gap:6px' }, ...accts.map((a) => {
          const coins = eco.wallets.get(a.address);
          return h('div', { class: 'eco-item' + (a.index === wallet.activeIndex ? ' home' : '') },
            h('div', { class: 'spread' },
              h('div', { class: 'row wrap', style: 'gap:6px; min-width:0' }, h('span', { class: 't-label-lg' }, a.label), a.playerId ? chip(a.playerId, 'player') : chip('no player', 'warn'), chip(a.role || 'account')),
              Object.assign(btn('Copy', () => copyText(a.address, 'Address copied'), 'ghost mini'), { title: 'Copy address' })),
            h('div', { class: 't-ticker c-hint eco-ell' }, a.address),
            coins == null ? h('div', { class: 't-tiny c-hint', title: 'Reading balances…' }, 'Reading…')
              : coins.length ? h('div', { class: 'eco-coins' }, ...coins.map((c) => h('div', { class: 'eco-coin', title: c.denom }, c.denom === 'ualpha' ? amount('alpha', alphaNum(BigInt(c.amount), 3), alphaText(BigInt(c.amount), 6), 'c-player') : h('span', { class: 'c-player' }, showAmount(BigInt(c.amount), c.denom, 3)), c.denom !== 'ualpha' ? h('span', { class: 't-tiny c-hint x-only' }, c.denom) : null)))
              : h('div', { class: 't-tiny c-hint' }, 'Empty'));
        }))], { icon: 'base' }) : null,
        ladder(ctx)),
      h('div', { class: 'eco-col' }, accts.length ? sendCard(ctx) : null)),
  ));
}

function sendCard(ctx: EcoCtx) {
  const signers = wallet.accounts.filter((a) => a.playerId);
  if (!signers.length) return section('Send', null, [empty('Needs a commander', 'Sending needs an account with a player on chain (MsgPlayerSend moves a player’s funds).')], { icon: 'send' });
  const from = select(ctx, 'tx:from', signers.map((a) => [String(a.index), `${a.label} · ${a.playerId}`]), { label: 'From', value: String(ctx.me?.account ?? signers[0].index) });
  const fromAcct = () => signers.find((a) => String(a.index) === from.sel.value) ?? signers[0];
  const coinsOf = () => eco.wallets.get(fromAcct().address) || [];
  const denoms = (): [string, string][] => { const c = coinsOf(); return (c.length ? c : [{ denom: 'ualpha', amount: '0' }]).map((x) => [x.denom, eco.denomLabel(x.denom)]); };
  const denom = select(ctx, 'tx:denom', denoms(), { label: 'Coin', value: 'ualpha', hint: 'What to send' });
  const toOpts: [string, string][] = [...wallet.accounts.map((a): [string, string] => [a.address, `${a.label}${a.playerId ? ' · ' + a.playerId : ''}`]), ['other', 'Someone else…']];
  const to = select(ctx, 'tx:to', toOpts, { label: 'To', value: 'other' });
  const other = field(ctx, 'tx:other', { placeholder: 'player id 1-… or structs1… address', mode: 'text', label: 'Who', hint: 'A player id (1-…) or a structs1… address' });
  const amount = field(ctx, 'tx:amt', { placeholder: '0', label: 'Amount', unit: 'alpha' });
  const unit = amount.el.querySelector('.eco-unit') as HTMLElement | null;
  const maxB = btn('Max', () => { const bal = amountOf(coinsOf(), denom.sel.value); amount.input.value = denom.sel.value === 'ualpha' || guildOfDenom(denom.sel.value) ? formatDecimal(bal, 6) : bal.toString(); ctx.drafts.set('tx:amt', amount.input.value); amount.input.dispatchEvent(new Event('input')); }, 'ghost mini');
  from.sel.addEventListener('change', () => { denom.sel.replaceChildren(...denoms().map(([v, t]) => h('option', { value: v }, t))); });

  /** Address for the recipient: an own account, a bech32 address, or a player id looked up. */
  const target = (): { addr: string | null; label: string; pending?: boolean } => {
    if (to.sel.value !== 'other') { const a = wallet.byAddress(to.sel.value); return { addr: to.sel.value, label: a?.label || to.sel.value }; }
    const v = other.input.value.trim();
    if (isAddress(v)) { const pid = store.byAddress.get(v); return { addr: v, label: pid ? `${store.playerName(pid)} (${pid})` : 'an address with no player' }; }
    if (/^1-\d+$/.test(v)) {
      const known = store.players.get(v)?.primaryAddress;
      if (known) return { addr: known, label: `${store.playerName(v)} (${v})` };
      if (!resolved.has(v)) { resolved.set(v, null); void lcd.player(v).then((p) => { resolved.set(v, p.Player.primaryAddress || null); other.input.dispatchEvent(new Event('input')); }).catch(() => resolved.set(v, '')); }
      const r = resolved.get(v);
      return r ? { addr: r, label: v } : { addr: null, label: r === '' ? `No player ${v}` : `Looking up ${v}…`, pending: r === null };
    }
    return { addr: null, label: 'Recipient: a structs1… address or a player id' };
  };

  const go = btn('Send', () => {
    const t = target(), d = denom.sel.value, a = parseAmount(amount.input.value, d), src = fromAcct();
    if (!t.addr || !a) return;
    void act(ctx, {
      title: 'Send', label: `Send ${showAmount(a, d, 3)} to ${t.label}`, as: { account: src.index, playerId: src.playerId },
      text: `${src.label} (${src.playerId}) sends ${showAmount(a, d)} — exactly ${a.toString()} ${d} — to ${t.label} at ${t.addr}. Transfers are final.`,
      msgs: [M('MsgPlayerSend', { from_address: src.address, to_address: t.addr, amount: [{ denom: d, amount: a.toString() }] })],
    });
  }, 'solid');
  const pv = preview([from.sel, denom.sel, to.sel, other.input, amount.input], () => {
    const d = denom.sel.value;
    other.el.classList.toggle('eco-hide', to.sel.value !== 'other');
    if (unit) unit.textContent = d === 'ualpha' ? 'alpha' : eco.denomLabel(d);
    const t = target(), src = fromAcct();
    const a = parseAmount(amount.input.value, d);
    const bal = amountOf(coinsOf(), d);
    const lines: string[] = [`${src.label} holds ${showAmount(bal, d, 3)}`];
    if (!t.addr) return { lines: [...lines, t.label], ok: false, tone: t.pending ? '' : 'warn' };
    lines.push(`→ ${t.label}`);
    if (t.addr === src.address) return { lines: [...lines, 'That is the same account'], ok: false, tone: 'warn' };
    if (a == null || a <= 0n) return { lines: [...lines, d === 'ualpha' ? 'Amount in alpha (or 250 mg, 1.5 kg, 1000 ualpha)' : 'Amount'], ok: false };
    if (a > bal) return { lines: [...lines, 'More than the account holds'], ok: false, tone: 'enemy' };
    return { lines: [...lines, `= ${a.toLocaleString()} ${d}`], ok: true };
  }, go);
  return section('Send', 'Between your own accounts or to any player. Free: this chain charges no fee. Transfers are final.', [
    h('div', { class: 'eco-form' }, h('div', { class: 'eco-form-grid' }, from.el, to.el, other.el, denom.el, h('div', { class: 'row', style: 'align-items:flex-end' }, amount.el, maxB)), pv, h('div', { class: 'row' }, go)),
  ], { tone: 'player', icon: 'send' });
}

function ladder(ctx: EcoCtx) {
  const f = field(ctx, 'ladder', { placeholder: '1.5 kg', mode: 'text', label: 'Convert', value: '1', hint: 'Type an amount of alpha: 2.5, 750 mg, 3 kg or 1000000 ualpha' });
  const out = h('div', { class: 'eco-ladder' });
  const draw = () => {
    const v = parseAlpha(f.input.value);
    out.replaceChildren(...(v == null ? [h('div', { class: 't-tiny c-hint', title: 'Try 2.5, 750 mg, 3 kg or 1000000 ualpha' }, 'Try 2.5 or 750 mg')]
      : [...alphaLadder(v).map((r) => h('div', { class: 'eco-rung' }, h('span', { class: 'eco-num c-player' }, r.value), h('span', { class: 't-label c-hint' }, r.label))),
        h('div', { class: 'eco-rung', title: 'The power it makes if infused (before commission)' }, amount('power', powerText(v), null, 'eco-num c-warn'), h('span', { class: 't-label c-hint' }, 'infused'))]));
  };
  f.input.addEventListener('input', draw);
  draw();
  return section('Units', 'How alpha is measured: 1 alpha = 1 gram of Alpha Matter = 1,000 mg = 1,000,000 ualpha (micro-alpha). Put in a reactor, each gram makes 1 kilowatt of power. Type a number to convert it.', [f.el, out], { icon: 'alpha' });
}
