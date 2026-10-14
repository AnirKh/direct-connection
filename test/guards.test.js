/*
  Tests for guards.js.

  Every rule here had a real bug behind it, and every one of those bugs reached
  a release because the rule lived inside DOM-driven code in app.js that the
  suite could not execute. The old client-source.test.js could only assert that
  certain text appeared near other text.

  These call the rules with plain values, so every combination can be checked —
  including the ones nobody thinks to try, which is where the bugs were.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const G = require("../guards.js");

/* ══════════════════════════════════════════
   mayCaptureForCall — the camera
══════════════════════════════════════════ */

test("the camera opens only when a call was agreed to", () => {
  assert.equal(G.mayCaptureForCall(true), true);
  assert.equal(G.mayCaptureForCall(false), false);
});

test("nothing truthy-but-not-true opens the camera", () => {
  /* inCall is set by a button press and nothing else. Anything arriving from a
     peer that happens to be truthy must not count. */
  for (const value of [1, "yes", {}, [], "false", undefined, null, 0, ""]) {
    assert.equal(G.mayCaptureForCall(value), false, `${JSON.stringify(value)} must not authorise capture`);
  }
});

/* ══════════════════════════════════════════
   consentedVideo — the escalation
══════════════════════════════════════════ */

test("video needs both sides to want it", () => {
  assert.equal(G.consentedVideo(true, true), true);
});

test("the peer cannot add video to a voice call", () => {
  /* The bug: user presses the voice button, peer answers withVideo:true, and
     the camera came on. */
  assert.equal(G.consentedVideo(false, true), false);
});

test("the peer may answer a video call with audio only", () => {
  /* No camera on their side is a fair reason, so this is an AND and not an
     override in the other direction. */
  assert.equal(G.consentedVideo(true, false), false);
});

test("neither side wanting video means no video", () => {
  assert.equal(G.consentedVideo(false, false), false);
});

test("a missing flag is never treated as consent", () => {
  assert.equal(G.consentedVideo(undefined, true), false);
  assert.equal(G.consentedVideo(null, true), false);
});

/* ══════════════════════════════════════════
   mayAcceptPeerKey — one exchange per channel
══════════════════════════════════════════ */

test("the first peer key of a channel is accepted", () => {
  assert.equal(G.mayAcceptPeerKey({ peerKeySeen: false }), true);
});

test("a second peer key is refused", () => {
  /* The bug: a second key re-derived the verification code without changing
     the key in use, so the code on screen no longer described the key, the two
     sides showed different codes, and the UI still said "verified". */
  assert.equal(G.mayAcceptPeerKey({ peerKeySeen: true }), false);
});

test("a key arriving while the first is still deriving is refused", () => {
  /* Deriving is async. The flag is set on arrival rather than on completion,
     so this window is closed too. */
  assert.equal(G.mayAcceptPeerKey({ peerKeySeen: true }), false);
});

test("a missing argument does not throw", () => {
  assert.equal(G.mayAcceptPeerKey(undefined), false);
  assert.equal(G.mayAcceptPeerKey(null), false);
});

/* ══════════════════════════════════════════
   mayRenderText — failing closed
══════════════════════════════════════════ */

test("an encrypted message is shown once the key is agreed", () => {
  assert.equal(G.mayRenderText({ ct: "abc", iv: "xyz" }, true), true);
});

test("a plaintext message is never shown", () => {
  /* The sender refuses to transmit one, so an unencrypted body is never a real
     peer — and rendering it would undo failing closed: a middleman caught
     swapping keys could still write into the chat window. */
  assert.equal(G.mayRenderText({ text: "hello" }, true), false);
  assert.equal(G.mayRenderText({ text: "hello", ct: "" }, true), false);
});

test("nothing is shown before the key exchange finishes", () => {
  assert.equal(G.mayRenderText({ ct: "abc" }, false), false);
});

test("a malformed message does not throw", () => {
  for (const msg of [null, undefined, {}, { ct: null }, { ct: 42 }, { ct: {} }]) {
    assert.equal(G.mayRenderText(msg, true), false, `failed on ${JSON.stringify(msg)}`);
  }
});

/* ══════════════════════════════════════════
   mayDeliverRecording — the voice-note leak
══════════════════════════════════════════ */

const recording = o => Object.assign(
  { recordedIn: "room-a", currentRoom: "room-a", discarded: false, channelOpen: true }, o);

test("a voice note is delivered to the room it was recorded in", () => {
  assert.equal(G.mayDeliverRecording(recording({})), true);
});

test("a voice note is never delivered to a different room", () => {
  /* This is the one that leaked: record in room A, leave, join room B, press
     the button again — the press reads as "start" but takes the stop branch,
     and minutes of audio went to someone who was never in room A. */
  assert.equal(G.mayDeliverRecording(recording({ currentRoom: "room-b" })), false);
});

