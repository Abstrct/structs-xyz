# The dev relay: what it was, how dev used it, why production never did

A handoff note for anyone building a browser client against Structs guilds (Guild API and
Matrix chat) who hits the same wall we did: **guild auth services won't accept `localhost` as a
web app's OAuth callback.**

> **Status (2026-10-14):** the relay is retired. It lived in `server/dev-relay.mjs` from
> 2026-10-11 to 2026-10-12 (removed in `953d8ac`). The guild API now does the OAuth dance
> server-side (`POST {guild_api}/auth/matrix`), so neither dev nor prod needs a relay. This
> doc explains the pattern so you can set it up if your guild doesn't have `/auth/matrix` yet,
> and so you know what replaced it.
>
> To read the original: `git show 953d8ac^:server/dev-relay.mjs`

---

## 1. The problem

Chat runs on each guild's Matrix homeserver. Signing in uses its auth service (MAS, Matrix
Authentication Service) through OAuth 2.0 + PKCE, and the guild's own wallet login is the identity
step:

1. The browser signs `LOGIN_GUILD{g}ADDRESS{addr}DATETIME{ts}` with the player's key.
2. The signature is posted to the guild's `/api/auth/login`, which sets a guild session cookie.
3. With that cookie, MAS's `/authorize` redirects back with a `code`.
4. The code is exchanged at MAS's `token_endpoint` for Matrix access and refresh tokens.

**On the published site (https)** this worked in the browser. The site registered itself with MAS
as a public **web** client and opened the guild login in a small pop-up window. The code came back
on `comms-callback.html`.

**On the Vite dev server (`http://localhost:5173`)** it couldn't work. MAS refuses `http://localhost`
as a *web* client's `redirect_uri`, so there was nowhere for the code to land.

## 2. The dev relay (dev only)

The fix: on the dev server, run the sign-in **from Node**, the way a native or desktop app would.
This is the same approach the structs-universe desktop app uses (`src-tauri/src/matrix/auth.rs`).

### Where it lived

| Piece | File (at `953d8ac^`) |
|---|---|
| Relay and Vite plugin | `server/dev-relay.mjs` (+ `.d.mts` types) |
| Wiring | `vite.config.ts`: `plugins: [siteEnvPlugin(), devRelayPlugin()]` |
| Client branch | `src/chat/matrix.ts` → `viaDevRelay()` |
| Tests | `scripts/devrelay.test.ts` |

### The endpoint

A Vite middleware, mounted only when Vite serves (`apply: 'serve'`):

```
POST /__dev/comms/signin
  body: { homeserver, guildApi, deviceId, login: { address, pubkey, signature, guild_id, unix_timestamp } }
  → 200 { access_token, refresh_token, expires_in, client_id, token_endpoint, revocation_endpoint, device_id }
  → 4xx/502 { error }
```

**The browser still signs.** The relay receives only the *signed* login and never a private key or
mnemonic.

### What the relay did, step by step

1. **Discover the auth service.** It tried `GET {homeserver}/_matrix/client/v1/auth_metadata` first,
   then the MSC2965 unstable path. It required every endpoint (`authorization`, `token`,
   `registration`, `revocation`) to be **https on the issuer's own origin**, so hostile metadata
   couldn't point the relay somewhere else.
2. **Register as a native client (once per issuer).** It used dynamic client registration with
   `application_type: 'native'`, `token_endpoint_auth_method: 'none'`, and a loopback redirect:

   ```
   http://127.0.0.1:47412/structs-xyz/comms/callback
   ```

   MAS accepts loopback redirects for *native* clients. **Nothing listens on that port.** The relay
   follows redirects by hand and stops when the `Location` starts with that URI. The `client_id`
   was cached in `node_modules/.cache/structs-dev-relay.json`.
3. **Get a guild session in its own cookie jar.** It POSTed the signed login to
   `{guildApi}/auth/login`, using a small in-memory cookie jar that respected `Domain`, `Path`,
   `Max-Age` and `Expires`.
4. **Authorize.** It built the PKCE `authorize` URL with
   scope `urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:{deviceId}`
   and followed redirects manually (`redirect: 'manual'`, at most 12 hops).
   - If the chain parked on the guild SPA (`?oidc=<request id>`), it resumed through
     `/oauth/resume?request_id=…`.
   - If MAS showed a consent page, it parsed the first `<form>` and submitted it, but only when the
     form was on the issuer's host and posted back to the issuer's host. It answered at most 4 forms.
5. **Read the callback without visiting it.** It checked `state`, pulled out `code` and redeemed it
   at `token_endpoint` with the PKCE `code_verifier`.
