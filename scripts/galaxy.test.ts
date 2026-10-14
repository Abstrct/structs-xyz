/* The galaxy snapshot (src/chain/galaxy.ts), offline:
 *   1. attribute ids → stores; absent is zero; LCD shapes out (flags, guards, grid);
 *   2. every GRASS patch: absolute values, the silent build-clock reset, stale frames dropped by
 *      height and by time, `value_p` only, moves re-indexed, guard links both ways, stubs ignored;
 *   3. the chain's typed events: a new struct, its attributes, planet attributes, grid;
 *   4. the walk: guild keyset paging (after_id, a short page ends it, clamped limits), the LCD
 *      fallback, frames during a walk replayed onto the new copy, and a short walk refused. */
export {};

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: () => null, length: 0 }; };
(globalThis as Record<string, unknown>).localStorage = mem();
(globalThis as Record<string, unknown>).sessionStorage = mem();

const { Snapshot, plausible, galaxy } = await import('../src/chain/galaxy');
const { parseGrass } = await import('../src/grass/grass');
const { live } = await import('../src/chain/live');
const { structsByIds, gridsFor, planetAttributeAll } = await import('../src/chain/reader');

let fails = 0;
const ok = (cond: unknown, msg: string) => { if (!cond) { fails++; console.error('FAIL', msg); } else console.log('ok  ', msg); };
const frame = (o: Record<string, unknown>) => parseGrass(String(o.subject), JSON.stringify(o))!;

/* ── 1. Stores and shapes ──────────────────────────────────────────────── */
const s = new Snapshot();
s.minHeight = 100;
s.takenAt = Date.parse('2026-10-14T00:00:00Z');
s.putStruct({ id: '5-1', type: 14, owner: '1-7', locationType: 'planet', locationId: '2-3', ambit: 'land', slot: 0 });
s.putStruct({ id: '5-2', type: 3, owner: '1-7', locationType: 'fleet', locationId: '9-7', ambit: 'space', slot: 1 });
ok(s.putAttribute('struct', '1-5-1', '7') && s.putAttribute('struct', '0-5-1', '3') && s.putAttribute('struct', '5-5-2', '1'), 'struct attributes land by their chain id');
ok(!s.putAttribute('struct', '6-1-7', '2') && !s.putAttribute('struct', 'junk', '1') && !s.putAttribute('struct', '0-5-9', 'abc'), 'typeCount (on players), junk ids and non-numbers are refused');
s.putAttribute('planet', '0-2-3', '120');
s.putAttribute('grid', '2-4-1', '5000000');
s.putAttribute('grid', '1-3-1', '123456789012345678');
let f = s.structFull('5-1')!;
ok(f.Struct.locationId === '2-3' && f.Struct.slot === '0' && f.structAttributes?.health === '3' && f.structAttributes.isBuilt && f.structAttributes.isOnline && !f.structAttributes.isDestroyed, 'a struct comes out in the LCD’s shape, flags from the status bits');
ok(JSON.stringify(f.structDefenders) === '["5-2"]' && s.structFull('5-2')!.structAttributes?.protectedStructIndex === '1', 'guard links: the guard’s protectedStructIndex, the protected struct’s defenders');
ok(s.gridOf('4-1').capacity === '5000000' && s.gridOf('4-1').load === '0' && s.gridOf('4-99').capacity === '0', 'grid values come out whole; absent is zero');
ok(s.gridOf('3-1').fuel === '123456789012345678', 'big grid values keep every digit (strings, not floats)');
ok(s.planetAttrs('2-3').planetaryShield === '120' && s.planetAttrs('2-3').blockStartRaid === '0', 'planet attributes by name');
ok(JSON.stringify(s.structsAt('2-3')) === '["5-1"]' && JSON.stringify(s.structsAt('9-7')) === '["5-2"]', 'structs are indexed by where they stand');

