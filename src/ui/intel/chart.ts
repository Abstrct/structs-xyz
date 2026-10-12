/* Small SVG charts for Intel: a sparkline, a line/area chart with a crosshair, and bars.
 * Thin marks, recessive grid, one y-axis, text in text colours; series hues come from a
 * validated categorical order (dark surface) and follow the series, never its rank. */
import { h, showTooltip, hideTooltip } from '../../core/dom';

/** Validated against the panel surface (#131a24): lightness band, chroma, CVD + normal separation, contrast. */
export const SERIES = ['#25A893', '#C9821F', '#6F82D8', '#D8553F', '#A96CCB'];
const NS = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string | number>, ...kids: Element[]): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const k of kids) el.appendChild(k);
  return el;
}

const compact = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(0) + 'k';
  if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

/** A tiny trend line (no axes) for stat tiles. */
export function sparkline(values: number[], color = SERIES[0], w = 120, hgt = 28): SVGElement {
  const s = svg('svg', { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, class: 'spark', 'aria-hidden': 'true' });
  if (values.length < 2) return s;
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const x = (i: number) => (i / (values.length - 1)) * (w - 2) + 1;
  const y = (v: number) => hgt - 2 - ((v - min) / (max - min || 1)) * (hgt - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  s.appendChild(svg('path', { d: `${d}L${x(values.length - 1)},${hgt}L${x(0)},${hgt}Z`, fill: color, opacity: 0.14 }));
  s.appendChild(svg('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
  return s;
}

export interface Series { name: string; values: number[]; color?: string }
export interface LineOpts { labels: string[]; height?: number; format?: (v: number) => string; area?: boolean; empty?: string }

/** A line chart over shared x labels, with a legend (≥2 series) and a crosshair tooltip.
 * The plot stretches to its box; labels are HTML so they never stretch with it. */
export function lineChart(series: Series[], o: LineOpts): HTMLElement {
  const W = 640, H = o.height ?? 170, T = 8;
  const fmt = o.format || compact;
  const n = o.labels.length;
  const box = h('div', { class: 'chart' });
  // A line needs two points; one minute in, there is only one.
  if (n < 2 || !series.some((s) => s.values.some((v) => v))) { box.appendChild(h('div', { class: 'chart-empty t-tiny c-hint' }, o.empty || 'No data yet')); return box; }
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => T + (1 - v / max) * (H - T - 1);
  const plot = h('div', { class: 'chart-plot', style: `height:${H}px` });
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', preserveAspectRatio: 'none', role: 'img', 'aria-label': series.map((s) => s.name).join(', ') });
  for (const f of [0, 0.5, 1]) {
    const yy = y(max * f);
    root.appendChild(svg('line', { x1: 0, x2: W, y1: yy, y2: yy, class: 'grid', 'vector-effect': 'non-scaling-stroke' }));
    if (f) plot.appendChild(h('span', { class: 'y-label', style: `top:${((yy / H) * 100).toFixed(1)}%` }, fmt(max * f)));
  }
  series.forEach((s, si) => {
    const c = s.color || SERIES[si % SERIES.length];
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    if (o.area && series.length === 1) root.appendChild(svg('path', { d: `${d}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`, fill: c, opacity: 0.12 }));
    root.appendChild(svg('path', { d, fill: 'none', stroke: c, 'stroke-width': 2, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
  });
  const cross = svg('line', { x1: 0, x2: 0, y1: T, y2: H, class: 'cross', visibility: 'hidden', 'vector-effect': 'non-scaling-stroke' });
  root.appendChild(cross);
  plot.appendChild(root);
  const at = (ev: PointerEvent) => {
    const r = plot.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((ev.clientX - r.left) / r.width) * (n - 1))));
    cross.setAttribute('x1', String(x(i))); cross.setAttribute('x2', String(x(i))); cross.setAttribute('visibility', 'visible');
    showTooltip(ev.clientX, ev.clientY, h('div', { class: 'col', style: 'gap:2px' },
      h('div', { class: 't-label c-hint' }, o.labels[i]),
      ...series.map((s, si) => h('div', { class: 'row', style: 'gap:6px' }, h('i', { class: 'swatch', style: `background:${s.color || SERIES[si % SERIES.length]}` }), h('span', { class: 'grow' }, s.name), h('span', { class: 'num' }, fmt(s.values[i] ?? 0))))));
  };
  plot.addEventListener('pointermove', at);
  plot.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTooltip(); });
  box.appendChild(plot);
  box.appendChild(xLabels(o.labels));
  if (series.length > 1) box.appendChild(legend(series.map((s, i) => ({ name: s.name, color: s.color || SERIES[i % SERIES.length] }))));
  return box;
}

function xLabels(labels: string[]): HTMLElement {
  const n = labels.length;
  const picks = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  // A lone label sits under the newest (rightmost) mark.
  return h('div', { class: 'x-labels' + (picks.length === 1 ? ' one' : '') }, ...picks.map((i) => h('span', null, labels[i])));
}

export function legend(items: { name: string; color: string }[]): HTMLElement {
  return h('div', { class: 'chart-legend' }, ...items.map((it) => h('span', null, h('i', { class: 'swatch', style: `background:${it.color}` }), it.name)));
}

/** Horizontal bars with labels and values (names left, values right): read as a ranked list. */
export function barList(rows: { label: string; value: number; sub?: string; href?: string; color?: string }[], o: { format?: (v: number) => string; onPick?: (href: string) => void } = {}): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const fmt = o.format || compact;
  return h('div', { class: 'barlist' }, ...rows.map((r, i) => {
    // A linked row is keyed by where it goes, so a repaint can put the cursor back on it.
    const row = h(r.href ? 'button' : 'div', { class: 'bar-row' + (r.href ? ' link' : ''), 'data-k': r.href ? 'bar:' + r.href : null, onclick: r.href && o.onPick ? () => o.onPick!(r.href!) : undefined },
      h('span', { class: 'bar-rank' }, String(i + 1)),
      h('span', { class: 'bar-label' }, r.label, r.sub ? h('span', { class: 't-tiny c-hint' }, ' ' + r.sub) : null),
      h('span', { class: 'bar-track' }, h('i', { style: `width:${Math.max(1.5, (r.value / max) * 100).toFixed(1)}%; background:${r.color || SERIES[0]}` })),
      h('span', { class: 'bar-val num' }, fmt(r.value)));
    return row;
  }));
}

