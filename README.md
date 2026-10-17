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
| `pake.js` | SPAKE2 (RFC 9382) over P-256 — the password-authenticated key agreement a **code room** uses, so a short shared word verifies the chat with nothing to compare by hand. Pure; pinned to the RFC test vectors. See "Code rooms". |
| `vendor/noble.js` | The audited elliptic-curve + hashing library `pake.js` stands on (`@noble/curves`, `@noble/hashes`), bundled into one self-hosted file by `npm run build-vendor`. Used unmodified; do not edit by hand. |
| `app.js` | Everything stateful and everything with an effect: WebRTC, data channel, calls, chat UI. Asks the two modules above rather than deciding for itself. |
| `csp.js` | The Content-Security-Policy, defined once (see below). |
| `clientip.js` | Works out the real client address from `X-Forwarded-For`. Every rate limit depends on it, so it is separate and tested. |
| `ratelimit.js` | Sliding-window counters, their expiry sweep, `safeLabel` for anything client-supplied that reaches a log line, and `joinVerdict` — which join lock applies to which credential. Same reason as above: small, pure, security-relevant. |
| `framebust.js` | Refuses to run inside a frame. The only such protection on GitHub Pages (see below). |
| `manifest.webmanifest`, `icons/` | What makes the site installable as an app: its name, colours and icons. `icons/icon.svg` is the drawing; the PNGs are rendered from it. See "Installable as an app". `icons/link-preview.png` is the card a shared link shows — see "Link previews". |
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

This only works because the server never learns the secret. **The one rule: never put the room secret in a WebSocket message, a query string, a request body, or a log line.** Of the invite's three parts, only `sessionId` and `token` may go over the wire. (The host key a host sends to take its room back is the server's own secret, which it made and handed out — not the room secret, and never in a link.)

Breaking that rule would remove the protection while everything carried on working, so it is enforced rather than merely documented:

- `wsSend` runs `payloadLeaksSecret` over every outgoing message and **refuses to send** any that contains a secret. Losing one signalling message is recoverable; leaking the secret is not.
- The guard checks `roomSecret`, `pendingRoomSecret` **and** `_autoSecret`. The join is sent while the secret is still in `pendingRoomSecret` — `roomSecret` is only assigned once the server confirms — so checking one variable would leave the guard inert during the very message most likely to carry it.
- `test/client-source.test.js` fails if any `wsSend` payload mentions a secret, if `join-session` grows a field beyond `sessionId`/`pin`/`token`, or if a new secret-holding variable appears without being added to `roomSecretsInPlay()`.

### Three kinds of room

The lobby has a button for each. All hold the host and **one** guest.

| | PIN room | Open room | Code room |
| --- | --- | --- | --- |
| Created with | `create-session` | `create-session` `open:true` | `create-session` `code:true` |
| To get in from the list | type the 6-digit PIN | tap Join — nothing to type | type the shared **word** |
| Invite link | works, authenticates the key | the same | **none** — the word is the only way in |
| Verified (green) without comparing a code | only via the invite link | only via the invite link | **always**, once the word matches |
| Join locks | apply to PIN guesses | nothing to guess | host-side, on wrong-word attempts |
| Shown in the list as | 🔒 "PIN" | 🔓 "open" | 🔑 "word" |

An open room is first come, first served: whoever taps it first is in, it leaves the list, and anyone after that is told it is full. That is the whole meaning of "open" — **it is not a room for more than two people.**

### Code rooms — a short word, verified automatically (SPAKE2)

A PIN join is amber until the two people compare a code by hand, because the server makes the PIN and so cannot be shut out of the key agreement. A **code room** removes the hand step: the host invents a word, shares it out of band (says it, texts it), the guest types it, and the chat turns **green on its own**. The server never sees the word.

What makes a *short* word safe is that it can only be guessed **online, one try per connection**. There is nothing an attacker can capture and grind through offline. That property does not come from mixing the word into the key — doing that would hand an attacker exactly the offline dictionary attack to avoid — it comes from a real **PAKE**: **SPAKE2** (RFC 9382) over P-256.

- **`pake.js`** is the SPAKE2 protocol; **`vendor/noble.js`** is the audited elliptic-curve library it stands on (`@noble/curves`, bundled by `npm run build-vendor`, used unmodified). The curve math is never hand-rolled.
- **`test/pake.test.js` pins every step to the official RFC 9382 test vector** — `pA`, `pB`, the shared point `K`, the transcript, the derived keys, and both confirmation tags all match the RFC byte for byte. A second, independent check that the implementation is correct is not needed when it reproduces the specification's own numbers.
- The handshake runs over the data channel in place of ECDH: each side sends its SPAKE2 message, answers with a confirmation tag, and verifies the peer's. Matching words → the same key, authenticated → `e2eActivate(key, true)` → green. A wrong word → the tags do not verify → the channel never opens. Only public values cross the wire (a curve point, a tag); the word is **proven, never sent**, which is why `pake-msg`/`pake-confirm` are the only new types allowed outside the encrypted envelope.
- **The word reaches no server message.** `create-session` carries a boolean `code:true`, never the word; a test fails if any `wsSend` payload mentions `pakeCode`.
- **A code room offers no invite link.** The link carries the ECDH room secret, which this path does not use, so it would only fail to connect. The way in is the word.
- **A wrong word does not end the room.** The host turns the guest away (`release-guest`) and goes back to waiting, with a note — "Someone tried a wrong word — your room is open again" — and the guest goes back to the lobby, where the room is listed again. This used to be promised and not done: the guest's leaving deleted the room, so the right word could only ever find "not found", and the host sat on a dead chat screen believing it still had a room.
- **A code room outlives its guest.** Admission is first-come, so anyone can take the seat; a guest leaving used to delete the room, which let any stranger destroy any listed code room with one join. Now the server frees the seat and tells the host (`guest-left`); the host knows which it was. Before the word matched, it was an attempt, and the room stays. After, it was a chat, and the room goes as every room does once its chat has been — closed by the host, so the seat is never offered to someone else mid-chat. A code room's *host* leaving still closes it, and PIN and open rooms are unchanged.
- **Rate limit.** SPAKE2 already caps an attacker to one guess per connection; `codeAttemptState` in `guards.js` caps how many wrong attempts the host accepts at all — ten — before locking the room for five minutes, since the server cannot rate-limit a word it never sees. While locked, every guest is turned away, the right word too, and the host's note says the room is locked. When the five minutes are up the count starts again from nothing. It used not to: the count was kept, so the room locked again the moment its lock ended, for good — ten wrong words from anyone who could see the list, and the room's own guest could never get in.

