/* The persona lab: twenty players (studio/personas.json) put the game through its five pillars
 * (stability, playability, fun, accessibility, beauty), in three lanes.
 *
 *   sim      each persona's habits fly headless battles up the ladder (sim.ts): balance and fun
 *   browser  each persona plays the real build as their machine, hands and eyes (browser.mjs)
 *   ai       a brief per persona for an AI playtester, who plays as them and writes a verdict.json
 *            that the next --score blends in (brief.mjs)
 *
 * Then: a score per persona per pillar, issues triaged across personas (the same issue for five
 * personas is one issue, ranked higher), a comparison with the saved baseline, and one report.
 *
 * usage: pnpm personas                          all twenty, sim + browser, score, report, briefs
 *        pnpm personas --quick                  six personas, 6 seeds a rung
 *        pnpm personas --only=rookie,mono       chosen personas
 *        pnpm personas --lane=sim               one lane (sim | browser); the other's last results are reused
 *        pnpm personas --score                  re-score the last run (after playtesters wrote verdicts)
 *        pnpm personas --save                   keep this run's scores as the baseline
 *        pnpm personas --no-gate                report only, exit 0
 *        pnpm personas --engine=firefox         the Firefox personas (personas.json › engines) in Firefox, compared
 *                                               with their Chrome runs: journeys, errors, frame rate, CPU, memory,
 *                                               and the web features each engine lacks; --engine=both runs both
 * env:   PERSONA_WORKERS (browsers at once, default 3), PERSONA_SEEDS (sim seeds a rung, default 16),
 *        STUDIO_URL / STUDIO_DIST as for the other studio tools.
 * Writes studio/reports/personas/ (index.html, scorecard.json, sim.json, <id>/browser.json, pictures,
 * brief.md). Exit 1 on any blocker, or a pillar more than BASELINE_DROP points under the baseline. */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, serveSite } from '../cdp.mjs';
import { playAs } from './browser.mjs';
import { compareEngines, paletteTable, scorePersona, SEV, triage } from './score.mjs';
import { scanUses } from './compat.mjs';
import { writeReport } from './report.mjs';
import { writeBriefs } from './brief.mjs';

const ROOT = new URL('../../../', import.meta.url).pathname;
const OUT = join(ROOT, 'studio/reports/personas');
const BASELINE = join(ROOT, 'studio/baseline/personas.json');
const BASELINE_DROP = 8;
const QUICK = ['rookie', 'couch-captain', 'thumb-pilot', 'tabber', 'steady', 'button-masher'];
const args = process.argv.slice(2);
const flag = (f) => args.includes('--' + f);
const opt = (f) => (args.find((a) => a.startsWith(`--${f}=`)) || '').split('=')[1];
const lab = JSON.parse(readFileSync(join(ROOT, 'studio/personas.json'), 'utf8'));
const budgets = JSON.parse(readFileSync(join(ROOT, 'studio/budgets.json'), 'utf8'));
const only = (opt('only') || '').split(',').filter(Boolean);
const unknown = only.filter((id) => !lab.personas.some((p) => p.id === id));
if (unknown.length) { console.error(`personas: no persona ${unknown.join(', ')} (have ${lab.personas.map((p) => p.id).join(', ')})`); process.exit(2); }
const engine = opt('engine') || 'chrome';
if (!['chrome', 'firefox', 'both'].includes(engine)) { console.error('personas: --engine is chrome, firefox or both'); process.exit(2); }
const FIREFOX = lab.engines?.firefox?.personas || [];
const cast = lab.personas.filter((p) => (only.length ? only.includes(p.id) : flag('quick') ? QUICK.includes(p.id) : engine === 'firefox' ? FIREFOX.includes(p.id) : true));
/** Which personas each engine plays this run: Firefox takes its own list (or exactly --only). */
const lanes = [...(engine !== 'firefox' ? [{ engine: 'chrome', cast }] : []), ...(engine !== 'chrome' ? [{ engine: 'firefox', cast: only.length ? cast : cast.filter((p) => FIREFOX.includes(p.id)) }] : [])];
const dirOf = (eng, id) => (eng === 'firefox' ? join(OUT, 'firefox', id) : join(OUT, id));
const lane = opt('lane');
const rescore = flag('score');
mkdirSync(OUT, { recursive: true });
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const t0 = Date.now();

