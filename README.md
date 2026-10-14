AnirKh.github.io/direct-connection

## Layout

| File | What it holds |
| --- | --- |
| `tools/sync-build.js` | Stamps the client with a build id so a browser cannot run files from two versions. **Run `npm run sync-build` after changing any file below that a browser loads.** See "One version in the browser at a time". |
| `index.html` | Markup. Loads `framebust.js` first, then `protocol.js`, `connstats.js`, `guards.js`, `i18n.js`, `app.js` **in that order** — `app.js` reads `DCProtocol`, `DCStats`, `DCGuards`, `LANG` and `I18N` while parsing. |
| `protocol.js` | Pure wire-protocol logic: invite links, ECDH→HKDF key derivation, verification code, binary chunk framing. No DOM, no sockets, no state — loaded as `window.DCProtocol` in the browser and `require`d by the tests. |
| `i18n.js` | All user-visible strings, Mongolian and English. Pure data. |
| `guards.js` | The safety decisions as pure functions — may the camera open, may this message be believed, may the microphone open, may this voice note be sent, which room is the server talking about, what the verification shield says. See below. |
| `connstats.js` | Everything derived from an `RTCStatsReport`: which route ICE chose, direct or relayed, link quality, byte totals, and the address each device shows the other. Also the coarse description of a device, and the fixed table of what may be displayed about the other side's. Pure. |
| `app.js` | Everything stateful and everything with an effect: WebRTC, data channel, calls, chat UI. Asks the two modules above rather than deciding for itself. |
| `csp.js` | The Content-Security-Policy, defined once (see below). |
| `clientip.js` | Works out the real client address from `X-Forwarded-For`. Every rate limit depends on it, so it is separate and tested. |
| `ratelimit.js` | Sliding-window counters, their expiry sweep, `safeLabel` for anything client-supplied that reaches a log line, and `joinVerdict` — which join lock applies to which credential. Same reason as above: small, pure, security-relevant. |
| `framebust.js` | Refuses to run inside a frame. The only such protection on GitHub Pages (see below). |
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

### Two kinds of room

The lobby has a button for each. Both hold the host and **one** guest.

| | PIN room | Open room |
| --- | --- | --- |
| Created with | `create-session` | `create-session` with `open: true` |
| To get in from the list | type the 6-digit PIN | tap Join — nothing to type |
| Invite link | works, and authenticates the key exchange | the same |
| Join locks | apply to PIN guesses | do not apply — there is nothing to guess |
| Shown in the list as | 🔒 and "PIN" | 🔓 and "open" |

An open room is first come, first served: whoever taps it first is in, it leaves the list, and anyone after that is told it is full. That is the whole meaning of "open" — **it is not a room for more than two people.**

A few rules keep a room from being open by accident:

- **Only exactly `open: true` makes a room open**, on the server and in the client. A string, a number, or a missing flag from an older server all mean a PIN room. The lobby compares with `=== true` for the same reason: reading the flag loosely would skip the PIN dialog for a room that wants one.
- **The server decides, not the list.** If the client taps a room it believed was open and it is not, the server answers `pin-required` — without counting it as a wrong guess — and the client opens the PIN dialog instead.
- **`joinVerdict` holds the rule** alongside the lock rules, with every combination tested: a PIN room never admits without its PIN or its token.

What an open room costs, said plainly: anyone who can see the list can connect to the host, which means they can message them, send them files, ring them, and — as with any peer-to-peer connection — learn their IP address. The host's panel says who can come in rather than leaving "no PIN" to be worked out. Someone arriving from the list has no invite-link secret, so the shield is amber exactly as it is for a PIN join.

`PUBLIC_SESSION_LIST=0` hides the list, and with it the only way to find an open room without its link.

### PIN joins have no secret

Someone joining by typing the 6-digit PIN — or by tapping an open room in the list — never received a link, so there is nothing to mix in. Those connections fall back to plain ECDH plus the manual verification code, and the shield in the chat header stays amber until the code is confirmed.