Admission is the open-room model: the server lets the first person connect (it has no word to check), and the SPAKE2 handshake between the two browsers is the real gate. Only an explicit `code:true` makes a code room — anything else is still a PIN room.

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

## The lobby: three tabs

Under the title the lobby has three tabs — **Rooms | Create room | Email** — and shows one section at a time. It opens on Rooms, because most people arriving are joining someone, and returns there after a chat. The Rooms tab carries a count of open rooms, so it can be seen from the other two. A created room brings its host to the Create tab, where the PIN and link are; a room that expires while its host is on another tab is also said as a toast. Arrow keys, Home and End move along the tabs (`showLobbyTab`, `lobbyTabKeyTarget` in `app.js`).

**`#lobbyStatus` is for news that belongs to no tab.** The create card's status line used to carry everything: the server waking up, "Joining…" from an invite link, a link that was refused. With Rooms open by default, all of that would have been said inside a hidden tab. It now goes on a status line above the panels, shown on every tab and taking no room when empty. `#createInfo` keeps only what is about creating: "Creating…", the PIN and link, the room expiring.

## A locked screen does not end the chat

**The bug:** put the phone down for a minute and the chat was gone. A phone whose screen locks pauses the page, and an iPhone cuts the page's link to the server almost at once. The server saw that link drop and sent the other side `peer-disconnected`, and the other side's app ended the chat — though the chat runs directly between the two phones, and that link was still up, or would have been when the screen came back on.

**The server's word alone no longer ends a working chat** (`serverLeaveEndsChat` in `guards.js`). If the data channel is open and ICE is `checking`, `connected`, `completed` or `disconnected`, the notice is noted (`serverRoomGone`) and the chat goes on; the direct link decides from then on:

| What happens next | What the chat does |
| --- | --- |
| the other side wakes up | carries on; whatever was sent meanwhile arrives |
| the other side taps Leave | its channel closes, and that is said as "Peer disconnected" |
| the direct link fails | over: with the room gone from the server, nothing can carry an ICE restart (`linkLostForGood`), so it says "Lost the connection to the other side" instead of "retrying" for ever |

Our own link to the server dropping marks the room gone too, since the server drops a socket's room with the socket. One Back button, however many ways a chat ends at once.

**While a room is open the screen does not lock by itself** (`keepScreenOn`, the Screen Wake Lock API): from creating a room or joining one until the chat ends or you leave. The browser lets go whenever the page is hidden, so it is taken again when the page comes back, and again on a tap if Safari refused it without one. Where the API is missing or says no (battery saver), the screen behaves as usual. The power button still locks the phone.

**During a call**, a lock had two more effects, now handled (`tracksToRestart`, `callPauseNote` in `guards.js`; the block "A call across a locked screen" in `app.js`):

- **The microphone and camera come back by themselves.** A phone may stop them for good while locked, and nothing started them again: back on the screen the call was up but the other side heard and saw nothing. On return, whatever ended is opened again and swapped into the call with `replaceTrack` — no new call, no renegotiation. Only what ended, only in an agreed call (`mayCaptureForCall`, asked before opening and again after), never a camera for a voice call; muted stays muted and a camera turned off stays off. A track the phone takes while the page is showing is restarted at once; a device that keeps failing is given up on after five tries, with a toast.
- **The other side is told.** Each side sends `call-away` when its page is hidden and `call-back` when it returns, sealed like all call signalling, and the call screen says "The other person's screen is off, or they switched apps". If that message never gets out before the phone sleeps, the call's own link going down says "Reconnecting…" instead.

**Still not covered:** a phone locked for long enough that the direct link fails. Coming back from that needs the server to keep the room for a while and the waking phone to rejoin it.

## The host's own room

- **A waiting room survives its host stepping away** — see "A room that waits for its host". Only if it cannot be taken back (kept too long, or the server restarted) does the Create tab say "Your room closed — the connection to the server dropped", with **Create again**: same name, same kind, and for a code room the same word, which the guest already has. A PIN room then gets a new PIN.
- **A Create pressed while the link is down goes when it is back.** `wsSend` drops messages while the link is down, so this used to leave "Creating…" on screen and every create button disabled for good. The create message is kept as `pendingCreate` until the server answers, and sent — again, if need be — each time the link comes up; a room the server made and then dropped with the old socket is just made afresh. It carries the `code` flag, never the word, and `test/client-source.test.js` follows it there.
- **Your own room in the list says "Your room"** (`isOwnRoom`) instead of offering a Join button that could only fail.
- A refused invite link says why once: the second line, "the room may have expired", followed every refusal, and was wrong after "full".

## A room that waits for its host

To send the link, the host copies it and switches to a messaging app. The phone pauses the page, and an iPhone cuts its link to the server almost at once. The server used to delete the room with the link, so the link the friend received was dead by the time they tapped it.

- **The server keeps a waiting room for `HOST_AWAY_MS`** (ten minutes) when its host's link *drops* — a socket closing, not a leave. It stays listed. Leaving on purpose, or creating another room, still closes it at once; and a room whose chat has started ends as before, the chat itself deciding whether it goes on.
- **The host takes it back with its host key** (`reclaim-session`): a secret the server gives only the host's page with `session-created`, never in a link and never in a list, compared in constant time. A guest who has the link cannot take the room. Taken back, it is the same room — the same PIN, the same token, so the same link — and its ten minutes to find a guest start again.
- **A guest who arrives meanwhile gets in and waits.** `session-joined` says `hostAway`, and the chat says the host has stepped away instead of counting down to "could not connect"; when the host is back, the guest hears `host-back`, the host hears `guest-joined`, and they connect as usual. A guest who gives up and leaves frees the seat. A host who never comes back: the room goes once its time is up, and a guest still waiting is told.
- **The page itself may be closed in the background.** So the host's page keeps its waiting room in `sessionStorage` — this tab only — and a page opened fresh takes it back from there at its first connection (`restorableHostRoom` checks the record before it is believed). The record holds the room's secret and, for a code room, its word, so it lives no longer than the room: forgotten when the chat starts, the room ends, or the host leaves. The reclaim message carries the room's name and the host key, and nothing else.

## Opened inside another app's browser

A link sent through Facebook, Instagram, Messenger and the like opens in that app's own browser, not Safari or Chrome. It is run by the app, which can add its own code to the pages it shows (researchers showed in 2022 that Facebook's and Instagram's do); it often may not use the camera or microphone, so calls fail; and it closes, chat and all, when the app is left. `inAppBrowser` in `guards.js` recognises the common ones by name and any other Android WebView or iPhone browser that does not call itself Safari — never our own home-screen app, whose user agent does not either.

