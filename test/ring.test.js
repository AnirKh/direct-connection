/*
  A call nobody answers — actually run.

  The other person away from the screen, or in another app, and nothing ended
  a call they never saw: the caller sat on "Calling…" for as long as anyone
  watched. After G.CALL_RING_MS it now stops and says "No answer", and the
  other side, told as for any hang-up, notes a missed call.

  The rule is G.callUnanswered. The ring block, requestCall, endCall and the
  call-reject case are lifted out of app.js and run against a stand-in clock.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const G      = require("../guards.js");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
const app = read("app.js");
const I18N = new Function("localStorage", `${read("i18n.js")}; return I18N;`)({ getItem: () => null });
const between = (from, to) => {
  const a = app.indexOf(from), b = app.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from} … ${to} not found in app.js`);
  return app.slice(a, b);
};
const fn = name => {
  const m = app.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} not found as a top-level function in app.js`);
  return m[0];
};

function classes(initial = []) {
  const set = new Set(initial);
  return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) };
}

/* ══════════════════════════════════════════
   The rule
══════════════════════════════════════════ */

test("a call rings for 45 seconds", () => {
  assert.equal(G.CALL_RING_MS, 45_000);
});

test("given up only while it is still just ringing", () => {
  assert.equal(G.callUnanswered({ inCall: true, answered: false }), true);
  assert.equal(G.callUnanswered({ inCall: true, answered: true }), false, "picked up: the call goes on");
  assert.equal(G.callUnanswered({ inCall: false, answered: false }), false, "already over: nothing to end");
  assert.equal(G.callUnanswered({ inCall: "yes", answered: false }), false);
  assert.equal(G.callUnanswered(undefined), false);
});

/* ══════════════════════════════════════════
   The caller and the callee, run
══════════════════════════════════════════ */

const RING   = between("/* ── A call nobody answers ──", "function requestCall(");
const REJECT = between('    case "call-reject": {', '    case "call-accept":');

function phone({ linkUp = true } = {}) {
  const log = { sent: [], sys: [], overlay: [], closed: 0 };
  const timers = new Map();
  let nextTimer = 0;
  const callRequestModal = { classList: classes(["hidden"]) };
  const api = new Function(
    "G", "t", "setTimeout", "clearTimeout", "dcReady", "isChatLinkUp", "dcSendCallSignal", "appendSys",
    "showCallOverlay", "updateCallPauseNote", "stopCallMedia", "closeCallPeerConnection", "remoteVideo", "callRequestModal", `
    let inCall = false, pendingCallVideo = false, peerAway = false, callIceQueue = [], pc = {}, e2eReady = true, callPc = null;
    ${RING}
    ${fn("requestCall")}
    ${fn("endCall")}
    function deliver(data) { switch (data.type) {\n${REJECT}\n} }
    return { requestCall, endCall, deliver,
             pickUp: () => { callPc = {}; },
             ringing: () => { inCall = true; callRequestModal.classList.remove("hidden"); },
             accepted: () => { inCall = true; callRequestModal.classList.add("hidden"); },
             inCall: () => inCall };`
  )(G, k => k,
    (f, ms) => { const id = ++nextTimer; timers.set(id, { f, ms }); return id; },
    id => { timers.delete(id); },
    () => true, () => linkUp, m => { log.sent.push(m.type); return Promise.resolve(); }, k => log.sys.push(k),
    s => log.overlay.push(s), () => {}, () => { log.closed++; }, () => {}, {}, callRequestModal);
  const wait = ms => {
    for (const [id, timer] of [...timers]) {
      if (timer.ms <= ms) { timers.delete(id); timer.f(); }
    }
  };
  return { ...api, log, timers, wait, callRequestModal };
}

test("nobody answers: after 45 seconds the call stops, both sides are told, and it says so", () => {
  const p = phone();
  p.requestCall(false);
  assert.deepEqual([...p.timers.values()].map(t => t.ms), [45_000]);
  p.wait(44_999);
  assert.equal(p.inCall(), true, "still ringing a moment before");
  p.wait(45_000);
  assert.deepEqual(p.log.sent, ["call-request", "call-reject"], "the other side stops ringing too");
  assert.deepEqual(p.log.sys, ["sysNoAnswer"]);
  assert.equal(p.inCall(), false);
  assert.equal(p.log.closed, 1, "the call screen is closed");
});

test("picked up in time: the call goes on", () => {
  const p = phone();
  p.requestCall(true);
  p.pickUp();
  p.wait(45_000);
  assert.deepEqual(p.log.sent, ["call-request"]);
  assert.deepEqual(p.log.sys, []);
  assert.equal(p.inCall(), true);
});

test("hung up while ringing: the ring stops with it, and a new call rings afresh", () => {
  const p = phone();
  p.requestCall(false);
  p.endCall(true);
  assert.equal(p.timers.size, 0, "no ring left running");
  p.requestCall(false);
  assert.equal(p.timers.size, 1, "one ring per call");
  p.wait(45_000);
  assert.deepEqual(p.log.sys, ["sysNoAnswer"], "said once, for the call that was ringing");
});

test("a call that could not be placed does not ring", () => {
  const p = phone({ linkUp: false });
  p.requestCall(false);
  assert.equal(p.timers.size, 0);
  assert.deepEqual(p.log.sys, ["callNeedLink"]);
});

test("the other side: hung up while ringing there is a missed call; after answering, an ended one", () => {
  const ringing = phone();
  ringing.ringing();
  ringing.deliver({ type: "call-reject" });
  assert.deepEqual(ringing.log.sys, ["sysMissedCall"]);
  assert.equal(ringing.callRequestModal.classList.contains("hidden"), true, "the incoming-call question goes");
  const talking = phone();
  talking.accepted();
  talking.deliver({ type: "call-reject" });
  assert.deepEqual(talking.log.sys, ["sysCallEnded"]);
});

test("the words are in both languages", () => {
  for (const key of ["sysNoAnswer", "sysMissedCall", "sysCallEnded"]) {
    for (const lang of ["mn", "en"]) assert.equal(typeof I18N[lang][key], "string", `${lang}.${key}`);
  }
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

test("an answer stops the ring — once the call guard has said it is ours", () => {
  const offer = fn("initiateCallOffer");
  const guard = offer.indexOf("G.mayCaptureForCall(inCall)"), stop = offer.indexOf("stopRinging();");
  assert.ok(guard > -1 && stop > guard, "stopRinging after the guard in initiateCallOffer");
});

test("every way a call ends stops the ring", () => {
  assert.match(fn("endCall"), /^function endCall\(notify = true\) \{\n\s*stopRinging\(\);/);
  assert.match(fn("requestCall"), /startRinging\(\);\n\}$/, "rings only once the call is placed");
});
