/* What floats over the droids, in the DOM so it stays sharp, reads aloud and wraps: a nameplate
 * over each droid near you, a speech balloon over whoever just spoke (light, so speech is the
 * brightest thing on screen), a typing bubble, a name pill when the speaker is far away, and a
 * chip on the screen's edge pointing at a speaker you can't see. Balloons never overlap: newer ones
 * push older ones up, and four is the most on screen at once. */
import * as THREE from 'three';
import { h } from '../../core/dom';
import type { Msg } from '../../chat/model';
import { renderBody, toneOf, face } from '../../ui/comms/rich';
import { stampOf, stampSvg } from './talk';

export interface Tagged {
  userId: string;
  /** World position of the top of the head. */
  head: THREE.Vector3;
  name: string;
  aura: string;
  guildTag: string | null;
  typing: boolean;
  dist: number;
  me?: boolean;
}

interface Balloon { el: HTMLElement; until: number; born: number; userId: string; w: number; hgt: number }

const NEAR = 14, NAMES = 12, MAX_BALLOONS = 4;
/** Below the top bar. */
const TOP = 54;
const life = (m: Msg) => Math.min(12000, 4000 + 60 * m.body.length);

export class Tags {
  readonly el = h('div', { class: 'cl-tags', 'aria-hidden': 'true' });
  private plates = new Map<string, HTMLElement>();
  private dots = new Map<string, HTMLElement>();
  private balloons = new Map<string, Balloon>();
  private chips = new Map<string, HTMLElement>();
  private v = new THREE.Vector3();

  constructor(private navigate: (p: string) => void) {}

  /** A line spoken: a balloon over that droid (a stamp is a picture; /me has no tail). */
  say(m: Msg, name: string, aura: string, replyName?: string | null) {
    const old = this.balloons.get(m.sender);
    old?.el.remove();
    const tone = toneOf(m.sender);
    const st = stampOf(m.stamp);
    const tab = h('span', { class: `cb-tab ${tone}` }, name);
    let el: HTMLElement;
    if (st) el = h('div', { class: 'cb cb-stamp', style: `--aura:${aura}` }, tab, h('span', { class: 'cb-ico', html: stampSvg(st, 30) }), h('span', { class: 'cb-tail' }));
    else if (m.kind === 'emote') el = h('div', { class: 'cb cb-emote', style: `--aura:${aura}` }, tab, h('span', { class: 'cb-text' }, name + ' ', ...this.body(m)));
    else {
      el = h('div', { class: 'cb', style: `--aura:${aura}` }, tab, replyName ? h('span', { class: 'cb-reply' }, '↩ ' + replyName) : null, h('span', { class: 'cb-text' }, ...this.body(m)), h('span', { class: 'cb-tail' }));
    }
    this.el.appendChild(el);
    const now = performance.now();
    this.balloons.set(m.sender, { el, until: now + life(m), born: now, userId: m.sender, w: 0, hgt: 0 });
  }

  /** Balloon text: links shown, never live (they open from the log). */
  private body(m: Msg): Node[] {
    return renderBody(m.body, m.pills, this.navigate).map((n) => {
      if (n instanceof HTMLAnchorElement) return h('span', { class: 'cb-link' }, n.textContent ?? '');
      if (n instanceof HTMLElement) { n.setAttribute('tabindex', '-1'); n.style.pointerEvents = 'none'; }
      return n;
    });
  }

