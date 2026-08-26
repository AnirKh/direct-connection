AnirKh.github.io/direct-connection

## Layout

| File | What it holds |
| --- | --- |
| `index.html` | Markup. Loads `protocol.js`, `i18n.js`, `app.js` **in that order** — `app.js` reads `DCProtocol`, `LANG` and `I18N` while parsing. |
| `protocol.js` | Pure wire-protocol logic: invite links, ECDH→HKDF key derivation, verification code, binary chunk framing. No DOM, no sockets, no state — loaded as `window.DCProtocol` in the browser and `require`d by the tests. |
| `i18n.js` | All user-visible strings, Mongolian and English. Pure data. |
| `app.js` | Everything stateful: WebRTC, data channel, calls, chat UI. |
| `csp.js` | The Content-Security-Policy, defined once (see below). |
| `clientip.js` | Works out the real client address from `X-Forwarded-For`. Every rate limit depends on it, so it is separate and tested. |
| `server.js` | Signaling, PIN/token auth, rate limits, `/api/send-message`. |

Adding a string means adding it to **both** languages in `i18n.js` — `t()` falls back to the key name, so a missing translation shows up as raw text in the UI.

## Invite links

```
https://host/path#<encoded room name>:<join token>:<room secret>
                  └─ part 0 ─────────┘ └─ part 1 ─┘ └─ part 2 ─┘
```

| Part | Made by | Goes to the server? | Purpose |
| --- | --- | --- | --- |
| room name | the host, typed | **yes** | identifies the room |
| join token | the **server** | **yes** | lets a guest in without typing the PIN |
| room secret | the host's **browser** | **never** | authenticates the key exchange |

Built and parsed only by `buildInviteHash` / `parseInviteHash` in `protocol.js`. The room name is URI-encoded, so a literal `:` becomes `%3A`; the token and secret are base64url. No part can therefore contain a `:`, which is what makes splitting on it unambiguous.

### Why the secret is in the fragment

Everything after `#` in a URL is **never sent in an HTTP request**. The browser keeps it. That is the entire reason it lives there.

Plain ECDH cannot detect a man-in-the-middle: the signalling server relays both public keys and could substitute its own. The room secret is mixed into the key derivation (`deriveSharedKey`), so an attacker who never saw it derives a different key, fails the confirmation exchange, and the channel never opens. Users do nothing — they send the link they were sending anyway.

This only works because the server never learns the secret. **The one rule: never put the room secret in a WebSocket message, a query string, a request body, or a log line.** Only `sessionId` and `token` may go over the wire.

Breaking that rule would remove the protection while everything carried on working, so it is enforced rather than merely documented:

- `wsSend` runs `payloadLeaksSecret` over every outgoing message and **refuses to send** any that contains a secret. Losing one signalling message is recoverable; leaking the secret is not.
- The guard checks `roomSecret`, `pendingRoomSecret` **and** `_autoSecret`. The join is sent while the secret is still in `pendingRoomSecret` — `roomSecret` is only assigned once the server confirms — so checking one variable would leave the guard inert during the very message most likely to carry it.
- `test/client-source.test.js` fails if any `wsSend` payload mentions a secret, if `join-session` grows a field beyond `sessionId`/`pin`/`token`, or if a new secret-holding variable appears without being added to `roomSecretsInPlay()`.

### PIN joins have no secret

Someone joining by typing the 6-digit PIN never received a link, so there is nothing to mix in. Those connections fall back to plain ECDH plus the manual verification code, and the UI shows a standing warning until the code is confirmed.

The host cannot know in advance which way a guest will arrive, so it derives **both** candidate keys and adopts whichever one opens the guest's confirmation packet. That is why an attacker forcing the weaker path is visible — the warning banner appears — rather than silent.

The PIN and token cannot substitute for the room secret: the server generates both, so it already knows them.

### Lifetime

Links are short-lived by nature. A room exists only in the server's memory and disappears when **either** participant disconnects, after ten minutes with nobody having joined, or whenever the server restarts. An "old" link points at a room that no longer exists and simply reports *session not found* — so there is no population of stale links to worry about.

## Calls: consent is local, never taken from the wire

Two rules, both enforced in `test/client-source.test.js`:

- **`getUserMedia` runs only when `inCall` is already true.** `inCall` is set by pressing a call button or Accept — nothing a peer sends can set it. Every function that reaches `attachCallMedia()` must check it first, or the peer can skip the prompt and open the camera by sending `call-offer` or `call-accept` cold.
- **`pendingCallVideo` decides whether the camera is used, not the peer's `withVideo` flag.** That flag rides in on every call message; `consentedVideo()` ANDs the two, so the peer may answer a video call with audio only but can never add video to a call you asked to keep voice-only.

The test walks whichever functions call `attachCallMedia` rather than a fixed list of names, because the guard was added to one of the two paths first and the second went unnoticed for a release.

## Text messages are shown only if the agreed key opened them

`handleTextMessage` drops any `text` that arrives without ciphertext or before the key exchange completes. `sendTextMessage` never sends one, so an unencrypted body is never a real peer.

This matters because `e2eFailClosed()` only disables **sending**. Rendering a plaintext body would leave a middleman who was just caught swapping keys still able to write into the chat window.

## Tests

```
npm test
```

Node's built-in runner, no dependencies. Three files:

