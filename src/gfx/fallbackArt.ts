/* Pixel art for the two struct types the game has no sprite for yet
 * (Continental Power Plant, World Engine), painted in the official sprites'
 * language so they stand beside them: a three-quarter view lit from the top
 * left, black outlines, the same steel / tan / amber / teal ramps, chamfered
 * plates with hazard stripes, panel seams and small lights. Shapes are
 * shaded by their surface normal and snapped to a ramp, so curves band the
 * way hand-placed pixels do. The damaged variant is drawn, not filtered:
 * a blast hole, cracks, scorch, a sheared-off corner, lights gone red. */

type RGB = [number, number, number];
const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const ramp = (...c: string[]) => c.map(hex);

const INK = hex('#000000');
const STEEL = ramp('#212833', '#2e3947', '#495569', '#586880', '#687a96', '#8695ab', '#acb6c5', '#d2d7df');
const TAN = ramp('#4f4537', '#695c49', '#807058', '#968468', '#ab9d86', '#c5bbac', '#dfdad2');
const AMBER = ramp('#ce810b', '#f2980d', '#f5ad3d', '#f8c67a', '#fbe0b6');
const TEAL = ramp('#1c5f6a', '#2a9d9b', '#43cdb6', '#86dfc6', '#c2efdd');
const PLUM = ramp('#2e1f3e', '#3c2448', '#553952');
const RED = ramp('#7a1410', '#c11f16', '#ff5a4a');

const N = 128;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const pick = (r: RGB[], t: number) => r[Math.round(clamp01(t) * (r.length - 1))];

/** A 128² paint buffer with a part id per pixel (for outlines between parts). */
class Sheet {
  readonly c = new Uint8ClampedArray(N * N * 4);
  set(x: number, y: number, col: RGB | null) {
    x = Math.floor(x); y = Math.floor(y);
    if (!col || x < 0 || y < 0 || x >= N || y >= N) return;
    const i = (y * N + x) * 4;
    this.c[i] = col[0]; this.c[i + 1] = col[1]; this.c[i + 2] = col[2]; this.c[i + 3] = 255;
  }
  clear(x: number, y: number) { if (x >= 0 && y >= 0 && x < N && y < N) this.c[(y * N + x) * 4 + 3] = 0; }
  on(x: number, y: number) { return x >= 0 && y >= 0 && x < N && y < N && this.c[(y * N + x) * 4 + 3] > 0; }
  get(x: number, y: number): RGB { const i = (y * N + x) * 4; return [this.c[i], this.c[i + 1], this.c[i + 2]]; }
  /** Fill a region; its border (any 4-neighbour outside) is inked unless `ink` is null. */
  shape(inside: (x: number, y: number) => boolean, paint: (x: number, y: number) => RGB | null, ink: RGB | null = INK, box = [0, 0, N, N]) {
    for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
      if (!inside(x, y)) continue;
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      this.set(x, y, edge && ink ? ink : paint(x, y));
    }
  }
  rect(x0: number, y0: number, x1: number, y1: number, paint: (x: number, y: number) => RGB | null, ink: RGB | null = INK) {
    this.shape((x, y) => x >= x0 && x < x1 && y >= y0 && y < y1, paint, ink, [x0, y0, x1, y1]);
  }
  hline(x0: number, x1: number, y: number, col: RGB) { for (let x = x0; x < x1; x++) this.set(x, y, col); }
  vline(x: number, y0: number, y1: number, col: RGB) { for (let y = y0; y < y1; y++) this.set(x, y, col); }
}

/** Inside a convex polygon (points clockwise on screen). */
function poly(pts: [number, number][]) {
  return (x: number, y: number) => {
    const px = x + 0.5, py = y + 0.5;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((bx - ax) * (py - ay) - (by - ay) * (px - ax) < 0) return false;
    }
    return true;
  };
}
const ellipse = (cx: number, cy: number, rx: number, ry: number) => (x: number, y: number) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;

