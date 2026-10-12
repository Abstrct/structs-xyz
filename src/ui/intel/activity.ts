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
import { describe, GROUPS, groupOf, type Group } from '../../grass/describe';
import { guildLabel } from '../../guild/directory';
import { errorBox, partsEl, type IntelCtx } from './common';
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

  const list = h('div', { class: 'alist', role: 'log', 'aria-live': 'off' });
  // A hand-typed route can carry a stray '%': take it as typed rather than fail the tab.
  let arg = ctx.arg || '';
  try { arg = decodeURIComponent(arg); } catch { /* keep raw */ }
  const query = h('input', { class: 'input afilter', placeholder: 'Filter by player name or id…', value: arg, spellcheck: false, autocomplete: 'off', 'aria-label': 'Filter activity', title: 'Filter by player name or id' }) as HTMLInputElement;
  // Pause and Clear are face-button glyphs; their names are the hover.
  const pauseBtn = h('button', { class: 'btn dct-iconbtn apause', title: 'Pause', 'aria-label': 'Pause', html: icon('pause', 16), onclick: () => setPaused(!paused) }) as HTMLButtonElement;
  // Clear empties the live rows only: the empty line and the history boxes come back with it.
  const clearBtn = h('button', { class: 'btn ghost dct-iconbtn', title: 'Clear the list', 'aria-label': 'Clear', onclick: () => {
    clear(list); held = [];
    list.append(emptyRow(), histBox, earlierBox);
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

  const row = (e: GrassEvent, hist = false) => {
    const d = describe(e, names);
    return h('div', { class: `arow tone-${d.tone} g-${d.group}${hist ? ' hist' : ''}`, title: e.subject },
      h('span', { class: 'when' }, new Date(e.at).toLocaleTimeString('en-US', { hour12: false })),
      h('span', { class: 'atag' }, d.tag),
      h('span', { class: 'atext' }, partsEl(ctx, d.parts), e.stub ? h('span', { class: 'chip warn stub', title: 'Payload too large for the feed: ids only' }, 'stub') : null));
  };

  const flush = () => {
    frame = 0;
    if (!ctx.alive() || !pending.length) return;
    const batch = pending; pending = [];
    const frag = document.createDocumentFragment();
    // Newest on top.
    for (let i = batch.length - 1; i >= 0; i--) frag.appendChild(row(batch[i]));
    list.prepend(frag);
    list.querySelector('.aempty')?.remove();
    const live = list.querySelectorAll(':scope > .arow');
    for (let i = MAX_ROWS; i < live.length; i++) live[i].remove();
    if (earlierBox.childElementCount && live.length + earlierBox.childElementCount > MAX_ROWS + 1) paintEarlier();
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
    histBox.replaceChildren(...(shown.length ? [h('div', { class: 'adivider t-label' }, `Older · from ${guildLabel(ctx.guildId).name}’s indexer (${formatInt(shown.length)})`)] : []),
      ...shown.map((e) => row(e, true)));
  };
  const paintEarlier = () => {
    const room = MAX_ROWS - list.querySelectorAll('.arow:not(.hist)').length;
    const shown = room > 0 ? earlier.filter(visible).slice(-Math.min(room, 120)) : [];
    earlierBox.replaceChildren(...(shown.length ? [h('div', { class: 'adivider t-label' }, `Earlier · kept from your last visit (${shown.length})`)] : []),
      ...shown.reverse().map((e) => row(e, true)));
  };
  const rebuild = () => {
    clear(list);
    pending = [];
    const recent = grass.recent().filter(visible).slice(-MAX_ROWS);
    for (let i = recent.length - 1; i >= 0; i--) list.appendChild(row(recent[i]));
    if (!list.children.length) list.appendChild(emptyRow());
    paintEarlier();
    paintHist();
    list.append(histBox, earlierBox);
  };
  // The empty list: a picture and three words; the sentence is the hover.
  const emptyText = () => (grass.state === 'live' ? 'Connected. Waiting for something to happen: builds, battles, raids and mining show up here the moment they do.' : 'Connecting to the live news…');
  const emptyWords = () => (grass.state === 'live' ? 'Waiting for news' : 'Tuning in…');
  const emptyRow = () => h('div', { class: 'aempty dct-blank', title: emptyText() }, h('span', { class: 'dct-blank-ico', html: icon('news', 26) }), h('span', { class: 'dct-blank-words' }, emptyWords()));

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
      c.num.textContent = formatInt(counts.get(g.id) || 0);
    }
    ticksChip.classList.toggle('on', prefs.ticks);
    ticksBox.checked = prefs.ticks;
  };

  const paintStatus = () => {
    const st: GrassState = grass.state;
    const label = st === 'live' ? 'Live' : st === 'connecting' ? 'Tuning in' : st === 'down' ? 'Reconnecting' : 'Idle';
    // The stream's details are an expert's read-out while it is live; trouble shows for everyone.
    status.className = 'astatus t-tiny ' + (st === 'live' ? 'c-player x-only' : st === 'down' ? 'c-enemy' : 'c-warn');
    const empty = list.querySelector('.aempty');
    if (empty) { (empty as HTMLElement).title = emptyText(); const w = empty.querySelector('.dct-blank-words'); if (w) w.textContent = emptyWords(); }
    status.replaceChildren(h('span', { class: 'dot' + (st === 'live' && !paused ? ' pulse' : '') }), ` ${paused ? 'Paused' : label} · ${guildLabel(grass.guildId || ctx.guildId).name} GRASS · block ${grass.height ? formatInt(grass.height) : '…'}`);
  };
  const paintRate = () => {
    const per = grass.perMinute(undefined, 30);
    rate.replaceChildren(h('span', { class: 't-label' }, 'Signal · 30 min'), sparkline(per, SERIES[0], 160, 22), h('span', { class: 'num t-tiny' }, formatInt(per[per.length - 1] || 0) + '/min'));
  };

  query.addEventListener('input', () => rebuild());
  ctx.body.replaceChildren(
    h('div', { class: 'atoolbar' }, h('div', { class: 'row wrap', style: 'gap:8px' }, status, rate), h('div', { class: 'row', style: 'gap:6px' }, query, pauseBtn, clearBtn)),
    chips, list, history);
  for (const e of grass.recent()) { const g = groupOf(e); counts.set(g, (counts.get(g) || 0) + 1); }
  paintChips(); paintStatus(); paintRate(); rebuild();
  void grass.earlier().then((v) => {
    if (!ctx.alive()) return;
    // Anything also in this session's ring is already on screen.
    const seen = new Set(grass.recent().map((e) => e.subject + '|' + (e.seq ?? '') + '|' + e.category + '|' + JSON.stringify(e.detail)));
    earlier = v.filter((e) => !seen.has(e.subject + '|' + (e.seq ?? '') + '|' + e.category + '|' + JSON.stringify(e.detail)));
    paintEarlier();
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
      histBtn.removeAttribute('disabled');
      histBtn.replaceChildren(h('span', { html: icon('clock', 16) }), rows.length ? 'More' : 'No more');
      histBtn.title = rows.length ? 'Load more history' : 'No more history';
      if (!rows.length) histBtn.setAttribute('disabled', '');
    } catch (e) {
      if (!ctx.alive()) return;
      history.replaceChildren(errorBox(e));
    }
  }

  const timer = setInterval(() => { paintRate(); paintChips(); }, 5000);
  ctx.cleanup.push(
    grass.on(undefined, accept),
    grass.onState(paintStatus),
    grass.onBlock(paintStatus),
    () => { clearInterval(timer); if (frame) cancelAnimationFrame(frame); },
    store.onCore(() => rebuild()),
  );
}
