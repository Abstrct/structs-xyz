/* Dev only (/dev/hulls.html, never built): the new struct hulls turning under lobby-like light, and
 * each one's portraits beside the old pixel art at the sizes the UI uses. */
import * as THREE from 'three';
import { RECIPES, hullGeometry } from '../gfx/hull/recipes';
import { hullMaterial } from '../gfx/hull/kit';
import { hullPortrait } from '../gfx/hull/portrait';
import { TYPES_BY_ID } from '../data/catalogue';

const ids = Object.keys(RECIPES).map(Number);

/** The official pixel art's layers (bottom, hull, top), for comparison only: the app no longer uses them. */
const OLD: Record<number, [string, string[], string[]]> = {
  1: ['cmd-ship', [], ['top-weapon']], 2: ['battleship', [], []], 3: ['starfighter', ['bottom-weapon-smart'], ['top-weapon-ballistic']],
  4: ['frigate', ['bottom-weapon'], []], 5: ['pursuit-fighter', ['bottom-weapon'], []], 6: ['stealth-bomber', ['bottom-weapon'], []],
  7: ['interceptor', ['bottom-weapon'], []], 8: ['mobile-artillery', [], ['top-weapon']], 9: ['tank', [], ['top-weapon']],
  10: ['sam-launcher', [], ['top-weapon']], 11: ['cruiser', ['bottom-ripples'], ['top-weapon-ballistic', 'top-weapon-smart']],
  12: ['destroyer', ['bottom-ripples'], ['top-weapon']], 13: ['submersible', ['bottom-ripples'], ['top-weapon']],
  14: ['extractor', [], ['top-drill']], 15: ['refinery', [], ['top-bays']], 16: ['orb-shield', [], ['top-weapon']],
  17: ['jamming-sat', [], ['top-weapon']], 18: ['ore-bunker', [], ['top-weapon']], 19: ['pdc', [], ['top-weapon']], 20: ['generator', [], ['top-tube']],
};
async function compositeSprite(id: number): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const spec = OLD[id];
  if (!spec) return c;
  const [dir, bottom, top] = spec;
  for (const layer of [...bottom, 'struct-base', ...top]) {
    const img = new Image();
    img.src = `/img/structs/${dir}/${dir}-${layer}.webp`;
    await img.decode().catch(() => null);
    c.getContext('2d')!.drawImage(img, 0, 0);
  }
  return c;
}

// ── The turntable ──
const canvas = document.getElementById('turn') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1730);
scene.add(new THREE.HemisphereLight(0xdce9ff, 0x3a3560, 1.0));
const key = new THREE.DirectionalLight(0xfff1dc, 2.2);
key.position.set(-3, 6, 5);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9fd8ff, 2.0);
rim.position.set(4, 3, -6);
scene.add(rim);
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
const spin: THREE.Object3D[] = [];
const COLS = 6, ROWS = Math.ceil(ids.length / COLS);
ids.forEach((id, i) => {
  const g = new THREE.Group();
  g.position.set((i % COLS - (COLS - 1) / 2) * 3.2, 0, (Math.floor(i / COLS) - (ROWS - 1) / 2) * 3.4);
  const m = new THREE.Mesh(hullGeometry(id)!, hullMaterial(i % 2 ? 'enemy' : 'player'));
  m.position.y = 0.05;
  g.add(m);
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.45, 0.08, 32), new THREE.MeshStandardMaterial({ color: 0x5866a8, roughness: 0.6 }));
  pad.position.y = -0.04;
  g.add(pad);
  scene.add(g);
  spin.push(m);
});
const resize = () => {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  camera.position.set(0, 13, 17 + Math.max(0, 1100 - w) / 40);
  camera.lookAt(0, 0, 0.6);
};
addEventListener('resize', resize);
resize();
renderer.setAnimationLoop((t) => {
  for (const m of spin) m.rotation.y = t / 2600;
  renderer.render(scene, camera);
});

// ── The lineup: every struct's portrait ──
const lineup = document.getElementById('lineup')!;
for (const id of ids) {
  const fig = document.createElement('figure');
  const img = new Image();
  img.src = hullPortrait(id, new URLSearchParams(location.search).get('f') === 'enemy' ? 'enemy' : 'player')!.toDataURL();
  const cap = document.createElement('figcaption');
  cap.textContent = `${id} · ${TYPES_BY_ID[id]?.type ?? '?'}`;
  fig.append(img, cap);
  lineup.append(fig);
}

// ── Portraits beside the old art ──
const grid = document.getElementById('grid') as HTMLTableElement;
grid.innerHTML = '<tr><th>Struct</th><th>Old</th><th>New · player</th><th>New · enemy</th><th>Small (old / new)</th><th>Tris</th></tr>';
const toImg = (c: HTMLCanvasElement, cls: string) => { const i = new Image(); i.src = c.toDataURL(); i.className = cls; return i; };
for (const id of ids) {
  const old = await compositeSprite(id);
  const pl = hullPortrait(id, 'player')!, en = hullPortrait(id, 'enemy')!;
  const tr = grid.insertRow();
  tr.insertCell().textContent = `${id} · ${TYPES_BY_ID[id]?.type ?? '?'}`;
  tr.insertCell().append(toImg(old, 'big old'));
  tr.insertCell().append(toImg(pl, 'big'));
  tr.insertCell().append(toImg(en, 'big'));
  const small = tr.insertCell();
  for (const bg of ['', ' light']) {
    const chip = document.createElement('span');
    chip.className = 'chip' + bg;
    chip.append(toImg(old, 's50 old'), toImg(pl, 's50'), toImg(old, 's26 old'), toImg(pl, 's26'));
    small.append(chip, ' ');
  }
  tr.insertCell().textContent = String(hullGeometry(id)!.getAttribute('position').count / 3);
}