/** Hazard stripes: amber and ink on a 45° diagonal. */
const hazard = (x: number, y: number, shade = 0) => (((x + y) >> 1) % 3 === 0 ? INK : pick(AMBER, 0.55 - shade));

/** A chamfered plate in three-quarter view: lit top face, darker front face with a stripe band. */
function plate(s: Sheet, x0: number, x1: number, yTop: number, yFront: number, yBottom: number, cut: number, mat: RGB[], stripes = true) {
  const top = poly([[x0 + cut, yTop], [x1 - cut, yTop], [x1, yTop + cut], [x1, yFront], [x0, yFront], [x0, yTop + cut]]);
  const front = poly([[x0, yFront - 1], [x1, yFront - 1], [x1, yBottom - cut], [x1 - cut, yBottom], [x0 + cut, yBottom], [x0, yBottom - cut]]);
  s.shape(front, (x, y) => {
    if (stripes && y >= yFront + 2 && y < yBottom - 2 && x > x0 + 2 && x < x1 - 2) return hazard(x, y, (x - x0) / (x1 - x0) * 0.3);
    return pick(mat, y === yBottom - 2 ? 0.1 : 0.32 - (x - x0) / (x1 - x0) * 0.1);
  });
  s.shape(top, (x, y) => {
    if (y === yTop + 1 || (x === x0 + 1 && y > yTop + cut)) return pick(mat, 1);
    if (((x - x0) % 16 === 0 && y > yTop + 2) || y === yFront - 2) return pick(mat, 0.5);
    if ((x - x0) % 16 === 3 && (y - yTop) % 7 === 3) return pick(mat, 0.35);
    return pick(mat, 0.72 - (y - yTop) / (yFront - yTop) * 0.12);
  });
}

/** A vertical body of revolution (`r(y)` its radius), lit from the left. */
function lathe(s: Sheet, cx: number, y0: number, y1: number, r: (y: number) => number, mat: RGB[], seams = 0, band?: (y: number) => boolean) {
  s.shape((x, y) => y >= y0 && y < y1 && Math.abs(x + 0.5 - cx) <= r(y), (x, y) => {
    const nx = (x + 0.5 - cx) / r(y);
    let t = 0.62 - nx * 0.42 + (Math.abs(nx + 0.5) < 0.12 ? 0.22 : 0) + (nx > 0.78 ? 0.12 : 0);
    if (seams && (y - y0) % seams === 0) t -= 0.18;
    if (band?.(y)) return (((x + y) >> 1) % 3 === 0) ? INK : pick(AMBER, 0.75 - Math.max(0, nx) * 0.6);
    return pick(mat, t);
  }, INK, [Math.floor(cx - 20), y0, Math.ceil(cx + 20), y1]);
}

/** Lambert-shaded sphere, light from the top left, with latitude/longitude seams. */
function sphere(s: Sheet, cx: number, cy: number, r: number, mat: RGB[]) {
  const L = [-0.52, -0.62, 0.58];
  s.shape(ellipse(cx, cy, r, r), (x, y) => {
    const nx = (x + 0.5 - cx) / r, ny = (y + 0.5 - cy) / r, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const lam = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
    let t = 0.12 + lam * 0.88;
    const lat = Math.asin(ny) / (Math.PI / 12), lon = Math.atan2(nx, nz) / (Math.PI / 9);
    if (Math.abs(lat - Math.round(lat)) < 0.09 / Math.max(0.3, nz) * 0.6 || Math.abs(lon - Math.round(lon)) < 0.07 / Math.max(0.35, nz)) t -= 0.2;
    if (nx > 0.55 && ny > 0.35 && nz < 0.6) t += 0.14;   // bounce light on the shadow side
    return pick(mat, t);
  });
}

/** Radial glow: bright core fading through the ramp. */
const glow = (cx: number, cy: number, r: number, rp: RGB[]) => (x: number, y: number) => pick(rp, 1 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r);