The page then says so first, before anything else, and offers the ways out (`inAppAdvice`):

| | |
| --- | --- |
| iPhone | **Open in Safari** — `x-safari-https://…`, which hands Safari the whole address, invite and all. Not an official feature: some apps block it, and then the note says to use their ⋯ menu. |
| Android | **Open in browser**, for the default browser — an `intent://` address — only when there is no invite in the address: it cannot carry the `#fragment`, which is where an invite keeps its secret, and the secret must never be moved anywhere a server would see it. |
| both | the app's own ⋯ → Open in browser, which takes the address as it is; **Copy link**, the whole invite, to paste into Safari or Chrome; **Continue here**. |

**While the notice is up, the invite stays in the address and nothing joins.** The page normally takes the invite out of the address as it loads; inside an app it keeps it, or Open in browser would carry a bare address. And it does not join: the seat is the friend's, and it belongs to the browser they are about to open — taken by the app's browser, it would leave the real one "full". Continue here lets go: the address is tidied and the invite joins, and this tab is not asked again. The Install button is hidden there too: nothing can be installed from inside another app.

Nothing here makes the app's browser safe; it only makes leaving it easy. A link sent through any app is also readable by that app and anyone in that chat — see "Code rooms" for a word that is said, not sent.

## The phone's Back button

To a phone, Back means "leave this page", so pressing it mid-chat closed the page and ended the chat for both people. While a chat is on screen, the page now holds one history entry of its own (`armBackGuard`): Back lands on this page instead of leaving it, and asks **"Leave the chat?"** — the chat ends for both of you; to keep it going while using another app, use Home or the app switcher. Back again, or **Stay**, keeps the chat; **Leave** leaves it. Once a chat has ended, Back just goes to the lobby (`backPress` in `guards.js`).

- **Chrome skips an entry a page added before the user touched it**, so Back would sail past it. A page opened from an invite link connects untouched, so there the entry is added at the first tap instead.
- **The entry is given back when the chat is left** — by Leave, the arrow, or a code room's host going back to waiting — so Back in the lobby goes where it always did. Only ever our own entry: going back past another would leave the page. And only once the chat is off screen, since giving it back queues a Back of its own.
- **Closing the tab or window mid-chat asks first** (`beforeunload`). It is listened for only while a chat is on: merely listening can keep a browser from caching the page.

This keeps Back from ending a chat; it does not make a chat run in the background. Home or the app switcher does that, within the limits each phone sets — see "A locked screen does not end the chat".

## A connection that never comes up

Some networks block direct connections, and with no relay server two such devices cannot reach each other at all. Both sides used to sit on "Connecting…" for as long as anyone watched. Thirty seconds after the chat screen opens (`CONNECT_GIVE_UP_MS`), if the channel has still not opened (`connectStalled`), the chat says so — one of the networks may be blocking direct connections; try switching between Wi-Fi and mobile data — with the Back button. It keeps trying underneath: a slow network that gets there late still connects, and the screen is kept on again when it does. A channel that opened but failed its key check is not this case; it says so itself.

## Installable as an app

The site can be installed: an icon on the home screen or desktop that opens in its own window, with no browser bar. `manifest.webmanifest` names it and lists the icons; `index.html` links it, plus the `apple-touch-icon` and `apple-*` lines iPhones read instead.

An **Install app** button sits at the bottom left of the lobby, and only where it can do something (`installOffer` in `guards.js`):

| Where | What the button does |
| --- | --- |
| Chrome, Edge, Samsung Internet | The browser offers to install (`beforeinstallprompt`); the offer is held, and the button spends it — the browser's own install window opens. An offer is good once, so the button goes with it. |
| iPhone, iPad | No page can install itself there. The button opens three steps: Share, Add to Home Screen, Add. iOS has no Mongolian, so those names stay in English. An iPad describes itself as a Mac; a Mac with a touch screen is taken for one. |
| Already running as the installed app | No button. |
| Firefox, Safari on a Mac | Cannot install a site from a button: no button. |

**No service worker.** Chrome and Edge no longer need one to offer the install — checked with the browser's own installability report, which lists nothing missing. A worker that cached files would also fight "One version in the browser at a time": it is exactly a second copy of the client that can go stale.

**Icons.** `icon.svg` is drawn on a 512 grid with everything inside the central circle a launcher may crop to. `icon-192.png` and `icon-512.png` are it with see-through corners; `icon-maskable-512.png` and `apple-touch-icon.png` are the same drawing on a full square, since Android crops a maskable icon to its own shape and iOS rounds the home-screen icon itself. The manifest, the SVG and the apple icon are in the build stamp, and pictures are hashed as bytes rather than text. The other PNGs are named only in the manifest and so are not stamped: if one is redrawn, give it a new name.

## Link previews

A shared link used to arrive bare in Messenger, Telegram, Facebook or WhatsApp. `index.html` now carries `og:*` lines (read by all of those), `twitter:*` lines and a `description` for search engines, so a link shows the name, one line of what it is, and `icons/link-preview.png`.

- **Every address is absolute** and points at GitHub Pages, the address people share — preview fetchers do not resolve relative ones. The Render copy of the page says the same, and `<link rel="canonical">` tells search engines which of the two is the main one. `test/csp.test.js` lets exactly that tag through without an integrity hash, since it loads nothing.
- **An invite link previews as the same card.** Its secret is in the `#fragment`, which no fetcher ever sends, and nothing in the card is built from the live address.
- **The picture** is 1200×630, the shape the big cards are drawn in, with the icon and name in the middle so a square crop keeps them, and under 300 KB, past which WhatsApp drops it. It is rendered from an HTML page; the services cache it by address, so a redrawn picture needs a new file name to show up.

## Calls: consent is local, never taken from the wire

Two rules. `test/guards.test.js` proves they give the right answer; `test/client-source.test.js` proves `app.js` asks before capturing:

- **`getUserMedia` runs only when `inCall` is already true.** `inCall` is set by pressing a call button or Accept — nothing a peer sends can set it. Every function that reaches `attachCallMedia()` must check it first, or the peer can skip the prompt and open the camera by sending `call-offer` or `call-accept` cold.
- **`pendingCallVideo` decides whether the camera is used, not the peer's `withVideo` flag.** That flag rides in on every call message; `consentedVideo()` ANDs the two, so the peer may answer a video call with audio only but can never add video to a call you asked to keep voice-only.

The test walks whichever functions call `attachCallMedia` rather than a fixed list of names, because the guard was added to one of the two paths first and the second went unnoticed for a release.

