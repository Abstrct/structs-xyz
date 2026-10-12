/* The Command Deck: where you play. Your commander's vitals, the battery every action
 * draws on, your planet's slots and your fleet's, every struct with what it can do right
 * now, proofs being ground, and the fleet's orders. Every button queues a real transaction.
 *   #/command            the active account's commander
 *   #/command/<playerId> one of your replicants */
import '../styles/command.css';
import '../styles/dc-base.css';
import * as THREE from 'three';
import { PIXEL_RATIO, type Engine } from '../core/engine';
import { h, toast, confirmBox, portrait, showTooltip, hideTooltip, banner } from '../core/dom';
import { audio } from '../core/audio';
import { PanelScreen } from './panelScreen';
import { currentRoute, redirectTo, replaceRoute } from '../core/nav';
import { wallet } from '../wallet/wallet';
import { txq } from '../wallet/queue';
import { empire, type OwnedStruct, type PlayerState } from '../game/empire';
import { act, actionBlock, buildBlock, buildable, exploreConfirmed, formatDraw, name, reservedSlots, verbsFor } from '../game/actions';
import { advise, type Advice } from '../game/advisor';
import { MISSIONS, progress } from '../game/missions';
import { record, RANKS } from '../game/record';
import { pow, type PowTask } from '../pow/pow';
import { live } from '../chain/live';
import { lcd, num, type StructFull } from '../chain/lcd';
import { store } from '../chain/store';
import { blocksToDuration, formatAlpha, hash32 } from '../core/util';
import { spriteDataUrl } from '../gfx/pixelModel';
import { Planet } from '../gfx/planet';
import { openVault } from '../ui/vault';
import { enlisting, retryEnlist } from '../game/enlist';
import { icon } from '../ui/icons';
import { adviceIcon, face, head, pill, tip, vital } from '../ui/dcbase';
import { keepFocus } from '../ui/keepFocus';
import { openTargets } from '../ui/targets';
import { openChannel } from '../ui/channel';
import { kids, taskRow, jobRow, fmtRate } from '../ui/opsDock';
import { AMBITS, AMBIT_NAME, typeOf, hasWeapon, weaponLabel, reachLabel, canTargetAmbit, type Ambit, type StructType, type WeaponSystem } from '../data/catalogue';

type Mode = { kind: 'none' } | { kind: 'build'; where: 'planet' | 'fleet'; ambit: Ambit; slot: number }
  | { kind: 'move'; struct: string } | { kind: 'defend'; struct: string } | { kind: 'attack'; struct: string; weapon: WeaponSystem; picks: string[] };

const CHARGE_MARKS = [1, 2, 3, 5, 8];

/** The worlds the dossiers paint (sea, lowland, highland), so the globe matches your planet's. */
const WORLD_LOOKS: [number, number, number][] = [
  [0x0d2140, 0x332b21, 0x6b5c47], [0x062a3a, 0x1d4a3a, 0x5d7e5a], [0x13203a, 0x6a5a48, 0xb3a38c],
  [0x1a2c48, 0x7894a8, 0xd8e4ec], [0x1a0d12, 0x4a1e18, 0x8a3a20], [0x101a30, 0x3e3456, 0x7a6a9a],
];

export class CommandScreen extends PanelScreen {
  /* The globe is near: the backdrop drift would swing it out of frame. */
  protected drift = 0.15;
  private playerId: string | null = null;
  private selected: string | null = null;
  private mode: Mode = { kind: 'none' };
  private els!: { vitals: HTMLElement; boards: HTMLElement; side: HTMLElement; tabs: HTMLElement; work: HTMLElement };
  private enemy: { planetId: string; structs: StructFull[]; at: number } | null = null;
  private paintTimer = 0;
  private dest: HTMLInputElement | null = null;
  /** Folds: the advisor's other moves, the tile key, the whole mission list (closed on first view). */
  private open = { advice: false, legend: false, missions: false };

  /** The holo-globe behind the boards: your world (painted as its dossier paints it) under a
   * survey grid, every struct a light flying its orbit with a wake behind it. */
  private globe = new THREE.Group();
  private planet: Planet;
  /** The holographic survey shell over the world: graticule, scan band, rim. */
  private globeMat: THREE.ShaderMaterial;
  private orbits = new THREE.Group();
  private orbitU = { uT: { value: 0 }, uPR: PIXEL_RATIO, uColor: { value: new THREE.Color(0x43cdb6) } };
  private orbiters: THREE.Points;
  private trails: THREE.LineSegments;
  private lanes: THREE.LineSegments;
  /** What the orbits were last built from (null: never built). */
  private orbitKey: string | null = null;
  private worldKey: string | null = null;

