# Onboarding: guild list, local accounts, guild signup

How structs.xyz turns a visitor into an on-chain commander with no server of its own. Written for
a developer building a similar client.

**In short:** the browser makes and keeps the key. It reads the guild list from the chain plus each
guild's `guild.json`. It asks the chosen guild's API to create the player. The guild's signer puts
the player on chain, and the client polls the chain until the player appears. All of this runs in
the page; `server/serve.mjs` only serves static files.

| Concern | File |
|---|---|
| Guild directory | `src/guild/directory.ts` |
| Calling a guild API | `src/guild/transport.ts`, `src/guild/api.ts` |
| Keys and addresses | `src/wallet/keys.ts` |
| Vault (key storage) | `src/wallet/vault.ts`, `src/wallet/devicekey.ts`, `src/wallet/wallet.ts` |
| Guild signup | `src/game/onboard.ts` → `joinGuild()` |
| Background enlist | `src/game/enlist.ts` |
| UI: lobby setup | `src/screens/lobby/setup.ts` (droid → name → guild → arrival) |
| UI: vault modal | `src/ui/vault.ts` (enlist, import, unlock, accounts) |
| Signing in to a guild later | `src/guild/session.ts` |
| Local test guild | `scripts/devnet/mock-guild.mjs` |

---

## 1. The player's path

```
lobby setup (src/screens/lobby/setup.ts)
  droid   – roll a portrait (pfp attrs), kept in sessionStorage as a draft
  name    – 2–20 chars [A-Za-z0-9 _.-], "a game name, never your real name"
  guild   – guilds that can take signups, biggest first, already selected
  launch  → enlist(name, guildId, guildName, index, pfpAttrs)
  arrival – the guild's steps tick by; the player can practise meanwhile; the lift opens when the player id lands
```

The vault modal (`openVault()`) has the same form in a smaller layout, plus **Import** and
**Restore** for players who already have a recovery phrase.

There's no separate account-creation step and no phrase to copy first. Clicking Launch creates
the key if there isn't one. After the commander lands, the lobby reminds the player to save the
recovery phrase until they've backed it up (`wallet.backedUp`).

---

## 2. Getting the current guild list

`guilds()` in `src/guild/directory.ts`. There's no central registry: the chain is the list, and
each guild describes itself.

### Step 1: guilds from the chain

```
GET {LCD}/structs/guild?pagination.limit=5000   (paged by next_key)
```

`LCD` is `VITE_LCD_URL`, default `https://public.testnet.structs.network`. The LCD answers CORS
for any origin. Each row has `id`, `owner`, `endpoint`, `joinInfusionMinimum`,
`entrySubstationId` and `primaryReactorId`.

`endpoint` is the URL of the guild's `guild.json`.

### Step 2: each guild's `guild.json`, read in parallel (first 80 guilds)

```js
fetch(g.endpoint, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(2500) })
```

The client uses the `guild` object inside it:

```jsonc
{ "guild": {
    "id": "0-5",                         // must equal the chain id, or the entry is rejected
    "name": "...", "tag": "...", "description": "...", "logo": "https://...", "website": "https://...",
    "services": {
      "guild_api": "https://api.example/api",      // required to enlist
      "grass_nats_websocket": "wss://...",          // live event stream
      "matrix": "https://matrix.example",           // chat homeserver
      "explorer": "https://..."
    }
} }
```

### Treat `guild.json` as hostile input

A guild controls its `guild.json`, so the client checks it before using any of it:

- **Size:** reads stop at 64 KB, and strings are truncated (name 80 chars, tag 12, description 600).
- **Identity:** `guild.id` must match the chain's id.
- **Service URLs (`okUrl`):** only https/wss are accepted. Rejected: IP literals, credentials in
  the URL, `localhost`, `.local`/`.internal`/`.lan`/`.home`/`.arpa` hosts and wildcard-DNS hosts
  (nip.io, sslip.io …). Redirects are refused too. This stops a guild from pointing players'
  browsers into their own network. Loopback is allowed only on a devnet, where both the page and
  the LCD are on loopback.
- **Links:** only http(s) logo and website URLs come out (`safeUrl`), so no `javascript:` links.

### Every entry carries a status

| `error` | Meaning |
|---|---|
| `null` | Read OK; `meta` and `services` are filled in |
| `'no endpoint'` | The chain row has no usable URL |
| `NOT_SHARED` | The host answered, but not with CORS. Detected by a follow-up `no-cors` fetch that succeeds. Remembered in localStorage for 1 h. |
| `'guild.json unreachable'` | The host didn't answer. After 2 misses in a row it's skipped for 60 s; coming back online clears that. |
| `'guild.json unreadable'` / `'…names another guild'` | Bad content |
| `NO_DIRECTORY` | Nothing could be read; the chain's list is used without names |

### Caching

- The list is stored in IndexedDB as `guilds-direct` for 10 minutes and served stale while it
  refreshes.