/* ── 2. GRASS ──────────────────────────────────────────────────────────── */
const P = (category: string, detail: Record<string, unknown>, height = 101) => frame({ subject: 'structs.planet.2-3.1-7', category, planet_id: '2-3', player_id: '1-7', block_height: height, seq: 1, detail });
ok(s.applyGrass(P('struct_health', { struct_id: '5-1', health: 2, health_old: 3 })) && s.structFull('5-1')!.structAttributes?.health === '2', 'struct_health patches');
ok(!s.applyGrass(P('struct_health', { struct_id: '5-1', health: 2, health_old: 3 })), 'replaying it changes nothing (absolute values)');
ok(!s.applyGrass(P('struct_health', { struct_id: '5-1', health: 9 }, 99)) && s.structFull('5-1')!.structAttributes?.health === '2', 'a frame from before the walk is dropped');
s.putStruct({ id: '5-3', type: 1, owner: '1-7', locationType: 'planet', locationId: '2-3', ambit: 'water', slot: 2 });
s.putAttribute('struct', '1-5-3', '1');
s.putAttribute('struct', '2-5-3', '90');
s.applyGrass(P('struct_status', { struct_id: '5-3', status: 7, status_old: 1 }));
ok(s.structFull('5-3')!.structAttributes?.isBuilt && s.structFull('5-3')!.structAttributes?.blockStartBuild === '0', 'a build completing clears its clock, as the chain does without a word');
s.applyGrass(P('struct_status', { struct_id: '5-3', status: 39, status_old: 7 }));
ok(s.structFull('5-3')!.structAttributes?.isDestroyed, 'a destroyed struct stays, flagged, until the next walk');
ok(s.applyGrass(P('struct_block_build_start', { struct_id: '5-50', block: 101 })) && s.pendingNew.has('5-50'), 'a build clock for a struct not yet known is kept, and the struct marked as wanted');
s.applyGrass(P('struct_defense_remove', { defender_struct_id: '5-2', protected_struct_id: '5-1' }));
ok(JSON.stringify(s.structFull('5-1')!.structDefenders) === '[]' && s.structFull('5-2')!.structAttributes?.protectedStructIndex === '0', 'a guard removed leaves both sides');
s.applyGrass(P('struct_defense_add', { defender_struct_id: '5-2', protected_struct_id: '5-3' }));
ok(JSON.stringify(s.structFull('5-3')!.structDefenders) === '["5-2"]', 'a guard added shows on the protected struct');
s.applyGrass(P('struct_move', { struct_id: '5-2', location_type: 'planet', location_id: '2-3', ambit: 'air', slot: 3 }));
ok(s.structsAt('9-7').length === 0 && s.structsAt('2-3').includes('5-2') && s.structFull('5-2')!.Struct.operatingAmbit === 'air', 'a move re-indexes the struct');
s.applyGrass(P('shield_change', { planetary_shield: 140, planetary_shield_old: 120 }));
s.applyGrass(P('block_raid_start', { block_start_raid: 98 }, 102));
ok(s.planetAttrs('2-3').planetaryShield === '140' && s.planetAttrs('2-3').blockStartRaid === '98', 'shield and raid clock (the clock from the frame, not its height)');
s.applyGrass(P('struct_block_ore_mine_start', { block: 101, planet_id: '2-3' }));
ok(s.planetAttrs('2-3').blockStartOreMine === '101', 'the planet’s mining clock');
const G = (o: Record<string, unknown>) => frame({ subject: 'structs.grid.substation.4-1', category: 'load', object_id: '4-1', object_type: 'substation', attribute_type: 'load', updated_at: '2026-10-14T00:05:00Z', ...o });
ok(s.applyGrass(G({ value_p: 2500000, value: 2500 })) && s.gridOf('4-1').load === '2500000', 'a grid frame patches its chain-precision value');
ok(!s.applyGrass(G({ value: 3000 })) && s.gridOf('4-1').load === '2500000', 'never the display figure');
ok(!s.applyGrass(G({ value_p: 1, updated_at: '2026-10-13T23:59:00Z' })) && s.gridOf('4-1').load === '2500000', 'a grid frame stamped before the walk is dropped');
ok(!s.applyGrass(frame({ subject: 'structs.planet.2-3.1-7', category: 'struct_health', planet_id: '2-3', stub: 'true' })), 'a stub patches nothing');

/* ── 3. The chain's own events ─────────────────────────────────────────── */
const tx = (height: number, events: { type: string; data: Record<string, unknown> }[]) => ({ height, hash: 'h', time: 0, events: events.map((e) => ({ ...e, attributes: {} })) }) as never;
ok(s.applyChain(tx(103, [
  { type: 'EventStruct', data: { structure: { id: '5-50', type: '7', owner: '1-7', locationType: 'fleet', locationId: '9-7', operatingAmbit: 'space', slot: '0' } } },
  { type: 'EventStructAttribute', data: { structAttributeRecord: { attributeId: '3-5-1', value: '102' } } },
  { type: 'EventPlanetAttribute', data: { planetAttributeRecord: { attributeId: '13-2-3', value: '102' } } },
  { type: 'EventGrid', data: { gridRecord: { attributeId: '0-1-7', value: '42' } } },
])), 'a transaction’s typed events apply');
ok(s.structs.has('5-50') && !s.pendingNew.has('5-50') && s.structsAt('9-7').includes('5-50') && s.structFull('5-50')!.structAttributes?.blockStartBuild === '101', 'a new struct arrives whole, and keeps the clock GRASS gave it first');
ok((s.structFull('5-1')!.structAttributes as Record<string, unknown>).blockStartOreMine === '102' && s.planetAttrs('2-3').blockStartOreRefine === '102' && s.gridOf('1-7').ore === '42', 'mining clocks (which GRASS never sends), planet attributes and grid');
ok(!s.applyChain(tx(50, [{ type: 'EventGrid', data: { gridRecord: { attributeId: '0-1-7', value: '1' } } }])) && s.gridOf('1-7').ore === '42', 'a transaction from before the walk is dropped');

