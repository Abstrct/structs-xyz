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
 * env:   PERSONA_WORKERS (browsers at once, default 3), PERSONA_SEEDS (sim seeds a rung, default 16),
 *        STUDIO_URL / STUDIO_DIST as for the other studio tools.
 * Writes studio/reports/personas/ (index.html, scorecard.json, sim.json, <id>/browser.json, pictures,
 * brief.md). Exit 1 on any blocker, or a pillar more than BASELINE_DROP points under the baseline. */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, serveSite } from '../cdp.mjs';
import { playAs } from './browser.mjs';
import { paletteTable, scorePersona, triage } from './score.mjs';
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
const cast = lab.personas.filter((p) => (only.length ? only.includes(p.id) : flag('quick') ? QUICK.includes(p.id) : true));
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
  run = { runId: `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${sha}`, sha, at: new Date().toISOString(), personas: cast.map((p) => p.id), quick: flag('quick') };
  // Re-running a few personas on the same code (--only after a fix to the bots) joins the last run's
  // scorecard instead of replacing it; on other code, only fresh results count.
  const prev = readJson(join(OUT, 'run.json'));
  if (only.length && prev && prev.sha === sha) run.personas = [...new Set([...prev.personas, ...run.personas])];
  console.log(`persona lab · run ${run.runId} · ${cast.length} personas${lane ? ' · ' + lane + ' lane only' : ''}`);

  /* ── Sim lane ── */
  if (lane !== 'browser') {
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
      await pool(cast, workers, async (p) => {
        const dir = join(OUT, p.id);
        // This run's pictures only: an old shot next to a new report would be a lie. (A verdict stays until re-scored.)
        const verdict = readJson(join(dir, 'verdict.json'));
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        if (verdict) writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict, null, 1));
        const s = Date.now();
        console.log(`  ▸ ${p.id} (${p.view}, ${p.input}): ${p.journeys.join(', ')}`);
        const limit = new Promise((r) => setTimeout(() => r('timeout'), 20 * 60000));
        const res = await Promise.race([playAs(p, lab, site, dir, { routes, log: (l) => process.env.PERSONA_VERBOSE && console.log('    ' + l) }).catch((e) => ({ error: String(e?.message || e) })), limit]);
        if (res === 'timeout' || res?.error) {
          writeFileSync(join(dir, 'browser.json'), JSON.stringify({ id: p.id, journeys: p.journeys.map((name) => ({ name, ok: false, steps: [], error: res === 'timeout' ? 'persona timed out after 20 min' : res.error })), checkpoints: [], battles: [], inputs: {}, problems: [] }, null, 1));
          console.log(`  ✗ ${p.id}: ${res === 'timeout' ? 'timed out' : res.error}`);
          return;
        }
        const bad = res.journeys.filter((j) => !j.ok);
        console.log(`  ${bad.length ? '✗' : '✓'} ${p.id} · ${Math.round((Date.now() - s) / 1000)} s · ${res.inputs.n} inputs (${res.inputs.dead} dead) · ${res.checkpoints.length} checkpoints${bad.length ? ' · failed: ' + bad.map((j) => `${j.name} (${j.steps.find((x) => !x.ok)?.name || j.error})`).join('; ') : ''}${res.problems.length ? ` · ${res.problems.length} problems` : ''}`);
      });
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
  const br = readJson(join(OUT, p.id, 'browser.json'));
  const v = readJson(join(OUT, p.id, 'verdict.json'));
  const verdict = v && v.runId === run.runId ? v : null;
  if (v && !verdict) console.log(`  (${p.id}: verdict.json is for run ${v.runId}, not this one: left out)`);
  palette ||= br?.palette || null;
  scored.push(scorePersona(p, lab, br, sim?.personas?.[p.id], verdict));
}
const issues = triage(scored);
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
  baselineAt: baseline?.at || null, palette: paletteTable(lab, palette), sim: sim ? { seeds: sim.seeds, ladderDrift: sim.ladderDrift, errors: sim.errors } : null };
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
console.log(`\n  ${issues.length} issues (${blockers.length} blockers, ${issues.filter((i) => i.sev === 'major').length} major). Top fixes:`);
for (const i of issues.slice(0, 8)) console.log(`   ${i.sev.padEnd(7)} ${i.pillar.padEnd(13)} ${i.title.slice(0, 90)} · ${i.where} · ${i.personas.length} persona${i.personas.length > 1 ? 's' : ''}`);
if (regressions.length) console.log(`\n  regressions vs baseline (${baseline.at}): ` + regressions.map((r) => `${r.persona} ${r.pillar} ${r.was}→${r.now}`).join(', '));
console.log(`\n  report: studio/reports/personas/index.html · ${briefs} playtest briefs (studio/reports/personas/<id>/brief.md) · ${Math.round((Date.now() - t0) / 1000)} s`);
const fail = !flag('no-gate') && (blockers.length > 0 || regressions.length > 0 || (run.simExit ?? 0) !== 0);
console.log(fail ? `personas: ✗ ${blockers.length} blockers, ${regressions.length} regressions` : 'personas: ✓');
process.exit(fail ? 1 : 0);
