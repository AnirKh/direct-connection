/*
  The chat's link is repaired from either side, a couple of seconds down —
  through a seat on the server that a dropped link no longer loses.

  Found assessing why calls did not survive a phone changing networks. The
  server deleted the room the moment either side's link to it dropped, so
  the repair had nowhere to go; the repair itself waited for the link to be
  declared failed, tens of seconds, and only the host could start it. Now
  the server keeps the seat (server.test.js has that side), the page takes
  it back with its key on reconnecting, and a couple of seconds after the
  link goes down the host makes a fresh offer while the guest asks it to.

  G.chatRepair decides. watchChatLink(), stepChatRepair(), repairChatNow(),
  resumeSeat() and the new handlers are lifted out of app.js and run with a
  stand-in clock, connection and server link.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const G   = require("../guards.js");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

/* ══════════════════════════════════════════
   The decision
══════════════════════════════════════════ */

const step = o => G.chatRepair({ state: "disconnected", host: true, pathOpen: true, downFor: 0, sinceRepair: 0, repairs: 0, ...o });

test("a link that is up needs nothing", () => {
  for (const state of ["connected", "completed", "checking", "new", "closed", undefined]) {
    assert.equal(step({ state, downFor: 60000 }), "none", String(state));
  }
  assert.equal(G.chatRepair(undefined), "none");
});

test("a couple of seconds down, the host restarts and the guest asks it to", () => {
  assert.equal(step({ downFor: 1000 }), "wait", "a blip may mend itself");
  assert.equal(step({ downFor: 2000 }), "restart");
  assert.equal(step({ state: "failed", downFor: 2000 }), "restart", "failed outright too");
  assert.equal(step({ host: false, downFor: 2000 }), "ask", "the guest never offers: two offers must not cross");
});

test("still down, again every few seconds — not straight away", () => {
  assert.equal(step({ downFor: 4000, repairs: 1, sinceRepair: 2000 }), "wait");
  assert.equal(step({ downFor: 8000, repairs: 1, sinceRepair: 6000 }), "restart");
  assert.equal(step({ host: false, downFor: 8000, repairs: 1, sinceRepair: 6000 }), "ask");
});

test("with the way through the server shut — our seat or theirs not back — it waits, however long", () => {
  for (const downFor of [2000, 30000, 600000]) {
    assert.equal(step({ downFor, pathOpen: false }), "wait");
    assert.equal(step({ host: false, downFor, pathOpen: false }), "wait");
  }
});

test("it never gives up by itself: the room's wait for a side that does not come back ends the chat", () => {
  assert.equal(step({ downFor: 3600000, repairs: 400, sinceRepair: 6000 }), "restart");
});

test("a time that makes no sense is waited on, not acted on", () => {
  assert.equal(step({ downFor: NaN }), "wait");
  assert.equal(step({ downFor: -5 }), "wait");
  assert.equal(step({ downFor: 5000, repairs: 1, sinceRepair: NaN }), "wait");
});

test("CHAT_REPAIR: sooner than the call's own recovery, so the call's channel is back first", () => {
  assert.ok(Object.isFrozen(G.CHAT_REPAIR));
  assert.ok(G.CHAT_REPAIR.firstTryMs < G.CALL_RECOVER.firstTryMs);
});

/* ══════════════════════════════════════════
   The repair, actually run
══════════════════════════════════════════ */

