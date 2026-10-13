/* Struct hulls (src/gfx/hull): every struct type has a recipe and a footprint, every hull builds
 * clean geometry (finite, unit normals, swatch UVs) inside the triangle budget, a ship's water is
 * scenery the boards can leave out, and the slugs chat reactions use still name real types. */
import { STRUCT_TYPES, STRUCT_SLUG, typeBySlug } from '../src/data/catalogue';
import { RECIPES, FOOTPRINT, hullGeometry } from '../src/gfx/hull/recipes';
import { STRUCT_ART } from '../src/chat/format';
import type { HullModel } from '../src/gfx/hull/model';
import * as THREE from 'three';

let fails = 0;
const ok = (cond: unknown, msg: string) => { if (!cond) { fails++; console.error('FAIL', msg); } };

/** Up to 16 hulls stand on a board beside the scene's own ~35k: each stays well inside 1,500. */
const BUDGET = 1500;
let worst = 0, worstId = 0;
for (const t of STRUCT_TYPES) {
  ok(RECIPES[t.id], `${t.id} ${t.type}: has a recipe`);
  ok(FOOTPRINT[t.id]?.every((n) => n > 20 && n <= 128), `${t.id} ${t.type}: has a footprint inside the old 128 px frame`);
  for (const scenery of [true, false]) {
    const g = hullGeometry(t.id, scenery);
    if (!g) { ok(false, `${t.id}: builds`); continue; }
    const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), uv = g.getAttribute('uv'), col = g.getAttribute('color');
    const tris = pos.count / 3;
    if (tris > worst) { worst = tris; worstId = t.id; }
    ok(tris > 40 && tris <= BUDGET, `${t.id} ${t.type}: ${tris} triangles (budget ${BUDGET})`);
    ok(!g.getAttribute('skinIndex'), `${t.id}: no skinning attributes (structs never bend)`);
    let bad = 0;
    for (let i = 0; i < pos.count; i++) {
      const v = [pos.getX(i), pos.getY(i), pos.getZ(i), nor.getX(i), nor.getY(i), nor.getZ(i), uv.getX(i), uv.getY(i), col.getX(i), col.getY(i), col.getZ(i)];
      if (!v.every(Number.isFinite)) { bad++; continue; }
      if (Math.abs(Math.hypot(v[3], v[4], v[5]) - 1) > 1e-3) bad++;
      if (v[6] < 0 || v[6] > 1 || v[7] < 0 || v[7] > 1) bad++;
      if (v[8] < 0 || v[9] < 0 || v[10] < 0 || v[8] > 1.01 || v[9] > 1.01 || v[10] > 1.01) bad++;
    }
    ok(!bad, `${t.id} ${t.type}${scenery ? '' : ' (board)'}: ${bad} bad vertices`);
    const bb = g.boundingBox!;
    ok(bb.max.x - bb.min.x > 0.5 && bb.max.x - bb.min.x < 4 && bb.max.y > 0.1, `${t.id} ${t.type}: a sensible size`);
  }
  // Water is scenery: a ship without it has fewer triangles; nothing else changes.
  const withWater = hullGeometry(t.id, true)!.getAttribute('position').count, without = hullGeometry(t.id, false)!.getAttribute('position').count;
  const ship = t.possibleAmbit === 2;
  ok(ship ? without < withWater : without === withWater, `${t.id} ${t.type}: water is scenery only on ships (${withWater} → ${without})`);
}
ok(hullGeometry(1) === hullGeometry(1), 'hulls are built once and shared');
ok(hullGeometry(999) === null, 'an unknown type has no hull');

// Chat reactions: every :struct/<slug>: still names a type with a hull.
for (const slug of STRUCT_ART) ok(typeBySlug(slug) && RECIPES[typeBySlug(slug)], `:struct/${slug}: names a struct type`);
ok(Object.values(STRUCT_SLUG).length === new Set(Object.values(STRUCT_SLUG)).size, 'slugs are unique');

// Shatter draws only the cubes in flight (12 triangles each; the boards' ring of 7000 is 84k, which
// once blew the cert's triangle budget whenever a blast was in the air).
{
  // fx.ts sits on the engine, which reads the window at load: a bare stand-in is enough here.
  const g = globalThis as Record<string, unknown>;
  const noop = () => {};
  g.window ??= { addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, matchMedia: () => ({ matches: false, addEventListener: noop }) };
  const { Debris } = await import('../src/gfx/fx');
  const d = new Debris(7000);
  const pixels = Array.from({ length: 1500 }, (_, i) => ({ x: (i % 50) / 16, y: Math.floor(i / 50) / 16, z: 0, r: 200, g: 200, b: 200 }));
  const model = { pixels, depth: 1 } as unknown as HullModel;
  const blast = () => d.shatter(model, new THREE.Matrix4(), new THREE.Vector3(), 6, -10);
  const run = (s: number) => { for (let t = 0; t < s * 20; t++) d.update(0.05); };
  blast();
  ok(d.mesh.count > 500 && d.mesh.count < 1200, `one blast draws its own cubes, about one for two pixels (${d.mesh.count})`);
  run(1.5);
  ok(d.mesh.count <= 1200, `mid-flight it never grows (${d.mesh.count})`);
  run(4);
  ok(d.mesh.count === 0, `nothing flying, nothing drawn (${d.mesh.count})`);
  for (let k = 0; k < 10; k++) blast();
  ok(d.mesh.count === 7000, `blasts that wrap the ring draw it all while they fly (${d.mesh.count})`);
  run(5);
  blast();
  ok(d.mesh.count < 1200, `after the ring empties, the next blast starts short again (${d.mesh.count})`);
}

if (fails) { console.error(`hull: ${fails} failure(s)`); process.exit(1); }
console.log(`hull: all checks passed (${STRUCT_TYPES.length} types, worst ${worst} triangles: type ${worstId})`);
