#!/usr/bin/env bash
# A private single-node Structs devnet for exercising the client's write path end to end.
# Everything binds to localhost on non-default ports (a local testnet node often holds
# 26656/26657/1317), and nothing here ever talks to a public network.
#
#   STRUCTSD=/path/to/structsd scripts/devnet/setup.sh all     # init + start + bootstrap
#   scripts/devnet/setup.sh init | start | bootstrap | stop | status | env
#
# Build the binary at the deployed chain version first (see README.md). State lives in
# $DEVNET_HOME (default scripts/devnet/.home); `init` wipes it.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
STRUCTSD="${STRUCTSD:-structsd}"
H="${DEVNET_HOME:-$DIR/.home}"
CHAIN_ID="${CHAIN_ID:-structs-devnet-1}"
RPC_PORT="${RPC_PORT:-36657}"
P2P_PORT="${P2P_PORT:-36656}"
API_PORT="${API_PORT:-31317}"
GRPC_PORT="${GRPC_PORT:-39090}"
BLOCK_TIME="${BLOCK_TIME:-1s}"
NODE="tcp://127.0.0.1:${RPC_PORT}"
KR=(--home "$H" --keyring-backend test)
TXF=(--home "$H" --keyring-backend test --chain-id "$CHAIN_ID" --node "$NODE" --gas auto --gas-adjustment 1.5 --output json --yes)
Q=(--home "$H" --node "$NODE" --output json)

