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
import type { FeedItem } from '../../chain/store';
import type { CombatRecord } from '../../chain/combat';
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
  if (/materialized/.test(t)) return { ico: 'build', word: 'building', tone: 'hint' };
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

/* ── Mining and refining: one card per player ─────────────────────────────
 * A mining cycle is a burst of ticks (cycle started, ore mined, the player's store up, the planet's
 * reserve down); refining likewise (ore used, alpha made). Each burst folds into one card per player:
 * "mined 3 ore", "refined 2 ore → 2 g Alpha". */
interface Fam { kind: 'mine' | 'refine'; ore: number; gain: number; alpha: number }
/** `weak`: a change in an ore level. It says nothing about why (mining, refining, a raid taking ore,
 * a raid's loot), so it only joins a card a real mining or refining event started, adds nothing
 * to its total, and never starts a card of its own. */
function famOf(e: GrassEvent): { kind: Fam['kind']; pid: string; ore?: number; alpha?: number; weak?: boolean } | null {
  const pid = e.playerId || '';
  if (!/^1-\d+$/.test(pid)) return null;
  const data = e.data || {};
  const n = (v: unknown) => Number(v ?? 0) || 0;
  if (e.category === 'struct_block_ore_mine_start') return { kind: 'mine', pid };
  if (e.category === 'struct_block_ore_refine_start') return { kind: 'refine', pid };
  if (e.kind === 'inventory') {
    const action = String(data.action || e.category), denom = String(data.denom || '');
    const amt = n(data.amount_p ?? data.amount);
    if (action === 'mined' && denom === 'ore') return { kind: 'mine', pid, ore: amt };
    if (action === 'refined' && denom === 'ore') return { kind: 'refine', pid, ore: amt };
    if (action === 'refined' && denom === 'ualpha') return { kind: 'refine', pid, alpha: amt };
    return null;
  }
  if (e.kind === 'grid' && String(data.attribute_type || e.category) === 'ore') {
    const v = n(data.value_p ?? data.value), o = n(data.value_old_p ?? data.value_old);
    const obj = String(e.objectId || '');
    if (obj.startsWith('1-')) return { kind: v >= o ? 'mine' : 'refine', pid, weak: true };
    if (obj.startsWith('2-') && v < o) return { kind: 'mine', pid, weak: true };
  }
  return null;
}
function famBody(f: Fam): Body {
  if (f.kind === 'mine') {
    const ore = Math.max(f.ore, f.gain);
    return { units: [], act: { ico: 'mine', word: ore ? 'mined' : 'mining', tone: 'neutral', num: ore ? `${formatInt(ore)} ore` : undefined }, key: 'mine' };
  }
  const ore = Math.max(f.ore, f.gain);
  return { units: [], act: { ico: 'ore', word: ore || f.alpha ? 'refined' : 'refining', tone: 'player', num: ore ? `${formatInt(ore)} ore` : undefined },
    key: 'refine', tail: f.alpha ? [{ text: `→ ${amountText(String(f.alpha), 'ualpha')}` }] : undefined };
}

/** A card's key: consecutive events with the same key fold into one card. Fights never fold. */
export function keyOf(e: GrassEvent): string {
  const f = famOf(e);
  if (f) return `fam:${f.kind}:${f.pid}`;
  return plainKey(e);
}

