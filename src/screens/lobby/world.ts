/* The Concourse: a round plaza 40 m across under a glass dome, the beacon (the Structs chevron
 * over a column of light) in the middle, a kiosk for each of the six hubs around the edge in that
 * hub's colour, the warp gate to the north, the notice wall above the north walk, the Academy
 * terminal and the deck lift (where you arrive) to the south. And, far below it, the hangar where
 * a new commander's droid is built and waits for the guild.
 *
 * North is -z: the camera at the spawn looks down -z at the beacon and the gate behind it. */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HUBS } from '../../data/learn';
import { icon } from '../../ui/icons';
import { createNebulaSky, createStarfield } from '../../gfx/space';
import { PLAZA_R, STATIONS, SPAWN, NOTICE, WARP, ACADEMY, KIOSK_R, KIOSK_DEG } from './layout';
export * from './layout';

/* ── Painting helpers ─────────────────────────────────────────────────── */

const FONT = '"DC Display", "Exo 2", system-ui, sans-serif';
export const fontsReady = (): Promise<unknown> => (document.fonts?.load ? Promise.all([document.fonts.load(`italic 900 48px ${FONT}`), document.fonts.ready]).catch(() => null) : Promise.resolve(null));

function canvasTex(c: HTMLCanvasElement, nearest = false) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (nearest) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
  return t;
}

/** An SVG icon as an image (drawn in one colour). */
export function iconImage(name: string, color: string, size = 96): Promise<HTMLImageElement | null> {
  const svg = icon(name, size).replace(/currentColor/g, color);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

/** A floating sign: an optional icon disc over a one-word label, painted once fonts are in. */
/** Every floating sign, so the ones right by the camera can fade out of the way. */
const signs: THREE.Sprite[] = [];

function sign(label: string, color: string, iconName?: string, w = 3.2): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = iconName ? 256 : 96;
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
  signs.push(s);
  return s;
}

function floorTexture(): THREE.CanvasTexture {
  const N = 1024, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  const px = N / (PLAZA_R * 2);
  const C = N / 2;
  g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
  const ring = (r: number, w: number, a: number, color = '121, 211, 242') => {
    g.strokeStyle = `rgba(${color}, ${a})`; g.lineWidth = w;
    g.beginPath(); g.arc(C, C, r * px, 0, Math.PI * 2); g.stroke();
  };
  // The sunken walk around the beacon, the kiosk ring, the rim.
  g.fillStyle = 'rgba(43, 108, 147, 0.10)';
  g.beginPath(); g.arc(C, C, 7 * px, 0, Math.PI * 2); g.fill();
  ring(2.9, 4, 0.9, '255, 106, 19');
  ring(7, 3, 0.55); ring(7.25, 1.5, 0.3);
  ring(12.4, 2, 0.28);
  ring(KIOSK_R - 2.2, 2, 0.3); ring(KIOSK_R + 2.2, 2, 0.3);
  ring(19.6, 5, 0.8);
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r0 = (i % 2 ? 7.4 : 7.1) * px, r1 = (i % 4 === 0 ? 19.4 : 12.2) * px;
    g.strokeStyle = `rgba(121, 211, 242, ${i % 4 === 0 ? 0.28 : 0.12})`; g.lineWidth = i % 4 === 0 ? 2 : 1;
    g.beginPath(); g.moveTo(C + Math.sin(a) * r0, C - Math.cos(a) * r0); g.lineTo(C + Math.sin(a) * r1, C - Math.cos(a) * r1); g.stroke();
  }
  // Lit paths from the spawn and to each kiosk, in the kiosk's colour.
  for (const hb of HUBS) {
    const a = THREE.MathUtils.degToRad(KIOSK_DEG[hb.id]);
    const col = new THREE.Color(hb.color);
    g.strokeStyle = `rgba(${Math.round(col.r * 255)}, ${Math.round(col.g * 255)}, ${Math.round(col.b * 255)}, 0.55)`;
    g.lineWidth = 3;
    g.beginPath(); g.arc(C, C, (KIOSK_R - 2.6) * px, -Math.PI / 2 + a - 0.09, -Math.PI / 2 + a + 0.09); g.stroke();
  }
  const t = canvasTex(c);
  t.anisotropy = 4;
  return t;
}

