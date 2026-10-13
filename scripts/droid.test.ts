/* Droids from PFPs (src/data/droidParts.ts, src/gfx/droid/*): every layer index has exactly one
 * family, every family combination builds a clean skinned mesh inside the triangle budget, and the
 * portrait reading matches the 2D portrait's (same seed, same face). */
import { PFP_PARTS, PFP_MAX, HEAD_FAMILIES, BODY_FAMILIES, ARMS_FAMILIES, NECK_FAMILIES, GAIT, pfpAttrs, droidSpec, rollAttrs, familyName } from '../src/data/droidParts';
import { buildDroidGeometry, frameFor, BONES } from '../src/gfx/droid/droid';

let fails = 0;
const ok = (cond: unknown, msg: string) => { if (!cond) { fails++; console.error('FAIL', msg); } };

// Every index in exactly one family.
for (const [part, table] of [['head', HEAD_FAMILIES], ['body', BODY_FAMILIES], ['arms', ARMS_FAMILIES], ['neck', NECK_FAMILIES]] as const) {
  const max = PFP_MAX[part];
  for (let i = 1; i <= max; i++) {
    const hits = (table as [string, number[]][]).filter(([, ids]) => ids.includes(i)).length;
    ok(hits === 1, `${part} ${i} is in ${hits} families (want 1)`);
  }
  const all = (table as [string, number[]][]).flatMap(([, ids]) => ids);
  ok(all.every((i) => i >= 1 && i <= max), `${part} families stay inside 1..${max}`);
}
ok(Object.keys(GAIT).length === BODY_FAMILIES.length, 'every body family has a gait');
ok(Object.values(GAIT).filter((g) => g === 'hover' || g === 'pods').length === 2, 'exactly two body families hover (Spire and Twin)');

// Reading portraits: the 2D portrait's rules.
const seeded = pfpAttrs(null, '@1-42:server');
ok(JSON.stringify(seeded) === JSON.stringify(pfpAttrs('', '@1-42:server')), 'no portrait derives the same face from the same seed');
ok(JSON.stringify(seeded) !== JSON.stringify(pfpAttrs(null, '@1-43:server')), 'different seeds give different faces');
ok(PFP_PARTS.every((p) => seeded[p] >= 1 && seeded[p] <= PFP_MAX[p]), 'seeded faces stay in range');
const clamped = pfpAttrs('{"head":999,"body":-3,"arms":"7","neck":2.6,"background":0}');
ok(clamped.head === 87 && clamped.body === 1 && clamped.arms === 7 && clamped.neck === 3 && clamped.background === 1, 'player-set values are clamped and rounded');
ok(JSON.stringify(pfpAttrs('[1,2]', 'x')) === JSON.stringify(pfpAttrs(null, 'x')), 'an array is no portrait');
ok(JSON.stringify(pfpAttrs('not json', 'x')) === JSON.stringify(pfpAttrs(null, 'x')), 'bad JSON is no portrait');
ok(familyName('head', 70) === 'Vee' && familyName('body', 9) === 'Spire' && familyName('background', 2) === 'Ember', 'family labels');

// The seeded portrait must equal dom.ts portrait()'s choice (same hash, same order).
{
  const want: Record<string, number> = {};
  let n = 2166136261;
  for (const c of 'abc') n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0;
  for (const p of PFP_PARTS) { want[p] = 1 + (n % PFP_MAX[p]); n = Math.imul(n ^ (n >>> 13), 2654435761) >>> 0; }
  ok(JSON.stringify(pfpAttrs(null, 'abc')) === JSON.stringify(want), 'seeded portrait matches the 2D portrait hash');
}

// Every family combination builds.
let worst = 0, combos = 0;
for (const [, heads] of HEAD_FAMILIES) for (const [, bodies] of BODY_FAMILIES) for (const [, arms] of ARMS_FAMILIES) for (const [, necks] of NECK_FAMILIES) {
  const spec = droidSpec({ head: heads[0], body: bodies[0], arms: arms[0], neck: necks[0], background: 1 + (combos % 6) });
  const g = buildDroidGeometry(spec);
  combos++;
  worst = Math.max(worst, g.triangles);
  const pos = g.geometry.getAttribute('position').array as Float32Array;
  const nor = g.geometry.getAttribute('normal').array as Float32Array;
  const skin = g.geometry.getAttribute('skinIndex').array as Uint16Array;
  const uv = g.geometry.getAttribute('uv').array as Float32Array;
  if (!pos.every(Number.isFinite) || !nor.every(Number.isFinite) || !uv.every(Number.isFinite)) { ok(false, `${spec.key}: non-finite attribute`); continue; }
  for (let i = 0; i < nor.length; i += 3) if (Math.abs(Math.hypot(nor[i], nor[i + 1], nor[i + 2]) - 1) > 1e-3) { ok(false, `${spec.key}: normal not unit`); break; }
  ok(skin.every((b) => b < BONES.length), `${spec.key}: bone index in range`);
  ok(g.triangles <= 1800, `${spec.key}: ${g.triangles} triangles (budget 1800)`);
  const bb = g.geometry.boundingBox!;
  ok(bb.min.y > -0.05 && bb.max.y < 2.1, `${spec.key}: stands on the floor and under 2.1 m (got ${bb.min.y.toFixed(2)}..${bb.max.y.toFixed(2)})`);
  ok(Math.abs(bb.max.x + bb.min.x) < 0.08, `${spec.key}: roughly symmetric`);
  g.geometry.dispose();
}
ok(combos === 8 * 6 * 5 * 3, `built all ${combos} family combinations`);

// Walkers' feet touch the floor; hover bodies float.
for (const g of ['heavy', 'legs', 'reverse', 'long'] as const) {
  const f = frameFor(g);
  ok(f.legs && Math.abs(f.hipY - (f.legs.foot[1] + f.legs.shin + f.legs.thigh)) < 1e-6, `${g}: hip height is the leg length`);
}
for (let i = 0; i < 50; i++) {
  const a = rollAttrs();
  ok(PFP_PARTS.every((p) => a[p] >= 1 && a[p] <= PFP_MAX[p] && Number.isInteger(a[p])), 'rolls stay in range');
}

if (fails) { console.error(`droid: ${fails} failure(s)`); process.exit(1); }
console.log(`droid: all checks passed (${combos} combinations, worst ${worst} triangles)`);