The host cannot know in advance which way a guest will arrive, so it derives **both** candidate keys and adopts whichever one opens the guest's confirmation packet. That is why an attacker forcing the weaker path is visible — the shield turns amber instead of green — rather than silent.

### The shield

The shield button in the chat header is the only standing sign of which of these a chat is in. `shieldState` in `guards.js` decides; `updateShield()` in `app.js` draws it.

| State | When | Colour | Glyph |
| --- | --- | --- | --- |
| idle | no key agreed yet | grey | plain shield |
| warn | encrypted, but nobody has checked for a middleman — a PIN join with the code not yet compared | amber | shield with `!` |
| ok | authenticated by the invite-link secret, or by typing the other side's code | green | shield with a tick |

Tapping it opens the code to compare. That panel is the only place the code appears: the chat itself says one word when a room connects — "Connected" — and it says it once the key is agreed, not when the channel opens, so a chat that fails the key check never claims it. The three lines that used to be written on every join (the transport, "setting up encryption…", the code) were removed on request as more than anyone read.

#### What the panel says

Under the code, the panel states what the chat is. It is the security panel, so every line has to be true, and three of them took some care:

- **Who can read it follows the shield.** "Only the two of you. The server cannot." is a claim that nobody is in the middle, so it is said only once that has been checked. An unverified chat gets a different sentence — encrypted, but a middleman cannot be ruled out until the code is compared. Both are drawn by `renderShieldFacts()`, which `updateShield()` calls, so the sentence and the colour cannot disagree.
- **The encryption is written out by hand** (`AES-256-GCM · ECDH P-256`, and `DTLS-SRTP` for calls), because the keys do not expose it in a form worth showing. `test/client-source.test.js` checks those words against the calls that do the work, so a change of cipher cannot leave the panel describing the old one.
- **Each device's IP address** comes from this browser's own connection statistics (`pathAddresses` in `connstats.js`) and from nothing the peer sent. "Your IP" on a direct connection is the public address a STUN server reported — the one the other side actually sees — not the device's address on its own network, which is what the route itself names. On a shared network it is the two local addresses. A relayed route shows none: those addresses belong to the relay. Browsers hide local addresses from pages (they arrive as random `….local` names), and a hidden address is shown as hidden, never guessed.

The panel also shows **each side's device** — system and browser, no version, no model. This is the one line that comes from the peer: each side sends two short codes (`peer-info`) inside the encrypted envelope, the guest first and the host in answer. What a peer sends is never written to the page. The codes are looked up in a fixed table (`deviceLabel`) and the words shown are ours, because a device "name" of the peer's choosing in the security panel — "✅ verified by server" — would be believed. It is still only what the other side *says* it is.

Showing addresses makes something visible that was already true: on a direct connection each side can see the other's IP. Before, that took developer tools; now it is one tap. In an open room that means anyone who joins sees the host's address.

This used to be a full-width warning banner across the chat. It was removed on request as more than the situation needed, and the shield took over its job, so a few things are now load-bearing:

- **Colour is never the only difference.** Each state swaps the glyph and the `aria-label` with it. Colour is no use to someone who cannot tell amber from green, and a tick drawn in amber would say "checked" about a chat nobody checked.
- **Nothing else may recolour it.** Hovering an icon button turns it white and opening the panel used to turn the shield green; both are overridden, because either would hide or misstate the state.
- **Every change to the verification state goes through `updateKeyVerifyUi()` or `updateShield()`.** With no banner behind it, a path that skips them leaves the old colour on screen.

Be honest about the trade: an icon is easier to miss than a banner, and with the join messages gone as well it is the **only** thing that distinguishes an unverified chat. Someone who never looks at the shield will not notice a PIN join that should have been a link join.

The PIN and token cannot substitute for the room secret: the server generates both, so it already knows them.

