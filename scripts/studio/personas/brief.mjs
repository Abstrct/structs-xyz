/* Persona lab, AI lane: a playtest brief per persona (studio/reports/personas/<id>/brief.md). A playtester
 * agent reads it, becomes that player, looks at what the bots saw and plays the build as them, then
 * writes <id>/verdict.json. `pnpm personas --score` blends that verdict in: 40% of a pillar's score, or
 * 50% for fun and beauty, which bots judge least well. A verdict counts only for the run its runId
 * names, so an old opinion never scores a new build. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const VERDICT_SHAPE = `{
  "runId": "<the run id above>",
  "persona": "<id>",
  "scores": { "stability": 1-10, "playability": 1-10, "fun": 1-10, "accessibility": 1-10, "beauty": 1-10 },
  "quote": "one line, in your voice, that sums up how it felt",
  "issues": [
    { "severity": "blocker | major | minor | polish", "pillar": "stability | playability | fun | accessibility | beauty",
      "title": "what went wrong, in a few words", "where": "/route or screen", "repro": "what you did", "fix": "what would make it right" }
  ]
}`;

export function writeBriefs(card, lab, out, root) {
  let n = 0;
  for (const s of card.personas) {
    const p = lab.personas.find((x) => x.id === s.id);
    const dir = join(out, s.id);
    if (!existsSync(dir)) continue;
    const v = lab.views[p.view];
    const mine = card.issues.filter((i) => i.personas.includes(s.id)).slice(0, 12);
    const rel = (f) => relative(root, join(dir, f));
    let pics = null;
    try { pics = JSON.parse(readFileSync(join(dir, 'browser.json'), 'utf8')); } catch { /* the browser lane didn't run for them */ }
    const md = `# Playtest brief: ${p.handle}

Run \`${card.runId}\` · persona \`${p.id}\`

You are playtesting **Structs** (a Dreamcast-styled browser strategy game: fleets of ships fight turn-by-turn battles) as **${p.handle}**.
Stay in character the whole time. Judge it the way this player would, and only by what they would notice.

**Who you are.** ${p.who}

**How you think and talk.** ${p.voice}

**What you care about.** ${p.cares.join('; ')}.

## Your setup

- Screen: ${p.view}, ${v.w}×${v.h} CSS px${v.dpr ? ` at ${v.dpr}× density` : ''}${v.mobile ? ', a touch device' : ''}.
- Hands: ${p.input}${p.hands.jitterPx ? `, presses land up to ${p.hands.jitterPx} px off` : ''}${p.hands.doubleClick ? `, ${Math.round(p.hands.doubleClick * 100)}% of clicks double` : ''}; about ${p.hands.reactionMs} ms between presses.
- Eyes: ${p.media?.vision ? p.media.vision + ' (the pictures below are already rendered as you see them)' : 'typical colour vision'}${p.media?.contrast ? `, prefers ${p.media.contrast} contrast` : ''}${p.media?.reducedMotion ? ', reduced motion on in the OS' : ''}.
- Machine: ${p.gl === 'swiftshader' ? 'no real GPU (software drawing)' : 'a working GPU'}${p.cpuThrottle ? `, a CPU about ${p.cpuThrottle}× slower than a new laptop` : ''}${p.network ? `, ${p.network} network` : ''}.
- Game settings: ${Object.keys(p.settings || {}).length ? '`' + JSON.stringify(p.settings) + '`' : 'defaults'}${p.storage ? ', plus saved data from an older version' : ''}.
- Patience: you give up after about ${p.patience.stuckSec} s stuck.

## What the bots saw as you

Scores this run: ${lab.pillars.map((k) => `${k} **${s.pillars[k] ?? '–'}**`).join(' · ')} · overall **${s.overall ?? '–'}**.

${pics ? (pics.journeys || []).map((j) => `- ${j.ok ? '✓' : '✗'} **${j.name}**${j.error ? ` (${j.error})` : ''}: ${j.steps.map((st) => `${st.ok ? '' : '✗ '}${st.name}${st.seconds != null ? ` ${st.seconds} s` : ''}`).join(' → ')}`).join('\n') : '- (the browser lane did not run for you)'}

Issues the bots raised for you:
${mine.length ? mine.map((i) => `- [${i.sev}] ${i.pillar}: ${i.title} (${i.where})${i.detail ? ` — ${i.detail}` : ''}`).join('\n') : '- none'}

Pictures from your run (open them; they show the screen as you see it):
${pics?.checkpoints?.filter((c) => c.shot).map((c) => `- \`${rel(c.shot)}\` ${c.name}${c.route ? ' ' + c.route : ''}${c.tile ? ' ' + c.tile : ''}`).join('\n') || '- none'}

## Play

1. Look at every picture above as ${p.handle}. What would you notice first? What would you miss? Where would you be stuck?
2. See more of the game as you: \`STUDIO_PERSONA=${p.id} pnpm shoot /sim+6 /academy /economy\` takes pictures with your screen, eyes, settings and machine (route+seconds; they land in \`studio/reports/shots/\`). \`STUDIO_EVAL\` runs a page action first, e.g. to start a fight: \`STUDIO_EVAL="[...document.querySelectorAll('.setup-panel button')].find((b) => /start/i.test(b.textContent))?.click()" STUDIO_AFTER=9000\`.
3. If you can drive a browser, play it yourself at ${v.w}×${v.h} with your input. Serve a build with \`npx vite build --outDir <scratch>/dist-${p.id} && npx vite preview --outDir <scratch>/dist-${p.id} --port 0\`. Don't use the dev server, which reloads under you.
4. Be concrete. Name the screen and the control, say what you did and what happened, and say what would have made it right. Don't repeat a bot finding unless you can add why it matters to you.

## Your verdict

Write \`${rel('verdict.json')}\` with this shape (1 = unplayable for you, 10 = perfect for you):

\`\`\`json
${VERDICT_SHAPE.replace('<the run id above>', card.runId).replace('<id>', p.id)}
\`\`\`

Then \`pnpm personas --score\` blends it into the scorecard.
`;
    writeFileSync(join(dir, 'brief.md'), md);
    n++;
  }
  return n;
}