## The self-view: mirrored here, movable

In a video call your own picture is shown **mirrored**, the way a mirror shows you, and the other person sees you the right way round. The mirror is one CSS transform on `#localVideo` and nothing else. It flips the element on this screen; the track that is sent is the camera's own. Flip the track instead — in script, or by redrawing the camera through a canvas — and the other side receives a mirror image. `#remoteVideo` is never flipped: text behind the other person would read backwards.

The self-view can be **dragged** anywhere inside the call, by mouse or finger. Until it is moved, CSS keeps it in its corner; once moved, `moveSelfView()` places it by `left`/`top`, and `selfViewPosition()` keeps all of it at least 8px inside every edge. A `ResizeObserver` puts it back inside whenever the call or the picture changes size — a phone turned on its side, a camera whose shape is only known once it starts — so it can never be left off screen with no way to reach it. A hidden call measures 0×0; that is ignored rather than believed, or the picture would jump to the corner it was moved out of. Where it was put is kept for the next call on the same page, not across reloads.

The call buttons stay on top of it, so dragging it under them never blocks End call.

## Flipping the camera

A video call on a phone or tablet has a button to switch between the front and back cameras. It shows only where there is another side to flip to — more than one camera, and the one in use says which way it faces (`G.flipCameraOffered`). A computer's webcam says nothing about facing, so a computer never gets the button.

`flipCamera()` puts the other camera's track into the **same sender** with `replaceTrack`: no new call, nothing renegotiated, the other side just sees a different picture. What it has to get right:

- **The camera in use is stopped before the other is opened.** Many phones run one camera at a time and refuse the second while the first is open. iOS stops the first itself — which `watchCallTrack` would take for the camera dying, and start a restart in the middle of the flip. `stop()` fires no `ended`, so stopping it ourselves sets nothing off.
- **It asks before opening and checks again after**, like every other door to the camera: `G.mayFlipCamera` — a call that is on, that already has a camera, with nothing else changing it — and `mayCaptureForCall` once it has opened. A flip never brings video into a voice call. It shares `restartingCallMedia` with the restart after a lock, so the two can never swap tracks at once.
- **A camera that will not open leaves the call as it was.** The one that was in use is opened again and a message says the switch failed. If neither will open, the call goes on with sound, and coming back to the page tries the camera again.
- **Only the front camera is mirrored.** The back camera shows the world; text in it should read the right way round on this screen too. `showCameraFacing()` sets a class and the stylesheet does the rest — the mirror stays the stylesheet's alone.
- **A restart after a lock opens the camera last flipped to.** Both it and `attachCallMedia` ask `callVideo()`; a fixed "front camera" there turned a back camera round on every unlock. Each new call starts on the front camera.

## Sharing the screen

In a video call, a share button puts the screen in the camera's place. **Only where the browser can share** — a computer's (Chrome, Edge, Firefox, Safari on a Mac). No iPhone or iPad browser can share its screen, and mobile browsers generally cannot, so there the button never shows (`SHARE_SUPPORTED`, `G.shareOffered`). Watching a shared screen works everywhere: to the other side it is the video it was already getting.

- **The browser's own picker is the consent.** It asks which screen, window or tab, every time; nothing is shared without it. `G.mayShareScreen` decides only whether the call is one to share into — an agreed video call, nothing else changing its devices. Closing the picker leaves the call exactly as it was, with no message: not sharing is not an error.
- **The same sender** (`replaceTrack`): no new call, nothing renegotiated. A voice call has no video sender, so it gets no button.
- **The camera is stopped while sharing** — nothing captured that is not being sent — and opened again when sharing stops, by the button or the browser's own "Stop sharing" (the screen's track ending). The camera comes back as it was: facing the way it was last flipped, and off if it was turned off before sharing. If it will not open, the screen stops anyway and is left ended in the call, so coming back to the page tries the camera again.
- **The self-view shows what is shared, unmirrored** (`#localVideo.screen-share`) — what the other side sees, as they see it. The button is lit while sharing.
- **Nothing puts the camera back over the screen.** The flip refuses while sharing (`G.mayFlipCamera`), `restartLikeCallStart()` does nothing, and headphones moving move only the microphone.
- **A sharer in another window is not "away".** The sharer is usually in the window being shown, so the page being hidden does not send `call-away` while sharing.

Sharing is video only: the call's microphone carries on as it was, and a tab's own sound is not sent. Checked with two browsers through a local server, a stand-in screen and cameras: the other side saw camera, then screen, then camera again, in the same senders.

## Headphones connected mid-call

Reported: Bluetooth headphones connected during a video call on an iPhone, and the other person went on coming out of the phone's speaker. On an iPhone a call's sound goes wherever its microphone is, and the call's microphone was the phone's own — opened when the call began, before the headphones arrived. Headphones connected before the call were never a problem: the call opened theirs from the start.

So while a call is on, a change in the phone's microphones opens the microphone again (`followAudioDevice()`), which picks whatever the phone now prefers, and swaps it into the call's sender with `replaceTrack` — no new call. The sound follows it. Taking the headphones off works the same way, back to the phone.

- **Only microphones count.** The list of audio inputs is noted when the call's own microphone opens, and a `devicechange` that leaves it as it was — a camera, say — does nothing. Phones fire the event more than once for one connection, so it acts once things settle.
- **The new microphone is opened before the old one is stopped.** If it will not open, the call keeps the sound it had.
- **It asks `G.mayMoveMic`** — a call that is on, with a microphone in it, nothing else changing its devices — and checks the call again once the microphone has opened. It shares `restartingCallMedia` with the camera flip and the restart after a lock. Muted stays muted.

Whether the sound then reaches the headphones is the phone's doing; the page has no say over where sound goes on an iPhone. This was checked in a browser with stand-in devices, not on a phone with real headphones.

### Back to the loudspeaker

Reported next: with headphones taken off mid-call, the sound landed on the iPhone's quiet **earpiece**, as for a voice call, with no way back — while a video call started without headphones was on the loudspeaker and fine. The microphone had been opened again alone, and on its own the phone treated it as a voice call.

**A page cannot choose the loudspeaker over the earpiece on an iPhone** — no browser there offers it. What a page can do is what happens as a video call starts, which is when the phone picks the loudspeaker: stop the call's microphone and camera altogether and open both again (`restartLikeCallStart()`), swapping them into the same senders. Two things do that:

- **Headphones coming off in a video call** (`G.micChangeAction` → `"mic-and-camera"`: fewer microphones than before, and a camera in the call). Headphones arriving still open the microphone alone — that works, and does not blink the picture.
- **The loudspeaker button**, for whenever the sound is quiet. Only on an iPhone or iPad, only in a video call (`G.speakerOffered`): a voice call has no camera to open, and opening one would be capture nobody agreed to.

Everything is stopped *first*, unlike the microphone-only move: the phone decides where the sound goes when the capture starts, and it has to start. The cost is a moment without sound or picture while both come back. Muted stays muted, camera off stays off, and it shares `restartingCallMedia` with the flip and the restart after a lock. If they will not open, the tracks are left ended and coming back to the page tries again.

It is the phone's decision in the end. If an iPhone keeps the earpiece after this, a page cannot overrule it, and the button should go.

## The other person's picture on an iPhone

Reported from an iPhone: sometimes, in a video call, the other person's picture stayed black — while their voice came through, your own picture showed, and they could see you. The call was working; the picture was never drawn.

The `<video>` used to be handed an empty `MediaStream` when the call began, and the other side's tracks were added to that same stream as they arrived. Safari — the engine of every browser on an iPhone — keeps playing the sound of such a stream but may never draw a video track added after the stream was attached. Whether it did depended on the order things happened in, hence "sometimes".

So the picture is never given a stream to grow. `showRemoteTracks()` hands it a **fresh** stream holding every track so far, each time one arrives, so the video is there from the stream's first moment. As a second line, when the video track starts receiving frames and the picture is still 0 pixels wide, it is handed over once more. A picture already showing is left alone — re-attaching restarts the player, a hiccup in the sound for nothing.

`test/remotevideo.test.js` runs the real code against a stand-in `<video>`; three of its tests fail against the old code. It cannot run Safari, so the fix is confirmed on a phone or not at all.

## A call that cannot start says so to both sides

Setting a call up can fail on either phone: camera permission refused, a camera another app is holding, a description the browser will not take. Every such failure used to end the call with `endCall(false)` — this side went back to the chat with "call failed", and **the other side was never told**. It sat on a dark "Connecting…" screen until someone pressed End.

Each of those paths now goes through `callSetupFailed()`, which sends `call-reject` so the other side closes its call screen too. Accepting the other side's answer (`handleCallAnswer`) had no `try` at all and is now inside one.

One subtlety holds it together: **the call is ended on every failure, but the other side is told only if it was still on.** Hung up while the camera was still opening, the failure arrives after the call is over. Ending it again is what turns that camera back off — skipping it would leave the camera running with no call — but the hang-up already told the other side, so a second `call-reject` is not sent. `test/client-source.test.js` runs `callSetupFailed()` both ways, and checks that every function that opens the camera or takes a description hands its failure to it.

## A call nobody answers stops ringing

The other person away from the screen, or in another app, and nothing ended a call they never saw: the caller sat on "Calling…" for as long as anyone watched. A call now rings for `CALL_RING_MS` (45 seconds, in `guards.js`). If it is still only ringing then — not answered, not hung up (`callUnanswered`) — it is ended as a hang-up is, with `call-reject`, and the caller's chat says **"No answer"**. On the other side the incoming-call question goes away, and since it was still on screen when the hang-up arrived, the chat says **"Missed call"** rather than "Call ended". A caller who hangs up while it rings causes the same missed call.

An answer stops the ring (`initiateCallOffer`), and so does every way a call ends (`endCall`). The ring starts only once the call is placed. `test/ring.test.js` runs the block, `requestCall`, `endCall` and the `call-reject` case on a stand-in clock.

## One key exchange per channel

`e2e-pubkey` is accepted once. A second one used to re-derive the verification code while leaving the key actually in use untouched — so the code on screen stopped describing the key, the two sides displayed **different** codes, and the UI still said "verified". On a PIN join that code is the only thing standing between the user and a middleman, so a peer able to set it to anything empties it of meaning.

Re-keying is not a feature: a fresh channel runs a fresh exchange, and `e2eInit()` clears the flag. The flag is set the moment a key arrives rather than when its derivation finishes, because deriving is async and a second key arriving in that window is exactly the case worth refusing.

## Interrupted transfers say so, in both directions

A transfer that dies must not keep claiming to be running. Three paths cover it:

- the sender catches the failure, marks its own bubble failed, and sends `transfer-abort` if the channel is still up
- the receiver fails that transfer on `transfer-abort`
- both sides fail every in-flight transfer when the data channel closes

Before this, the peer leaving mid-transfer left the sender's bubble frozen at whatever percentage it had reached, permanently, next to an unhandled null-reference error. The receiver's bubble sat on "Receiving…" just as long. Neither side was told the file had not arrived.

## A received file is held to what it announced

The sending app refuses a file over 150 MB before it sends. The receiving app used to trust that and check nothing — but the other side can run a changed app, and in a room with no PIN the other side can be anyone. It could stream data until the phone filled up, or send a "picture" typed `text/html` that, opened from the chat, would load as a page from this site.

So the receiver now decides for itself (`incomingTransfer`, `presentAs` and `withinDeclaredSize` in `guards.js`):

| Check | When | What happens |
| --- | --- | --- |
| announced size over 150 MB | at `transfer-meta` | turned away before a byte is stored |
| more than 16 arriving at once, or more than 300 MB between them | at `transfer-meta` | turned away |
| an id, kind, size or chunk count this app could not have sent | at `transfer-meta` | turned away |
| one byte more than announced | as each chunk decrypts | cut off then, not at a `transfer-done` a changed app need never send |
| a chunk bigger than 64 KB plus IV and tag | on arrival | not decrypted, not parked |
| fewer bytes than announced | at `transfer-done` | failed, as a missing chunk already was |

Turning a transfer away frees what it held, says so in the chat, drops whatever more arrives under its id, and sends `transfer-abort`, which the sending app now obeys: it stops between chunks rather than sending the rest into nothing.

**The type the file is given is never the sender's.** A blob's type is what the browser treats it as when it is opened. A picture keeps its type only if it is a raster image (PNG, JPEG, GIF, WebP, AVIF, BMP, HEIC); a voice note only if it is `audio/…`. Everything else — an SVG, which can carry script, included — arrives as a plain download typed `application/octet-stream`, which no browser renders. The sender asks the same question, so an SVG picked as a picture is sent as a file and both sides show the same thing. A picture can be opened full size only once it has actually drawn; one that will not draw (a HEIC photo outside Safari) becomes a download link instead of a broken image.

## Messages have a limit, and say so

A chat message is at most **10 000 characters** (`MAX_MESSAGE_CHARS` in `guards.js`).

