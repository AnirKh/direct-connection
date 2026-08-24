/*
  Source-level checks on app.js.

  app.js needs a browser and two peers to run, so these read it as text rather
  than executing it. That is a weaker guarantee than a runtime test and it is
  deliberate: these guard invariants where the failure is silent, so a coarse
  check that fires is worth more than a precise one that does not exist.

  The runtime half of the secret-leak guard lives in protocol.test.js
  ("payloadLeaksSecret"), and wsSend enforces it on every outgoing message.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

/** Comments mention the same identifiers as the code, which throws off any
    check about ordering — strip them before reasoning about statements. */
function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Top-level function declarations, by name. Bodies end at a closing brace in
    column 0, which is how every function in app.js is written. */
function topLevelFunctions(src) {
  const found = new Map();
  for (const m of src.matchAll(/^(?:async\s+)?function (\w+)\s*\([^)]*\)\s*\{[\s\S]*?^\}/gm)) {
    found.set(m[1], m[0]);
  }
  return found;
}

/** Every `wsSend({ ... })` literal in app.js. Payloads here are flat objects. */
function wsSendPayloads() {
  return Array.from(appSrc.matchAll(/wsSend\(\s*\{[^}]*\}/g)).map(m => m[0]);
}

test("app.js does send messages through wsSend", () => {
  /* Guards the checks below: if the call shape changes, they would silently
     pass by matching nothing at all. */
  assert.ok(wsSendPayloads().length >= 5, "expected several wsSend call sites");
});

test("no wsSend payload mentions a secret", () => {
  /* The realistic regression: someone adds the room secret to an outgoing
     message. See README, "Invite links" — only sessionId and token may go
     over the WebSocket. */
  for (const payload of wsSendPayloads()) {
    assert.ok(!/secret/i.test(payload), `wsSend payload references a secret:\n${payload}`);
  }
});

test("join-session sends only the fields the server needs", () => {
  const joins = wsSendPayloads().filter(p => p.includes("join-session"));
  assert.ok(joins.length > 0, "expected at least one join-session send");
  const allowed = new Set(["type", "sessionId", "pin", "token"]);
  for (const payload of joins) {
    for (const [, key] of payload.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) {
      assert.ok(allowed.has(key), `join-session must not carry "${key}":\n${payload}`);
    }
  }
});

test("wsSend runs the leak guard before sending", () => {
  /* Cheap structural check that the guard was not removed or moved below the
     send. Its behaviour is covered in protocol.test.js. */
  const body = appSrc.match(/function wsSend\(obj\)\s*\{[\s\S]*?\n\}/);
  assert.ok(body, "wsSend not found");
  assert.ok(body[0].includes("payloadLeaksSecret"), "wsSend no longer calls the guard");
  assert.ok(
    body[0].indexOf("payloadLeaksSecret") < body[0].indexOf("ws.send"),
    "the guard must run before the message goes out");
});

test("the guard covers every variable a room secret can live in", () => {
  /* join-session is sent while the secret is still in pendingRoomSecret;
     roomSecret is not assigned until the server confirms. Checking only
     roomSecret would leave the guard inert during that very message. */
  const holders = Array.from(appSrc.matchAll(/^let (roomSecret|pendingRoomSecret)\b/gm))
    .map(m => m[1]);
  assert.deepEqual(new Set(holders), new Set(["roomSecret", "pendingRoomSecret"]),
    "a secret-holding variable was added or renamed — update roomSecretsInPlay()");

  const guarded = appSrc.match(/function roomSecretsInPlay\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(guarded, "roomSecretsInPlay not found");
  for (const holder of [...holders, "_autoSecret"]) {
    assert.ok(guarded[0].includes(holder), `roomSecretsInPlay omits ${holder}`);
  }
});

test("every path to the camera checks that a call was agreed to first", () => {
  /* attachCallMedia() calls getUserMedia. inCall is what the call buttons and
     the Accept button set, so without this guard a peer can send call-offer or
     call-accept cold and open the camera and microphone with no prompt shown.

     Written against whichever functions reach attachCallMedia rather than
     against a fixed pair of names: the guard was added to one of the two doors
     first and the other went unnoticed. A third door must not be able to. */
  const reaching = Array.from(topLevelFunctions(withoutComments(appSrc)))
    .filter(([name, body]) => name !== "attachCallMedia" && body.includes("attachCallMedia("));

  assert.ok(reaching.length >= 2,
    `expected the call-offer and call-accept paths, found ${reaching.length}`);

  for (const [name, body] of reaching) {
    assert.ok(/if\s*\(!inCall\)/.test(body), `${name} is missing the !inCall consent guard`);
    assert.ok(
      body.indexOf("!inCall") < body.indexOf("attachCallMedia("),
      `${name} must check consent before capturing media`);
  }
});

test("the peer cannot add video to a call the user asked to keep voice-only", () => {
  /* withVideo rides in on the peer's messages; pendingCallVideo is what the
     user actually pressed. Answering a voice call with withVideo:true would
     otherwise switch the camera on. */
  const fns = topLevelFunctions(withoutComments(appSrc));
  for (const name of ["initiateCallOffer", "handleIncomingCallOffer"]) {
    const body = fns.get(name);
    assert.ok(body, `${name} not found`);
    assert.ok(body.includes("consentedVideo("),
      `${name} must gate video on what the user agreed to, not on the peer's flag`);
  }
  const helper = fns.get("consentedVideo");
  assert.ok(helper, "consentedVideo not found");
  assert.ok(helper.includes("pendingCallVideo"), "consentedVideo must read the user's choice");
});

test("a text message is only displayed when the agreed key opened it", () => {
  /* A plaintext fallback would undo e2eFailClosed(): that disables sending, but
     a middleman caught swapping keys could still write into the chat window. */
  const handler = topLevelFunctions(withoutComments(appSrc)).get("handleTextMessage");
  assert.ok(handler, "handleTextMessage not found");
  assert.ok(!/data\.text\b/.test(handler),
    "handleTextMessage must not render an unencrypted message body");
  assert.ok(/if\s*\(!e2eReady\s*\|\|\s*!data\.ct\)/.test(handler),
    "the text case must drop anything that was not encrypted");
});

test("transfer ids reach a selector through exactly one escaped helper", () => {
  /* The id comes from transfer-meta, so the peer picks it. Unescaped it can
     break the selector or steer it at another message's bubble. */
  const builders = Array.from(appSrc.matchAll(/\[data-tid="\$\{([^}]*)\}"\]/g))
    .map(m => m[1]);
  assert.equal(builders.length, 1,
    `expected one place building this selector, found ${builders.length} — route them through findTransferRow()`);
  assert.ok(/CSS\.escape/.test(builders[0]), "the selector must escape the id");
});

test("call signaling never goes over the WebSocket", () => {
  /* Accepting call offers from the signaling server would let it start
     getUserMedia without the peer asking; sending them there would expose the
     call setup it is not meant to see. Both directions must stay on the
     encrypted data channel. */
  for (const payload of wsSendPayloads()) {
    assert.ok(!/["']call-/.test(payload), `call signaling must not use wsSend:\n${payload}`);
  }
  const signalingHandler = appSrc.match(/async function handleSignaling\(data\)[\s\S]*?\n\}/);
  assert.ok(signalingHandler, "handleSignaling not found");
  assert.ok(
    !/case\s+"call-(offer|answer|ice)"/.test(signalingHandler[0]),
    "handleSignaling must not accept call signaling from the WebSocket");
});
