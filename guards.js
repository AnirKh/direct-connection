/*
  ─────────────────────────────────────────────
  Direct Connection — guards.js
  ─────────────────────────────────────────────

  The safety decisions, as pure functions.

  Every one of these had a real bug behind it, and every one was invisible to
  the test suite because it lived inside DOM-driven code in app.js:

    mayCaptureForCall     a peer could send call-offer, or later call-accept,
                          cold and open the camera with no prompt shown
    consentedVideo        answering a voice call with withVideo:true turned the
                          camera on
    mayRenderText         plaintext arriving on the data channel was displayed,
                          which undid failing closed on a key mismatch
    mayDeliverRecording   a voice note recorded in one room was delivered to the
                          next room's peer
    shouldRetryAutoJoin   an invite-link join whose answer never arrived left
                          the lobby disabled behind "Joining…" forever
    mayHandleFrame        only chat text was checked for encryption; a file
                          announcement or a call request arriving in the clear
                          was acted on, even after the channel had been declared
                          unsafe
    mayStartRecording     a double-click opened the microphone twice and the app
                          kept track of one — the other stayed on until the tab
                          closed
    mayKeepMicOpen        the room could go away while the microphone was still
                          opening, leaving it live in the lobby
    mayApplyRoomEvent     "the other side left" named no room, so one room
                          expiring tore down the chat in another

  One is here without a bug behind it, because it is the thing users are asked
  to trust:

    shieldState           what the shield in the chat header says — nothing
                          yet, encrypted but unchecked, or verified

  Extracting them is the point: a rule that can be called with plain values can
  be tested for every combination, including the ones nobody thinks to try.
  app.js keeps the effects — opening the camera, drawing bubbles — and asks
  here whether it is allowed to.

  No DOM, no module state, no side effects.
*/

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DCGuards = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /* ══════════════════════════════════════════
     Calls
  ══════════════════════════════════════════ */

  /**
   * May getUserMedia run?
   *
   * `inCall` is set by pressing a call button or Accept, and by nothing a peer
   * sends. Both call paths — placing a call and answering one — reach the same
   * capture, so both must ask. The guard was added to one of them first and the
   * other went unnoticed for a release.
   */
  function mayCaptureForCall(inCall) {
    return inCall === true;
  }

  /**
   * How much capture the user actually agreed to.
   *
   * The peer's flag rides in on every call message and cannot be trusted alone.
   * This is an AND, not an override: the peer may answer a video call with
   * audio only — no camera on their side is a fair reason — but can never add
   * video to a call the user asked to keep voice-only.
   */
  function consentedVideo(pendingCallVideo, peerWantsVideo) {
    return Boolean(pendingCallVideo) && Boolean(peerWantsVideo);
  }

  /* ══════════════════════════════════════════
     Key exchange
  ══════════════════════════════════════════ */

  /**
   * May a peer public key be accepted?
   *
   * Exactly one exchange per data channel. A second key was accepted at any
   * time, including on a fully established channel, and re-derived the
   * verification code without changing the key actually in use — so the code on
   * screen stopped matching the key, the two sides displayed different codes,
   * and the UI still said "verified". On a PIN join that code is the only thing
   * standing between the user and a middleman, so a peer being able to set it
   * to anything empties it of meaning.
   *
   * Re-keying is not a feature here: a fresh channel runs a fresh exchange.
   *
   * `peerKeySeen` must be set the moment the first key arrives, not once its
   * derivation finishes — deriving is async, and a second key arriving during
   * that window is exactly the case worth refusing.
   */
  function mayAcceptPeerKey(o) {
    return Boolean(o) && !o.peerKeySeen;
  }

  /**
   * What the shield in the chat header should say.
   *
   *   "idle"  no key agreed yet — there is nothing to vouch for
   *   "warn"  encrypted, but nobody has checked for a middleman: a PIN join
   *           whose verification code has not been compared
   *   "ok"    authenticated — by the invite-link secret, or by the two people
   *           comparing the code
   *
   * The shield is the only standing sign of which of these a chat is in. It
   * replaced a full-width warning banner, so it carries that banner's whole
   * job: a PIN join is the path a middleman would force, and amber is how the
   * user finds out it happened.
   *
   * Green therefore has exactly two ways in, and both need a key to exist
   * first. Nothing merely truthy counts.
   *
   * @param {{ready: boolean, secure: boolean, verified: boolean}} o
   */
  function shieldState(o) {
    if (!o || o.ready !== true) return "idle";
    return (o.secure === true || o.verified === true) ? "ok" : "warn";
  }

  /* ══════════════════════════════════════════
     Incoming messages
  ══════════════════════════════════════════ */

  /**
   * May an incoming text message be displayed?
   *
   * Only when the agreed key opened it. The sender never transmits an
   * unencrypted body, so one arriving is never a real peer — and rendering it
   * would undo failing closed: that disables sending, but a middleman caught
   * swapping keys could still write into the chat window.
   */
  function mayRenderText(msg, e2eReady) {
    return Boolean(e2eReady) && Boolean(msg) && typeof msg.ct === "string" && msg.ct.length > 0;
  }

  /**
   * The only message types that may arrive outside the encrypted envelope.
   *
   * The handshake has to — there is no key yet. `e2e-dc` is the envelope
   * itself. `text` carries its own ciphertext and answers to mayRenderText.
   * `ack` and `typing` say nothing a watcher of the connection could not
   * already see from packet timing.
   *
   * Everything else — file announcements, call setup — is sent sealed, so it
   * is only believed sealed.
   */
  const CLEAR_TYPES = Object.freeze([
    "e2e-pubkey", "e2e-confirm", "e2e-fail", "e2e-dc",
    /* SPAKE2 handshake for a code room — runs before any key exists, and
       carries only public values (a curve point, a confirmation tag). See
       pake.js. The word itself never travels; it is proven, not sent. */
    "pake-msg", "pake-confirm",
    "text", "ack", "typing", "typing-stop"
  ]);

  /**
   * May a message from the data channel be acted on?
   *
   * `sealed` is true only for what came out of the envelope, which means the
   * agreed key opened it and the peer wrote it. Anything else on the channel
   * could have been written by whoever is carrying the packets.
   *
   * That party is not hypothetical: a signaling server that swaps the transport
   * fingerprints sits on the channel, and can pass the key exchange through
   * untouched so everything still reads as verified. It cannot open the
   * envelope — but it could write next to it. A clear `transfer-meta` drew a
   * file bubble with any name it liked; a clear `call-request` raised the
   * incoming-call prompt, and a clear `call-offer` after it was accepted as the
   * peer's — a call answered to whoever sent it.
   *
   * This is a list of what may be clear, not of what must be sealed, so a
   * message type added later is refused in the clear until someone decides
   * otherwise. The check that came before this one covered `text` alone, and
   * every other type was open by default.
   */
  function mayHandleFrame(type, sealed) {
    if (typeof type !== "string") return false;
    if (sealed === true) return true;
    return CLEAR_TYPES.includes(type);
  }

  /* ══════════════════════════════════════════
     Voice notes
  ══════════════════════════════════════════ */

  /**
   * May a finished recording be sent?
   *
   * A recording belongs to the room it started in. The recorder outlives the
   * room otherwise: leave while recording, join somewhere else, press the
   * button again — the press reads as "start" to the user but takes the stop
   * branch, and the file goes to whoever is connected now. That delivered
   * minutes of audio, including time spent in the lobby, to someone who was
   * never in the original room.
   *
   * @param {{recordedIn: string|null, currentRoom: string|null,
   *          discarded: boolean, channelOpen: boolean}} o
   */
  function mayDeliverRecording(o) {
    if (!o || o.discarded) return false;
    if (!o.channelOpen) return false;
    if (!o.recordedIn || !o.currentRoom) return false;
    return o.recordedIn === o.currentRoom;
  }

  /**
   * May a press on the record button open the microphone?
   *
   * Opening it is not instant, and `recording` only turns true once it has
   * opened. Two presses inside that gap — an ordinary double-click — each
   * opened a stream. The second replaced the first in the one variable that
   * remembers it, so the first could never be stopped: the microphone stayed
   * on, with nothing on screen saying so, until the tab was closed.
   *
   * @param {{recording: boolean, opening: boolean}} o
   */
  function mayStartRecording(o) {
    return Boolean(o) && !o.recording && !o.opening;
  }

  /**
   * The microphone has just finished opening. Is it still wanted?
   *
   * The permission prompt can sit on screen for as long as the user likes, and
   * the room can end underneath it. The clean-up that runs when a room ends
   * found nothing to stop — the stream did not exist yet — so the microphone
   * came on afterwards, in the lobby, with no button left to turn it off.
   *
   * @param {{askedIn: string|null, currentRoom: string|null, channelOpen: boolean}} o
   */
  function mayKeepMicOpen(o) {
    if (!o || !o.channelOpen) return false;
    if (!o.askedIn || !o.currentRoom) return false;
    return o.askedIn === o.currentRoom;
  }

  /* ══════════════════════════════════════════
     Invite-link join
  ══════════════════════════════════════════ */

  /**
   * The socket dropped. Should the pending join be sent again on reconnect?
   *
   * Only when one was outstanding and never answered. Without this the retry
   * was skipped and no answer ever came, leaving the lobby disabled with
   * nothing to click — and the invite already stripped from the URL, so
   * reloading did not help either.
   */
  function shouldRetryAutoJoin(o) {
    return Boolean(o) && Boolean(o.isAutoJoin) && Boolean(o.joinSent) && !o.joined;
  }

  /**
   * The server refused a join. Where does the reason go?
   *
   * There are three ways to ask to join, and each has its own place for a "no":
   *
   *   "dialog"  a PIN typed into the dialog — the dialog is on screen and has a
   *             line for errors
   *   "toast"   a tap on an open room in the list — nothing is on screen for
   *             it, so it has to be said some other way
   *   "lobby"   an invite link — the lobby is waiting on it
   *
   * Decided by which join is still waiting for an answer, never by how the page
   * was opened. That was a real bug: a page that arrived by invite link kept
   * routing every later refusal to the lobby, so a wrong PIN typed afterwards
   * was reported behind the dialog and left its button dead.
   *
   * @param {{pinJoin: boolean, listJoin: boolean, autoJoinPage: boolean}} o
   * @returns {"dialog"|"toast"|"lobby"}
   */
  function joinRefusalTarget(o) {
    if (!o) return "dialog";
    if (o.pinJoin)      return "dialog";
    if (o.listJoin)     return "toast";
    if (o.autoJoinPage) return "lobby";
    return "dialog";
  }

  /* ══════════════════════════════════════════
     Code rooms (SPAKE2)
  ══════════════════════════════════════════ */

  /** How many wrong-code attempts a host accepts before locking the room for a
      cooldown. SPAKE2 already limits an attacker to one guess per connection;
      this caps how fast those guesses can be made at all. */
  const CODE_MAX_ATTEMPTS = 10;

  /**
   * A guest just failed the SPAKE2 check on a code room. May the host accept
   * another attempt, or is it locked?
   *
   * The word is proven between the two phones, so the server cannot rate-limit
   * it — the host does, here. A short word has few possibilities, so without
   * this a stranger could reconnect and guess, one try per connection, as fast
   * as the link allows. After CODE_MAX_ATTEMPTS the host turns new guests away
   * until `until`.
   *
   * @param {{failures: number, now: number, lockedUntil: number}} o
   * @returns {{locked: boolean, until: number}}
   */
  function codeAttemptState(o) {
    const now = (o && o.now) || 0;
    if (o && o.lockedUntil && o.lockedUntil > now) return { locked: true, until: o.lockedUntil };
    const failures = (o && o.failures) || 0;
    if (failures >= CODE_MAX_ATTEMPTS) return { locked: true, until: now + 5 * 60 * 1000 };
    return { locked: false, until: 0 };
  }

  /* ══════════════════════════════════════════
     Received files
  ══════════════════════════════════════════ */

  /** Picture types a received "image" may be drawn and opened as. Raster only:
      an SVG is a document that can carry script. Anything else sent as a
      picture is offered as a download instead. */
  const SHOWABLE_IMAGE_TYPES = Object.freeze([
    "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/avif",
    "image/bmp", "image/heic", "image/heif"
  ]);

  /** How many transfers may be arriving at once. */
  const INCOMING_MAX_AT_ONCE = 16;

  /** The transfer id's shape: protocol.js makeTransferId, a v4 UUID. */
  const TRANSFER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  /** "Image/PNG; q=1" → "image/png". Empty for anything that is not a string. */
  function baseType(mimeType) {
    if (typeof mimeType !== "string") return "";
    return mimeType.split(";")[0].trim().toLowerCase();
  }

  /**
   * How a received file is shown, and the type its assembled blob is given.
   *
   * The blob's type is what the browser treats it as when it is opened, and
   * the sender chooses the type. A "picture" typed text/html, opened from the
   * chat — or a file link long-pressed into a new tab — would load as a page
   * from this site. So the sender's type is kept only when it can do nothing
   * but show: a raster picture, or sound. Everything else becomes a plain
   * download, typed application/octet-stream, which no browser renders.
   *
   * The sending side asks the same question, so a picture the receiver would
   * not draw is sent as a file in the first place, and both sides agree.
   *
   * @returns {{kind: "file"|"image"|"voice", blobType: string}}
   */
  function presentAs(kind, mimeType) {
    const type = baseType(mimeType);
    if (kind === "image" && SHOWABLE_IMAGE_TYPES.includes(type)) return { kind: "image", blobType: type };
    if (kind === "voice" && /^audio\/[a-z0-9.+-]+$/.test(type))  return { kind: "voice", blobType: type };
    return { kind: "file", blobType: "application/octet-stream" };
  }

  /**
   * A transfer-meta has arrived: take the file, or turn it away?
   *
   * The sending app refuses anything over the limit before it sends — but the
   * other side can run a changed app, and nothing on this side checked. A
   * stranger in a room with no PIN could stream data until the phone filled up.
   *
   *   "malformed"  not a transfer this app could have sent
   *   "too-big"    over the per-file limit
   *   "busy"       too many arriving at once, or too many bytes between them
   *
   * The declared size is a promise, not a fact; app.js holds the sender to it
   * byte by byte as the file arrives (withinDeclaredSize).
   *
   * @param {{meta: object, maxBytes: number, budgetBytes: number,
   *          activeBytes: number, activeCount: number}} o
   * @returns {{ok: true, kind: string, blobType: string} | {ok: false, reason: string}}
   */
  function incomingTransfer(o) {
    const meta = o && o.meta;
    const refuse = reason => ({ ok: false, reason });
    if (!meta || typeof meta !== "object") return refuse("malformed");
    if (typeof meta.id !== "string" || !TRANSFER_ID.test(meta.id)) return refuse("malformed");
    if (meta.kind !== "file" && meta.kind !== "image" && meta.kind !== "voice") return refuse("malformed");
    if (!Number.isSafeInteger(meta.size) || meta.size < 0) return refuse("malformed");
    if (meta.totalChunks !== undefined &&
        (!Number.isSafeInteger(meta.totalChunks) || meta.totalChunks < 0)) return refuse("malformed");
    if (!(meta.size <= o.maxBytes)) return refuse("too-big");
    if ((o.activeCount || 0) >= INCOMING_MAX_AT_ONCE) return refuse("busy");
    if (!((o.activeBytes || 0) + meta.size <= o.budgetBytes)) return refuse("busy");
    return { ok: true, ...presentAs(meta.kind, meta.mimeType) };
  }

  /** Has a transfer still sent no more than it said it would? */
  function withinDeclaredSize(receivedBytes, declaredBytes) {
    return Number.isSafeInteger(receivedBytes) && Number.isSafeInteger(declaredBytes) &&
           receivedBytes >= 0 && receivedBytes <= declaredBytes;
  }

  /* ══════════════════════════════════════════
     Chat messages
  ══════════════════════════════════════════ */

  /**
   * The longest chat message, in characters.
   *
   * A message goes as one data-channel message, and an oversized one is not
   * delivered late or in pieces — send() throws, or the channel closes. That
   * used to happen silently: a long paste did nothing, and the text sat in the
   * box with no word as to why. 64 KB is the size every browser's channel
   * carries in one message; at the worst case of 3 UTF-8 bytes per character,
   * 10 000 characters sealed and base64-encoded is about 40 KB.
   */
  const MAX_MESSAGE_CHARS = 10000;

  /** May this message be sent — or, arriving, be shown? */
  function messageFits(text) {
    return typeof text === "string" && text.length <= MAX_MESSAGE_CHARS;
  }

  /**
   * What the message box shows for a draft of `length` characters: a counter
   * once the draft is near the limit, marked over once it is past it.
   *
   * @returns {{counter: boolean, over: boolean}}
   */
  function draftState(length) {
    const n = Number.isFinite(length) ? length : 0;
    return { counter: n >= MAX_MESSAGE_CHARS * 0.9, over: n > MAX_MESSAGE_CHARS };
  }

  /* ══════════════════════════════════════════
     When the other side's link to the server drops
  ══════════════════════════════════════════ */

  /** ICE states in which the direct link is up, or may still come back. */
  const LINK_ALIVE = Object.freeze(["checking", "connected", "completed", "disconnected"]);

  /**
   * The server says the other side's connection to it dropped. Does that end
   * the chat?
   *
   * Once the two phones are connected the chat runs directly between them; the
   * server only introduced them. But a phone whose screen locks has its page
   * paused, and an iPhone cuts the page's link to the server almost at once.
   * The server saw that link drop and said "peer left", and the chat ended —
   * while the link between the phones was still up, or would have been as soon
   * as the screen came back on.
   *
   * So the server's word ends the chat only when the direct link is not up:
   * the channel never opened, or the link has already failed or closed.
   * Otherwise the chat carries on and the direct link decides — it closes when
   * the other side really leaves, and see linkLostForGood for when it fails.
   *
   * @param {{channelOpen: boolean, iceState: string}} o
   */
  function serverLeaveEndsChat(o) {
    if (!o || o.channelOpen !== true) return true;
    return !LINK_ALIVE.includes(o.iceState);
  }

  /**
   * The direct link has failed. Is it gone for good?
   *
   * A failed link is repaired by a fresh exchange through the server (an ICE
   * restart). Once the server has dropped the room there is nobody to carry
   * one, so a failure then is final — and the chat must say so, rather than
   * sit on "retrying" for ever.
   *
   * @param {{iceState: string, serverRoomGone: boolean}} o
   */
  function linkLostForGood(o) {
    return Boolean(o) && o.iceState === "failed" && o.serverRoomGone === true;
  }

  /* ══════════════════════════════════════════
     A call across a locked screen
  ══════════════════════════════════════════ */

  /**
   * Which of our call's microphone and camera need starting again?
   *
   * A phone that locks mid-call may stop them for good — the track ends — and
   * nothing started them again: back on the screen, the call was still up,
   * but the other side heard and saw nothing until someone hung up and rang
   * again. Only "ended" counts. "Muted" is the phone pausing a track, and the
   * phone resumes it itself.
   *
   * Starting them again is opening the microphone and camera, so it happens
   * only in an agreed call (mayCaptureForCall), and only for what the call
   * already had: a voice call never gains a camera here.
   *
   * @param {{inCall: boolean, tracks: {kind: string, readyState: string}[]}} o
   * @returns {string[]} "audio", "video", both or neither
   */
  function tracksToRestart(o) {
    if (!o || !mayCaptureForCall(o.inCall) || !Array.isArray(o.tracks)) return [];
    const kinds = [];
    for (const t of o.tracks) {
      if (!t || t.readyState !== "ended") continue;
      if ((t.kind === "audio" || t.kind === "video") && !kinds.includes(t.kind)) kinds.push(t.kind);
    }
    return kinds;
  }

  /**
   * What the call screen says about the other side, if anything.
   *
   *   "away"          their page is hidden — screen locked, or another app —
   *                   as their app told ours
   *   "reconnecting"  the call's own link is down for now, and may come back
   *   null            nothing to say
   *
   * Without this a locked screen on the other side was a frozen picture, or
   * silence, with nothing to say why. Their own word comes first: it says why,
   * where the link can only say that something is wrong.
   *
   * @param {{inCall: boolean, peerAway: boolean, linkState: string}} o
   */
  function callPauseNote(o) {
    if (!o || o.inCall !== true) return null;
    if (o.peerAway === true) return "away";
    if (o.linkState === "disconnected") return "reconnecting";
    return null;
  }

  /* ══════════════════════════════════════════
     Installing as an app
  ══════════════════════════════════════════ */

  /** An iPhone or iPad. iPadOS describes itself as a Mac, so a Mac with a
      touch screen counts too — no Mac has one. */
  function isAppleTouchDevice(userAgent, maxTouchPoints) {
    const ua = String(userAgent || "");
    if (/iPhone|iPad|iPod/.test(ua)) return true;
    return /Macintosh/.test(ua) && Number(maxTouchPoints) > 1;
  }

  /**
   * What the Install button does here, if anything.
   *
   *   "prompt"    the browser has offered to install this site (Chrome, Edge,
   *               Samsung Internet — beforeinstallprompt): the button asks it to
   *   "ios-help"  an iPhone or iPad, where no page can install itself: the
   *               button shows the taps that do it by hand
   *   "none"      already running as the installed app, or a browser that
   *               cannot install a site at all (Firefox): no button
   *
   * Running installed wins over everything: a button offering to install the
   * app you are already in would be nonsense.
   *
   * @param {{standalone: boolean, canPrompt: boolean, userAgent: string, maxTouchPoints: number}} o
   * @returns {"prompt"|"ios-help"|"none"}
   */
  function installOffer(o) {
    if (!o || o.standalone === true) return "none";
    if (o.canPrompt === true) return "prompt";
    if (isAppleTouchDevice(o.userAgent, o.maxTouchPoints)) return "ios-help";
    return "none";
  }

  /* ══════════════════════════════════════════
     Room events from the server
  ══════════════════════════════════════════ */

  /**
   * The server says something happened to a room. Is it the one on screen?
   *
   * These messages used to name no room, and the client assumed they meant the
   * current one. A browser that had opened a room and then moved to another
   * still heard about the first: ten minutes on, when it expired, "the other
   * side left" arrived and closed the live chat in the second.
   *
   * A message with no room at all is believed, for an older server that does
   * not name one yet. One that names a different room never is.
   *
   * @param {{eventRoom: string|null|undefined, currentRoom: string|null}} o
   */
  function mayApplyRoomEvent(o) {
    if (!o || !o.currentRoom) return false;
    if (o.eventRoom === undefined || o.eventRoom === null) return true;
    return o.eventRoom === o.currentRoom;
  }

  /* ══════════════════════════════════════════
     Updates
  ══════════════════════════════════════════ */

  /** `202610131742-3fa9c1d2` — when it was built, then a hash of what was
      built. Written by tools/sync-build.js. */
  const BUILD_ID = /^\d{12}-[0-9a-f]{8}$/;

  /**
   * Is build `a` later than build `b`?
   *
   * True only for two well-formed ids. One of them arrives from the server, and
   * something malformed must never talk a page into reloading itself.
   */
  function isNewerBuild(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (!BUILD_ID.test(a) || !BUILD_ID.test(b)) return false;
    return a.slice(0, 12) > b.slice(0, 12);
  }

  /**
   * The server has said which build it is. What should this page do about it?
   *
   *   "none"    the same build — or the server is the older one, which happens
   *             for a few minutes while it is still restarting after an update
   *   "reload"  this page is out of date and nothing is going on: fetch the new one
   *   "later"   out of date, but someone is mid-chat, mid-join or mid-sentence —
   *             remember it and fetch the new page once they are done
   *   "notify"  out of date, and a fresh page was already fetched without
   *             getting a newer one — the update has not finished arriving, and
   *             fetching again would only loop
   *
   * This is what makes a page that was left open notice an update. Without it
   * a tab from before the update kept running the old code for as long as it
   * stayed open: its owner saw a room that needs no PIN drawn as one that does,
   * was asked for a PIN that did not exist, and could not get in.
   *
   * @param {{serverBuild: string, pageBuild: string, retriedFor: string|null,
   *          recentlyReloaded: boolean, busy: boolean}} o
   */
  function updateAction(o) {
    if (!o || !isNewerBuild(o.serverBuild, o.pageBuild)) return "none";
    if (o.recentlyReloaded) return "notify";
    if (typeof o.retriedFor === "string" && o.retriedFor.indexOf(o.serverBuild) === 0) return "notify";
    return o.busy ? "later" : "reload";
  }

  return {
    isNewerBuild, updateAction,
    mayCaptureForCall, consentedVideo,
    mayAcceptPeerKey, shieldState,
    CODE_MAX_ATTEMPTS, codeAttemptState,
    SHOWABLE_IMAGE_TYPES, INCOMING_MAX_AT_ONCE, presentAs, incomingTransfer, withinDeclaredSize,
    MAX_MESSAGE_CHARS, messageFits, draftState,
    isAppleTouchDevice, installOffer,
    LINK_ALIVE, serverLeaveEndsChat, linkLostForGood,
    tracksToRestart, callPauseNote,
    CLEAR_TYPES, mayRenderText, mayHandleFrame,
    mayDeliverRecording, mayStartRecording, mayKeepMicOpen,
    shouldRetryAutoJoin, joinRefusalTarget,
    mayApplyRoomEvent
  };
});