Before this, a long paste did nothing: Send was pressed, no bubble appeared, the text sat in the box, and nothing said why. A message goes as one data-channel message, sealed and base64-encoded, and two things broke past a certain size — `e2eEncrypt` spreads the sealed bytes into `String.fromCharCode`, which Safari refuses past 65 536 arguments, and the channel itself carries about 64 KB in one message in every browser. Either threw, and nothing caught it. At the worst case of 3 UTF-8 bytes per character, 10 000 characters is about 30 KB sealed and 40 KB on the wire; `test/message.test.js` checks both numbers.

- **Near the limit** a counter (`9500 / 10000`) appears over the box; **past it** the counter turns red and the box is marked `aria-invalid`. Nothing is cut off — a long paste stays whole, to be trimmed or split.
- **Pressing Send over the limit** shows a toast naming the limit. The text stays in the box.
- **Any other failure while sending** — the channel closing as Send is pressed — shows "Message not sent" and keeps the text, instead of an unhandled rejection.
- **The receiver holds the same limit**, since the other side can run a changed app: a longer message is not shown, not acknowledged, and a note says one arrived.

## Read aloud

Bubbles are drawn silently, so a screen reader found a new message only by going to look for one. `#srAnnouncer` is a visually hidden `aria-live="polite"` region, and `announce()` writes into it: each message from the other side ("New message: …"), each file, picture or voice note arriving, every system note, and the too-long warning. Your own messages are not read back. Only the last three lines are kept — it is a voice, not a history, and `aria-relevant="additions"` keeps the pruning silent.

## Telling you something arrived

A message, a file or a call that came while nobody was looking at the page — another tab, another app, another window in front — arrived in silence: no sound, nothing in the tab's title, and an incoming call rang nobody. The block "Telling you something arrived" in `app.js`:

- **A message, file, picture, voice note or missed call while the page is not looked at** (`unattended`: hidden, or on screen without the focus) gets a short two-note chime, a buzz where the phone has one, and a count in the title — "(2) Шууд холбоос" (`tabTitle`) — and on the installed app's icon (`setAppBadge`). The count goes once the page is looked at again. A burst of messages chimes once and counts every one. While the page is looked at, nothing.
- **An incoming call rings**, looked at or not — a phone left on the table with its screen kept on is the usual case — with a phone in the title and a buzz on Android, until it is answered, turned down or over. The caller gives up after `CALL_RING_MS`; the ringing gives up five seconds later on its own, as a missed call, so a hang-up lost on the way cannot leave it ringing.

The sounds are made with Web Audio — no sound files — and scheduled on the sound's own clock, which keeps time in a background tab where timers are slowed. A ring is cut by disconnecting its own output, which silences every ring still to come at once.

**What it cannot do.** No browser lets a page make a sound before it has been touched, so the sound is readied at the first tap or key; until then only the title counts. A page the phone has put to sleep — an iPhone with its screen off, or Safari in the background — runs none of this until it wakes, and Android ignores a buzz from a hidden page. Only a notification sent through a server reaches a phone in that state, which this app does not have.

## Only the handshake may arrive unencrypted

Two things travel on the data channel: frames in the clear, and an `e2e-dc` envelope that the agreed key seals. **Anything the app sends sealed is believed only sealed.** `handleTextMessage` takes a `sealed` flag that is true in exactly one place — where `e2eDecrypt` hands over what the envelope held — and asks `mayHandleFrame` before acting on anything.

| May arrive in the clear | Why |
| --- | --- |
| `e2e-pubkey`, `e2e-confirm`, `e2e-fail` | the ECDH handshake — there is no key yet |
| `pake-msg`, `pake-confirm` | the SPAKE2 handshake for a code room — also before any key, and only public values (a curve point, a tag) |
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

## The same link opened twice: the newer copy takes the seat

Reported: a link sent through Messenger, opened by the guest, who then chose Safari — and was told the room was full. The link had opened first in Messenger's own browser, and that copy had taken the one guest seat. It stayed connected in the background, so Safari was refused; and when it finally dropped, a guest leaving deletes the room, so the invite was lost either way. The in-app notice holds the join until the person chooses, but "Continue here" joins, and an app that opens links in a Safari-based viewer is not detected at all.

The invite link is one person's. A second copy of it arriving is that person in another browser, so **a seat taken through the link moves to a newer copy of the link that someone is looking at** (`joinVerdict` → `"replace"`, in `ratelimit.js`):

- **Only a copy on screen takes the seat by itself.** The join carries `visible` — the page's own `document.visibilityState`, nothing more. The first version let any copy take the seat, and one nobody was looking at — a second Safari tab opened behind the first, an app's browser loading again in the background — took it from the Safari page the guest was using: the guest watched it say the chat had moved, and the host tried to connect to a page nobody had open. A copy in the background is refused with `held-elsewhere` instead, and so is a page too old to say.
- **Every copy without the seat offers "Continue here"** — the one that lost it (`seat-taken`) and the one refused it (`held-elsewhere`). Whichever copy the person is actually looking at, one tap makes it the one in use. Only the tap does: neither copy ever takes the seat back by itself.

- **The room is kept.** The guest has not left, only changed browsers. The server swaps the seat; the copy left behind is no longer the guest, so its socket closing later ends nothing.
- **The copy left behind is told** (`seat-taken`), says the chat moved to another browser, and **never joins with the link again by itself** (`inviteMovedAway`) — only through its "Continue here". Without that, the phone putting the app to sleep drops its socket, the reconnect re-sends the join, and the two copies take the seat back and forth for as long as both are open.
- **The host is told it is a new copy** (`guest-joined` with `replaced: true`): the old connection is let go of quietly, the chat on screen stays, a line says the other person reopened the link, and the connection starts again — verified, since the new copy carries the same room secret.
- **Only the link moves a seat taken by the link.** A guest let in by a PIN or by tapping an open room is not moved by the link, and a PIN does not move a link guest.
- **The same socket sending its join twice is not a second copy.** "Replacing" itself would run the guest-left clean-up on the room's own guest and delete the room; it is told "full", as before.

What it costs, said plainly: anyone holding the link can take the seat from whoever holds it through the link, mid-chat. That was already true of the first person to arrive — the link is the credential — and the host is told every time it happens.

## Join locks are for PINs, not invite links

Three wrong attempts lock an address out for 30 seconds; fifteen against one room lock the room for five minutes. Both exist to slow down guessing a 6-digit PIN.

**A correct invite token goes through both** (`joinVerdict` in `ratelimit.js`). The token is 192 random bits — nobody presenting the right one is guessing. Holding it to the PIN's locks protected nothing, and room names are public, so anyone could lock an invited guest out of a room they held a valid link to, for as long as they cared to keep it up.

