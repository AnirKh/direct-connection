/*
  Source-level checks on app.js.

  app.js needs a browser and two peers to run, so these read it as text rather
  than executing it. That is a weaker guarantee than a runtime test, and the
  split is deliberate:

    guards.js + connstats.js hold the decisions, and their own tests prove the
    answers are right — every combination, with no browser involved.

    These tests prove app.js actually ASKS, and asks at the right moment. A
    correct guard that nothing calls is worth nothing, and no test of guards.js
    could ever notice.

  What remains here is what cannot be extracted: that outgoing messages go
  through wsSend, that none of them carries the room secret, that call signaling
  never touches the WebSocket, and that a peer-chosen transfer id reaches a
  selector through exactly one escaped helper.
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

test("every path to the camera asks the guard first", () => {
  /* attachCallMedia() calls getUserMedia. Whether the answer is right is
     guards.test.js's job — this checks only that app.js asks, and asks before
     capturing, which no amount of testing guards.js could establish.

     Written against whichever functions reach attachCallMedia rather than a
     fixed pair of names: the guard was added to one of the two doors first and
     the other went unnoticed for a release. A third door must not be able to. */
  const reaching = Array.from(topLevelFunctions(withoutComments(appSrc)))
    .filter(([name, body]) => name !== "attachCallMedia" && body.includes("attachCallMedia("));

  assert.ok(reaching.length >= 2,
    `expected the call-offer and call-accept paths, found ${reaching.length}`);

  for (const [name, body] of reaching) {
    assert.ok(body.includes("mayCaptureForCall("), `${name} does not ask mayCaptureForCall`);
    assert.ok(
      body.indexOf("mayCaptureForCall(") < body.indexOf("attachCallMedia("),
      `${name} must ask before capturing, not after`);
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

test("an incoming text message is put to the guard", () => {
  /* What counts as displayable is guards.test.js's job. Two things it cannot
     see are checked here: that handleTextMessage consults the guard at all, and
     that no plaintext body is read anywhere in it — a fallback would undo
     failing closed, letting a middleman caught swapping keys still write into
     the chat window. */
  const handler = topLevelFunctions(withoutComments(appSrc)).get("handleTextMessage");
  assert.ok(handler, "handleTextMessage not found");
  assert.ok(!/data\.text\b/.test(handler),
    "handleTextMessage must not render an unencrypted message body");
  assert.ok(handler.includes("mayRenderText("),
    "the text case must ask the guard rather than deciding inline");
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

test("only what came out of the envelope is ever marked sealed", () => {
  /* mayHandleFrame trusts its `sealed` argument completely, so the whole rule
     rests on who is able to pass true. Exactly one call may: the one fed by
     e2eDecrypt. The raw channel handler must never pass anything. */
  const src = withoutComments(appSrc);

  const sealedCalls = Array.from(src.matchAll(/handleTextMessage\([^\n]*,\s*true\s*\)/g));
  assert.equal(sealedCalls.length, 1, `expected one sealed call site, found ${sealedCalls.length}`);
  const leadUp = src.slice(Math.max(0, sealedCalls[0].index - 160), sealedCalls[0].index);
  assert.ok(/e2eDecrypt\(/.test(leadUp), "the sealed call must be the one the envelope's decryption feeds");

  const onmessage = src.match(/dataChannel\.onmessage\s*=[\s\S]*?\n  \};/);
  assert.ok(onmessage, "dataChannel.onmessage not found");
  assert.ok(onmessage[0].includes("handleTextMessage("), "raw frames no longer reach handleTextMessage");
  assert.ok(!/handleTextMessage\([^\n]*,/.test(onmessage[0]),
    "a frame straight off the channel must never be passed as sealed");
});

test("handleTextMessage asks the guard before acting on any message", () => {
  const handler = topLevelFunctions(withoutComments(appSrc)).get("handleTextMessage");
  assert.ok(handler, "handleTextMessage not found");
  assert.ok(handler.includes("mayHandleFrame("), "handleTextMessage must ask whether a frame may be handled");
  assert.ok(handler.indexOf("mayHandleFrame(") < handler.indexOf("switch ("),
    "the check must come before the dispatch, not inside one case of it");
});

test("what the app sends in the clear is what it accepts in the clear", () => {
  /* The list in guards.js and the senders here have to agree in both
     directions. A type sent clear but not listed is silently dropped by the
     other side; a type sent sealed but listed is a hole left open for nothing. */
  const { CLEAR_TYPES } = require("../guards.js");
  const src = withoutComments(appSrc);

  const clearSent  = new Set(Array.from(
    src.matchAll(/(?:\bdcSend|dataChannel\.send)\(\s*(?:JSON\.stringify\(\s*)?\{\s*type:\s*"([^"]+)"/g)).map(m => m[1]));
  const sealedSent = new Set(Array.from(
    src.matchAll(/(?:dcSendE2e|dcSendCallSignal)\(\s*\{\s*type:\s*"([^"]+)"/g)).map(m => m[1]));

  /* Guards the two checks below against matching nothing at all. */
  assert.ok(clearSent.size >= 5,  `expected several clear sends, found ${[...clearSent]}`);
  assert.ok(sealedSent.size >= 8, `expected the transfer and call types, found ${[...sealedSent]}`);

  for (const type of clearSent) {
    assert.ok(CLEAR_TYPES.includes(type), `"${type}" is sent in the clear but the peer would refuse it`);
  }
  for (const type of sealedSent) {
    assert.ok(!CLEAR_TYPES.includes(type), `"${type}" is always sent sealed, so it must not be accepted in the clear`);
  }
});

test("the record button asks before opening the microphone, and again once it is open", () => {
  /* Two gaps, one on each side of the await. Before: a double-click opened two
     streams and only one could ever be stopped. After: the room could end
     while the permission prompt was up, and the microphone came on anyway. */
  const fn = topLevelFunctions(withoutComments(appSrc)).get("toggleVoiceRecord");
  assert.ok(fn, "toggleVoiceRecord not found");
  const opens = fn.indexOf("getUserMedia(");
  assert.ok(opens > -1, "toggleVoiceRecord no longer opens the microphone itself — update this test");

  assert.ok(fn.includes("mayStartRecording("), "a press must ask whether it may open the microphone");
  assert.ok(fn.indexOf("mayStartRecording(") < opens, "that question must come before opening, not after");
  assert.ok(fn.indexOf("mayKeepMicOpen(") > opens, "the room must be checked again once the microphone has opened");
  assert.ok(/finally\s*\{\s*voiceOpening\s*=\s*false/.test(fn),
    "the opening flag must clear on every exit, or one refused permission leaves the button dead");
});

test("the PIN dialog always opens with a working Join button", () => {
  /* Join was only re-enabled after a refusal, so one successful join left it
     disabled for every room after. */
  const fns = topLevelFunctions(withoutComments(appSrc));
  assert.ok(fns.get("settlePinJoin"), "settlePinJoin not found");
  assert.ok(/pinJoinBtn\.disabled\s*=\s*false/.test(fns.get("settlePinJoin")), "settlePinJoin must re-enable Join");
  assert.ok(fns.get("openPinModal").includes("settlePinJoin("), "opening the dialog must re-arm its button");

  const joined = withoutComments(appSrc).match(/case "session-joined":[\s\S]*?break;/);
  assert.ok(joined && joined[0].includes("settlePinJoin("), "a successful join must settle the dialog too");
});

test("server news about a room is checked against the room on screen", () => {
  /* These messages used to name no room. The handler assumed the current one,
     so an abandoned room expiring closed the chat in a different one. */
  const handler = appSrc.match(/async function handleSignaling\(data\)[\s\S]*?\n\}/);
  assert.ok(handler, "handleSignaling not found");
  const body = withoutComments(handler[0]);

  for (const type of ["guest-joined", "peer-disconnected", "session-expired"]) {
    const branch = body.match(new RegExp(`case "${type}":[\\s\\S]*?break;`));
    assert.ok(branch, `no ${type} case in handleSignaling`);
    assert.ok(branch[0].includes("roomEventIsOurs("), `${type} must check which room it is about before acting`);
  }
  const helper = topLevelFunctions(withoutComments(appSrc)).get("roomEventIsOurs");
  assert.ok(helper && helper.includes("mayApplyRoomEvent("), "roomEventIsOurs must ask the guard");
});
