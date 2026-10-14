/* Persona lab: the measurements behind the beauty and accessibility scores, in plain Node (no deps).
 *
 *   decodePng       Chrome's screenshots (8-bit, non-interlaced) to RGBA
 *   imageStats      lightness, contrast, crushed blacks and blown whites, colourfulness, blank frames
 *   flashes         WCAG 2.3.1 general flashes from a screencast (opposing ≥10% luminance swings, per second)
 *   motion          how far the picture lurches frame to frame (camera shake under Reduce motion)
 *   simulate        a colour as a colour-vision type sees it (Machado 2009, severity 1; achromatopsia as luminance)
 *   deltaE          CIEDE2000 between two sRGB colours
 *   contrastRatio   WCAG contrast of two sRGB colours
 *   readingGrade    Flesch–Kincaid grade of UI text (each block of text counted as a sentence) */
import { inflateSync } from 'node:zlib';

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8, w = 0, h = 0, ctype = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); ctype = data[9];
      if (data[8] !== 8 || data[12]) throw new Error('only 8-bit, non-interlaced PNGs');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const ch = { 6: 4, 2: 3, 0: 1, 4: 2 }[ctype];
  if (!ch) throw new Error('unsupported PNG colour type ' + ctype);
  const raw = inflateSync(Buffer.concat(idat)), stride = w * ch, out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], cur = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const line = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = cur[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * ch;
      if (ch >= 3) { out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = ch === 4 ? line[s + 3] : 255; }
      else { out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = ch === 2 ? line[s + 1] : 255; }
    }
    prev = line;
  }
  return { w, h, data: out };
}

/* ── Colour ───────────────────────────────────────────────────────────── */
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const gam = (c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
const LIN = Array.from({ length: 256 }, (_, i) => lin(i));
export const luminance = ([r, g, b]) => 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];
const lstar = (Y) => (Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y);

export function parseColour(s) {
  s = String(s || '').trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let x = m[1];
    if (x.length <= 4) x = [...x].map((c) => c + c).join('');
    return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
  }
  m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(s);
  return m ? [+m[1], +m[2], +m[3]].map(Math.round) : null;
}

export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const MACHADO = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
export const VISION_TYPES = ['none', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'];
export function simulate(rgb, type) {
  if (!type || type === 'none') return rgb;
  const l = rgb.map((c) => LIN[c]);
  if (type === 'achromatopsia') { const y = luminance(rgb); return [gam(y), gam(y), gam(y)]; }
  const M = MACHADO[type];
  return M.map((row) => gam(row[0] * l[0] + row[1] * l[1] + row[2] * l[2]));
}

function lab(rgb) {
  const [r, g, b] = rgb.map((c) => LIN[c]);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function deltaE(c1, c2) {
  const [L1, a1, b1] = lab(c1), [L2, a2, b2] = lab(c2);
  const rad = Math.PI / 180, C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2, C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (a, b) => { const t = Math.atan2(b, a) / rad; return t < 0 ? t + 360 : t; };
  const h1 = h(a1p, b1), h2 = h(a2p, b2);
  const dL = L2 - L1, dC = C2p - C1p;
  let dh = C1p * C2p === 0 ? 0 : h2 - h1;
  if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad);
  const Lb = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hb = h1 + h2;
  if (C1p * C2p !== 0) hb = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2), SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

/* ── Pictures ─────────────────────────────────────────────────────────── */
/** A frame's look: mean and spread of lightness (L*, 0–100), crushed (<2.5: true black, below the kit's night blue) and blown (>97) shares,
 * colourfulness (Hasler & Süsstrunk 2003: ~15 dull, ~60 lively, >110 garish) and whether it is blank. */
export function imageStats({ w, h, data }) {
  let n = 0, sL = 0, sL2 = 0, crushed = 0, blown = 0, srg = 0, srg2 = 0, syb = 0, syb2 = 0;
  for (let i = 0; i < w * h * 4; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const L = lstar(0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b]);
    sL += L; sL2 += L * L; if (L < 2.5) crushed++; if (L > 97) blown++;
    const rg = r - g, yb = 0.5 * (r + g) - b;
    srg += rg; srg2 += rg * rg; syb += yb; syb2 += yb * yb;
    n++;
  }
  const mL = sL / n, sdL = Math.sqrt(Math.max(0, sL2 / n - mL * mL));
  const mrg = srg / n, myb = syb / n, sdrg = Math.sqrt(Math.max(0, srg2 / n - mrg * mrg)), sdyb = Math.sqrt(Math.max(0, syb2 / n - myb * myb));
  const colourfulness = Math.hypot(sdrg, sdyb) + 0.3 * Math.hypot(mrg, myb);
  return { lightness: +mL.toFixed(1), contrast: +sdL.toFixed(1), crushed: +(crushed / n).toFixed(3), blown: +(blown / n).toFixed(3), colourfulness: +colourfulness.toFixed(1), blank: sdL < 1.5 };
}