### Lifetime

Links are short-lived by nature. A room exists only in the server's memory and disappears when **either** participant disconnects, after ten minutes with nobody having joined (the host is told — see "Rooms" below), when its host opens or joins another room, or whenever the server restarts. An "old" link points at a room that no longer exists and simply reports *session not found* — so there is no population of stale links to worry about.

## Why the decisions live outside app.js

`app.js` needs a browser and two peers, so nothing in it could be executed by the test suite. Round after round of analysis found real bugs in it, and **almost every one was a decision or a small state machine** — not DOM code:

| Bug | The decision behind it |
| --- | --- |
| A peer could open the camera with no prompt | may capture start? |
| A voice call was upgraded to video by the peer | how much video was agreed to? |
| Plaintext messages were displayed | may this be shown? |
| Unencrypted file announcements and call requests were acted on | may this be believed? |
| A voice note reached the next room's peer | which room does this recording belong to? |
| A double-click left the microphone on | may the microphone open? |
| An invite-link join hung forever | should this join be retried? |
| One room expiring closed the chat in another | which room is this message about? |
| The wrong network route was reported | which candidate pair is actually in use? |

So the decisions moved to `guards.js` and `connstats.js`, and the effects stayed put. Both modules are pure — no DOM, no module state, no side effects — so every combination can be asserted directly, including the ones nobody thinks to try. That is where the bugs were.

The split gives the two test files different jobs:

- `test/guards.test.js` and `test/connstats.test.js` prove the **answers are right**.
- `test/client-source.test.js` proves `app.js` **asks**, and asks before acting. A correct guard nothing calls is worth nothing, and no test of `guards.js` could ever notice.

**Deliberately not done:** the rest of `app.js` is still one file of stateful WebRTC and DOM code. Splitting it further would mean restructuring live code that has no runtime coverage — recreating the exact risk this was meant to reduce. Extracting a decision is safe because it is provably pure; moving effects around is not. If more comes out later, it should be more decisions.

## Calls: consent is local, never taken from the wire

Two rules. `test/guards.test.js` proves they give the right answer; `test/client-source.test.js` proves `app.js` asks before capturing:

- **`getUserMedia` runs only when `inCall` is already true.** `inCall` is set by pressing a call button or Accept — nothing a peer sends can set it. Every function that reaches `attachCallMedia()` must check it first, or the peer can skip the prompt and open the camera by sending `call-offer` or `call-accept` cold.
- **`pendingCallVideo` decides whether the camera is used, not the peer's `withVideo` flag.** That flag rides in on every call message; `consentedVideo()` ANDs the two, so the peer may answer a video call with audio only but can never add video to a call you asked to keep voice-only.

The test walks whichever functions call `attachCallMedia` rather than a fixed list of names, because the guard was added to one of the two paths first and the second went unnoticed for a release.

## One key exchange per channel

`e2e-pubkey` is accepted once. A second one used to re-derive the verification code while leaving the key actually in use untouched — so the code on screen stopped describing the key, the two sides displayed **different** codes, and the UI still said "verified". On a PIN join that code is the only thing standing between the user and a middleman, so a peer able to set it to anything empties it of meaning.

Re-keying is not a feature: a fresh channel runs a fresh exchange, and `e2eInit()` clears the flag. The flag is set the moment a key arrives rather than when its derivation finishes, because deriving is async and a second key arriving in that window is exactly the case worth refusing.

## Interrupted transfers say so, in both directions

A transfer that dies must not keep claiming to be running. Three paths cover it:

- the sender catches the failure, marks its own bubble failed, and sends `transfer-abort` if the channel is still up
- the receiver fails that transfer on `transfer-abort`
- both sides fail every in-flight transfer when the data channel closes

Before this, the peer leaving mid-transfer left the sender's bubble frozen at whatever percentage it had reached, permanently, next to an unhandled null-reference error. The receiver's bubble sat on "Receiving…" just as long. Neither side was told the file had not arrived.

