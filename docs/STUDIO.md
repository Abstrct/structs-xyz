# The studio

How Structs is made: one art bible, a set of gates every build passes, and the tools that measure them. Everything here runs on a laptop and in CI.

## Art bible: the DC kit

The design canvas **Structs Dreamcast Direction** holds the kit and the key screens (title, menu, battle HUD, base). In code it is `src/styles/dc.css`, `src/ui/icons.ts`, `src/ui/vmu.ts` and the Dreamcast picture in `src/core/engine.ts`.

- **Show it, don't say it.** Icons and numbers come first. A label is one to three words, and screens carry no paragraphs. Explanations live in hover titles, in the `?` card, and in Expert mode (`x-only`); none of them are deleted.
- **Ground and glass.** A night-blue ground (`#0B1240`) under glass-blue rounded panels with a gloss along the top. There is one orange accent (`#FF6A13`, `--dc-accent`), which is also the focus cursor.
- **The logo is Structs' own.** The Structs chevron (`MARK` in `src/ui/icons.ts`, the same emblem as the app icon) beside the STRUCTS wordmark, in the top bar, on the title and on the boot screen. The kit borrows the console's feel, never its logo.
- **Face buttons are verbs.** A (red) goes, B (blue) backs out, X (yellow) is the alternate, Y (green) opens the menu. The same color does the same job on every screen, and `.dc-face.a|b|x|y` draws the badge. A badge always sits next to a word or icon, never alone, because on a touch-only screen badges are hidden until a pad is used (`body.pad`).
- **Type.** Exo 2 Black Italic for labels and numbers, M PLUS Rounded for words. Both are OFL fonts kept in `public/fonts`.
- **Hardware.**
  - The 3D view draws about 480 lines (the console's 640×480) in 16-bit color with a 4×4 ordered dither, scaled up crisp.
  - There is no film grain, lens streak or chromatic aberration.
  - Settings › Dreamcast picture switches to the modern full-resolution grade.
- **The controller.** Any standard gamepad plays the whole game (`src/core/pad.ts`):
  - A presses the control in focus, or Enter. B is Escape.
  - X is guard, Y is drift, L/R are previous/next ship, Start is Space.
  - Back is the Menu button: it jumps to the hubs in the top bar from any screen, even one that keeps the d-pad for itself (replay stepping, unit browsing). In a window on top it backs out instead. `?` help is the bar's ? button.
  - The d-pad aims in battle and moves focus elsewhere.
  - On a keyboard, arrows aim and Enter fires.
  - Hits and blasts rumble a pad that supports it, like the Jump Pack.
- **The VMU.** A 48×32 one-bit screen in the top bar shows your pinned commander's mood, charge and ore at risk as pixels. With no commander pinned it keeps a pet: an egg that hatches with your first win, grows up after five wins, and shows a heart after each victory. It flashes and chirps when it hatches or grows. Tapping it names what it shows.
- **Waiting looks like receiving.** While the testnet answers, a screen shows its outline under a sweeping scan, a signal meter where each number will land, and a "Receiving" pill (`src/styles/dc-polish.css`, the `.dcp-*` kit). Values kept from a last visit show dimmed and say so (LAST VISIT), never as live. When the chain can't be reached, the screen says "No signal" and offers the way on.
- **No hover, no guessing.** Where nothing can hover (touch, a pad in hand), stat icons carry their word, small, beside the number (`.dcb-cap`, `.dw-cap`). Ships the armed weapon can hit wear breathing red brackets that face the camera, and a tap reaches the nearest ship within 44 px.
- **Touch peek.** On a touch screen, tapping anything with a hover title (an icon, a number, a stat tile) shows that title for a moment (`src/ui/peek.ts`). Put the explanation in `title` and touch players get it too.
- **Teach by doing.** The first battle is coached: one short callout per step, pinned near the control it is about, and the clock waits for you. Results show the XP bar filling toward the next rank.
- **The hubs are named.** Each hub in the top bar is its icon and its one-word name. When the bar runs short of room only the hub you're in keeps its name, then none do (`src/styles/dc-nav.css`, stepped by `data-fit` in `main.ts`).
- **Phones.** Held upright, the six hubs become a bar along the bottom, under the thumb, each an icon over its name; a hub's menu rises from it as a sheet. The top bar keeps the logo, the VMU, the vault and More; the Academy and chat move into More. A fight takes the whole screen (the bar steps away while the battle HUD is up), and the battle deck packs closer (`FIELD.compact` in `src/screens/battle/env.ts`) so the ships draw about a third bigger.
  - Everything a phone needs lives in `src/styles/mobile.css`, loaded last. That covers the safe-area insets for notches and home indicators, the visible height (`--vh`, which is `100dvh`), taps without double-tap zoom, and touch layouts.
  - Every rule there is either zero on a desktop or scoped to touch (`pointer: coarse` / `hover: none`). Width alone isn't enough, because the 640×480 TV view is narrow too.
  - Code follows the same rule: `touchScreen()` and `touchWords()` in `src/core/touch.ts`, and `inputMode()` in battle.
  - After a phone change, `pnpm layout` (STUDIO_VIEW=desktop and tv) proves the desktop and TV frames didn't move.

## Gates

`pnpm studio` runs them all in order and writes `studio/reports/index.html`. `pnpm studio --quick` runs a short pass (a smaller soak and a desktop-only cert, no parity). `--only=cert,playtest` picks stages, and `--smoke` adds the live-testnet smoke test.

| Gate | Tool | Fails on |
|---|---|---|
| lint | `tsc` (game and tools) | any type error |
| unit | `pnpm test` (15 suites) | any failed assertion |
| parity | `pnpm test:parity` | the combat port drifting from the original simulator |
| soak | `pnpm soak` (`scripts/studio/soak.test.ts`) | an exception or broken invariant (health, charge, destroyed units acting, slots, guards), nondeterminism (replay and refight must match exactly), or an unfinished battle in about 400 seeded AI-vs-AI battles |
| build | `vite build` | a build error, or a bundle over `studio/budgets.json` › `bundle` |
| cert | `pnpm cert` (`scripts/studio/cert.mjs`) | an exception or console error, a screen that never mounts (it waits out the boot screen first, so a loaded machine doesn't measure NOW LOADING), a blank 3D view, or anything running past the right edge, on any screen at TV (640×480), desktop or phone. Also over budget on words, tiny targets, unnamed controls, triangles or text size: these are listed in `budgets.json › enforce` and fail. FPS only warns, since CI draws on a software GPU. |
| padtour | `pnpm padtour` (`scripts/studio/padtour.mjs`) | the playtest's virtual-controller bot, using only the d-pad, A and Back, failing to reach any hub tile from the title, or a tile landing anywhere but the screen its link names |
| playtest | `pnpm playtest` (`scripts/studio/playtest.mjs`) | the bot, holding a virtual controller, failing to get from the title to a finished battle: PRESS START, Battle door, Start, then A until the debrief. On the phone it then puts the pad down and plays by touch (tap Again, a weapon, an enemy, the card's Fire): the shot must go in. |
| layout (opt-in, `--layout`, local only) | `pnpm layout` (`scripts/studio/layout.mjs`) | the desktop or TV frame (top bar, hubs, panels, bars, buttons) moving more than 2 px from the baseline saved with `--save`. Run it after any phone-only change. Not in CI, because a Linux runner's fonts measure differently. |
| smoke | `pnpm smoke` | a screen without chain data online, without an outage message offline, or not recovering when the testnet returns |

### Cert budgets (`studio/budgets.json`)

- **words**: visible words on a screen at desktop and TV sizes (numbers are free). The default is 40, and reading screens (Academy, Code Lab, News) get 90.
- **minFontPx**: the smallest text a player must read.
- **tiny**: buttons smaller than 24 px (40 px on touch screens).
- **tris / calls**: one frame's GPU cost, summed over every pass (`Engine.stats`). 60k triangles is the Dreamcast's ~3M polygons a second at 50–60 fps.
- **fps**: two seconds of frames at desktop size.

Routes can also name an in-play state after `#`, defined in `budgets.json › states` as an action plus a wait. `/sim#fight` is a battle nine seconds in, and `/galaxy#hud` is the live galaxy with the title closed. This way the screens players spend their time on are measured, not just the first arrival.

The first cert run is the baseline (`studio/baseline/cert.json`), and every report shows each number's change against it. `STUDIO_BASELINE=1 pnpm cert` saves a new one.

## Tools

- `pnpm shoot /route@tv+9 /sim@phone` saves screenshots to `studio/reports/shots/` for art review.
  - `STUDIO_EVAL` runs a page action first, and `STUDIO_AFTER` waits that many ms after it.
- `STUDIO_URL=http://localhost:5173` points cert, shoot and playtest at a running dev server instead of a fresh build. A dev server hot-reloads while files change, so use a build for gate runs. It also injects CSS in import order, while the build links CSS chunks in its own order. A rule that wins in dev can lose in the build: `.panel-screen` lost to `.screen` and slid eight screens under the top bar. Selectors that must win carry the extra class (`.screen.panel-screen`), and gates always run on a build.
- `SOAK_N`, `SOAK_SEED` and `SOAK_ONLY=17,58` size the soak and replay single failing battles. Every failure prints its repro line.
- The soak doubles as the balance lab, since its tables give win rates by preset, difficulty and gauntlet round. Jobs `38 + 43k` are gauntlet runs, and the gauntlet's five rounds were tuned on them so it ramps: the Hard autopilot clears round 3 about two runs in three and round 4 about half the time, and round 5 is the boss.
- Headless Chrome uses the real GPU on a Mac (ANGLE Metal) and SwiftShader elsewhere; `STUDIO_GL` overrides it.
- **CI's speed, here.** `STUDIO_GL=swiftshader STUDIO_CPU_THROTTLE=20` draws at CI's 1–3 fps on a Mac. Use it before trusting a bot or a timing change: a gate that only passes at 60 fps will fail in CI.
- **The bots' controller** (`PAD_STUB` and `padPress` in `scripts/studio/cdp.mjs`): a press is a pulse that exactly one of `pad.ts`'s polls sees. Never hold a bot's button for "N frames". At a few fps that outlasts the d-pad's 320 ms auto-repeat, and one RIGHT becomes two.

## Roles

The studio works as a lead plus parallel specialists, each with a written brief, a scope of files, and the gates above as the definition of done.

- **Design** keeps the art bible on the design canvas.
- **Art/UX** passes take one area of screens each, add their CSS in `src/styles/dc-<area>.css`, and report words before and after.
- **QA** owns the soak, the playtest bot and the cert.
- **Review** runs scoped read-only reviewers after each big change. They look for concrete bugs with file:line and a failing scenario.

## CI

`.github/workflows/ci.yml` runs typecheck, the tests and both builds on every push and pull request. The `studio` job runs soak, build, cert and playtest under SwiftShader and keeps `studio/reports` as an artifact for 14 days.
