/* Wheel zoom toward the pointer for the board screens (battle, planet map), and dragging.
 * The zoom is a multiplier on the fitted camera distance plus a pan offset on
 * the board plane, chosen so the point under the cursor stays under it. The
 * pan is bounded by the board, so zooming back out always returns home. A drag
 * moves the board with the pointer; `slack` lets it move a little even unzoomed
 * (the planet map, whose edges sit under its panels). */
import * as THREE from 'three';
import { clamp, damp } from '../../core/util';

export class BoardZoom {
  /** Distance multiplier: 1 = fitted, `min` = closest. */
  target = 1;
  cur = 1;
  private offTarget = new THREE.Vector2();
  /** Current pan offset on the board plane, added to camera and look-at. */
  readonly offset = new THREE.Vector2();
  /** The board's resting centre; offsets are relative to it. */
  readonly center = new THREE.Vector2();
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private hit = new THREE.Vector3();

  /** How far the board may be dragged at the fitted zoom, as a share of its half size (0: not at all). */
  slack = 0;

  constructor(private min = 0.42, private halfW = 26, private halfH = 12) {}

  get zoomed() { return this.target < 0.999; }

  wheel(deltaY: number, camera: THREE.Camera, ndc: THREE.Vector2) {
    const before = this.target;
    const k = Math.exp(Math.sign(deltaY) * Math.min(Math.abs(deltaY), 120) * 0.0016);
    this.target = clamp(before * k, this.min, 1);
    // All the way out is home again, a drag included.
    if (this.target > 0.995) { this.target = 1; this.offTarget.set(0, 0); this.bound(); return; }
    this.ray.setFromCamera(ndc, camera);
    if (this.ray.ray.intersectPlane(this.plane, this.hit)) {
      // Keep the board point under the cursor fixed: c' = p - (p - c)·(d'/d).
      const r = this.target / before;
      const hx = this.hit.x - this.center.x, hy = this.hit.y - this.center.y;
      this.offTarget.set(hx - (hx - this.offTarget.x) * r, hy - (hy - this.offTarget.y) * r);
    }
    this.bound();
  }

  setBounds(halfW: number, halfH: number) { this.halfW = halfW; this.halfH = halfH; this.bound(); }

  /** Drag the board: the point that was under the pointer at `from` (NDC) moves to `to`. It follows
   * at once, without the zoom's easing, so the board stays under the finger or cursor. */
  drag(camera: THREE.Camera, from: THREE.Vector2, to: THREE.Vector2) {
    this.ray.setFromCamera(from, camera);
    if (!this.ray.ray.intersectPlane(this.plane, this.hit)) return;
    const ax = this.hit.x, ay = this.hit.y;
    this.ray.setFromCamera(to, camera);
    if (!this.ray.ray.intersectPlane(this.plane, this.hit)) return;
    this.offTarget.x -= this.hit.x - ax;
    this.offTarget.y -= this.hit.y - ay;
    this.bound();
    this.offset.copy(this.offTarget);
  }

  private bound() {
    const room = Math.max(1 - this.target, this.slack);
    this.offTarget.x = clamp(this.offTarget.x, -this.halfW * room, this.halfW * room);
    this.offTarget.y = clamp(this.offTarget.y, -this.halfH * room, this.halfH * room);
  }

  reset(snap = false) {
    this.target = 1;
    this.offTarget.set(0, 0);
    if (snap) { this.cur = 1; this.offset.set(0, 0); }
  }

  update(dt: number) {
    this.cur = damp(this.cur, this.target, 8, dt);
    this.offset.x = damp(this.offset.x, this.offTarget.x, 8, dt);
    this.offset.y = damp(this.offset.y, this.offTarget.y, 8, dt);
  }
}

