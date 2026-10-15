# The persona lab

Twenty players test the game on five pillars: **stability, playability, fun, accessibility and beauty**. The gates in [STUDIO.md](STUDIO.md) prove that the build works. The persona lab asks a different question: does it work *for this person*?

```
pnpm personas                    all twenty: sim + browser lanes, scores, report, playtest briefs  (~20 min)
pnpm personas:quick              six of them (rookie, couch-captain, thumb-pilot, tabber, steady, button-masher)
pnpm personas --only=mono,shaky  chosen players (on the same commit, they join the last run's scorecard)
pnpm personas --lane=sim         just the balance/fun lab (about a minute); --lane=browser just the bots
pnpm personas --score            re-score the last run, blending in AI playtesters' verdicts
pnpm personas --save             keep this run as the baseline the next runs are held to
pnpm personas:firefox            the Firefox personas in Firefox, compared with their Chrome runs (--engine=both runs both)
pnpm studio --personas           as a stage of the full pipeline, on the pipeline's build
```

The report is `studio/reports/personas/index.html`. The numbers are in `scorecard.json`, and each player has a folder with their bot's run, pictures and playtest brief.

## The twenty

Each one is a full profile in [`studio/personas.json`](../studio/personas.json). A profile sets their device and viewport, their input, how their hands behave (reaction time, misinput rate, tremor jitter, accidental double clicks) and their patience. It also sets their eyesight, their OS and game settings, their machine and network, any saved data, the journeys they play, their battle pilot and how much each pillar matters to them.

| | Persona | Plays on | Tests above all |
|---|---|---|---|
| 1 | **Rookie**: 13, first strategy game | desktop · mouse | knowing what to press; winning the first fight |
| 2 | **Couch Captain**: Dreamcast veteran | TV 640×480 · pad | never needing a mouse; A goes and B backs out |
| 3 | **Thumb Pilot**: bus commuter | phone · one thumb · patchy 4G | fat-finger targets; backgrounding; turning sideways |
| 4 | **Tabber**: RSI, keyboard only | desktop · trusted key events | Tab reaches everything; focus always shows |
| 5 | **Magnifier**: low vision | 200% zoom · Larger text · more contrast | text size, WCAG contrast, nothing cut off |
| 6 | **Redgreen**: deuteranopia | desktop · mouse | friend vs foe without hue |
| 7 | **Mono**: achromatopsia, light-sensitive | tablet · touch | shape and brightness cues; no flashes |
| 8 | **Steady**: vestibular, photosensitive | desktop · Reduce motion | no shake, flashes or lurches; Reduce motion honoured |
| 9 | **Narrator**: blind, screen reader | desktop · keyboard | names, landmarks, a fight that announces itself |
| 10 | **Shaky Hands**: tremor | desktop · mouse ±9 px, double clicks | target size and spacing; safe double clicks |
| 11 | **Frame Perfect**: speedrunner | desktop · pad, 160 ms | input lag; swallowed presses; skill ceiling |
| 12 | **Spreadsheet**: strategy veteran, Expert mode | desktop · mouse | depth, dominant strategies, skill over luck |
| 13 | **Button Masher**: 8-year-old sibling | tablet · chaos | nothing crashes, whatever is pressed |
| 14 | **Night Owl**: hours-long sessions | desktop · pad | leaks and slowdown over fight after fight |
| 15 | **Hand-me-down**: old school laptop | 1366×768 · software GL · CPU ÷4 | frame rate; response; load time |
| 16 | **Dead Zone**: rural connection | small phone · slow 3G, then offline | first load; "No signal"; recovery |
| 17 | **Back After a Year**: returning player | desktop · old, corrupt saved data | migrations; nothing breaks on old state |
| 18 | **Art Director**: illustrator | tablet · modern picture | composition, palette, every screen pictured |
| 19 | **Second Language**: 14, ESL | desktop · mouse | reading grade; jargon; consistent words |
| 20 | **Streamer**: 3440×1440 ultrawide | pad · chat watching | spectacle; close finishes; no dead air |

## Three lanes

**Sim lane** (`scripts/studio/personas/sim.ts`). Each persona's *pilot* flies headless battles up the debrief's ladder, through `BattleSession` exactly as the soak does. A pilot is a duck-typed autopilot with that player's reaction time and an `Ai` brain for how well they read the board. It also has their habits:

- whether they guard or drift
- the kid habit of firing with the selected Command Ship (`flagshipBias`)
- distraction (`idle`) and fumbled orders (`misinput`)
- how many empty bays they know to fill (`fill`)

This lane measures what makes a fight fun or not. **Flow** is the win rate on their home rung against their band. **Pacing** is the battle length plus the longest stretch with none of their orders landing. **Tension** counts lead changes, close finishes and comebacks. **Agency** is orders that land and shots that hurt. **Variety** is the mix of orders and ships used, and stalemates. It runs 16 seeds a rung by default (`PERSONA_SEEDS`), one child process per persona. Before it plays, it checks that the ladder in `personas.json` still matches `LADDER` in `battle.ts`.

