/* Intel · Activity: GRASS as it happens. Every struct status flip, hit, shield change, raid,
 * fleet move, ore mined and Alpha sent across the galaxy, narrated and colour-coded, with
 * the ids clickable. Filter by group or by any text (a player, planet, struct, category);
 * pause to read. Public: works with no wallet at all. Signed-in members can pull older
 * history from the guild indexer. #/intel/activity/<text> pre-fills the filter. */
import { h, clear } from '../../core/dom';
import { audio } from '../../core/audio';
import { store } from '../../chain/store';
import { formatInt } from '../../core/util';
import { grass, parseGrass, type GrassEvent, type GrassState } from '../../grass/grass';
import { GROUPS, groupOf, type Group } from '../../grass/describe';
import { guildLabel } from '../../guild/directory';
import { errorBox, receiving, type IntelCtx } from './common';
import { FEED_HOT, absorbOre, attackCard, feedCards, fold, foldNear, foldTarget, newCard, nowCards, tickTimes, type Card } from './feedCard';
import { latestAttacks, type CombatRecord } from '../../chain/combat';
import { cache } from '../../cache/idb';
import { ago } from '../../core/util';
import { loading } from './common';
import type { FeedItem } from '../../chain/store';
import { sparkline, SERIES } from './chart';
import { icon } from '../icons';

const PREFS = 'structs.intel.activity';
const MAX_ROWS = 250;
const names = { player: (id: string) => store.playerName(id), fleetOwner: (f: string) => store.fleets.get(f)?.owner };
const GROUP_COLOR: Partial<Record<Group, string>> = { combat: SERIES[3], fleet: SERIES[4], struct: SERIES[0], grid: SERIES[2], economy: SERIES[1], people: SERIES[0], market: SERIES[1] };

interface Prefs { off: Group[]; ticks: boolean }
function loadPrefs(): Prefs {
  try { const p = JSON.parse(localStorage.getItem(PREFS) || '{}'); return { off: Array.isArray(p.off) ? p.off : [], ticks: !!p.ticks }; } catch { return { off: [], ticks: false }; }
}
function savePrefs(p: Prefs) { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* ignore */ } }