function powerPlant(s: Sheet) {
  plate(s, 27, 101, 76, 91, 100, 4, TAN);
  // Cooling towers: hyperboloids pinched at the waist, the near one taller, hazard bands at the lip.
  const tower = (cx: number, top: number, bottom: number, rt: number, rw: number, rb: number) => {
    const yw = top + (bottom - top) * 0.6;
    const aTop = (yw - top) / Math.sqrt((rt / rw) ** 2 - 1), aBot = (bottom - yw) / Math.sqrt((rb / rw) ** 2 - 1);
    const r = (y: number) => rw * Math.sqrt(1 + ((y + 0.5 - yw) / (y < yw ? aTop : aBot)) ** 2);
    lathe(s, cx, top, bottom, r, STEEL, 8, (y) => y >= top + 4 && y < top + 7);
    s.shape(ellipse(cx, top + 0.5, rt + 0.5, 2.6), (_x, y) => (y <= top - 1 ? pick(STEEL, 1) : pick(STEEL, 0.78)));
    s.shape(ellipse(cx, top + 1, rt - 1.6, 1.5), (_x, y) => (y >= top + 1 ? pick(PLUM, 0.5) : STEEL[0]), null);
    s.set(cx + rt - 2, top - 2, RED[1]); s.set(cx + rt - 2, top - 3, RED[2]);
  };
  tower(59, 37, 84, 7.5, 5.2, 10);
  tower(42, 28, 86, 9, 6.2, 12.5);
  // Conduits from the towers into the reactor hall.
  for (const [y, x0] of [[76, 50], [81, 53]] as const) {
    s.rect(x0, y, 80, y + 4, (x, yy) => ((x - x0) % 6 === 0 ? pick(STEEL, 0.35) : pick(STEEL, yy === y + 1 ? 1 : yy === y + 2 ? 0.7 : 0.45)));
  }
  // Reactor hall: lit roof, steel walls, a dome ringed in lights.
  s.rect(74, 57, 99, 65, (x, y) => (y === 58 ? pick(STEEL, 1) : x === 75 ? pick(STEEL, 0.9) : pick(STEEL, 0.78)));
  s.rect(74, 64, 99, 89, (x, y) => {
    if (y === 65) return pick(STEEL, 0.4);
    if (x > 95 && (y - 67) % 4 < 2) return STEEL[1];
    return pick(STEEL, 0.6 - (x - 74) / 25 * 0.18);
  });
  s.shape((x, y) => ellipse(86.5, 59, 9, 7)(x, y) && y < 60, (x, y) => pick(STEEL, 0.78 - (x + 0.5 - 86.5) / 9 * 0.4 + (y < 54 ? 0.1 : 0)));
  for (let x = 80; x <= 93; x += 3) { s.set(x, 58, TEAL[3]); s.set(x, 59, TEAL[1]); }
  // The core: alpha matter burning behind a reinforced window.
  s.rect(77, 67, 95, 85, (x, y) => (x === 78 || y === 68 ? STEEL[1] : null));
  s.rect(79, 69, 93, 83, (x, y) => {
    const rod = (x - 79) % 4 === 1;
    const t = 1 - Math.hypot((x + 0.5 - 86) / 7, (y + 0.5 - 76) / 7.5) * 0.9;
    return rod ? pick(TEAL, t * 0.45) : pick(TEAL, t + 0.15);
  }, STEEL[0]);
  for (let x = 77; x <= 96; x += 3) s.set(x, 87, TEAL[2]);
  // Transformer bank, then a control hut out front with its warning lamp.
  for (const x of [54, 61, 68]) {
    s.rect(x, 85, x + 5, 92, (xx, y) => (y === 86 ? pick(STEEL, 0.9) : (xx + y) % 2 ? STEEL[2] : STEEL[3]));
    s.set(x + 2, 84, AMBER[3]);
  }
  s.rect(28, 76, 37, 91, (x, y) => (y === 77 ? pick(STEEL, 1) : y < 80 ? pick(STEEL, 0.8) : y > 85 && y < 88 ? hazard(x, y) : pick(STEEL, 0.52)));
  s.set(31, 82, TEAL[3]); s.set(33, 82, TEAL[2]);
  s.set(32, 74, RED[1]); s.set(32, 75, RED[0]);
}

