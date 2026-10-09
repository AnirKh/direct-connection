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

  return {
    mayCaptureForCall, consentedVideo,
    mayAcceptPeerKey,
    CLEAR_TYPES, mayRenderText, mayHandleFrame,
    mayDeliverRecording, mayStartRecording, mayKeepMicOpen,
    shouldRetryAutoJoin,
    mayApplyRoomEvent
  };
});
