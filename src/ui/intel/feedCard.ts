/* The live feed as event cards: who (their portrait and name), what (the unit's sprite and type name,
 * an icon and a word for what happened), how long ago, and how many times in a row. The raw ids
 * stay in the card's hover (and Expert mode); fights and raids stand out. Runs of the same thing
 * (four guards set in a row) fold into one card with a count.
 *
 * A struct's type is not in the GRASS payload: it is read from the LCD once a card scrolls into
 * view, a few at a time, and kept (IndexedDB) for a month, since a struct never changes type. */
import { h, portrait } from '../../core/dom';
import { audio } from '../../core/audio';
import { ago, formatInt, formatPower, humanize } from '../../core/util';
import { store } from '../../chain/store';
import { lcd } from '../../chain/lcd';
import { cached } from '../../cache/idb';
import { TYPES_BY_ID } from '../../data/catalogue';
import { spriteDataUrl } from '../../gfx/pixelModel';
import { amountText, describe, statusChange, hrefFor, type Described, type Names, type Part, type Tone } from '../../grass/describe';
import type { GrassEvent } from '../../grass/grass';
import { guildLabel } from '../../guild/directory';
import { icon } from '../icons';
import type { IntelCtx } from './common';

/* ── Struct types, read on demand ───────────────────────────────────────── */

const typeOf = new Map<string, number | null>();
const listeners = new Map<string, Set<(t: number | null) => void>>();
const queue: string[] = [];
let running = 0;
const MAX_RUNNING = 3;

function pump() {
  while (running < MAX_RUNNING && queue.length) {
    // Newest asks first: what just scrolled into view.
    const id = queue.pop()!;
    if (typeOf.has(id)) { settle(id, typeOf.get(id)!); continue; }
    running++;
    cached(id, 30 * 86_400_000, () => lcd.struct(id).then((r) => Number(r.Struct.type) || 0), { ns: 'structType' })
      .then((t) => settle(id, t || null), () => settle(id, null))
      .finally(() => { running--; pump(); });
  }
}
function settle(id: string, t: number | null) {
  typeOf.set(id, t);
  if (typeOf.size > 5000) typeOf.delete(typeOf.keys().next().value as string);
  const ls = listeners.get(id);
  listeners.delete(id);
  ls?.forEach((f) => f(t));
}
function want(id: string, f: (t: number | null) => void) {
  if (typeOf.has(id)) { f(typeOf.get(id)!); return; }
  let ls = listeners.get(id);
  if (!ls) { listeners.set(id, (ls = new Set())); queue.push(id); if (queue.length > 400) queue.shift(); }
  ls.add(f);
  pump();
}

/** Units fill in their type when they come into view (the feed's own scroll counts). */
let seer: IntersectionObserver | null = null;
function watch(el: HTMLElement) {
  if (typeof IntersectionObserver === 'undefined') { fill(el); return; }
  seer ??= new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { seer!.unobserve(e.target); fill(e.target as HTMLElement); } }, { rootMargin: '200px 0px' });
  seer.observe(el);
}
function fill(el: HTMLElement) {
  const id = el.dataset.sid || '';
  want(id, (t) => {
    const type = t ? TYPES_BY_ID[t] : undefined;
    if (!type) { el.classList.add('unknown'); return; }
    const img = h('img', { alt: '' });
    void spriteDataUrl(type.id).then((u) => { img.src = u; });
    el.querySelector('.acard-sprite')?.replaceChildren(img);
    const name = el.querySelector('.acard-type');
    if (name) name.textContent = type.type;
    el.title = `${type.type} · struct ${id}`;
  });
}

/** A struct as its sprite and type name (a plain chip until the type is known). `named`: the name
 * shows beside the sprite (the second unit in a card is its sprite alone; its name is the hover). */
function unit(id: string, named = true): HTMLElement {
  const el = h('span', { class: 'acard-unit', 'data-sid': id, title: `struct ${id}` },
    h('span', { class: 'acard-sprite', html: icon('build', 14) }), named ? h('span', { class: 'acard-type' }) : null);
  const t = typeOf.get(id);
  if (t !== undefined) fill(el); else watch(el);
  return el;
}

