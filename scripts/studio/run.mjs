/* The studio pipeline: every gate a build passes before it ships, in order, with one report.
 *
 *   lint      typecheck the game and the tools (tsc)
 *   unit      the rules, wallet, chain, economy and learning suites (pnpm test)
 *   parity    the combat port against the original simulator (pnpm test:parity)
 *   soak      hundreds of seeded AI-vs-AI battles: invariants, determinism, balance
 *   build     a production build, with the bundle measured against studio/budgets.json
 *   cert      every screen at TV, desktop and phone: words, text size, targets, frame rate, GPU cost
 *   playtest  a bot with a virtual controller plays from the title to a finished battle
 *   padtour   the same bot reaches every hub tile with the d-pad, A and Back only
 *   smoke     (--smoke) the full online/offline/recovery check against the live testnet
 *
 * usage: pnpm studio                full run (smoke excluded: it needs the testnet and ~4 min)
 *        pnpm studio --quick        lint, unit, a short soak, a desktop-only cert, playtest
 *        pnpm studio --only=cert,playtest
 *        pnpm studio --smoke        include the smoke test
 * Writes studio/reports/index.html (and the stage reports beside it); exits 1 if any gate fails. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = new URL('../../', import.meta.url).pathname;
const REPORTS = join(ROOT, 'studio/reports');
mkdirSync(REPORTS, { recursive: true });
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const BUDGETS = JSON.parse(readFileSync(join(ROOT, 'studio/budgets.json'), 'utf8'));
const dist = mkdtempSync(join(tmpdir(), 'structs-studio-build-'));

/** Run a command, streaming its last lines; resolves with its exit code and output tail. */
function sh(cmd, argv, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (d) => { out += d; process.stdout.write(d.toString().split('\n').filter(Boolean).map((l) => '    ' + l).join('\n') + '\n'); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('close', (code) => resolve({ code: code ?? 1, tail: out.split('\n').filter(Boolean).slice(-8).join('\n') }));
  });
}

async function bundle() {
  const r = await sh('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn']);
  if (r.code) return r;
  // What a first visit downloads: the entry chunk and its CSS (screens load on demand).
  const assets = join(dist, 'assets');
  const files = readdirSync(assets).map((f) => ({ f, bytes: statSync(join(assets, f)).size, gz: gzipSync(readFileSync(join(assets, f))).length }));
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const entry = files.filter((x) => html.includes(x.f));
  const kb = (n) => Math.round(n / 1024);
  const entryGz = entry.reduce((a, x) => a + x.gz, 0), totalGz = files.reduce((a, x) => a + x.gz, 0);
  const b = BUDGETS.bundle || {};
  const over = [entryGz > (b.entryGzKB ?? Infinity) * 1024 ? `entry ${kb(entryGz)} KB gz > ${b.entryGzKB}` : '', totalGz > (b.totalGzKB ?? Infinity) * 1024 ? `all ${kb(totalGz)} KB gz > ${b.totalGzKB}` : ''].filter(Boolean);
  const biggest = files.sort((a, z) => z.gz - a.gz).slice(0, 5).map((x) => `${x.f} ${kb(x.gz)} KB`).join(', ');
  return { code: over.length ? 1 : 0, tail: `entry ${kb(entryGz)} KB gz · all ${kb(totalGz)} KB gz · biggest: ${biggest}${over.length ? '\nover budget: ' + over.join('; ') : ''}` };
}

const STAGES = [
  { id: 'lint', run: () => sh('npx', ['tsc', '--noEmit']).then(async (r) => r.code ? r : sh('npx', ['tsc', '--noEmit', '-p', 'scripts'])) },
  { id: 'unit', run: () => sh('pnpm', ['-s', 'test']) },
  { id: 'parity', skipQuick: true, run: () => sh('pnpm', ['-s', 'test:parity']) },
  { id: 'soak', run: () => sh('npx', ['tsx', 'scripts/studio/soak.test.ts'], quick ? { SOAK_N: '100' } : {}) },
  { id: 'build', run: bundle },
  { id: 'cert', run: () => sh('node', ['scripts/studio/cert.mjs'], { STUDIO_DIST: dist, ...(quick ? { STUDIO_VIEWS: 'desktop' } : {}) }) },
  // The golden path at every size a player brings: the desktop, the console's 640×480, a phone.
  { id: 'playtest', run: async () => {
    const views = quick ? ['desktop'] : ['desktop', 'tv', 'phone'];
    const runs = [];
    for (const v of views) runs.push(await sh('node', ['scripts/studio/playtest.mjs'], { STUDIO_DIST: dist, STUDIO_VIEW: v }));
    return { code: runs.some((r) => r.code) ? 1 : 0, tail: runs.map((r) => r.tail.split('\n').pop()).join('\n') };
  } },
  // A controller reaches every screen: d-pad, A and Back only, from the title to each hub tile.
  { id: 'padtour', skipQuick: true, run: () => sh('node', ['scripts/studio/padtour.mjs'], { STUDIO_DIST: dist }) },
  { id: 'smoke', optIn: true, run: () => sh('node', ['scripts/smoke.mjs']) },
  // Opt-in, local: the desktop and TV frames haven't moved since the saved baseline (layout.mjs --save).
  // Not in CI: a Linux runner's fonts measure differently from the machine that saved it.
  { id: 'layout', optIn: true, run: async () => {
    const d = await sh('node', ['scripts/studio/layout.mjs'], { STUDIO_DIST: dist, STUDIO_VIEW: 'desktop' });
    return d.code ? d : sh('node', ['scripts/studio/layout.mjs'], { STUDIO_DIST: dist, STUDIO_VIEW: 'tv' });
  } },
];