test("a voice note is dropped when there is no room any more", () => {
  assert.equal(G.mayDeliverRecording(recording({ currentRoom: null })), false);
});

test("an abandoned recording is never sent", () => {
  assert.equal(G.mayDeliverRecording(recording({ discarded: true })), false);
});

test("nothing is sent over a closed channel", () => {
  assert.equal(G.mayDeliverRecording(recording({ channelOpen: false })), false);
});

test("a recording with no room of its own is dropped", () => {
  assert.equal(G.mayDeliverRecording(recording({ recordedIn: null })), false);
});

test("similar room names are not treated as the same room", () => {
  assert.equal(G.mayDeliverRecording(recording({ currentRoom: "room-a " })), false);
  assert.equal(G.mayDeliverRecording(recording({ currentRoom: "Room-A" })), false);
});

test("a missing argument does not throw", () => {
  assert.equal(G.mayDeliverRecording(undefined), false);
  assert.equal(G.mayDeliverRecording(null), false);
});

/* ══════════════════════════════════════════
   shouldRetryAutoJoin — the stuck lobby
══════════════════════════════════════════ */

const join = o => Object.assign({ isAutoJoin: true, joinSent: true, joined: false }, o);

test("an unanswered invite-link join is retried", () => {
  /* Without this the reconnect skipped the join, no answer ever came, and the
     lobby sat disabled behind "Joining…" with nothing to click. */
  assert.equal(G.shouldRetryAutoJoin(join({})), true);
});

test("a join that already landed is not repeated", () => {
  assert.equal(G.shouldRetryAutoJoin(join({ joined: true })), false);
});

test("nothing is retried when no join was sent", () => {
  assert.equal(G.shouldRetryAutoJoin(join({ joinSent: false })), false);
});

test("a PIN join is not retried — there is no link to replay", () => {
  assert.equal(G.shouldRetryAutoJoin(join({ isAutoJoin: false })), false);
});

test("a missing argument does not throw", () => {
  assert.equal(G.shouldRetryAutoJoin(undefined), false);
});

/* ══════════════════════════════════════════
   mayHandleFrame — what may arrive unencrypted
══════════════════════════════════════════ */

/* Everything the app sends inside the encrypted envelope. */
const SEALED_ONLY = [
  "transfer-meta", "transfer-abort", "transfer-done",
  "call-request", "call-accept", "call-reject", "call-offer", "call-answer", "call-ice"
];

test("file announcements and call setup are refused in the clear", () => {
  /* The bug: only `text` was checked. A clear transfer-meta drew a file bubble
     with any name, and a clear call-request raised the incoming-call prompt —
     both still worked after the channel had been declared unsafe. */
  for (const type of SEALED_ONLY) {
    assert.equal(G.mayHandleFrame(type, false), false, `${type} must not be believed in the clear`);
  }
});

test("the same messages are accepted once the envelope opened them", () => {
  for (const type of SEALED_ONLY) {
    assert.equal(G.mayHandleFrame(type, true), true, `${type} must work when sealed`);
  }
});

test("the handshake, the envelope itself, acks and typing may arrive in the clear", () => {
  /* There is no key before the handshake, and the envelope cannot be inside
     itself. Refusing any of these would stop the chat from ever opening. */
  for (const type of ["e2e-pubkey", "e2e-confirm", "e2e-fail", "e2e-dc", "text", "ack", "typing", "typing-stop"]) {
    assert.equal(G.mayHandleFrame(type, false), true, `${type} must still be accepted`);
  }
});

test("a message type nobody has listed is refused in the clear", () => {
  /* The list says what MAY be clear, so a type added later is closed until
     someone decides otherwise. The check this replaced was the other way
     round — it named one type to protect and left the rest open. */
  for (const type of ["screen-share", "transfer-resume", "call-upgrade", ""]) {
    assert.equal(G.mayHandleFrame(type, false), false, `${JSON.stringify(type)} should be closed by default`);
  }
});

test("only a real true counts as sealed", () => {
  /* `sealed` is passed by the code that opened the envelope. Nothing a peer
     can put in a message must be able to stand in for it. */
  for (const value of [1, "true", {}, [], undefined, null, 0]) {
    assert.equal(G.mayHandleFrame("call-offer", value), false, `${JSON.stringify(value)} must not count as sealed`);
  }
});

test("a message with no usable type is dropped, sealed or not", () => {
  for (const type of [undefined, null, 42, {}, ["call-offer"]]) {
    assert.equal(G.mayHandleFrame(type, false), false);
    assert.equal(G.mayHandleFrame(type, true), false);
  }
});

test("names inherited from Object are not mistaken for message types", () => {
  assert.equal(G.mayHandleFrame("constructor", false), false);
  assert.equal(G.mayHandleFrame("__proto__", false), false);
  assert.equal(G.mayHandleFrame("toString", false), false);
});