/** An event's own key, mining families aside (an ore level's change, standing alone). */
function plainKey(e: GrassEvent): string {
  const b = bodyOf(e);
  if (b?.act.hot || HOT.has(e.category)) return e.category + ':' + e.n;
  // A player's own goings-on (a build starting, a machine coming online, the shield going up, their
  // power use moving): one card per player while they keep at it ("online · shield up · building 2").
  if (b && e.playerId && (e.kind === 'planet' || e.kind === 'grid')) return `p:${e.playerId}`;
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

export interface Card { el: HTMLElement; key: string; count: number; at: number; players: string[]; lines: string[]; fam?: Fam; units?: Set<string>; weakOre?: boolean;
  /** A player's card: each kind of thing that happened, how often, and its latest number. */
  acts?: Map<string, { act: Act; n: number; structs: Set<string> }>; unit?: string }
/** A player's card collects what happened (newest first) and the structs it happened to. */
const noteUnit = (c: Card, b: Body | null) => {
  if (!c.key.startsWith('p:') || !b) return;
  if (b.units[0]) { (c.units ??= new Set()).add(b.units[0]); c.unit = b.units[0]; }
  const acts = (c.acts ??= new Map());
  const was = acts.get(b.act.word);
  acts.delete(b.act.word);
  const structs = was?.structs || new Set<string>();
  if (b.units[0]) structs.add(b.units[0]);
  // How many: structs it happened to (a build's three events are one build), else times it happened.
  acts.set(b.act.word, { act: b.act, n: (was?.n || 0) + 1, structs });
};

const addFam = (c: Card, e: GrassEvent) => {
  const f = famOf(e);
  if (!f || (f.weak && !c.fam)) return;
  c.fam ??= { kind: f.kind, ore: 0, gain: 0, alpha: 0 };
  if (f.weak) return;
  c.fam.ore += f.ore || 0; c.fam.alpha += f.alpha || 0;
};

/** The key a new card for `e` gets: an ore level's change with no mining card to join stands alone
 * under its own key (its old "gained / used N ore" card), never posing as mining or refining. */
const startKey = (e: GrassEvent) => (famOf(e)?.weak ? plainKey(e) : keyOf(e));

/** The card `e` folds into among `cards` (newest first): within the look-back for families and
 * builds, else only the newest; an ore level's change with no family card falls back to its own key. */
export function foldTarget(cards: Card[], e: GrassEvent): Card | undefined {
  const key = keyOf(e);
  const deep = key.startsWith('fam:') || key.startsWith('p:');
  const near = (k: string, n: number) => cards.slice(0, n).find((c) => c.key === k && Math.abs(e.at - c.at) < FOLD_MS);
  return near(key, deep ? LOOK_BACK : 1) || (famOf(e)?.weak ? near(plainKey(e), 1) : undefined);
}

const plain = (d: Described) => d.parts.map((p) => p.text).join('').replace(/\s+/g, ' ').trim();

/** A new card for one event (`hist`: from the indexer or the last visit, drawn dimmer). */
export function newCard(ctx: Pick<IntelCtx, 'navigate'>, e: GrassEvent, names: Names, hist = false): Card {
  const d = describe(e, names);
  const b = bodyOf(e);
  const pid = pidOf(e, names);
  const hot = !!b?.act.hot || HOT.has(e.category) || (d.tone === 'enemy' && d.group === 'combat');
  const tone = b ? b.act.tone : d.tone;
  const el = h('div', { class: `acard tone-${tone} g-${d.group}${hot ? ' hot' : ''}${hist ? ' hist' : ''}` });
  const card: Card = { el, key: startKey(e), count: 1, at: e.at, players: pid ? [pid] : [], lines: [], weakOre: !!famOf(e)?.weak };
  addFam(card, e);
  noteUnit(card, b);
  if (card.fam) el.className = `acard tone-${card.fam.kind === 'mine' ? 'neutral' : 'player'} g-economy${hist ? ' hist' : ''}`;
  paint(ctx, card, e, d, card.fam ? famBody(card.fam) : b);
  return card;
}

/** Fold one more event into a card (same key, the next one in time). */
export function fold(ctx: Pick<IntelCtx, 'navigate'>, card: Card, e: GrassEvent, names: Names) {
  const pid = pidOf(e, names);
  card.count++;
  card.at = Math.max(card.at, e.at);
  if (pid) { card.players = [pid, ...card.players.filter((x) => x !== pid)]; }
  addFam(card, e);
  const b = bodyOf(e);
  noteUnit(card, b);
  paint(ctx, card, e, describe(e, names), card.fam ? famBody(card.fam) : b);
}

/** How many cards back a mining or refining tick looks for its player's card (others fold only
 * into the card on top). */
const LOOK_BACK = 8;
/** Fold `e` into a card near the top of `box` (the top one, or for mining/refining one of the top
 * few, which then moves to the top); false when it starts a card of its own. */
export function foldNear(ctx: Pick<IntelCtx, 'navigate'>, cards: WeakMap<HTMLElement, Card>, box: HTMLElement, e: GrassEvent, names: Names): boolean {
  const top: Card[] = [];
  for (let el = box.firstElementChild as HTMLElement | null; el && top.length < LOOK_BACK; el = el.nextElementSibling as HTMLElement | null) {
    const c = cards.get(el);
    if (c) top.push(c);
  }
  const c = foldTarget(top, e);
  if (!c) return false;
  fold(ctx, c, e, names);
  if (c.el !== box.firstElementChild) box.prepend(c.el);
  return true;
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
  // A player's card: their latest struct (and how many more), then what happened, newest first.
  const pills = card.acts ? [...card.acts.values()].reverse().slice(0, 3) : [];
  const main: (Node | null)[] = card.key.startsWith('p:') && pills.length
    ? [who, others, card.unit ? unit(card.unit) : null, (card.units?.size || 0) > 1 ? h('span', { class: 'acard-more', title: `${card.units!.size} structs` }, `+${card.units!.size - 1}`) : null,
      ...pills.map(({ act, n, structs }) => { const k = structs.size || n; return h('span', { class: 'acard-act tone-' + act.tone }, h('span', { class: 'acard-act-ico', html: icon(act.ico, 14) }), act.word, k > 1 ? h('b', null, ` ×${k}`) : null, act.num ? h('b', null, ` ${act.num}`) : null); }),
      ...(b?.place && store.homeOf.get(b.place) !== pid ? sentence(ctx, [{ text: b.place, id: b.place }]) : [])]
    : b
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
    card.key.startsWith('p:') ? null : card.count > 1 ? h('span', { class: 'acard-n', title: `${card.count} in a row` }, `×${card.count}`) : null,
    h('span', { class: 'acard-when', 'data-at': String(card.at) }, when(Date.now() - card.at)),
  ].filter((x): x is HTMLElement => !!x));
  card.el.title = card.lines.join('\n') + (card.count > card.lines.length ? `\n…and ${card.count - card.lines.length} more` : '');
}