- A list where nobody answered (offline) isn't cached.
- Unreachable guilds are retried in the background, at most every 20 s.
- `onGuilds(fn)` and `guildsNow()` give other screens the list without reading it again.

### Narrowing the list down to guilds you can enlist with

The setup screen shows a guild only when:

1. its `guild.json` names a `guild_api`, **and**
2. `canReach(guildId)` didn't return false. That check is `GET {guild_api}/timestamp`; it fails
   only when the guild refuses CORS, not when the network is down.

The list is then sorted by member count and the first guild is selected. If nothing passes, the
page says enlisting isn't open on this site yet, while practice battles and the Academy keep working.

> **Practical note:** if you're starting a new client on a new origin, guilds must allow your
> origin with CORS, both on `guild.json` and on the Guild API. Until they do, your guild list will
> be empty even though the chain lists them.

---

## 3. Creating the account locally (the vault)

The account is a Cosmos HD key. Nothing about it is sent anywhere.

### Keys (`src/wallet/keys.ts`)

- A BIP-39 mnemonic (24 words for new players), using `@scure/bip39`.
- BIP-32 secp256k1 derivation on **`m/44'/118'/0'/0/{index}`** (the Cosmos coin type).
- The address is bech32 `structs1…` of `ripemd160(sha256(compressedPubKey))`.
- Index 0 is the **commander**. Higher indexes are **replicants** (extra players run by
  standing orders) or limited **field keys**.
- Libraries: audited noble/scure only (`@noble/curves`, `@noble/hashes`, `@scure/*`).

### Two ways to seal it (`src/wallet/vault.ts`)

Only ciphertext goes into `localStorage['structs.vault.v1']`. Public facts sit next to it in plain
text: addresses, labels, player ids and roles. That lets the UI show your empire before the vault
is unlocked.

| Seal | How | When |
|---|---|---|
| **Device** (default) | AES-256-GCM under a **non-extractable** WebCrypto key stored in IndexedDB (`structs-xyz-keys` database, id `vault-<uuid>`) | `wallet.createInstant()`: one-click enlist, and phrase import. Opens itself on load and never locks. |
| **Passphrase** | PBKDF2-SHA256 (600k rounds), then AES-256-GCM, with a fresh salt and IV on each save | `wallet.changePassphrase()` moves a device vault to this, from the vault UI. Locks itself after 45 min idle. |

What follows from this design:

- Script on this origin can *use* the device key but can't *read* it.
- Anyone with the browser profile can open a device vault, so **the recovery phrase is the real
  backup**. The UI keeps reminding the player until they've backed it up.
- If site data is cleared, the device key is gone. The vault says so and offers **Import phrase**.
  Importing the same phrase keeps the accounts this browser already knew.
- The phrase stays in memory only while unlocked. Keys are derived each time they're needed and
  then dropped (`wallet.key(index)`).
- **Secure context required:** on `http://` at a network address `crypto.subtle` is missing, and
  the vault refuses to run there (`src/wallet/secure.ts`). Use `localhost` or https.
- `wallet.forget()` deletes the vault and the device key, and tells everything that acted for it
  (the guild session, chat, a pending enlist) to let go.

### Finding out whether an address is already a player

```
GET {LCD}/structs/address/{address}   → { playerId }
```

A `playerId` of `"1-0"` or an error means "not a player yet". `wallet.resolvePlayers()` runs this
for every account after unlock, after import and after `addAccount`. That's how an imported phrase
finds its existing commander.

---

## 4. Creating the player with the guild (signup)

`joinGuild(index, guildId, username, onStep, pfp)` in `src/game/onboard.ts`.

A new address has no tokens, so it can't pay gas for its own join. The **guild** creates the
player instead: it broadcasts `MsgGuildMembershipJoinProxy` with the guild's own key, using a
signature the player made.

```
1. GET {LCD}/structs/address/{addr}
      already a player? → done (also covers retries and reloads)

2. sign  "GUILD{guildId}ADDRESS{address}NONCE0"
      fresh address ⇒ proxy nonce 0; the chain checks it

3. POST {guild_api}/auth/signup      (CORS, credentials omitted)
      { primary_address, signature, pubkey, guild_id, username,
        pfp_client_render_attributes?: JSON string of the droid }
      → 202 Accepted (or success, or an "exists" error, which is treated as fine)

4. The guild's transaction agent broadcasts
      MsgGuildMembershipJoinProxy(address, pubkey, signature, playerName)

5. Poll GET {LCD}/structs/address/{addr}
      every 3 s ×5, then every 6 s, ~4 min total
      → playerId lands → wallet.setAccount(index, { playerId })

6. If the player has no planet: queue MsgPlanetExplore, which the player signs from now on
```

### Signature format (shared by every guild-stack message)

secp256k1 over `sha256(utf8(message))`, low-S. The result is hex of `r‖s‖recovery` (65 bytes),
the same layout as cosmjs `ExtendedSecp256k1Signature.toFixedLength`. `pubkey` is the hex
compressed public key. See `wallet.signMessage()`.