**A correct PIN does not.** If a right PIN were admitted during a lock, the lock would stop nothing — the guesser would keep going until one landed. Someone can therefore still lock a room against PIN joiners; that is the price of a guess limit on a short code, and the invite link is the way round it.

**An open room is outside both locks**, for the same reason as the token: nothing is being guessed. And arriving at a PIN room with no PIN and no token is not a guess either — it gets `pin-required` and is not counted, where a wrong PIN is. Counting it would lock people out for looking.

Because nothing limits how often a token may be tried, both secrets are compared in constant time (`secretMatches`).

## A browser that keeps nothing

With cookies blocked — a setting every browser has — merely reading `localStorage` throws, and some apps' built-in browsers have none at all. `i18n.js` read the saved language on its first line with nothing to catch that, so it threw, `I18N` was never made, and `app.js` stopped at its first word: the page looked as usual and nothing on it worked — no room list, no button. Reproduced in Edge with cookies blocked. The language is now read inside a `try`, where anything but `"en"` means Mongolian, and saved inside one, so with storage off the page works and only forgets the language when it closes. Every use of `sessionStorage` was already guarded. **Any new read or write of storage goes in a `try`.**

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
- `test/integration/server.test.js` — spawns a real server on port 3199 with a 1-second heartbeat: join rules, PIN lockout, an invite token getting through a locked room, open rooms (one guest, no PIN, never open by accident), one room per socket, room-name reuse, a peer that vanishes without disconnecting, and the same link opened again (the seat moves to a copy on screen and not one in the background, the room stays, the copy left behind ends nothing). Each client presents its own `X-Forwarded-For` so one test's rate-limit lockout does not leak into the next.
- `test/csp.test.js` — fails if `index.html` has drifted from `csp.js`, and covers the framing and third-party-asset rules above.
- `test/ratelimit.test.js` — the sliding window, its expiry sweep, log sanitising, and every combination of `joinVerdict`'s seven inputs. The sweep has no external symptom until the process runs out of memory, which is why it is tested directly.
- `test/guards.test.js` — the safety decisions, every combination.
- `test/connstats.test.js` — which route ICE chose, link quality, byte totals, and which addresses are shown, with a plain Map standing in for the stats report. Also device descriptions, including that nothing a peer sends as one reaches the screen as it was sent.
- `test/shield.test.js` — the shield and its panel, lifted out of `app.js` and **run** against stand-in elements: what sentence, addresses and devices end up on screen in each state. Added because a text-level check passed while the "who can read this" sentence was never being redrawn.
- `test/pake.test.js` — SPAKE2: every step against the official RFC 9382 test vector (`pA`, `pB`, the shared `K`, the transcript, the derived keys, both confirmation tags), plus matching words reaching one key, and wrong words, tampered messages and invalid points failing.
- `test/build.test.js` — the build stamp: that it still describes the files, that every local file carries it, and `refuseToRunInAStalePage()` lifted out of `app.js` and run against a stand-in page.
- `test/screenshare.test.js` — screen sharing: `G.mayShareScreen`, `G.shareOffered` and the flip refusing while sharing, then `startScreenShare()` and `stopScreenShare()` lifted out of `app.js` and run against a stand-in screen and camera — the same sender, the camera stopped only once the screen is in, the picker closed, a hang-up mid-picker, the browser's own Stop sharing, the camera coming back as it was or not at all.
- `test/headphones.test.js` — where a call's sound goes: `G.mayMoveMic`, `G.micChangeAction` and `G.speakerOffered`, then `followAudioDevice()` and `restartLikeCallStart()` lifted out of `app.js` and run against stand-in devices — only a change in microphones counts, the same sender, the old microphone stopped only once the new one is in, muted kept, a hang-up mid-open, a microphone that will not open.
- `test/flipcamera.test.js` — the camera flip: `G.mayFlipCamera` and `G.flipCameraOffered` in every combination, then `flipCamera()` and `updateFlipCamBtn()` lifted out of `app.js` and run against stand-in cameras — stopped before the other opens, the same sender, a hang-up mid-open, a camera that refuses, only the front mirrored.
- `test/selfview.test.js` — the self-view: that only it is mirrored and only by the stylesheet, and `selfViewPosition()`, `moveSelfView()` and `keepSelfViewInside()` lifted out of `app.js` and run against stand-in elements — past every edge, a phone turned on its side, a hidden call.
- `test/remotevideo.test.js` — the other person's picture: `createCallPeerConnection()`, `showRemoteTracks()` and `playRemoteCallMedia()` lifted out of `app.js` and run against a stand-in `<video>` and connection — never an empty stream to start, a fresh stream per arriving track, a blank picture re-attached when frames arrive, a showing one left alone.
- `test/i18n.test.js` — both languages have the same keys, every key `app.js` asks for by name exists in both, and every `data-i18n`, `data-i18n-ph` and `data-i18n-aria` key in `index.html` does too, since a missing one falls back silently. That `i18n.js` loads with storage throwing, missing or holding nonsense, and that switching language works with storage blocked. Also that the page opens straight to the lobby, with "about this page" as a dropdown beside the title rather than the dialog every visit used to start with, and that on a phone that button sits below the fixed language switcher rather than under it.
- `test/awake.test.js` — a locked screen: `serverLeaveEndsChat` and `linkLostForGood` for every link state, and the `peer-disconnected` case, the ICE state handler, `endChatLinkLost`, `showReconnectButton` and the keep-the-screen-on block lifted out of `app.js` and run — a notice that leaves a working chat alone, a failure that ends one only when the server cannot repair it, a wake lock taken, retaken on return and on a tap, and let go on leaving.
- `test/callpause.test.js` — a call across a locked screen: `tracksToRestart` and `callPauseNote`, and the block lifted out of `app.js` and run against a stand-in call — the other side told on hide and return, ended tracks reopened and swapped in place, mute kept, a hang-up during the reopening putting everything back, one reopening at a time, a limit on retries, and the note's three states.
- `test/attention.test.js` — telling you something arrived: `unattended` and `tabTitle`, and the block lifted out of `app.js` and run against a stand-in page, sound and clock — a chime, a buzz and a count while nobody looks and none while someone does, a burst chiming once, the count going once the page is really looked at, no sound before a tap, a sleeping sound woken, a ring that is cut whole and never starts after an answer, and a lost hang-up ending as a missed call.
- `test/ring.test.js` — a call nobody answers: `callUnanswered`, and the ring block, `requestCall`, `endCall` and the `call-reject` case lifted out of `app.js` and run on a stand-in clock — given up after 45 seconds with both sides told, an answered call left alone, a hang-up stopping the ring, and a missed call said as one on the other side.
- `test/preview.test.js` — the link-preview card: description, `og:*` and `twitter:*` lines present and agreeing, every address absolute and under the shared address with no fragment or query, and the picture on disk at the size the card claims, under 300 KB, served by `server.js`.
- `test/hostaway.test.js` — a room that waits for its host: `restorableHostRoom`, and the take-back block and its signalling cases lifted out of `app.js` and run — the room kept in this tab and taken up by a page opened fresh, a code room keeping its word, an invite page taking up nothing, broken or stale records thrown away, the reclaim carrying only the name and host key, and the guest waiting for the host. The server's half — rooms kept on a drop and not on a leave, the host key and nothing else taking them back, waiting guests, expiry — is in `test/integration/server.test.js`.
- `test/inapp.test.js` — opened inside another app's browser: `inAppBrowser` against the user agents Facebook, Instagram, Messenger, TikTok, LINE, Snapchat and WeChat really send, real browsers and our home-screen app left alone, the ways out for each phone, Safari handed the whole invite and Android never one with a fragment, and the hold and the notice lifted out of `app.js` and run — the invite kept and nothing joined while it is up, Copy link copying the whole invite, and Continue here joining.
- `test/back.test.js` — the phone's Back button: `backPress` and `chatIsLive`, and the Back-button block lifted out of `app.js` and run against a stand-in history — Back asking and staying on the page, Back again and Stay keeping the chat, Leave giving the entry back and never going past one that is not ours, an ended chat going to the lobby unasked, no entry before the first tap, and the close warning only while a chat is on.
- `test/codewait.test.js` — a code room through a wrong word, and a connection that cannot come up: `pakeFailClosed`, `returnToWaitingRoom`, the `guest-left` case and the connection watch lifted out of `app.js` and run — the host turning the guest away and waiting again with a note, our own closing kept from running the close handler, a failed attempt kept apart from an ended chat, ten wrong words locking the room for five minutes and a fresh count after, and the give-up note after thirty seconds with no channel. The server's half — seats freed, rooms kept, only the host turning a guest away, PIN and open rooms unchanged, and the upload limit — is in `test/integration/server.test.js`.
- `test/room.test.js` — the host's own room: `waitingRoomLost` and `isOwnRoom`, and `loseWaitingRoom`, `recreateRoom`, `createRoom` and `sendPendingCreate` lifted out of `app.js` and run — the lost room said and made again as the same kind, a code room keeping its word without sending it, a create kept while the link is down and sent once it is up.
- `test/install.test.js` — installing as an app: `installOffer` for each browser and the installed app, the button's block lifted out of `app.js` and run against a stand-in window (offer held, spent once, gone when installed; the iPhone steps open and close), and the manifest and icons read from disk — sizes, relative addresses, no see-through corners where the icon is cropped, and every one served by `server.js`.
- `test/lobby.test.js` — the lobby's tabs: the markup (three tabs, each naming its panel, Rooms open first, each section's controls inside its own panel, the status line outside them all), that nothing unrelated to creating is written into the Create tab, and `showLobbyTab()`, `lobbyTabKeyTarget()` and `renderSessionList()`'s room count lifted out of `app.js` and run.
- `test/message.test.js` — long messages and read-aloud: `sendTextMessage`, `updateMessageCounter`, `announce`, `appendBubble`, `appendSys` and the `text` case lifted out of `app.js` and run. The limit's arithmetic against the wire and Safari's argument cap; at the limit sent and shown, one past it refused on both sides with a reason; a failed send keeps its text; the counter's states; what is read out, what is not, and that the page carries the region.
- `test/receive.test.js` — receiving files: the real `sendBinary`, `handleTransferMeta`, `acceptChunk`, `handleBinaryChunk`, `assembleTransfer` and the transfer cases of the message switch, lifted out of `app.js` and run as two sides against each other. Honest files, pictures and voice notes arrive whole and correctly typed; a changed app's oversized, overlong, short, mistyped or too-many transfers are turned away, and an honest sender that is turned away stops sending.
- `test/layout.test.js` — the phone-keyboard fix: that every full-height rule reads `--app-height`, and `fitToVisibleArea()` lifted out of `app.js` and run against a stand-in window for each case it has to judge.

