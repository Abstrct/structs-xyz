/* Persona lab report: studio/reports/personas/index.html. The page opens on the five pillar scores, then
 * shows a persona × pillar matrix (each cell is a number on a band colour, so nothing depends on hue
 * alone), the top fixes, the fun lab (ladder win rates per pilot) and the palette as each colour-vision
 * type sees it. Last come the twenty persona cards: who they are, each journey step by step, why each
 * pillar scored what it did, their checkpoint pictures and the playtester's line. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const band = (n) => (n == null ? 'na' : n >= 85 ? 'great' : n >= 70 ? 'good' : n >= 50 ? 'meh' : 'bad');
const pc = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
const NAMES = { stability: 'Stability', playability: 'Playability', fun: 'Fun', accessibility: 'Access', beauty: 'Beauty' };

export function writeReport(card, lab, sim, out) {
  const P = lab.pillars;
  const byId = Object.fromEntries(lab.personas.map((p) => [p.id, p]));
  const baseline = (id, k) => card.regressions.find((r) => r.persona === id && r.pillar === k);
  const cell = (n, id, k) => `<td class="c ${band(n)}"${baseline(id, k) ? ` title="was ${baseline(id, k).was}"` : ''}>${n ?? '–'}${baseline(id, k) ? '<i>▼</i>' : ''}</td>`;

  const matrix = `<table class="matrix"><thead><tr><th>Persona</th>${P.map((k) => `<th>${NAMES[k]}</th>`).join('')}<th>All</th></tr></thead><tbody>
${card.personas.map((s) => `<tr><th><a href="#p-${s.id}">${esc(s.handle)}</a><small>${esc(byId[s.id].view)} · ${esc(byId[s.id].input)}</small></th>${P.map((k) => cell(s.pillars[k], s.id, k)).join('')}<td class="c all ${band(s.overall)}">${s.overall ?? '–'}</td></tr>`).join('\n')}
<tr class="mean"><th>Game</th>${P.map((k) => `<td class="c ${band(card.pillars[k].mean)}">${card.pillars[k].mean ?? '–'}</td>`).join('')}<td class="c all ${band(card.overall)}">${card.overall}</td></tr></tbody></table>`;

  const issues = card.issues.slice(0, 40).map((i) => `<li class="issue ${i.sev}"><span class="sev">${i.sev}</span><b>${esc(i.title)}</b>
    <span class="meta">${esc(NAMES[i.pillar] || i.pillar)} · ${esc(i.where)} · ${i.personas.map((id) => `<a href="#p-${id}">${esc(byId[id]?.handle || id)}</a>`).join(', ')}</span>${i.detail ? `<span class="detail">${esc(i.detail)}</span>` : ''}</li>`).join('');

  let funLab = '';
  if (sim?.personas) {
    const pilots = card.personas.filter((s) => sim.personas[s.id]);
    const rows = lab.ladder.rungs.map((r, i) => `<tr><th>${i + 1}. ${r.preset} / ${r.difficulty}</th>${pilots.map((s) => { const x = sim.personas[s.id].byRung?.[i]; return x ? `<td class="c ${x.win >= byId[s.id].pilot.band[0] && x.win <= byId[s.id].pilot.band[1] ? 'great' : 'meh'}${byId[s.id].pilot.home === i ? ' home' : ''}">${pc(x.win)}</td>` : '<td class="c na"></td>'; }).join('')}</tr>`).join('');
    const home = pilots.map((s) => { const h = sim.personas[s.id].home; return h ? `<tr><th>${esc(s.handle)}</th><td>${h.preset}/${h.difficulty}</td><td>${pc(h.win)}</td><td>${byId[s.id].pilot.band.map((x) => Math.round(x * 100)).join('–')}%</td><td>${h.minutes}</td><td>${h.deadAirS} s</td><td>${pc(h.tension)}</td><td>${pc(h.comebacks)}</td><td>${pc(h.agency)}</td><td>${h.variety}</td><td>${h.killsPerMin}</td></tr>` : ''; }).join('');
    funLab = `<h2>Fun lab</h2><p class="dim">Each persona's pilot: their reaction, read of the board, habits and fumbles, over ${sim.seeds} seeded fights a rung. A cell is that pilot's win rate; inside their band reads as good; their home rung is outlined.${sim.ladderDrift ? ` <b class="warn">${esc(sim.ladderDrift)}</b>` : ''}</p>
<div class="scroll"><table class="matrix ladder"><thead><tr><th>Rung</th>${pilots.map((s) => `<th>${esc(s.handle)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
<div class="scroll"><table class="plain"><thead><tr><th>Home rung</th><th></th><th>Win</th><th>Band</th><th>Min</th><th>Dead air</th><th>Tension</th><th>Comebacks</th><th>Agency</th><th>Variety</th><th>Kills/min</th></tr></thead><tbody>${home}</tbody></table></div>`;
  }

  const palette = card.palette ? `<h2>Colour pairs to every eye</h2><p class="dim">CIEDE2000 between each pair as that colour-vision type sees it (Machado 2009). Under ${lab.palettePairs.minDeltaE} the pair is told apart by little but hue.</p>
<div class="scroll"><table class="plain"><thead><tr><th>Pair</th><th></th>${Object.keys(card.palette[0].dE).map((t) => `<th>${t}</th>`).join('')}</tr></thead><tbody>
${card.palette.map((r) => `<tr><th>${esc(r.what)}${r.labelled ? ' <small>(labelled)</small>' : ''}</th><td><span class="sw" style="background:${esc(r.a)}"></span><span class="sw" style="background:${esc(r.b)}"></span></td>${Object.values(r.dE).map((d) => `<td class="c ${d == null ? 'na' : d >= lab.palettePairs.minDeltaE * 2 ? 'great' : d >= lab.palettePairs.minDeltaE ? 'good' : 'bad'}">${d ?? '–'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';

  const cards = card.personas.map((s) => {
    const p = byId[s.id];
    let br = null;
    try { br = JSON.parse(readFileSync(join(out, s.id, 'browser.json'), 'utf8')); } catch { /* no browser lane */ }
    const journeys = (br?.journeys || []).map((j) => `<div class="journey ${j.ok ? 'ok' : 'fail'}"><b>${j.ok ? '✓' : '✗'} ${esc(j.name)}</b> <span class="dim">${j.seconds ?? '–'} s${j.error ? ' · ' + esc(j.error) : ''}</span><ol>${j.steps.map((st) => `<li class="${st.ok ? '' : 'bad'}">${st.ok ? '✓' : '✗'} ${esc(st.name)} <span class="dim">${st.s} s${st.seconds != null ? ` · ${st.seconds} s` : ''}${st.inputs != null ? ` · ${st.inputs} inputs` : ''}${st.result ? ' · ' + esc(st.result) : ''}</span></li>`).join('')}</ol></div>`).join('');
    const reasons = P.map((k) => `<div class="why"><span class="c ${band(s.pillars[k])}">${s.pillars[k] ?? '–'}</span><b>${NAMES[k]}</b> ${s.reasons[k]?.length ? esc(s.reasons[k].join(' · ')) : '<span class="dim">nothing off</span>'}</div>`).join('');
    const shots = (br?.checkpoints || []).filter((c) => c.shot).map((c) => `<a href="${esc(s.id + '/' + c.shot)}"><img loading="lazy" src="${esc(s.id + '/' + c.shot)}" alt="${esc(c.name + ' ' + (c.route || c.tile || ''))}"><span>${esc(c.name)}${c.route ? ' ' + esc(c.route) : c.tile ? ' ' + esc(c.tile) : ''}</span></a>`).join('');
    const inp = br?.inputs;
    const facts = br ? [`${inp?.n ?? 0} inputs, ${inp?.dead ?? 0} dead, ${inp?.rage ?? 0} rage`, br.inputsToStart != null ? `${br.inputsToStart} to a fight` : '', br.boot != null ? `title in ${br.boot} s` : '', (br.battles || []).length ? `${br.battles.length} fights: ${br.battles.map((x) => `${esc(x.result || x.phase)} ${x.seconds} s`).join(', ')}` : '', br.live ? `${br.live.changes} live announcements` : ''].filter(Boolean).join(' · ') : 'browser lane not run';
    return `<section class="persona" id="p-${s.id}"><header><h3>${esc(s.handle)} <span class="c all ${band(s.overall)}">${s.overall ?? '–'}</span></h3>
<p>${esc(p.who)}</p><p class="dim">${esc(p.view)} · ${esc(p.input)}${p.network ? ' · ' + esc(p.network) : ''}${p.gl ? ' · ' + esc(p.gl) + ' GL' : ''}${p.cpuThrottle ? ` · CPU ÷${p.cpuThrottle}` : ''}${p.media?.vision ? ' · ' + esc(p.media.vision) : ''}${p.media?.reducedMotion ? ' · reduced motion' : ''}${Object.keys(p.settings || {}).length ? ' · settings ' + esc(JSON.stringify(p.settings)) : ''} · cares about: ${esc(p.cares.join(', '))}</p>
${s.verdict ? `<blockquote>“${esc(s.verdict.quote)}” <span class="dim">— AI playtester as ${esc(s.handle)}</span></blockquote>` : ''}</header>
<p class="dim">${facts}</p>${reasons}<div class="journeys">${journeys}</div><div class="shots">${shots}</div></section>`;
  }).join('\n');

  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Persona Lab</title>
