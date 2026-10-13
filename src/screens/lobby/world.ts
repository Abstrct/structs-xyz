/* The Concourse: a round hall 40 m across, in the manner of the Dreamcast-era online lobbies
 * (studied, never copied: every shape and texture here is drawn in code).
 *
 * Hull-panel walls stand under tall windows onto space and a planet. A ceiling ring is held up by
 * arched ribs that carry light. In the middle a pillar runs floor to ceiling on a stepped dais, with
 * the Structs chevron turning in its glass capsule. Round the walls stands a counter for each hub,
 * an attendant behind it and a green monitor on the back wall. The warp pad is to the north under
 * the notice screen; the Academy podium and the deck lift (where you arrive) are to the south.
 *
 * Light comes mostly from the textures: light strips, amber lamp rows, monitors. Each deck (chat
 * channel) has its own colour, as the old lobbies did. Far below is the hangar, where a new
 * commander's droid is built and waits for the guild.
 *
 * North is -z: the camera at the spawn looks down -z at the pillar and the warp behind it. */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HUBS } from '../../data/learn';
import { pfpAttrs } from '../../data/droidParts';
import { icon } from '../../ui/icons';
import { createNebulaSky, createStarfield } from '../../gfx/space';
import { Planet } from '../../gfx/planet';
import { DroidActor } from '../../gfx/droid/actor';
import { PLAZA_R, STATIONS, SPAWN, NOTICE, WARP, ACADEMY, KIOSK_R, KIOSK_DEG, DAIS_R, PAD_TOP } from './layout';
export * from './layout';

/* ── Deck colours: one hall, a colour per channel ─────────────────────── */

export interface Theme { floor: string; band: string; light: string }
export const THEMES: Record<string, Theme> = {
  '1': { floor: '#5866A8', band: '#8A2848', light: '#5FE3FF' },
  '2': { floor: '#4C8672', band: '#7A3A2A', light: '#86FFB4' },
  '3': { floor: '#9C6E4C', band: '#4E2A5A', light: '#FFC46B' },
  'G': { floor: '#6A58A2', band: '#244E72', light: '#D2A6FF' },
};
export const themeFor = (deckKey: string): Theme => THEMES[deckKey] ?? THEMES['1'];

/** The floor disc runs a little under the wall; its texture covers exactly this radius. */
const FLOOR_R = PLAZA_R + 0.5;

/* ── Painting helpers ─────────────────────────────────────────────────── */

const FONT = '"DC Display", "Exo 2", system-ui, sans-serif';
export const fontsReady = (): Promise<unknown> => (document.fonts?.load ? Promise.all([document.fonts.load(`italic 900 48px ${FONT}`), document.fonts.ready]).catch(() => null) : Promise.resolve(null));

function canvasTex(c: HTMLCanvasElement, nearest = false) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (nearest) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
  return t;
}
const canvas = (w: number, h = w) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const mixHex = (a: string, b: string, k: number) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), k).getHexString();

