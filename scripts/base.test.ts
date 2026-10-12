/* The base path (src/core/base.ts): the site at a domain's root, or under /<repo>/ as a GitHub
 * project page. Routes stay '/codex/5' in the code; links, the URL bar and files carry the base. */
import { makeBase } from '../src/core/base';

let fails = 0;
const ok = (cond: unknown, msg: string) => { if (!cond) { fails++; console.error('FAIL', msg); } };

const root = makeBase('/');
ok(root.base === '/' && makeBase(undefined).base === '/' && makeBase('').base === '/', 'no base is the root');
ok(root.withBase('/codex/5') === '/codex/5' && root.stripBase('/codex/5') === '/codex/5' && root.asset('/img/a.webp') === '/img/a.webp', 'at the root nothing changes');

for (const raw of ['/structs-xyz/', 'structs-xyz', '/structs-xyz', '//structs-xyz//']) ok(makeBase(raw).base === '/structs-xyz/', `"${raw}" normalises to /structs-xyz/`);
const b = makeBase('/structs-xyz/');
ok(b.withBase('/codex/5') === '/structs-xyz/codex/5', 'a route goes under the base');
ok(b.withBase('/') === '/structs-xyz/', 'the home route is the base itself');
ok(b.withBase('/structs-xyz/codex/5') === '/structs-xyz/codex/5' && b.withBase(b.withBase('/sim')) === '/structs-xyz/sim', 'adding the base twice is harmless (h() may see an already-based URL)');
ok(b.stripBase('/structs-xyz/codex/5') === '/codex/5' && b.stripBase('/structs-xyz/') === '/' && b.stripBase('/structs-xyz') === '/', 'a URL path comes back as its route');
ok(b.stripBase('/elsewhere') === '/elsewhere' && b.stripBase('/structs-xyzzy/x') === '/structs-xyzzy/x', 'paths outside the base pass through (no prefix match on a longer name)');
ok(b.asset('/sound/alpha.mp3') === '/structs-xyz/sound/alpha.mp3' && b.asset('sw.js') === '/structs-xyz/sw.js', 'files live under the base');
for (const r of ['/', '/galaxy', '/codex/5', '/combat/ABC/e', '/sim/R1-xyz']) ok(b.stripBase(b.withBase(r)) === r, `round trip ${r}`);
ok(makeBase('/a/b/').withBase('/x') === '/a/b/x', 'a nested base works too');

if (fails) { console.error(`base: ${fails} failure(s)`); process.exit(1); }
console.log('base: all checks passed');