/* ── A card ──────────────────────────────────────────────────────────────── */

/** What happened, as an icon and at most two words; `hot` cards (fights, raids) stand out. */
interface Act { ico: string; word: string; tone: Tone; hot?: boolean; num?: string }
const HOT = new Set(['struct_attack', 'raid_status', 'block_raid_start', 'fleet_arrive']);

function statusAct(now: number, old: number): Act {
  const c = statusChange(now, old);
  const t = c.text;
  if (/destroyed/.test(t)) return { ico: 'boom', word: 'destroyed', tone: 'enemy', hot: true };
  if (/came online/.test(t)) return { ico: 'power', word: 'online', tone: 'player' };
  if (/finished building/.test(t)) return { ico: 'build', word: 'built', tone: 'player' };
  if (/offline/.test(t)) return { ico: 'power', word: 'offline', tone: 'warn' };
  if (/into stealth/.test(t)) return { ico: 'eye', word: 'hidden', tone: 'hint' };
  if (/dropped stealth/.test(t)) return { ico: 'eye', word: 'revealed', tone: 'warn' };
  if (/materialized/.test(t)) return { ico: 'build', word: 'appeared', tone: 'hint' };
  if (/stored/.test(t)) return { ico: 'build', word: 'stored', tone: 'hint' };
  if (/locked/.test(t)) return { ico: 'lock', word: 'locked', tone: 'warn' };
  return { ico: 'build', word: 'changed', tone: c.tone };
}

interface Body { units: string[]; act: Act; key: string; place?: string; tail?: Part[] }
const POWER_WORD: Record<string, string> = { structsLoad: 'power use', load: 'power use', capacity: 'capacity', connectionCapacity: 'capacity', fuel: 'fuel', power: 'power' };
const INV_WORD: Record<string, string> = { sent: 'sent', received: 'got', mined: 'mined', refined: 'refined', seized: 'seized', forfeited: 'lost', infused: 'infused', minted: 'minted', burned: 'burned',
  defusion_started: 'defusing', defusion_completed: 'defused', defusion_cancelled: 'kept', migrated: 'moved', genesis: 'started with', diversion_started: 'diverting', diversion_completed: 'diverted' };

/** The parts of a card that are not the player: the unit(s), the act and its number, a place.
 * Null for the kinds that read best as describe()'s sentence (fleets, raids, shots, people). */