/** An SVG icon as an image (drawn in one colour). */
export function iconImage(name: string, color: string, size = 96): Promise<HTMLImageElement | null> {
  // As an image file an SVG needs its namespace (inline in the page it doesn't).
  const svg = icon(name, size).replace(/currentColor/g, color).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

/** A floating sign: an optional icon disc over a one-word label, painted once fonts are in. */
function sign(label: string, color: string, iconName?: string, w = 3.2): THREE.Sprite {
  const c = canvas(256, iconName ? 256 : 96);
  const tex = canvasTex(c);
  const paint = async () => {
    const img = iconName ? await iconImage(iconName, color, 110) : null;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    let y = 0;
    if (iconName) {
      g.fillStyle = 'rgba(7, 22, 41, 0.82)';
      g.beginPath(); g.arc(128, 84, 76, 0, Math.PI * 2); g.fill();
      g.lineWidth = 6; g.strokeStyle = color; g.stroke();
      if (img) g.drawImage(img, 128 - 55, 84 - 55, 110, 110);
      y = 168;
    }
    g.font = `italic 900 ${iconName ? 54 : 60}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.lineWidth = 8; g.strokeStyle = 'rgba(7, 22, 41, 0.9)';
    g.strokeText(label.toUpperCase(), 128, y + 8);
    g.fillStyle = '#EAF6FF';
    g.fillText(label.toUpperCase(), 128, y + 8);
    tex.needsUpdate = true;
  };
  void paint();
  void fontsReady().then(paint);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(w, w * c.height / c.width, 1);
  return s;
}

/** The floor in the deck's colours: tiled periwinkle, the maroon band round the dais, the pale
 * walkway by the walls with its row of amber lamps, thin red circuit runs, a pad before each counter. */
function paintFloor(color: HTMLCanvasElement, glow: HTMLCanvasElement, th: Theme) {
  const N = color.width, px = N / (FLOOR_R * 2), C = N / 2;
  const g = color.getContext('2d')!;
  const at = (r: number, a: number): [number, number] => [C + Math.sin(a) * r * px, C - Math.cos(a) * r * px];
  const annulus = (r0: number, r1: number, fill: string) => {
    g.fillStyle = fill; g.beginPath(); g.arc(C, C, r1 * px, 0, Math.PI * 2); g.arc(C, C, r0 * px, 0, Math.PI * 2, true); g.fill();
  };
  g.fillStyle = th.floor; g.fillRect(0, 0, N, N);
  // Tiles: rings every 1.6 m, seams every 7.5°, every other tile a shade lighter.
  for (let r = 4.4, k = 0; r < 17.6; r += 1.6, k++) {
    for (let i = 0; i < 48; i++) {
      if ((i + k) % 2) continue;
      const a0 = (i / 48) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 1) / 48) * Math.PI * 2 - Math.PI / 2;
      g.fillStyle = 'rgba(255, 255, 255, 0.05)';
      g.beginPath(); g.arc(C, C, Math.min(17.6, r + 1.6) * px, a0, a1); g.arc(C, C, r * px, a1, a0, true); g.fill();
    }
  }
  g.strokeStyle = 'rgba(10, 14, 40, 0.28)'; g.lineWidth = 2;
  for (let r = 4.4; r < 17.6; r += 1.6) { g.beginPath(); g.arc(C, C, r * px, 0, Math.PI * 2); g.stroke(); }
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    g.beginPath(); g.moveTo(...at(4.4, a)); g.lineTo(...at(17.6, a)); g.stroke();
  }
  // Red circuit runs: out, round, out again (seeded, so every deck draws them alike).
  let s = 41;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.strokeStyle = 'rgba(214, 64, 96, 0.75)'; g.lineWidth = 3;
  for (let i = 0; i < 16; i++) {
    const a = rnd() * Math.PI * 2, r0 = 5 + rnd() * 3, r1 = r0 + 2 + rnd() * 3, turn = (rnd() - 0.5) * 0.35, r2 = r1 + 1 + rnd() * 3;
    g.beginPath(); g.moveTo(...at(r0, a)); g.lineTo(...at(r1, a));
    g.arc(C, C, r1 * px, a - Math.PI / 2, a + turn - Math.PI / 2, turn < 0);
    g.lineTo(...at(Math.min(16.5, r2), a + turn)); g.stroke();
    g.fillStyle = 'rgba(214, 64, 96, 0.9)'; const [ex, ey] = at(Math.min(16.5, r2), a + turn); g.fillRect(ex - 4, ey - 4, 8, 8);
  }
  // The band round the dais, cream edged.
  annulus(DAIS_R - 0.1, 4.4, th.band);
  g.strokeStyle = '#E9E4D6'; g.lineWidth = 4; g.beginPath(); g.arc(C, C, 4.4 * px, 0, Math.PI * 2); g.stroke();
  // The walkway by the walls: pale, its own seams.
  annulus(17.6, PLAZA_R + 0.5, mixHex(th.floor, '#DDE3EE', 0.62));
  g.strokeStyle = 'rgba(40, 50, 80, 0.35)'; g.lineWidth = 2;
  for (let i = 0; i < 72; i++) { const a = (i / 72) * Math.PI * 2; g.beginPath(); g.moveTo(...at(17.6, a)); g.lineTo(...at(PLAZA_R, a)); g.stroke(); }
  g.strokeStyle = '#E9E4D6'; g.lineWidth = 5; g.beginPath(); g.arc(C, C, 17.6 * px, 0, Math.PI * 2); g.stroke();
  // A pad before each counter, in its hub's colour.
  for (const hb of HUBS) {
    const a = THREE.MathUtils.degToRad(KIOSK_DEG[hb.id]);
    g.fillStyle = mixHex(th.floor, hb.color, 0.35);
    g.beginPath(); g.arc(C, C, (KIOSK_R - 1.6) * px, a - 0.12 - Math.PI / 2, a + 0.12 - Math.PI / 2); g.arc(C, C, (KIOSK_R - 3.4) * px, a + 0.12 - Math.PI / 2, a - 0.12 - Math.PI / 2, true); g.fill();
  }

  // What glows: amber lamps along the walkway, the light colour's rings.
  const e = glow.getContext('2d')!;
  e.fillStyle = '#000'; e.fillRect(0, 0, N, N);
  e.fillStyle = '#FFC74A';
  for (let i = 0; i < 200; i++) { const [x, y] = at(17.85, (i / 200) * Math.PI * 2); e.fillRect(x - 4, y - 3, 8, 6); }
  // The rings run right under the camera: dim enough to sit at the bloom's edge, not flare.
  e.globalAlpha = 0.4;
  e.strokeStyle = th.light; e.lineWidth = 3;
  for (const r of [4.5, 17.5]) { e.beginPath(); e.arc(C, C, r * px, 0, Math.PI * 2); e.stroke(); }
  e.globalAlpha = 1;
  for (const hb of HUBS) {
    const a = THREE.MathUtils.degToRad(KIOSK_DEG[hb.id]);
    e.strokeStyle = hb.color; e.lineWidth = 4;
    e.beginPath(); e.arc(C, C, (KIOSK_R - 3.4) * px, a - 0.12 - Math.PI / 2, a + 0.12 - Math.PI / 2); e.stroke();
  }
}

/** Hull plating: pale panels, dark insets with small lights, a darker kick plate. Tiles across. */
function hullTexture(): THREE.CanvasTexture {
  const c = canvas(256), g = c.getContext('2d')!;
  g.fillStyle = '#CDD3DB'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#B9C0CA'; g.fillRect(0, 0, 256, 12); g.fillRect(0, 128, 256, 6);
  g.fillStyle = '#8E96A6'; g.fillRect(0, 214, 256, 42);
  g.fillStyle = '#3C4352';
  g.fillRect(20, 46, 96, 54); g.fillRect(140, 46, 96, 54);
  g.fillStyle = '#5A6274'; g.fillRect(26, 52, 84, 8); g.fillRect(146, 52, 84, 8);
  g.fillStyle = '#6FE0FF'; for (const x of [32, 48, 152, 168]) g.fillRect(x, 84, 8, 6);
  g.fillStyle = '#FF5A7A'; g.fillRect(212, 84, 8, 6);
  g.strokeStyle = 'rgba(40, 46, 60, 0.55)'; g.lineWidth = 2;
  g.strokeRect(1, 1, 254, 254); g.beginPath(); g.moveTo(128, 0); g.lineTo(128, 214); g.stroke();
  g.fillStyle = 'rgba(40, 46, 60, 0.6)';
  for (const [x, y] of [[8, 20], [248, 20], [8, 200], [248, 200], [120, 140], [136, 140]]) g.fillRect(x - 2, y - 2, 4, 4);
  g.strokeStyle = 'rgba(0, 0, 0, 0.35)'; g.lineWidth = 3; g.beginPath(); g.moveTo(0, 150); g.lineTo(256, 150); g.stroke();
  const t = canvasTex(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** A counter's front: blue-violet panelling, a light strip, a row of amber keys. */
function counterTexture(hub: string): THREE.CanvasTexture {
  const c = canvas(256, 96), g = c.getContext('2d')!;
  g.fillStyle = '#5560A0'; g.fillRect(0, 0, 256, 96);
  g.fillStyle = '#434C86'; g.fillRect(0, 60, 256, 36);
  g.fillStyle = '#E3E7EE'; g.fillRect(0, 0, 256, 8);
  g.fillStyle = hub; g.fillRect(10, 16, 236, 6);
  g.fillStyle = '#2F3666'; for (let x = 18; x < 240; x += 38) g.fillRect(x, 30, 30, 22);
  g.fillStyle = '#FFC74A'; for (let x = 24; x < 240; x += 19) g.fillRect(x, 70, 8, 6);
  return canvasTex(c);
}

/** A green CRT: a grid, a sweep and two traces, one in the hub's colour. */
function monitorTexture(hub: string, seed: number): THREE.CanvasTexture {
  const c = canvas(256, 144), g = c.getContext('2d')!;
  g.fillStyle = '#0C2E10'; g.fillRect(0, 0, 256, 144);
  g.fillStyle = '#1F6A26'; g.fillRect(8, 8, 240, 128);
  g.strokeStyle = 'rgba(160, 255, 150, 0.35)'; g.lineWidth = 1;
  for (let x = 8; x <= 248; x += 24) { g.beginPath(); g.moveTo(x, 8); g.lineTo(x, 136); g.stroke(); }
  for (let y = 8; y <= 136; y += 16) { g.beginPath(); g.moveTo(8, y); g.lineTo(248, y); g.stroke(); }
  const trace = (col: string, k: number) => {
    g.strokeStyle = col; g.lineWidth = 3; g.beginPath();
    for (let x = 8; x <= 248; x += 4) { const y = 72 + Math.sin(x * 0.04 * k + seed) * 34 * Math.sin(x * 0.011 + k); x === 8 ? g.moveTo(x, y) : g.lineTo(x, y); }
    g.stroke();
  };
  trace(hub, 1.2); trace('#FF4A4A', 0.7);
  g.strokeStyle = '#BFFFC0'; g.lineWidth = 2; g.beginPath(); g.arc(196, 52, 30, -0.4, 2.2); g.stroke();
  g.fillStyle = '#BFFFC0'; for (let i = 0; i < 6; i++) g.fillRect(16 + i * 10, 118, 6, 10 - i);
  return canvasTex(c);
}

/** Vertical light: bright at the base, fading up (beams, the warp, the capsule). */
function beamTexture(): THREE.CanvasTexture {
  const c = canvas(64, 128), g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 128, 0, 0);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)'); grd.addColorStop(0.55, 'rgba(255,255,255,0.3)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 128);
  g.fillStyle = 'rgba(0,0,0,0.45)'; for (let x = 0; x < 64; x += 8) g.fillRect(x, 0, 3, 128);
  return canvasTex(c);
}

/** The warp pad's face: rings and a cross-hatch of light. */
function warpTexture(): THREE.CanvasTexture {
  const c = canvas(256), g = c.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#fff';
  for (let r = 20; r < 128; r += 18) { g.lineWidth = r % 36 ? 2 : 5; g.beginPath(); g.arc(128, 128, r, 0, Math.PI * 2); g.stroke(); }
  g.lineWidth = 2;
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; g.beginPath(); g.moveTo(128 + Math.cos(a) * 20, 128 + Math.sin(a) * 20); g.lineTo(128 + Math.cos(a) * 124, 128 + Math.sin(a) * 124); g.stroke(); }
  const t = canvasTex(c);
  t.center.set(0.5, 0.5);
  return t;
}

/* ── The hall ─────────────────────────────────────────────────────────── */

export interface World {
  plaza: THREE.Group;
  hangar: THREE.Group;
  /** The hangar lift's ring: orange while the guild builds you, cyan when ready. */
  setLiftReady(ready: boolean): void;
  /** Recolour the hall for a deck. */
  setTheme(th: Theme): void;
  /** Free what bakes again by itself (the planet's cube maps): call on leaving the screen. */
  release(): void;
  noticeCanvas: HTMLCanvasElement;
  noticeTexture: THREE.CanvasTexture;
  sky: THREE.Object3D[];
  /** `live` false (the screen has gone) keeps released things released. */
  update(t: number, camera?: THREE.Vector3, dt?: number, live?: boolean): void;
  dispose(): void;
}

export const HANGAR_Y = -400;
const WALL_H = 3.2, WIN_TOP = 10.8, CEIL_IN = 13.6;
/** How bright a light strip burns, as the bloom's high pass measures it (its threshold is 1; lit
 * paint peaks ~0.85). Bloom goes by luminance, so every hue is pushed to the same level: a deep red
 * needs far more than a cyan. */
const LAMP_LUM = 1.6;
/** The hangar ring: softer, the droid stands in it and the camera is close. */
const HRING_LUM = 1.25;
/** The floor's painted lamps (amber row, light rings). */
const FLOOR_GLOW = 2.6;
const luma = (c: THREE.Color) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
const burn = (c: THREE.Color, lum: number) => c.multiplyScalar(Math.min(8, lum / Math.max(0.05, luma(c))));

export function buildWorld(scene: THREE.Scene, renderer: THREE.WebGLRenderer, opts: { lite?: boolean } = {}): World {
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };
  const std = (color: THREE.ColorRepresentation, o: THREE.MeshStandardMaterialParameters = {}) => keep(new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.25, ...o }));
  const glow = (color: THREE.ColorRepresentation, o: THREE.MeshBasicMaterialParameters = {}) => keep(new THREE.MeshBasicMaterial({ color, toneMapped: false, ...o }));
  const lamp = (color: THREE.ColorRepresentation, o: THREE.MeshBasicMaterialParameters = {}, lum = LAMP_LUM) => { const m = glow(color, o); burn(m.color, lum); return m; };
  const signs: THREE.Sprite[] = [];
  const mkSign = (...a: Parameters<typeof sign>) => { const s = sign(...a); signs.push(s); return s; };
  const inScene: THREE.Object3D[] = [];
  const put = (o: THREE.Object3D) => { scene.add(o); inScene.push(o); return o; };
  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], at: [number, number, number] = [0, 0, 0], rot?: [number, number, number]) => {
    const m = new THREE.Mesh(keep(geo), mat);
    m.position.set(...at);
    if (rot) m.rotation.set(...rot);
    parent.add(m);
    return m;
  };

  scene.background = new THREE.Color(0x040a1a);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTex = pmrem.fromScene(room, 0.04).texture;
  room.dispose(); pmrem.dispose();
  scene.environment = envTex;
  (scene as THREE.Scene & { environmentIntensity?: number }).environmentIntensity = 0.4;
  disposables.push(envTex);

  const sky = [createNebulaSky({ seed: 5.2, intensity: 0.85 }), createStarfield(3000, 800, 9)];
  for (const s of sky) put(s);

  // High-key, as those halls were: a bright sky-blue fill, a warm key from above. Lit white stays
  // under the bloom threshold; only the lamps go over it.
  const hemi = new THREE.HemisphereLight(0xdce9ff, 0x5866a8, 0.85);
  put(hemi);
  const key = new THREE.DirectionalLight(0xfff4e0, 0.75);
  key.position.set(5, 14, 6);
  put(key);
  const fill = new THREE.DirectionalLight(0x8fb4e0, 0.3);
  fill.position.set(-8, 6, -7);
  put(fill);

  const plaza = new THREE.Group();
  plaza.name = 'plaza';
  put(plaza);
  const hull = keep(hullTexture());
  const white = std('#E3E7EE', { roughness: 0.45, metalness: 0.2 });
  const dark = std('#2A3354', { roughness: 0.6 });
  // In the deck's light colour: a lamp (burnt to LAMP_LUM), or with `soft`, a plain multiple of it.
  const lightMats: { m: THREE.MeshBasicMaterial; soft?: number }[] = [];
  const themed = (o: THREE.MeshBasicMaterialParameters = {}, soft?: number) => { const m = glow('#5FE3FF', o); lightMats.push({ m, soft }); return m; };

  // ── Floor and walkway ──
  const floorColor = canvas(1024), floorGlow = canvas(1024);
  const floorTex = keep(canvasTex(floorColor)), floorGlowTex = keep(canvasTex(floorGlow));
  floorTex.anisotropy = 4;
  const floorMat = std('#ffffff', { map: floorTex, emissive: 0xffffff, emissiveMap: floorGlowTex, emissiveIntensity: FLOOR_GLOW, roughness: 0.5, metalness: 0.1 });
  add(plaza, new THREE.CircleGeometry(FLOOR_R, 96), floorMat, [0, 0, 0], [-Math.PI / 2, 0, 0]).name = 'floor';

  // ── Walls, windows, ceiling ──
  const wallTex = hull.clone(); wallTex.repeat.set(30, 1); wallTex.needsUpdate = true; keep(wallTex);
  add(plaza, new THREE.CylinderGeometry(PLAZA_R + 0.4, PLAZA_R + 0.4, WALL_H, 96, 1, true), std('#ffffff', { map: wallTex, side: THREE.BackSide, roughness: 0.5 }), [0, WALL_H / 2, 0]);
  add(plaza, new THREE.TorusGeometry(PLAZA_R + 0.3, 0.05, 6, 128), lamp('#FF4FA0', {}, 1.15), [0, 1.05, 0], [Math.PI / 2, 0, 0]);
  add(plaza, new THREE.TorusGeometry(PLAZA_R + 0.35, 0.16, 6, 128), white, [0, WALL_H, 0], [Math.PI / 2, 0, 0]);
  add(plaza, new THREE.TorusGeometry(PLAZA_R + 0.35, 0.2, 6, 128), white, [0, WIN_TOP, 0], [Math.PI / 2, 0, 0]);
  add(plaza, new THREE.CylinderGeometry(PLAZA_R + 0.5, PLAZA_R + 0.5, WIN_TOP - WALL_H, 64, 1, true),
    keep(new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.06, side: THREE.BackSide, depthWrite: false })), [0, (WALL_H + WIN_TOP) / 2, 0]);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const m = add(plaza, new THREE.BoxGeometry(0.34, WIN_TOP - WALL_H, 0.4), white, [Math.sin(a) * (PLAZA_R + 0.35), (WALL_H + WIN_TOP) / 2, -Math.cos(a) * (PLAZA_R + 0.35)]);
    m.rotation.y = -a;
  }
  // The ceiling ring, its round lamps, and the inner lit edge.
  add(plaza, new THREE.RingGeometry(CEIL_IN - 0.2, PLAZA_R + 0.6, 96), std('#C9D0DA', { side: THREE.DoubleSide, roughness: 0.6 }), [0, WIN_TOP + 0.05, 0], [Math.PI / 2, 0, 0]);
  add(plaza, new THREE.TorusGeometry(CEIL_IN - 0.2, 0.12, 6, 96), themed(), [0, WIN_TOP, 0], [Math.PI / 2, 0, 0]);
  const lampGeo = keep(new THREE.CircleGeometry(0.42, 16));
  const lamps = keep(new THREE.InstancedMesh(lampGeo, themed({ side: THREE.DoubleSide }), 48));
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
  for (let i = 0; i < 48; i++) {
    const a = (i / 24) * Math.PI * 2 + (i >= 24 ? Math.PI / 24 : 0), r = i < 24 ? 18.6 : 15.6;
    mtx.compose(new THREE.Vector3(Math.sin(a) * r, WIN_TOP - 0.01, -Math.cos(a) * r), q, new THREE.Vector3(1, 1, 1));
    lamps.setMatrixAt(i, mtx);
  }
  plaza.add(lamps);
  // Twelve ribs arch from the window tops to the crown, each carrying a strip of light.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
    const P = (r: number, y: number) => new THREE.Vector3(Math.sin(a) * r, y, -Math.cos(a) * r);
    const curve = new THREE.CatmullRomCurve3([P(PLAZA_R + 0.3, WIN_TOP), P(17, 13.2), P(11, 15.4), P(5.2, 16.2)]);
    add(plaza, new THREE.TubeGeometry(curve, 36, 0.26, 6), white);
    const strip = new THREE.CatmullRomCurve3(curve.points.map((p) => p.clone().add(new THREE.Vector3(0, -0.24, 0))));
    add(plaza, new THREE.TubeGeometry(strip, 36, 0.07, 4), themed());
  }
  // The crown over the pillar.
  add(plaza, new THREE.CylinderGeometry(5.4, 5.4, 0.6, 48), dark, [0, 16.5, 0]);
  add(plaza, new THREE.TorusGeometry(5.3, 0.12, 6, 64), themed(), [0, 16.2, 0], [Math.PI / 2, 0, 0]);
  add(plaza, new THREE.CircleGeometry(4.2, 48), themed({ transparent: true, opacity: 0.55, side: THREE.DoubleSide }, 1), [0, 16.19, 0], [Math.PI / 2, 0, 0]);

  // ── The pillar ──
  const beam = keep(beamTexture());
  const band = std('#8A2848');
  add(plaza, new THREE.CylinderGeometry(DAIS_R, DAIS_R + 0.1, 0.18, 64), band, [0, 0.09, 0]);
  add(plaza, new THREE.CylinderGeometry(2.7, 2.8, 0.22, 64), std('#E9E4D6', { roughness: 0.5 }), [0, 0.29, 0]);
  const colTex = hull.clone(); colTex.repeat.set(4, 1); colTex.needsUpdate = true; keep(colTex);
  const column = std('#ffffff', { map: colTex });
  add(plaza, new THREE.CylinderGeometry(1.55, 1.75, 1.2, 32), column, [0, 1.0, 0]);
  add(plaza, new THREE.TorusGeometry(1.32, 0.07, 6, 48), themed(), [0, 1.62, 0], [Math.PI / 2, 0, 0]);
  add(plaza, new THREE.CylinderGeometry(1.15, 1.15, 2.7, 32, 1, true), keep(new THREE.MeshBasicMaterial({ color: 0xa0e8ff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })), [0, 3.0, 0]);
  const core = add(plaza, new THREE.CylinderGeometry(0.85, 0.85, 2.6, 24, 1, true), themed({ map: beam, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }, 1.2), [0, 3.0, 0]);
  add(plaza, new THREE.TorusGeometry(1.32, 0.07, 6, 48), themed(), [0, 4.38, 0], [Math.PI / 2, 0, 0]);
  add(plaza, new THREE.CylinderGeometry(1.25, 1.5, 0.7, 32), white, [0, 4.75, 0]);
  add(plaza, new THREE.CylinderGeometry(0.85, 1.0, 11.2, 24), column, [0, 10.7, 0]);
  for (const y of [6.6, 8.8, 11, 13.2]) add(plaza, new THREE.TorusGeometry(0.93, 0.06, 6, 40), themed(), [0, y, 0], [Math.PI / 2, 0, 0]);
  // The Structs chevron turning in the capsule.
  const mark = new THREE.Group();
  const shape = (pts: [number, number][]) => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x - 8, 8 - y)));
  const hullShape = shape([[2.5, 3.5], [10, 3.5], [13.5, 8], [10, 12.5], [2.5, 12.5], [6, 8]]);
  const cut = shape([[6, 8], [3.8, 5.2], [8.1, 5.2], [10.3, 8], [8.1, 10.8], [3.8, 10.8]]);
  const ext = { depth: 1.2, bevelEnabled: true, bevelThickness: 0.25, bevelSize: 0.2, bevelSegments: 1 };
  const markHull = new THREE.Mesh(keep(new THREE.ExtrudeGeometry(hullShape, ext)), std('#43CDB6', { emissive: '#43CDB6', emissiveIntensity: 0.7 }));
  const markCut = new THREE.Mesh(keep(new THREE.ExtrudeGeometry(cut, { ...ext, depth: 1.8 })), std('#0B1240', { emissive: '#0B1240' }));
  markHull.position.z = -0.6; markCut.position.z = -0.9;
  mark.add(markHull, markCut);
  mark.scale.setScalar(0.15);
  mark.position.y = 3.0;
  plaza.add(mark);
  const capsuleLight = new THREE.PointLight(0x5fe3ff, 5, 13, 1.6);
  capsuleLight.position.y = 3;
  plaza.add(capsuleLight);
  const crownLight = new THREE.PointLight(0xffffff, 3.5, 24, 1.4);
  crownLight.position.y = 12;
  plaza.add(crownLight);

  // ── Counters: one per hub, an attendant and a monitor behind each ──
  const attendants: DroidActor[] = [];
  STATIONS.filter((s) => s.kind === 'kiosk').forEach((st, idx) => {
    const k = new THREE.Group();
    k.position.copy(st.at);
    k.lookAt(0, 0, 0);
    const front = keep(counterTexture(st.color));
    add(k, new THREE.BoxGeometry(3.4, 1.0, 0.8), [white, white, white, white, std('#ffffff', { map: front }), white], [0, 0.5, 0.3]);
    add(k, new THREE.BoxGeometry(3.7, 0.09, 1.05), white, [0, 1.04, 0.3]);
    add(k, new THREE.BoxGeometry(3.4, 0.05, 0.03), lamp(st.color), [0, 0.97, 0.72]);
    const back = hull.clone(); back.repeat.set(2, 1); back.needsUpdate = true; keep(back);
    add(k, new THREE.BoxGeometry(4.0, 3.0, 0.3), std('#ffffff', { map: back }), [0, 1.5, -1.55]);
    add(k, new THREE.PlaneGeometry(2.7, 1.5), glow('#ffffff', { map: keep(monitorTexture(st.color, idx * 1.7)) }), [0, 1.85, -1.39]);
    for (const x of [-2.1, 2.1]) {
      add(k, new THREE.BoxGeometry(0.34, 3.4, 0.5), white, [x, 1.7, -1.45]);
      add(k, new THREE.BoxGeometry(0.06, 2.8, 0.04), lamp(st.color), [x, 1.75, -1.18]);
    }
    const s = mkSign(st.label, st.color, st.hub, 2.2);
    s.position.set(0, 4.15, -1.4);
    k.add(s);
    plaza.add(k);
    // The attendant stands behind the counter, facing you.
    const att = new DroidActor(pfpAttrs(null, `attendant:${st.id}`), { seed: `attendant:${st.id}`, lite: opts.lite });
    att.group.position.copy(st.at).add(new THREE.Vector3(-st.at.x, 0, -st.at.z).normalize().multiplyScalar(-0.75));
    att.group.rotation.y = Math.atan2(-st.at.x, -st.at.z);
    plaza.add(att.group);
    attendants.push(att);
  });

  // ── The warp pad: walk on, and out ──
  const warp = new THREE.Group();
  warp.position.copy(WARP);
  // Raised, as the lift is: droids step up onto it (floorAt in layout.ts).
  add(warp, new THREE.CylinderGeometry(1.9, 2.0, PAD_TOP - 0.015, 48), white, [0, (PAD_TOP - 0.015) / 2, 0]);
  add(warp, new THREE.CylinderGeometry(1.72, 1.72, 0.02, 48), dark, [0, PAD_TOP - 0.015, 0]);
  const warpTex = keep(warpTexture());
  add(warp, new THREE.CircleGeometry(1.7, 48), themed({ map: warpTex, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }, 1.4), [0, PAD_TOP, 0], [-Math.PI / 2, 0, 0]);
  add(warp, new THREE.CylinderGeometry(1.7, 1.7, 3.4, 48, 1, true), themed({ map: beam, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }, 1.2), [0, 1.8, 0]);
  add(warp, new THREE.TorusGeometry(1.8, 0.08, 6, 48), white, [0, 3.5, 0], [Math.PI / 2, 0, 0]);
  const warpSign = mkSign('Warp', '#79D3F2', 'battle', 2.2);
  warpSign.position.set(0, 4.5, 0);
  warp.add(warpSign);
  plaza.add(warp);

  // ── The news: a terminal by the north wall, the live feed on a big screen hung above it ──
  const noticeCanvas = canvas(768, 384);
  const noticeTexture = keep(canvasTex(noticeCanvas));
  const notice = new THREE.Group();
  notice.position.copy(NOTICE);
  notice.lookAt(0, 0, 0);
  const back = -(PLAZA_R + 0.15 - NOTICE.length());
  add(notice, new THREE.BoxGeometry(6.6, 3.5, 0.3), white, [0, 5.3, back]);
  add(notice, new THREE.PlaneGeometry(6.2, 3.1), glow(0xffffff, { map: noticeTexture }), [0, 5.3, back + 0.16]);
  add(notice, new THREE.BoxGeometry(6.2, 0.06, 0.04), themed(), [0, 3.62, back + 0.17]);
  const nTex = hull.clone(); nTex.repeat.set(1, 0.6); nTex.needsUpdate = true; keep(nTex);
  add(notice, new THREE.BoxGeometry(0.9, 1.0, 0.5), std('#ffffff', { map: nTex }), [0, 0.5, 0]);
  const nDesk = new THREE.Group();
  nDesk.position.set(0, 1.05, 0.05);
  nDesk.rotation.x = 0.5;
  add(nDesk, new THREE.BoxGeometry(1.0, 0.08, 0.62), white);
  add(nDesk, new THREE.PlaneGeometry(0.86, 0.5), glow(0xffffff, { map: noticeTexture }), [0, 0.045, 0], [-Math.PI / 2, 0, 0]);
  notice.add(nDesk);
  plaza.add(notice);

  // ── The Academy podium ──
  const acad = new THREE.Group();
  acad.position.copy(ACADEMY);
  acad.lookAt(0, 0, 0);
  // A slim console: a pedestal, a slanted lit desk, the hub-style strip.
  const acTex = hull.clone(); acTex.repeat.set(1, 0.6); acTex.needsUpdate = true; keep(acTex);
  add(acad, new THREE.CylinderGeometry(0.62, 0.7, 0.12, 24), white, [0, 0.06, 0]);
  add(acad, new THREE.BoxGeometry(0.46, 0.95, 0.4), std('#ffffff', { map: acTex }), [0, 0.6, 0]);
  const desk = new THREE.Group();
  desk.position.set(0, 1.1, 0.05);
  desk.rotation.x = 0.5;
  add(desk, new THREE.BoxGeometry(1.0, 0.08, 0.62), white);
  add(desk, new THREE.PlaneGeometry(0.84, 0.48), glow('#ffffff', { map: keep(monitorTexture('#F5C518', 4.2)) }), [0, 0.045, 0], [-Math.PI / 2, 0, 0]);
  add(desk, new THREE.BoxGeometry(1.0, 0.03, 0.03), lamp('#F5C518'), [0, -0.03, 0.31]);
  acad.add(desk);
  const acSign = mkSign('Academy', '#F5C518', 'academy', 1.7);
  acSign.position.set(0, 2.6, 0);
  acad.add(acSign);
  plaza.add(acad);

  // ── The deck lift: where you arrive, and where you change channel ──
  const lift = new THREE.Group();
  lift.position.copy(SPAWN);
  add(lift, new THREE.CylinderGeometry(1.5, 1.6, PAD_TOP - 0.015, 40), white, [0, (PAD_TOP - 0.015) / 2, 0]);
  add(lift, new THREE.CylinderGeometry(1.32, 1.32, 0.02, 40), dark, [0, PAD_TOP - 0.015, 0]);
  // Softer than the other lamps: you stand right in it, and its bloom would wash over you.
  add(lift, new THREE.TorusGeometry(1.42, 0.05, 6, 48), themed({}, 1.3), [0, PAD_TOP - 0.005, 0], [Math.PI / 2, 0, 0]);
  add(lift, new THREE.CircleGeometry(1.3, 40), themed({ map: warpTex, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }, 0.6), [0, PAD_TOP, 0], [-Math.PI / 2, 0, 0]);
  const lSign = mkSign('Decks', '#79D3F2', 'chat', 1.3);
  // On the wall side of the pad: behind you when you arrive, never between you and the hall.
  lSign.position.set(0, 3.0, 1.5);
  lift.add(lSign);
  plaza.add(lift);

  // ── Outside the windows: a world below, turning ──
  const planet = new Planet({ radius: 1, palette: [0x0e2a4c, 0x2f6b4a, 0xc8b88a], seed: 7.7, atmosphere: 0x7fc4ff, tilt: [-0.35, 0.25], detail: 512 });
  planet.group.scale.setScalar(46);
  planet.group.position.set(-60, 16, -118);
  planet.setSun(new THREE.Vector3(1, 0.5, 0.6));
  put(planet.group);

  /* ── The hangar (setup and arrival) ── */
  const hangar = new THREE.Group();
  hangar.name = 'hangar';
  hangar.position.y = HANGAR_Y;
  hangar.visible = false;
  put(hangar);
  add(hangar, new THREE.CircleGeometry(14, 48), std('#0A1C33', { roughness: 0.9, metalness: 0.1 }), [0, 0, 0], [-Math.PI / 2, 0, 0]);
  for (let i = -5; i <= 5; i++) add(hangar, new THREE.BoxGeometry(0.35, 9, 0.35), std('#0A1F38'), [i * 1.9, 4.5, -5 + Math.abs(i) * 0.25]);
  add(hangar, new THREE.PlaneGeometry(30, 10), std('#071629', { roughness: 1, metalness: 0 }), [0, 5, -6]);
  add(hangar, new THREE.CylinderGeometry(1.25, 1.35, 0.14, 40), std('#0F3352'), [0, 0.07, 0]);
  const hringMat = lamp('#FF6A13', {}, HRING_LUM);
  add(hangar, new THREE.TorusGeometry(1.3, 0.06, 6, 64), hringMat, [0, 0.15, 0], [Math.PI / 2, 0, 0]);
  // Only the cone's far wall draws, so the light never washes over the droid standing in it.
  add(hangar, new THREE.CylinderGeometry(0.5, 2.2, 7, 32, 1, true), glow('#79D3F2', { map: beam, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide }), [0, 3.5, 0]);
  const hlight = new THREE.PointLight(0xbfe8ff, 4, 9, 1.5);
  hlight.position.set(0, 4.5, 1.5);
  hangar.add(hlight);

  let liftReady = true, released = false;
  const tmp = new THREE.Vector3();
  const setTheme = (th: Theme) => {
    paintFloor(floorColor, floorGlow, th);
    floorTex.needsUpdate = true; floorGlowTex.needsUpdate = true;
    for (const { m, soft } of lightMats) { m.color.set(th.light); if (soft) m.color.multiplyScalar(soft); else burn(m.color, LAMP_LUM); }
    band.color.set(th.band);
    capsuleLight.color.set(th.light);
    hemi.groundColor.set(th.floor);
  };
  setTheme(THEMES['1']);

  return {
    plaza, hangar, sky, noticeCanvas, noticeTexture, setTheme,
    release() { planet.release(); released = true; },
    setLiftReady(ready) { liftReady = ready; burn(hringMat.color.set(ready ? '#79D3F2' : '#FF6A13'), HRING_LUM); },
    update(t, camera, dt = 1 / 60, live = true) {
      if (live) released = false;
      if (camera) for (const sp of signs) {
        sp.getWorldPosition(tmp);
        (sp.material as THREE.SpriteMaterial).opacity = THREE.MathUtils.clamp((camera.distanceTo(tmp) - 3.5) / 4, 0, 1);
      }
      if (plaza.visible) {
        mark.rotation.y = t * 0.6;
        mark.position.y = 3.0 + Math.sin(t * 0.9) * 0.12;
        (core.material as THREE.MeshBasicMaterial).opacity = 0.3 + Math.sin(t * 1.7) * 0.08;
        warpTex.rotation = -t * 0.6;
        if (!released) planet.update(dt, t);
        for (const a of attendants) a.update(dt, t);
      }
      if (!liftReady) burn(hringMat.color.setHSL(0.06, 1, 0.5, THREE.SRGBColorSpace), HRING_LUM * (1 + Math.sin(t * 4) * 0.2));
    },
    dispose() {
      for (const o of inScene) scene.remove(o);
      for (const d of disposables) d.dispose();
      for (const s of signs) { s.material.map?.dispose(); s.material.dispose(); }
      for (const s of sky) s.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
      for (const a of attendants) a.dispose();
      planet.dispose();
      scene.environment = null;
    },
  };
}
