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

  return {
    mayCaptureForCall, consentedVideo,
    mayAcceptPeerKey,
    mayRenderText,
    mayDeliverRecording,
    shouldRetryAutoJoin
  };
});