/** Vertical bars over time (one series), hover for the value. */
export function columns(values: number[], labels: string[], o: { color?: string; height?: number; format?: (v: number) => string } = {}): HTMLElement {
  const W = 640, H = o.height ?? 110;
  const n = values.length;
  const box = h('div', { class: 'chart' });
  if (!n || !values.some((v) => v)) { box.appendChild(h('div', { class: 'chart-empty t-tiny c-hint' }, 'No data yet')); return box; }
  const max = Math.max(1, ...values);
  // At least 40 slots, newest at the right: a handful of samples doesn't balloon into slabs.
  const slots = Math.max(n, 40), off = slots - n;
  const bw = W / slots, gap = Math.min(2, bw * 0.2);
  const plot = h('div', { class: 'chart-plot', style: `height:${H}px` });
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', preserveAspectRatio: 'none' });
  root.appendChild(svg('line', { x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5, class: 'grid', 'vector-effect': 'non-scaling-stroke' }));
  values.forEach((v, i) => {
    const bh = (v / max) * (H - 4);
    root.appendChild(svg('rect', { x: (off + i) * bw + gap / 2, y: H - bh, width: Math.max(0.5, bw - gap), height: Math.max(v ? 1 : 0, bh), fill: o.color || SERIES[0] }));
  });
  plot.appendChild(h('span', { class: 'y-label', style: 'top:0' }, (o.format || compact)(max)));
  plot.appendChild(root);
  plot.addEventListener('pointermove', (ev) => {
    const r = plot.getBoundingClientRect();
    const i = Math.floor(((ev.clientX - r.left) / r.width) * slots) - off;
    if (i < 0 || i >= n) { hideTooltip(); return; }
    showTooltip(ev.clientX, ev.clientY, `${labels[i]} · ${(o.format || compact)(values[i])}`);
  });
  plot.addEventListener('pointerleave', () => hideTooltip());
  box.appendChild(plot);
  const xl = xLabels(labels);
  xl.style.paddingLeft = ((off / slots) * 100).toFixed(1) + '%';
  box.appendChild(xl);
  return box;
}