function bodyOf(e: GrassEvent): Body | null {
  const d = e.detail || {}, data = e.data || {};
  const n = (v: unknown) => Number(v ?? 0);
  if (e.stub) return null;
  if (e.kind === 'grid') {
    const attr = String(data.attribute_type || e.category);
    const obj = String(e.objectId || '');
    const place = obj.startsWith('2-') ? obj : undefined;
    const v = data.value_p ?? data.value, o = data.value_old_p ?? data.value_old;
    if (attr === 'lastAction') return { units: [], act: { ico: 'charge', word: 'spent charge', tone: 'hint' }, key: attr, place };
    // Ore held: a player's store going up or down by so much; a planet's reserve, what is left.
    if (attr === 'ore') return place
      ? { units: [], act: { ico: 'ore', word: 'ore left', tone: 'neutral', num: formatInt(n(v)) }, key: attr + ':planet', place }
      : { units: [], act: { ico: 'ore', word: n(v) >= n(o) ? 'gained' : 'used', tone: n(v) >= n(o) ? 'neutral' : 'warn', num: `${formatInt(Math.abs(n(v) - n(o)))} ore` }, key: attr + (n(v) >= n(o) ? '+' : '-') };
    if (POWER_WORD[attr]) return { units: [], act: { ico: 'power', word: POWER_WORD[attr], tone: 'hint', num: `${n(v) >= n(o) ? '▲' : '▼'} ${formatPower(String(v ?? 0))}` }, key: attr, place };
    return { units: [], act: { ico: 'grid', word: humanize(attr).toLowerCase(), tone: 'hint', num: `${o ?? '?'}→${v ?? '?'}` }, key: attr, place };
  }
  if (e.kind === 'inventory') {
    const action = String(data.action || e.category);
    const denom = String(data.denom || '');
    const cp = data.counterparty_player_id && data.counterparty_player_id !== 'noPlayer' ? String(data.counterparty_player_id) : '';
    const tone: Tone = action === 'seized' ? 'enemy' : action === 'forfeited' ? 'warn' : action === 'refined' || action === 'received' ? 'player' : 'neutral';
    return { units: [], act: { ico: denom === 'ore' ? 'ore' : 'alpha', word: INV_WORD[action] || humanize(action).toLowerCase(), tone, hot: action === 'seized', num: amountText(data.amount_p ?? data.amount, denom) }, key: action + ':' + denom,
      tail: cp ? [{ text: action === 'received' ? ' from ' : action === 'sent' ? ' to ' : ' · ' }, { text: store.playerName(cp), id: cp }] : undefined };
  }
  const sid = (k: string) => String(d[k] ?? '?');
  switch (e.category) {
    case 'struct_status': { const a = statusAct(n(d.status), n(d.status_old)); return { units: [sid('struct_id')], act: a, key: 'status:' + a.word }; }
    case 'struct_health': {
      const hp = n(d.health), old = n(d.health_old);
      if (old === 0 && hp > 0) return { units: [sid('struct_id')], act: { ico: 'build', word: 'building', tone: 'hint' }, key: 'building' };
      if (hp < old) return { units: [sid('struct_id')], act: { ico: 'health', word: hp === 0 ? 'knocked out' : 'hit', tone: 'enemy', hot: true, num: `−${old - hp}` }, key: 'hit' };
      return { units: [sid('struct_id')], act: { ico: 'health', word: 'repaired', tone: 'player', num: `+${hp - old}` }, key: 'repair' };
    }
    case 'struct_block_build_start': return { units: [sid('struct_id')], act: { ico: 'build', word: 'building', tone: 'hint' }, key: 'building' };
    case 'struct_move': return { units: [sid('struct_id')], act: { ico: 'send', word: 'moved', tone: 'hint' }, key: 'move' };
    case 'struct_defense_add': return { units: [sid('defender_struct_id'), sid('protected_struct_id')], act: { ico: 'shield', word: 'guards', tone: 'player' }, key: 'guard' };
    case 'struct_defense_remove': return { units: [sid('defender_struct_id'), sid('protected_struct_id')], act: { ico: 'shield', word: 'stops guarding', tone: 'warn' }, key: 'unguard' };
    case 'struct_block_ore_mine_start': return { units: [], act: { ico: 'mine', word: 'started mining', tone: 'neutral' }, key: 'mine', place: String(d.planet_id || e.planetId || '') || undefined };
    case 'struct_block_ore_refine_start': return { units: [], act: { ico: 'ore', word: 'started refining', tone: 'neutral' }, key: 'refine', place: String(d.planet_id || e.planetId || '') || undefined };
    case 'shield_change': {
      const s = n(d.planetary_shield), o = n(d.planetary_shield_old);
      return { units: [], act: { ico: 'shield', word: s < o ? 'shield down' : 'shield up', tone: s < o ? 'warn' : 'player', num: `${formatInt(o)}→${formatInt(s)}` }, key: s < o ? 'shield-' : 'shield+', place: e.planetId };
    }
  }
  return null;
}

/** A card's key: consecutive events with the same key fold into one card. Fights never fold. */
export function keyOf(e: GrassEvent): string {
  const b = bodyOf(e);
  if (b?.act.hot || HOT.has(e.category)) return e.category + ':' + e.n;
  if (b) return e.kind + ':' + e.category + ':' + b.key;
  return e.kind + ':' + e.category;
}

/** Who a card is about: the attacker of a shot, a fleet's owner for fleets and raids, else the player
 * the event belongs to. */
function pidOf(e: GrassEvent, names: Names): string {
  const a = (e.detail?.eventAttackDetail || e.detail || {}) as Record<string, unknown>;
  const id = e.category === 'struct_attack' && typeof a.attackerPlayerId === 'string' ? a.attackerPlayerId
    : /^fleet_|^raid_status$/.test(e.category) ? names.fleetOwner?.(String(e.detail?.fleet_id || '')) || ''
    : e.playerId || '';
  // Only a real player (1-…): the guild stack's "noPlayer" is the galaxy itself (mints and the like).
  return /^1-\d+$/.test(id) ? id : '';
}

