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

test("an incoming call offer is refused unless a call was accepted", () => {
  /* attachCallMedia() calls getUserMedia. Without this guard a peer could skip
     call-request and open the camera and microphone with no prompt shown —
     inCall is what the accept button sets. */
  const fn = withoutComments(appSrc)
    .match(/async function handleIncomingCallOffer\(data\)[\s\S]*?\n\}/);
  assert.ok(fn, "handleIncomingCallOffer not found");
  assert.ok(/if\s*\(!inCall\)/.test(fn[0]), "missing the !inCall consent guard");
  assert.ok(
    fn[0].indexOf("!inCall") < fn[0].indexOf("attachCallMedia"),
    "the guard must run before any media is captured");
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