/* ══════════════════════════════════════════
   mayStartRecording / mayKeepMicOpen — the microphone
══════════════════════════════════════════ */

test("the first press opens the microphone", () => {
  assert.equal(G.mayStartRecording({ recording: false, opening: false }), true);
});

test("a second press while the microphone is still opening does nothing", () => {
  /* The bug: a double-click. Both presses saw "not recording", each opened a
     stream, the second overwrote the first, and the first stayed on until the
     tab was closed. */
  assert.equal(G.mayStartRecording({ recording: false, opening: true }), false);
});

test("a press while recording never opens a second microphone", () => {
  assert.equal(G.mayStartRecording({ recording: true, opening: false }), false);
  assert.equal(G.mayStartRecording({ recording: true, opening: true }), false);
});

test("a missing argument does not open the microphone", () => {
  assert.equal(G.mayStartRecording(undefined), false);
  assert.equal(G.mayStartRecording(null), false);
});

const mic = o => Object.assign({ askedIn: "room-a", currentRoom: "room-a", channelOpen: true }, o);

test("the microphone stays open when the room is still there", () => {
  assert.equal(G.mayKeepMicOpen(mic({})), true);
});

test("the microphone is closed again if the room ended while it was opening", () => {
  /* The permission prompt can outlast the room. The room's clean-up ran with
     nothing to stop, and the microphone then came on in the lobby. */
  assert.equal(G.mayKeepMicOpen(mic({ currentRoom: null })), false);
  assert.equal(G.mayKeepMicOpen(mic({ channelOpen: false })), false);
});

test("the microphone is closed again if a different room is on screen", () => {
  assert.equal(G.mayKeepMicOpen(mic({ currentRoom: "room-b" })), false);
});

test("a press made with no room never keeps the microphone", () => {
  assert.equal(G.mayKeepMicOpen(mic({ askedIn: null })), false);
  assert.equal(G.mayKeepMicOpen(undefined), false);
});

/* ══════════════════════════════════════════
   mayApplyRoomEvent — which room the server means
══════════════════════════════════════════ */

test("news about the room on screen is acted on", () => {
  assert.equal(G.mayApplyRoomEvent({ eventRoom: "room-a", currentRoom: "room-a" }), true);
});

test("news about a different room is ignored", () => {
  /* The bug: open a room, then open a second and chat in it. Ten minutes on the
     first expired, "the other side left" arrived without a name, and the live
     chat in the second was closed. */
  assert.equal(G.mayApplyRoomEvent({ eventRoom: "typo-room", currentRoom: "real-room" }), false);
});

test("similar room names are still different rooms", () => {
  assert.equal(G.mayApplyRoomEvent({ eventRoom: "room-a ", currentRoom: "room-a" }), false);
  assert.equal(G.mayApplyRoomEvent({ eventRoom: "Room-A", currentRoom: "room-a" }), false);
});

test("an older server that names no room is still believed", () => {
  assert.equal(G.mayApplyRoomEvent({ eventRoom: undefined, currentRoom: "room-a" }), true);
  assert.equal(G.mayApplyRoomEvent({ eventRoom: null, currentRoom: "room-a" }), true);
});

test("nothing is acted on when no room is on screen", () => {
  assert.equal(G.mayApplyRoomEvent({ eventRoom: "room-a", currentRoom: null }), false);
  assert.equal(G.mayApplyRoomEvent({ eventRoom: undefined, currentRoom: null }), false);
  assert.equal(G.mayApplyRoomEvent(undefined), false);
});

/* ══════════════════════════════════════════
   shieldState — what the header shield says
══════════════════════════════════════════ */

const chat = o => Object.assign({ ready: true, secure: false, verified: false }, o);

test("the shield says nothing until a key has been agreed", () => {
  assert.equal(G.shieldState(chat({ ready: false })), "idle");
});

test("a PIN join nobody has verified shows the warning", () => {
  /* This is the state the full-width banner used to announce, and the one a
     middleman forcing the weaker path would put the chat in. The shield is now
     the only thing that says so. */
  assert.equal(G.shieldState(chat({})), "warn");
});

test("comparing the code turns the shield green", () => {
  assert.equal(G.shieldState(chat({ verified: true })), "ok");
});

test("an invite-link join is green without anyone typing a code", () => {
  assert.equal(G.shieldState(chat({ secure: true })), "ok");
  assert.equal(G.shieldState(chat({ secure: true, verified: true })), "ok");
});

test("the shield is never green before a key exists", () => {
  /* Stale flags from the previous chat must not vouch for the next one. */
  assert.equal(G.shieldState(chat({ ready: false, verified: true })), "idle");
  assert.equal(G.shieldState(chat({ ready: false, secure: true })), "idle");
  assert.equal(G.shieldState(chat({ ready: false, secure: true, verified: true })), "idle");
});