let run = rescore ? readJson(join(OUT, 'run.json')) : null;
if (rescore && !run) { console.error('personas: no earlier run to re-score (run pnpm personas first)'); process.exit(2); }
if (!run) {
  let sha = 'local';
  try { sha = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim() + (execSync('git status --porcelain', { cwd: ROOT }).toString().trim() ? '+dirty' : ''); } catch { /* not a checkout */ }
  run = { runId: `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${sha}`, sha, at: new Date().toISOString(), personas: engine === 'firefox' ? [] : cast.map((p) => p.id), quick: flag('quick') };
  // Re-running a few personas on the same code (--only after a fix to the bots), or adding the Firefox
  // lane, joins the last run's scorecard instead of replacing it; on other code, only fresh results count.
  const prev = readJson(join(OUT, 'run.json'));
  const same = prev && prev.sha === sha;
  if (same && (only.length || engine === 'firefox')) { run.personas = [...new Set([...prev.personas, ...run.personas])]; if (engine === 'firefox') run.runId = prev.runId; }
  const ffNow = lanes.find((l) => l.engine === 'firefox')?.cast.map((p) => p.id) || [];
  run.firefox = [...new Set([...(same && (only.length || engine === 'firefox') ? prev.firefox || [] : []), ...ffNow])];
  console.log(`persona lab · run ${run.runId} · ${cast.length} personas${lane ? ' · ' + lane + ' lane only' : ''}`);

  /* ── Sim lane ── */
  if (lane !== 'browser' && engine !== 'firefox') {
    console.log('▸ sim lane: persona pilots up the ladder');
    const code = await new Promise((resolve) => {
      const p = spawn('npx', ['tsx', 'scripts/studio/personas/sim.ts'], { cwd: ROOT, stdio: 'inherit',
        env: { ...process.env, PERSONA_ONLY: cast.map((x) => x.id).join(','), ...(flag('quick') && !process.env.PERSONA_SEEDS ? { PERSONA_SEEDS: '6' } : {}) } });
      p.on('close', resolve);
    });
    run.simExit = code;
  }

  /* ── Browser lane ── */
  if (lane !== 'sim') {
    console.log('▸ browser lane: building and serving the game');
    const site = await serveSite();
    const routes = budgets.routes.map((r) => r.split('#')[0]).filter((r, i, a) => a.indexOf(r) === i);
    const workers = Math.max(1, Number(process.env.PERSONA_WORKERS) || 3);
    try {
      for (const { engine: eng, cast: who } of lanes) {
      if (lanes.length > 1 || eng !== 'chrome') console.log(`  ${eng}: ${who.length} personas`);
      await pool(who, workers, async (p) => {
        const dir = dirOf(eng, p.id);
        // This run's pictures only: an old shot next to a new report would be a lie. (A verdict stays until re-scored.)
        const verdict = readJson(join(dir, 'verdict.json'));
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        if (verdict) writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict, null, 1));
        const s = Date.now();
        console.log(`  ▸ ${p.id} (${p.view}, ${p.input}): ${p.journeys.join(', ')}`);
        // The browser process itself ending mid-run (another tool's cleanup killing headless browsers, a
        // machine under load) is infrastructure, not the game: such a persona is played once more, and
        // if it happens again it is reported as not measured rather than as a blocker.
        const gone = (r) => r && r !== 'timeout' && (/connection closed|browser gone|Firefox did not open|no page target/.test(r.error || '') || (r.journeys || []).some((j) => /connection closed|browser gone/.test(j.error || '')));
        let res;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const limit = new Promise((r) => setTimeout(() => r('timeout'), 20 * 60000));
          res = await Promise.race([playAs(p, lab, site, dir, { routes, engine: eng, log: (l) => process.env.PERSONA_VERBOSE && console.log('    ' + l) }).catch((e) => ({ error: String(e?.message || e) })), limit]);
          if (!gone(res)) break;
          const why = (res.error || (res.journeys || []).map((j) => j.error).find((e) => /connection closed|browser gone/.test(e || '')) || '').slice(0, 400);
          if (attempt === 1) console.log(`  ↻ ${p.id}${eng === 'chrome' ? '' : ' @' + eng}: the browser process ended mid-run (${why}); playing again`);
          else { writeFileSync(join(dir, 'browser.json'), JSON.stringify({ id: p.id, engine: eng, infra: `the browser process ended mid-run twice: ${why}`, journeys: [], checkpoints: [], battles: [], inputs: {}, problems: [] }, null, 1)); console.log(`  ? ${p.id}${eng === 'chrome' ? '' : ' @' + eng}: not measured (the browser process ended mid-run twice: ${why})`); return; }
        }
        if (res === 'timeout' || res?.error) {
          writeFileSync(join(dir, 'browser.json'), JSON.stringify({ id: p.id, journeys: p.journeys.map((name) => ({ name, ok: false, steps: [], error: res === 'timeout' ? 'persona timed out after 20 min' : res.error })), checkpoints: [], battles: [], inputs: {}, problems: [] }, null, 1));
          console.log(`  ✗ ${p.id}: ${res === 'timeout' ? 'timed out' : res.error}`);
          return;
        }
        const bad = res.journeys.filter((j) => !j.ok);
        console.log(`  ${bad.length ? '✗' : '✓'} ${p.id}${eng === 'chrome' ? '' : ' @' + eng} · ${Math.round((Date.now() - s) / 1000)} s · ${res.inputs.n} inputs (${res.inputs.dead} dead) · ${res.checkpoints.length} checkpoints${bad.length ? ' · failed: ' + bad.map((j) => `${j.name} (${j.steps.find((x) => !x.ok)?.name || j.error})`).join('; ') : ''}${res.problems.length ? ` · ${res.problems.length} problems` : ''}`);
      });
      }
    } finally { await site.close(); }
  }
  writeFileSync(join(OUT, 'run.json'), JSON.stringify(run, null, 1));
}

