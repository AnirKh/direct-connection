AnirKh.github.io/direct-connection

## Layout

| File | What it holds |
| --- | --- |
| `index.html` | Markup. Loads `protocol.js`, `i18n.js`, `app.js` **in that order** — `app.js` reads `DCProtocol`, `LANG` and `I18N` while parsing. |
| `protocol.js` | Pure wire-protocol logic: invite links, ECDH→HKDF key derivation, verification code, binary chunk framing. No DOM, no sockets, no state — loaded as `window.DCProtocol` in the browser and `require`d by the tests. |
| `i18n.js` | All user-visible strings, Mongolian and English. Pure data. |
| `app.js` | Everything stateful: WebRTC, data channel, calls, chat UI. |
| `csp.js` | The Content-Security-Policy, defined once (see below). |
| `server.js` | Signaling, PIN/token auth, rate limits, `/api/send-message`. |

Adding a string means adding it to **both** languages in `i18n.js` — `t()` falls back to the key name, so a missing translation shows up as raw text in the UI.

## Tests

```
npm test
```

Node's built-in runner, no dependencies. Three files:

- `test/protocol.test.js` — invite-link parsing (including malformed input, which must not throw at page load), room secrets, key derivation, and the framing. Includes a man-in-the-middle case asserting that an attacker who substitutes both public keys cannot reach a working key without the room secret.
- `test/server.test.js` — spawns a real server on port 3199 with a 1-second heartbeat: join rules, PIN lockout, room-name reuse, and a peer that vanishes without disconnecting. Each client presents its own `X-Forwarded-For` so one test's rate-limit lockout does not leak into the next.
- `test/csp.test.js` — fails if `index.html` has drifted from `csp.js`.

Not covered: the WebRTC and UI code in `app.js`, which needs a browser and two peers. Changes there still want a manual two-tab check.

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
- **`HEARTBEAT_MS`** — how often the server pings each WebSocket client, in ms (default **30000**, accepted range 1000–300000). A client that misses a sweep is dropped, which frees its room and tells the other peer. Lower it only for testing; every client answers every sweep, so short intervals mean constant traffic.
- **`LEAVE_ATTACH_MAX_BYTES`** — optional max attachment size for the main-page email form (default **28 MB**). Resend rejects emails over **~40 MB** total after encoding, so do not set this above **35 MB** unless you use another mail provider.