/** Two-finger pinch on a canvas, reported as wheel-equivalent deltas at the pinch centre. */
export function bindPinch(canvas: HTMLElement, onZoom: (deltaY: number, x: number, y: number) => void): () => void {
  const pts = new Map<number, { x: number; y: number }>();
  let last = 0;
  const spread = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const down = (e: PointerEvent) => { if (e.pointerType !== 'touch') return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) last = spread(); };
  const move = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size !== 2 || !last) return;
    const d = spread();
    const [a, b] = [...pts.values()];
    // wheel() scales by exp(deltaY·0.0016): invert that for the finger spread ratio.
    if (d > 0) onZoom(-Math.log(d / last) / 0.0016, (a.x + b.x) / 2, (a.y + b.y) / 2);
    last = d;
  };
  const up = (e: PointerEvent) => { pts.delete(e.pointerId); last = pts.size === 2 ? spread() : 0; };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
  };
}

/** Clicks for a board: a mouse acts on press (as before); a touch acts on release, and only
 * if it stayed put and no second finger joined (so the start of a pinch is never a tap).
 * `mouseOnRelease`: a board that drags (bindDrag) takes a mouse click on release too, and only
 * if the mouse didn't move, so a drag is never also a click. */
export function bindTap(canvas: HTMLElement, onTap: (e: PointerEvent) => void, opts: { mouseOnRelease?: boolean } = {}): () => void {
  let touch: { id: number; x: number; y: number; cancelled: boolean } | null = null;
  let mouse: { x: number; y: number } | null = null;
  const down = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') {
      if (e.button !== 0) return;
      if (opts.mouseOnRelease) mouse = { x: e.clientX, y: e.clientY }; else onTap(e);
      return;
    }
    if (touch) { touch.cancelled = true; return; }
    touch = { id: e.pointerId, x: e.clientX, y: e.clientY, cancelled: false };
  };
  const up = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') {
      const m = mouse;
      mouse = null;
      if (m && e.button === 0 && Math.hypot(e.clientX - m.x, e.clientY - m.y) < DRAG_MOUSE) onTap(e);
      return;
    }
    if (!touch || e.pointerId !== touch.id) return;
    const t = touch;
    touch = null;
    if (!t.cancelled && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 10) onTap(e);
  };
  const cancel = (e: PointerEvent) => { if (touch && e.pointerId === touch.id) touch = null; };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', cancel);
  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', cancel);
  };
}

/** How far a pointer moves before a press becomes a drag (a finger wanders more than a mouse). */
const DRAG_MOUSE = 5, DRAG_TOUCH = 10;

/** Dragging a board: a mouse with its main button held, or one finger (a second finger hands the
 * gesture to the pinch). Past a small dead zone, each move reports where the pointer was and is. */
export function bindDrag(canvas: HTMLElement, onDrag: (fromX: number, fromY: number, toX: number, toY: number) => void, onEnd: () => void = () => {}): () => void {
  let d: { id: number; x: number; y: number; lastX: number; lastY: number; on: boolean; touch: boolean } | null = null;
  let fingers = 0;
  const down = (e: PointerEvent) => {
    if (e.pointerType === 'touch') fingers++;
    if (e.pointerType !== 'touch' && e.button !== 0) return;
    if (fingers > 1) { if (d?.on) onEnd(); d = null; return; }
    d = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, on: false, touch: e.pointerType === 'touch' };
  };
  const move = (e: PointerEvent) => {
    if (!d || e.pointerId !== d.id) return;
    if (!d.touch && !(e.buttons & 1)) { end(e); return; }
    if (!d.on && Math.hypot(e.clientX - d.x, e.clientY - d.y) < (d.touch ? DRAG_TOUCH : DRAG_MOUSE)) return;
    d.on = true;
    onDrag(d.lastX, d.lastY, e.clientX, e.clientY);
    d.lastX = e.clientX; d.lastY = e.clientY;
  };
  const end = (e: PointerEvent) => {
    if (e.pointerType === 'touch') fingers = Math.max(0, fingers - 1);
    if (!d || e.pointerId !== d.id) return;
    const was = d.on;
    d = null;
    if (was) onEnd();
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', end);
    canvas.removeEventListener('pointercancel', end);
  };
}