/* ── 4. The walk ───────────────────────────────────────────────────────── */
const small = new Snapshot();
small.putStruct({ id: '5-1', type: 1, owner: '', locationType: '', locationId: '', ambit: '', slot: 0 });
small.putAttribute('struct', '0-5-1', '1'); small.putAttribute('planet', '0-2-1', '1'); small.putAttribute('grid', '0-1-1', '1');
const big = new Snapshot();
for (let i = 1; i <= 10; i++) { big.putStruct({ id: '5-' + i, type: 1, owner: '', locationType: '', locationId: '', ambit: '', slot: 0 }); big.putAttribute('struct', `0-5-${i}`, '1'); big.putAttribute('planet', `0-2-${i}`, '1'); big.putAttribute('grid', `0-1-${i}`, '1'); }
ok(plausible(big, small) && !plausible(small, big) && !plausible(new Snapshot(), null), 'a walk far smaller than the last (or empty) is refused');

// The LCD fallback, against a mocked LCD (no session here): pages by key; frames during the walk replay.
const LCD = 'https://public.testnet.structs.network/structs/';
const lcdPages: Record<string, Record<string, unknown>[]> = {
  struct: [{ Struct: [{ id: '5-1', type: '2', owner: '1-1', locationType: 'planet', locationId: '2-1', operatingAmbit: 'land', slot: '0' }], pagination: { next_key: 'NS0y' } }, { Struct: [{ id: '5-2', type: '2', owner: '1-1', locationType: 'planet', locationId: '2-1', operatingAmbit: 'land', slot: '1' }], pagination: { next_key: null } }],
  struct_attribute: [{ structAttributeRecords: [{ attributeId: '0-5-1', value: '3' }, { attributeId: '1-5-1', value: '7' }], pagination: {} }],
  planet_attribute: [{ planetAttributeRecords: [{ attributeId: '0-2-1', value: '50' }], pagination: {} }],
  grid: [{ gridRecords: [{ attributeId: '0-1-1', value: '9' }], pagination: {} }],
};
const seen: string[] = [];
let release: () => void = () => {};
const gate = new Promise<void>((r) => { release = r; });
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  seen.push(url);
  if (url.startsWith(LCD)) {
    const [store, q] = url.slice(LCD.length).split('?');
    if (store === 'grid') await gate;      // hold the walk open while a frame arrives
    const key = new URLSearchParams(q).get('pagination.key');
    const pages = lcdPages[store] || [];
    const page = store === 'struct' && key === 'NS0y' ? pages[1] : pages[0];
    return new Response(JSON.stringify(page || {}), { status: 200 });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;
live.state = 'live';
live.height = 200;
ok(galaxy.want() === null, 'the first ask starts the walk and answers null (callers read as before meanwhile)');
await new Promise((r) => setTimeout(r, 20));
// Mid-walk: a struct's health changes on the live feed.
(galaxy as unknown as { feed: (f: unknown) => void }).feed({ kind: 'chain', at: Date.now(), tx: tx(201, [{ type: 'EventStructAttribute', data: { structAttributeRecord: { attributeId: '0-5-1', value: '1' } } }]) });
release();
await galaxy.refresh();
const snap = galaxy.want();
ok(!!snap && snap.source === 'lcd' && snap.structs.size === 2 && snap.structFull('5-2')?.Struct.slot === '1', 'without a session the LCD’s stores are walked, page by page');
ok(seen.some((u) => u.includes('struct_attribute?') && u.includes('pagination.key=' + encodeURIComponent(btoa('0-')))), 'the attribute store is entered at "0-"');
ok(snap?.structFull('5-1')?.structAttributes?.health === '1', 'a change that landed during the walk is replayed onto the new copy');
const viaReader = await structsByIds(['5-1', '5-2'], ['1-1']);
ok(viaReader.size === 2 && !seen.some((u) => u.includes('/structs/struct/')), 'the reader answers from the snapshot, without a read per struct');
const grids = await gridsFor('player', ['1-1', '1-2'], ['ore']);
ok(grids?.get('1-1')?.ore === '9' && grids?.get('1-2')?.ore === '0', 'and grids, zero-filled');
ok((await planetAttributeAll('planetaryShield'))?.get('2-1') === '50', 'and planet attributes across the galaxy');
live.state = 'down';
ok(galaxy.want() === null, 'with no live feed patching it, it isn’t trusted');

// The guild walk: keyset paging, a short page ends it, a clamped limit doesn't end it early.
const { GuildApi } = await import('../src/guild/api');
const calls: string[] = [];
const fakeApi = { call: async (path: string) => {
  calls.push(path);
  const after = new URLSearchParams(path.split('?')[1]).get('after_id');
  // The server clamps to 2 rows a page; 5 rows in all.
  const all = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, val: '1' }));
  const from = after ? all.findIndex((r) => r.id === after) + 1 : 0;
  return { success: true, errors: [], data: all.slice(from, from + 2) };
} } as unknown as InstanceType<typeof GuildApi>;
const got: string[] = [];
const { __walkGuild } = await import('../src/chain/galaxy') as unknown as { __walkGuild: (api: unknown, path: string, on: (rows: { id: string }[]) => void) => Promise<void> };
await __walkGuild(fakeApi, 'grid/all', (rows) => got.push(...rows.map((r) => r.id)));
ok(got.join('') === 'abcde' && calls.length === 3 && calls[1].includes('after_id=b') && calls.every((c) => c.startsWith('grid/all/page/1?')), 'the guild walk pages by cursor and reads past a clamped page size: ' + calls.length + ' calls');