const results = [];
const t0 = Date.now();
for (const st of STAGES) {
  if (only.length ? !only.includes(st.id) : (st.optIn && !args.includes('--' + st.id)) || (quick && st.skipQuick)) continue;
  // Stages that serve the build need it, even when --only skips the build stage itself.
  if (['cert', 'playtest', 'padtour'].includes(st.id) && !existsSync(join(dist, 'index.html'))) {
    console.log('▸ build (needed by ' + st.id + ')');
    const b = await bundle();
    if (b.code) { results.push({ id: 'build', ok: false, s: 0, tail: b.tail }); break; }
  }
  console.log(`▸ ${st.id}`);
  const s0 = Date.now();
  const r = await st.run();
  const res = { id: st.id, ok: r.code === 0, s: Math.round((Date.now() - s0) / 1000), tail: r.tail };
  results.push(res);
  console.log(`${res.ok ? '✓' : '✗'} ${st.id} (${res.s} s)` + (st.id === 'build' || !res.ok ? '\n    ' + res.tail.split('\n').join('\n    ') : ''));
}
rmSync(dist, { recursive: true, force: true });

const read = (f) => { try { return JSON.parse(readFileSync(join(REPORTS, f), 'utf8')); } catch { return null; } };
// Only this run's stages speak: a report left by an earlier run is not today's result.
const ran = new Set(results.filter((r) => r.ok || r.id !== 'build').map((r) => r.id));
const cert = ran.has('cert') ? read('cert/report.json') : null, soak = ran.has('soak') ? read('soak.json') : null, play = ran.has('playtest') ? read('playtest.json') : null;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const failed = results.filter((r) => !r.ok);
writeFileSync(join(REPORTS, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio pipeline</title>
<style>
:root{--bg:#0B1240;--card:#16297F;--ink:#fff;--dim:#C9D6FF;--ok:#2DB34A;--fail:#FF3D5A;--accent:#FF6A13}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif;padding:24px;max-width:1100px}
h1{font:italic 900 40px/1 system-ui;margin:0 0 4px}.dim{color:var(--dim)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin:20px 0}
.card{background:var(--card);border-radius:18px;padding:14px 16px;border:3px solid transparent}.card.ok{border-color:var(--ok)}.card.fail{border-color:var(--fail)}
.card b{font:italic 900 22px system-ui;display:block}pre{white-space:pre-wrap;font-size:12px;color:var(--dim);margin:8px 0 0;max-height:160px;overflow:auto}
.big{font:italic 900 48px/1 system-ui}.row{display:flex;gap:28px;flex-wrap:wrap;margin:16px 0}a{color:#FFB27A}
</style>
<h1>STUDIO</h1>
<div class="dim">${failed.length ? `${failed.length} gate${failed.length > 1 ? 's' : ''} failed` : 'All gates passed'} · ${Math.round((Date.now() - t0) / 1000)} s · ${new Date().toISOString()}${quick ? ' · quick' : ''}</div>
<div class="row">
${cert ? `<div><div class="big">${cert.summary.words}</div><div class="dim">words on desktop screens${cert.summary.wordsBefore != null ? ` (was ${cert.summary.wordsBefore})` : ''}</div></div>` : ''}
${soak ? `<div><div class="big">${soak.totals.battles}</div><div class="dim">soak battles · ${soak.totals.failures} failures</div></div>` : ''}
${play ? `<div><div class="big">${play.firstShotSeconds ?? '–'} s</div><div class="dim">to the first shot · ${play.inputsToStart ?? '–'} inputs to start · ${esc(play.result || 'no result')}</div></div>` : ''}
</div>
<div class="grid">${results.map((r) => `<div class="card ${r.ok ? 'ok' : 'fail'}"><b>${r.ok ? '✓' : '✗'} ${r.id}</b><span class="dim">${r.s} s</span><pre>${esc(r.tail)}</pre></div>`).join('')}</div>
${play ? `<div class="grid">${['', '-tv', '-phone'].flatMap((t) => [`playtest-battle${t}.jpg`, `playtest-debrief${t}.jpg`]).filter((f) => existsSync(join(REPORTS, f))).map((f) => `<img src="${f}" alt="${f}" style="width:100%;border-radius:14px">`).join('')}</div>` : ''}
<p><a href="cert/index.html">Cert contact sheet</a> · <a href="soak.json">soak.json</a> · <a href="playtest.json">playtest.json</a></p>`);
console.log(`\nstudio: ${failed.length ? '✗ ' + failed.map((r) => r.id).join(', ') + ' failed' : '✓ all gates passed'} · ${Math.round((Date.now() - t0) / 1000)} s · studio/reports/index.html`);
process.exit(failed.length ? 1 : 0);
