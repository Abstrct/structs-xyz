# CI and deploy: GitHub Actions → GitHub Pages

How structs.xyz is checked and shipped. There are two workflows in `.github/workflows/`, no
secrets, and no server of our own. The site is static files on GitHub Pages; the page talks to the
chain and the guilds directly.

| Workflow | File | Runs on | Does |
|---|---|---|---|
| **CI** | `ci.yml` | every PR, push to `main`, manual | Typecheck, tests, two builds, then the studio gates and the smoke test in parallel |
| **Deploy to GitHub Pages** | `pages.yml` | push to `main`, manual | Typecheck, tests, build with repo variables, publish `dist/` to Pages |

The two run on their own: **the deploy doesn't wait for CI**. It repeats typecheck and tests, so a
red unit test still blocks the release. A failing studio or smoke job does **not** block it.

```
push to main ──┬─► CI ── check ──┬─► studio   (soak, build+budgets, cert, playtest, padtour)
               │                 └─► smoke    (every screen in headless Chrome vs. live testnet)
               │
               └─► Pages ── build (typecheck, test, vite build + prerender) ──► deploy-pages
```

---

## 1. Toolchain (the same in every job)

```yaml
- uses: actions/checkout@v7
- uses: pnpm/action-setup@v6        # pnpm version comes from package.json "packageManager" (pnpm@9.15.9)
- uses: actions/setup-node@v7
  with: { node-version: 24, cache: pnpm }
- run: pnpm install --frozen-lockfile
```

- Node 24, pnpm pinned through `packageManager`, and a lockfile-exact install.
- Runtime dependencies are only `three` plus the noble/scure crypto libraries, so installs are quick.
- Everything runs on `ubuntu-latest`. There's no Docker in CI.

## 2. What `pnpm build` is

```
tsc --noEmit  &&  vite build  &&  tsx scripts/prerender.ts
```

1. **Typecheck** the app.
2. **Vite build** into `dist/`. `three.js` goes into its own long-cached chunk, and assets are
   hashed under `dist/assets/`.
3. **Prerender** (`scripts/prerender.ts`): a real HTML page for every route, built from the shell
   plus that route's title, description, canonical URL, Open Graph tags and a text body.
   - Route lists come from `src/data/seo.ts`, the codex, the academy and the glossary.
   - It also writes `sitemap.xml`, fills in `robots.txt`, and writes **`404.html`**.

`404.html` is how routing works on Pages. Pages has no rewrites, so a route with no prerendered page
(`/planet/2-7`) is served `404.html`. That file is the app shell, and the app routes itself.

### Base path

The build can live at the root of a domain (`/`) or under a project-page path (`/structs-xyz/`).

- `VITE_SITE_URL` sets both the full address (canonical, OG, sitemap) and the **base path**, which is
  its URL path. `VITE_BASE` overrides the base path on its own.
- `vite.config.ts` and `scripts/prerender.ts` work out the base the same way.
- **Prerender refuses a mismatched build.** If `dist/index.html` asset URLs don't start with the
  expected base, the build fails instead of shipping broken links.

### Build-time settings (`VITE_*`)

These are baked into the bundle. They can't be changed at runtime without a rebuild.

| Variable | Default (unset) | Purpose |
|---|---|---|
| `VITE_SITE_URL` | `https://structs.xyz` (locally); on Pages, the Pages address | Canonical, OG, sitemap, base path |
| `VITE_LCD_URL` | `https://public.testnet.structs.network` | Chain REST |
| `VITE_RPC_URL` | derived from `VITE_RPC_WS_URL` (`wss`→`https`, `/websocket` dropped) | Chain RPC over HTTP (block history) |
| `VITE_RPC_WS_URL` | `wss://public.testnet.structs.network:26657/websocket` | Live blocks |
| `VITE_GRASS_URL` | `wss://beta.playstructs.com:1443` | Guild event stream (`off` disables it) |
| `VITE_DEFAULT_GUILD` | `0-5` | Guild whose infrastructure backs the client by default |

---

## 3. CI workflow (`ci.yml`)

```yaml
on: { push: { branches: [main] }, pull_request: {}, workflow_dispatch: {} }
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }   # new push cancels the old run
```

### `check` (20 min): the gate the other jobs wait for

| Step | What |
|---|---|
| `pnpm typecheck` | `tsc` for the app **and** for `scripts/` |
| `pnpm test` | About 20 `tsx` suites, plain Node with no test framework. They cover rules/sim, combat, store, wallet, proof-of-work, GPU, data, direct guild calls, session, galaxy, chat, economy, planet actions, learning, base path, droid, lobby and hulls. |
| `pnpm build` | Root build (custom domain or container) |
| Build under a project path | `VITE_SITE_URL=https://example.github.io/structs-xyz pnpm build`, then asserts `dist/404.html` and `dist/codex/index.html` exist |

Building twice proves the site works both on a custom domain and as `<owner>.github.io/<repo>`,
which is what a fork gets.

### `studio` (40 min, after `check`): the game's own quality gates

```yaml
env: { CI: true }
- run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   # let Chrome's sandbox start on Ubuntu 24.04
- run: pnpm studio --only=soak,build,cert,playtest,padtour
- uses: actions/upload-artifact@v7   # if: always()
  with: { name: studio-reports, path: studio/reports, retention-days: 14 }
```

`scripts/studio/run.mjs` runs each gate and writes `studio/reports/index.html`. It exits 1 if any
gate fails.

