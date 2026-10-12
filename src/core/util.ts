/* Small shared helpers: seeded randomness, easing, formatting. */

export function hash32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rngFor = (s: string) => mulberry(hash32(s));

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => t * t * (3 - 2 * t);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutBack = (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
export const easeInCubic = (t: number) => t * t * t;
/** Frame-rate independent exponential approach. */
export const damp = (a: number, b: number, lambda: number, dt: number) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Index of an entity id `type-index` → numeric index. */
export const idIndex = (id: string) => Number(String(id).split('-')[1] || 0);
export const idType = (id: string) => Number(String(id).split('-')[0] || -1);

export const OBJECT_TYPES: Record<number, string> = {
  0: 'guild', 1: 'player', 2: 'planet', 3: 'reactor', 4: 'substation', 5: 'struct',
  6: 'allocation', 7: 'infusion', 8: 'address', 9: 'fleet', 10: 'provider', 11: 'agreement',
};

/* ── Number formatting ─────────────────────────────────────────────────── */

/** Energy arrives in milliwatts as a string; show it on the W ladder. */
export function formatPower(mw: string | number | bigint | null | undefined): string {
  if (mw == null || mw === '') return '0 W';
  let v: number;
  try { v = Number(typeof mw === 'bigint' ? mw : BigInt(String(mw).split('.')[0])) / 1000; } catch { v = Number(mw) / 1000; }
  const units = ['W', 'kW', 'MW', 'GW', 'TW'];
  let i = 0;
  // Pick the unit by the value as it will print (999.96 W shows as 1 kW, not 1000 W).
  while (Math.abs(v) >= 999.5 && i < units.length - 1) { v /= 1000; i++; }
  const r1 = Math.round(v * 10) / 10;
  return (Math.abs(r1) >= 100 || Number.isInteger(r1) ? Math.round(v).toFixed(0) : r1.toFixed(1)) + ' ' + units[i];
}

/** ualpha → grams of Alpha Matter on a metric ladder ("9.4 kg"). */
export function formatAlpha(ualpha: string | number | null | undefined): string {
  let g: number;
  try { g = Number(BigInt(String(ualpha ?? '0').split('.')[0])) / 1_000_000; } catch { g = Number(ualpha || 0) / 1_000_000; }
  if (g === 0) return '0 g';
  // Thresholds sit where rounding would otherwise print "1000 mg" or "1000 g".
  if (g < 0.9995) return (g * 1000).toFixed(0) + ' mg';
  if (g < 999.95) return (g < 10 ? g.toFixed(2) : g.toFixed(1)).replace(/\.0+$/, '') + ' g';
  if (g < 999950) return (g / 1000).toFixed(1) + ' kg';
  return (g / 1e6).toFixed(2) + ' t';
}

export function formatInt(v: string | number | null | undefined): string {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : String(v);
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

export function clockTime(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Blocks → human duration at ~6 s per block (the chain's estimate). */
export function blocksToDuration(blocks: number): string {
  const s = Math.max(0, blocks) * 6;
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** camelCase chain enum → "Camel case". */
export function humanize(s: string | null | undefined): string {
  if (!s) return '';
  return cap(String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase());
}

/* ── Proof-of-work clocks (knowledge/mechanics/hashing.md) ──────────────── */

/** Leading hex zeros a proof needs, `age` blocks after its anchor. */
export function powDifficulty(age: number, range: number): number {
  if (age <= 1 || range <= 1) return 64;
  const d = 64 - Math.floor((Math.log10(age) / Math.log10(range)) * 63);
  return Math.max(1, Math.min(64, d));
}
/** Blocks after the anchor until difficulty falls to `target` or below. */
export function powAgeFor(target: number, range: number): number {
  if (range <= 1) return 0;
  return Math.ceil(Math.pow(range, (64 - target) / 63));
}

/** Call every listener; one that throws is logged and never stops the others (or the caller). */
export function safeEach<F>(listeners: Iterable<F>, call: (f: F) => void) {
  for (const f of listeners) {
    try { call(f); } catch (e) { console.error(e); }
  }
}