## Only the handshake may arrive unencrypted

Two things travel on the data channel: frames in the clear, and an `e2e-dc` envelope that the agreed key seals. **Anything the app sends sealed is believed only sealed.** `handleTextMessage` takes a `sealed` flag that is true in exactly one place — where `e2eDecrypt` hands over what the envelope held — and asks `mayHandleFrame` before acting on anything.

| May arrive in the clear | Why |
| --- | --- |
| `e2e-pubkey`, `e2e-confirm`, `e2e-fail` | the handshake — there is no key yet |
| `e2e-dc` | the envelope itself |
| `text` | carries its own ciphertext; `mayRenderText` drops it without one |
| `ack`, `typing`, `typing-stop` | nothing a watcher of packet timing could not already see |

Everything else — `transfer-*`, `call-*` — is refused in the clear.

**Who could send a clear frame?** Whoever is carrying the packets. A signaling server that swaps the transport fingerprints sits on the channel, and it can pass the key exchange through untouched, so the chat still reads as verified. It cannot open the envelope. It could write beside it: a clear `transfer-meta` drew a file bubble with any name it chose, a clear `call-request` raised the incoming-call prompt, and a clear `call-offer` after that was treated as the peer's. All of it kept working after `e2eFailClosed()`, which only disables **sending**.

The first fix for this covered `text` and nothing else. That is why the list says what **may** be clear rather than what must be sealed: a message type added later is refused in the clear until someone decides otherwise. `test/client-source.test.js` checks the list against the senders in both directions — a type sent clear but not listed would be dropped by the other side without a word.

## The microphone has one owner

A voice note opens the microphone, and opening is not instant. Two rules keep track of it, one each side of that wait:

- **A second press while it is opening does nothing** (`mayStartRecording`). `_isRecording` only turns true once the stream exists, so a double-click used to open two. The second replaced the first in the one variable that remembers it; the first could never be stopped and stayed live until the tab closed.
- **The room is checked again once it has opened** (`mayKeepMicOpen`). A permission prompt can outlast the room. The room's clean-up ran, found no stream yet, and the microphone then came on in the lobby with no button left to turn it off.

## Rooms: one per socket, and every message says which

- **A socket is in at most one room.** Creating or joining one lets go of any other (`cleanupClient`). A browser that opened a room and then opened or joined another used to keep hosting the first: it stayed in the lobby list with nobody behind it, and a guest who joined waited on a host who was elsewhere.
- **`peer-disconnected`, `guest-joined` and `session-expired` carry a `sessionId`**, and the client acts only if it names the room on screen (`mayApplyRoomEvent`). They used to name nothing, so when that abandoned first room expired, "the other side left" closed the live chat in the second.
- **An unjoined room that expires says so.** After ten minutes the host gets `session-expired` and the lobby replaces the PIN and link with a notice. It used to arrive as `peer-disconnected`, which wrote "peer left" into the hidden chat screen and left the lobby advertising a room that no longer existed.
- **A host cannot join their own room** (`own-room`). It is in the list like any other and the PIN is on screen; it used to be admitted, leaving one browser negotiating with itself.

## Join locks are for PINs, not invite links

Three wrong attempts lock an address out for 30 seconds; fifteen against one room lock the room for five minutes. Both exist to slow down guessing a 6-digit PIN.

**A correct invite token goes through both** (`joinVerdict` in `ratelimit.js`). The token is 192 random bits — nobody presenting the right one is guessing. Holding it to the PIN's locks protected nothing, and room names are public, so anyone could lock an invited guest out of a room they held a valid link to, for as long as they cared to keep it up.

**A correct PIN does not.** If a right PIN were admitted during a lock, the lock would stop nothing — the guesser would keep going until one landed. Someone can therefore still lock a room against PIN joiners; that is the price of a guess limit on a short code, and the invite link is the way round it.