<style>
:root{--bg:#0B1240;--card:#16297F;--deep:#070B2C;--ink:#fff;--dim:#C9D6FF;--accent:#FF6A13;--great:#1F8F3A;--good:#3E7C99;--meh:#A8721A;--bad:#B3263E;--na:#2A356E}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif;padding:24px 16px;max-width:1280px;margin:auto}
h1{font:italic 900 44px/1 system-ui;margin:0 0 6px}h2{font:italic 900 26px system-ui;margin:36px 0 8px}h3{font:italic 900 22px system-ui;margin:0;display:flex;gap:10px;align-items:center}
a{color:#FFB27A}.dim{color:var(--dim)}.warn{color:#FFD27A}small{display:block;color:var(--dim);font-weight:400;font-size:11px}
.pillars{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
.pill{background:var(--card);border-radius:18px;padding:12px 16px}.pill b{display:block;font:italic 900 42px/1 system-ui}.pill span{color:var(--dim);font-size:13px}
.gate{display:inline-block;padding:4px 12px;border-radius:999px;font-weight:700}.gate.ok{background:var(--great)}.gate.fail{background:var(--bad)}
.scroll{overflow-x:auto}table{border-collapse:separate;border-spacing:3px;width:100%}th{text-align:left;font-weight:600;padding:4px 8px;white-space:nowrap}
.c{text-align:center;font:italic 800 16px system-ui;padding:6px 8px;border-radius:8px;min-width:52px}.c i{font-size:10px;margin-left:3px}
.great{background:var(--great)}.good{background:var(--good)}.meh{background:var(--meh)}.bad{background:var(--bad)}.na{background:var(--na);color:var(--dim)}
.all{outline:2px solid #fff3}.mean th{font-style:italic}.home{outline:3px solid var(--accent)}.matrix thead th{font-size:12px;color:var(--dim);text-align:center}
.plain td{padding:4px 8px;background:var(--deep);border-radius:6px;text-align:center}.sw{display:inline-block;width:18px;height:18px;border-radius:5px;margin-right:3px;vertical-align:middle;border:1px solid #fff5}
ol.issues{list-style:none;padding:0;margin:0;display:grid;gap:6px}.issue{background:var(--card);border-radius:12px;padding:8px 12px;border-left:6px solid var(--na)}
.issue.blocker{border-color:#FF3D5A}.issue.major{border-color:var(--accent)}.issue.minor{border-color:#F5C518}.issue.polish{border-color:#5B7BE0}
.issue .sev{font:italic 800 11px system-ui;text-transform:uppercase;margin-right:8px;color:var(--dim)}.issue .meta,.issue .detail{display:block;font-size:12px;color:var(--dim)}
.persona{background:var(--card);border-radius:20px;padding:16px;margin:16px 0}.persona p{margin:4px 0}blockquote{margin:8px 0;padding:8px 12px;background:var(--deep);border-radius:12px;font-style:italic}
.why{display:flex;gap:8px;align-items:baseline;font-size:13px;margin:4px 0}.why .c{font-size:13px;min-width:40px;padding:2px 6px}.why b{min-width:84px}
.journeys{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;margin:10px 0}.journey{background:var(--deep);border-radius:12px;padding:8px 12px;font-size:13px}
.journey.fail{outline:2px solid var(--bad)}.journey ol{margin:4px 0 0;padding-left:16px}.journey li.bad{color:#FF8FA0}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px}.shots a{display:block;color:var(--dim);font-size:11px;text-decoration:none}.shots img{width:100%;border-radius:10px;display:block;background:#000}
@media (max-width:640px){h1{font-size:34px}.why{flex-wrap:wrap}}
</style>
<h1>PERSONA LAB</h1>
<div class="dim">Run ${esc(card.runId)} · ${card.personas.length} personas${card.quick ? ' (quick)' : ''} · ${esc(card.at)}${card.baselineAt ? ' · baseline ' + esc(card.baselineAt) : ' · no baseline yet (pnpm personas --save)'}</div>
<p><span class="gate ${card.blockers || card.regressions.length ? 'fail' : 'ok'}">${card.blockers || card.regressions.length ? `✗ ${card.blockers} blockers · ${card.regressions.length} regressions` : '✓ gate passed'}</span></p>
<div class="pillars">${P.map((k) => `<div class="pill"><b>${card.pillars[k].mean ?? '–'}</b>${NAMES[k]}<span><br>${card.pillars[k].min == null ? '–' : card.pillars[k].min >= 100 ? 'everyone 100' : 'worst: ' + esc(byId[card.pillars[k].worst].handle) + ' ' + card.pillars[k].min}</span></div>`).join('')}<div class="pill"><b>${card.overall}</b>Overall<span><br>each persona weighted by what they care about</span></div></div>
<h2>Every persona, every pillar</h2><div class="scroll">${matrix}</div>
<h2>Top fixes</h2><p class="dim">The same issue met by several personas is one line, blockers first, then by severity × how many it hit. ${card.issues.length} in all.</p><ol class="issues">${issues}</ol>
${funLab}
${palette}
<h2>The players</h2>
${cards}
</html>`;
  writeFileSync(join(out, 'index.html'), html);
}

