/* Dev only (/dev/arena.html, never built): the battle board as a real 3D place, to choose a
 * direction. It keeps the board's own layout (the tiers' heights, the slots' x), so the battle's
 * coach, callouts and picking would keep working. The tiers already stack the way altitude does, so
 * the board becomes a cross-section of the planet: the sea at the bottom, a deck of land above it,
 * the cloud layer, and orbit, under a sky that fades from atmosphere into space.
 *   ?cam=board  today's framing, straight on (the default)
 *   ?cam=arena  a free three-quarter camera over the same decks */
import * as THREE from 'three';
import { getHullModel, hullFxMaterial, type HullUniforms } from '../gfx/hull/model';
import { slotX, tiersFor, TIER_STRETCH } from '../screens/battle/env';

const cam = new URLSearchParams(location.search).get('cam') === 'arena' ? 'arena' : 'board';
document.getElementById('tag')!.textContent = cam === 'arena' ? 'OPTION B · ARENA CAMERA' : 'OPTION A · TODAY’S FRAMING, REAL 3D DECKS';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
const scene = new THREE.Scene();
const T = tiersFor(TIER_STRETCH);
const camera = new THREE.PerspectiveCamera(cam === 'arena' ? 40 : 36, 1, 0.1, 2000);

/* ── Sky: atmosphere low, space high ─────────────────────────────────── */
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { uSea: { value: T.water }, uSpace: { value: T.space } },
  vertexShader: `varying vec3 vW; void main() { vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
  fragmentShader: `
    varying vec3 vW; uniform float uSea, uSpace;
    float h(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
    void main() {
      vec3 d = normalize(vW - vec3(0.0, 0.0, 47.0));
      float alt = d.y;
      vec3 deep = vec3(0.012, 0.02, 0.06), high = vec3(0.05, 0.07, 0.2), atmo = vec3(0.32, 0.42, 0.72), glow = vec3(0.95, 0.62, 0.55);
      vec3 c = mix(atmo, high, smoothstep(-0.05, 0.16, alt));
      c = mix(c, deep, smoothstep(0.14, 0.4, alt));
      c += glow * exp(-abs(alt + 0.02) * 30.0) * 0.55;
      // Stars where the air thins.
      vec3 q = floor(d * 420.0);
      float s = step(0.9975, h(q)) * smoothstep(0.06, 0.22, alt);
      c += vec3(s) * (0.6 + 0.4 * h(q + 3.1));
      gl_FragColor = vec4(c, 1.0);
    }`,
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), skyMat));
scene.fog = new THREE.Fog(0x46598f, 70, 230);

/* ── Light ───────────────────────────────────────────────────────────── */
scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x3a3250, 1.0));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
sun.position.set(-30, 40, 30);
scene.add(sun);
const rim = new THREE.DirectionalLight(0x9fd8ff, 1.4);
rim.position.set(25, 10, -40);
scene.add(rim);

const flat = (color: THREE.ColorRepresentation, o: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, metalness: 0.05, ...o });
/** A mesh placed at x, y, z. */
const at = <M extends THREE.Object3D>(m: M, x: number, y: number, z: number) => { m.position.set(x, y, z); return m; };
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/* ── The sea ─────────────────────────────────────────────────────────── */
const seaY = T.water - 1.75;
const seaGeo = new THREE.PlaneGeometry(260, 160, 70, 40).toNonIndexed();
seaGeo.rotateX(-Math.PI / 2);
seaGeo.translate(0, seaY - 0.3, -50);
const seaBase = Float32Array.from(seaGeo.getAttribute('position').array);
const sea = new THREE.Mesh(seaGeo, flat(0x1f5fb0, { roughness: 0.35, metalness: 0.2, emissive: 0x0a2a55, emissiveIntensity: 0.4 }));
scene.add(sea);

/* ── The land deck: a slab of terrain, hills behind, mesas on the skyline ── */
const landY = T.land - 1.85;
const land = new THREE.Group();
scene.add(land);
const topGeo = new THREE.PlaneGeometry(64, 26, 40, 16).toNonIndexed();
topGeo.rotateX(-Math.PI / 2);
const tp = topGeo.getAttribute('position');
for (let i = 0; i < tp.count; i++) {
  const x = tp.getX(i), z = tp.getZ(i);
  const back = Math.max(0, -z - 3) / 10;                 // flat where the hulls stand, rising behind
  const n = Math.sin(x * 0.31 + z * 0.17) * 0.5 + Math.sin(x * 0.11 - z * 0.37) * 0.7;
  tp.setY(i, (back * back) * 2.6 + n * back * 1.2 + (Math.abs(z) < 6 ? 0 : n * 0.08));
}
topGeo.computeVertexNormals();
topGeo.translate(0, landY, -10);
const sand = topGeo.clone();
{ // Colour by height: sand where the hulls stand, ochre then rust up the hills.
  const p = sand.getAttribute('position'), col: number[] = [];
  const a = new THREE.Color(0xd9b07a), b = new THREE.Color(0xb4703f), c = new THREE.Color(0x7d3b2c);
  for (let i = 0; i < p.count; i += 3) {
    const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3 - landY;
    const k = THREE.MathUtils.clamp(y / 4, 0, 1), cc = (k < 0.5 ? a.clone().lerp(b, k * 2) : b.clone().lerp(c, (k - 0.5) * 2)).offsetHSL(0, 0, (rnd() - 0.5) * 0.04);
    for (let j = 0; j < 3; j++) col.push(cc.r, cc.g, cc.b);
  }
  sand.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
}
land.add(new THREE.Mesh(sand, flat(0xffffff, { vertexColors: true })));
// The deck's front edge: a rock face with strata, down to a jagged underside.
const lip = new THREE.Mesh(new THREE.BoxGeometry(64, 1.3, 1.2), flat(0x8a4a33));
lip.position.set(0, landY - 0.65, 3.4);
land.add(lip);
land.add(at(new THREE.Mesh(new THREE.BoxGeometry(64, 0.18, 1.25), flat(0xe8c48a)), 0, landY - 0.05, 3.42));
for (let i = 0; i < 18; i++) {
  const r = 0.6 + rnd() * 1.1;
  const rock = new THREE.Mesh(new THREE.ConeGeometry(r, 1 + rnd() * 1.6, 5), flat(0x6b3a2c));
  rock.rotation.x = Math.PI;
  rock.position.set(-31 + i * 3.6 + rnd(), landY - 1.6 - rnd() * 0.5, 2.6 - rnd() * 2);
  land.add(rock);
}
for (let i = 0; i < 9; i++) {
  const h = 4 + rnd() * 7, r = 2.5 + rnd() * 3;
  const mesa = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r, h, 6 + Math.floor(rnd() * 3)), flat(rnd() < 0.5 ? 0xa45a3a : 0x8c4a33));
  mesa.position.set(-60 + i * 15 + rnd() * 6, landY + h / 2 + 1, -26 - rnd() * 20);
  land.add(mesa);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.82, r * 0.82, 0.4, mesa.geometry.parameters.radialSegments), flat(0xd9a46a));
  cap.position.copy(mesa.position).y += h / 2;
  land.add(cap);
}

/* ── The cloud layer: puffs from the front of the board to the horizon ── */
const airY = T.air;
const puff = new THREE.IcosahedronGeometry(1, 1);
const PUFFS = 360;
const clouds = new THREE.InstancedMesh(puff, flat(0xf6f4ff, { roughness: 1, emissive: 0x6a74b0, emissiveIntensity: 0.35 }), PUFFS);
{
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < PUFFS; i++) {
    // Mostly well behind the hulls; a few small ones drift under them at the front.
    const front = rnd() < 0.12;
    const z = front ? 1 - rnd() * 4 : -8 - Math.pow(rnd(), 0.7) * 70, x = (rnd() - 0.5) * (80 + -z * 1.6);
    const k = front ? 0.5 + rnd() * 0.6 : 1 + rnd() * 2;
    p.set(x, airY - (front ? 2.4 : 2.0 + rnd() * 0.8), z);
    s.set(k * (1.4 + rnd()), k * (0.45 + rnd() * 0.25), k * (1 + rnd() * 0.6));
    q.setFromEuler(new THREE.Euler(0, rnd() * 3, 0));
    clouds.setMatrixAt(i, m.compose(p, q, s));
  }
}
scene.add(clouds);

/* ── Orbit: a station rail the space hulls hold station along ──────────── */
const spaceY = T.space;
const rail = new THREE.Group();
scene.add(rail);
const hull = flat(0xc9d1dd, { roughness: 0.5, metalness: 0.4 });
for (const z of [-2.6, 1.6]) {
  rail.add(at(new THREE.Mesh(new THREE.BoxGeometry(62, 0.22, 0.22), hull), 0, spaceY - 2.3, z));
}
for (let i = 0; i < 31; i++) {
  const x = -30 + i * 2;
  rail.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 4.2), hull), x, spaceY - 2.3, -0.5));
  if (i % 3 === 0) rail.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.3), new THREE.MeshBasicMaterial({ color: 0x7af0ff })), x, spaceY - 2.15, 1.6));
}

// The planet's edge below orbit, far behind: the space deck reads as high above it.
const limb = new THREE.Mesh(new THREE.SphereGeometry(260, 64, 32), new THREE.MeshStandardMaterial({ color: 0x2c5fa8, emissive: 0x16306a, emissiveIntensity: 0.5, roughness: 0.9 }));
limb.position.set(0, spaceY - 2.3 - 268, -330);
scene.add(limb);
limb.material.fog = false;

/* ── The hulls, at the board's own slots ────────────────────────────── */
const UNIT = 0.82;
type Spot = { id: number; side: 'player' | 'enemy'; ambit: 'space' | 'air' | 'land' | 'water'; slot: number; command?: boolean };
const lineup: Spot[] = [
  { id: 1, side: 'player', ambit: 'space', slot: 0, command: true }, { id: 2, side: 'player', ambit: 'space', slot: 0 }, { id: 3, side: 'player', ambit: 'space', slot: 1 },
  { id: 5, side: 'player', ambit: 'air', slot: 0 }, { id: 6, side: 'player', ambit: 'air', slot: 1 }, { id: 7, side: 'player', ambit: 'air', slot: 2 },
  { id: 9, side: 'player', ambit: 'land', slot: 0 }, { id: 8, side: 'player', ambit: 'land', slot: 1 }, { id: 10, side: 'player', ambit: 'land', slot: 2 },
  { id: 11, side: 'player', ambit: 'water', slot: 0 }, { id: 12, side: 'player', ambit: 'water', slot: 1 },
  { id: 4, side: 'enemy', ambit: 'space', slot: 0 }, { id: 3, side: 'enemy', ambit: 'space', slot: 1 },
  { id: 5, side: 'enemy', ambit: 'air', slot: 0 }, { id: 6, side: 'enemy', ambit: 'air', slot: 1 },
  { id: 1, side: 'enemy', ambit: 'land', slot: 0, command: true }, { id: 9, side: 'enemy', ambit: 'land', slot: 0 }, { id: 8, side: 'enemy', ambit: 'land', slot: 1 },
  { id: 12, side: 'enemy', ambit: 'water', slot: 0 }, { id: 13, side: 'enemy', ambit: 'water', slot: 1 },
];
const units: { g: THREE.Group; u: HullUniforms; ambit: Spot['ambit']; seed: number; y: number }[] = [];
for (const s of lineup) {
  const frame = cam === 'arena' ? 'upright' : 'board';
  const m = getHullModel(s.id, s.side, 'base', frame);
  const mat = hullFxMaterial(m);
  const mesh = new THREE.Mesh(m.geometry, mat);
  const k = UNIT * (s.command ? 1.15 : 1);
  mesh.scale.setScalar(k);
  if (s.side === 'enemy') { if (frame === 'board') mesh.scale.x *= -1; else mesh.rotation.y = Math.PI; }
  const hh = m.height * k / 2;
  const x = slotX(s.side, s.slot, !!s.command);
  const y = s.ambit === 'land' ? landY + hh : s.ambit === 'water' ? seaY + hh * 0.55 : T[s.ambit] - 0.2;
  const g = new THREE.Group();
  g.position.set(x, y, s.command ? -0.6 : 0);
  g.add(mesh);
  scene.add(g);
  const u = mat.userData.hull as HullUniforms;
  u.uRim.value.multiplyScalar(0.8);
  units.push({ g, u, ambit: s.ambit, seed: Math.random() * 10, y });
}
// The divide between the sides: a thin wall of light, as the board has.
const divide = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 30), new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
divide.position.set(0, 0, 0.5);
scene.add(divide);

/* ── Frame ───────────────────────────────────────────────────────────── */
const resize = () => {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (cam === 'board') {
    // battle.ts fitCamera: the deck's half-width (22.5) across the view, straight on.
    const half = 22.5, t = Math.tan((camera.fov * Math.PI) / 360);
    camera.position.set(0, 0.6, Math.max(half / (t * camera.aspect), 16.5 / t));
    camera.lookAt(0, 0, 0);
  }
};
addEventListener('resize', resize);
resize();
renderer.setAnimationLoop((ms) => {
  const t = ms / 1000;
  if (cam === 'arena') {
    const a = -0.42 + Math.sin(t * 0.08) * 0.08;
    camera.position.set(Math.sin(a) * 52, 15, Math.cos(a) * 52);
    camera.lookAt(0, -0.5, -3);
  }
  // The sea rolls.
  const p = seaGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = seaBase[i * 3], z = seaBase[i * 3 + 2];
    p.setY(i, seaBase[i * 3 + 1] + Math.sin(x * 0.35 + t * 1.1) * 0.18 + Math.sin(z * 0.5 - t * 0.8 + x * 0.1) * 0.22);
  }
  p.needsUpdate = true;
  seaGeo.computeVertexNormals();
  for (const u of units) {
    const s = u.seed;
    if (u.ambit === 'space') u.g.position.y = u.y + Math.sin(t * 0.7 + s) * 0.12;
    else if (u.ambit === 'air') { u.g.position.y = u.y + Math.sin(t * 1.3 + s) * 0.18; u.g.rotation.z = Math.sin(t * 0.9 + s) * 0.05; }
    else if (u.ambit === 'water') { u.g.position.y = u.y + Math.sin(t * 1.1 + s) * 0.08; u.g.rotation.z = Math.sin(t * 0.8 + s) * 0.03; }
  }
  renderer.render(scene, camera);
});