/** How long ago, for a card: "now" for the first ten seconds, then 12s, 3m, 2h. */
const when = (ms: number) => (ms < 10_000 ? 'now' : ago(ms));

/** describe()'s sentence with its ids as names and pictures: players by name, guilds by name,
 * planets and fleets as icons, structs as their sprite; any other id only in Expert mode. */
function sentence(ctx: Pick<IntelCtx, 'navigate'>, parts: Part[]): Node[] {
  const out: Node[] = [];
  const go = (href: string) => (ev: Event) => { ev.preventDefault(); audio.play('select'); ctx.navigate(href); };
  for (const p of parts) {
    if (!p.text) continue;
    if (!p.id) { out.push(document.createTextNode(p.text)); continue; }
    const href = hrefFor(p.id);
    if (href && /^1-\d+$/.test(p.id)) out.push(h('a', { class: 'id-link who', href, title: p.id, onclick: go(href) }, p.text));
    else if (href && /^0-\d+$/.test(p.id)) out.push(h('a', { class: 'id-link', href, title: p.id, onclick: go(href) }, guildLabel(p.id).name));
    else if (href && /^2-\d+$/.test(p.id)) {
      const owner = store.homeOf.get(p.id);
      out.push(h('a', { class: 'acard-place', href, title: `Planet ${p.id}${owner ? ' · ' + store.playerName(owner) + '’s world' : ''}`, 'aria-label': `planet ${p.id}`, onclick: go(href), html: icon('planet', 14) }));
    } else if (/^5-\d+$/.test(p.id)) out.push(unit(p.id, false));
    else if (/^9-\d+$/.test(p.id)) out.push(h('span', { class: 'acard-place', title: `Fleet ${p.id}`, role: 'img', 'aria-label': `fleet ${p.id}`, html: icon('ship', 14) }));
    else out.push(h('span', { class: 'x-only mono' }, p.text));
  }
  return out;
}

export interface Card { el: HTMLElement; key: string; count: number; at: number; players: string[]; lines: string[] }

const plain = (d: Described) => d.parts.map((p) => p.text).join('').replace(/\s+/g, ' ').trim();

/** A new card for one event (`hist`: from the indexer or the last visit, drawn dimmer). */
export function newCard(ctx: Pick<IntelCtx, 'navigate'>, e: GrassEvent, names: Names, hist = false): Card {
  const d = describe(e, names);
  const b = bodyOf(e);
  const pid = pidOf(e, names);
  const hot = !!b?.act.hot || HOT.has(e.category) || (d.tone === 'enemy' && d.group === 'combat');
  const tone = b ? b.act.tone : d.tone;
  const el = h('div', { class: `acard tone-${tone} g-${d.group}${hot ? ' hot' : ''}${hist ? ' hist' : ''}` });
  const card: Card = { el, key: keyOf(e), count: 1, at: e.at, players: pid ? [pid] : [], lines: [] };
  paint(ctx, card, e, d, b);
  return card;
}

/** Fold one more event into a card (same key, the next one in time). */
export function fold(ctx: Pick<IntelCtx, 'navigate'>, card: Card, e: GrassEvent, names: Names) {
  const pid = pidOf(e, names);
  card.count++;
  card.at = Math.max(card.at, e.at);
  if (pid) { card.players = [pid, ...card.players.filter((x) => x !== pid)]; }
  paint(ctx, card, e, describe(e, names), bodyOf(e));
}