**Browser lane** (`browser.mjs`). Each persona plays the real build in headless Chrome, set up as their machine. That covers viewport and density, GPU path and CPU, network, `prefers-reduced-motion` and `prefers-contrast`, and Chrome's colour-vision emulation (screenshots carry it). It also covers game settings and saved data. They press with their own hands: the virtual pad, trusted key events, a jittery mouse or a finger, at their speed, with their slips.

Every input is watched. If the game's state doesn't change, it is a *dead input*, and three in a row is a *rage* burst. The time until the state changed is its response time.

At each checkpoint the screen is audited (`probes.mjs`):

- words and text size
- contrast against what really lies under the text (the element stack, not the parent)
- targets too small for those hands, unnamed controls, and controls covered by something else
- overflow and clipped text
- endless animations and whether focus shows
- for Narrator, the accessibility tree

Each checkpoint is also pictured, and the picture is measured for lightness, crushed blacks, blown whites, colourfulness and blank frames. Personas that check flashes or motion record a screencast during the fight. It is tested for WCAG 2.3.1 general flashes and for frame-to-frame lurch.

Live announcements are counted all run long: every change to an `aria-live`, `status`, `alert` or `log` region, which is what a screen reader would speak. A page load starts the page's count afresh, so the lane banks it before every load and after every journey. `browser.json` holds `live.changes` for the whole run, the last 30 lines in `live.sample`, and the count per journey in `live.byJourney`.

Journeys: `firstBattle`, `marathon` (three more fights; heap, nodes and listeners after GC), `tour` (every hub by mouse or touch; every cert route with a pad press), `tabwalk`, `reader`, `chaos` (160 random taps, keys, swipes, route jumps, Back and rotations), `offline` and `interrupt` (backgrounded mid-fight, then rotated).

**AI lane** (`brief.mjs`). Each persona gets `studio/reports/personas/<id>/brief.md`. It holds who they are and how they talk, their setup, what the bots saw (journeys, issues, the pictures as they see them), how to look further (`STUDIO_PERSONA=<id> pnpm shoot /route+secs` pictures any screen as that persona), and the verdict to write.

A playtester agent becomes that player and writes `<id>/verdict.json` (scores 1–10 per pillar, a one-line quote, concrete issues). `pnpm personas --score` blends the verdict in: 40% of a pillar, or 50% for fun and beauty, where bots see least. A verdict counts only for the run its `runId` names.

## Chrome and Firefox

`--engine=firefox` plays the personas listed in `personas.json › engines.firefox` in headless Firefox. `--engine=both` plays them in Chrome as well, then compares. Firefox is driven over WebDriver BiDi, which is built into Firefox, so there is no geckodriver and no new dependency. `scripts/studio/firefox.mjs` gives it the same interface as `cdp.mjs` and translates the DevTools calls the bots make (navigation, script, screenshots, mouse, touch, keys, viewport, offline), so every journey runs unchanged.

The comparison (`compareEngines` in `score.mjs`) reports, per persona:

- both engines' scores
- frame rate, jank and input response
- **efficiency**: the browser's whole process tree (GPU and content processes too) in CPU seconds per minute of play and peak memory, from `ps` (`compat.mjs › procTree`)

Firefox's frame rate falls much further than Chrome's on a busy machine. On 2026-10-14 it held 57–60 fps beside Chrome's 60 on a quiet machine, and fell to 2–15 fps while other tools loaded the machine. So a frame-rate gap is a minor issue until a run alone (`PERSONA_WORKERS=1`, quiet machine) repeats it. Errors, journeys and features compare fairly at any load; CPU and memory are best compared from the same run.

It raises an issue for anything Firefox does worse than Chrome:

- a journey that fails only in Firefox (a blocker when it is a must)
- an error seen only in Firefox
- under 85% of Chrome's frame rate, or more stutter
- 1.5× the CPU, memory, load time or response time

**Compatibility.** `compat.mjs` scans `src/` for the modern web features the game uses: `:has()`, `color-mix()`, container queries, `backdrop-filter`, WebGPU, gamepad rumble and more, about 30 in `FEATURES`. Each engine tests every feature in the page. A feature the game uses that an engine lacks is an issue: minor for CSS, or when the code checks first and goes without (`degrades`), major when a function would stop. Add a row to `FEATURES` when the game takes up something new.

Firefox can't emulate everything Chrome can. These are not measured there, and the report lists them instead of passing them:

- colour-vision filters
- the accessibility tree
- CPU and network throttling (offline works)
- screencasts, so no flash or motion checks
- JS heap size (DOM node counts still work)
- window focus: headless Firefox on macOS never holds it, so `:focus-visible` never matches and focus rings never draw. Ring checks are skipped for Firefox runs, and keyboard-only personas stay in Chrome; test keyboard play in Firefox headed. The driver does press a focused button on an uncancelled Enter or Space, as a focused Firefox would, and says so.