// A cursor row deleted between pages (a value that dropped to zero): the walk steps back and carries on.
{
  const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, val: '1' }));
  const live2: string[] = [];
  const api = { call: async (path: string) => {
    const after = new URLSearchParams(path.split('?')[1]).get('after_id');
    // 'b' is deleted once page one is out: asking after it finds nothing (the server's subquery is NULL).
    if (after === 'b') return { success: true, errors: [], data: [] };
    const from = after ? rows.findIndex((r) => r.id === after) + 1 : 0;
    return { success: true, errors: [], data: rows.slice(from, from + 2), total: 6 };
  } };
  await __walkGuild(api, 'grid/all', (r) => live2.push(...r.map((x) => x.id)));
  ok(['c', 'd', 'e', 'f'].every((x) => live2.includes(x)), 'a deleted cursor row doesn’t end the walk early: ' + live2.join(''));
  // A walk that stops far short of the server's own count is refused.
  const short = { call: async (path: string) => ({ success: true, errors: [], data: new URLSearchParams(path.split('?')[1]).get('after_id') ? [] : rows.slice(0, 2), total: 50 }) };
  const err = await __walkGuild(short, 'grid/all', () => {}).then(() => null, (e: Error) => e);
  ok(err && /short/.test(err.message), 'a walk far short of the server’s count is refused: ' + err?.message);
}

// GRASS: a number past 2^53 is left to the chain's event; a struct's own mining clock patches.
{
  const t = new Snapshot();
  t.putStruct({ id: '5-1', type: 1, owner: '1-1', locationType: 'planet', locationId: '2-1', ambit: 'land', slot: 0 });
  ok(!t.applyGrass(frame({ subject: 'structs.grid.reactor.3-1', category: 'fuel', object_id: '3-1', attribute_type: 'fuel', value_p: 2 ** 60 })) && t.gridOf('3-1').fuel === '0', 'a grid value JSON can’t hold exactly is left to the chain’s event');
  t.applyGrass(frame({ subject: 'structs.planet.2-1.1-1', category: 'struct_block_ore_mine_start', planet_id: '2-1', detail: { struct_id: '5-1', block: 77 } }));
  ok((t.structFull('5-1')!.structAttributes as Record<string, unknown>).blockStartOreMine === '77', 'a struct’s mining clock from GRASS');
}

// A drop in the chain feed distrusts the copy; failed walks back off.
{
  const g = galaxy as unknown as { stateListeners?: unknown; broken: boolean; failures: number; nextTry: number; snap: unknown };
  live.state = 'live';
  const fire = (st: string) => { for (const f of (live as unknown as { stateL: Set<(s: string) => void> }).stateL) f(st); };
  fire('down');
  live.state = 'down';
  ok(g.broken && galaxy.want() === null, 'a dropped chain feed distrusts the snapshot (nothing replays the gap)');
  live.state = 'live';
  ok(galaxy.want() === null, 'and coming back doesn’t trust it again until it has walked');
  // Make every walk fail: the next may not start at once.
  globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
  g.snap = null;
  await galaxy.refresh();
  const after = g.nextTry - Date.now();
  let started = false;
  const orig = galaxy.refresh.bind(galaxy);
  (galaxy as unknown as { refresh: () => Promise<void> }).refresh = () => { started = true; return orig(); };
  galaxy.want();
  ok(galaxy.error && after > 20_000 && !started, 'a failed walk backs off instead of walking again on the next ask: ' + galaxy.error);
}

if (fails) { console.error(`galaxy: ${fails} failure(s)`); process.exit(1); }
console.log('galaxy: all checks passed');
process.exit(0);