/** How long ago in plain words, for a card that may be hours or days old: "5 min ago", "1 day ago". */
function plainAgo(ms: number): string {
  const m = Math.floor(ms / 60_000), hr = Math.floor(m / 60), d = Math.floor(hr / 24);
  return ms < 60_000 ? 'just now' : m < 60 ? `${m} min ago` : hr < 24 ? `${hr} h ago` : `${d} day${d === 1 ? '' : 's'} ago`;
}

/** Bring every card's "how long ago" up to date. */
export function tickTimes(root: ParentNode) {
  const now = Date.now();
  for (const el of root.querySelectorAll<HTMLElement>('.acard-when')) el.textContent = (el.dataset.plain ? plainAgo : when)(now - Number(el.dataset.at || now));
  for (const el of root.querySelectorAll<HTMLElement>('.adiv-age')) el.textContent = ago(now - Number(el.dataset.at || now));
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
    if (top && foldNear(ctx, cards, el, e, names)) return;
    const edge = (top ? null : el.lastElementChild) as HTMLElement | null;
    const c = edge ? cards.get(edge) : undefined;
    if (c && c.key === keyOf(e) && Math.abs(e.at - c.at) < FOLD_MS) { fold(ctx, c, e, names); return; }
    const n = newCard(ctx, e, names);
    cards.set(n.el, n);
    if (top) el.prepend(n.el); else el.appendChild(n.el);
    while (el.children.length > max) el.lastElementChild?.remove();
  };
}


/* ── Chain history (store.feed, read from the LCD): what happened before News opened ───────── */

const FEED_ICO: Record<string, string> = { attack: 'battle', raid: 'flag', theft: 'ore', build: 'build', mine: 'mine', refine: 'ore', explore: 'planet', fleet: 'ship', player: 'team', infuse: 'fuel', guild: 'team', other: 'news' };
const FEED_WORD: Record<string, string> = { attack: 'attacked', raid: 'raid', theft: 'stole', build: 'built', mine: 'mined', refine: 'refined', explore: 'found', fleet: 'fleet', player: 'joined', infuse: 'infused', guild: 'guild', other: 'news' };
export const FEED_HOT = new Set(['attack', 'raid', 'theft']);
/** Earlier cards at most (fights come on top of these). */
const MAX_EARLIER = 30;

