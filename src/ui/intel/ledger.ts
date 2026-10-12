/* Intel · Ledger: the commander's books. Balances straight from the chain (public), the
 * indexer's transfer ledger and lifetime ore record (members), and every ledger row about
 * them as it lands on GRASS — mined, refined, seized, sent, received, infused. The
 * commander is the wallet's active player, else the pinned one; #/intel/ledger/1-x reads
 * any player's public side. */
import { h, portrait } from '../../core/dom';
import { store } from '../../chain/store';
import { commander } from '../../chain/commander';
import { lcd } from '../../chain/lcd';
import { wallet } from '../../wallet/wallet';
import { balances } from '../../wallet/tx';
import { formatAlpha, formatInt } from '../../core/util';
import { grass, type GrassEvent } from '../../grass/grass';
import { describe, amountText } from '../../grass/describe';
import type { LedgerRow } from '../../guild/api';
import { errorBox, loading, partsEl, playerLink, section, short, slot, tile, timeOf, type IntelCtx } from './common';
import { icon } from '../icons';

const names = { player: (id: string) => store.playerName(id) };

export function mountLedger(ctx: IntelCtx) {
  const pid = (ctx.arg && /^1-\d+$/.test(ctx.arg) ? ctx.arg : null) || wallet.active?.playerId || commander.id;
  const live = h('div', { class: 'gfeed' });
  if (!pid) {
    ctx.body.replaceChildren(
      // No commander: a picture, three words and one verb; the sentence is the hover.
      h('div', { class: 'dct-blank', title: 'Open the vault to add your commander, or pin any player from their world, and their books appear here.' },
        h('span', { class: 'dct-blank-ico', html: icon('book', 26) }), h('span', { class: 'dct-blank-words' }, 'No commander yet'),
        h('button', { class: 'btn solid', title: 'Open the vault', onclick: () => import('../vault').then((m) => m.openVault()).catch(() => ctx.navigate('/command')) }, 'Open')),
      section({ text: 'Money moving', hint: 'The galaxy’s economy · live', icon: 'alpha' }, live));
    feed(ctx, live, () => true);
    return;
  }
  const head = h('div', { class: 'lhead' }, loading());
  const bal = h('div', { class: 'tiles' }, loading('Reading balances…'));
  const book = h('div');
  ctx.body.replaceChildren(head, section('What they own', bal),
    section('Lifetime ore', slot(ctx, () => ctx.api.oreStats(pid), (o) => h('div', { class: 'tiles' },
      tile('Mined', formatInt(o.mined) + ' ore', 'dug from worlds', 'player'), tile('Seized', formatInt(o.seized) + ' ore', 'taken in raids', 'enemy'), tile('Forfeited', formatInt(o.forfeited) + ' ore', 'lost to raiders', 'warn')), { cta: 'The ore record' })),
    section('Transfers · members', book),
    section('Money moving · live', live));

  void (async () => {
    try {
      const p = await lcd.player(pid);
      if (!ctx.alive()) return;
      const pl = p.Player;
      head.replaceChildren(portrait(pl.pfpClientRenderAttributes, 'player', pl.id),
        h('div', { class: 'col', style: 'gap:4px; min-width:0' },
          h('div', { class: 'row wrap', style: 'gap:8px' }, h('span', { class: 't-display' }, pl.name || pl.id), playerLink(ctx, pl.id, pl.id)),
          h('div', { class: 't-tiny c-hint' }, short(pl.primaryAddress, 14), ' · ', pl.guildId ? store.guildName(pl.guildId) : 'no guild'),
          pid === (wallet.active?.playerId || '') ? h('span', { class: 'chip player' }, 'Your commander') : h('span', { class: 'chip' }, 'Pinned commander')));
      const rows = await balances(pl.primaryAddress).catch(() => [] as { denom: string; amount: string }[]);
      if (!ctx.alive()) return;
      const alpha = rows.find((r) => r.denom === 'ualpha')?.amount || p.playerInventory?.rocks?.amount || '0';
      bal.replaceChildren(
        tile('Alpha Matter', formatAlpha(alpha), 'in the wallet', 'player'),
        tile('Ore in the hold', formatInt(p.gridAttributes?.ore || 0), 'raidable until refined', Number(p.gridAttributes?.ore || 0) ? 'warn' : ''),
        ...rows.filter((r) => r.denom !== 'ualpha').slice(0, 6).map((r) => tile(r.denom.startsWith('uguild.') ? 'Guild ' + r.denom.slice(7) : r.denom, amountText(r.amount, r.denom))));
    } catch (e) { if (ctx.alive()) head.replaceChildren(errorBox(e)); }
  })();

  // The indexer's ledger, a page at a time.
  let page = 1;
  const table = h('tbody');
  const more = h('button', { class: 'btn ghost', onclick: () => void next() }, 'Older');
  const next = async () => {
    more.setAttribute('disabled', '');
    try {
      const rows = (await ctx.api.ledger(pid, page)).data || [];
      if (!ctx.alive()) return;
      if (page === 1) {
        const count = await ctx.api.ledgerCount(pid).then((c) => c.count).catch(() => null);
        book.replaceChildren(h('div', { class: 't-tiny c-hint' }, count != null ? `${formatInt(count)} transfers on record` : ''), h('div', { class: 'itable-wrap' }, h('table', { class: 'itable' },
          h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Action'), h('th', null, 'Amount'), h('th', null, 'Counterparty'))), table)), more);
      }
      for (const r of rows) table.appendChild(ledgerRow(ctx, r));
      page++;
      if (rows.length < 100) { more.textContent = 'That’s everything'; return; }
      more.removeAttribute('disabled');
    } catch (e) {
      if (!ctx.alive()) return;
      if (page === 1) book.replaceChildren(slotError(ctx, e)); else { more.removeAttribute('disabled'); }
    }
  };
  book.appendChild(loading('Reading the ledger…'));
  void next();

  const addresses = new Set(wallet.accounts.filter((a) => a.playerId === pid).map((a) => a.address));
  feed(ctx, live, (e) => e.playerId === pid || addresses.has(String(e.data.address || '')));
}

function slotError(ctx: IntelCtx, e: unknown): HTMLElement {
  // Reuse slot()'s judgement: a sign-in CTA for a missing session, else the error.
  return slot(ctx, () => Promise.reject(e), () => h('div'), { cta: 'Your transfer ledger', quiet: true });
}

function ledgerRow(ctx: IntelCtx, r: LedgerRow): HTMLElement {
  const credit = r.direction === 'credit';
  return h('tr', null,
    h('td', { class: 't-tiny c-hint' }, timeOf(r.time)),
    h('td', null, h('span', { class: 'chip ' + (credit ? 'player' : 'enemy') }, r.action || r.direction)),
    h('td', { class: 'num ' + (credit ? 'c-player' : 'c-enemy') }, (credit ? '+' : '−') + amountText(r.amount_p ?? r.amount, r.denom)),
    h('td', null, r.counterparty_player_id ? playerLink(ctx, r.counterparty_player_id, r.counterparty_username || undefined) : h('span', { class: 't-tiny c-hint' }, short(r.counterparty || '—', 12))));
}

function feed(ctx: IntelCtx, el: HTMLElement, keep: (e: GrassEvent) => boolean) {
  const add = (e: GrassEvent, top = true) => {
    const d = describe(e, names);
    const r = h('div', { class: 'arow tone-' + d.tone }, h('span', { class: 'when' }, new Date(e.at).toLocaleTimeString('en-US', { hour12: false })), h('span', { class: 'atag' }, d.tag), partsEl(ctx, d.parts));
    if (top) el.prepend(r); else el.appendChild(r);
    while (el.children.length > 80) el.lastElementChild?.remove();
    el.querySelector('.empty-live')?.remove();
  };
  const past = grass.recent({ kind: 'inventory' }).filter(keep).slice(-60);
  for (let i = past.length - 1; i >= 0; i--) add(past[i], false);
  if (!el.children.length) el.appendChild(h('div', { class: 't-tiny c-hint empty-live', title: 'Waiting for the next ore or alpha to move…' }, 'Listening…'));
  ctx.cleanup.push(grass.on({ kind: 'inventory' }, (e) => { if (keep(e)) add(e); }));
}