- `test/protocol.test.js` — invite-link parsing (including malformed input, which must not throw at page load), room secrets, key derivation, and the framing. Includes a man-in-the-middle case asserting that an attacker who substitutes both public keys cannot reach a working key without the room secret.
- `test/server.test.js` — spawns a real server on port 3199 with a 1-second heartbeat: join rules, PIN lockout, room-name reuse, and a peer that vanishes without disconnecting. Each client presents its own `X-Forwarded-For` so one test's rate-limit lockout does not leak into the next.
- `test/csp.test.js` — fails if `index.html` has drifted from `csp.js`.

`/api/send-message` is covered inside `server.test.js`. Those tests assert the process is **still serving** after a malformed request, not just the status code — an uncaught throw in that handler ends the process and every open room with it. Any new async route must go through `asyncRoute()` for the same reason: Express 4 does not await handlers, so a rejected promise becomes an unhandled rejection and Node exits.

Not covered: the WebRTC and UI code in `app.js`, which needs a browser and two peers. Changes there still want a manual two-tab check.

### Icon font

`index.html` loads Tabler icons from jsDelivr with a Subresource Integrity hash. The browser refuses the file unless it hashes to exactly that value, so a compromised or hijacked CDN cannot substitute a stylesheet — which matters because CSS alone can hide `#verifyBanner`, the warning that says nobody has verified the connection.

**Bumping the version means recomputing the hash**, or every icon silently disappears:

```
node -e "const h=require('https'),c=require('crypto');h.get(process.argv[1],r=>{const b=[];r.on('data',d=>b.push(d));r.on('end',()=>console.log('sha384-'+c.createHash('sha384').update(Buffer.concat(b)).digest('base64')))})" "https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@VERSION/dist/tabler-icons.min.css"
```

`test/csp.test.js` fails if any third-party tag in `index.html` lacks `integrity`, lacks `crossorigin` (without which the check is skipped rather than enforced), or points at a floating version.

The hash covers the stylesheet, not the font files it references. A hostile CDN could still serve altered glyphs — it could not hide an element or run code.

### Dependencies

```
npm audit
```

Worth running before a deploy. Two of the four direct dependencies sit directly on the internet — `ws` handles every signalling socket and `multer` parses every upload — so an advisory in either is reachable by anyone, not theoretical.

Deliberately **not** in the pre-push hook: advisories appear on their own schedule, so it would block pushes for reasons unrelated to the change being pushed, and a hook that fails for unrelated reasons is one you learn to bypass.

### Git hooks

Tracked in `.githooks/` and wired up by `npm install` (via the `prepare` script). To enable them by hand after a fresh clone:

```
git config core.hooksPath .githooks
```

| Hook | Runs | Takes |
| --- | --- | --- |
| `pre-commit` | `check-csp` + `npm run test:fast` | ~0.4s |
| `pre-push` | `npm test` (adds the server integration tests) | ~7s |

The split keeps committing instant — a hook slow enough to be annoying is a hook you start bypassing. The slower half runs before code leaves the machine, which is the last moment a failure is free: pushing redeploys Render and republishes GitHub Pages.

Bypass a single run with `git commit --no-verify` or `git push --no-verify`.

## Content-Security-Policy

The policy is defined once, in **`csp.js`**. It reaches the browser two ways and both are needed:

- `server.js` sends it as a response header (Render deployment; also the only form that can carry `frame-ancestors`)
- `index.html` carries a `<meta>` copy, because GitHub Pages serves static files and cannot set headers

After editing `csp.js`, regenerate the meta tag:

```
npm run sync-csp
```

`npm run check-csp` reports drift and exits non-zero without changing anything — worth running before a deploy, since a stale meta tag only affects the static build and the Render deployment will look fine. The server also warns on startup if the two have drifted.

## Server configuration (Render or self-hosted)

Set **`ALLOWED_ORIGINS`** to a comma-separated list of every **browser origin** that loads the app and talks to this API (WebSocket + `fetch`). Examples:

- Static site on GitHub Pages: `https://YOURNAME.github.io`
- App and API on Render: `https://direct-connection.onrender.com`
- Local dev: `http://localhost:3000`, `http://127.0.0.1:3000`

If an origin is missing, the browser will block CORS and **WebSocket connections will be rejected** during the upgrade (except non-production loopback without an `Origin` header).

Optional:

- **`PUBLIC_SESSION_LIST=0`** — the lobby never receives other users’ room names (only empty lists). Hosts still share PIN or invite link as usual.
- **`RESEND_API_KEY`**, **`MAIL_TO`** — required for “leave a message” email; `POST /api/send-message` also requires a custom header (`X-DC-Client: 1`) sent by the bundled client so drive-by form posts cannot abuse the endpoint.
- **`TRUSTED_PROXY_HOPS`** — how many proxies sit in front of this process (default **1**). Every rate limit keys on the client address, and `X-Forwarded-For` is only trustworthy as far back as the proxies you control, so the address is read that many entries from the **right**. Leave at 1 behind Render/Fly/Heroku/nginx. **Set to 0 if the process is exposed directly** — otherwise a client can send its own `X-Forwarded-For` and pick a fresh identity for every request, evading the PIN lockout, the room-creation cap and the email limit. The server logs the value it is using on startup.
- **`HEARTBEAT_MS`** — how often the server pings each WebSocket client, in ms (default **30000**, accepted range 1000–300000). A client that misses a sweep is dropped, which frees its room and tells the other peer. Lower it only for testing; every client answers every sweep, so short intervals mean constant traffic.
- **`LEAVE_ATTACH_MAX_BYTES`** — optional max attachment size for the main-page email form (default **28 MB**). Resend rejects emails over **~40 MB** total after encoding, so do not set this above **35 MB** unless you use another mail provider.