function paint(ctx: Pick<IntelCtx, 'navigate'>, card: Card, e: GrassEvent, d: Described, b: Body | null) {
  card.lines.unshift(plain(d) + (e.subject ? ` (${e.subject})` : ''));
  if (card.lines.length > 6) card.lines.length = 6;
  const pid = card.players[0] || '';
  const p = pid ? store.players.get(pid) : undefined;
  // Up to three faces, the newest in front; an event with no player shows its kind's picture.
  const faces = h('span', { class: 'acard-faces' + (card.players.length > 1 ? ' many' : ''), 'aria-hidden': 'true' },
    ...(card.players.length ? card.players.slice(0, 3).map((id) => portrait(store.players.get(id)?.pfpClientRenderAttributes, 'xs', id))
      : [h('span', { class: 'acard-glyph', html: icon(e.kind === 'inventory' ? 'alpha' : e.kind === 'grid' ? 'planet' : d.group === 'people' ? 'team' : d.group === 'market' ? 'market' : 'news', 16) })]));
  // No player behind it (a mint, the galaxy's own bookkeeping): it is the galaxy's doing.
  const who = pid ? h('a', { class: 'id-link who acard-who', href: '/player/' + pid, title: pid, onclick: (ev: Event) => { ev.preventDefault(); audio.play('select'); ctx.navigate('/player/' + pid); } },
    p?.name || store.playerName(pid)) : e.kind === 'inventory' || e.kind === 'grid' ? h('span', { class: 'acard-who galaxy', title: 'No player: the galaxy itself' }, 'The galaxy') : null;
  const others = card.players.length > 1 ? h('span', { class: 'acard-more', title: card.players.slice(1).map((x) => store.playerName(x)).join(', ') }, `+${card.players.length - 1}`) : null;
  const main: (Node | null)[] = b
    ? [who, others, ...b.units.slice(0, 1).map((u) => unit(u)),
      h('span', { class: 'acard-act' }, h('span', { class: 'acard-act-ico', html: icon(b.act.ico, 14) }), b.act.word),
      ...b.units.slice(1).map((u) => unit(u, false)),
      b.act.num ? h('b', { class: 'acard-num' }, b.act.num) : null,
      // The place, unless it is the card's own player's home (mining on your own world says nothing new).
      ...(b.tail ? sentence(ctx, b.tail) : []), ...(b.place && store.homeOf.get(b.place) !== pid ? sentence(ctx, [{ text: b.place, id: b.place }]) : [])]
    // Kinds that read best as a sentence: describe()'s words with the ids as names and pictures.
    // A sentence that starts with the card's own player drops the name (it is already there).
    : [who, others, h('span', { class: 'acard-text' }, ...sentence(ctx, pid && d.parts[0]?.id === pid ? d.parts.slice(1) : d.parts))];
  card.el.replaceChildren(...[
    faces,
    h('span', { class: 'acard-main' }, ...main.filter((x): x is Node => !!x)),
    card.count > 1 ? h('span', { class: 'acard-n', title: `${card.count} in a row` }, `×${card.count}`) : null,
    h('span', { class: 'acard-when', 'data-at': String(card.at) }, when(Date.now() - card.at)),
  ].filter((x): x is HTMLElement => !!x));
  card.el.title = card.lines.join('\n') + (card.count > card.lines.length ? `\n…and ${card.count - card.lines.length} more` : '');
}

/** Bring every card's "how long ago" up to date. */
export function tickTimes(root: ParentNode) {
  const now = Date.now();
  for (const el of root.querySelectorAll<HTMLElement>('.acard-when')) el.textContent = when(now - Number(el.dataset.at || now));
}

/** Within this long, the same thing again folds into the card above it. */
export const FOLD_MS = 120_000;

/** A smaller live feed of cards (a guild's members, raids, a ledger): `add(e)` puts an event on top
 * (or, `top` false, at the bottom, for history read newest first), folding repeats; the times tick. */
export function cardFeed(ctx: Pick<IntelCtx, 'navigate' | 'cleanup'>, el: HTMLElement, names: Names, max: number) {
  const cards = new WeakMap<HTMLElement, Card>();
  const t = setInterval(() => tickTimes(el), 5000);
  ctx.cleanup.push(() => clearInterval(t));
  return (e: GrassEvent, top = true) => {
    el.querySelector('.empty-live')?.remove();
    const edge = (top ? el.firstElementChild : el.lastElementChild) as HTMLElement | null;
    const c = edge ? cards.get(edge) : undefined;
    if (c && c.key === keyOf(e) && Math.abs(e.at - c.at) < FOLD_MS) { fold(ctx, c, e, names); return; }
    const n = newCard(ctx, e, names);
    cards.set(n.el, n);
    if (top) el.prepend(n.el); else el.appendChild(n.el);
    while (el.children.length > max) el.lastElementChild?.remove();
  };
}