### `enlist()` wraps signup so it survives tabs and reloads (`src/game/enlist.ts`)

- It creates the device vault if there's none, then returns right away. Everything after that runs
  in the background.
- The pending request is saved in `localStorage['structs.enlist.pending']`. `resumeEnlist()` runs it
  again on boot and whenever the wallet changes.
- `navigator.locks` (`'structs-enlist'`) makes sure only one tab talks to the guild. Other tabs
  just poll for the player.
- A `GuildBlockedError` (the guild refuses this site) isn't retried. The UI offers another guild.
- The droid portrait goes with the signup, so the commander has it from the first block.

### Replicants use the same path

`src/game/replicants.ts` calls `wallet.addAccount(n, callsign, role)` and then
`joinGuild(n, commanderGuild, …)`. That's the same signup at the next HD index, into the
commander's guild.

---

## 5. Signing in to the guild afterwards (session)

Signup creates the player. Reading members-only Guild API data (structs, grid, raids, ledgers)
needs a **guild session**, which `src/guild/session.ts` handles in the background:

```
sign  "LOGIN_GUILD{guildId}ADDRESS{address}DATETIME{unix_ts}"   // ts from GET {guild_api}/timestamp
POST  {guild_api}/auth/login  { address, signature, pubkey, guild_id, unix_timestamp }
      → session cookie; later calls use credentials: 'include'
```

- It first tries any cookie the browser already has (another tab, an earlier visit), so no
  signature is needed while that cookie lasts.
- A 401 later signs in again, with at most 2 failed sign-ins per visit.
- A locked vault waits for the player to unlock.
- Only the commander's own guild gets cookies. Every other guild is called with
  `credentials: 'omit'`, because a guild that answers `Access-Control-Allow-Origin: *` rejects
  credentialed requests.
- Callers use `session.api()` and fall back to the LCD when it's null.

Chat uses the same signed login: `POST {guild_api}/auth/matrix` returns Matrix tokens. See
[DEV-RELAY.md](DEV-RELAY.md).

---

## 6. What a guild must provide for this to work

| Endpoint | Used for | Needs CORS for your origin |
|---|---|---|
| `guild.json` at the on-chain `endpoint` | Name, logo, `services.guild_api` | Yes (any origin is fine) |
| `GET  /api/timestamp` | Reachability check; clock for login | Yes |
| `POST /api/auth/signup` | Create the player (proxy join) | Yes |
| `POST /api/auth/login` | Session cookie | Yes, **with credentials** (exact origin, not `*`) |
| `POST /api/auth/matrix` | Chat tokens | Yes |
| `GET  /api/auth/player-address/{addr}/guild/{g}/player-id` | Is this address a member here | Yes |

The session cookie is `SameSite=Lax`, so a browser that blocks third-party cookies drops it. The
session reports this to the player rather than retrying.

---

## 7. Running it locally

`scripts/devnet/` runs the full flow with no public network involved:

```bash
pnpm devnet          # single-node chain + bootstrap + mock guild on 127.0.0.1:31318
pnpm devnet:vite     # client on http://127.0.0.1:5186 (use 127.0.0.1, not localhost)
```

`mock-guild.mjs` implements `/guild.json`, `/api/timestamp`, `/api/guild/this`, `/api/auth/signup`
(it returns 202, then the guild owner's key broadcasts `guild-membership-join-proxy` through the
`structsd` CLI), `/api/auth/login`, `/api/auth/logout` and the player-id lookup. It doesn't check
signatures; the chain checks the signup proof. Full instructions are in `scripts/devnet/README.md`.

Useful environment overrides:

| Variable | Default | Purpose |
|---|---|---|
| `VITE_LCD_URL` | `https://public.testnet.structs.network` | Chain REST |
| `VITE_RPC_WS_URL` | `wss://public.testnet.structs.network:26657/websocket` | Tendermint websocket |
| `VITE_DEFAULT_GUILD` | `0-5` | Guild whose infrastructure backs the client by default (GRASS) |
| `VITE_GRASS_URL` | `wss://beta.playstructs.com:1443` | Event stream; `off` disables it |

---

## 8. localStorage and IndexedDB keys

| Key | What |
|---|---|
| `localStorage['structs.vault.v1']` | Sealed phrase plus public account facts |
| IndexedDB `structs-xyz-keys/keys/vault-<uuid>` | Non-extractable device key |
| `structs.wallet.active` | Active HD index |
| `structs.wallet.autolock` | Minutes before a passphrase vault locks (default 45) |
| `structs.enlist.pending` | Signup to resume |
| `sessionStorage['structs.lobby.draft']` | Droid, name and guild chosen during setup |
| `structs.guildjson.refused` | `guild.json` hosts that refused CORS (retried after 1 h) |
| `structs.commander` | Pinned player to watch, for visitors with no vault |
| IndexedDB cache `guilds-direct` | Guild directory (10 min) |
