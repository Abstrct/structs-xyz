/* Shared parts for the Economy tabs: the context each tab renders with, stat tiles, meters,
 * draft-keeping inputs, live previews and the one door every action goes through
 * (confirm → queue). */
import { h, toast, confirmBox } from '../../core/dom';
import { audio } from '../../core/audio';
import { txq } from '../../wallet/queue';
import { wallet } from '../../wallet/wallet';
import { openVault } from '../vault';
import { icon } from '../icons';
import { formatPower } from '../../core/util';
import { decimalProblem, formatDecimal } from '../../game/economy';
import type { Mine } from './data';

export interface EcoCtx {
  host: HTMLElement;
  /** The player this wallet acts as on this screen (null: no wallet player yet). */
  me: Mine | null;
  /** Route argument after the tab (a player, provider or guild id). */
  arg?: string;
  navigate: (hash: string) => void;
  /** Re-render the current tab from the snapshot. */
  repaint: () => void;
  /** Form values that survive repaints, keyed per field — one map per acting account, so a
   * value typed as one commander is never prefilled for another. */
  drafts: Map<string, string>;
}

type Kid = Node | string | null | undefined | false;
export const kids = (...k: (Kid | Kid[])[]): Node[] => k.flat().filter((x): x is Node | string => !!x).map((x) => (typeof x === 'string' ? document.createTextNode(x) : x));

/** A titled block: an icon and a word or two. Its explanation (`sub`) is a hover away, and
 * written out in Expert mode. `tone` colours its edge. */
export function section(title: string, sub: string | null, body: (Kid | Kid[])[], opts: { tone?: 'player' | 'enemy' | 'neutral'; cls?: string; tools?: Node | null; icon?: string } = {}) {
  return h('section', { class: `eco-sec panel ${opts.tone || ''} ${opts.cls || ''}` },
    h('div', { class: 'eco-sec-head', title: sub || null },
      h('div', { class: 'col', style: 'gap:2px; min-width:0' },
        h('span', { class: 'eco-sec-name' }, opts.icon ? h('span', { class: 'eco-sec-ico', html: icon(opts.icon, 20) }) : null, h('span', { class: 't-label-lg eco-sec-title' }, title)),
        sub ? h('span', { class: 't-tiny c-hint x-only' }, sub) : null),
      opts.tools || null),
    h('div', { class: 'eco-sec-body' }, ...kids(...body)));
}

/** A stat tile, number first: [icon] value, then a one- or two-word label. `sub` (what the number
 * means) is the tile's hover, and shows in Expert mode. */
export function tile(label: string, value: string | Node, sub?: string | null, tone: '' | 'player' | 'enemy' | 'warn' | 'neutral' = '', ico?: string) {
  return h('div', { class: 'eco-tile ' + tone, title: sub ? `${label}: ${sub}` : label },
    h('span', { class: 'eco-big' }, ico ? h('span', { class: 'eco-tile-ico k-' + ico, html: icon(ico, 20) }) : null, value),
    h('span', { class: 't-label c-hint' }, label),
    sub ? h('span', { class: 't-tiny c-hint x-only' }, sub) : null);
}

/** A number with its picture: the icon says what it counts, the hover says it in words. */
export function amount(ico: string, text: string, title?: string | null, cls = '') {
  return h('span', { class: `dct-num k-${ico} ${cls}`, title: title || null }, h('span', { class: 'dct-num-ico', html: icon(ico, 15) }), h('span', null, text));
}

/** The DC empty state: a picture, two to four words and at most one verb. The full sentence is
 * the hover. */
export function blank(ico: string, words: string, title?: string | null, action?: [string, () => void] | null) {
  return h('div', { class: 'dct-blank', title: title || null },
    h('span', { class: 'dct-blank-ico', html: icon(ico, 26) }),
    h('span', { class: 'dct-blank-words' }, words),
    action ? h('button', { class: 'btn solid', onclick: action[1] }, action[0]) : null);
}

/** A horizontal stack of parts against a total (or the parts' sum), with a marker line. */
export function meter(parts: { value: bigint; cls: string; title?: string }[], total: bigint, mark?: { at: bigint; title: string } | null) {
  const sum = parts.reduce((a, p) => a + (p.value > 0n ? p.value : 0n), 0n);
  const t = total > sum ? total : sum;
  const pct = (v: bigint) => (t > 0n ? Number((v * 10_000n) / t) / 100 : 0);
  const bar = h('div', { class: 'eco-meter' }, ...parts.filter((p) => p.value > 0n).map((p) => h('i', { class: p.cls, style: `width:${pct(p.value)}%`, title: p.title || '' })));
  if (mark && t > 0n) bar.appendChild(h('b', { class: 'eco-cap', style: `left:${Math.min(100, pct(mark.at))}%`, title: mark.title }));
  return bar;
}