**An open room is outside both locks**, for the same reason as the token: nothing is being guessed. And arriving at a PIN room with no PIN and no token is not a guess either — it gets `pin-required` and is not counted, where a wrong PIN is. Counting it would lock people out for looking.

Because nothing limits how often a token may be tried, both secrets are compared in constant time (`secretMatches`).

## One version in the browser at a time

**After changing any file a browser loads, run `npm run sync-build`.** The pre-commit hook refuses the commit otherwise.

This exists because of a bug that reached users. `index.html` loaded every script as `app.js?v=202608261800` — a stamp written once and never changed. GitHub Pages lets a browser keep each file for ten minutes, each on its own clock, and a tab left open keeps what it has for as long as it stays open. So after an update, three different things went wrong, all reproduced with a real browser cache:

| What the browser had | What the user saw |
| --- | --- |
| new page, old script | the new button is on screen and does nothing |
| old page, new script | the script reaches for an element that is not there, throws while loading, and **nothing** on the page works |
| a tab opened before the update | old code against the new server — a room with no PIN was drawn as one that needs one, asked for a PIN that did not exist, and nobody could get in |

It was reported as "the open-room button does not work and the other person cannot enter", and it would have happened again on the next change that added anything to the page.

Three pieces, one for each row:

1. **The stamp changes with the files.** `tools/sync-build.js` writes a build id — `202610131742-3fa9c1d2`, the time and a hash of every client file — into `const APP_BUILD` in `app.js` and onto every local file `index.html` loads. A new page therefore asks for addresses no browser has cached, and cannot be handed an old script.
2. **`app.js` checks the page it finds itself in.** Before it reads the invite or opens a socket, `refuseToRunInAStalePage()` compares the stamp it was loaded with against `APP_BUILD`. If they differ the page is the stale half: it fetches a fresh one and runs nothing. This cannot use `guards.js` or `i18n.js` — in a mixed page those are exactly the files that cannot be trusted to match.
3. **The server says which build it is.** Every socket is sent `hello` with the build on connecting, and every open page reconnects within seconds of the server restarting for an update. `updateAction` in `guards.js` decides: an idle page fetches the new build; one in a chat, joining, or part-way through typing waits until that is over; one that already fetched for this build says so rather than looping.

A fresh page is always fetched as `?r=<build>` — an address no cache has seen — and never by a plain reload, which can be answered from the same cache that held the stale copy. The invite rides along in the fragment, so it still never reaches a server.

Pages that predate all this cannot update themselves. The server recognises them — they ask for the room list without saying `hello` first — and sends the one thing they do display, an error message, asking for the page to be closed and reopened. That bridge can be deleted once those pages are gone; none survives being closed.

The server reads the id out of `app.js` rather than holding a second copy, and `npm run check-build` fails if the stamp no longer describes the files.

## Phone keyboards

On a phone the message box used to sit **underneath the keyboard** while you typed into it. Two causes, and both had to go:

- **Every full-height rule in `style.css` read `height: 100dvh; height: -webkit-fill-available;`.** The second declaration wins wherever it is understood — which is every phone browser — so the first never applied. All of them now read one variable, `--app-height`, set in one place.
- **Nothing watched the visual viewport.** That is the one measurement that actually gets shorter when a keyboard opens. On iOS, and in most in-app browsers (a link opened from inside a messaging app), no CSS unit does: the page stays full height and the keyboard simply covers the bottom of it. `fitToVisibleArea()` in `app.js` keeps `--app-height` equal to the visual viewport's height.

The viewport tag also carries `interactive-widget=resizes-content`, so Android Chrome and Firefox shrink the page themselves and need no script.

Three details that are easy to undo by accident:

