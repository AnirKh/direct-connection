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