function worldEngine(s: Sheet) {
  plate(s, 24, 104, 86, 96, 104, 6, STEEL);
  // The equatorial ring's far half sits behind the sphere.
  const ringOuter = ellipse(64, 60, 39, 9), ringInner = ellipse(64, 59, 31, 5.5);
  const ringPaint = (x: number, y: number) => {
    const ny = (y + 0.5 - 60) / 9;
    if (ny < -0.45) return pick(TAN, 0.95);
    return pick(TAN, 0.78 - ny * 0.35 - Math.abs(x + 0.5 - 64) / 39 * 0.3);
  };
  s.shape((x, y) => ringOuter(x, y) && !ringInner(x, y) && y < 59, ringPaint);
  // Buttresses cradling the core, conduits glowing up their faces.
  for (const side of [-1, 1]) {
    const pts: [number, number][] = side < 0
      ? [[31, 94], [40, 58], [48, 54], [48, 94]]
      : [[80, 94], [80, 54], [88, 58], [97, 94]];
    s.shape(poly(pts), (x, y) => {
      const lit = side < 0 ? x < 38 + (94 - y) * 0.2 : x < 84;
      if (Math.abs(x + 0.5 - (side < 0 ? 43 : 85)) < 1 && y > 61 && y < 91) return pick(TEAL, 0.55 + ((y >> 1) % 3 === 0 ? 0.4 : 0));
      return pick(STEEL, lit ? 0.7 : 0.4);
    });
  }
  sphere(s, 64, 51, 23, STEEL);
  // Near half of the ring, with running lights.
  s.shape((x, y) => ringOuter(x, y) && !ringInner(x, y) && y >= 59, (x, y) => {
    if (y >= 65 && y <= 66 && x % 5 === 0) return TEAL[3];
    return ringPaint(x, y);
  });
  // The aperture: a teal sun in an armoured iris.
  s.shape(ellipse(64, 47, 10.5, 10.5), (x, y) => pick(STEEL, 0.95 - (x + y - 94) / 36));
  s.shape(ellipse(64, 47, 8.2, 8.2), () => STEEL[0], null);
  s.shape(ellipse(64, 47, 6.8, 6.8), glow(64, 47, 7.3, TEAL), null);
  s.shape(ellipse(63, 46, 2.6, 2.6), () => TEAL[4], null);
  for (const [dx, dy] of [[0, -8], [0, 8], [-8, 0], [8, 0]]) s.set(64 + dx, 47 + dy, STEEL[6]);
  // Vents and the spire.
  for (const [x, y] of [[48, 37], [77, 39], [47, 58], [79, 58]]) s.rect(x, y, x + 4, y + 3, () => AMBER[2]);
  s.vline(64, 17, 29, STEEL[6]); s.vline(65, 17, 29, STEEL[3]); s.vline(63, 18, 29, INK); s.vline(66, 18, 29, INK);
  s.set(64, 16, RED[2]); s.set(65, 16, RED[1]); s.set(64, 15, INK); s.set(65, 15, INK);
  // Plate lights.
  for (let x = 34; x <= 94; x += 8) s.set(x, 91, TEAL[2]);
}

