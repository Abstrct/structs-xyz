/* Portraits: the flat struct pictures the UI shows (cards, boards, lists), rendered from the hull
 * models, so a struct looks the same on a 26 px chip as on the battle board. A studio light rig: a
 * warm key from the front left above (as the old art was lit), a cool rim from behind, a soft sky.
 *
 * One small offscreen renderer of its own (the game's renderer keeps its state). It renders at twice
 * the size and scales down, so edges are smooth without multisampling (which software GL makes
 * slow). Requests queue and render a few per task, so opening a list of 22 never stalls a frame. If
 * WebGL can't be had, or the context is lost, a portrait comes back empty and is tried again later. */
import * as THREE from 'three';
import { hullGeometry, FOOTPRINT } from './recipes';
import { hullMaterial, type Faction, type Variant } from './kit';

interface Rig { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.OrthographicCamera; mesh: THREE.Mesh }
/** false: WebGL isn't available here (no point asking again). */
let rig: Rig | null | false = null;

function getRig(): Rig | null {
  if (rig === false) return null;
  if (rig) return rig.renderer.getContext().isContextLost() ? null : rig;
  try {
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdce9ff, 0x2e2a40, 1.1));
    const key = new THREE.DirectionalLight(0xfff1dc, 2.4);
    key.position.set(-3, 6, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fd8ff, 2.2);
    rim.position.set(4, 3, -6);
    scene.add(rim);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    const mesh = new THREE.Mesh();
    scene.add(mesh);
    rig = { renderer, scene, camera, mesh };
    return rig;
  } catch {
    rig = false;
    return null;
  }
}

/** The three-quarter view: up 40°, turned 20° toward the nose (the boards tip hulls to match). */
export const VIEW_TURN = 0.35, VIEW_UP = 0.7;
const VIEW = new THREE.Vector3(Math.sin(VIEW_TURN) * Math.cos(VIEW_UP), Math.sin(VIEW_UP), Math.cos(VIEW_TURN) * Math.cos(VIEW_UP));
/** Rendered this many times larger, then scaled down: the anti-aliasing. */
const SS = 2;

/** Render a struct type's portrait onto a new canvas: null for an unknown type, undefined when
 * there's no GL to render with right now. `sprite` framing puts the hull at its footprint inside
 * the frame, as the old 128 px art sat (the UI's thumbnail crops expect it); otherwise the hull
 * fills the frame. */
export function hullPortrait(typeId: number, faction: Faction = 'player', size = 256, outline = true, variant: Variant = 'base', sprite = false): HTMLCanvasElement | null | undefined {
  const geo = hullGeometry(typeId);
  if (!geo) return null;
  const r0 = getRig();
  if (!r0) return undefined;
  const { renderer, scene, camera, mesh } = r0;
  mesh.geometry = geo;
  mesh.material = hullMaterial(faction, variant);
  // Fit the silhouette itself (every vertex, seen from the view), centred in the frame.
  const ctr = geo.boundingBox!.getCenter(new THREE.Vector3());
  camera.position.copy(ctr).addScaledVector(VIEW, 20);
  camera.up.set(0, 1, 0);
  camera.lookAt(ctr);
  camera.updateMatrixWorld();
  const inv = camera.matrixWorldInverse, pos = geo.getAttribute('position'), v = new THREE.Vector3();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(inv);
    if (v.x < x0) x0 = v.x; if (v.x > x1) x1 = v.x; if (v.y < y0) y0 = v.y; if (v.y > y1) y1 = v.y;
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, w = x1 - x0, h = y1 - y0;
  let r: number;
  if (sprite) {
    // World units per art pixel, so the hull spans its footprint (of 128) and no more.
    const [fw, fh] = FOOTPRINT[typeId] ?? [64, 64];
    r = Math.max(w / fw, h / fh) * 64;
  } else r = Math.max(w, h) / 2 * (outline ? 1.1 : 1.04);
  Object.assign(camera, { left: cx - r, right: cx + r, top: cy + r, bottom: cy - r });
  camera.updateProjectionMatrix();
  renderer.setSize(size * SS, size * SS, false);
  renderer.render(scene, camera);

  const out = document.createElement('canvas');
  out.width = out.height = size;
  const g = out.getContext('2d')!;
  const art = document.createElement('canvas');
  art.width = art.height = size;
  const ag = art.getContext('2d')!;
  ag.imageSmoothingQuality = 'high';
  ag.drawImage(renderer.domElement, 0, 0, size, size);
  if (outline) {
    // A dark keyline round the silhouette, so a struct still reads at 26 px on any background.
    const k = Math.max(1, Math.round(size / 96));
    const sil = document.createElement('canvas');
    sil.width = sil.height = size;
    const sg = sil.getContext('2d')!;
    sg.drawImage(art, 0, 0);
    sg.globalCompositeOperation = 'source-in';
    sg.fillStyle = '#0B1424';
    sg.fillRect(0, 0, size, size);
    for (const [rad, n] of [[k, 12], [k / 2, 8]] as const) {
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; g.drawImage(sil, Math.cos(a) * rad, Math.sin(a) * rad); }
    }
  }
  g.drawImage(art, 0, 0);
  return out;
}

/* ── Data URLs for <img>, rendered a few per task ─────────────────────── */

const urls = new Map<string, Promise<string>>();
const queue: (() => void)[] = [];
let pumping = false;
function pump() {
  const t0 = performance.now();
  while (queue.length && performance.now() - t0 < 10) queue.shift()!();
  if (queue.length) setTimeout(pump, 0); else pumping = false;
}

/** A struct's portrait as a data URL for <img>, in the old art's framing (cached). 256 px: the UI
 * crops the middle half, so the hull itself is drawn at about 128 px, sharp up to 96 px cards at 2×.
 * Never rejects: '' when it couldn't be drawn (and then it's tried again next time). */
export function structPortrait(typeId: number, variant: Variant = 'base', faction: Faction = 'player', size = 256): Promise<string> {
  const key = `${typeId}:${variant}:${faction}:${size}`;
  let p = urls.get(key);
  if (!p) {
    p = new Promise<string>((resolve) => {
      queue.push(() => {
        let c: HTMLCanvasElement | null | undefined;
        try { c = hullPortrait(typeId, faction, size, true, variant, true); } catch { c = undefined; }
        if (c === undefined) urls.delete(key);
        resolve(c ? c.toDataURL() : '');
      });
      if (!pumping) { pumping = true; setTimeout(pump, 0); }
    });
    urls.set(key, p);
  }
  return p;
}