  constructor(engine: Engine, navigate: (hash: string) => void) {
    super(engine, navigate, 'command', 5.1);
    // Sun from the left and a little behind: a half-lit world, its night side strung with cities.
    const sun = new THREE.Vector3(-0.9, 0.32, -0.22);
    this.planet = new Planet({ radius: 2.2, palette: [0x0d2140, 0x332b21, 0x6b5c47], seed: 3.3, sun, atmosphere: 0x5fa8ff, tilt: [-0.32, 0.22], detail: 512 });
    this.globeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColor: this.orbitU.uColor, uSun: { value: sun.clone().normalize() } },
      vertexShader: /* glsl */ `varying vec3 vP; varying vec3 vN; varying vec3 vW;
        void main() { vP = position; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `uniform float uTime; uniform vec3 uColor, uSun; varying vec3 vP; varying vec3 vN; varying vec3 vW;
        void main() {
          vec3 n = normalize(vP);
          // A graticule every 15°, anti-aliased by hand (atan's seam would fool fwidth).
          float cell = 0.2618;
          float px = length(fwidth(n));
          float lat = asin(clamp(n.y, -1.0, 1.0)) / cell, lon = (atan(n.z, n.x) + uTime * 0.025) / cell;
          float wLat = px / cell * 1.2, wLon = px / max(sqrt(max(0.0, 1.0 - n.y * n.y)), 0.08) / cell * 1.2;
          float line = max(1.0 - smoothstep(0.0, wLat, abs(fract(lat + 0.5) - 0.5)),
                           (1.0 - smoothstep(0.0, wLon, abs(fract(lon + 0.5) - 0.5))) * step(abs(n.y), 0.96));
          vec3 N = normalize(vN), V = normalize(cameraPosition - vW);
          float facing = clamp(dot(N, V), 0.0, 1.0);
          float night = smoothstep(0.15, -0.25, dot(N, normalize(uSun)));
          float rim = pow(1.0 - facing, 4.0);
          float sweep = n.y - (fract(uTime * 0.06) * 2.6 - 1.3);
          float scan = exp(-sweep * sweep * 160.0) + (sweep < 0.0 ? exp(sweep * 9.0) * 0.12 : 0.0);
          float a = line * (0.012 + 0.05 * night) * smoothstep(0.0, 0.3, facing) + scan * 0.16 * smoothstep(0.0, 0.4, facing) + rim * 0.22;
          gl_FragColor = vec4(uColor * a, 1.0);
        }`,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(2.2 * 1.012, 72, 36), this.globeMat);
    shell.renderOrder = 3;
    const orbitVert = /* glsl */ `
      attribute vec4 orbit; attribute vec3 color; attribute float lag;
      uniform float uT, uPR;
      varying vec3 vC; varying float vA;
      vec3 orbitAt(vec4 o, float a) { return vec3(cos(a) * o.x, sin(a) * o.x * o.y, sin(a) * o.x); }
    `;
    this.orbiters = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: this.orbitU,
      vertexShader: orbitVert + /* glsl */ `
        void main() {
          vec4 mv = modelViewMatrix * vec4(orbitAt(orbit, orbit.z + uT * orbit.w), 1.0);
          gl_Position = projectionMatrix * mv;
          vC = color; vA = lag;
          gl_PointSize = (lag > 0.5 ? 12.0 : 9.0) * uPR * (10.0 / -mv.z);
        }`,
      fragmentShader: /* glsl */ `varying vec3 vC; varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          // Fleet hulls are diamonds, planet structs round lamps; both in a soft halo.
          float d = vA > 0.5 ? (abs(c.x) + abs(c.y)) * 0.8 : length(c);
          float core = smoothstep(0.17, 0.08, d);
          float halo = exp(-dot(c, c) * 26.0) * 0.55;
          gl_FragColor = vec4(vC * (core * 2.4 + halo), 1.0);
        }`,
    }));
    this.trails = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: this.orbitU,
      vertexShader: orbitVert + /* glsl */ `
        void main() {
          vec4 mv = modelViewMatrix * vec4(orbitAt(orbit, orbit.z + uT * orbit.w - lag * 0.85 * sign(orbit.w)), 1.0);
          gl_Position = projectionMatrix * mv;
          vC = color; vA = (1.0 - lag) * (1.0 - lag);
        }`,
      fragmentShader: /* glsl */ `varying vec3 vC; varying float vA; void main() { gl_FragColor = vec4(vC * vA * 1.3, 1.0); }`,
    }));
    this.lanes = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: this.orbitU,
      vertexShader: /* glsl */ `attribute float dash; varying float vD; void main() { vD = dash; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `uniform vec3 uColor; varying float vD; void main() { gl_FragColor = vec4(uColor * (0.07 + 0.08 * step(0.5, fract(vD))), 1.0); }`,
    }));
    for (const o of [this.orbiters, this.trails, this.lanes]) { o.frustumCulled = false; o.renderOrder = 4; this.orbits.add(o); }
    // The orbit planes lean toward the viewer so their ellipses read.
    this.orbits.rotation.set(0.34, 0, -0.1);
    this.globe.add(this.planet.group, shell, this.orbits);
    this.scene.add(this.globe);
    this.placeGlobe();
  }

  /** Off to the right on a wide screen; on a tall phone, rising from under the deck's panels. */
  private placeGlobe() {
    if (this.camera.aspect >= 1) this.globe.position.set(3.2, -0.6, -9);
    else this.globe.position.set(0.6, -3.7, -9);
  }

  resize(width: number, height: number) {
    super.resize(width, height);
    this.placeGlobe();
  }

  protected tick(dt: number, time: number) {
    this.globeMat.uniforms.uTime.value = time;
    const still = this.engine.reduceMotion;
    if (!still) this.orbitU.uT.value += dt;
    this.planet.update(still ? 0 : dt * 6, time);
    const p = this.me;
    // The globe wears your world's own face (the same palette and terrain its dossier shows).
    const wk = p?.planetId || '';
    if (wk !== this.worldKey) {
      this.worldKey = wk;
      const seed = wk ? hash32(wk) : 0;
      this.planet.setWorld(wk ? { palette: WORLD_LOOKS[seed % WORLD_LOOKS.length], seed: (seed % 1000) / 37 } : { palette: WORLD_LOOKS[0], seed: 3.3 });
    }
    const key = p ? [...p.structs.values()].map((s) => s.id + (s.built ? 'b' : '') + (s.online ? 'o' : '')).join() + (p.online ? '+' : '-') : '';
    if (key !== this.orbitKey) {
      this.orbitKey = key;
      const list = p ? [...p.structs.values()].filter((s) => !s.destroyed) : [];
      // Planet structs ride low, fleet hulls high; each ambit its own lane, inner lanes faster.
      type Orb = { r: number; tilt: number; a: number; w: number; fleet: boolean; c: THREE.Color };
      const orbs: Orb[] = list.map((s, i) => {
        const band = ({ water: 0, land: 1, air: 2, space: 3 } as Record<string, number>)[s.ambit] ?? 1;
        const fleet = s.locationType === 'fleet';
        const r = (fleet ? 3.3 : 2.55) + band * 0.12;
        return { r, tilt: (band - 1.5) * 0.18, a: (i / Math.max(1, list.length)) * Math.PI * 2 + band, w: 0.55 / Math.pow(r, 1.5), fleet, c: new THREE.Color(!s.built ? 0xebaa49 : s.online ? 0x5ee6cf : 0x5d7e90).multiplyScalar(1.4) };
      });
      // No commander yet: a little anonymous traffic on the lanes, so the globe is never dead.
      if (!p) for (let i = 0; i < 9; i++) orbs.push({ r: i % 3 ? 3.45 : 2.75, tilt: ((i % 4) - 1.5) * 0.18, a: i * 2.39, w: (i % 3 ? 0.09 : 0.13) * (i % 2 ? 1 : 0.8), fleet: i % 3 > 0, c: new THREE.Color(0x94a4e4).multiplyScalar(0.9) });
      const SEG = 14;
      const pOrbit = new Float32Array(orbs.length * 4), pCol = new Float32Array(orbs.length * 3), pKind = new Float32Array(orbs.length);
      const tOrbit = new Float32Array(orbs.length * SEG * 2 * 4), tCol = new Float32Array(orbs.length * SEG * 2 * 3), tLag = new Float32Array(orbs.length * SEG * 2);
      orbs.forEach((o, i) => {
        pOrbit.set([o.r, o.tilt, o.a, o.w], i * 4); pCol.set([o.c.r, o.c.g, o.c.b], i * 3); pKind[i] = o.fleet ? 1 : 0;
        for (let k = 0; k < SEG * 2; k++) {
          const v = i * SEG * 2 + k;
          tOrbit.set([o.r, o.tilt, o.a, o.w], v * 4); tCol.set([o.c.r, o.c.g, o.c.b], v * 3);
          tLag[v] = (Math.floor(k / 2) + (k % 2)) / SEG;
        }
      });
      const pos = (n: number) => new THREE.BufferAttribute(new Float32Array(n * 3), 3);
      const pg = this.orbiters.geometry, tg = this.trails.geometry;
      pg.setAttribute('position', pos(orbs.length)); pg.setAttribute('orbit', new THREE.BufferAttribute(pOrbit, 4)); pg.setAttribute('color', new THREE.BufferAttribute(pCol, 3)); pg.setAttribute('lag', new THREE.BufferAttribute(pKind, 1));
      tg.setAttribute('position', pos(orbs.length * SEG * 2)); tg.setAttribute('orbit', new THREE.BufferAttribute(tOrbit, 4)); tg.setAttribute('color', new THREE.BufferAttribute(tCol, 3)); tg.setAttribute('lag', new THREE.BufferAttribute(tLag, 1));
      // The lanes themselves: one faint dashed ellipse for each orbit in use.
      const lanes = [...new Map(orbs.map((o) => [`${o.r}:${o.tilt}`, o])).values()];
      const N = 96;
      const lp = new Float32Array(lanes.length * N * 2 * 3), ld = new Float32Array(lanes.length * N * 2);
      lanes.forEach((o, j) => {
        for (let k = 0; k < N; k++) for (let e = 0; e < 2; e++) {
          const a = ((k + e) / N) * Math.PI * 2, v = (j * N + k) * 2 + e;
          lp.set([Math.cos(a) * o.r, Math.sin(a) * o.r * o.tilt, Math.sin(a) * o.r], v * 3);
          ld[v] = ((k + e) / N) * 48;
        }
      });
      const lg = this.lanes.geometry;
      lg.setAttribute('position', new THREE.BufferAttribute(lp, 3)); lg.setAttribute('dash', new THREE.BufferAttribute(ld, 1));
      this.orbitU.uColor.value.set(p && !p.online ? 0xee7d69 : 0x43cdb6);
    }
  }

  protected mount(params: Record<string, string>) {
    this.playerId = params.player || null;
    this.selected = null;
    this.mode = { kind: 'none' };
    this.els = { vitals: h('div', { class: 'cd-vitals panel player' }), boards: h('div', { class: 'cd-boards' }), side: h('div', { class: 'cd-side panel' }), tabs: h('div', { class: 'cd-tabs' }), work: h('div', { class: 'cd-work panel' }) };
    this.root.append(h('div', { class: 'cd' }, this.els.tabs, h('div', { class: 'cd-grid' }, this.els.vitals, this.els.boards, h('div', { class: 'cd-right' }, this.els.side, this.els.work))));
    const repaint = () => this.schedulePaint();
    // The proof engine reports many times a second: only the work panel follows it, once a second.
    let workTimer = 0;
    const work = () => { if (!workTimer) workTimer = window.setTimeout(() => { workTimer = 0; const p = this.me; if (p && this.root?.isConnected) this.paintWork(p); }, 1000); };
    this.cleanup.push(empire.onChange(repaint), wallet.onChange(repaint), enlisting.onChange(repaint), txq.onChange(repaint), pow.onChange(work), live.onBlock(() => this.paintVitals()), () => clearTimeout(workTimer));
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && this.mode.kind !== 'none') { this.mode = { kind: 'none' }; this.paint(); } };
    window.addEventListener('keydown', key);
    this.cleanup.push(() => window.removeEventListener('keydown', key));
    if (this.playerId && !empire.commands(this.playerId)) { empire.watch(this.playerId); const id = this.playerId; this.cleanup.push(() => empire.unwatch(id)); }
    void empire.refresh();
    this.paint();
    // My Base opens on the planet itself, the fun view; these panels are one press away there (its
    // Base pill opens /command/<id>, which stays here). Only a bare /command goes, and only once
    // the home planet is known.
    if (!params.player) this.openPlanet();
  }

  /** To the home planet's own view, now or as soon as the commander loads (for a few seconds, and
   * never once the player has started doing something here). */
  private openPlanet() {
    let done = false, off: () => void = () => {};
    const stop = () => { if (done) return; done = true; clearTimeout(t); off(); this.root?.removeEventListener('pointerdown', stop); window.removeEventListener('keydown', stop); };
    const go = () => {
      const planetId = this.me?.planetId;
      if (done || !planetId || !this.root?.isConnected || currentRoute() !== '/command') return;
      stop();
      redirectTo('/planet/' + planetId);
    };
    const t = window.setTimeout(stop, 6000);
    this.root.addEventListener('pointerdown', stop);
    window.addEventListener('keydown', stop);
    this.cleanup.push(stop);
    off = empire.onChange(() => go());
    if (done) off();
    else go();
  }

  private schedulePaint() {
    if (this.paintTimer) return;
    this.paintTimer = window.setTimeout(() => {
      this.paintTimer = 0;
      // Never rebuild the boards under a field being typed into: try again shortly.
      const a = document.activeElement as HTMLElement | null;
      if (a && this.root?.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) { this.schedulePaint(); return; }
      this.paint();
    }, 60);
  }
  protected unmount() { clearTimeout(this.paintTimer); this.paintTimer = 0; hideTooltip(); this.planet.release(); }

  private get me(): PlayerState | null {
    const id = this.playerId || wallet.active?.playerId;
    return id ? empire.players.get(id) ?? null : null;
  }

  /* ── Paint ───────────────────────────────────────────────────────── */

  /** Repaint everything, the pad or keyboard cursor staying on the control in the same place. */
  private paint() {
    if (!this.root?.isConnected) return;
    keepFocus(this.root, () => this.paintAll());
  }

  private paintAll() {
    const st = wallet.state;
    const mine = wallet.accounts.filter((a) => a.playerId);
    const watching = !!this.playerId && !empire.commands(this.playerId);
    if (!watching && (st === 'empty' || !mine.length)) return this.paintEnlist();
    const me = this.me;
    this.root.classList.remove('enlist');
    this.root.classList.toggle('watching', watching);
    this.paintTabs();
    if (!me && !this.playerId && wallet.active && !wallet.active.playerId) {
      const firstPlayer = wallet.accounts.find((a) => a.playerId);
      const fieldKey = wallet.active.role === 'key';
      this.els.boards.replaceChildren(h('div', { class: 'cd-enlist dcb-enlist panel player' },
        h('div', { class: 'dcb-hero' }, h('span', { class: 'dcb-hero-ico', html: icon('key', 56) }),
          h('div', { class: 't-display c-player' }, `${wallet.active.label} has no player`)),
        h('div', { class: 't-tiny c-hint' }, fieldKey ? 'A field key acts through the player it is linked to (Guild Hall → Permissions). Act as a player account to command.' : 'This key has not joined a guild yet.'),
        h('div', { class: 'dcb-acts' }, firstPlayer ? h('button', { class: 'btn solid big', onclick: () => wallet.setActive(firstPlayer.index) }, face('a'), `Act as ${firstPlayer.label}`) : null,
          !fieldKey ? pill('team', 'Join a guild', 'The guild creates your commander, then you claim a planet', () => openVault('join'), 'btn ghost big') : null)));
      this.els.vitals.replaceChildren(); this.els.side.replaceChildren(); this.els.work.replaceChildren();
      return;
    }
    if (!me) {
      this.els.boards.replaceChildren(h('div', { class: 'cd-loading t-label c-hint', title: 'Reading your empire from the chain' }, h('span', { html: icon('base', 40) }), h('div', null, 'Reading the chain…')));
      this.els.vitals.replaceChildren(); this.els.side.replaceChildren(); this.els.work.replaceChildren();
      return;
    }
    this.paintVitals();
    this.paintBoards(me);
    this.paintSide(me);
    this.paintWork(me);
  }

  private paintEnlist() {
    this.root.classList.add('enlist');
    this.els.tabs.replaceChildren();
    this.els.vitals.replaceChildren(); this.els.side.replaceChildren(); this.els.work.replaceChildren();
    const st = wallet.state;
    const e = enlisting.current;
    if (e && e.status !== 'done' && st !== 'empty') {
      const failed = e.status === 'failed';
      this.els.boards.replaceChildren(h('div', { class: 'cd-enlist dcb-enlist panel player' },
        h('div', { class: 'dcb-hero' }, h('span', { class: 'dcb-hero-ico' + (failed ? ' c-enemy' : ' dcb-spin'), html: icon(failed ? 'flag' : 'team', 56) }),
          h('div', { class: 'col', style: 'gap:6px; min-width:0' },
            h('span', { class: 'chip ' + (failed ? 'enemy' : 'player'), style: 'align-self:flex-start' }, failed ? 'Stalled' : `Joining ${e.guildName}`),
            h('div', { class: 't-display c-player' }, `Commander ${e.name}`))),
        h('div', { class: 't-body c-hint', title: failed ? 'Press Retry, or pick another guild.' : 'It takes a few seconds. Look around meanwhile: this screen lights up the moment you’re in.' },
          failed ? 'The guild didn’t finish creating your commander.' : 'Your guild is creating your commander…'),
        h('div', { class: 'col join-log' }, ...e.steps.map((s) => h('div', { class: 't-tiny c-player-hi join-step' }, '▸ ' + s)), failed ? h('div', { class: 't-tiny c-enemy' }, e.error || '') : h('div', { class: 't-tiny c-hint join-step' }, '▸ …')),
        h('div', { class: 'dcb-acts' }, ...kids(
          failed ? h('button', { class: 'btn solid big', onclick: () => retryEnlist() }, face('a'), 'Retry') : null,
          failed ? pill('team', 'Another guild', 'Pick another guild', () => openVault('join'), 'btn ghost big') : null,
          pill('explore', 'Galaxy', 'Watch the galaxy meanwhile', () => this.navigate('/galaxy'), 'btn ghost big'),
          pill('target', 'Practice', 'Practice battle: nothing here can be lost', () => this.navigate('/sim'), 'btn ghost big')))));
      return;
    }
    // The invitation: one big A button, four pictures of the game, the trust line kept in plain view.
    const fresh = st === 'empty';
    this.els.boards.replaceChildren(h('div', { class: 'cd-enlist dcb-enlist panel player' },
      h('div', { class: 'dcb-hero' }, h('span', { class: 'dcb-hero-ico', html: icon(fresh ? 'base' : 'team', 56) }),
        h('div', { class: 't-display c-player' }, fresh ? 'Start your own base' : 'Join a guild')),
      h('div', { class: 'dcb-acts' },
        h('button', { class: 'btn solid big dcb-go', onclick: () => openVault(fresh ? undefined : 'join'),
          title: fresh ? 'Enlist a free commander in seconds: pick a name and a guild (your team). Then this screen comes alive: build, mine, refine and raid, all from here.'
            : 'Your vault holds a key, but no player yet. Join a guild to become one: the guild creates your commander, then you claim a planet.' },
          face('a'), fresh ? 'Enlist' : 'Join'),
        pill('target', 'Practice', 'Practice battle first: nothing here can be lost', () => this.navigate('/sim'), 'btn ghost big'),
        pill('academy', 'Academy', 'Learn the game, one lesson at a time', () => this.navigate('/academy'), 'btn ghost big')),
      fresh ? tip(h('div', { class: 'dcb-safe', tabindex: 0 }, h('span', { html: icon('lock', 16) }), h('span', null, 'Free · signed in your browser')), 'Free · signed in your browser', 'Every move is signed right here in your browser: your key never leaves it.')
        : h('div', { class: 'dcb-safe' }, h('span', { html: icon('key', 16) }), h('span', null, 'One step left: your key needs a guild.')),
      // Four pictures of the game; each opens its Academy lesson (the book in the corner says so).
      h('div', { class: 'dcb-tiles' },
        ...[['build', 'Build', 'Put machines (structs) into your planet’s slots. Your computer solves a puzzle to finish each one.', '/academy/strategy/units'],
          ['mine', 'Mine', 'Dig ore out of your planet, then refine it into alpha before raiders can steal it.', '/academy/economics/alpha'],
          ['battle', 'Raid', 'Sail your fleet to another world, beat its defenders and take its ore.', '/academy/strategy/flagship'],
          ['robot', 'Robots', 'Replicate: make robot helpers that mine and fight by the rules you give them.', '/academy/technology/ifthen']]
          .map(([ico, t, d, go]) => h('button', { class: 'dcb-tile', title: `${d} Opens the lesson.`, 'aria-label': `${t}: open the lesson`, onclick: () => { audio.play('select'); this.navigate(go); } },
            h('span', { class: 'dcb-tile-ico', html: icon(ico, 40) }), h('span', { class: 'dcb-tile-w' }, t), h('span', { class: 'dcb-tile-cue', html: icon('book', 14) })))),
      h('div', { class: 'dcb-links' },
        h('a', { href: 'https://playstructs.com', target: '_blank', rel: 'noopener', title: 'New to Structs? The official site' }, h('span', { html: icon('star', 14) }), 'playstructs.com'),
        h('a', { href: 'https://structs.ai', target: '_blank', rel: 'noopener', title: 'The game documentation' }, h('span', { html: icon('book', 14) }), 'structs.ai'))));
  }

  private paintTabs() {
    const mine = wallet.accounts.filter((a) => a.playerId);
    const cur = this.me?.playerId || wallet.active?.playerId;
    const watched = this.me && !empire.commands(this.me.playerId) ? this.me : null;
    this.els.tabs.replaceChildren(...kids(watched ? h('div', { class: 'cd-tab on watch', title: `Visiting ${watched.name}: only their owner can give orders here` }, portrait(watched.pfp, 'xs', watched.playerId),
      h('span', { class: 'dcb-ico', html: icon('eye', 16) }), h('span', { class: 'nm' }, watched.name), h('span', { class: 'chip warn' }, h('span', { class: 'dcb-ico', html: icon('lock', 12) }), 'Look only')) : null), ...mine.map((a) => {
      const p = empire.players.get(a.playerId!);
      const ch = p ? empire.charge(p) : 0;
      return h('button', { class: 'cd-tab' + (a.playerId === cur ? ' on' : ''), title: `${p?.name || a.label}: charge ${ch}${p && !p.online ? ', grid offline' : ''}`, onclick: () => { audio.play('select'); this.selected = null; this.mode = { kind: 'none' }; this.playerId = a.playerId!; wallet.setActive(a.index); replaceRoute('/command/' + a.playerId); this.paint(); } },
        portrait(p?.pfp || store.players.get(a.playerId!)?.pfpClientRenderAttributes, 'xs', a.address),
        h('span', { class: 'nm' }, p?.name || a.label), h('span', { class: 'chip ' + (ch >= 8 ? 'player' : 'warn') }, '⚡' + (ch > 999 ? '999+' : ch)),
        p && !p.online ? h('span', { class: 'chip enemy dcb-ico', html: icon('power', 12) }) : null);
    }), h('div', { class: 'grow' }), ...kids(wallet.state === 'locked' ? pill('lock', 'Unlock', 'Unlock your vault to act', () => openVault(), 'btn mini') : null));
  }

  private paintVitals() {
    const p = this.me;
    if (!p || !this.els) return;
    const ch = empire.charge(p);
    const capacity = p.capacity + p.connectionCapacity;
    const load = p.load + p.structsLoad;
    const pct = capacity > 0n ? Math.min(100, Number((load * 1000n) / capacity) / 10) : load > 0n ? 100 : 0;
    const guild = store.guilds.get(p.guildId);
    const planet = p.planet;
    const ore = num(planet?.gridAttributes?.ore);
    const mine = empire.commands(p.playerId);
    const away = p.fleet?.status === 'away';
    const battery = h('span', { class: 'battery cd-battery' },
      ...Array.from({ length: 8 }, (_, i) => h('i', { class: (ch > i ? 'on' : '') + (CHARGE_MARKS.includes(i + 1) ? ' mark' : '') })));
    const quick = (ico: string, word: string, title: string, run: () => void, cls: string, off = false) => { const b = pill(ico, word, title, run, cls); b.disabled = off; return b; };
    // Repainted every block: a pad or keyboard cursor on one of these stays where it was.
    keepFocus(this.els.vitals, () => this.els.vitals.replaceChildren(...kids(
      h('div', { class: 'cd-id' }, portrait(p.pfp, 'player', p.playerId),
        h('div', { class: 'col', style: 'gap:4px; min-width:0' },
          h('div', { class: 't-display c-player cd-name' }, p.name),
          h('div', { class: 'row wrap dcb-idrow' }, h('span', { class: 't-tiny c-hint x-only' }, p.playerId),
            h('a', { class: 'lnk dcb-guild', href: '/intel/guild/' + p.guildId, title: 'Their guild (team)' }, h('span', { class: 'dcb-ico', html: icon('team', 16) }), store.guildName(p.guildId) || guild?.id || 'no guild')),
          // Two lamps: the grid (lit = online) and the fleet (home, or away at a planet).
          h('div', { class: 'row dcb-lamps' },
            vital('power', p.online ? '' : 'Off', p.online ? 'Grid online' : 'Grid offline', p.online ? 'Load is under capacity: every machine can act.' : 'Load is over capacity: nothing can act until that is fixed.', 'lamp ' + (p.online ? 'c-player' : 'c-enemy hot')),
            p.fleet ? vital('ship', away ? '→ ' + p.fleet.locationId : '', away ? `Fleet away at ${p.fleet.locationId}` : 'Fleet home', away ? 'Out raiding, so it isn’t defending home.' : 'On station, guarding the planet.', 'lamp ' + (away ? 'c-warn' : 'c-player')) : null))),
      mine ? tip(h('a', { class: 'cd-rank dcb-rank', href: '/academy' }, h('span', { class: 'dcb-ico c-neutral', html: icon('star', 18) }),
        h('span', { class: 't-label c-neutral' }, RANKS[record.rank]), h('span', { class: 'bar warn' }, h('i', { style: `width:${record.progress * 100}%` })), h('b', { class: 'dcb-n' }, String(record.r.xp))),
      RANKS[record.rank], `${record.r.xp} XP · ${record.r.kills} kills · ${record.r.raids} raids won. Earn XP by playing, and by taking Academy lessons.`) : null,
      // What to do next comes first: it is the one thing a new commander most needs.
      this.advisor(p),
      h('div', { class: 'dcb-vitals' },
        vital('charge', ch > 9999 ? '9999+' : String(ch), 'Charge', `Blocks since ${mine ? 'your' : 'their'} last action, one about every 6 seconds. Every move costs 1–8.`, 'wide ' + (ch >= 8 ? 'c-player' : 'c-warn'), battery),
        vital('alpha', formatAlpha(p.alpha.toString()), 'Alpha', 'Refined alpha in the wallet. Raiders can’t take it.', 'wide c-player'),
        vital('ore', String(p.ore), 'Ore held', p.ore ? 'Raiders can steal stored ore. Refine it into alpha.' : 'Nothing at risk.', p.ore ? 'c-enemy hot' : ''),
        vital('mine', String(ore), 'Ore in ground', 'Ore left in the planet to mine.'),
        vital('shield', planet?.planetAttributes?.planetaryShield || '0', 'Shield', 'Planetary shield: the higher it is, the harder the raid puzzle.', 'wide c-secondary'),
        vital('power', `${formatDraw(Number(load))} / ${formatDraw(Number(capacity))}`, 'Power', 'Load / capacity. Load over capacity takes the grid offline.', 'wide ' + (pct > 95 ? 'c-enemy' : pct > 80 ? 'c-warn' : ''),
          h('span', { class: 'bar' + (pct > 95 ? ' enemy' : pct > 80 ? ' warn' : '') }, h('i', { style: `width:${pct}%` })))),
      h('div', { class: 'cd-quick dcb-quick' },
        quick('planet', 'Planet', 'See the planet map', () => this.navigate('/planet/' + p.planetId), 'btn ghost', !p.planetId),
        quick('chat', 'Chat', 'The planet’s chat room', () => openChannel(p.planetId), 'btn ghost', !p.planetId),
        quick('explore', 'Explore', 'Explore: claim a fresh planet', () => this.guard(() => exploreConfirmed(p)), 'btn secondary cd-act'),
        quick('send', 'Send', 'Send alpha to another player', () => openVault('send'), 'btn ghost cd-act')),
    )));
  }

  /** The advisor's best move as one card with its A-button verb; the rest fold under "+N". */
  private advisor(p: PlayerState) {
    const list = advise(p);
    const mineToo = empire.commands(p.playerId);
    const label = mineToo ? 'What to do next' : 'Their situation';
    if (!list.length) return tip(h('div', { class: 'dcb-next player quiet', tabindex: 0 }, h('span', { class: 'dcb-next-ico', html: icon('check', 28) }), h('div', { class: 't-label-lg' }, 'All quiet')), 'All quiet', 'The engine works while you watch.');
    const said = (a: Advice, cls: string) => tip(h('div', { class: 'dcb-next-body', tabindex: 0 }, h('div', { class: cls }, a.title)), a.title, a.detail, a.tone);
    const verb = (a: Advice, big: boolean) => a.action && mineToo
      ? h('button', { class: 'btn dcb-verb' + (big ? '' : ' mini') + (a.tone === 'enemy' ? ' danger' : ''), title: a.detail, onclick: () => this.guard(a.action!.run) },
        big ? face('a') : null, a.action.label, a.action.cost ? h('span', { class: 'cost' }, `⚡${a.action.cost}`) : null)
      : a.go ? h('button', { class: 'btn ghost dcb-verb' + (big ? '' : ' mini'), title: a.detail, onclick: () => this.navigate(a.go!) }, big ? face('a') : null, 'Open ▸') : null;
    const [top, ...more] = list;
    const fold = () => { this.open.advice = !this.open.advice; audio.play('select'); this.paintVitals(); };
    const foldName = this.open.advice ? 'Fold the other moves' : `Show ${more.length} more move${more.length > 1 ? 's' : ''}`;
    return h('div', { class: 'cd-advice', role: 'group', 'aria-label': label },
      h('div', { class: `dcb-next ${top.tone}` },
        h('span', { class: 'dcb-next-ico', html: icon(adviceIcon(top.id), 30) }),
        said(top, 't-label-lg'),
        verb(top, true),
        more.length ? h('button', { class: 'dcb-more', title: foldName, 'aria-label': foldName, 'aria-expanded': String(this.open.advice), onclick: fold }, this.open.advice ? '−' : `+${more.length}`) : null),
      this.open.advice ? h('div', { class: 'dcb-next-more' }, ...more.map((a) => h('div', { class: `dcb-next small ${a.tone}` },
        h('span', { class: 'dcb-next-ico', html: icon(adviceIcon(a.id), 20) }), said(a, 't-label'), verb(a, false)))) : null);
  }

  /* ── The boards: planet and fleet slots ──────────────────────────── */

  private paintBoards(p: PlayerState) {
    const planet = p.planet?.Planet;
    const fleet = p.fleet;
    const banner = this.modeBanner();
    const boards: HTMLElement[] = [];
    if (planet) boards.push(this.board(p, 'planet', planet.name || planet.id, `Planet ${planet.id}: its slots, four layers deep. Click a + to build.`, (a) => (planet as unknown as Record<string, string[]>)[a] || [], (a) => num((planet as unknown as Record<string, string>)[a + 'Slots'])));
    if (fleet) boards.push(this.board(p, 'fleet', 'Fleet', 'The fleet: its slots, led by the Command Ship. It defends home, or sails out to raid.', (a) => (fleet as unknown as Record<string, string[]>)[a] || [], (a) => num((fleet as unknown as Record<string, string>)[a + 'Slots']), fleet.commandStruct,
      fleet.status === 'away' ? h('span', { class: 'chip warn', title: `Away at ${fleet.locationId}` }, '→ ' + fleet.locationId) : h('span', { class: 'chip player dcb-ico', title: 'On station at home', html: icon('base', 14) })));
    // Sailing orders are a commander's; a visitor sees them only while the fleet is out raiding.
    if (fleet && (empire.commands(p.playerId) || fleet.status === 'away')) boards.push(this.fleetOrders(p));
    this.els.boards.replaceChildren(...kids(banner, ...boards));
  }

  private modeBanner(): HTMLElement | null {
    const m = this.mode;
    if (m.kind === 'none' || m.kind === 'build') return null;
    const actor = m.kind === 'move' || m.kind === 'defend' || m.kind === 'attack' ? this.me?.structs.get(m.struct) : undefined;
    // The struct we were aiming with is gone (destroyed, moved): drop the mode instead of freezing.
    if (!actor?.type) { this.mode = { kind: 'none' }; return null; }
    const text = m.kind === 'move' ? 'Pick a slot' : m.kind === 'defend' ? 'Guard who?' : m.picks.length ? 'More, or fire' : 'Pick a target';
    const hint = m.kind === 'move' ? 'Pick an empty slot to move into' : m.kind === 'defend' ? 'Pick the friend to guard' : `Pick ${m.picks.length ? 'more targets or fire' : 'a target'} — ${weaponLabel(actor.type, m.weapon)}`;
    return h('div', { class: 'cd-mode ' + (m.kind === 'attack' ? 'enemy' : 'player'), title: hint },
      h('span', { class: 'dcb-ico', html: icon(m.kind === 'move' ? 'build' : m.kind === 'defend' ? 'shield' : 'target', 22) }),
      h('span', { class: 't-label-lg' }, text, m.kind === 'attack' ? h('span', { class: 'c-hint' }, ' · ' + weaponLabel(actor.type, m.weapon)) : null),
      m.kind === 'attack' && m.picks.length ? h('button', { class: 'btn danger mini', title: `Fire on ${m.picks.length}`, onclick: () => this.fire() }, face('a'), `Fire ×${m.picks.length}`) : null,
      h('button', { class: 'btn ghost mini', title: 'Cancel (Esc)', onclick: () => { this.mode = { kind: 'none' }; this.paint(); } }, face('b'), 'Cancel'));
  }

  private board(p: PlayerState, where: 'planet' | 'fleet', title: string, hint: string, slotsOf: (a: Ambit) => string[], countOf: (a: Ambit) => number, command?: string, status?: HTMLElement) {
    const rows = AMBITS.map((a) => {
      const ids = slotsOf(a);
      const n = Math.max(countOf(a), ids.length);
      const cells = Array.from({ length: n }, (_, i) => this.cell(p, where, a, i, ids[i] || ''));
      return h('div', { class: 'cd-row' }, h('span', { class: `cd-ambit chip ambit-${a} dcb-ambit`, title: AMBIT_NAME[a], 'aria-label': AMBIT_NAME[a], html: icon(a, 18) }), h('div', { class: 'cd-slots' }, ...cells));
    });
    const cmd = command ? p.structs.get(command) : undefined;
    return h('section', { class: 'cd-board panel' + (where === 'fleet' ? ' fleet' : '') },
      head(where === 'planet' ? 'planet' : 'ship', title, hint, status, cmd ? this.mini(cmd) : null),
      h('div', { class: 'panel-body col' }, ...rows));
  }

  /** The Command Ship, in the fleet's title bar: its picture, a star and its health. */
  private mini(s: OwnedStruct) {
    const img = h('img', { alt: '', draggable: false });
    if (s.type) void spriteDataUrl(s.type.id).then((u) => { img.src = u; });
    return h('button', { class: 'cd-mini' + (this.selected === s.id ? ' on' : '') + (s.online ? '' : ' off'), title: `Command Ship: ${s.type?.type || s.id}${s.online ? '' : ' (offline)'}`, onclick: () => this.pick(s) },
      h('span', { class: 'dcb-ico', html: icon('star', 14) }), h('span', { class: 'sprite' }, img), h('span', { class: 'x-only' }, s.type?.type || s.id),
      h('span', { class: 'pips' }, ...Array.from({ length: s.type?.maxHealth || 0 }, (_, i) => h('i', { class: i < s.health ? '' : 'lost' }))));
  }

  private cell(p: PlayerState, where: 'planet' | 'fleet', ambit: Ambit, slot: number, id: string): HTMLElement {
    const s = id ? p.structs.get(id) : undefined;
    const m = this.mode;
    if ((!id || !s) && reservedSlots(p.playerId).has(`${where}:${ambit}:${slot}`)) {
      return h('div', { class: 'cd-cell empty reserved', title: 'A queued move is headed here' }, h('span', { class: 'plus', html: icon('clock', 24) }), h('span', { class: 't-tiny c-hint' }, String(slot + 1)));
    }
    if (!id || !s) {
      const target = m.kind === 'move';
      const building = m.kind === 'build' && m.where === where && m.ambit === ambit && m.slot === slot;
      return h('button', { class: 'cd-cell empty' + (target ? ' target' : '') + (building ? ' on' : ''), title: `${target ? 'Move here' : 'Build here'} · ${AMBIT_NAME[ambit]} ${slot + 1}`, onclick: () => {
        if (!empire.commands(p.playerId)) { audio.play('deny'); return; }
        audio.play('select');
        if (m.kind === 'move') { const ms = p.structs.get(m.struct); if (ms) this.guard(() => act.move(p, ms, where, ambit, slot)); this.mode = { kind: 'none' }; this.paint(); return; }
        this.selected = null; this.mode = { kind: 'build', where, ambit, slot }; this.paint();
      } }, h('span', { class: 'plus' }, '+'), h('span', { class: 't-tiny c-hint' }, String(slot + 1)));
    }
    const t = s.type;
    const img = h('img', { alt: '', draggable: false });
    if (t) void spriteDataUrl(t.id).then((u) => { img.src = u; });
    const task = [...pow.tasks.values()].find((x) => x.objectId === s.id && x.status !== 'done');
    const pending = txq.active.find((j) => j.msgs.some((mm) => Object.values(mm.value).includes(s.id)));
    const cls = ['cd-cell', s.built ? '' : 'building', s.online ? 'online' : 'offline', s.hidden ? 'hidden' : '', this.selected === s.id ? 'on' : '', pending ? 'pending' : '',
      m.kind === 'defend' && m.struct !== s.id ? 'target' : ''].filter(Boolean).join(' ');
    // The picture is the label: its name is in the hover card (and on the tile in Expert mode).
    const el = h('button', { class: cls, 'aria-label': t?.type || s.id, onclick: () => {
      if (m.kind === 'defend') { const d = p.structs.get(m.struct); if (d && d.id !== s.id) this.guard(() => act.defend(p, d, s.id)); this.mode = { kind: 'none' }; this.paint(); return; }
      this.pick(s);
    } },
      h('div', { class: 'sprite' }, img),
      h('div', { class: 'pips' }, ...Array.from({ length: t?.maxHealth || 0 }, (_, i) => h('i', { class: i < s.health ? '' : 'lost' }))),
      h('div', { class: 'nm t-tiny x-only' }, t?.classAbbreviation || t?.type || s.id),
      !s.built ? h('div', { class: 'cd-prog' }, h('i', { style: `width:${task ? Math.min(100, ((task.best?.zeros || 0) / Math.max(1, pow.required(task))) * 100) : 4}%` })) : null,
      s.defenders.length ? h('span', { class: 'cd-badge shield', title: `${s.defenders.length} defender(s)` }) : null,
      s.protectedStructIndex ? h('span', { class: 'cd-badge guard', title: 'Guarding another struct' }) : null,
      pending ? h('span', { class: 'cd-badge pend', title: pending.label }) : null);
    el.addEventListener('pointerenter', (e) => showTooltip(e.clientX, e.clientY, this.tip(s, task), s.built ? 'player' : 'neutral'));
    el.addEventListener('pointermove', (e) => showTooltip(e.clientX, e.clientY, this.tip(s, task), s.built ? 'player' : 'neutral'));
    el.addEventListener('pointerleave', () => hideTooltip());
    return el;
  }

  private tip(s: OwnedStruct, task?: PowTask) {
    const t = s.type;
    return h('div', { class: 'col', style: 'gap:3px' },
      h('div', { class: 't-label-lg' }, t?.type || 'Machine', h('span', { class: 'x-only' }, ` · ${s.id}`)),
      h('div', { class: 't-tiny c-hint' }, `${s.ambit} slot ${s.slot + 1} · ${s.built ? (s.online ? 'switched on' : 'switched off') : 'being built'}${s.hidden ? ' · hidden' : ''}`),
      t ? h('div', { class: 't-tiny c-hint' }, roleLine(t)) : null,
      h('div', { class: 't-tiny' }, `Health ${s.health}/${t?.maxHealth ?? '?'}`),
      task ? h('div', { class: 't-tiny c-secondary' }, h('span', { class: 's-only' }, 'Your computer is solving the puzzle to finish it'), h('span', { class: 'x-only' }, `Proof: best ${task.best?.zeros ?? 0} / need ${pow.required(task)} zeros`)) : null);
  }

  private pick(s: OwnedStruct) {
    const m = this.mode;
    if (m.kind === 'attack') return;
    audio.play('select');
    this.selected = this.selected === s.id ? null : s.id;
    this.mode = { kind: 'none' };
    this.paint();
  }

  /* ── Fleet orders, raid and targets ──────────────────────────────── */

  private fleetOrders(p: PlayerState) {
    const f = p.fleet!;
    const away = f.status === 'away';
    // One input for the screen's life, so typing survives repaints.
    const dest = this.dest ??= h('input', { class: 'input', placeholder: 'planet 2-… or player name', 'aria-label': 'Where to: a planet id (2-…) or a player’s name', spellcheck: false }) as HTMLInputElement;
    dest.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    const go = () => {
      const q = dest.value.trim();
      let target = /^2-\d+$/.test(q) ? q : '';
      if (!target && /^1-\d+$/.test(q)) target = store.players.get(q)?.planetId || '';
      if (!target && q) for (const pl of store.players.values()) if (pl.name && pl.name.toLowerCase() === q.toLowerCase()) { target = pl.planetId; break; }
      if (!target) { toast('No such planet', 'warn'); audio.play('deny'); return; }
      this.guard(() => act.fleetMove(p, target));
    };
    const tgt = p.target;
    const raid = tgt ? num(tgt.planetAttributes?.blockStartRaid) : 0;
    const enemies = this.enemyBoard(p);
    const cmd = empire.commands(p.playerId);
    return h('section', { class: 'cd-board panel ' + (away ? 'enemy' : '') },
      head('target', away ? 'Raid' : 'Sail', away ? 'Destroy their Command Ship and the raid puzzle unlocks. Your computer solves it and takes the ore as soon as it can.' : 'Type a planet id or a player’s name and press Sail. A raid starts when you arrive. Targets finds planets worth raiding.',
        away ? h('span', { class: 'chip warn', title: `At ${f.locationId}` }, '→ ' + f.locationId) : null),
      h('div', { class: 'panel-body col' },
        away && tgt ? h('div', { class: 'dcb-vitals' },
          vital('shield', tgt.planetAttributes?.planetaryShield || '0', 'Their shield', 'The higher it is, the harder the raid puzzle.', 'c-secondary'),
          raid ? vital('clock', live.height > raid ? blocksToDuration(live.height - raid) : '#' + raid, 'Raid clock', `The raid puzzle started ${live.height > raid ? blocksToDuration(live.height - raid) + ' ago, at ' : 'at '}block #${raid}; it gets easier every block.`, 'c-enemy') : null) : null,
        cmd ? h('div', { class: 'row dcb-sail' }, dest, h('button', { class: 'btn danger', title: 'Sail there. A raid starts when you arrive.', onclick: go }, face('a'), 'Sail'), pill('target', 'Targets', 'Find planets worth raiding', () => openTargets(this.navigate))) : null,
        away ? h('div', { class: 'row' }, cmd ? pill('base', 'Home', 'Return home', () => this.guard(() => act.fleetMove(p, p.planetId)), 'btn') : null, pill('eye', 'Watch', 'Watch the target planet', () => this.navigate('/planet/' + f.locationId))) : null,
        enemies));
  }

  /** Enemy structs at the planet our fleet is raiding — click to target. */
  private enemyBoard(p: PlayerState): HTMLElement | null {
    const tgt = p.target;
    if (!tgt || p.fleet?.status !== 'away') return null;
    const pid = tgt.Planet.id;
    if (!this.enemy || this.enemy.planetId !== pid || Date.now() - this.enemy.at > 30_000) {
      const ids = ['space', 'air', 'land', 'water'].flatMap((a) => (tgt.Planet as unknown as Record<string, string[]>)[a] || []).filter(Boolean);
      // The defender's home fleet sits there too.
      const owner = store.players.get(tgt.Planet.owner);
      const want = this.enemy?.planetId === pid ? this.enemy : null;
      this.enemy = { planetId: pid, structs: want?.structs || [], at: Date.now() };
      void (async () => {
        const fleet = owner?.fleetId ? await lcd.fleet(owner.fleetId).catch(() => null) : null;
        if (fleet && fleet.locationId === pid) ids.push(...['space', 'air', 'land', 'water'].flatMap((a) => (fleet as unknown as Record<string, string[]>)[a] || []).filter(Boolean), fleet.commandStruct);
        const got = (await Promise.all(ids.filter(Boolean).map((id) => lcd.struct(id).catch(() => null)))).filter((x): x is StructFull => !!x && !x.structAttributes?.isDestroyed);
        if (this.enemy?.planetId === pid) { this.enemy.structs = got; this.schedulePaint(); }
      })();
    }
    const m = this.mode;
    const shooter = m.kind === 'attack' ? p.structs.get(m.struct) : undefined;
    const list = this.enemy.structs;
    if (!list.length) return h('div', { class: 't-tiny c-hint', title: 'Reading the defenders' }, 'Scanning…');
    return h('div', { class: 'cd-enemies' }, ...list.map((e) => {
      const t = typeOf(e.Struct.type);
      const hidden = !!e.structAttributes?.isHidden;
      const reach = shooter && m.kind === 'attack' && t ? canTargetAmbit(shooter.type!, m.weapon, shooter.ambit as Ambit, e.Struct.operatingAmbit as Ambit) : false;
      const picked = m.kind === 'attack' && m.picks.includes(e.Struct.id);
      const img = h('img', { alt: '', draggable: false });
      if (t) void spriteDataUrl(t.id).then((u) => { img.src = u; });
      return h('button', { class: 'cd-cell foe' + (reach && !hidden ? ' target' : m.kind === 'attack' ? ' dim' : '') + (picked ? ' on' : '') + (hidden ? ' hidden' : ''), title: `${t?.type || 'Struct'} ${e.Struct.id} · ${e.Struct.operatingAmbit}${hidden ? ' · stealthed' : ''}`, onclick: () => {
        if (m.kind !== 'attack' || !reach) { audio.play('deny'); return; }
        const max = (m.weapon === 'primaryWeapon' ? shooter!.type!.primaryWeaponTargets : shooter!.type!.secondaryWeaponTargets) || 1;
        m.picks = picked ? m.picks.filter((x) => x !== e.Struct.id) : [...m.picks, e.Struct.id].slice(-max);
        audio.play('tick');
        if (m.picks.length >= max) this.fire(); else this.paint();
      } }, h('div', { class: 'sprite' }, img), h('div', { class: 'pips' }, ...Array.from({ length: t?.maxHealth || 0 }, (_, i) => h('i', { class: i < num(e.structAttributes?.health) ? '' : 'lost' }))), h('div', { class: 'nm t-tiny x-only' }, t?.classAbbreviation || e.Struct.id));
    }));
  }

  private fire() {
    const m = this.mode;
    const p = this.me;
    if (m.kind !== 'attack' || !p || !m.picks.length) return;
    const s = p.structs.get(m.struct);
    if (s) this.guard(() => act.attack(p, s, m.picks, m.weapon), () => { audio.play(m.weapon === 'primaryWeapon' ? 'missile' : 'gatling'); });
    this.mode = { kind: 'none' };
    this.paint();
  }

  /* ── Side panel: the selected struct, or the build picker ────────── */

  private paintSide(p: PlayerState) {
    const m = this.mode;
    if (m.kind === 'build') return this.paintBuild(p, m.where, m.ambit, m.slot);
    const s = this.selected ? p.structs.get(this.selected) : undefined;
    if (s && !s.type) { this.els.side.replaceChildren(h('div', { class: 'panel-body t-tiny c-hint' }, `Struct ${s.id}: type ${s.typeId} is newer than this client’s catalogue.`)); return; }
    if (!s) {
      const cmd = empire.commands(p.playerId);
      const hint = cmd ? 'Click a machine to give it orders, or a + slot to build a new one. Hover anything to see what it is.' : 'Hover any machine to see what it is.';
      // The tile marks' key folds behind a button; the plain prompt is a picture and three words.
      const key = h('button', { class: 'btn ghost mini dcb-key' + (this.open.legend ? ' active' : ''), title: 'What the marks on the tiles mean', 'aria-expanded': String(this.open.legend),
        onclick: () => { this.open.legend = !this.open.legend; audio.play('select'); this.paintSide(p); } }, h('span', { class: 'dcb-ico', html: icon('help', 14) }), 'Key');
      this.els.side.replaceChildren(head(cmd ? 'flag' : 'eye', cmd ? 'Orders' : 'Look', hint, key),
        h('div', { class: 'panel-body col' }, cmd ? this.missions() : null,
          this.open.legend ? h('div', { class: 'cd-legend t-tiny c-hint' }, h('span', null, h('i', { class: 'lg online' }), 'online'), h('span', null, h('i', { class: 'lg offline' }), 'offline'), h('span', null, h('i', { class: 'lg building' }), 'building'), h('span', null, h('i', { class: 'lg shield' }), 'defended'), h('span', null, h('i', { class: 'lg guard' }), 'guarding'), h('span', null, h('i', { class: 'lg pend' }), 'move queued')) : null,
          tip(h('div', { class: 'dcb-empty' }, h('span', { html: icon(cmd ? 'build' : 'find', 40) }), h('span', { class: 't-label' }, cmd ? 'Pick a tile' : 'Point at a unit')), cmd ? 'Pick a tile' : 'Point at a unit', hint)));
      return;
    }
    const t = s.type!;
    const ch = empire.charge(p);
    const verbs = verbsFor(p, s);
    const weapons: WeaponSystem[] = (['primaryWeapon', 'secondaryWeapon'] as WeaponSystem[]).filter((w) => hasWeapon(t, w));
    const away = p.fleet?.status === 'away';
    const img = h('img', { alt: '', draggable: false });
    void spriteDataUrl(t.id).then((u) => { img.src = u; });
    const verbBtn = (label: string, cost: number, run: () => void, cls = '', hint = '') => h('button', { class: `btn ${cls}`, title: hint, onclick: run },
      label, cost ? h('span', { class: 'cost ' + (ch >= cost ? '' : 'c-warn') }, `⚡${cost}`) : null);
    const task = [...pow.tasks.values()].find((x) => x.objectId === s.id && x.status !== 'done');
    this.els.side.replaceChildren(
      head('chip', h('span', null, t.class, h('span', { class: 'x-only' }, ` · ${s.id}`)), roleLine(t), h('button', { class: 'btn ghost icon', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => { this.selected = null; this.paint(); } }, '×')),
      h('div', { class: 'panel-body col' },
        h('div', { class: 'row' }, h('div', { class: 'sprite big' }, img), h('div', { class: 'col', style: 'gap:4px' },
          h('div', { class: 't-label-lg c-player', title: roleLine(t) }, t.type), h('div', { class: 't-tiny c-hint x-only' }, `${t.defaultCosmeticModelNumber} “${t.defaultCosmeticName}”`),
          h('div', { class: 'row wrap' }, h('span', { class: `chip ambit-${s.ambit} dcb-ico`, title: AMBIT_NAME[s.ambit as Ambit] || s.ambit, html: icon(s.ambit, 14) }), h('span', { class: 'chip ' + (s.built ? (s.online ? 'player' : 'warn') : 'neutral') }, s.built ? (s.online ? 'online' : 'offline') : 'building'), s.hidden ? h('span', { class: 'chip' }, 'stealthed') : null))),
        h('div', { class: 'dcb-vitals' },
          vital('health', `${s.health}/${t.maxHealth}`, 'Health', 'Hits it can take before it is destroyed.', s.health < t.maxHealth ? 'c-warn' : 'c-player'),
          vital('power', formatDraw(t.passiveDraw), 'Draw', 'Power it uses while switched on.'),
          ...weapons.map((w) => vital('target', `${w === 'primaryWeapon' ? t.primaryWeaponDamage : t.secondaryWeaponDamage}`, weaponLabel(t, w), `Reaches ${reachLabel(t, w)}; damage per hit.`, 'wide c-enemy', h('span', { class: 't-tiny c-hint dcb-sub' }, `${weaponLabel(t, w)} · ${reachLabel(t, w)}`))),
          s.defenders.length ? vital('shield', `×${s.defenders.length}`, 'Defended by', s.defenders.join(', '), 'c-secondary') : null),
        task ? taskRow(task) : null,
        actionBlock(p) ? h('div', { class: 't-tiny c-enemy' }, actionBlock(p)!) : null,
        h('div', { class: 'cd-verbs' + (actionBlock(p) ? ' blocked' : '') },
          ...verbs.map((v) => verbBtn(v.label, v.cost, () => this.guard(v.run), v.danger ? 'danger' : '', v.hint)),
          ...(s.built && s.online ? weapons.map((w) => verbBtn(weaponLabel(t, w), w === 'primaryWeapon' ? t.primaryWeaponCharge : t.secondaryWeaponCharge, () => {
            if (!away && s.locationType === 'fleet') { toast('Sail your fleet to a target first', 'warn'); return; }
            this.mode = { kind: 'attack', struct: s.id, weapon: w, picks: [] }; audio.play('charge'); this.paint();
          }, 'danger', `${reachLabel(t, w)}`)) : []),
          s.built && t.canDefend !== false ? verbBtn('Guard…', t.defendChangeCharge, () => { this.mode = { kind: 'defend', struct: s.id }; this.paint(); }, 'secondary', 'Pick a friend to protect') : null,
          s.built && t.movable ? verbBtn('Move…', t.moveCharge, () => { this.mode = { kind: 'move', struct: s.id }; this.paint(); }, 'secondary', 'Then pick an empty slot') : null,
          s.built && t.powerGeneration && t.powerGeneration !== 'noPowerGeneration' ? verbBtn('Burn alpha…', 0, async () => {
            const n = Number(prompt('Alpha to burn in this generator (it becomes permanent power capacity):', '1'));
            if (n > 0 && await confirmBox('Burn alpha', `Burn ${n} alpha in ${name(s)}? It cannot be recovered.`, 'Burn', 'enemy')) this.guard(() => act.infuseGenerator(p, s, BigInt(Math.round(n * 1e6))));
          }, 'secondary') : null,
          s.id !== p.fleet?.commandStruct ? verbBtn('Scrap', 0, async () => { if (await confirmBox('Scrap it', `Scrap ${name(s)}? It is gone for good.`, 'Scrap', 'enemy')) this.guard(() => act.trash(p, s)); }, 'ghost') : null)));
  }

  private paintBuild(p: PlayerState, where: 'planet' | 'fleet', ambit: Ambit, slot: number) {
    const ch = empire.charge(p);
    const types = buildable(where, ambit);
    const owned = (t: StructType) => [...p.structs.values()].filter((s) => s.typeId === t.id && !s.destroyed).length;
    this.els.side.replaceChildren(
      head('build', 'Build', `Build here: ${where} slot ${slot + 1}, ${AMBIT_NAME[ambit]}`, h('span', { class: `chip ambit-${ambit}`, title: `${AMBIT_NAME[ambit]} ${slot + 1}` }, h('span', { class: 'dcb-ico', html: icon(ambit, 14) }), String(slot + 1)),
        h('button', { class: 'btn ghost icon', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => { this.mode = { kind: 'none' }; this.paint(); } }, '×')),
      h('div', { class: 'panel-body col cd-build scroll' },
        buildBlock(p) ? h('div', { class: 't-tiny c-warn' }, buildBlock(p)!) : null,
        ...(types.length ? types.map((t) => {
          const img = h('img', { alt: '', draggable: false });
          void spriteDataUrl(t.id).then((u) => { img.src = u; });
          const limit = t.buildLimit && owned(t) >= t.buildLimit;
          const why = limit ? `You already have the most allowed (${t.buildLimit})` : buildBlock(p, t);
          return h('button', { class: 'cd-buildopt' + (why ? ' dim' : ''), disabled: !!why, title: why || roleLine(t), onclick: () => {
            this.guard(() => act.build(p, t, ambit, slot), () => { audio.play('confirm'); banner(t.type.toUpperCase(), 'CONSTRUCTION QUEUED', 'player', 1400); });
            this.mode = { kind: 'none' }; this.paint();
          } }, h('div', { class: 'sprite' }, img), h('div', { class: 'col', style: 'gap:2px; text-align:left; min-width:0' },
            h('div', { class: 't-label-lg c-player' }, t.type), h('div', { class: 't-tiny c-hint clamp2 x-only' }, roleLine(t)),
            h('div', { class: 'row t-tiny dcb-costs' }, h('span', { class: ch >= t.buildCharge ? 'c-player' : 'c-warn', title: 'Charge it costs' }, `⚡${t.buildCharge}`),
              h('span', { class: 'c-hint', title: 'Power it needs while being built' }, h('span', { class: 'dcb-ico', html: icon('power', 13) }), formatDraw(t.buildDraw)), h('span', { class: 'c-secondary x-only' }, `proof ⟶ ${t.buildDifficulty}`), why ? h('span', { class: 'c-enemy' }, limit ? 'limit' : 'blocked') : null)));
        }) : [h('div', { class: 't-tiny c-hint' }, 'Nothing can be built in this layer.')])));
  }

  /** The mission ladder: what's next, and the trail behind it. */
  private missions() {
    const { next, done, total } = progress();
    const p = wallet.primary?.playerId ? empire.players.get(wallet.primary.playerId) ?? null : null;
    const all = () => { this.open.missions = !this.open.missions; audio.play('select'); const me = this.me; if (me) this.paintSide(me); };
    return h('div', { class: 'cd-missions' },
      h('div', { class: 'spread' }, h('span', { class: 'row', style: 'gap:6px' }, h('span', { class: 'dcb-ico c-neutral', html: icon('flag', 18) }), h('span', { class: 't-label c-neutral' }, 'Missions')),
        h('button', { class: 'btn ghost mini dcb-key' + (this.open.missions ? ' active' : ''), title: 'Every mission', 'aria-label': `Missions ${done} of ${total}: ${this.open.missions ? 'fold the list' : 'show every mission'}`, 'aria-expanded': String(this.open.missions), onclick: all }, h('b', { class: 'dcb-n' }, `${done}/${total}`))),
      h('div', { class: 'bar warn' }, h('i', { style: `width:${(done / total) * 100}%` })),
      next ? h('div', { class: 'dcb-next small player' }, h('span', { class: 'dcb-next-ico', html: icon('flag', 20) }),
        tip(h('div', { class: 'dcb-next-body', tabindex: 0 }, h('div', { class: 't-label' }, next.title, h('span', { class: 'c-neutral' }, ` +${next.xp}`))), `${next.title}, +${next.xp} XP`, next.brief),
        next.go ? h('button', { class: 'btn ghost mini dcb-verb', title: next.brief, onclick: () => this.navigate(next.go!) }, face('a'), 'Go') : null)
        : h('div', { class: 't-tiny c-player' }, '★ Every mission complete. The galaxy is yours to take.'),
      this.open.missions ? h('div', { class: 'cd-mission-list' }, ...MISSIONS.map((m) => h('span', { class: 'chip ' + (m.done(p) ? 'player' : m === next ? 'warn' : ''), title: m.brief }, m.title))) : null);
  }

  /* ── Work: proofs and this player's queue ─────────────────────────── */

  private paintWork(p: PlayerState) {
    const tasks = [...pow.tasks.values()].filter((t) => t.playerId === p.playerId && t.status !== 'done');
    const jobs = txq.jobs.filter((j) => j.playerId === p.playerId).slice(-6).reverse();
    const state = pow.rate ? 'solving · ' + fmtRate(pow.rate) : pow.settings.enabled ? 'idle' : 'paused';
    this.els.work.replaceChildren(
      head('hash', 'Puzzles', 'Puzzles & moves: your computer solves a puzzle (proof of work) to finish each build, mining run, refining run and raid. Your queued moves are listed here too.',
        pow.rate || !pow.settings.enabled ? h('span', { class: 'chip ' + (pow.rate ? 'player' : 'warn'), title: state }, pow.rate ? fmtRate(pow.rate) : 'paused') : null),
      h('div', { class: 'panel-body col cd-worklist scroll' },
        ...(tasks.length ? tasks.map(taskRow) : jobs.length ? [] : [tip(h('div', { class: 'dcb-empty' }, h('span', { html: icon('check', 36) }), h('span', { class: 't-label' }, 'Nothing to solve')), 'Nothing to solve', 'Nothing to solve right now. Builds, mining and raids give your computer puzzles to solve.')]),
        ...jobs.map((j) => jobRow(j, true))));
  }

  /** Queue a move, explaining a refusal instead of throwing. */
  private guard(run: () => unknown, after?: () => void) {
    if (this.me && !empire.commands(this.me.playerId)) { audio.play('deny'); toast(`This is ${this.me.name}’s base. Only they can give orders here.`, 'warn'); return; }
    if (wallet.state !== 'unlocked') { openVault(); toast('Unlock your vault to act — the move is not queued', 'warn'); return; }
    try { run(); audio.play('confirm'); after?.(); } catch (e) { audio.play('deny'); toast((e as Error).message, 'enemy', 4000); }
  }
}

function roleLine(t: StructType): string {
  const bits: string[] = [];
  if (t.planetaryMining && t.planetaryMining !== 'noPlanetaryMining') bits.push('mines ore');
  if (t.planetaryRefinery && t.planetaryRefinery !== 'noPlanetaryRefinery') bits.push('refines ore to alpha');
  if (t.powerGeneration && t.powerGeneration !== 'noPowerGeneration') bits.push('generates power');
  if (hasWeapon(t, 'primaryWeapon')) bits.push(`${weaponLabel(t, 'primaryWeapon')} (${reachLabel(t, 'primaryWeapon')})`);
  if (t.planetaryDefenses && t.planetaryDefenses !== 'noPlanetaryDefense') bits.push('planetary defense');
  if (t.stealthSystems) bits.push('stealth');
  return bits.join(' · ') || t.class;
}