- **Pinch-zoom is ignored.** Zooming shrinks the visual viewport too; resizing the page to match would fight the zoom.
- **A height of 0 is ignored.** A hidden tab reports one, and believing it collapses every screen.
- **Toasts are placed from the top of the visible area**, not from the bottom of the screen, which is behind the keyboard. Errors are shown as toasts.

Do not add a `height: 100vh` / `100dvh` / `-webkit-fill-available` to any rule — size it from `--app-height`. `test/layout.test.js` fails if one comes back.

**What has and has not been checked.** A headless browser at phone size, with the visual viewport reporting a keyboard, puts the message box directly above it (before: 286px below the visible edge). That exercises the code, not a real keyboard. It has not been run on a physical iPhone or Android phone from here.

## Tests

```
npm test
```

Node's built-in runner, no dependencies.

**`test/` is everything that runs without a server** — pure, and finished in under a second, so it all goes in the pre-commit hook. **`test/integration/` needs a real server** and runs before a push. The split is by directory rather than a list of filenames on purpose: `test:fast` used to name its files, and four pure test files were quietly left out of it.


- `test/protocol.test.js` — invite-link parsing (including malformed input, which must not throw at page load), room secrets, key derivation, and the framing. Includes a man-in-the-middle case asserting that an attacker who substitutes both public keys cannot reach a working key without the room secret.
- `test/integration/server.test.js` — spawns a real server on port 3199 with a 1-second heartbeat: join rules, PIN lockout, an invite token getting through a locked room, open rooms (one guest, no PIN, never open by accident), one room per socket, room-name reuse, and a peer that vanishes without disconnecting. Each client presents its own `X-Forwarded-For` so one test's rate-limit lockout does not leak into the next.
- `test/csp.test.js` — fails if `index.html` has drifted from `csp.js`, and covers the framing and third-party-asset rules above.
- `test/ratelimit.test.js` — the sliding window, its expiry sweep, log sanitising, and every combination of `joinVerdict`'s seven inputs. The sweep has no external symptom until the process runs out of memory, which is why it is tested directly.
- `test/guards.test.js` — the safety decisions, every combination.
- `test/connstats.test.js` — which route ICE chose, link quality, byte totals, and which addresses are shown, with a plain Map standing in for the stats report. Also device descriptions, including that nothing a peer sends as one reaches the screen as it was sent.
- `test/shield.test.js` — the shield and its panel, lifted out of `app.js` and **run** against stand-in elements: what sentence, addresses and devices end up on screen in each state. Added because a text-level check passed while the "who can read this" sentence was never being redrawn.
- `test/build.test.js` — the build stamp: that it still describes the files, that every local file carries it, and `refuseToRunInAStalePage()` lifted out of `app.js` and run against a stand-in page.
- `test/layout.test.js` — the phone-keyboard fix: that every full-height rule reads `--app-height`, and `fitToVisibleArea()` lifted out of `app.js` and run against a stand-in window for each case it has to judge.

`/api/send-message` is covered inside `server.test.js`. Those tests assert the process is **still serving** after a malformed request, not just the status code — an uncaught throw in that handler ends the process and every open room with it. Any new async route must go through `asyncRoute()` for the same reason: Express 4 does not await handlers, so a rejected promise becomes an unhandled rejection and Node exits.

**The WebSocket side has the same hazard and the same kind of backstop.** Nothing catches what a `"message"` listener throws, so it ends the process too — the four characters `null` did it, because `JSON.parse` accepts them and reading `.type` off `null` throws. `handleMessage` now rejects anything that is not a plain object, and the listener wraps it in a `try`/`catch` for whichever input nobody has thought of yet. New message handling goes inside `handleMessage`, not in a second listener.

Not covered: the WebRTC and UI code in `app.js`, which needs a browser and two peers. Changes there still want a manual two-tab check. Also not covered: the ten-minute expiry of an unjoined room — the wait is hard-coded, so it was checked by hand against a server with its clock moved forward.

### Two ordering rules in `server.js`

Both are about work done before a request has earned it.

