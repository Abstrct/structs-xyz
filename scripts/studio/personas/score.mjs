/* Persona lab, scoring: each persona's evidence (sim lane, browser lane, an AI playtester's verdict)
 * becomes five pillar scores out of 100, an overall weighted by what that persona cares about, and
 * issues. An issue carries a pillar, a severity, a screen, the detail and the personas it hit. The
 * same issue met by several personas is one issue, and it ranks higher.
 *
 * Severities: blocker (a crash, a persona who can't finish a must journey, a seizure risk) fails the
 * run; major and minor cost points; polish is noted. Each rule below says what it costs and why. */
import { deltaE, parseColour, readingGrade, simulate, VISION_TYPES } from './metrics.mjs';

export const SEV = { blocker: 100, major: 30, minor: 8, polish: 2 };
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const median = (a) => { const s = a.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const uniq = (a) => [...new Set(a)];
/** One problem line as a stable key: numbers, ids and urls stripped so repeats group. */
const norm = (s) => String(s).replace(/https?:\/\/\S+/g, '<url>').replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').slice(0, 140);

/** A pillar's ledger: points off with a reason, issues raised. */
function ledger() {
  const L = { off: 0, reasons: [], issues: [] };
  L.pen = (pts, reason, issue) => { if (pts > 0) { L.off += pts; L.reasons.push(`−${Math.round(pts)} ${reason}`); } if (issue) L.issues.push(issue); };
  L.score = () => clamp(100 - L.off);
  return L;
}
const capped = (n, each, max) => Math.min(max, n * each);
const audits = (br) => (br?.checkpoints || []).filter((c) => c.audit && !c.audit.error);
const routeOf = (c) => c.route || c.audit?.path || c.name;

/* ── Stability ─────────────────────────────────────────────────────────── */
function stability(p, br, sim) {
  const L = ledger();
  if (!br && !sim) return null;
  if (br) {
    const probs = uniq((br.problems || []).filter((x) => !/could not start Chrome/.test(x)).map(norm));
    const uncaught = probs.filter((x) => /^uncaught/.test(x)), crash = probs.filter((x) => /renderer crashed|DevTools connection closed/.test(x));
    const errors = probs.filter((x) => /^console\.error/.test(x)), logs = probs.filter((x) => /^log:/.test(x));
    for (const u of uncaught) L.pen(30 / Math.max(1, uncaught.length / 3), 'uncaught exception', { sev: 'blocker', code: 'exception', title: u.slice(0, 120), where: 'runtime' });
    for (const c of crash) L.pen(60, 'the renderer crashed', { sev: 'blocker', code: 'crash', title: c, where: 'runtime' });
    L.pen(capped(errors.length, 10, 40), `${errors.length} distinct console errors`);
    for (const e of errors) L.issues.push({ sev: 'major', code: 'console-error', title: e.slice(0, 120), where: 'runtime' });
    L.pen(capped(logs.length, 6, 24), `${logs.length} failed loads of the site's own files`);
    for (const e of logs) L.issues.push({ sev: 'major', code: 'resource', title: e.slice(0, 120), where: 'network' });
    const longMs = 250 * Math.max(1, p.cpuThrottle || 1);
    const long = (br.longTasks || []).filter((d) => d > longMs);
    if (long.length) L.pen(capped(long.length, 1, 15), `${long.length} long tasks over ${longMs} ms (worst ${Math.max(...long)} ms)`, long.length >= 5 ? { sev: 'minor', code: 'long-task', title: `main thread blocked over ${longMs} ms ${long.length} times (worst ${Math.max(...long)} ms)`, where: p.view } : null);
    if (br.chaos?.hang || br.chaos?.dead) L.pen(60, 'the page stopped answering under chaos', { sev: 'blocker', code: 'hang', title: 'page hung under random input', where: 'chaos', detail: JSON.stringify(br.chaos.tally) });
    const m = br.marathon?.rounds;
    if (m?.length > 1) {
      const a = m[0], z = m[m.length - 1], grow = (k) => (a[k] ? (z[k] - a[k]) / a[k] : 0);
      if (grow('heapMB') > 0.25) L.pen(15, `heap grew ${Math.round(grow('heapMB') * 100)}% over ${m.length} fights`, { sev: 'major', code: 'leak-heap', title: `JS heap grows ${a.heapMB} → ${z.heapMB} MB over ${m.length} fights (after GC)`, where: '/sim' });
      if (grow('nodes') > 0.25) L.pen(8, `DOM nodes grew ${Math.round(grow('nodes') * 100)}%`, { sev: 'minor', code: 'leak-dom', title: `DOM nodes ${a.nodes} → ${z.nodes} over ${m.length} fights`, where: '/sim' });
      if (grow('listeners') > 0.25) L.pen(8, `event listeners grew ${Math.round(grow('listeners') * 100)}%`, { sev: 'minor', code: 'leak-listeners', title: `event listeners ${a.listeners} → ${z.listeners} over ${m.length} fights`, where: '/sim' });
      if (a.fps && z.fps && z.fps < a.fps * 0.8) L.pen(8, `frame rate fell ${a.fps} → ${z.fps} fps`, { sev: 'minor', code: 'slowdown', title: `fight ${m.length} runs at ${z.fps} fps, fight 1 at ${a.fps}`, where: '/sim' });
    }
    for (const j of br.journeys || []) if (!j.ok && j.error && !j.steps?.some((s) => !s.ok) && !/no such journey/.test(j.error)) L.pen(10, `the bot lost the page in ${j.name}: ${j.error}`, { sev: 'major', code: 'bot-lost', title: `${j.name}: ${j.error.slice(0, 100)}`, where: j.name });
  }
  if (sim?.all?.unfinished) L.pen(20, `${sim.all.unfinished} sim battles never finished`, { sev: 'major', code: 'unfinished', title: `${sim.all.unfinished} battles hit the block cap`, where: 'sim' });
  return L;
}

/* ── Playability ───────────────────────────────────────────────────────── */
function playability(p, br) {
  if (!br) return null;
  const L = ledger();
  let cap = 100;
  for (const j of br.journeys || []) {
    const failedStep = j.steps?.find((s) => !s.ok);
    if (!j.ok) {
      const must = (p.musts || []).includes(j.name);
      const what = failedStep ? failedStep.name : j.error;
      L.pen(must ? 40 : 20, `${j.name} failed at "${what}"`, { sev: must ? 'blocker' : 'major', code: 'journey', title: `${j.name}: can't get past "${what}"`, where: j.name, detail: failedStep?.quit || j.error });
      if (must) cap = 25;
    } else if (j.soft) {
      const fails = j.steps.filter((s) => !s.ok);
      L.pen(capped(fails.length, 4, 20), `${fails.length} steps failed in ${j.name}`);
      for (const f of fails) L.issues.push({ sev: 'minor', code: 'step', title: f.name, where: j.name, detail: f.failed ? f.failed.join(', ') : '' });
    }
  }
  const stuck = p.patience?.stuckSec ?? 60;
  for (const bt of br.battles || []) {
    if (bt.firstShotS != null && bt.firstShotS > stuck / 2) L.pen(6, `first shot took ${bt.firstShotS} s`, { sev: 'minor', code: 'slow-first-shot', title: `first shot after ${bt.firstShotS} s (patience ${stuck} s)`, where: '/sim' });
  }
  const traps = {};
  for (const u of br.unstuck || []) traps[u.mode] = (traps[u.mode] || 0) + 1;
  for (const [mode, n] of Object.entries(traps)) L.pen(Math.min(12, 4 * n), `stuck in "${mode}" mode ${n}×`, { sev: 'minor', code: 'mode-trap', title: mode.startsWith('cursor') ? `the pad ${mode} after a slip: every A pressed it instead of firing, until the cursor was steered back (${n}×)` : `stuck in the "${mode}" pick with nothing a press could do, until backing out (${n}×)`, where: '/sim' });
  const its = br.inputsToStart;
  if (its > 20) L.pen(12, `${its} inputs from the title to a fight`, { sev: 'major', code: 'inputs-to-start', title: `${its} ${p.input} inputs from the title to a fight`, where: 'title → /sim' });
  else if (its > 10) L.pen(5, `${its} inputs from the title to a fight`, { sev: 'minor', code: 'inputs-to-start', title: `${its} ${p.input} inputs from the title to a fight`, where: 'title → /sim' });
  const inp = br.inputs || {};
  if (p.id !== 'button-masher' && inp.n > 10) {
    const dead = inp.dead / inp.n;
    if (dead > 0.4) L.pen(15, `${Math.round(dead * 100)}% of inputs did nothing visible`, { sev: 'major', code: 'dead-input', title: `${Math.round(dead * 100)}% of ${p.input} inputs changed nothing (${inp.rage} rage bursts)`, where: 'input' });
    else if (dead > 0.25) L.pen(8, `${Math.round(dead * 100)}% of inputs did nothing visible`, { sev: 'minor', code: 'dead-input', title: `${Math.round(dead * 100)}% of ${p.input} inputs changed nothing`, where: 'input' });
    L.pen(capped(inp.rage, 4, 12), `${inp.rage} rage bursts (3+ dead inputs in a row)`);
  }
  const lat = (inp.latency || []).slice().sort((a, b) => a - b), p95 = lat.length ? lat[Math.floor(lat.length * 0.95)] : null;
  const want = p.checks?.latency ? 150 : 300;
  if (p95 != null && p95 > want * 2) L.pen(15, `p95 response ${p95} ms`, { sev: 'major', code: 'latency', title: `p95 input response ${p95} ms (wants ≤ ${want})`, where: p.view });
  else if (p95 != null && p95 > want) L.pen(8, `p95 response ${p95} ms`, { sev: 'minor', code: 'latency', title: `p95 input response ${p95} ms (wants ≤ ${want})`, where: p.view });
  const bootWant = p.network === '3g' ? 45 : p.network === '4g' ? 15 : 8;
  if (br.boot != null && br.boot > bootWant * 2) L.pen(12, `first load ${br.boot} s`, { sev: 'major', code: 'boot', title: `title after ${br.boot} s on ${p.network || 'a fast line'}`, where: '/' });
  else if (br.boot != null && br.boot > bootWant) L.pen(6, `first load ${br.boot} s`, { sev: 'minor', code: 'boot', title: `title after ${br.boot} s on ${p.network || 'a fast line'}`, where: '/' });
  const covered = new Map();
  for (const c of audits(br)) if (!c.audit.modal) for (const x of c.audit.covered || []) covered.set(routeOf(c) + ' ' + x.name, { where: routeOf(c), ...x });
  L.pen(capped(covered.size, 2, 12), `${covered.size} controls covered by something else`);
  // (Under a toast is a passing nuisance, polish; under anything else the control can't be pressed.)
  for (const x of covered.values()) L.issues.push({ sev: /toast/.test(x.by) ? 'polish' : 'minor', code: 'covered', title: `"${x.name}" is under ${/toast/.test(x.by) ? 'a toast' : x.by}`, where: x.where });
  if (br.offline) {
    if (!br.offline.seen?.some((s) => s.says)) L.pen(15, 'no outage message offline', { sev: 'major', code: 'offline-silent', title: 'with no signal, no screen says so', where: 'offline' });
    for (const s of br.offline.seen || []) if (!s.mounted) L.pen(10, `${s.route} blank offline`, { sev: 'major', code: 'offline-blank', title: `${s.route} doesn't open with no signal`, where: s.route });
  }
  const sc = L.score();
  L.score = () => Math.min(cap, sc);
  return L;
}

/* ── Fun ───────────────────────────────────────────────────────────────── */
function fun(p, br, sim) {
  // Fun is measured by the sim lane (hundreds of fights); a browser fight or two only adjusts it.
  if (!sim?.home) return null;
  const L = ledger();
  const h = sim?.home, pl = p.pilot;
  if (h) {
    const [lo, hi] = pl.band, dist = h.win < lo ? lo - h.win : h.win > hi ? h.win - hi : 0;
    const rung = `${h.preset}/${h.difficulty}`;
    L.pen(0.35 * Math.min(100, dist * 250), `home rung ${rung}: win ${Math.round(h.win * 100)}% (band ${Math.round(lo * 100)}–${Math.round(hi * 100)}%)`,
      dist > 0.05 ? { sev: dist > 0.15 ? 'major' : 'minor', code: 'flow', title: `${rung} is too ${h.win < lo ? 'hard' : 'easy'} for this player: wins ${Math.round(h.win * 100)}% (want ${Math.round(lo * 100)}–${Math.round(hi * 100)}%)`, where: 'balance' } : null);
    const [mlo, mhi] = pl.minutes, out = h.minutes < mlo ? mlo - h.minutes : h.minutes > mhi ? h.minutes - mhi : 0;
    L.pen(0.2 * Math.min(100, out * 40), `fights last ${h.minutes} min (want ${mlo}–${mhi})`, out > 0.5 ? { sev: 'minor', code: 'pacing', title: `fights last ${h.minutes} min median (want ${mlo}–${mhi})`, where: 'balance' } : null);
    if (h.deadAirS > 20) L.pen(0.2 * Math.min(100, (h.deadAirS - 20) * 3), `${h.deadAirS} s with no order landing`, h.deadAirS > 30 ? { sev: 'minor', code: 'dead-air', title: `${h.deadAirS} s stretches where none of your orders land`, where: 'balance' } : null);
    L.pen(0.2 * (100 - Math.min(100, (h.tension / 0.5) * 100)), `${Math.round(h.tension * 100)}% of fights close or swinging`, h.tension < 0.2 ? { sev: 'minor', code: 'tension', title: `only ${Math.round(h.tension * 100)}% of fights are close or change hands`, where: 'balance' } : null);
    const agency = Math.min(1, h.agency / 0.9) * (0.5 + 0.5 * Math.min(1, h.hitRate / 0.6));
    L.pen(0.15 * (100 - agency * 100), `${Math.round(h.agency * 100)}% of orders went in, ${Math.round(h.hitRate * 100)}% of shots hurt`);
    const variety = Math.min(1, h.variety / 0.5) * 100 - h.stalemates * 200;
    L.pen(0.1 * (100 - Math.max(0, variety)), `order variety ${h.variety}${h.stalemates ? `, ${Math.round(h.stalemates * 100)}% stalemates` : ''}`);
    if (h.stalemates > 0.1) L.issues.push({ sev: 'minor', code: 'stalemate', title: `${Math.round(h.stalemates * 100)}% of ${rung} fights end in a standoff`, where: 'balance' });
    const top = Math.max(0, ...Object.values(h.mix || {}));
    if (pl.brain === 'hard' && top > 0.85) L.issues.push({ sev: 'polish', code: 'dominant', title: `a strong player's orders are ${Math.round(top * 100)}% ${h.dominant}: one move dominates ${rung}`, where: 'balance' });
  }
  for (const bt of br?.battles || []) {
    if (bt.firstShotS > 25) L.pen(5, `${bt.firstShotS} s before the first shot`);
    if (bt.noShotS > 45) L.pen(5, `${bt.noShotS} s in a fight with nothing to fire`, { sev: 'minor', code: 'dead-air-live', title: `${bt.noShotS} s in a fight with nothing to fire (${bt.result || 'unfinished'})`, where: '/sim' });
  }
  return L;
}

/* ── Accessibility ─────────────────────────────────────────────────────── */
function accessibility(p, br, lab) {
  if (!br) return null;
  const L = ledger(), A = audits(br), ax = !!p.checks?.ax;
  /* The same failing text or control on many screens is one problem (a top-bar button fails everywhere):
   * grouped by what it is, with the screens it was seen on. */
  const across = (pick, keyOf) => { const m = new Map(); for (const c of A) for (const x of pick(c) || []) { const k = keyOf(x); if (!m.has(k)) m.set(k, { x, where: new Set() }); m.get(k).where.add(routeOf(c)); } return [...m.values()]; };
  const places = (set) => { const a = [...set]; return a.length > 4 ? `${a.length} screens (${a.slice(0, 3).join(', ')}…)` : a.join(', '); };
  const contrast = across((c) => c.audit.contrast?.fails, (x) => `${x.text}|${x.ratio}`);
  for (const { x, where } of contrast) L.issues.push({ sev: x.ratio < x.need - 1.5 ? 'major' : 'minor', code: 'contrast', title: `"${x.text}" is ${x.ratio}:1 against its background (needs ${x.need})`, where: places(where), screens: [...where], detail: `${x.px}px, ${x.fg} on ${x.bg}` });
  L.pen(capped(contrast.length, p.checks?.contrast ? 2.5 : 1.5, 30), `${contrast.length} texts under WCAG contrast`);
  const small = across((c) => c.audit.small, (x) => x.text);
  for (const { x, where } of small) L.issues.push({ sev: 'minor', code: 'small-text', title: `"${x.text}" is ${x.px}px (wants ≥ ${p.checks?.minFontPx ?? 11})`, where: places(where), screens: [...where] });
  L.pen(capped(small.length, 2, 25), `${small.length} texts too small`);
  const minTap = p.checks?.minTargetPx ?? (p.input === 'touch' ? 40 : 24);
  const tiny = across((c) => c.audit.tiny, (x) => `${x.name}|${x.w}x${x.h}`);
  for (const { x, where } of tiny) L.issues.push({ sev: 'minor', code: 'tiny-target', title: `"${x.name || '?'}" is ${x.w}×${x.h} px, under ${minTap} px for ${p.input}`, where: places(where), screens: [...where] });
  L.pen(capped(tiny.length, 1.5, 25), `${tiny.length} targets too small for ${p.input}`);
  const unnamed = across((c) => c.audit.unnamed, (x) => x);
  for (const { x, where } of unnamed) L.issues.push({ sev: ax ? 'major' : 'minor', code: 'unnamed', title: `a control with no name (${x})`, where: places(where), screens: [...where] });
  L.pen(capped(unnamed.length, ax ? 6 : 3, ax ? 35 : 20), `${unnamed.length} unnamed controls`);
  if (p.input === 'pad' || p.checks?.focus) {
    const pads = A.filter((c) => c.journey === 'tour' && c.route);
    const lost = pads.filter((c) => !c.audit.focus), noRing = pads.filter((c) => c.audit.focus && !c.audit.focus.ring);
    L.pen(capped(lost.length + noRing.length, 3, 20), `${lost.length} screens where a d-pad press focused nothing, ${noRing.length} with no cursor ring`);
    for (const c of lost) L.issues.push({ sev: 'minor', code: 'pad-focus', title: 'a d-pad press lands focus nowhere', where: routeOf(c) });
    for (const c of noRing) L.issues.push({ sev: 'minor', code: 'focus-ring', title: `focus on "${c.audit.focus.name}" shows no ring`, where: routeOf(c) });
  }
  for (const w of br.tabwalk || []) {
    if (!w.distinct) { L.pen(15, `Tab reaches nothing on ${w.route}`, { sev: 'major', code: 'tab-nothing', title: `Tab moves focus nowhere: no control on the screen is reachable by Tab`, where: w.route }); continue; }
    if (w.trapped) L.pen(20, `Tab is trapped on ${w.route}`, { sev: 'major', code: 'focus-trap', title: `Tab cycles ${w.distinct} controls and never leaves`, where: w.route });
    if (!w.hubs && !w.trapped) L.pen(6, `Tab never reaches the hubs on ${w.route}`, { sev: 'minor', code: 'tab-hubs', title: `40 Tabs never reach the hubs`, where: w.route });
    if (w.noRing) L.pen(Math.min(12, w.noRing * 1.5), `${w.noRing} Tab stops with no ring on ${w.route}`, { sev: w.noRing > 5 ? 'major' : 'minor', code: 'focus-ring', title: `${w.noRing} of ${w.stops} Tab stops show no focus ring`, where: w.route, detail: w.noRingNames.join(', ') });
    if (w.outOfView > 3) L.pen(5, `${w.outOfView} Tab stops off screen on ${w.route}`, { sev: 'minor', code: 'focus-offscreen', title: `${w.outOfView} Tab stops land off screen`, where: w.route });
    if (w.lost > 5) L.pen(5, `focus fell to the page ${w.lost} times on ${w.route}`, { sev: 'minor', code: 'focus-lost', title: `focus drops to the page ${w.lost} times in 40 Tabs`, where: w.route });
  }
  const vision = p.checks?.palette;
  if (vision && br.palette) {
    for (const [a, b, what, labelled] of lab.palettePairs.pairs) {
      const ca = parseColour(br.palette[a]), cb = parseColour(br.palette[b]);
      if (!ca || !cb) continue;
      const d = deltaE(simulate(ca, vision), simulate(cb, vision));
      if (d < lab.palettePairs.minDeltaE) L.pen(labelled ? 3 : 10, `${what}: ΔE ${d.toFixed(1)} to ${vision}`, { sev: labelled ? 'minor' : 'major', code: 'colour-pair', title: `${what} look alike to ${vision} (ΔE ${d.toFixed(1)}, want ≥ ${lab.palettePairs.minDeltaE})`, where: 'palette', detail: `${a} ${br.palette[a]} vs ${b} ${br.palette[b]}${labelled ? ' (a letter or icon also tells them apart)' : ''}` });
    }
  }
  for (const s of br.screencasts || []) {
    if (s.flashes.perSecond > 3) L.pen(40, `${s.flashes.perSecond} flashes in a second`, { sev: p.checks?.flash ? 'blocker' : 'major', code: 'flash', title: `${s.flashes.perSecond} general flashes in one second (WCAG 2.3.1 allows 3)`, where: s.label });
    if (p.checks?.motion && s.motion.p95 > 6) L.pen(15, `picture lurches (p95 ΔL* ${s.motion.p95}) with Reduce motion on`, { sev: 'major', code: 'motion', title: `the picture lurches with Reduce motion on (frame-to-frame change p95 ${s.motion.p95})`, where: s.label });
  }
  if (p.checks?.motion) {
    if (A.some((c) => c.audit.reduceMotion === false)) L.pen(15, 'the engine ignored Reduce motion', { sev: 'major', code: 'reduce-motion', title: 'Reduce motion is on but the engine runs with it off', where: 'settings' });
    const inf = A.filter((c) => c.audit.infinite > 8);
    if (inf.length) L.pen(5, `endless animations with Reduce motion on (${inf.map((c) => c.audit.infinite).join(', ')})`, { sev: 'minor', code: 'endless-animation', title: `${Math.max(...inf.map((c) => c.audit.infinite))} endless animations run with Reduce motion on`, where: routeOf(inf[0]) });
  }
  if (ax) {
    const axs = (br.checkpoints || []).filter((c) => c.ax);
    if (axs.length && axs.every((c) => !c.ax.landmarks)) L.pen(5, 'no landmarks', { sev: 'minor', code: 'landmarks', title: 'no landmarks (main, navigation) to jump by', where: 'all' });
    const noHead = axs.filter((c) => !c.ax.headings);
    if (noHead.length > axs.length / 2) L.pen(5, `${noHead.length} screens without headings`, { sev: 'minor', code: 'headings', title: `${noHead.length} of ${axs.length} screens have no heading`, where: uniq(noHead.map(routeOf)).slice(0, 4).join(', ') });
    if ((br.battles || []).length && !(br.live?.changes > 0)) L.pen(20, 'the battle announces nothing', { sev: 'major', code: 'silent', title: 'a fight makes no live announcement a screen reader can speak', where: '/sim' });
  }
  if (p.checks?.reading) {
    const jargon = new RegExp(`\\b(${lab.jargon.words.join('|')})\\b`, 'gi');
    const hits = new Map();
    for (const c of A) {
      const texts = c.audit.texts || [], g = readingGrade(texts);
      if (g.grade != null && g.grade > 7) L.pen(4, `grade ${g.grade} reading on ${routeOf(c)}`, { sev: 'minor', code: 'reading', title: `reads at school grade ${g.grade} (${g.perBlock} words a line)`, where: routeOf(c) });
      for (const t of texts) for (const m of t.match(jargon) || []) hits.set(m.toLowerCase(), (hits.get(m.toLowerCase()) || 0) + 1);
    }
    if (hits.size) L.pen(capped(hits.size, 2, 15), `jargon: ${[...hits.keys()].join(', ')}`, { sev: 'minor', code: 'jargon', title: `jargon on screen: ${[...hits.entries()].map(([k, v]) => `${k} ×${v}`).join(', ')}`, where: 'copy' });
  }
  const over = uniq(A.filter((c) => c.audit.overflowX || c.audit.offscreen > 0).map(routeOf));
  L.pen(capped(over.length, 10, 20), `content past the edge on ${over.length} screens`);
  for (const r of over) L.issues.push({ sev: 'major', code: 'overflow', title: `content runs past the screen edge at ${p.view}`, where: r });
  return L;
}

/* ── Beauty ────────────────────────────────────────────────────────────── */
function beauty(p, br) {
  if (!br) return null;
  const L = ledger(), A = audits(br);
  const target = p.gl === 'swiftshader' ? 30 : 55;
  const fpsAll = (br.battles || []).map((x) => x.frames?.fps).filter(Boolean);
  const fps = median(fpsAll.length ? fpsAll : (br.checkpoints || []).map((c) => c.frames?.fps));
  if (fps != null) {
    const s = Math.max(0, Math.min(1, (fps - 10) / (target - 10)));
    L.pen(30 * (1 - s), `${fps} fps median (target ${target})`, fps < target * 0.6 ? { sev: 'major', code: 'fps', title: `${fps} fps in play at ${p.view} (target ${target})`, where: p.gl || 'gpu' } : null);
  }
  const jank = median([...(br.battles || []).map((x) => x.frames?.jank), ...(br.checkpoints || []).map((c) => c.frames?.jank)]);
  if (jank != null) L.pen(15 * Math.min(1, jank * 10), `${Math.round(jank * 100)}% janky frames`, jank > 0.08 ? { sev: 'minor', code: 'jank', title: `${Math.round(jank * 100)}% of frames take over twice the median`, where: p.view } : null);
  let layout = 0;
  const clipped = new Map();
  for (const c of A) for (const t of c.audit.clipped || []) clipped.set(routeOf(c) + t, { where: routeOf(c), t });
  layout += Math.min(60, clipped.size * 6);
  for (const x of clipped.values()) L.issues.push({ sev: 'minor', code: 'clipped', title: `"${x.t}" is cut off`, where: x.where });
  if (br.cls > 0.1) { layout += 25; L.issues.push({ sev: 'minor', code: 'layout-shift', title: `layout shifts add up to ${br.cls} (want < 0.1)`, where: p.view }); }
  layout += Math.min(40, uniq(A.filter((c) => c.audit.overflowX).map(routeOf)).length * 20);
  L.pen(0.2 * Math.min(100, layout), 'layout: clipped text, shifts, overflow');
  let pic = 0;
  const grey = p.media?.vision === 'achromatopsia';
  for (const c of br.checkpoints || []) {
    const im = c.image; if (!im) continue;
    const where = routeOf(c);
    if (im.blank) { pic += 50; L.issues.push({ sev: 'blocker', code: 'blank', title: 'the screen is blank', where, detail: c.shot }); }
    if (im.crushed > 0.45) { pic += 10; L.issues.push({ sev: 'polish', code: 'crushed', title: `${Math.round(im.crushed * 100)}% of the picture is crushed to black`, where, detail: c.shot }); }
    if (im.blown > 0.25) { pic += 10; L.issues.push({ sev: 'polish', code: 'blown', title: `${Math.round(im.blown * 100)}% of the picture is blown to white`, where, detail: c.shot }); }
    if (!grey && im.colourfulness < 12) { pic += 6; L.issues.push({ sev: 'polish', code: 'washed-out', title: `washed out (colourfulness ${im.colourfulness})`, where, detail: c.shot }); }
    if (im.colourfulness > 140) { pic += 6; L.issues.push({ sev: 'polish', code: 'garish', title: `garish (colourfulness ${im.colourfulness})`, where, detail: c.shot }); }
    if (im.contrast < 8 && !im.blank) { pic += 6; L.issues.push({ sev: 'polish', code: 'flat', title: `flat picture (lightness spread ${im.contrast})`, where, detail: c.shot }); }
  }
  L.pen(0.25 * Math.min(100, pic), 'picture: blank, crushed, blown, flat or washed-out frames');
  const covered = A.reduce((n, c) => n + (c.audit.modal ? 0 : (c.audit.covered || []).length), 0);
  L.pen(Math.min(10, covered), `${covered} overlapping controls`);
  return L;
}

/* ── All together ──────────────────────────────────────────────────────── */
const FNS = { stability, playability, fun, accessibility, beauty };

/** verdict: an AI playtester's { runId, scores: { pillar: 1..10 }, issues: [...], quote } for this run, or null. */
export function scorePersona(p, lab, br, sim, verdict) {
  const pillars = {}, reasons = {}, issues = [];
  for (const [k, fn] of Object.entries(FNS)) {
    const L = k === 'accessibility' ? fn(p, br, lab) : k === 'stability' || k === 'fun' ? fn(p, br, sim) : fn(p, br);
    if (!L) { pillars[k] = null; continue; }
    let s = L.score();
    const v = verdict?.scores?.[k];
    if (typeof v === 'number') {
      const w = k === 'fun' || k === 'beauty' ? 0.5 : 0.4;   // bots measure fun and beauty least well: a player's eye counts more there
      reasons[k] = [...L.reasons, `blended with the playtester's ${v}/10 at ${w * 100}%`];
      s = clamp(s * (1 - w) + v * 10 * w);
    } else reasons[k] = L.reasons;
    pillars[k] = s;
    for (const i of L.issues) issues.push({ pillar: k, ...i });
  }
  for (const i of verdict?.issues || []) issues.push({ pillar: i.pillar || 'playability', sev: SEV[i.severity] ? i.severity : 'minor', code: 'playtester', title: String(i.title || '').slice(0, 160), where: i.where || '', detail: [i.repro, i.fix].filter(Boolean).join(' · ') });
  let sum = 0, wsum = 0;
  for (const [k, w] of Object.entries(p.weights)) if (pillars[k] != null) { sum += pillars[k] * w; wsum += w; }
  return { id: p.id, handle: p.handle, pillars, overall: wsum ? Math.round(sum / wsum) : null, reasons, issues, verdict: verdict ? { quote: verdict.quote || '', scores: verdict.scores } : null };
}

/** The same issue from several personas (or several screens) is one issue: grouped by pillar, code and title.
 * Blockers first, then majors…; within a severity, the more personas it hit the higher. */
export function triage(scored) {
  const m = new Map();
  for (const s of scored) for (const i of s.issues) {
    const k = [i.pillar, i.code, norm(i.title)].join('|');
    if (!m.has(k)) m.set(k, { ...i, personas: [], wheres: [] });
    const g = m.get(k);
    for (const w of i.screens || (i.where ? [i.where] : [])) if (!g.wheres.includes(w)) g.wheres.push(w);
    if (!g.personas.includes(s.id)) g.personas.push(s.id);
    if (SEV[i.sev] > SEV[g.sev]) g.sev = i.sev;
  }
  return [...m.values()].map(({ wheres, screens, ...g }) => ({ ...g, where: wheres.length > 4 ? `${wheres.length} screens (${wheres.slice(0, 3).join(', ')}…)` : wheres.join(', '), priority: Math.round(SEV[g.sev] * (1 + 0.25 * (g.personas.length - 1))) })).sort((a, b) => SEV[b.sev] - SEV[a.sev] || b.priority - a.priority);
}

/** How each colour pair reads to every colour-vision type, for the report. */
export function paletteTable(lab, palette) {
  if (!palette) return null;
  return lab.palettePairs.pairs.map(([a, b, what, labelled]) => {
    const ca = parseColour(palette[a]), cb = parseColour(palette[b]);
    return { what, a: palette[a], b: palette[b], labelled: !!labelled, dE: Object.fromEntries(VISION_TYPES.map((t) => [t, ca && cb ? +deltaE(simulate(ca, t), simulate(cb, t)).toFixed(1) : null])) };
  });
}
