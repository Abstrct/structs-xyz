/* Intel · Stats: the galaxy in numbers and lines. Live (public): block cadence and the GRASS
 * signal by category, measured in this tab. Indexer (members): 30 days of planet activity,
 * Alpha moved per day, the struct census, and the commander's own grid over the week. */
import { h } from '../../core/dom';
import { store } from '../../chain/store';
import { commander } from '../../chain/commander';
import { wallet } from '../../wallet/wallet';
import { formatAlpha, formatInt, formatPower, humanize } from '../../core/util';
import { grass } from '../../grass/grass';
import type { BucketVolume, PlayerMetric, StatBucket } from '../../guild/api';
import { section, slot, tile, waiting, type IntelCtx } from './common';
import { barList, columns, lineChart, SERIES, sparkline } from './chart';

/** Stable colour per category (identity, not rank). */
const CAT_ORDER = ['struct_status', 'struct_health', 'shield_change', 'lastAction', 'struct_block_build_start', 'mined', 'ore', 'structsLoad', 'struct_attack', 'raid_status', 'fleet_arrive', 'fleet_depart', 'struct_defense_add', 'struct_defense_remove', 'struct_block_ore_mine_start', 'struct_block_ore_refine_start'];
const catColor = (c: string) => SERIES[(CAT_ORDER.indexOf(c) < 0 ? CAT_ORDER.length + c.length : CAT_ORDER.indexOf(c)) % SERIES.length];
const dayLabel = (iso: string) => { const d = new Date(iso); return Number.isNaN(+d) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };

export function mountStats(ctx: IntelCtx) {
  const live = h('div', { class: 'stat-grid' });
  const pid = wallet.active?.playerId || commander.id;
  ctx.body.replaceChildren(...[
    section({ text: 'Live', hint: 'Live · this session', icon: 'news' }, live),
    section({ text: 'Census', hint: 'Galaxy census · members', icon: 'team' }, slot(ctx, async () => {
      const [players, active, counts] = await Promise.all([ctx.api.playerCount(), ctx.api.activePlayers().catch(() => null), ctx.api.structStatusCounts()]);
      return { players, active, counts };
    }, ({ players, active, counts }) => h('div', { class: 'tiles' },
      tile('Commanders', formatInt(players.count), undefined, '', 'team'), active ? tile('Active', formatInt(active.count), 'acted in the last ~day', 'player', 'health') : null,
      tile('Structs', formatInt(counts.total), `${formatInt(counts.online)} online`, '', 'base'), tile('Built', formatInt(counts.built), undefined, '', 'check'),
      tile('Hidden', formatInt(counts.hidden), 'in stealth', 'warn', 'shield'), tile('Destroyed', formatInt(counts.destroyed), 'not yet swept', 'enemy', 'battle')), { cta: 'The galaxy census' })),
    section({ text: 'Planets', hint: 'Planet activity · 30 days', icon: 'planet' }, slot(ctx, () => ctx.api.activityStats('1d'), activityChart, { cta: 'Thirty days of planet activity' })),
    section({ text: 'Alpha moved', hint: 'Alpha moved per day · 30 days', icon: 'alpha' }, slot(ctx, () => ctx.api.ledgerStats('1d', 'ualpha'), volumeChart, { cta: 'The economy’s volume' })),
    pid ? section({ text: store.playerName(pid), hint: `${store.playerName(pid)} · last 7 days`, icon: 'base' }, commanderCharts(ctx, pid)) : null].filter((x): x is HTMLElement => !!x));

  const paintLive = () => {
    if (!ctx.alive()) return;
    const blocks = grass.blocks.toArray();
    const gaps: number[] = [], labels: string[] = [];
    for (let i = 1; i < blocks.length; i++) if (blocks[i].height === blocks[i - 1].height + 1) { gaps.push((blocks[i].at - blocks[i - 1].at) / 1000); labels.push('#' + formatInt(blocks[i].height)); }
    const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const cats = grass.categories(30);
    const top = cats.slice(0, 4).map((c) => c.category);
    const per = grass.perMinute(undefined, 30);
    const minutes = per.length;
    const mlabels = Array.from({ length: minutes }, (_, i) => (i === minutes - 1 ? 'now' : `−${minutes - 1 - i}m`));
    live.replaceChildren(
      h('div', { class: 'tiles' },
        tile('Block', grass.height ? formatInt(grass.height) : waiting(), 'the game clock', '', 'clock'),
        tile('Block time', avg ? avg.toFixed(1) + ' s' : waiting(), `${gaps.length} blocks measured`, '', 'clock'),
        tile('Messages', formatInt(grass.received), 'since this page opened', '', 'news'),
        tile('Signal', formatInt(per[per.length - 1] || 0) + '/min', sparkline(per.slice(-15), SERIES[0], 100, 18), '', 'health')),
      h('div', { class: 'chart-card' }, h('div', { class: 't-label', title: 'Seconds between blocks' }, 'Block gaps'), columns(gaps.slice(-80), labels.slice(-80), { color: SERIES[2], format: (v) => v.toFixed(1) + ' s' })),
      h('div', { class: 'chart-card' }, h('div', { class: 't-label', title: 'Live news per minute · busiest kinds' }, 'News per minute'),
        lineChart(top.map((c) => ({ name: humanize(c), values: grass.perMinute(c, minutes), color: catColor(c) })), { labels: mlabels, height: 150, empty: 'Collecting the first minute…' })),
      h('div', { class: 'chart-card' }, h('div', { class: 't-label', title: 'Category mix · last 30 min' }, 'Mix'),
        cats.length ? barList(cats.slice(0, 10).map((c) => ({ label: humanize(c.category), value: c.count, color: catColor(c.category) }))) : h('div', { class: 't-tiny c-hint' }, 'Collecting…')));
  };
  paintLive();
  const timer = setInterval(paintLive, 6000);
  ctx.cleanup.push(() => clearInterval(timer));
}