/* ── Score ── */
const sim = readJson(join(OUT, 'sim.json'));
const baseline = readJson(BASELINE);
const scored = [];
let palette = null;
for (const p of lab.personas.filter((x) => run.personas.includes(x.id))) {
  const br0 = readJson(join(OUT, p.id, 'browser.json'));
  const br = br0?.infra ? null : br0;   // not measured: the browser died under the bots twice
  const v = readJson(join(OUT, p.id, 'verdict.json'));
  const verdict = v && v.runId === run.runId ? v : null;
  if (v && !verdict) console.log(`  (${p.id}: verdict.json is for run ${v.runId}, not this one: left out)`);
  palette ||= br?.palette || null;
  scored.push(scorePersona(p, lab, br, sim?.personas?.[p.id], verdict));
}
let issues = triage(scored);
/* ── Engines: Firefox against Chrome, for the personas Firefox played ── */
let engines = null;
if (run.firefox?.length) {
  const ch = {}, ff = {};
  const unmeasured = [];
  for (const id of run.firefox) {
    ff[id] = readJson(join(dirOf('firefox', id), 'browser.json')); ch[id] = readJson(join(dirOf('chrome', id), 'browser.json'));
    if (ff[id]?.infra) unmeasured.push(id);
    if (!ff[id] || ff[id].infra) delete ff[id];
    if (ch[id]?.infra) delete ch[id];
  }
  const cmp = compareEngines(lab, ch, ff, scanUses(ROOT), (p, br) => scorePersona(p, lab, br, sim?.personas?.[p.id], null));
  engines = { firefox: { version: Object.values(ff).find((b) => b?.version)?.version || null, chrome: Object.values(ch).find((b) => b?.version)?.version || null, rows: cmp.rows, compat: cmp.compat, unsupported: [...new Set(Object.values(ff).flatMap((b) => b?.unsupported || []))], unmeasured } };
  issues = [...issues, ...cmp.issues.map((i) => ({ ...i, priority: SEV[i.sev] }))].sort((a, b) => SEV[b.sev] - SEV[a.sev] || b.priority - a.priority);
}
const pillars = Object.fromEntries(lab.pillars.map((k) => {
  const xs = scored.map((s) => s.pillars[k]).filter((x) => x != null);
  const worst = scored.filter((s) => s.pillars[k] != null).sort((a, b) => a.pillars[k] - b.pillars[k])[0];
  return [k, { mean: xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null, min: worst ? worst.pillars[k] : null, worst: worst?.id || null }];
}));
const overall = Math.round(scored.reduce((a, s) => a + (s.overall ?? 0), 0) / Math.max(1, scored.filter((s) => s.overall != null).length));
const regressions = [];
for (const s of scored) for (const k of lab.pillars) {
  const was = baseline?.personas?.[s.id]?.[k], now = s.pillars[k];
  if (was != null && now != null && was - now > BASELINE_DROP) regressions.push({ persona: s.id, pillar: k, was, now });
}
const blockers = issues.filter((i) => i.sev === 'blocker');
const card = { runId: run.runId, at: new Date().toISOString(), sha: run.sha, quick: run.quick, overall, pillars, personas: scored, issues, regressions, blockers: blockers.length,
  baselineAt: baseline?.at || null, engines, palette: paletteTable(lab, palette), sim: sim ? { seeds: sim.seeds, ladderDrift: sim.ladderDrift, errors: sim.errors } : null };