/** One card for a run of chain-history items (one item, or a player's mining in a row). */
export function feedCard(ctx: Pick<IntelCtx, 'navigate'>, items: FeedItem[], lead = false): HTMLElement {
  const it = items[0];
  const pid = it.playerId && /^1-\d+$/.test(it.playerId) ? it.playerId : '';
  const p = pid ? store.players.get(pid) : undefined;
  const name = pid ? p?.name || store.playerName(pid) : '';
  const hot = FEED_HOT.has(it.kind);
  // The sentence without its leading name (the card's name is already there) and without raw ids.
  const rest = (t: string) => (name && t.startsWith(name) ? t.slice(name.length) : t).replace(/^['’]s\b/, '’s').replace(/\b(planet )?2-\d+\b/g, '').replace(/\s{2,}/g, ' ').trim();
  const mined = it.kind === 'mine' ? items.reduce((a, x) => a + (Number(/mined (\d+)/.exec(x.text)?.[1]) || 1), 0) : 0;
  // "began building a Tank (land)" → building · Tank; "completed a Tank" → built · Tank.
  const building = it.kind === 'build' && /began building/.test(it.text);
  const spent = /is spent/.test(it.text);
  const nameOf = (x: FeedItem) => rest(x.text).replace(/^(completed|began building)\s+(an?\s+)?/, '').replace(/\s*\((space|air|land|water)\)$/, '');
  // A player's builds in the stretch: their names, the first two and how many more.
  const names = [...new Set(items.map(nameOf))];
  const what = it.kind === 'build' ? names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '') : rest(it.text);
  // A player's builds over the stretch, as counts: "built 6 · building 2" (one build: its name).
  const done = items.filter((x) => x.kind === 'build' && !/began building/.test(x.text)).length;
  const started = items.filter((x) => x.kind === 'build' && /began building/.test(x.text)).length;
  const pill = (ico: string, word: string, n?: number) => h('span', { class: 'acard-act' }, h('span', { class: 'acard-act-ico', html: icon(ico, 14) }), word, ...(n ? [h('b', null, ` ${n}`)] : []));
  const body: Node[] = it.kind === 'build' && items.length > 1
    ? [done ? pill('build', 'built', done) : null, started ? pill('build', 'building', started) : null].filter((x): x is HTMLElement => !!x)
    : it.kind === 'mine' || it.kind === 'refine'
    ? [h('span', { class: 'acard-act' }, h('span', { class: 'acard-act-ico', html: icon(FEED_ICO[it.kind], 14) }), FEED_WORD[it.kind]), ...(it.kind === 'mine' ? [h('b', { class: 'acard-num' }, `${formatInt(mined)} ore`)] : [])]
    // A world mined out: the planet and two words, no sentence.
    : spent ? [h('span', { class: 'acard-act' }, h('span', { class: 'acard-act-ico', html: icon('planet', 14) }), 'world used up')]
    : [h('span', { class: 'acard-act' }, h('span', { class: 'acard-act-ico', html: icon(FEED_ICO[it.kind] || 'news', 14) }), building ? 'building' : FEED_WORD[it.kind] || 'news'), h('span', { class: 'acard-text' }, what)];
  const go = (href: string) => (ev: Event) => { ev.preventDefault(); audio.play('select'); ctx.navigate(href); };
  const place = it.planetId && /^2-\d+$/.test(it.planetId) && store.homeOf.get(it.planetId) !== pid
    ? h('a', { class: 'acard-place', href: '/planet/' + it.planetId, title: `Planet ${it.planetId}`, 'aria-label': `planet ${it.planetId}`, onclick: go('/planet/' + it.planetId), html: icon('planet', 14) }) : null;
  const watch = it.kind === 'attack' && it.hash ? h('a', { class: 'acard-place', href: '/combat/' + it.hash, title: 'Watch this fight', 'aria-label': 'Watch this fight', onclick: go('/combat/' + it.hash), html: icon('play', 14) }) : null;
  const at = Math.max(...items.map((x) => x.at));
  return h('div', { class: `acard hist chain tone-${it.tone}${hot ? ' hot' : ''}${lead ? ' lead' : ''}`, title: items.map((x) => x.text).slice(0, 6).join('\n') + '\n(read from the chain: before you opened News)' },
    h('span', { class: 'acard-faces', 'aria-hidden': 'true' }, pid ? portrait(p?.pfpClientRenderAttributes, 'xs', pid) : h('span', { class: 'acard-glyph', html: icon(FEED_ICO[it.kind] || 'news', 16) })),
    h('span', { class: 'acard-main' }, ...[pid ? h('a', { class: 'id-link who acard-who', href: '/player/' + pid, title: pid, onclick: go('/player/' + pid) }, name) : null, ...body, place, watch].filter((x): x is HTMLElement => !!x)),
    items.length > 1 && it.kind !== 'build' ? h('span', { class: 'acard-n', title: `${items.length} in a row` }, `×${items.length}`) : null,
    h('span', { class: 'acard-when', 'data-at': String(at) }, when(Date.now() - at)));
}

/** All the mining and refining in a stretch of history, as one card: how many miners and how much
 * ore, how many refined. The names are its hover. */
function workCard(items: FeedItem[]): HTMLElement {
  const mine = items.filter((x) => x.kind === 'mine'), refine = items.filter((x) => x.kind === 'refine');
  const miners = [...new Set(mine.map((x) => x.playerId).filter((x): x is string => !!x))];
  const refiners = [...new Set(refine.map((x) => x.playerId).filter((x): x is string => !!x))];
  const ore = mine.reduce((a, x) => a + (Number(/mined (\d+)/.exec(x.text)?.[1]) || 1), 0);
  const who = [...new Set([...miners, ...refiners])];
  const at = Math.max(...items.map((x) => x.at));
  const names = (ids: string[]) => ids.slice(0, 12).map((id) => store.playerName(id)).join(', ') + (ids.length > 12 ? ` and ${ids.length - 12} more` : '');
  return h('div', { class: 'acard hist chain tone-neutral summary', title: [miners.length ? `Mining: ${names(miners)}` : '', refiners.length ? `Refining: ${names(refiners)}` : '', '(read from the chain: before you opened News)'].filter(Boolean).join('\n') },
    h('span', { class: 'acard-faces' + (who.length > 1 ? ' many' : ''), 'aria-hidden': 'true' }, ...who.slice(0, 3).map((id) => portrait(store.players.get(id)?.pfpClientRenderAttributes, 'xs', id))),
    h('span', { class: 'acard-main' }, ...[
      miners.length ? h('span', { class: 'acard-act' }, h('span', { class: 'acard-act-ico', html: icon('mine', 14) }), `${miners.length} ${miners.length === 1 ? 'miner' : 'miners'}`) : null,
      miners.length ? h('b', { class: 'acard-num' }, `${formatInt(ore)} ore`) : null,
      refiners.length ? h('span', { class: 'acard-act refine' }, h('span', { class: 'acard-act-ico', html: icon('ore', 14) }), `${refiners.length} refining`) : null,
    ].filter((x): x is HTMLElement => !!x)),
    h('span', { class: 'acard-when', 'data-at': String(at) }, when(Date.now() - at)));
}

/** Everyone's building over the stretch, as one card: how many builders, how many structs finished
 * and started, the commonest kind. The names are its hover. */
function buildCard(items: FeedItem[]): HTMLElement {
  const done = items.filter((x) => !/began building/.test(x.text)), started = items.filter((x) => /began building/.test(x.text));
  const who = [...new Set(items.map((x) => x.playerId).filter((x): x is string => !!x))];
  const kinds = new Map<string, number>();
  for (const x of items) { const k = /(?:completed|began building)\s+(?:an?\s+)?([^(]+?)(?:\s*\(|$)/.exec(x.text)?.[1]; if (k) kinds.set(k, (kinds.get(k) || 0) + 1); }
  const top = [...kinds].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const at = Math.max(...items.map((x) => x.at));
  return h('div', { class: 'acard hist chain tone-player summary', title: `Building: ${who.slice(0, 12).map((id) => store.playerName(id)).join(', ')}${who.length > 12 ? ` and ${who.length - 12} more` : ''}\n(read from the chain: before you opened News)` },
    h('span', { class: 'acard-faces' + (who.length > 1 ? ' many' : ''), 'aria-hidden': 'true' }, ...who.slice(0, 3).map((id) => portrait(store.players.get(id)?.pfpClientRenderAttributes, 'xs', id))),
    h('span', { class: 'acard-main' }, ...[
      h('span', { class: 'acard-act' }, h('span', { class: 'acard-act-ico', html: icon('build', 14) }), `${who.length} ${who.length === 1 ? 'builder' : 'builders'}`),
      done.length ? h('b', { class: 'acard-num' }, `${formatInt(done.length)} built`) : null,
      started.length ? h('b', { class: 'acard-num' }, `${formatInt(started.length)} started`) : null,
      top ? h('span', { class: 'acard-text', title: 'Built most' }, top) : null,
    ].filter((x): x is HTMLElement => !!x)),
    h('span', { class: 'acard-when', 'data-at': String(at) }, when(Date.now() - at)));
}

/** What makes news, most first after fights: new players and guilds, worlds found, fleets on the
 * move; everything else (builds, the rest) after. */
const NOTABLE = new Set(['player', 'guild', 'explore', 'fleet']);

/** Chain history as cards, variety first: the freshest notable event leads as the headline (a fight
 * or raid, else a new player or guild, a world found, a fleet on the move, else a finished build);
 * then the other fights; up to two of each other notable kind; all the mining and refining as one
 * summary card; then each player's builds as one card ("built 6 · building 2"); then the rest. */
export function feedCards(ctx: Pick<IntelCtx, 'navigate'>, items: FeedItem[]): { lead: HTMLElement | null; fights: HTMLElement[]; notable: HTMLElement[]; work: HTMLElement | null; rest: HTMLElement[] } {
  const newest = [...items].sort((a, b) => b.at - a.at);
  const hot = newest.filter((x) => FEED_HOT.has(x.kind));
  const note = newest.filter((x) => NOTABLE.has(x.kind));
  const top = hot[0] || note[0] || newest.find((x) => x.kind === 'build' && !/began building/.test(x.text)) || null;
  const work = newest.filter((x) => x.kind === 'mine' || x.kind === 'refine');
  const perKind = new Map<string, number>();
  const notable = note.filter((x) => { if (x === top) return false; const n = (perKind.get(x.kind) || 0) + 1; perKind.set(x.kind, n); return n <= 2; });
  // Each player's builds over the whole stretch: one card, where they last built.
  const builds = new Map<string, FeedItem[]>();
  const other: FeedItem[] = [];
  for (const x of newest) {
    if (x === top || FEED_HOT.has(x.kind) || NOTABLE.has(x.kind) || x.kind === 'mine' || x.kind === 'refine') continue;
    if (x.kind === 'build' && x.playerId) { const r = builds.get(x.playerId); if (r) r.push(x); else builds.set(x.playerId, [x]); continue; }
    other.push(x);
  }
  // Building, the stretch's busiest kind of news: one summary card, then only the busiest builders
  // (three or more builds) by name, three at most.
  const all = [...builds.values()];
  const busy = all.filter((r) => r.length >= 3).sort((a, b) => b.length - a.length).slice(0, 3);
  const flat = all.flat();
  return {
    lead: top ? feedCard(ctx, [top], true) : null,
    fights: hot.filter((x) => x !== top).map((x) => feedCard(ctx, [x])),
    notable: notable.map((x) => feedCard(ctx, [x])),
    work: work.length ? workCard(work) : null,
    rest: [...(flat.length ? [buildCard(flat)] : []), ...busy.map((r) => feedCard(ctx, r)), ...other.map((x) => feedCard(ctx, [x]))].slice(0, MAX_EARLIER),
  };
}


/** The newest real attack on the testnet (the combat archive), pinned at the top of News when the
 * chain's last half hour has no fight of its own: who fired, at whom, where, and a Watch button. */
export function attackCard(ctx: Pick<IntelCtx, 'navigate'>, r: CombatRecord): HTMLElement {
  const a = r.attack;
  const pid = /^1-\d+$/.test(a.attackerPlayerId || '') ? a.attackerPlayerId : '';
  const shots = a.eventAttackShotDetail || [];
  const target = shots.find((x) => /^1-\d+$/.test(x.targetPlayerId || ''))?.targetPlayerId || '';
  const kills = shots.filter((x) => (x as { targetDestroyed?: boolean }).targetDestroyed).length;
  const go = (href: string) => (ev: Event) => { ev.preventDefault(); audio.play('select'); ctx.navigate(href); };
  const at = Date.parse(r.time) || Date.now();
  const place = /^2-\d+$/.test(a.attackerStructLocationId || '') ? a.attackerStructLocationId : '';
  return h('div', { class: 'acard hist chain hot lead pinned tone-enemy', title: `The newest real attack on the testnet, read from the chain (not live).\n${a.attackerStructType || 'A struct'} fired ${shots.length} shot${shots.length === 1 ? '' : 's'}${kills ? `, ${kills} destroyed` : ''}.` },
    h('span', { class: 'acard-faces', 'aria-hidden': 'true' }, pid ? portrait(store.players.get(pid)?.pfpClientRenderAttributes, 'xs', pid) : h('span', { class: 'acard-glyph', html: icon('battle', 16) })),
    h('span', { class: 'acard-main' }, ...[
      pid ? h('a', { class: 'id-link who acard-who', href: '/player/' + pid, title: pid, onclick: go('/player/' + pid) }, store.playerName(pid)) : null,
      h('span', { class: 'acard-act' }, h('span', { class: 'acard-act-ico', html: icon('battle', 14) }), 'attacked'),
      target ? h('a', { class: 'id-link who', href: '/player/' + target, title: target, onclick: go('/player/' + target) }, store.playerName(target)) : null,
      kills ? h('b', { class: 'acard-num' }, `${kills} destroyed`) : null,
      place ? h('a', { class: 'acard-place', href: '/planet/' + place, title: `Planet ${place}`, 'aria-label': `planet ${place}`, onclick: go('/planet/' + place), html: icon('planet', 14) }) : null,
      h('a', { class: 'acard-place', href: '/combat/' + r.hash, title: 'Watch this fight', 'aria-label': 'Watch this fight', onclick: go('/combat/' + r.hash), html: icon('play', 14) }),
    ].filter((x): x is HTMLElement => !!x)),
    h('span', { class: 'acard-when plain', 'data-at': String(at), 'data-plain': '1' }, plainAgo(Date.now() - at)));
}

/** A mining or refining card just started: an ore change of the same player that arrived a moment
 * before it (and so stood alone) joins it now. `cards` are the cards below it, nearest first. */
export function absorbOre(card: Card, below: Card[]): Card[] {
  if (!card.fam) return [];
  const pid = card.players[0];
  return below.slice(0, LOOK_BACK).filter((c) => c.weakOre && c.players[0] === pid && Math.abs(c.at - card.at) < FOLD_MS);
}

/** The galaxy right now, from the roster (read in well under a second): fleets out raiding and the
 * newest commanders. Shown while the chain's history is still on its way (its search takes ~5 s);
 * a state, not events, so it carries no time. */
export function nowCards(ctx: Pick<IntelCtx, 'navigate'>): HTMLElement[] {
  if (!store.coreLoaded) return [];
  const go = (href: string) => (ev: Event) => { ev.preventDefault(); audio.play('select'); ctx.navigate(href); };
  const out: HTMLElement[] = [];
  const raiders = [...store.fleets.values()].filter((f) => f.status === 'away' && /^2-\d+$/.test(f.locationId || '')).map((f) => f.owner).filter((x) => /^1-\d+$/.test(x));
  if (raiders.length) out.push(h('div', { class: 'acard chain now hot tone-enemy', title: `Fleets away from home, at other players’ worlds: ${raiders.slice(0, 12).map((x) => store.playerName(x)).join(', ')}` },
    h('span', { class: 'acard-faces' + (raiders.length > 1 ? ' many' : ''), 'aria-hidden': 'true' }, ...raiders.slice(0, 3).map((id) => portrait(store.players.get(id)?.pfpClientRenderAttributes, 'xs', id))),
    h('span', { class: 'acard-main' },
      h('span', { class: 'acard-act' }, h('span', { class: 'acard-act-ico', html: icon('ship', 14) }), `${raiders.length} ${raiders.length === 1 ? 'fleet' : 'fleets'} raiding`),
      h('a', { class: 'acard-place', href: '/intel/raids', title: 'Who is raiding whom', 'aria-label': 'Raids', onclick: go('/intel/raids'), html: icon('battle', 14) }))));
  const newest = [...store.players.values()].filter((p) => p.name).sort((a, b) => Number(b.index) - Number(a.index)).slice(0, 3);
  if (newest.length) out.push(h('div', { class: 'acard chain now tone-player', title: 'The newest commanders in the galaxy' },
    h('span', { class: 'acard-faces many', 'aria-hidden': 'true' }, ...newest.map((p) => portrait(p.pfpClientRenderAttributes, 'xs', p.id))),
    h('span', { class: 'acard-main' },
      h('span', { class: 'acard-act' }, h('span', { class: 'acard-act-ico', html: icon('team', 14) }), 'newest'),
      ...newest.map((p) => h('a', { class: 'id-link who', href: '/player/' + p.id, title: p.id, onclick: go('/player/' + p.id) }, p.name)))));
  return out;
}