export function mountActivity(ctx: IntelCtx) {
  const prefs = loadPrefs();
  let paused = false;
  let held: GrassEvent[] = [];
  let pending: GrassEvent[] = [];
  let frame = 0;
  const counts = new Map<Group, number>();
  /** The chain history's events per group: they count toward the chips too. */
  const chainCounts = new Map<Group, number>();

  const list = h('div', { class: 'alist', role: 'log', 'aria-live': 'off' });
  // A hand-typed route can carry a stray '%': take it as typed rather than fail the tab.
  let arg = ctx.arg || '';
  try { arg = decodeURIComponent(arg); } catch { /* keep raw */ }
  const query = h('input', { class: 'input afilter', placeholder: 'Filter by player name or id…', value: arg, spellcheck: false, autocomplete: 'off', 'aria-label': 'Filter activity', title: 'Filter by player name or id' }) as HTMLInputElement;
  // Pause and Clear are face-button glyphs; their names are the hover.
  const pauseBtn = h('button', { class: 'btn dct-iconbtn apause', title: 'Pause', 'aria-label': 'Pause', html: icon('pause', 16), onclick: () => setPaused(!paused) }) as HTMLButtonElement;
  // Narrow screens: the filter box hides behind a search button, so the first card starts high.
  const searchBtn = h('button', { class: 'btn ghost dct-iconbtn asearch', title: 'Filter by player name or id', 'aria-label': 'Filter', 'aria-expanded': arg ? 'true' : 'false', html: icon('find', 16), onclick: () => {
    const open = !bar.classList.contains('searching');
    bar.classList.toggle('searching', open);
    searchBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) query.focus(); else if (query.value) { query.value = ''; rebuild(); }
  } }) as HTMLButtonElement;
  // Clear empties the live rows only: the history boxes come back with it, then the empty line.
  const clearBtn = h('button', { class: 'btn ghost dct-iconbtn', title: 'Clear the list', 'aria-label': 'Clear', onclick: () => {
    clear(list); held = [];
    appendHistory();
    settleEmpty();
    setPaused(paused);
  } }, '✕');
  const chips = h('div', { class: 'row wrap achips' });
  const status = h('div', { class: 'astatus t-tiny x-only' });
  const rate = h('div', { class: 'arate x-only' });
  const history = h('div', { class: 'ahistory' });

  const visible = (e: GrassEvent) => {
    const g = groupOf(e);
    if (g === 'block' || prefs.off.includes(g)) return false;
    if (!prefs.ticks && e.category === 'lastAction') return false;
    const q = query.value.trim().toLowerCase();
    if (!q) return true;
    if (e.subject.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)) return true;
    for (const v of [e.playerId, e.planetId, e.objectId, e.guildId]) if (v && v.toLowerCase() === q) return true;
    const json = JSON.stringify(e.detail).toLowerCase();
    if (json.includes(`"${q}"`)) return true;
    return !!(e.playerId && store.playerName(e.playerId).toLowerCase().includes(q));
  };

  /* The list is event cards, newest on top; the same thing again (four guards set in a row) folds
   * into the card above it with a count, so the feed reads as what is happening, not a log. */
  const cards = new WeakMap<HTMLElement, Card>();
  /** Put one event on top of the live list (oldest first, so the newest ends on top). */
  /** Ore changes of a player that arrived just before their mining (or refining) itself join its card:
   * a new one, or the batch they just joined (which stays where it is, so these may sit above it). */
  const soak = (n: Card) => {
    const near: Card[] = [];
    for (let el = list.firstElementChild as HTMLElement | null; el && near.length < 24; el = el.nextElementSibling as HTMLElement | null) { const c = cards.get(el); if (c && c !== n) near.push(c); }
    for (const c of absorbOre(n, near)) { c.el.remove(); n.count += c.count; }
  };
  const add = (e: GrassEvent) => {
    const into = foldNear(ctx, cards, list, e, names);
    if (into) { if (into.fam) soak(into); return; }
    const n = newCard(ctx, e, names);
    cards.set(n.el, n);
    soak(n);
    list.prepend(n.el);
  };
  /** Cards for a run of history (newest first), folded the same way. */
  const histCards = (events: GrassEvent[]) => {
    const out: Card[] = [];
    for (const e of events) {
      const near = foldTarget([...out].reverse(), e);
      if (near) fold(ctx, near, e, names);
      else out.push(newCard(ctx, e, names, true));
    }
    return out.map((c) => c.el);
  };
  const liveCards = () => list.querySelectorAll(':scope > .acard');

  const flush = () => {
    frame = 0;
    if (!ctx.alive() || !pending.length) return;
    const batch = pending; pending = [];
    for (const e of batch) add(e);
    const live = liveCards();
    for (let i = MAX_ROWS; i < live.length; i++) live[i].remove();
    if (earlierBox.childElementCount && live.length + earlierBox.childElementCount > MAX_ROWS + 1) paintEarlier();
    // The empty line goes only once a card is really there (a batch can fold into cards below the fold, or add none).
    settleEmpty();
    paintStatus();
  };

  const accept = (e: GrassEvent) => {
    if (e.kind !== 'block') { const g = groupOf(e); counts.set(g, (counts.get(g) || 0) + 1); }
    if (!visible(e)) return;
    if (paused) { held.push(e); if (held.length > 2000) held.shift(); paintStatus(); return; }
    pending.push(e);
    if (!frame) frame = requestAnimationFrame(flush);
  };

  // The last visit's feed (IndexedDB), shown dimmed under the live rows until they fill the list.
  let earlier: GrassEvent[] = [];
  const earlierBox = h('div', { class: 'aearlier' });
  // Indexer history in its own box: the live trim above counts only the list's own rows, and a
  // rebuild (filter, names) repaints these from what was loaded instead of dropping pages.
  const hist: GrassEvent[] = [];
  const histBox = h('div', { class: 'ahist' });
  const paintHist = () => {
    const shown = hist.filter(visible);
    histBox.replaceChildren(...(shown.length ? [h('div', { class: 'adivider t-label', title: `Older news from ${guildLabel(ctx.guildId).name}’s indexer (${formatInt(shown.length)})` }, h('span', { html: icon('clock', 14) }), 'Older')] : []),
      ...histCards(shown));
  };
  /* The chain's last half hour, as read this visit (store.feed's replayed items), or until that
   * lands, as it was read at the last visit (IndexedDB): shown at once, marked as the last visit's. */
  let snap: { at: number; items: FeedItem[] } | null = null;
  let savedAt = 0;
  /** This visit's read of the chain didn't come (the last visit's cards then say so). */
  let chainFailed = false;
  const chainItems = (): { items: FeedItem[]; old: boolean } => {
    const fresh = store.feed.filter((x) => x.replay);
    return fresh.length || !snap ? { items: fresh, old: false } : { items: snap.items, old: true };
  };
  /** The newest real attack on the testnet: pinned on top when the stretch has no fight of its own. */
  let pinned: CombatRecord | null = null;
  /** The read of the newest fight hasn't come back yet (its place is held meanwhile). */
  let pinWait = true;
  const PIN_FOR = 6 * 3_600_000;

  const paintEarlier = () => {
    const room = MAX_ROWS - liveCards().length;
    // The chain's own history covers its stretch better (and live): the last visit keeps only what is older.
    const replays = chainItems().items;
    const cut = replays.length ? Math.min(...replays.map((x) => x.at)) : Infinity;
    const shown = room > 0 ? earlier.filter((e) => e.at < cut && visible(e)).slice(-Math.min(room, 120)) : [];
    earlierBox.replaceChildren(...(shown.length ? [h('div', { class: 'adivider t-label', title: `Kept from your last visit (${shown.length}): not live` }, h('span', { html: icon('clock', 14) }), 'Last visit')] : []),
      ...histCards(shown.reverse()));
  };
  /* What happened on the chain before News opened (the LCD's recent blocks, read once for the whole
   * app): on screen at once, under the live cards and plainly marked as earlier, fights first. */
  const chainBox = h('div', { class: 'achain' });
  /** Pinned above the live list (outside it), so routine updates never bury it: the latest real fight
   * and the galaxy right now. */
  const nowBox = h('div', { class: 'anow' });
  const feedGroup = (it: FeedItem): Group => it.kind === 'attack' || it.kind === 'raid' || it.kind === 'theft' ? 'combat' : it.kind === 'fleet' || it.kind === 'explore' ? 'fleet'
    : it.kind === 'build' ? 'struct' : it.kind === 'mine' || it.kind === 'refine' || it.kind === 'infuse' ? 'economy' : it.kind === 'player' || it.kind === 'guild' ? 'people' : 'other';
  const feedVisible = (it: FeedItem) => {
    if (!it.replay || prefs.off.includes(feedGroup(it))) return false;
    const q = query.value.trim().toLowerCase();
    return !q || it.text.toLowerCase().includes(q) || it.playerId === q || it.planetId === q;
  };
  /** The last visit's divider: its age keeps ticking (tickTimes), and a read that never came says so. */
  const lastVisit = (at: number) => h('div', { class: 'adivider t-label', title: chainFailed ? 'What the chain showed at your last visit: not live. This visit’s read didn’t come; the live feed above still works.' : 'What the chain showed at your last visit: not live. This visit’s read is on its way.' },
    h('span', { html: icon('clock', 14) }), 'Last visit · ', chainFailed ? h('span', null, 'couldn’t refresh') : h('span', { class: 'adiv-age', 'data-at': String(at) }, ago(Date.now() - at)));
  const paintChain = () => {
    const room = MAX_ROWS - liveCards().length;
    const { items: source, old } = chainItems();
    const items = room > 0 ? source.filter(feedVisible).slice(-Math.min(room, 80)) : [];
    const { lead, fights, notable, work, rest } = feedCards(ctx, items);
    const cards = [lead, ...fights, ...notable, work, ...rest].filter((x): x is HTMLElement => !!x);
    // No fight in the stretch: the newest real one is pinned on top, under its own divider.
    // (Only a fresh one: a fight older than six hours isn't news; the stretch's own headline leads instead.)
    const fresh = pinned && Date.now() - (Date.parse(pinned.time) || 0) < PIN_FOR;
    const pin = pinned && fresh && !items.some((x) => FEED_HOT.has(x.kind) || x.hash === pinned!.hash) && !prefs.off.includes('combat') && !query.value.trim() ? attackCard(ctx, pinned) : null;
    const divider = (ico: string, word: string, title: string) => h('div', { class: 'adivider t-label', title }, h('span', { html: icon(ico, 14) }), word);
    // One divider says it all: everything below is from before News opened, read from the chain (or
    // the last visit's read of it, with its age).
    // While the chain's read is still on its way (it takes a few seconds), and no last visit stands
    // in for it: the galaxy as it stands right now. It goes once the read lands, or fails.
    // "Right now" stays until the chain's own cards are on screen: while its read is on its way, after
    // a quiet half hour, or when the read didn't come (its divider says which).
    const read = store.feed.some((x) => x.replay);
    // "Right now" (fleets raiding, the newest commanders) stays on top, above the chain's history,
    // with its counts on the chips: it is the galaxy as it stands, whatever the last half hour held.
    const nowRead = !query.value.trim() ? nowCards(ctx, { combat: !prefs.off.includes('combat'), people: !prefs.off.includes('people') }) : { cards: [], combat: 0, people: 0 };
    const nowTitle = read ? 'The galaxy as it stands, from the roster'
      : chainFailed ? 'The chain’s history didn’t come: the galaxy as it stands, from the roster'
      : 'The galaxy as it stands, from the roster: the news of the last half hour is on its way';
    // Until the roster lands, its slot is held by a placeholder card, so it fills in without moving the list.
    // (The newest fight's likewise, while its read is out.)
    const ghost = (tall = false) => h('div', { class: `acard chain now ghost dcp-sweep${tall ? ' tall' : ''}`, 'aria-hidden': 'true' });
    const holding = !store.coreLoaded && !query.value.trim() && !prefs.off.includes('people');
    // (Two: the newest commanders, and most of the time fleets out raiding.)
    const now = nowRead.cards.length || !holding ? nowRead.cards : prefs.off.includes('combat') ? [ghost()] : [ghost(), ghost()];
    const pinCard = pin || (pinWait && !items.some((x) => FEED_HOT.has(x.kind)) && !prefs.off.includes('combat') && !query.value.trim() ? ghost(true) : null);
    nowBox.replaceChildren(
      ...(pinCard ? [divider('battle', 'Latest fight', 'The newest real attack on the testnet, read from the chain: not live'), pinCard] : []),
      ...(now.length ? [divider('planet', 'Right now', nowTitle), ...now] : []));
    chainBox.replaceChildren(
      ...(cards.length ? [old && snap ? lastVisit(snap.at) : divider('clock', 'Earlier', 'The last half hour or so, read from the chain: not live')] : []), ...cards);
    // The chips count what this visit read (the last visit's cards are not today's news).
    chainCounts.clear();
    if (!old) for (const it of source) { const g = feedGroup(it); chainCounts.set(g, (chainCounts.get(g) || 0) + 1); }
    // What "Right now" shows counts on its chips too (fleets raiding: Combat; newest commanders: People).
    if (nowRead.combat) chainCounts.set('combat', (chainCounts.get('combat') || 0) + nowRead.combat);
    if (nowRead.people) chainCounts.set('people', (chainCounts.get('people') || 0) + nowRead.people);
    // This visit's read, kept for the next visit's first paint (at most every 30 s).
    if (!old && source.length && Date.now() - savedAt > 30_000) { savedAt = Date.now(); void cache.set('chain', { at: Date.now(), items: source.slice(-80) }, 7 * 86_400_000, 'news').catch(() => { /* memory only */ }); }
    paintChips();
    // The last visit's events from inside the chain's stretch would repeat it.
    paintEarlier();
    settleEmpty();
  };
  /** The history boxes, newest stretch first: the chain's last half hour, the last visit, the indexer's pages. */
  const appendHistory = () => list.append(chainBox, earlierBox, histBox);
  /** History actually in the list (cards, not just a divider). */
  const hasHistory = () => !!nowBox.querySelector('.acard') || [chainBox, earlierBox, histBox].some((b) => list.contains(b) && !!b.querySelector('.acard'));
  /** The empty live list's line, chosen from what the list really holds: none with live cards, a slim
   * "listening" line over history, the big well over nothing. */
  const settleEmpty = () => {
    const empty = list.querySelector<HTMLElement>(':scope > .aempty');
    if (liveCards().length) { empty?.remove(); return; }
    const want = hasHistory() ? 'slim' : 'big';
    if (empty && empty.classList.contains('slim') === (want === 'slim')) return;
    const row = emptyRow();
    if (empty) empty.replaceWith(row); else list.prepend(row);
  };
  let chainTimer = 0;
  const chainSoon = (it: FeedItem) => { if (it.replay && !chainTimer) chainTimer = window.setTimeout(() => { chainTimer = 0; if (ctx.alive()) paintChain(); }, 250); };

  const rebuild = () => {
    clear(list);
    pending = [];
    const recent = grass.recent().filter(visible).slice(-MAX_ROWS);
    for (const e of recent) add(e);
    // The boxes first, then the empty line chosen from what they hold.
    appendHistory();
    paintHist();
    paintChain();
    settleEmpty();
    paintStatus();
  };
  // The empty list: a dish under a scan line and a word or two; the sentence is the hover. Tuning
  // in, the line sweeps; connected and only waiting, the dish's rings go on alone.
  const emptyText = () => (grass.state === 'live' ? 'Connected. Waiting for something to happen: builds, battles, raids and mining show up here the moment they do.' : 'Connecting to the live news…');
  const emptyWords = () => (grass.state === 'live' ? 'Waiting for news' : 'Tuning in');
  const emptyRow = () => {
    const slim = hasHistory();
    // Earlier news below: one slim line that says the live feed is listening. Nothing yet: the big well.
    const el = slim ? loading(emptyText(), 'news', grass.state === 'live' ? 'Listening' : 'Tuning in') : receiving(emptyWords(), emptyText(), 'news', grass.state === 'live');
    el.classList.add('aempty');
    if (slim) el.classList.add('slim');
    return el;
  };

  function setPaused(p: boolean) {
    paused = p;
    pauseBtn.innerHTML = icon(p ? 'play' : 'pause', 16) + (p && held.length ? `<span>${formatInt(held.length)}</span>` : '');
    pauseBtn.title = p ? (held.length ? `Resume · ${formatInt(held.length)} new` : 'Resume') : 'Pause';
    pauseBtn.setAttribute('aria-label', pauseBtn.title);
    pauseBtn.classList.toggle('active', p);
    pauseBtn.classList.toggle('wide', p && held.length > 0);
    if (!p && held.length) { pending.push(...held.slice(-MAX_ROWS)); held = []; if (!frame) frame = requestAnimationFrame(flush); }
    paintStatus();
  }

  // The filter chips are built once and then only updated (counts, on/off), so the 5-second
  // refresh never replaces a chip under a click or a keyboard/pad cursor.
  const chipEls = new Map<Group, { el: HTMLElement; num: HTMLElement }>();
  const ticksBox = h('input', { type: 'checkbox', checked: prefs.ticks, onchange: () => { prefs.ticks = ticksBox.checked; savePrefs(prefs); paintChips(); rebuild(); } }) as HTMLInputElement;
  const ticksChip = h('label', { class: 'achip ticks x-only', title: 'Every action spends charge: one row per action. Noisy.' }, ticksBox, 'Charge ticks');
  const paintChips = () => {
    if (!chipEls.size) {
      chips.replaceChildren(...GROUPS.map((g) => {
        const num = h('span', { class: 'num' });
        const el = h('button', { class: `achip g-${g.id}`, style: `--c:${GROUP_COLOR[g.id] || SERIES[0]}`, onclick: () => {
          const on = !prefs.off.includes(g.id);
          prefs.off = on ? [...prefs.off, g.id] : prefs.off.filter((x) => x !== g.id);
          savePrefs(prefs); audio.play('tick'); paintChips(); rebuild();
        } }, h('i'), g.label, num);
        chipEls.set(g.id, { el, num });
        return el;
      }), ticksChip);
    }
    for (const g of GROUPS) {
      const c = chipEls.get(g.id)!, on = !prefs.off.includes(g.id);
      c.el.classList.toggle('on', on);
      c.el.setAttribute('aria-pressed', on ? 'true' : 'false');
      c.num.textContent = formatInt((counts.get(g.id) || 0) + (chainCounts.get(g.id) || 0));
    }
    ticksChip.classList.toggle('on', prefs.ticks);
    ticksBox.checked = prefs.ticks;
  };

  const paintStatus = () => {
    const st: GrassState = grass.state;
    const label = st === 'live' ? 'Live' : st === 'connecting' ? 'Tuning in' : st === 'down' ? 'Reconnecting' : 'Idle';
    const empty = list.querySelector('.aempty');
    // The stream's details are an expert's read-out while it is live, and while the empty list's
    // dish says the same thing bigger; trouble shows for everyone.
    status.className = 'astatus t-tiny ' + (st === 'live' ? 'c-player x-only' : st === 'down' ? 'c-enemy' : 'c-warn' + (empty ? ' x-only' : ''));
    if (empty) { (empty as HTMLElement).title = emptyText(); empty.classList.toggle('calm', st === 'live'); const w = empty.querySelector('.dcp-word'); if (w) w.textContent = emptyWords(); }
    if (empty?.classList.contains('slim')) { const pill = empty.querySelector('.dcp-rx'); if (pill?.lastChild) pill.lastChild.textContent = st === 'live' ? 'Listening' : 'Tuning in'; }
    status.replaceChildren(h('span', { class: 'dot' + (st === 'live' && !paused ? ' pulse' : '') }), ` ${paused ? 'Paused' : label} · ${guildLabel(grass.guildId || ctx.guildId).name} GRASS${grass.height ? ` · block ${formatInt(grass.height)}` : ''}`);
  };
  const paintRate = () => {
    const per = grass.perMinute(undefined, 30);
    rate.replaceChildren(h('span', { class: 't-label' }, 'Signal · 30 min'), sparkline(per, SERIES[0], 160, 22), h('span', { class: 'num t-tiny' }, formatInt(per[per.length - 1] || 0) + '/min'));
  };

  query.addEventListener('input', () => rebuild());
  // The toolbar and the filter chips: one bar (on a narrow screen, one row: the buttons, then the
  // chips scrolling sideways; the filter box opens above them).
  const bar = h('div', { class: 'abar' + (arg ? ' searching' : '') },
    h('div', { class: 'atoolbar' }, h('div', { class: 'row wrap', style: 'gap:8px' }, status, rate), h('div', { class: 'row atools', style: 'gap:6px' }, query, searchBtn, pauseBtn, clearBtn)),
    chips);
  ctx.body.replaceChildren(bar, nowBox, list, history);
  for (const e of grass.recent()) { const g = groupOf(e); counts.set(g, (counts.get(g) || 0) + 1); }
  paintChips(); paintStatus(); paintRate(); rebuild();
  void grass.earlier().then((v) => {
    if (!ctx.alive()) return;
    // Anything also in this session's ring is already on screen.
    const seen = new Set(grass.recent().map((e) => e.subject + '|' + (e.seq ?? '') + '|' + e.category + '|' + JSON.stringify(e.detail)));
    earlier = v.filter((e) => !seen.has(e.subject + '|' + (e.seq ?? '') + '|' + e.category + '|' + JSON.stringify(e.detail)));
    paintEarlier();
    settleEmpty();
  });

  // Older history from the indexer, for members.
  const histBtn = h('button', { class: 'btn ghost dct-more', title: 'Load earlier activity from the guild indexer', onclick: () => void loadHistory() }, h('span', { html: icon('clock', 16) }), 'Earlier');
  history.appendChild(histBtn);
  let page = 1;
  async function loadHistory() {
    histBtn.setAttribute('disabled', '');
    try {
      const rows = (await ctx.api.activity('all', page, 100)).data || [];
      if (!ctx.alive()) return;
      page++;
      for (const r of rows) {
        // History rows carry no owner: the planet's commander stands in (the subject's last token, as live).
        const subject = `structs.planet.${r.planet_id}.${store.homeOf.get(r.planet_id) || 'noPlayer'}`;
        const e = parseGrass(subject, JSON.stringify({ subject, category: r.category, planet_id: r.planet_id, seq: r.seq, block_height: r.block_height, detail: r.detail_json ?? r.detail }), Date.parse(r.time) || Date.now());
        if (e) hist.push(e);
      }
      paintHist();
      settleEmpty();
      histBtn.removeAttribute('disabled');
      histBtn.replaceChildren(h('span', { html: icon('clock', 16) }), rows.length ? 'More' : 'No more');
      histBtn.title = rows.length ? 'Load more history' : 'No more history';
      if (!rows.length) histBtn.setAttribute('disabled', '');
    } catch (e) {
      if (!ctx.alive()) return;
      history.replaceChildren(errorBox(e));
    }
  }

  const timer = setInterval(() => { paintRate(); paintChips(); tickTimes(list); }, 5000);
  ctx.cleanup.push(
    grass.on(undefined, accept),
    grass.onState(paintStatus),
    grass.onBlock(paintStatus),
    () => { clearInterval(timer); if (frame) cancelAnimationFrame(frame); },
    store.onCore(() => rebuild()),
    store.onFeed(chainSoon),
    () => clearTimeout(chainTimer),
  );
  // The chain's recent blocks (read once for the whole app; the galaxy may have read them already).
  void store.backfill();
  // Until they land, the last visit's read of them; and the newest real fight, for the top.
  void cache.entry<{ at: number; items: FeedItem[] }>('chain', 'news').then((e) => {
    if (!ctx.alive() || !e?.v || !Array.isArray(e.v.items) || !e.v.items.length) return;
    snap = e.v;
    if (!store.feed.some((x) => x.replay)) paintChain();
  }, () => { /* no cache */ });
  // (The app's shared read of the newest attacks, cached for two minutes: no search per visit.)
  void latestAttacks().then((r) => { pinWait = false; if (!ctx.alive()) return; pinned = r[0] || null; paintChain(); }, () => { pinWait = false; if (ctx.alive()) paintChain(); });
  // This visit's read of the chain hasn't landed in 15 s: the last visit's cards say they couldn't be refreshed.
  const staleTimer = setTimeout(() => { if (!ctx.alive() || store.feed.some((x) => x.replay)) return; chainFailed = true; paintChain(); }, 15_000);
  ctx.cleanup.push(() => clearTimeout(staleTimer));
}