test("green has exactly two ways in, across every combination", () => {
  for (let bits = 0; bits < 8; bits++) {
    const o = { ready: Boolean(bits & 1), secure: Boolean(bits & 2), verified: Boolean(bits & 4) };
    const state = G.shieldState(o);
    assert.ok(["idle", "warn", "ok"].includes(state), `unexpected state ${state}`);
    assert.equal(state === "ok", o.ready && (o.secure || o.verified), `wrong for ${JSON.stringify(o)}`);
    assert.equal(state === "idle", !o.ready, `wrong for ${JSON.stringify(o)}`);
  }
});

test("nothing merely truthy turns the shield green", () => {
  for (const value of [1, "true", "yes", {}, []]) {
    assert.equal(G.shieldState({ ready: true, secure: value, verified: false }), "warn", `secure=${JSON.stringify(value)}`);
    assert.equal(G.shieldState({ ready: true, secure: false, verified: value }), "warn", `verified=${JSON.stringify(value)}`);
    assert.equal(G.shieldState({ ready: value, secure: true, verified: true }), "idle", `ready=${JSON.stringify(value)}`);
  }
});

test("a missing argument is not a verified chat", () => {
  assert.equal(G.shieldState(undefined), "idle");
  assert.equal(G.shieldState(null), "idle");
  assert.equal(G.shieldState({}), "idle");
});

/* ══════════════════════════════════════════
   joinRefusalTarget — where a "no" is shown
══════════════════════════════════════════ */

const refusal = o => Object.assign({ pinJoin: false, listJoin: false, autoJoinPage: false }, o);

test("a refused PIN goes to the PIN dialog", () => {
  assert.equal(G.joinRefusalTarget(refusal({ pinJoin: true })), "dialog");
});

test("a refused tap on an open room is shown as a toast", () => {
  /* Nothing is on screen for that join — no dialog was opened — so the dialog's
     error line would be writing to something hidden. */
  assert.equal(G.joinRefusalTarget(refusal({ listJoin: true })), "toast");
});

test("a refused invite link is reported in the lobby", () => {
  assert.equal(G.joinRefusalTarget(refusal({ autoJoinPage: true })), "lobby");
});

test("how the page was opened never outranks the join that is waiting", () => {
  /* The bug: a page opened by invite link sent every later refusal to the
     lobby, so a wrong PIN typed afterwards was reported behind the dialog and
     left its button dead. */
  assert.equal(G.joinRefusalTarget(refusal({ pinJoin: true, autoJoinPage: true })), "dialog");
  assert.equal(G.joinRefusalTarget(refusal({ listJoin: true, autoJoinPage: true })), "toast");
});

test("with nothing waiting and no invite link, the dialog is the fallback", () => {
  assert.equal(G.joinRefusalTarget(refusal({})), "dialog");
  assert.equal(G.joinRefusalTarget(undefined), "dialog");
});

/* ══════════════════════════════════════════
   peer-info — the device description
══════════════════════════════════════════ */

test("a device description is only believed from inside the envelope", () => {
  /* It is shown in the security panel. Accepted in the clear, whoever carries
     the packets could write the other person's device there themselves. */
  assert.equal(G.mayHandleFrame("peer-info", false), false);
  assert.equal(G.mayHandleFrame("peer-info", true), true);
  assert.ok(!G.CLEAR_TYPES.includes("peer-info"));
});

/* ══════════════════════════════════════════
   codeAttemptState — the host's limit on wrong-code guesses
══════════════════════════════════════════ */

const now = 1_000_000;

test("a fresh code room accepts attempts", () => {
  assert.deepEqual(G.codeAttemptState({ failures: 0, lockedUntil: 0, now }), { locked: false, until: 0 });
  assert.equal(G.codeAttemptState({ failures: G.CODE_MAX_ATTEMPTS - 1, lockedUntil: 0, now }).locked, false);
});

test("the room locks once the wrong-guess limit is reached", () => {
  /* SPAKE2 gives one guess per connection; this caps how many connections of
     guesses a stranger gets before the host shuts the door. */
  const s = G.codeAttemptState({ failures: G.CODE_MAX_ATTEMPTS, lockedUntil: 0, now });
  assert.equal(s.locked, true);
  assert.ok(s.until > now, "it locks for a cooldown, not forever");
});

test("a standing lock holds until it expires, then releases", () => {
  assert.equal(G.codeAttemptState({ failures: 0, lockedUntil: now + 1000, now }).locked, true);
  assert.equal(G.codeAttemptState({ failures: 0, lockedUntil: now - 1, now }).locked, false);
});

test("a missing argument does not throw and is not locked", () => {
  assert.equal(G.codeAttemptState(undefined).locked, false);
  assert.equal(G.codeAttemptState({}).locked, false);
});