`/api/send-message` is covered inside `server.test.js`. Those tests assert the process is **still serving** after a malformed request, not just the status code — an uncaught throw in that handler ends the process and every open room with it. Any new async route must go through `asyncRoute()` for the same reason: Express 4 does not await handlers, so a rejected promise becomes an unhandled rejection and Node exits.

**The WebSocket side has the same hazard and the same kind of backstop.** Nothing catches what a `"message"` listener throws, so it ends the process too — the four characters `null` did it, because `JSON.parse` accepts them and reading `.type` off `null` throws. `handleMessage` now rejects anything that is not a plain object, and the listener wraps it in a `try`/`catch` for whichever input nobody has thought of yet. New message handling goes inside `handleMessage`, not in a second listener.

Not covered: the WebRTC and UI code in `app.js`, which needs a browser and two peers. Changes there still want a manual two-tab check. Also not covered: the ten-minute expiry of an unjoined room — the wait is hard-coded, so it was checked by hand against a server with its clock moved forward.

### Three ordering rules in `server.js`

All are about work done before a request has earned it.

**At most `UPLOADS_AT_ONCE` (2) uploads are read at a time** (`limitConcurrentUploads`). multer holds each one in memory — up to the attachment limit — and the rate limit is per address, so nothing else bounded how many arrive together: a handful of large uploads from a few addresses could use up the instance's memory, and the restart would drop every live chat. One past the limit gets **503** before a byte of its body is read, does not count against its sender's allowance, and is said in the user's language. A slot is freed when the request is answered or its connection goes.

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
- **`HOST_AWAY_MS`** — how long a waiting room is kept for a host whose link dropped, in ms (default **600000**, ten minutes; accepted range 1000–3600000). See "A room that waits for its host".
- **`HEARTBEAT_MS`** — how often the server pings each WebSocket client, in ms (default **30000**, accepted range 1000–300000). A client that misses a sweep is dropped, which frees its room and tells the other peer. Lower it only for testing; every client answers every sweep, so short intervals mean constant traffic.
- **`LEAVE_ATTACH_MAX_BYTES`** — optional max attachment size for the main-page email form (default **28 MB**). Resend rejects emails over **~40 MB** total after encoding, so do not set this above **35 MB** unless you use another mail provider.