const grab = (pattern, what) => {
  const m = app.match(pattern);
  assert.ok(m, `${what} not found in app.js`);
  return m[0];
};
const fn = name => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"), name);
const between = (from, to) => {
  const a = app.indexOf(from);
  const b = app.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found in app.js`);
  return app.slice(a, b);
};
const SOURCE = ["watchChatLink", "chatOver", "serverPathOpen", "stepChatRepair", "stopChatRepair", "repairChatNow", "roomGoneForGood", "resumeSeat"]
  .map(fn).join("\n");
const CASES = between('    case "session-rejoined":', "    /* No call-offer");
const ON_CLOSE = between("    /* Mid-chat, the server now keeps our seat", "    /* A room still waiting for its guest");

function chat({ host = true, keyed = true } = {}) {
  const log = { offers: 0, sent: [], ended: 0 };
  /* Not 0: the page takes 0 to mean "not down", as a real clock never says it. */
  const clock = { now: 1_000_000, interval: null };
  const pc = { iceConnectionState: "connected" };
  const dc = { readyState: "open" };
  const ws = { readyState: 1 };
  const env = {
    G,
    WebSocket: { OPEN: 1 },
    Date: { now: () => clock.now },
    setInterval: (f, ms) => { clock.interval = { f, ms }; return clock.interval; },
    clearInterval: h => { if (clock.interval === h) clock.interval = null; },
    ws,
    wsSend: m => log.sent.push(m),
    handleFullRenegotiation: () => { log.offers++; },
    endChatLinkLost: () => { log.ended++; },
    roomEventIsOurs: d => d.sessionId === "r"
  };
  const names = Object.keys(env);
  const api = new Function(...names, "start", `
    let pc = start.pc, isHost = start.host, currentSession = { sessionId: "r" }, dataChannel = start.dc;
    let hostKey = start.keyed && isHost ? "hk" : null, guestKey = start.keyed && !isHost ? "gk" : null;
    let seatPending = false, peerServerAway = false, serverRoomGone = false;
    let chatDownSince = 0, chatRepairAt = 0, chatRepairs = 0, chatRepairTimer = null;
    ${SOURCE}
    function deliver(data) { switch (data.type) {\n${CASES}\n} }
    function serverLinkDrops() {\n${ON_CLOSE}\n}
    return {
      watchChatLink, stopChatRepair, resumeSeat, deliver, serverLinkDrops,
      set: o => { if ("peerServerAway" in o) peerServerAway = o.peerServerAway; if ("pc" in o) pc = o.pc; },
      now: () => ({ seatPending, peerServerAway, serverRoomGone, chatRepairs, chatRepairTimer, chatDownSince })
    };
  `)(...names.map(n => env[n]), { pc, host, keyed, dc });
  /** The link goes to `state`, as the connection would report it. */
  const link = state => { pc.iceConnectionState = state; api.watchChatLink(); };
  /** Time passes; the repair takes its one-second steps. */
  const wait = ms => {
    for (let t = 0; t < ms; t += 1000) {
      clock.now += 1000;
      if (clock.interval) clock.interval.f();
    }
  };
  const asks = () => log.sent.filter(m => m.type === "repair-request").length;
  return { ...api, log, pc, dc, ws, clock, link, wait, asks };
}

test("link down: two seconds on, the host makes a fresh offer", () => {
  const c = chat();
  c.link("disconnected");
  c.wait(1000);
  assert.equal(c.log.offers, 0, "a blip may mend itself");
  c.wait(1000);
  assert.equal(c.log.offers, 1);
  assert.equal(c.asks(), 0);
});

test("link down: two seconds on, the guest asks the host — it never offers itself", () => {
  const c = chat({ host: false });
  c.link("disconnected");
  c.wait(2000);
  assert.equal(c.log.offers, 0);
  assert.deepEqual(c.log.sent, [{ type: "repair-request", sessionId: "r" }]);
});

test("still down: again every six seconds; back up: it stops", () => {
  const c = chat();
  c.link("failed");
  c.wait(14000);
  assert.equal(c.log.offers, 3, "at 2, 8 and 14 seconds");
  c.link("connected");
  assert.equal(c.now().chatRepairTimer, null);
  assert.equal(c.now().chatDownSince, 0);
  c.wait(20000);
  assert.equal(c.log.offers, 3);
});

test("the other side's seat not back: the offer waits for it, then goes at once", () => {
  const c = chat();
  c.deliver({ type: "peer-away", sessionId: "r" });
  c.link("disconnected");
  c.wait(10000);
  assert.equal(c.log.offers, 0, "it would go nowhere");
  c.deliver({ type: "peer-back", sessionId: "r" });
  assert.equal(c.log.offers, 1, "not at the next step — now");
});

test("our own link to the server drops mid-chat: our seat is pending, and taken back with our key", () => {
  const host = chat();
  host.serverLinkDrops();
  assert.equal(host.now().seatPending, true);
  assert.equal(host.now().serverRoomGone, false, "the room is kept for us now");
  host.resumeSeat();
  assert.deepEqual(host.log.sent, [{ type: "reclaim-session", sessionId: "r", hostKey: "hk" }]);

  const guest = chat({ host: false });
  guest.serverLinkDrops();
  guest.resumeSeat();
  assert.deepEqual(guest.log.sent, [{ type: "rejoin-session", sessionId: "r", guestKey: "gk" }]);
});

test("without a key (an older server), a dropped link is the room gone, as before — nothing to take back", () => {
  const c = chat({ host: false, keyed: false });
  c.serverLinkDrops();
  assert.equal(c.now().seatPending, false);
  assert.equal(c.now().serverRoomGone, true);
  c.resumeSeat();
  assert.deepEqual(c.log.sent, []);
});

test("with our seat pending, no repair is tried; once it is back, the guest asks straight away", () => {
  const c = chat({ host: false });
  c.serverLinkDrops();
  c.link("disconnected");
  c.wait(10000);
  assert.equal(c.asks(), 0, "the server cannot pass it on yet");
  c.deliver({ type: "session-rejoined", sessionId: "r", hostAway: false });
  assert.equal(c.now().seatPending, false);
  assert.equal(c.asks(), 1);
});

test("rejoined while the host's own seat is away: the guest waits for peer-back", () => {
  const c = chat({ host: false });
  c.serverLinkDrops();
  c.link("disconnected");
  c.wait(5000);
  c.deliver({ type: "session-rejoined", sessionId: "r", hostAway: true });
  assert.equal(c.now().peerServerAway, true);
  assert.equal(c.asks(), 0);
  c.deliver({ type: "peer-back", sessionId: "r" });
  assert.equal(c.asks(), 1);
});

test("the guest's ask: the host restarts even before its own side notices — but not twice in three seconds", () => {
  const c = chat();
  c.wait(5000);
  c.deliver({ type: "repair-request", sessionId: "r" });
  assert.equal(c.log.offers, 1, "its link still says connected");
  c.wait(1000);
  c.deliver({ type: "repair-request", sessionId: "r" });
  assert.equal(c.log.offers, 1, "one already on its way");
  c.wait(2000);
  c.deliver({ type: "repair-request", sessionId: "r" });
  assert.equal(c.log.offers, 2);
});

test("an ask the host cannot act on is dropped: our seat pending, or a guest page, or another room", () => {
  const pending = chat();
  pending.wait(5000);
  pending.serverLinkDrops();
  pending.deliver({ type: "repair-request", sessionId: "r" });
  assert.equal(pending.log.offers, 0);

  const guest = chat({ host: false });
  guest.wait(5000);
  guest.deliver({ type: "repair-request", sessionId: "r" });
  assert.equal(guest.log.offers + guest.log.sent.length, 0);

  const other = chat();
  other.wait(5000);
  other.deliver({ type: "repair-request", sessionId: "elsewhere" });
  assert.equal(other.log.offers, 0);
});

test("the seat could not be taken back: the room is gone — the chat ends only if its own link has failed too", () => {
  const up = chat({ host: false });
  up.serverLinkDrops();
  up.deliver({ type: "rejoin-failed", sessionId: "r" });
  assert.equal(up.now().seatPending, false);
  assert.equal(up.now().serverRoomGone, true);
  assert.equal(up.log.ended, 0, "the two phones still talk directly");
  up.serverLinkDrops();
  up.resumeSeat();
  assert.deepEqual(up.log.sent, [], "its key forgotten: the next dropped link tries nothing");
  assert.equal(up.now().seatPending, false);

  const down = chat({ host: false });
  down.serverLinkDrops();
  down.pc.iceConnectionState = "failed";
  down.deliver({ type: "rejoin-failed", sessionId: "r" });
  assert.equal(down.log.ended, 1);
});

test("someone else's room's news changes nothing here", () => {
  const c = chat();
  c.deliver({ type: "peer-away", sessionId: "elsewhere" });
  assert.equal(c.now().peerServerAway, false);
  c.deliver({ type: "rejoin-failed", sessionId: "elsewhere" });
  assert.equal(c.now().serverRoomGone, false);
});

test("no chat left (the page left it): the repair stops rather than offering into nothing", () => {
  const c = chat();
  c.link("disconnected");
  c.set({ pc: null });
  c.wait(5000);
  assert.equal(c.log.offers, 0);
  assert.equal(c.now().chatRepairTimer, null);
});

test("the chat's channel closed — the other side gone for good — nothing is repaired: no fresh route reopens it", () => {
  /* Found trying it in a browser: with the host's page gone, the guest kept
     its repair ticking behind "Peer disconnected". */
  const c = chat({ host: false });
  c.link("disconnected");
  c.dc.readyState = "closed";
  c.wait(10000);
  assert.equal(c.asks(), 0);
  assert.equal(c.now().chatRepairTimer, null, "and it stops");
  c.link("failed");
  assert.equal(c.now().chatRepairTimer, null, "nor starts again");

  const host = chat();
  host.dc.readyState = "closed";
  host.wait(5000);
  host.deliver({ type: "repair-request", sessionId: "r" });
  host.deliver({ type: "peer-back", sessionId: "r" });
  assert.equal(host.log.offers, 0);
});

/* ══════════════════════════════════════════
   Wiring
══════════════════════════════════════════ */

test("the channel closing stops the repair", () => {
  assert.match(between("  dataChannel.onclose = () => {", "  dataChannel.onerror"), /stopChatRepair\(\);/);
});

test("on every reconnection the seat is taken back, beside the waiting room's own reclaim", () => {
  const onopen = between("  ws.onopen    = () => {", "  ws.onclose");
  assert.match(onopen, /sendReclaim\(\);\s*\n\s*resumeSeat\(\);/);
});

test("closing the chat's connection stops its repair", () => {
  assert.match(fn("closePeerConnection"), /stopChatRepair\(\)/);
});

test("the guest key is kept from the join, and forgotten on leaving or losing the seat", () => {
  const joined = between('    case "session-joined":', "      break;");
  assert.match(joined, /guestKey = /);
  const leave = between("leaveBtn.onclick = () => {", "};");
  assert.match(leave, /guestKey = null/);
  const taken = between('    case "seat-taken":', "      break;");
  assert.match(taken, /guestKey = null/);
});

test("a fresh offer's candidates that come in ahead of it are kept and tried with it", () => {
  const offer = between('    case "renegotiate-offer":', '    case "renegotiate-answer":');
  assert.match(offer, /setRemoteDescription[\s\S]*while \(iceQueue\.length\)[\s\S]*createAnswer/);
  const answer = between('    case "renegotiate-answer":', "    /* ── Our seat kept");
  assert.match(answer, /signalingState !== "have-local-offer"/, "an answer to nothing we asked is ignored");
  assert.match(answer, /while \(iceQueue\.length\)/);
  const cand = between('    case "ice-candidate":', '    case "renegotiate-offer":');
  assert.match(cand, /catch \(_\) \{ iceQueue\.push\(data\.candidate\); \}/);
});