function galaxyTexture(): THREE.CanvasTexture {
  const N = 512, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  const C = N / 2;
  const core = g.createRadialGradient(C, C, 0, C, C, N * 0.18);
  core.addColorStop(0, 'rgba(255, 236, 200, 0.95)'); core.addColorStop(1, 'rgba(255, 200, 150, 0)');
  g.fillStyle = core; g.fillRect(0, 0, N, N);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2600; i++) {
    const arm = i % 3, t = rnd();
    const r = 10 + t * N * 0.45;
    const a = arm * (Math.PI * 2 / 3) + t * 6.2 + (rnd() - 0.5) * 0.5;
    const x = C + Math.cos(a) * r, y = C + Math.sin(a) * r;
    const hot = rnd() < 0.15;
    g.fillStyle = hot ? `rgba(255, 220, 190, ${0.7 * (1 - t)})` : `rgba(160, 180, 255, ${0.55 * (1 - t * 0.8)})`;
    g.fillRect(x, y, hot ? 2 : 1.5, hot ? 2 : 1.5);
  }
  return canvasTex(c);
}

/* ── The plaza ────────────────────────────────────────────────────────── */

export interface World {
  plaza: THREE.Group;
  hangar: THREE.Group;
  /** The hangar lift's ring: orange while the guild builds you, cyan when ready. */
  setLiftReady(ready: boolean): void;
  noticeCanvas: HTMLCanvasElement;
  noticeTexture: THREE.CanvasTexture;
  sky: THREE.Object3D[];
  update(t: number, camera?: THREE.Vector3): void;
  dispose(): void;
}

export const HANGAR_Y = -400;