log() { printf '\033[36m-> %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m!! %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "needs $1"; }
need jq
"$STRUCTSD" version >/dev/null 2>&1 || die "STRUCTSD=$STRUCTSD is not runnable"

height() { curl -s "http://127.0.0.1:${RPC_PORT}/status" | jq -r '.result.sync_info.latest_block_height // 0' 2>/dev/null || echo 0; }
wait_height() {
  local want=$1 i=0
  while [ "$(height)" -lt "$want" ]; do
    sleep 0.5; i=$((i+1))
    if [ $i -gt 600 ]; then die "chain stuck below $want"; fi
  done
}

# Broadcast, then follow the hash into a block: a sync broadcast's code 0 only means "in the mempool".
tx() {
  local out hash r i
  out=$("$STRUCTSD" tx "$@" "${TXF[@]}" 2>&1) || die "tx $* failed before broadcast: $(echo "$out" | tail -1)"
  out=$(echo "$out" | grep '^{' | tail -1)   # --gas auto prints "gas estimate: N" first
  hash=$(echo "$out" | jq -r '.txhash // empty' 2>/dev/null) || true
  [ -n "$hash" ] || die "tx $*: no hash: $(echo "$out" | tail -1)"
  [ "$(echo "$out" | jq -r '.code // 0')" = 0 ] || die "tx $* refused: $(echo "$out" | jq -r .raw_log)"
  for i in $(seq 1 40); do
    r=$("$STRUCTSD" query tx "$hash" "${Q[@]}" 2>/dev/null) && break
    sleep 0.5
  done
  [ -n "${r:-}" ] || die "tx $* ($hash) never landed"
  [ "$(echo "$r" | jq -r '.code // 0')" = 0 ] || die "tx $* failed in block: $(echo "$r" | jq -r .raw_log)"
  log "ok  $1 $2  h=$(echo "$r" | jq -r .height) $hash"
  sleep 1.2   # one tx per address per block (structs ante 2041)
}
addr() { "$STRUCTSD" keys show "$1" -a "${KR[@]}"; }
player_of() { "$STRUCTSD" query structs address "$1" "${Q[@]}" | jq -r '.playerId // empty'; }

cmd_init() {
  log "fresh devnet home at $H"
  pkill -f "structsd start --home $H" 2>/dev/null || true
  rm -rf "$H"
  "$STRUCTSD" init devnode --chain-id "$CHAIN_ID" --home "$H" >/dev/null 2>&1
  "$STRUCTSD" config set client chain-id "$CHAIN_ID" --home "$H" >/dev/null 2>&1 || true
  "$STRUCTSD" config set client keyring-backend test --home "$H" >/dev/null 2>&1 || true

  # Test mnemonic for the browser vault (index 0 = commander, index 1 = second identity).
  # Generated per devnet so it is never a real wallet.
  local mn
  mn=$("$STRUCTSD" keys add scratch --dry-run --output json "${KR[@]}" | jq -r .mnemonic)
  printf %s "$mn" > "$H/test-mnemonic.txt"   # --source chokes on a trailing newline
  for k in alice bob; do "$STRUCTSD" keys add "$k" "${KR[@]}" >/dev/null 2>&1; done
  "$STRUCTSD" keys add tp0 --recover --index 0 --source "$H/test-mnemonic.txt" "${KR[@]}" >/dev/null 2>&1
  "$STRUCTSD" keys add tp1 --recover --index 1 --source "$H/test-mnemonic.txt" "${KR[@]}" >/dev/null 2>&1
  "$STRUCTSD" keys add tp2 --recover --index 2 --source "$H/test-mnemonic.txt" "${KR[@]}" >/dev/null 2>&1

  # Genesis: the repo's config.yml overrides (ualpha everywhere, dev-sized guild charter).
  local g="$H/config/genesis.json"
  jq '
    .app_state.staking.params.bond_denom = "ualpha"
    | .app_state.crisis.constant_fee.denom = "ualpha"
    | .app_state.gov.params.min_deposit = [{denom:"ualpha",amount:"10000000"}]
    | .app_state.gov.params.expedited_min_deposit = [{denom:"ualpha",amount:"50000000"}]
    | .app_state.gov.params.max_deposit_period = "120s"
    | .app_state.gov.params.voting_period = "120s"
    | .app_state.gov.params.expedited_voting_period = "60s"
    | .app_state.slashing.params.signed_blocks_window = "35000"
    | .app_state.slashing.params.min_signed_per_window = "0.05"
    | .app_state.structs.params.guildCharterDifficultyRange = "2"
    | .app_state.structs.params.guildCharterReactorAge = "5"
    | .app_state.bank.denom_metadata = [{name:"alpha",description:"Alpha Matter",base:"ualpha",display:"alpha",symbol:"ALPHA",
        denom_units:[{denom:"ualpha",exponent:0},{denom:"malpha",exponent:3},{denom:"alpha",exponent:6}]}]
  ' "$g" > "$g.tmp" && mv "$g.tmp" "$g"
  "$STRUCTSD" genesis add-genesis-account "$(addr alice)" 400000000ualpha --home "$H" >/dev/null
  "$STRUCTSD" genesis add-genesis-account "$(addr bob)" 400000000ualpha --home "$H" >/dev/null
  "$STRUCTSD" genesis gentx alice 100000000ualpha --chain-id "$CHAIN_ID" "${KR[@]}" >/dev/null 2>&1
  "$STRUCTSD" genesis collect-gentxs --home "$H" >/dev/null 2>&1
  "$STRUCTSD" genesis validate --home "$H" >/dev/null 2>&1 || "$STRUCTSD" genesis validate-genesis --home "$H"

  # Node config: LCD on, CORS open (the browser talks straight to it), fast blocks, local ports.
  local app="$H/config/app.toml" cfg="$H/config/config.toml"
  sed -i '' -e 's/^minimum-gas-prices = .*/minimum-gas-prices = "0ualpha"/' "$app"
  # [api] section: enable + unsafe cors + address
  awk -v api="tcp://127.0.0.1:${API_PORT}" -v grpc="127.0.0.1:${GRPC_PORT}" '
    /^\[/ { sec=$0 }
    sec=="[api]" && /^enable = / { $0="enable = true" }
    sec=="[api]" && /^address = / { $0="address = \"" api "\"" }
    sec=="[api]" && /^enabled-unsafe-cors = / { $0="enabled-unsafe-cors = true" }
    sec=="[grpc]" && /^address = / { $0="address = \"" grpc "\"" }
    sec=="[grpc-web]" && /^enable = / { $0="enable = false" }
    { print }' "$app" > "$app.tmp" && mv "$app.tmp" "$app"
  awk -v rpc="tcp://127.0.0.1:${RPC_PORT}" -v p2p="tcp://127.0.0.1:${P2P_PORT}" -v bt="$BLOCK_TIME" '
    /^\[/ { sec=$0 }
    sec=="[rpc]" && /^laddr = / { $0="laddr = \"" rpc "\"" }
    sec=="[rpc]" && /^cors_allowed_origins = / { $0="cors_allowed_origins = [\"*\"]" }
    sec=="[rpc]" && /^pprof_laddr = / { $0="pprof_laddr = \"\"" }
    sec=="[p2p]" && /^laddr = / { $0="laddr = \"" p2p "\"" }
    sec=="[consensus]" && /^timeout_commit = / { $0="timeout_commit = \"" bt "\"" }
    sec=="[consensus]" && /^timeout_propose = / { $0="timeout_propose = \"1s\"" }
    { print }' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"
  "$STRUCTSD" config set client node "$NODE" --home "$H" >/dev/null 2>&1 || true
  log "genesis ready (chain-id $CHAIN_ID)"
}

cmd_start() {
  if [ "$(height)" -gt 0 ]; then
    # Something answers on our RPC port: fine if it is this home's node, fatal if it is another devnet.
    if pgrep -f "structsd start --home $H\$" >/dev/null; then log "already running at height $(height)"; return; fi
    die "another node holds 127.0.0.1:${RPC_PORT} (a different DEVNET_HOME?): stop it first"
  fi
  log "starting structsd (log: $H/node.log)"
  nohup "$STRUCTSD" start --home "$H" > "$H/node.log" 2>&1 &
  echo $! > "$H/node.pid"
  wait_height 2
  log "chain up: RPC http://127.0.0.1:${RPC_PORT}  LCD http://127.0.0.1:${API_PORT}"
}

cmd_stop() {
  if [ -f "$H/mock-guild.pid" ]; then kill "$(cat "$H/mock-guild.pid")" 2>/dev/null || true; rm -f "$H/mock-guild.pid"; fi
  if [ -f "$H/node.pid" ]; then kill "$(cat "$H/node.pid")" 2>/dev/null || true; rm -f "$H/node.pid"; fi
  pkill -f "structsd start --home $H" 2>/dev/null || true
  log "stopped"
}

cmd_bootstrap() {
  wait_height 2
  local alice bob val p1 cap alloc sub reactor eligible guild
  alice=$(addr alice); bob=$(addr bob)
  val=$("$STRUCTSD" query staking validators "${Q[@]}" | jq -r '.validators[0].operator_address')
  p1=$(player_of "$alice"); [ -n "$p1" ] || die "alice has no player (genesis validator should)"
  log "alice = player $p1"

  # Alice: allocation → substation → guild (the reactor's proof-free charter, per tests/test_chain.sh).
  if [ "$("$STRUCTSD" query structs player "$p1" "${Q[@]}" | jq -r '.Player.guildId // ""')" = "" ]; then
    alloc=$("$STRUCTSD" query structs allocation-all "${Q[@]}" | jq -r --arg p "$p1" '[(.Allocation // [])[] | select(.sourceObjectId==$p)] | last | .id // empty')
    if [ -z "$alloc" ]; then
      cap=$("$STRUCTSD" query structs player "$p1" "${Q[@]}" | jq -r '.gridAttributes.capacity')
      tx structs allocation-create "$p1" "$cap" --allocation-type dynamic --from alice
      alloc=$("$STRUCTSD" query structs allocation-all "${Q[@]}" | jq -r --arg p "$p1" '[(.Allocation // [])[] | select(.sourceObjectId==$p)] | last | .id')
    fi
    sub=$("$STRUCTSD" query structs allocation "$alloc" "${Q[@]}" | jq -r '.Allocation.destinationId // empty')
    if [ -z "$sub" ]; then
      tx structs substation-create "$p1" "$alloc" --from alice
      sub=$("$STRUCTSD" query structs allocation "$alloc" "${Q[@]}" | jq -r '.Allocation.destinationId')
    fi
    reactor=$("$STRUCTSD" query structs reactor-all "${Q[@]}" | jq -r '.Reactor[0].id')
    eligible=$("$STRUCTSD" query structs reactor-all "${Q[@]}" | jq -r '.Reactor[0].guildCharterEligibleHeight // 0')
    wait_height "$eligible"
    tx structs guild-create "$reactor" "devnet.local" "$sub" --from alice
  fi
  reactor=$("$STRUCTSD" query structs reactor-all "${Q[@]}" | jq -r '.Reactor[0].id')
  guild=$("$STRUCTSD" query structs player "$p1" "${Q[@]}" | jq -r '.Player.guildId')
  log "guild $guild on reactor $reactor"
  # Point the guild at the mock Guild API (scripts/devnet/mock-guild.mjs) so the client's guild
  # flows (signup, replicants) have something to talk to (the page calls it directly).
  local ep="http://127.0.0.1:${MOCK_GUILD_PORT:-31318}/guild.json"
  if [ "$("$STRUCTSD" query structs guild "$guild" "${Q[@]}" | jq -r '.Guild.endpoint')" != "$ep" ]; then
    tx structs guild-update-endpoint "$guild" "$ep" --from alice
  fi

  # Test players: fund from bob, delegate (the staking hook makes the player), join the guild.
  local k a pid
  for k in tp0 tp1; do
    a=$(addr "$k"); pid=$(player_of "$a")
    if [ -z "$pid" ] || [ "$pid" = "1-0" ]; then
      tx bank send "$bob" "$a" 20000000ualpha --from bob
      tx staking delegate "$val" 5000000ualpha --from "$k"
      pid=$(player_of "$a")
    fi
    if [ "$("$STRUCTSD" query structs player "$pid" "${Q[@]}" | jq -r '.Player.guildId // ""')" != "$guild" ]; then
      tx structs guild-membership-join "$guild" "${reactor}-${a}" --from "$k"
    fi
    log "$k $a = player $pid"
  done
  # tp2: funded, never a player (a plain send target).
  a=$(addr tp2)
  [ "$("$STRUCTSD" query bank balances "$a" "${Q[@]}" | jq -r '[.balances[]|select(.denom=="ualpha")][0].amount // "0"')" != 0 ] || tx bank send "$bob" "$a" 1000000ualpha --from bob

  # Alice explores a planet so there is someone to look at / move against.
  if [ "$("$STRUCTSD" query structs player "$p1" "${Q[@]}" | jq -r '.Player.planetId // ""')" = "" ]; then
    tx structs planet-explore "$p1" --from alice
  fi
  cmd_env
}

cmd_guild() {
  log "mock Guild API (log: $H/mock-guild.log)"
  STRUCTSD="$STRUCTSD" DEVNET_HOME="$H" CHAIN_ID="$CHAIN_ID" NODE_RPC="$NODE" LCD="http://127.0.0.1:${API_PORT}" \
    nohup node "$DIR/mock-guild.mjs" "${MOCK_GUILD_PORT:-31318}" > "$H/mock-guild.log" 2>&1 &
  echo $! > "$H/mock-guild.pid"
}

cmd_env() {
  cat <<EOF

  chain-id     $CHAIN_ID     height $(height)
  LCD          http://127.0.0.1:${API_PORT}
  RPC (ws)     ws://127.0.0.1:${RPC_PORT}/websocket
  mnemonic     $H/test-mnemonic.txt
  tp0 (idx 0)  $(addr tp0)  player $(player_of "$(addr tp0)")
  tp1 (idx 1)  $(addr tp1)  player $(player_of "$(addr tp1)")
  tp2 (idx 2)  $(addr tp2)  (no player)

  client:  pnpm devnet:vite   (then node scripts/devnet/cdp.mjs && node scripts/devnet/e2e.mjs "$H/test-mnemonic.txt")
EOF
}

cmd_status() { echo "height $(height)"; }

case "${1:-all}" in
  init) cmd_init ;;
  start) cmd_start ;;
  bootstrap) cmd_bootstrap ;;
  stop) cmd_stop ;;
  env) cmd_env ;;
  status) cmd_status ;;
  guild) cmd_guild ;;
  all) cmd_init; cmd_start; cmd_bootstrap; cmd_guild ;;
  *) die "usage: $0 [all|init|start|bootstrap|guild|stop|status|env]" ;;
esac