/** An input whose value lives in ctx.drafts, so a repaint mid-typing keeps it. */
export function field(ctx: EcoCtx, key: string, opts: { placeholder?: string; value?: string; unit?: string; mode?: 'decimal' | 'numeric' | 'text'; cls?: string; label?: string; width?: string; hint?: string } = {}) {
  const input = h('input', {
    class: 'input eco-input ' + (opts.cls || ''), placeholder: opts.placeholder || '', inputmode: opts.mode || 'decimal', spellcheck: false, autocomplete: 'off',
    'aria-label': opts.label || opts.placeholder || key, style: opts.width ? `width:${opts.width}` : undefined,
  }) as HTMLInputElement;
  input.value = ctx.drafts.get(key) ?? opts.value ?? '';
  input.addEventListener('input', () => ctx.drafts.set(key, input.value));
  const wrap = opts.unit ? h('label', { class: 'eco-field' }, input, h('span', { class: 'eco-unit' }, opts.unit)) : input;
  return { input, el: opts.label ? h('label', { class: 'eco-labeled', title: opts.hint || null }, h('span', { class: 't-label c-hint' }, opts.label), wrap) : wrap };
}

export function select(ctx: EcoCtx, key: string, options: [string, string][], opts: { label?: string; value?: string; hint?: string } = {}) {
  const sel = h('select', { class: 'input eco-select', 'aria-label': opts.label || key }, ...options.map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
  const want = ctx.drafts.get(key) ?? opts.value;
  if (want != null && options.some(([v]) => v === want)) sel.value = want;
  sel.addEventListener('change', () => ctx.drafts.set(key, sel.value));
  return { sel, el: opts.label ? h('label', { class: 'eco-labeled', title: opts.hint || null }, h('span', { class: 't-label c-hint' }, opts.label), sel) : sel };
}

/** Wire inputs to a preview: `compute` returns lines to show and whether the action may run. */
export function preview(inputs: (HTMLInputElement | HTMLSelectElement)[], compute: () => { lines: (Node | string)[]; ok: boolean; tone?: 'enemy' | 'warn' | '' }, button: HTMLButtonElement) {
  const box = h('div', { class: 'eco-preview t-tiny' });
  // Amount fields refuse "0,5"-style decimals; say why here instead of a vague "enter an amount".
  const ambiguous = () => {
    for (const i of inputs) if (i instanceof HTMLInputElement && i.inputMode === 'decimal') { const p = decimalProblem(i.value); if (p) return p; }
    return null;
  };
  const run = () => {
    let r: ReturnType<typeof compute>;
    const amb = ambiguous();
    if (amb) r = { lines: [amb], ok: false, tone: 'enemy' };
    else try { r = compute(); } catch (e) { r = { lines: [(e as Error).message], ok: false, tone: 'enemy' }; }
    box.className = 'eco-preview t-tiny ' + (r.tone || '');
    box.replaceChildren(...r.lines.map((l) => (typeof l === 'string' ? h('div', null, l) : l)));
    button.disabled = !r.ok;
  };
  for (const i of inputs) { i.addEventListener('input', run); i.addEventListener('change', run); }
  run();
  return box;
}

type Msg = { typeUrl: string; value: Record<string, unknown> };
export interface Act {
  title: string; text: string; ok?: string; tone?: 'player' | 'enemy'; label: string; msgs: Msg[];
  /** Sign as another wallet account than the screen's acting player. */
  as?: { account: number; playerId?: string };
  /** One transaction per signer instead of `msgs` (each player signing for itself). */
  each?: { as: { account: number; playerId?: string }; label: string; msgs: Msg[] }[];
}

export const shortAddr = (a: string) => (a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a);
/** "Commander (1-12, structs1abc…wxyz)" for a wallet account index. */
export function actorName(account: number, playerId?: string): string {
  const acct = wallet.accounts.find((x) => x.index === account);
  return `${acct?.label || 'account ' + account} (${playerId || acct?.playerId || 'no player'}, ${shortAddr(acct?.address || '?')})`;
}

/** The only way a tab writes to the chain: confirm exactly what will happen — and as whom — then
 * queue it for that account. Returns true once queued. */
export async function act(ctx: EcoCtx, a: Act): Promise<boolean> {
  if (wallet.state === 'empty') { openVault(); return false; }
  const me = a.as ? { account: a.as.account, playerId: a.as.playerId } : ctx.me;
  const jobs = a.each ?? (me ? [{ as: me, label: a.label, msgs: a.msgs }] : []);
  if (!jobs.length || jobs.some((j) => j.as.account < 0)) { toast('Enlist a commander first: your vault joins you to a guild', 'warn', 4200); openVault('join'); return false; }
  const who = jobs.length === 1 ? `As ${actorName(jobs[0].as.account, jobs[0].as.playerId)}: ` : `As each player's own account, ${jobs.map((j) => actorName(j.as.account, j.as.playerId)).join('; ')}: `;
  if (!(await confirmBox(a.title, who + a.text, a.ok || 'Queue it', a.tone || 'player'))) return false;
  try {
    for (const j of jobs) txq.enqueue(j.msgs.map((m) => ({ typeUrl: m.typeUrl, value: { ...m.value } })), { account: j.as.account, playerId: j.as.playerId, label: j.label, source: 'you' });
    audio.play('confirm');
    if (!wallet.unlocked) toast(`Queued: ${a.label}. Unlock the vault to sign it.`, 'warn', 6000, { label: 'Unlock', run: () => openVault() });
    else toast(`Queued: ${a.label}`, 'player');
    return true;
  } catch (e) {
    audio.play('deny');
    toast((e as Error).message, 'enemy', 6000);
    return false;
  }
}

export const M = (name: string, value: Record<string, unknown>) => ({ typeUrl: `/structs.structs.${name}`, value });

/** The polite locked-vault line (the screen still reads; only signing waits). */
export function lockedNote(): HTMLElement | null {
  if (wallet.state !== 'locked') return null;
  return h('div', { class: 'vault-alert eco-alert dct-alert', title: 'Your vault is locked. Everything below is live; actions queue and wait until you unlock.' },
    h('span', { class: 'dct-alert-ico', html: icon('lock', 18) }), h('span', { class: 'grow' }, 'Vault locked'), h('button', { class: 'btn mini solid', onclick: () => openVault() }, 'Unlock'));
}

/** Read-only: a lock, a few words and the way in (the full sentence is the hover). */
export function enlistCta(what: string): HTMLElement {
  const st = wallet.state;
  const [words, msg, label, run] = st === 'empty'
    ? ['Needs a commander', `${what} needs a commander. Enlisting one is free and takes a few seconds; you can still look around without one.`, 'Enlist', () => openVault()]
    : st === 'locked' ? ['Vault locked', `${what} needs your commander. Unlock the vault to see your own grid.`, 'Unlock', () => openVault()]
    : ['Join a guild', `${what} needs a commander on chain. Join a guild from the vault to enlist.`, 'Enlist', () => openVault('join')];
  return h('div', { class: 'eco-cta' }, blank('lock', words, msg, [label, run]));
}

/** A quiet "nothing here" line; `title` carries the longer explanation. */
export const empty = (text: string, title?: string) => h('div', { class: 'pane-empty dct-empty', title: title || null }, text);

export const chip = (text: string, tone: '' | 'player' | 'enemy' | 'warn' | 'neutral' = '', title?: string) => h('span', { class: 'chip ' + tone, title: title || '' }, text);

/** Alpha with its exact figure on hover. */
/** Alpha at up to `maxFrac` places; amounts under a milligram keep every digit so they never read as 0. */
export const alphaText = (ualpha: bigint, maxFrac = 3) => `${formatDecimal(ualpha, 6, { maxFrac: ualpha !== 0n && (ualpha < 0n ? -ualpha : ualpha) < 10n ** BigInt(6 - Math.min(maxFrac, 6)) ? 6 : maxFrac, group: true })} alpha`;
export const powerText = (mw: bigint) => formatPower(mw);
/** Alpha as a bare number: the alpha icon beside it is the unit. */
export const alphaNum = (ualpha: bigint, maxFrac = 3) => alphaText(ualpha, maxFrac).replace(/ alpha$/, '');
/** Alpha with its icon (the exact figure on hover). */
export const alphaEl = (ualpha: bigint, maxFrac = 3, cls = '') => amount('alpha', alphaNum(ualpha, maxFrac), alphaText(ualpha, 6), cls);
/** Power with its icon. */
export const powerEl = (mw: bigint, cls = '', title?: string) => amount('power', powerText(mw), title, cls);
/** A token amount at 6 places with its unit. */
export const tokenText = (amount: bigint, unit: string, maxFrac = 3) => `${formatDecimal(amount, 6, { maxFrac, group: true })} ${unit}`;

/** Id chip that navigates where the id lives (players to the deck, everything else stays). */
export function idLink(ctx: EcoCtx, id: string, label?: string) {
  if (/^1-\d+$/.test(id)) return h('a', { class: 'eco-id', href: '/command/' + id, onclick: (e: Event) => { e.preventDefault(); ctx.navigate('/command/' + id); } }, label || id);
  return h('span', { class: 'eco-id' }, label || id);
}

export function btn(text: string, onclick: () => void, cls = 'mini') { return h('button', { class: 'btn ' + cls, onclick }, text) as HTMLButtonElement; }

/** Disclosure: a button that opens a form panel inline (state kept in drafts). Open, it turns
 * into a ✕ (never the word "Close", which beside a rental means ending it). */
export function disclose(ctx: EcoCtx, key: string, label: string, build: () => Node, cls = 'ghost mini') {
  const open = ctx.drafts.get('open:' + key) === '1';
  const holder = h('div', { class: 'eco-disclose' + (open ? ' on' : '') });
  const face = (on: boolean) => {
    b.textContent = on ? '✕' : label;
    b.setAttribute('aria-label', on ? `Hide the ${label} form` : label);
    b.classList.toggle('dct-x', on);
  };
  const b = btn(label, () => {
    const now = ctx.drafts.get('open:' + key) !== '1';
    ctx.drafts.set('open:' + key, now ? '1' : '0');
    holder.classList.toggle('on', now);
    face(now);
    holder.replaceChildren(...(now ? [build()] : []));
    audio.play('select');
  }, cls);
  face(open);
  b.dataset.k = 'form:' + key;
  if (open) holder.appendChild(build());
  return { button: b, holder };
}
