/* The learning layer's data, checked offline: every hub item and lesson link opens a real screen,
 * every route lands in the hub that lists it, every lesson can be finished (a check or a quiz with
 * one right answer among distinct choices), every glossary and guide reference resolves, and every
 * screen the router knows has a guide card. */
import { HUBS, hubFor, placeFor, GLOSSARY, termByKey, GUIDES, TRACKS, LESSONS, lessonById, trackOf } from '../src/data/learn';
import { ROUTES, describeRoute } from '../src/data/seo';
import { looksLikePhrase, newMnemonic } from '../src/wallet/keys';
import { matchupQuestion, canHit, priceQuestion, codeQuestion } from '../src/game/practice';
import { TYPES_BY_ID, AMBITS, type Ambit } from '../src/data/catalogue';

let fails = 0;
const ok = (cond: unknown, msg: string) => { if (!cond) { fails++; console.error('FAIL', msg); } };

/** Route heads the router in src/main.ts understands (anything else falls back to the galaxy). */
const HEADS = new Set(['galaxy', 'planet', 'player', 'sim', 'codex', 'combat', 'grid', 'command', 'ops', 'forge', 'comms', 'guild', 'economy', 'intel', 'academy', 'lobby']);
const SCREENS = ['galaxy', 'planet', 'sim', 'codex', 'combat', 'grid', 'command', 'ops', 'forge', 'comms', 'intel', 'economy', 'guild', 'academy', 'lobby'];
const routes = (p: string) => p.startsWith('/') && HEADS.has(p.split('/')[1]);

/* ── Hubs ───────────────────────────────────────────────────────────────── */
ok(HUBS.length === 6, 'six hubs');
ok(new Set(HUBS.map((h) => h.id)).size === HUBS.length, 'hub ids are unique');
ok(new Set(HUBS.map((h) => h.color)).size === HUBS.length, 'every hub has its own colour');
const allPaths: string[] = [];
for (const hub of HUBS) {
  ok(hub.items.length >= 2, `${hub.id}: at least two places`);
  if (hub.track) ok(TRACKS.some((t) => t.id === hub.track), `${hub.id}: its track exists`);
  for (const it of hub.items) {
    ok(!!it.path !== !!it.action, `${hub.id}/${it.label}: a path or an action, not both`);
    ok(it.desc.length >= 20 && it.desc.length <= 120, `${hub.id}/${it.label}: a one-line description (${it.desc.length} chars)`);
    if (it.path) {
      ok(routes(it.path), `${hub.id}/${it.label}: ${it.path} is a real route`);
      ok(hubFor(it.path) === hub.id, `${it.path} lands in the ${hub.id} hub (got ${hubFor(it.path)})`);
      ok(placeFor(it.path).label === it.label, `${it.path} is called ${it.label} (got ${placeFor(it.path).label})`);
      allPaths.push(it.path);
    }
  }
}
ok(new Set(allPaths).size === allPaths.length, 'no screen listed twice');
// Every screen the client has is reachable from some hub (the Academy and planet maps sit outside).
for (const s of SCREENS.filter((x) => !['academy', 'planet'].includes(x))) ok(allPaths.some((p) => p.split('/')[1] === s), `${s} is in a hub`);
// Routes the hubs don't list still land somewhere sensible.
ok(hubFor('/planet/2-1') === 'explore' && hubFor('/player/1-5') === 'explore', 'planet maps belong to Explore');
ok(hubFor('/combat/ABCDEF/e') === 'battle' && hubFor('/codex/5') === 'battle' && hubFor('/sim/R123') === 'battle', 'battle deep links');
ok(hubFor('/ops/record') === 'base' && hubFor('/ops/queue') === 'base' && hubFor('/ops') === 'base', 'ops pages of the base');
ok(hubFor('/ops/proofs') === 'lab' && hubFor('/ops/health') === 'lab' && hubFor('/forge/MsgStructAttack') === 'lab', 'ops pages of the lab');
ok(hubFor('/intel/guild/0-5') === 'team' && hubFor('/guild/perms') === 'team' && hubFor('/intel/leaderboards') === 'explore', 'guild pages vs intel');
ok(hubFor('/academy/strategy') === null, 'the Academy sits beside the hubs');
ok(hubFor('/') === 'explore', 'the front door is the galaxy');

/* ── Lessons ────────────────────────────────────────────────────────────── */
ok(TRACKS.length === 3, 'three tracks');
ok(new Set(LESSONS.map((l) => l.id)).size === LESSONS.length, 'lesson ids are unique');
for (const l of LESSONS) {
  ok(l.check || l.quiz, `${l.id}: can be finished (a check or a quiz)`);
  ok(l.xp >= 10 && l.xp <= 100, `${l.id}: xp in range`);
  ok(l.learn.length >= 60 && l.learn.length <= 360, `${l.id}: two or three sentences (${l.learn.length} chars)`);
  ok(!/[—]/.test(l.title), `${l.id}: titles read plainly`);
  if (l.go) ok(l.go === 'palette' || l.go === 'expert' || routes(l.go), `${l.id}: go ${l.go} is a real route`);
  if (l.check && 'route' in l.check) ok(routes(l.check.route), `${l.id}: check route ${l.check.route} is real`);
  if (l.check && 'route' in l.check && l.go && l.go !== 'palette' && l.go !== 'expert') {
    const r = l.check.route;
    const reaches = r.endsWith('/') ? l.go.startsWith(r) || l.go === r.slice(0, -1) : l.go === r || l.go.startsWith(r + '/');
    ok(reaches, `${l.id}: "Try it" (${l.go}) leads to what the check wants (${r})`);
  }
  if (l.quiz) {
    const q = l.quiz;
    ok(q.choices.length >= 2 && q.choices.length <= 4, `${l.id}: 2–4 choices`);
    ok(new Set(q.choices.map((c) => c.toLowerCase())).size === q.choices.length, `${l.id}: distinct choices`);
    ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length, `${l.id}: the answer is one of the choices`);
    ok(q.why.length > 10, `${l.id}: explains the answer`);
  }
  ok(trackOf(l.id) && lessonById.get(l.id) === l, `${l.id}: indexed`);
}
for (const t of TRACKS) ok(t.lessons.length >= 5, `${t.id}: at least five lessons`);