export function buildWorld(scene: THREE.Scene, renderer: THREE.WebGLRenderer): World {
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };
  const std = (color: THREE.ColorRepresentation, o: THREE.MeshStandardMaterialParameters = {}) => keep(new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.35, flatShading: true, ...o }));
  const glow = (color: THREE.ColorRepresentation, o: THREE.MeshBasicMaterialParameters = {}) => keep(new THREE.MeshBasicMaterial({ color, toneMapped: false, ...o }));

  scene.background = new THREE.Color(0x050c1e);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTex = pmrem.fromScene(room, 0.04).texture;
  room.dispose(); pmrem.dispose();
  scene.environment = envTex;
  (scene as THREE.Scene & { environmentIntensity?: number }).environmentIntensity = 0.45;
  disposables.push(envTex);

  const sky = [createNebulaSky({ seed: 5.2, intensity: 0.7 }), createStarfield(3000, 800, 9)];
  for (const s of sky) scene.add(s);

  scene.add(new THREE.HemisphereLight(0x8fb4e0, 0x0b1240, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(6, 14, 9);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x6fa8dc, 0.55);
  fill.position.set(-8, 6, -7);
  scene.add(fill);

  const plaza = new THREE.Group();
  plaza.name = 'plaza';
  scene.add(plaza);

  // Floor and rim.
  const floorTex = keep(floorTexture());
  const floor = new THREE.Mesh(keep(new THREE.CircleGeometry(PLAZA_R, 96)), std('#0A1F38', { roughness: 0.82, metalness: 0.15, emissive: 0xffffff, emissiveMap: floorTex, emissiveIntensity: 0.5, flatShading: false }));
  floor.rotation.x = -Math.PI / 2;
  floor.name = 'floor';
  plaza.add(floor);
  const outer = new THREE.Mesh(keep(new THREE.RingGeometry(PLAZA_R, 70, 64)), std('#071629', { roughness: 0.95, metalness: 0 }));
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.02;
  plaza.add(outer);
  const wall = new THREE.Mesh(keep(new THREE.CylinderGeometry(PLAZA_R, PLAZA_R, 1.1, 96, 1, true)), std('#0C2744', { side: THREE.BackSide }));
  wall.position.y = 0.55;
  plaza.add(wall);
  const rail = new THREE.Mesh(keep(new THREE.TorusGeometry(PLAZA_R - 0.05, 0.06, 6, 128)), glow('#79D3F2'));
  rail.rotation.x = Math.PI / 2; rail.position.y = 1.1;
  plaza.add(rail);

  // The dome: a lattice over everything, open to the sky.
  const domeGeo = keep(new THREE.EdgesGeometry(new THREE.SphereGeometry(30, 20, 9, 0, Math.PI * 2, 0, Math.PI / 2.2)));
  const dome = new THREE.LineSegments(domeGeo, keep(new THREE.LineBasicMaterial({ color: 0x2b6c93, transparent: true, opacity: 0.32 })));
  dome.position.y = -2;
  plaza.add(dome);

  // The galaxy turning overhead.
  const galaxyTex = keep(galaxyTexture());
  const galaxy = new THREE.Mesh(keep(new THREE.PlaneGeometry(70, 70)), keep(new THREE.MeshBasicMaterial({ map: galaxyTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })));
  galaxy.position.set(26, 34, -70);
  galaxy.rotation.set(0.9, -0.35, 0.4);
  plaza.add(galaxy);

  // The beacon: a raised disc, a column of light, the chevron turning above.
  const beacon = new THREE.Group();
  beacon.add(new THREE.Mesh(keep(new THREE.CylinderGeometry(2.4, 2.65, 0.32, 40)), std('#12406A')));
  const bring = new THREE.Mesh(keep(new THREE.TorusGeometry(2.42, 0.07, 6, 64)), glow('#FF6A13'));
  bring.rotation.x = Math.PI / 2; bring.position.y = 0.33;
  beacon.add(bring);
  const colC = document.createElement('canvas'); colC.width = 4; colC.height = 128;
  const cg = colC.getContext('2d')!;
  const grd = cg.createLinearGradient(0, 128, 0, 0);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)'); grd.addColorStop(0.5, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  cg.fillStyle = grd; cg.fillRect(0, 0, 4, 128);
  const colTex = keep(canvasTex(colC));
  const column = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.6, 0.75, 16, 24, 1, true)), glow('#43CDB6', { map: colTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  column.position.y = 8.3;
  beacon.add(column);
  const mark = new THREE.Group();
  const shape = (pts: [number, number][]) => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x - 8, 8 - y)));
  const hull = shape([[2.5, 3.5], [10, 3.5], [13.5, 8], [10, 12.5], [2.5, 12.5], [6, 8]]);
  const cut = shape([[6, 8], [3.8, 5.2], [8.1, 5.2], [10.3, 8], [8.1, 10.8], [3.8, 10.8]]);
  const ext = { depth: 1.2, bevelEnabled: true, bevelThickness: 0.25, bevelSize: 0.2, bevelSegments: 1 };
  const hullMesh = new THREE.Mesh(keep(new THREE.ExtrudeGeometry(hull, ext)), std('#43CDB6', { emissive: '#43CDB6', emissiveIntensity: 0.55 }));
  const cutMesh = new THREE.Mesh(keep(new THREE.ExtrudeGeometry(cut, { ...ext, depth: 1.8 })), std('#0B1240', { emissive: '#0B1240' }));
  hullMesh.position.z = -0.6; cutMesh.position.z = -0.9;
  mark.add(hullMesh, cutMesh);
  mark.scale.setScalar(0.3);
  mark.position.y = 7.2;
  beacon.add(mark);
  const beaconLight = new THREE.PointLight(0x43cdb6, 18, 16, 1.6);
  beaconLight.position.y = 3;
  beacon.add(beaconLight);
  plaza.add(beacon);

  // Kiosks: a console facing the centre, a pillar in the hub's colour, its sign floating above.
  for (const st of STATIONS.filter((s) => s.kind === 'kiosk')) {
    const k = new THREE.Group();
    k.position.copy(st.at);
    k.lookAt(0, 0, 0);
    const col = new THREE.Color(st.color);
    const base = new THREE.Mesh(keep(new THREE.BoxGeometry(2.5, 1.0, 1.3)), std('#0C2744'));
    base.position.y = 0.5;
    const top = new THREE.Mesh(keep(new THREE.BoxGeometry(2.3, 0.08, 0.9)), std(col, { emissive: col, emissiveIntensity: 0.9 }));
    top.position.set(0, 1.05, 0.05); top.rotation.x = -0.35;
    const screen = new THREE.Mesh(keep(new THREE.BoxGeometry(2.2, 1.3, 0.12)), std('#071629', { emissive: col, emissiveIntensity: 0.25 }));
    screen.position.set(0, 1.85, -0.45); screen.rotation.x = -0.12;
    const pillar = new THREE.Mesh(keep(new THREE.BoxGeometry(0.28, 3.4, 0.28)), std('#12406A'));
    pillar.position.set(1.35, 1.7, -0.5);
    const band = new THREE.Mesh(keep(new THREE.BoxGeometry(0.3, 2.6, 0.06)), glow(col));
    band.position.set(1.35, 1.9, -0.35);
    const pad = new THREE.Mesh(keep(new THREE.RingGeometry(1.3, 1.45, 32)), glow(col, { transparent: true, opacity: 0.35 }));
    pad.rotation.x = -Math.PI / 2; pad.position.set(0, 0.02, 2.0);
    k.add(base, top, screen, pillar, band, pad);
    const s = sign(st.label, st.color, st.hub, 2.4);
    s.position.set(0, 3.9, -0.3);
    k.add(s);
    plaza.add(k);
  }

  // The warp gate: an arch over a turning portal.
  const warp = new THREE.Group();
  warp.position.copy(WARP);
  const arch = new THREE.Mesh(keep(new THREE.TorusGeometry(2.45, 0.3, 8, 28, Math.PI)), std('#12406A', { emissive: '#79D3F2', emissiveIntensity: 0.25 }));
  arch.position.y = 2.2;
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(keep(new THREE.BoxGeometry(0.6, 2.2, 0.6)), std('#12406A'));
    post.position.set(s * 2.45, 1.1, 0);
    warp.add(post);
  }
  const swirlC = document.createElement('canvas'); swirlC.width = swirlC.height = 128;
  const sg = swirlC.getContext('2d')!;
  for (let i = 0; i < 9; i++) {
    sg.strokeStyle = `rgba(121, 211, 242, ${0.15 + (i % 3) * 0.12})`; sg.lineWidth = 6;
    sg.beginPath(); sg.arc(64, 64, 8 + i * 6.5, i, i + 4.2); sg.stroke();
  }
  const swirlTex = keep(canvasTex(swirlC));
  swirlTex.center.set(0.5, 0.5);
  const portal = new THREE.Mesh(keep(new THREE.CircleGeometry(2.2, 40)), glow('#79D3F2', { map: swirlTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  portal.position.y = 2.2;
  const floorPortal = new THREE.Mesh(keep(new THREE.RingGeometry(1.6, 2.2, 32)), glow('#79D3F2', { transparent: true, opacity: 0.45 }));
  floorPortal.rotation.x = -Math.PI / 2; floorPortal.position.set(0, 0.02, 1.6);
  warp.add(arch, portal, floorPortal);
  const warpSign = sign('Warp', '#79D3F2', 'battle', 2.4);
  warpSign.position.set(0, 5.6, 0);
  warp.add(warpSign);
  plaza.add(warp);

  // The notice wall: a big screen high over the north walk, the live feed on it.
  const noticeCanvas = document.createElement('canvas');
  noticeCanvas.width = 768; noticeCanvas.height = 384;
  const noticeTexture = keep(canvasTex(noticeCanvas));
  const notice = new THREE.Group();
  notice.position.copy(NOTICE);
  const npost = new THREE.Mesh(keep(new THREE.BoxGeometry(0.5, 4.2, 0.5)), std('#12406A'));
  npost.position.y = 2.1;
  const frame = new THREE.Mesh(keep(new THREE.BoxGeometry(6.6, 3.5, 0.25)), std('#0C2744', { emissive: '#79D3F2', emissiveIntensity: 0.12 }));
  frame.position.y = 5.4;
  const face = new THREE.Mesh(keep(new THREE.PlaneGeometry(6.2, 3.1)), glow(0xffffff, { map: noticeTexture }));
  face.position.set(0, 5.4, 0.14);
  const nring = new THREE.Mesh(keep(new THREE.RingGeometry(1.2, 1.35, 32)), glow('#94A4E4', { transparent: true, opacity: 0.5 }));
  nring.rotation.x = -Math.PI / 2; nring.position.set(0, 0.02, 1.4);
  notice.add(npost, frame, face, nring);
  plaza.add(notice);

  // The Academy terminal: a podium with a gold screen.
  const acad = new THREE.Group();
  acad.position.copy(ACADEMY);
  acad.lookAt(0, 0, 0);
  const pod = new THREE.Mesh(keep(new THREE.BoxGeometry(0.9, 1.1, 0.6)), std('#0C2744'));
  pod.position.y = 0.55;
  const acScreen = new THREE.Mesh(keep(new THREE.BoxGeometry(0.85, 0.06, 0.55)), std('#F5C518', { emissive: '#F5C518', emissiveIntensity: 0.9 }));
  acScreen.position.set(0, 1.13, 0.02); acScreen.rotation.x = -0.4;
  acad.add(pod, acScreen);
  const acSign = sign('Academy', '#F5C518', 'academy', 1.7);
  acSign.position.set(0, 2.6, 0);
  acad.add(acSign);
  plaza.add(acad);

  // The deck lift: where you arrive, and where you change channel.
  const lift = new THREE.Group();
  lift.position.copy(SPAWN);
  lift.add(new THREE.Mesh(keep(new THREE.CylinderGeometry(1.5, 1.6, 0.12, 32)), std('#12406A')));
  const lring = new THREE.Mesh(keep(new THREE.TorusGeometry(1.5, 0.05, 6, 48)), glow('#79D3F2'));
  lring.rotation.x = Math.PI / 2; lring.position.y = 0.13;
  lift.add(lring);
  const lSign = sign('Decks', '#79D3F2', 'chat', 1.3);
  lSign.position.set(0, 3.8, -1.6);
  lift.add(lSign);
  plaza.add(lift);

  /* ── The hangar (setup and arrival) ── */
  const hangar = new THREE.Group();
  hangar.name = 'hangar';
  hangar.position.y = HANGAR_Y;
  hangar.visible = false;
  scene.add(hangar);
  const hfloor = new THREE.Mesh(keep(new THREE.CircleGeometry(14, 48)), std('#0A1C33', { roughness: 0.9, metalness: 0.1 }));
  hfloor.rotation.x = -Math.PI / 2;
  hangar.add(hfloor);
  for (let i = -5; i <= 5; i++) {
    const rib = new THREE.Mesh(keep(new THREE.BoxGeometry(0.35, 9, 0.35)), std('#0A1F38'));
    rib.position.set(i * 1.9, 4.5, -5 + Math.abs(i) * 0.25);
    hangar.add(rib);
  }
  const backWall = new THREE.Mesh(keep(new THREE.PlaneGeometry(30, 10)), std('#071629', { roughness: 1, metalness: 0 }));
  backWall.position.set(0, 5, -6);
  hangar.add(backWall);
  const hlift = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.25, 1.35, 0.14, 40)), std('#0F3352'));
  hlift.position.y = 0.07;
  const hringMat = glow('#FF6A13');
  const hring = new THREE.Mesh(keep(new THREE.TorusGeometry(1.3, 0.06, 6, 64)), hringMat);
  hring.rotation.x = Math.PI / 2; hring.position.y = 0.15;
  // Only the cone's far wall draws, so the light never washes over the droid standing in it.
  const cone = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.5, 2.2, 7, 32, 1, true)), glow('#79D3F2', { map: colTex, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide }));
  cone.position.y = 3.5;
  const hlight = new THREE.PointLight(0xbfe8ff, 4, 9, 1.5);
  hlight.position.set(0, 4.5, 1.5);
  hangar.add(hlift, hring, cone, hlight);

  let liftReady = true;
  const tmp = new THREE.Vector3();
  return {
    plaza, hangar, sky, noticeCanvas, noticeTexture,
    setLiftReady(ready) { liftReady = ready; hringMat.color.set(ready ? '#79D3F2' : '#FF6A13'); },
    update(t, camera) {
      if (camera) for (const sp of signs) {
        sp.getWorldPosition(tmp);
        (sp.material as THREE.SpriteMaterial).opacity = THREE.MathUtils.clamp((camera.distanceTo(tmp) - 3.5) / 4, 0, 1);
      }
      mark.rotation.y = t * 0.45;
      mark.position.y = 7.2 + Math.sin(t * 0.8) * 0.25;
      column.material.opacity = 0.75 + Math.sin(t * 1.7) * 0.15;
      swirlTex.rotation = -t * 0.9;
      galaxy.rotation.z = 0.4 + t * 0.01;
      lring.material.opacity = 1;
      if (!liftReady) hringMat.color.setHSL(0.06, 1, 0.45 + Math.sin(t * 4) * 0.1);
    },
    dispose() {
      for (const d of disposables) d.dispose();
      scene.environment = null;
    },
  };
}
