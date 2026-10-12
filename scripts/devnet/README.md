# Devnet: the client's write path against a private chain

A single-node Structs chain on localhost, at the version the public testnet runs, for proving
that signing, the tx queue and the proof engine work for real. Nothing here talks to a public
network: `pnpm devnet:vite` runs the client with `VITE_GRASS_URL=off`, so not even the guild event
stream is dialled.

## 1. Build structsd at the deployed version

Without touching your checkout of the chain repo:

```bash
git -C ../structs worktree add /tmp/structs-v0.21.0 v0.21.0
(cd /tmp/structs-v0.21.0 && go build -o /tmp/bin/structsd ./cmd/structsd)   # a few minutes the first time
git -C ../structs worktree remove /tmp/structs-v0.21.0
```

(`/cosmos/base/tendermint/v1beta1/node_info` on the testnet says which tag to build.)

## 2. Chain

```bash
export STRUCTSD=/tmp/bin/structsd
pnpm devnet            # = setup.sh all: init + start + bootstrap
pnpm devnet env        # addresses, player ids, URLs
pnpm devnet stop
```

- Ports: RPC 36657, LCD 31317, gRPC 39090, P2P 36656 (all 127.0.0.1; override with RPC_PORT etc.).
- `init` writes genesis with the repo's `config.yml` dev overrides (ualpha everywhere,
  `guildCharterDifficultyRange 2`, `guildCharterReactorAge 5`), LCD on with unsafe CORS, RPC
  `cors_allowed_origins ["*"]`, `timeout_commit` = `$BLOCK_TIME` (default 1s).
- `bootstrap` follows `tests/test_chain.sh`: alice (genesis validator) makes an allocation and a
  substation and founds guild `0-1` through the reactor's proof-free charter; a fresh test mnemonic
  (`.home/test-mnemonic.txt`) gets HD index 0 and 1 funded by bob, delegated (the staking hook
  creates the player) and joined to the guild; index 2 is funded but never a player; alice explores
  a planet to be a target.
- Faster clock for the long proofs (mining is range 14000, refining 28000): stop, set
  `timeout_commit = "150ms"` in `.home/config/config.toml`, start (~3–5 blocks/s).

## 3. Client

```bash
pnpm devnet:vite                     # http://127.0.0.1:5186, HMR off (other edits won't reload the page mid-tx)
node scripts/devnet/cdp.mjs          # headless Chrome + control server on 127.0.0.1:9555
node scripts/devnet/e2e.mjs --wait-proof
```

`cdp.mjs` keeps one Chrome (profile in `$PROFILE` or a temp dir, so `/reload` keeps the vault and
the queue). Drive it by hand with curl:

```bash
curl -s localhost:9555/eval --data-binary @scripts/devnet/helpers.js       # window.e2e helpers
curl -s localhost:9555/eval -d 'JSON.stringify(e2e.jobs())'
curl -s localhost:9555/eval -d 'e2e.traceJobs()'                           # record every job transition with heights
curl -s localhost:9555/cdp -d '{"method":"Network.setBlockedURLs","params":{"urls":["*/cosmos/tx/v1beta1/txs"]}}'
curl -s localhost:9555/shot -d /tmp/x.png ; curl -s localhost:9555/logs ; curl -s localhost:9555/quit
```

The vault passphrase the scripts use is `devnet-pass-123`.

## 4. Guild flows (signup, replicants) without a real guild stack

- `mock-guild.mjs` is a dependency-free Guild API for one devnet guild: `/guild.json`, `/api/timestamp`,
  `/api/guild/this`, `/api/auth/signup` (202, then the guild owner's key broadcasts
  `guild-membership-join-proxy <address> <pubkey> <signature> --player-name <username>`), `/api/auth/login`
  (cookie session), `/api/auth/logout`, `/api/auth/player-address/<a>/guild/<g>/player-id`.
  `setup.sh all` starts it on 127.0.0.1:31318 (log `.home/mock-guild.log`) and points guild `0-1`'s
  on-chain endpoint at `http://127.0.0.1:31318/guild.json`. A second guild: `GUILD_ID=0-2 GUILD_SIGNER=<key>
  node scripts/devnet/mock-guild.mjs 31319` and update that guild's endpoint.
- The page calls the mock guild directly, as it calls any guild: the mock answers CORS (with
  credentials) for pages on this machine, and the page accepts a loopback guild only while it and the
  chain are both on loopback. Open the devnet at http://127.0.0.1:5186, not localhost: the mock's
  session cookie is `SameSite=Lax` like a real guild's, so the browser sends it only within the same
  site, and 127.0.0.1 on any port is one site.
- `pnpm devnet:vite` runs with `VITE_GRASS_URL=off` (no public GRASS feed).