/* ── Glossary and guides ────────────────────────────────────────────────── */
ok(new Set(GLOSSARY.map((t) => t.key)).size === GLOSSARY.length, 'glossary keys are unique');
for (const t of GLOSSARY) {
  ok(termByKey.get(t.key) === t, `${t.key}: indexed`);
  ok(t.short.length >= 30 && t.short.length <= 200, `${t.key}: one or two sentences`);
  if (t.lesson) ok(lessonById.has(t.lesson), `${t.key}: lesson ${t.lesson} exists`);
}
for (const k of ['alpha', 'ore', 'charge', 'power', 'shield', 'hash', 'phrase', 'block']) ok(termByKey.has(k), `glossary explains ${k}`);
for (const s of SCREENS) {
  const g = GUIDES[s];
  ok(g, `${s}: has a guide card`);
  if (!g) continue;
  ok(g.tries.length === 3, `${s}: three things to try`);
  if (g.lesson) ok(lessonById.has(g.lesson), `${s}: guide lesson ${g.lesson} exists`);
}

/* ── The Academy as a page ──────────────────────────────────────────────── */
ok(ROUTES.some((r) => r.path === '/academy' && !r.commander), 'the Academy is prerendered, and public');
ok(describeRoute('academy', { track: 'economics' }).title === 'Academy · Economics', 'track pages name themselves');

/* ── Chat's phrase guard ────────────────────────────────────────────────── */
ok(looksLikePhrase(newMnemonic(24)) && looksLikePhrase(newMnemonic(12)), 'a recovery phrase is caught');
ok(looksLikePhrase('my words are: ' + newMnemonic(12) + ' pls help'), 'a phrase inside a sentence is caught');
ok(!looksLikePhrase('hey team, who wants to raid planet 2-7 with me tonight? bring tanks and a cruiser'), 'ordinary chat passes');
ok(!looksLikePhrase('the cat sat on the mat and then it ran away'), 'a short run of common words passes');
ok(!looksLikePhrase('hello team what can you build there now you have time come help'), 'a long run of everyday list words passes');
ok(!looksLikePhrase('you know what, just wait there until they come back, then attack the planet with your team now'), 'everyday chat with game words passes');

/* ── Matchup practice ───────────────────────────────────────────────────── */
{
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let yes = 0;
  for (let i = 0; i < 200; i++) {
    const q = matchupQuestion(rand);
    const m = /^Can a (.+) in (\w+) hit a (.+) in (\w+)\?$/.exec(q.q);
    ok(m, `practice question reads as a question: ${q.q}`);
    if (!m) continue;
    const from = m[2].toLowerCase() as Ambit, to = m[4].toLowerCase() as Ambit;
    ok(AMBITS.includes(from) && AMBITS.includes(to), `practice ambits are real: ${q.q}`);
    ok(canHit(TYPES_BY_ID[q.attacker], from, to) === q.yes, `practice answer follows the reach rules: ${q.q}`);
    ok(q.why.startsWith(q.yes ? 'Yes' : 'No'), 'practice explains its answer');
    if (q.yes) yes++;
  }
  ok(yes > 60 && yes < 140, `practice answers are balanced (${yes}/200 yes)`);
}
{
  let seed = 3;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 200; i++) {
    const q = priceQuestion(rand);
    const m = /costs ([\d.]+) alpha per kW per day\. You need (\d+) kW for (\d+) day/.exec(q.q);
    ok(m, `price question parses: ${q.q}`);
    if (!m) continue;
    const total = Math.round(Number(m[1]) * Number(m[2]) * Number(m[3]) * 100) / 100;
    ok(q.answer >= 0 && q.choices[q.answer] === `${total} alpha`, `price answer is right: ${q.q} → ${q.choices[q.answer]}`);
    ok(new Set(q.choices).size === q.choices.length && q.choices.length === 3, `price choices are 3 and distinct: ${q.choices.join(', ')}`);
  }
}

{
  let seed = 11;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const q = codeQuestion(rand);
    ok(q.answer >= 0 && q.choices.length === 4 && new Set(q.choices).size === 4, `code question has 4 distinct choices: ${q.choices.join(' | ')}`);
    seen.add(q.choices[q.answer].replace(/\(.*/, ''));
  }
  for (const f of ['explore', 'switchOn', 'build', 'sail', 'sendHome', 'wait']) ok(seen.has(f), `code practice sometimes answers ${f}()`);
}

if (fails) { console.error(`learn: ${fails} failure(s)`); process.exit(1); }
console.log(`learn: ok (${HUBS.length} hubs, ${LESSONS.length} lessons, ${GLOSSARY.length} words, ${Object.keys(GUIDES).length} guides)`);