  /** Lay everything out for this frame. */
  update(camera: THREE.Camera, w: number, hgt: number, people: Tagged[]) {
    const now = performance.now();
    const byId = new Map(people.map((p) => [p.userId, p]));
    const proj = (p: Tagged, lift = 0) => {
      this.v.copy(p.head); this.v.y += lift;
      this.v.project(camera);
      return { x: (this.v.x * 0.5 + 0.5) * w, y: (-this.v.y * 0.5 + 0.5) * hgt, behind: this.v.z > 1 };
    };

    // Balloons first (they decide where the plates hide).
    const live = [...this.balloons.values()].filter((b) => {
      if (now > b.until || !byId.has(b.userId)) { b.el.remove(); this.balloons.delete(b.userId); return false; }
      return true;
    }).sort((a, b) => b.born - a.born);
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const ballooned = new Set<string>();
    live.forEach((b, i) => {
      const p = byId.get(b.userId)!;
      const s = proj(p, 0.25);
      const off = s.behind || s.x < 0 || s.x > w || s.y < 0 || s.y > hgt;
      const far = p.dist > NEAR;
      b.el.classList.toggle('far', far && !off);
      if (i >= MAX_BALLOONS || off) { b.el.style.visibility = 'hidden'; if (off && !p.me) this.chip(p, s, w, hgt); return; }
      this.chips.get(b.userId)?.remove(); this.chips.delete(b.userId);
      b.el.style.visibility = '';
      const bw = b.el.offsetWidth, bh = b.el.offsetHeight;
      let x = s.x - bw / 2, y = s.y - bh - 10;
      x = Math.max(6, Math.min(w - bw - 6, x));
      for (let k = 0; k < 8; k++) {
        const hit = placed.find((r) => x < r.x + r.w && x + bw > r.x && y < r.y + r.h && y + bh > r.y);
        if (!hit) break;
        y = hit.y - bh - 6;
      }
      // No room left under the top bar: this one stays in the log only.
      if (y < TOP) { b.el.style.visibility = 'hidden'; return; }
      placed.push({ x, y, w: bw, h: bh });
      b.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      b.el.style.opacity = String(Math.min(1, (b.until - now) / 300));
      ballooned.add(b.userId);
    });
    for (const [id, c] of this.chips) if (!this.balloons.has(id)) { c.remove(); this.chips.delete(id); }

    // Nameplates and typing dots for droids near you.
    const seen = new Set<string>();
    for (const p of people) {
      if (p.me || p.dist > NAMES) continue;
      const s = proj(p, 0.28);
      if (s.behind || s.x < -60 || s.x > w + 60 || s.y < -20 || s.y > hgt + 20) continue;
      seen.add(p.userId);
      let plate = this.plates.get(p.userId);
      if (!plate) {
        plate = h('div', { class: 'cn' }, h('span', { class: 'cn-dot' }), h('span', { class: 'cn-name' }), h('span', { class: 'cn-tag' }));
        this.plates.set(p.userId, plate);
        this.el.appendChild(plate);
      }
      (plate.children[0] as HTMLElement).style.background = p.aura;
      if (plate.children[1].textContent !== p.name) plate.children[1].textContent = p.name;
      const tag = plate.children[2] as HTMLElement;
      tag.textContent = p.guildTag ?? ''; tag.hidden = !p.guildTag;
      plate.style.visibility = ballooned.has(p.userId) ? 'hidden' : '';
      plate.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
      plate.style.opacity = String(Math.max(0.35, Math.min(1, (NAMES - p.dist) / 4)));
      let dot = this.dots.get(p.userId);
      if (p.typing && !ballooned.has(p.userId)) {
        if (!dot) { dot = h('div', { class: 'ct' }, h('i'), h('i'), h('i')); this.dots.set(p.userId, dot); this.el.appendChild(dot); }
        dot.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y - 34)}px) translate(-50%, -100%)`;
      } else if (dot) { dot.remove(); this.dots.delete(p.userId); }
    }
    for (const [id, el] of this.plates) if (!seen.has(id)) { el.remove(); this.plates.delete(id); this.dots.get(id)?.remove(); this.dots.delete(id); }
  }

  /** The edge chip: the speaker's face and an arrow, pinned to the side they're on. */
  private chip(p: Tagged, s: { x: number; y: number; behind: boolean }, w: number, hgt: number) {
    let c = this.chips.get(p.userId);
    if (!c) {
      c = h('div', { class: 'cb-edge' }, face(p.userId, 'cb-edge-face'), h('span', null, p.name));
      this.chips.set(p.userId, c);
      this.el.appendChild(c);
    }
    let x = s.x, y = s.y;
    if (s.behind) { x = w - x; y = hgt - 40; }
    const left = x < w / 2;
    c.classList.toggle('left', left);
    const cx = left ? 8 : w - c.offsetWidth - 8;
    // Clear of the deck plate and the map above, the chat and buttons below.
    const cy = Math.max(Math.min(200, hgt * 0.22), Math.min(hgt - 260, y));
    c.style.transform = `translate(${Math.round(cx)}px, ${Math.round(cy)}px)`;
  }

  clear() {
    this.el.replaceChildren();
    this.plates.clear(); this.dots.clear(); this.balloons.clear(); this.chips.clear();
  }
}