6. Returned the tokens to the page. The page then called `/_matrix/client/v3/account/whoami` and
   **checked the Matrix user really was the signing commander**, because an auth service can hand
   back someone else's stale session.

### Lock-down (copy these if you build one)

A relay that holds a cookie jar and follows redirects is an open proxy if it isn't fenced in.
`relayRefusal(req)` rejected:

- any caller that isn't loopback (`127.0.0.1`, `::1`, `localhost`) → 403
- any method other than `POST` → 405
- any `Content-Type` other than `application/json` → 415. A JSON body forces a CORS preflight from
  other sites, and the relay never answers preflights, so other sites can't call it.
- `Sec-Fetch-Site` other than `same-origin`, or an `Origin` that isn't the dev server's own host → 403
- bodies over 16 KB (the request was destroyed)

Other rules:

- `homeserver` and `guildApi` must be https (http allowed only on loopback, for the devnet).
- Query strings are stripped from every URL that goes into an error or log (`redact()`), because
  codes and request IDs travel in them.
- Each upstream request times out after 25 s. The client gives the whole sign-in 120 s.

## 3. Why production never used it

This was enforced in three separate places:

1. **Vite plugin scope.** `devRelayPlugin()` had `apply: 'serve'` and hooked only
   `configureServer`. `vite build` never ran it, so `/__dev/comms/signin` doesn't exist in `dist/`.
2. **Dead-code elimination in the client.** Every branch was written out literally where it was used:

   ```ts
   tok = import.meta.env?.DEV === true
     ? await viaDevRelay(route, deviceId, login, sig)
     : await this.viaWindow(route, deviceId, login, sig);
   ```

   A build replaces `import.meta.env.DEV` with `false`, so the relay call, its fetch URL and its error
   strings drop out of the bundle completely. Don't hide the check behind a helper like `isDev()`;
   the bundler may not inline it.
3. **The production server only serves files.** Production is static hosting: GitHub Pages, or
   `server/serve.mjs` in the container (`pnpm build && node server/serve.mjs`). That server serves
   `dist/` with compression and cache headers and does nothing else. Its header comment says it:
   *"The page talks to the chain and to each guild itself; this only serves files."*

In production the sign-in went through the pop-up window and `comms-callback.html`, with the site
registered as a **web** client on its real https origin.

## 4. What replaced it (current state)

The relay was a workaround for something the guild could do itself. Now:

- **Chat sign-in.** `POST {guild_api}/auth/matrix` takes
  `{ address, pubkey, signature, guild_id, unix_timestamp, device_id }` and returns
  `{ success, data: { user_id, device_id, access_token, refresh_token, expires_in, client_id, token_endpoint, revocation_endpoint } }`.
  The guild API walks the MAS chain on its own side. The page sends one JSON POST with no cookies,
  no window and no redirect, and it works the same on localhost and in prod. The page then refreshes
  and revokes directly at MAS, since `client_id` is a public client.
  See `src/chat/oauth.ts` and `scripts/chat.test.ts`.
- **Guild API reads.** The page calls the API named in each guild's `guild.json` directly over CORS
  (`src/guild/transport.ts`). Only the commander's own guild gets credentials, for its session cookie
  (`src/guild/session.ts`).
- **Local guild flows.** `scripts/devnet/mock-guild.mjs` is a dependency-free fake Guild API on
  `127.0.0.1:31318` that answers CORS with credentials for pages on the same machine. Open the devnet
  page at `http://127.0.0.1:5186`, not `localhost`, so the `SameSite=Lax` cookie counts as same-site.
  See `scripts/devnet/README.md`.

**Older leftover.** Before that, an even earlier version proxied Guild API calls through a relay
session (`x-relay-session` header, `structs.relay.session` in localStorage). That is gone too:
`src/main.ts` still clears the old localStorage key, and `scripts/direct.test.ts` asserts no call
carries the header.

## 5. Should you build one?

| Your situation | Do this |
|---|---|
| Your guild has `/api/auth/matrix` | No relay. POST the signed login and you're done, in dev and prod. |
| No `/auth/matrix`, and you're on an https origin you can register | Use the browser flow: web client, pop-up and callback page. |
| No `/auth/matrix`, and you're developing on localhost | Build a dev relay as above: a Vite `serve`-only plugin, a native client with a loopback redirect nobody listens on, manual redirects, and the lock-down list. Gate the client branch with a literal `import.meta.env.DEV === true`. |
| You want it in production | Don't. Put the token exchange in the guild API (as `/auth/matrix` does). A public relay holding guild cookies is a liability you'd have to defend. |