| Gate | Checks |
|---|---|
| `soak` | Hundreds of seeded AI-vs-AI battles: invariants, determinism, balance |
| `build` | Production build; gzipped entry and total bundle size measured against `studio/budgets.json` |
| `cert` | Every route in `budgets.json` at TV, desktop and phone sizes: visible word count, min font 11 px, tap targets (24 px fine / 40 px coarse), frame cost. Budgets under `enforce` fail; fps only warns, because CI renders with SwiftShader (a software GPU). |
| `playtest` | A bot with a virtual controller plays from the title screen to a finished battle |
| `padtour` | The same bot reaches every hub tile using only the d-pad, A and Back |

These gates run headless Chrome with SwiftShader, so new procedurally baked art must stay small
enough not to stall it.

Download the reports from the run page under **Artifacts → studio-reports**.

### `smoke` (40 min, after `check`): end-to-end against the live testnet

```yaml
- run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
- run: pnpm smoke                           # SMOKE_SHOTS=smoke-shots
- run: node scripts/smoke.mjs               # SMOKE_QUICK=1, VITE_SITE_URL=https://example.github.io/structs-xyz
- uses: actions/upload-artifact@v7          # if: failure() → smoke-shots, 7 days
```

`scripts/smoke.mjs` builds into its own directory, serves it, and opens every screen in headless
Chrome:

- at desktop and phone sizes,
- with the testnet unreachable,
- with the testnet coming back mid-visit.

A check fails on:

- an uncaught exception, `console.error` or resource error,
- a screen that never mounts,
- horizontal overflow,
- a blank 3D view,
- a live screen with no chain data online, no outage message offline, or no recovery.

The second run serves the site under `/structs-xyz/`, and **any request outside the base 404s and
fails the check**. That catches hard-coded root paths.

It depends on the public testnet, so it can go red when the testnet is down. That's why it doesn't
block the deploy. Without Chrome or Node 22+ it skips, and with `CI` set a skip counts as a failure.

---

## 4. Deploy workflow (`pages.yml`)

```yaml
on: { push: { branches: [main] }, workflow_dispatch: {} }
permissions: { contents: read, pages: write, id-token: write }   # id-token: OIDC for deploy-pages
concurrency: { group: pages, cancel-in-progress: false }         # queue, never cancel a publish mid-way
```

**`build` job:**

1. Install the toolchain.
2. `actions/configure-pages@v6` reads the Pages address: the custom domain, or
   `https://<owner>.github.io/<repo>`.
3. `pnpm typecheck && pnpm test`.
4. `pnpm build`, with:

   ```yaml
   VITE_SITE_URL: ${{ vars.VITE_SITE_URL || steps.pages.outputs.base_url }}
   VITE_LCD_URL / VITE_RPC_URL / VITE_RPC_WS_URL / VITE_GRASS_URL / VITE_DEFAULT_GUILD: ${{ vars.* }}
   ```

   Unset variables become empty strings, and the code falls back to the public-testnet defaults.
5. `actions/upload-pages-artifact@v5` with `path: dist`.

**`deploy` job:** `actions/deploy-pages@v5` into the `github-pages` environment. The run page links
to the live URL.

### One-time repository setup

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.** Not "Deploy from a branch".
2. Optional custom domain: **Settings → Pages → Custom domain**. Add DNS for it (`CNAME` to
   `<owner>.github.io`, or the apex A/AAAA records) and enable **Enforce HTTPS**. With Actions
   deploys the domain lives in the Pages settings. The `CNAME` file at the repo root isn't used,
   because only `dist/` is published.
3. Optional variables: **Settings → Secrets and variables → Actions → Variables**, for any
   `VITE_*` listed above. Use them to point a fork at another chain or guild, or to force
   `VITE_SITE_URL`.
4. No secrets are needed. The deploy authenticates with the workflow's OIDC token.

A fork with no custom domain deploys to `https://<owner>.github.io/<repo>/`. The base path follows
automatically, and CI has already proven that layout works.

---

## 5. The other way to ship: the container

The same build, served by a dependency-free Node server, for hosting outside Pages:

```bash
docker build -t structs-xyz --build-arg VITE_SITE_URL=https://play.example.org .
docker run --rm -p 8080:8080 structs-xyz
```

- A two-stage `Dockerfile`: `node:24-slim` runs `pnpm build`, then `node:24-alpine` runs
  `server/serve.mjs` as user `node`.
- `VITE_*` values are `--build-arg`s, because they're baked in at build time.
- `server/serve.mjs` serves `dist/` with brotli/gzip, cache headers, prerendered pages by path and
  the shell for other routes. It answers `GET /healthz`, which the Dockerfile's `HEALTHCHECK` uses.
  It only serves files.
- Locally: `pnpm build && pnpm start`, which listens on `http://localhost:8080`.

CI doesn't build or push the image. It's there for anyone who wants to host it themselves.

---

## 6. What isn't in CI

| Thing | Where it runs | Why |
|---|---|---|
| OG and README images (`public/og/*.jpg`, `docs/*.jpg`) | Locally: `pnpm docshots`, `scripts/studio/ogshots.mjs`; results are committed | Needs a real GPU for good-looking shots |
| `pnpm test:parity` | Locally | Compares the combat port with the original simulator |
| Devnet end-to-end (`scripts/devnet/`) | Locally | Needs a `structsd` binary and a private chain |
| `pnpm studio --smoke` | Locally | Same as the CI smoke job, inside the studio report |

## 7. Reproducing CI on your machine

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build
VITE_SITE_URL=https://example.github.io/structs-xyz pnpm build   # project-page build
pnpm studio --only=soak,build,cert,playtest,padtour              # report at studio/reports/index.html
pnpm smoke                                                       # needs Chrome and the testnet
```

Run the studio gates on a build, not against the HMR dev server. The scripts above build for you.