`prefers-contrast` is also missing. Reduced motion is a launch pref. That is why the Firefox list leaves out touch, colour-vision, keyboard-only, screen-reader, throttled and software-GL personas. `STUDIO_PERSONA=<id> STUDIO_ENGINE=firefox pnpm shoot /route` pictures a screen as that persona in Firefox.

## Scoring

Each pillar starts at 100, and every point off is written down with its reason. The report shows the reasons under each persona.

- **Stability**:
  - uncaught exceptions, renderer crashes and hangs (blockers)
  - console errors and failed loads of the site's own files
  - long tasks (scaled by the persona's CPU)
  - heap, DOM or listener growth over the marathon, and slowdown
- **Playability**:
  - journeys they must finish (a fail is a blocker and caps the pillar at 25), and other journeys and steps
  - inputs from the title to a fight, and the first shot against their patience
  - the dead-input share and rage bursts
  - p95 response, first load, and controls covered by something else
  - offline: the outage message, blank screens and recovery
- **Fun**: from the sim lane: flow 35%, pacing 20%, tension 20%, agency 15%, variety 10%. Plus a slow first shot in the browser.
- **Accessibility**:
  - contrast, text size, and target size for their input
  - unnamed controls, d-pad focus and focus rings, Tab traps, Tab reaching nothing, and the hubs reachable
  - colour pairs in their colour vision (`palettePairs`, CIEDE2000 after Machado simulation)
  - flashes, lurch and Reduce motion honoured
  - landmarks, headings and live announcements
  - reading grade and jargon (`jargon`)
  - content past the edge
- **Beauty**:
  - frame rate against the persona's machine (55 fps, or 30 on software GL)
  - jank, clipped text, layout shift and overflow
  - blank, crushed, blown, flat, washed-out or garish frames
  - overlapping controls

Each persona's overall score is the pillars weighted by their `weights`. The game's score for each pillar is the mean over personas, and the report also names the worst-served persona.

**Issues** are grouped across screens and across personas: one line per problem, listing who it hit and where. They are ranked blockers first, then by severity weight × (1 + ¼ per extra persona). **The gate** fails (exit 1) on any blocker, on a pillar more than 8 points under the saved baseline for any persona, or on a sim-lane error. `--no-gate` reports only.

## The iteration loop

This is how the studio works a round:

1. **Freeze a build** for the round: `npx vite build --outDir <scratch>/dist-rN`, then `STUDIO_DIST=` that folder. This is the same rule as every gate: a dev server reloads mid-run.
2. **`pnpm personas`**. It runs about 20 minutes with 3 browsers (`PERSONA_WORKERS`). Read the top fixes and the worst-served persona per pillar.
3. **Playtesters in parallel.** Spawn one agent per persona that the bots scored lowest (or all twenty), each handed its `brief.md`. They write verdicts on that same frozen build.
4. **`pnpm personas --score`** folds the verdicts in. Route each top fix to the specialist who owns that area (battle, screens, art), with the personas it hurt.
5. **Fix, then re-run only the personas the fix is for**: `--only=tabber,narrator`. Before anything ships, run all twenty and `--save` the baseline, so the next round is held to it.

## Adding or changing a persona

Add an object to `personas[]` in `studio/personas.json`. A new viewport goes in `views`. A new journey goes in `J` in `browser.mjs`, then in the persona's `journeys` list (a journey in `musts` that fails is a blocker). A new check flag goes in `checks` and is read in `score.mjs`. Keep each persona distinct: a new one should be the first to catch some class of problem.

## Gotchas

- **One build per run.** The lab serves `STUDIO_DIST` (or builds its own). Never point it at a dev server another agent is editing.
- **Load.** Every browser is a real Chrome with a real GPU. On a loaded machine, run `PERSONA_WORKERS=2`, and re-run a lone failure alone before believing it (see STUDIO.md).
- **Headless focus.** `cdp.mjs` emulates focus, so `:focus-visible` and rings show. The tab-walk reads computed outline and box-shadow.
- **The fun numbers are relative.** A pilot is a model of a habit, not a person. Trust the deltas between builds and between personas more than any absolute win rate, and let playtester verdicts and real players settle taste.
- **Hand-me-down runs on SwiftShader and ÷4 CPU,** so its fights take longer. Its frame-rate target is 30, not 55.
- **Firefox beside other Firefoxes.** The driver launches with `--new-instance`; without it, macOS hands the launch to any Firefox already running and the bots lose theirs.
- **A browser that dies mid-run is retried, then left unmeasured.** On a heavily loaded machine, headless Firefoxes sometimes end mid-run; the driver records the exit code, signal and last stderr lines. Such a persona is played once more. If it ends again, it is reported as not measured, never as a game blocker. Re-run those personas alone with `--only` and `PERSONA_WORKERS=1` when the machine is quieter. Firefox's frame rate also suffers more than Chrome's from several instances at once, so judge Firefox efficiency on runs with one worker.
- **WebDriver's Enter is the numpad's.** `\uE007` arrives as `NumpadEnter`, so the driver sends Return (`\uE006`), which is the main keyboard's Enter.