/** Mean relative luminance of each cell of a g×g grid. */
function cells(img, g = 4) {
  const out = new Float64Array(g * g), cnt = new Float64Array(g * g);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const i = (y * img.w + x) * 4, c = Math.min(g - 1, Math.floor((y / img.h) * g)) * g + Math.min(g - 1, Math.floor((x / img.w) * g));
    out[c] += 0.2126 * LIN[img.data[i]] + 0.7152 * LIN[img.data[i + 1]] + 0.0722 * LIN[img.data[i + 2]]; cnt[c]++;
  }
  return Array.from(out, (v, i) => v / (cnt[i] || 1));
}

/** WCAG 2.3.1 general flashes from timed frames [{ t (s), img }]: in any cell of a 4×4 grid (each about a
 * quarter of a 10° field at desk distance), a flash is a pair of opposing luminance swings of ≥ 0.1 where the
 * darker state is below 0.8. Returns the worst count of flashes in any one-second window. */
export function flashes(frames) {
  if (frames.length < 3) return { perSecond: 0, frames: frames.length };
  const series = frames.map((f) => ({ t: f.t, c: cells(f.img) }));
  let worst = 0;
  for (let k = 0; k < 16; k++) {
    const swings = [];
    let ref = series[0].c[k];
    for (const s of series) {
      const v = s.c[k], d = v - ref;
      if (Math.abs(d) >= 0.1 && Math.min(v, ref) < 0.8) { swings.push({ t: s.t, dir: Math.sign(d) }); ref = v; }
      else if (Math.sign(d) === (swings[swings.length - 1]?.dir ?? 0)) ref = v;   // still climbing: follow the extreme
    }
    const flashesAt = [];
    for (let i = 1; i < swings.length; i++) if (swings[i].dir !== swings[i - 1].dir) { flashesAt.push(swings[i].t); i++; }
    for (let i = 0; i < flashesAt.length; i++) {
      let j = i; while (j < flashesAt.length && flashesAt[j] - flashesAt[i] < 1) j++;
      worst = Math.max(worst, j - i);
    }
  }
  return { perSecond: worst, frames: frames.length, seconds: +(frames[frames.length - 1].t - frames[0].t).toFixed(1) };
}

/** How much the whole picture changes frame to frame: mean |ΔL*| per frame pair (p50, p95, max). A
 * steady camera with ships moving sits low; shake and hard zooms spike. */
export function motion(frames) {
  const ds = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].img, b = frames[i].img;
    if (a.w !== b.w || a.h !== b.h) continue;
    let s = 0;
    for (let p = 0; p < a.data.length; p += 16) {
      const la = lstar(0.2126 * LIN[a.data[p]] + 0.7152 * LIN[a.data[p + 1]] + 0.0722 * LIN[a.data[p + 2]]);
      const lb = lstar(0.2126 * LIN[b.data[p]] + 0.7152 * LIN[b.data[p + 1]] + 0.0722 * LIN[b.data[p + 2]]);
      s += Math.abs(la - lb);
    }
    ds.push(s / (a.data.length / 16));
  }
  ds.sort((x, y) => x - y);
  const q = (f) => +(ds[Math.min(ds.length - 1, Math.floor(ds.length * f))] ?? 0).toFixed(2);
  return { p50: q(0.5), p95: q(0.95), max: q(1), pairs: ds.length };
}

/* ── Words ────────────────────────────────────────────────────────────── */
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Flesch–Kincaid grade over UI text blocks (each block a sentence, as a label or line reads), plus the
 * long-word share (3+ syllables) and words per block. */
export function readingGrade(blocks) {
  const sentences = blocks.flatMap((b) => b.split(/[.!?]+\s/)).map((s) => s.trim()).filter((s) => /[a-z]{2}/i.test(s));
  const words = sentences.flatMap((s) => s.match(/[A-Za-z][A-Za-z'’-]*/g) || []);
  if (words.length < 12) return { grade: null, words: words.length };
  const syl = words.reduce((a, w) => a + syllables(w), 0);
  const grade = 0.39 * (words.length / sentences.length) + 11.8 * (syl / words.length) - 15.59;
  return { grade: +grade.toFixed(1), words: words.length, perBlock: +(words.length / sentences.length).toFixed(1), longWords: +(words.filter((w) => syllables(w) >= 3).length / words.length).toFixed(3) };
}

export const pct = (a, f) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * f))]; };