**`requireClientHeader` and `enforceEmailRateLimit` must stay ahead of `upload.single()`.** multer buffers the entire upload into memory before the handler runs, so any check placed after it has already let a stranger spend up to `LEAVE_ATTACH_MAX_BYTES` of RAM. The tests pin this by status code: an oversized upload with no client header must answer **403**, not 413 — a 413 means multer parsed it first.

**Anything client-supplied that reaches a log line goes through `safeLabel`.** A WebSocket `data.type` is arbitrary text up to `maxPayload`. Printed raw, a newline in it writes further log lines the attacker controls, including imitations of the real ones. Unknown types are also capped per socket, so one client cannot fill the log by inventing names.

### Framing (clickjacking)

`server.js` sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`. **Neither reaches the GitHub Pages build** — Pages serves static files and sets no headers, and browsers ignore `frame-ancestors` in a `<meta>` tag. So on Pages, `framebust.js` is the entire defence.

It has two halves, and both are load-bearing:

| In `index.html` | What it does |
| --- | --- |
| `<style id="antiClickjack">body{visibility:hidden}</style>` | hides the page before anything renders |
| `<script src="framebust.js">` | reveals it only after confirming we are not in a frame |

That order makes it **fail closed**: if the script never loads, the page stays blank instead of becoming an invisible click target. Both must stay ahead of every other script, because `app.js` opens a WebSocket the moment it parses.

Inside a frame, `framebust.js` first tries to replace the framing page. Do not rely on that — Chrome refuses top navigation from a cross-origin frame without a user gesture, and an attacker picks the sandbox flags anyway. What actually protects the page is what follows: `window.stop()` halts parsing so `app.js` never loads, and the body is replaced with a notice.

Measured against a headerless static server standing in for Pages, framed in a sandbox that blocks escape:

| | without `framebust.js` | with it |
| --- | --- | --- |
| Scripts parsed | `protocol.js`, `i18n.js`, `app.js` | `framebust.js` only |
| Lobby rendered | yes | removed |
| Clickable controls | Approve, Create room, Send message | none |

`server.js` must keep serving `/framebust.js`, or the Render build 404s on it and every page stays hidden — `test/csp.test.js` checks that, along with the load order and the hide-first style.

### Icon font

`index.html` loads Tabler icons from jsDelivr with a Subresource Integrity hash. The browser refuses the file unless it hashes to exactly that value, so a compromised or hijacked CDN cannot substitute a stylesheet — which matters because CSS alone can turn the amber shield green, and that shield is the only sign that nobody has verified the connection.

**Bumping the version means recomputing the hash**, or every icon silently disappears:

```
node -e "const h=require('https'),c=require('crypto');h.get(process.argv[1],r=>{const b=[];r.on('data',d=>b.push(d));r.on('end',()=>console.log('sha384-'+c.createHash('sha384').update(Buffer.concat(b)).digest('base64')))})" "https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@VERSION/dist/tabler-icons.min.css"
```

`test/csp.test.js` fails if any third-party tag in `index.html` lacks `integrity`, lacks `crossorigin` (without which the check is skipped rather than enforced), or points at a floating version.

The hash covers the stylesheet, not the font files it references. A hostile CDN could still serve altered glyphs — it could not hide an element or run code.

### Node version

`package.json` declares **`"node": ">=22"`**. Two reasons, and the second is the one that bites:

- `node --test` only accepts glob patterns from Node 21, and both test scripts rely on them — that is what keeps a new test file in the right suite by where it sits rather than by someone remembering to list it.
- **Render picks its own Node version when nothing says otherwise**, and can pick a different one on any redeploy. `engines` pins it.

22 rather than 21 because Node 21 is end-of-life. Nothing in the app itself needs anything newer than Node 18 — the floor comes from the tooling.

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
| `pre-commit` | `check-csp` + `check-build` + `npm run test:fast` | ~1s |
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