/** Battle damage, drawn: a blast hole with exposed wiring, cracks, scorch, a sheared corner, red lights. */
function damage(s: Sheet, seed: number) {
  let st = seed;
  const rnd = () => ((st = (Math.imul(st ^ (st >>> 13), 1103515245) + 12345) >>> 0) / 4294967296);
  // Lights die red.
  for (let i = 0; i < N * N; i++) {
    if (!s.c[i * 4 + 3]) continue;
    const r = s.c[i * 4], g = s.c[i * 4 + 1], b = s.c[i * 4 + 2];
    if (g > r + 40 && g > 120 && b > 90) { const k = g > 200 ? RED[2] : RED[1]; s.c[i * 4] = k[0]; s.c[i * 4 + 1] = k[1]; s.c[i * 4 + 2] = k[2]; }
  }
  // Scorch: darken around blast centres by a ramp step.
  const blasts: [number, number, number][] = [[50 + rnd() * 22, 44 + rnd() * 20, 7.5], [40 + rnd() * 36, 72 + rnd() * 8, 4.5]];
  for (const [bx, by, br] of blasts) {
    for (let y = Math.floor(by - br * 2.2); y < by + br * 2.2; y++) for (let x = Math.floor(bx - br * 2.2); x < bx + br * 2.2; x++) {
      if (!s.on(x, y)) continue;
      const d = Math.hypot(x + 0.5 - bx, (y + 0.5 - by) * 1.2) / br;
      if (d < 2.2 && rnd() < 1.3 - d * 0.5) { const c = s.get(x, y); s.set(x, y, [c[0] * 0.55, c[1] * 0.52, c[2] * 0.58]); }
    }
  }
  // The hole: jagged dark crater, ink rim, glowing wires.
  const [hx, hy, hr] = blasts[0];
  for (let y = Math.floor(hy - hr - 2); y < hy + hr + 2; y++) for (let x = Math.floor(hx - hr - 2); x < hx + hr + 2; x++) {
    if (!s.on(x, y)) continue;
    const a = Math.atan2(y - hy, x - hx), d = Math.hypot(x + 0.5 - hx, y + 0.5 - hy);
    const edge = hr * (0.7 + 0.3 * Math.sin(a * 5 + seed) + 0.15 * Math.sin(a * 11));
    if (d < edge - 1) s.set(x, y, d < edge * 0.5 ? PLUM[0] : pick(PLUM, 0.6 - d / edge * 0.4));
    else if (d < edge) s.set(x, y, INK);
  }
  for (let k = 0; k < 3; k++) {
    const col = [RED[2], hex('#3d85f5'), AMBER[3]][k];
    let x = hx - 2 + k * 2, y = hy;
    for (let i = 0; i < 4; i++) { s.set(x, y, col); x += rnd() < 0.5 ? 1 : 0; y += 1; }
  }
  // Cracks running off the hole.
  for (let k = 0; k < 3; k++) {
    let x = hx, y = hy, a = rnd() * Math.PI * 2;
    for (let i = 0; i < 14; i++) {
      x += Math.cos(a); y += Math.sin(a); a += (rnd() - 0.5) * 0.9;
      if (s.on(Math.floor(x), Math.floor(y))) s.set(x, y, INK);
    }
  }
  // A sheared corner and its fragments.
  const cx = 96 + rnd() * 6, cy = 82 + rnd() * 6;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (s.on(x, y) && (x - cx) + (y - cy) * 0.6 > 0 && x > cx - 8) s.clear(x, y);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (s.on(x, y) && (!s.on(x + 1, y) || !s.on(x, y + 1)) && (x - cx) + (y - cy) * 0.6 > -2.5 && x > cx - 10) s.set(x, y, INK);
  for (const [dx, dy] of [[6, 2], [9, -3], [4, 7]]) { s.set(cx + dx, cy + dy, STEEL[5]); s.set(cx + dx + 1, cy + dy, INK); s.set(cx + dx, cy + dy + 1, INK); }
}

export function drawFallbackArt(ctx: CanvasRenderingContext2D, typeId: number, variant: 'base' | 'dmg') {
  ctx.clearRect(0, 0, N, N);
  const s = new Sheet();
  if (typeId === 21) powerPlant(s);
  else worldEngine(s);
  if (variant === 'dmg') damage(s, typeId * 7919 + 17);
  const img = ctx.createImageData(N, N);
  img.data.set(s.c);
  ctx.putImageData(img, 0, 0);
}