function activityChart(rows: StatBucket[]): HTMLElement {
  const buckets = [...new Set(rows.map((r) => r.bucket))].sort();
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.category, (totals.get(r.category) || 0) + Number(r.count));
  const top = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => c);
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const series = top.map((c) => {
    const v = new Array(buckets.length).fill(0);
    for (const r of rows) if (r.category === c) v[idx.get(r.bucket)!] += Number(r.count);
    return { name: humanize(c), values: v, color: catColor(c) };
  });
  return lineChart(series, { labels: buckets.map(dayLabel), height: 170 });
}

function volumeChart(rows: BucketVolume[]): HTMLElement {
  const buckets = [...new Set(rows.map((r) => r.bucket))].sort();
  const vol = buckets.map((b) => rows.filter((r) => r.bucket === b && (r.action === 'sent' || r.action === 'received')).reduce((n, r) => n + Number(r.volume || 0), 0) / 2);
  return h('div', null, columns(vol, buckets.map(dayLabel), { color: SERIES[1], format: (v) => formatAlpha(v) }),
    h('div', { class: 't-tiny c-hint' }, `${formatAlpha(vol.reduce((a, b) => a + b, 0))} transferred in ${buckets.length} days`));
}

function commanderCharts(ctx: IntelCtx, pid: string): HTMLElement {
  const end = Math.floor(Date.now() / 1000), start = end - 7 * 86400;
  const metrics: { metric: PlayerMetric; label: string; color: string; fmt: (v: number) => string }[] = [
    { metric: 'ore', label: 'Ore in the hold', color: SERIES[1], fmt: (v) => formatInt(Math.round(v)) },
    { metric: 'capacity', label: 'Capacity', color: SERIES[0], fmt: (v) => formatPower(v) },
    { metric: 'load', label: 'Load', color: SERIES[3], fmt: (v) => formatPower(v) },
    { metric: 'structs_load', label: 'Structs load', color: SERIES[2], fmt: (v) => formatPower(v) },
  ];
  return slot(ctx, () => Promise.all(metrics.map((m) => ctx.api.statSeries(m.metric, pid, { start_time: start, end_time: end, bucket: '1h', limit: 500 }))), (all) =>
    h('div', { class: 'stat-grid two' }, ...metrics.map((m, i) => {
      const pts = [...all[i]].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      // One measure per chart: these differ in unit and scale, so no shared axis.
      return h('div', { class: 'chart-card' }, h('div', { class: 't-label' }, m.label),
        lineChart([{ name: m.label, values: pts.map((p) => Number(p.value) || 0), color: m.color }], { labels: pts.map((p) => dayLabel(p.time)), height: 110, area: true, format: m.fmt }));
    })), { cta: 'Your commander’s history' });
}