writeFileSync(join(OUT, 'scorecard.json'), JSON.stringify(card, null, 1));
writeReport(card, lab, sim, OUT);
const briefs = writeBriefs(card, lab, OUT, ROOT);
if (flag('save')) {
  mkdirSync(join(ROOT, 'studio/baseline'), { recursive: true });
  const prev = baseline?.personas || {};
  writeFileSync(BASELINE, JSON.stringify({ at: card.at, runId: run.runId, personas: { ...prev, ...Object.fromEntries(scored.map((s) => [s.id, { ...s.pillars, overall: s.overall }])) } }, null, 1));
  console.log('  baseline saved: studio/baseline/personas.json');
}

/* ── Say how it went ── */
const bar = (n) => (n == null ? '  –' : String(n).padStart(3));
console.log(`\n  ${'persona'.padEnd(18)} stab play  fun a11y beau │ all`);
for (const s of scored) console.log(`  ${s.id.padEnd(18)} ${lab.pillars.map((k) => bar(s.pillars[k])).join('  ')} │ ${bar(s.overall)}${s.verdict ? '  ✎' : ''}`);
console.log(`  ${'game (mean)'.padEnd(18)} ${lab.pillars.map((k) => bar(pillars[k].mean)).join('  ')} │ ${bar(overall)}`);
if (engines) {
  const E = engines.firefox, n = (x) => (x == null ? '–' : x);
  console.log(`\n  Chrome ${n(E.chrome)} vs Firefox ${n(E.version)}   overall    fps        CPU-s/min   peak MB    journeys`);
  for (const r of E.rows) console.log(`  ${r.id.padEnd(18)} ${String(n(r.chrome?.overall)).padStart(3)} / ${String(n(r.firefox.overall)).padEnd(4)} ${String(n(r.chrome?.fps)).padStart(4)} / ${String(n(r.firefox.fps)).padEnd(5)} ${String(n(r.chrome?.cpuPerMin)).padStart(5)} / ${String(n(r.firefox.cpuPerMin)).padEnd(5)} ${String(n(r.chrome?.peakRssMB)).padStart(5)} / ${String(n(r.firefox.peakRssMB)).padEnd(5)} ${r.firefox.ok}/${r.firefox.journeys}`);
  const lacks = E.compat.filter((c) => c.firefox === false || c.chrome === false);
  console.log(`  features the game uses that an engine lacks: ${lacks.length ? lacks.map((c) => `${c.name} (${c.chrome === false ? 'Chrome' : 'Firefox'}, ${c.uses}×)`).join(', ') : 'none'}`);
  if (E.unsupported.length) console.log(`  not measured in Firefox (no BiDi equivalent): ${E.unsupported.join(', ')}`);
  if (E.unmeasured?.length) console.log(`  not measured (the browser process died under the bots twice): ${E.unmeasured.join(', ')}`);
}
console.log(`\n  ${issues.length} issues (${blockers.length} blockers, ${issues.filter((i) => i.sev === 'major').length} major). Top fixes:`);
for (const i of issues.slice(0, 8)) console.log(`   ${i.sev.padEnd(7)} ${i.pillar.padEnd(13)} ${i.title.slice(0, 90)} · ${i.where} · ${i.personas.length} persona${i.personas.length > 1 ? 's' : ''}`);
if (regressions.length) console.log(`\n  regressions vs baseline (${baseline.at}): ` + regressions.map((r) => `${r.persona} ${r.pillar} ${r.was}→${r.now}`).join(', '));
console.log(`\n  report: studio/reports/personas/index.html · ${briefs} playtest briefs (studio/reports/personas/<id>/brief.md) · ${Math.round((Date.now() - t0) / 1000)} s`);
const fail = !flag('no-gate') && (blockers.length > 0 || regressions.length > 0 || (run.simExit ?? 0) !== 0);
console.log(fail ? `personas: ✗ ${blockers.length} blockers, ${regressions.length} regressions` : 'personas: ✓');
process.exit(fail ? 1 : 0);
