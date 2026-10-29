/*
  A room that waits while its host is away — the app's half, actually run.

  To send the link, the host switches to a messaging app; the phone pauses the
  page and cuts its link to the server. The room used to go with the link, so
  the link the friend received was dead by the time they tapped it. Now the
  server keeps it (test/integration/server.test.js), and this page takes it
  back on reconnecting — or, if the phone closed the page meanwhile, from
  sessionStorage when it is opened again.

  G.restorableHostRoom is the rule. The "Taking a waiting room back" block and
  the signalling cases it answers to are lifted out of app.js and run against
  stand-ins.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const G      = require("../guards.js");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");
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

const NOW = 1_800_000_000_000;
const record = over => ({ v: 1, sessionId: "bat-room", hostKey: "host-key", token: "tok", pin: "123456", kind: "pin",
                          roomSecret: "secret", word: null, savedAt: NOW - 60_000, ...over });

/* ══════════════════════════════════════════
   The rule
══════════════════════════════════════════ */

test("a recent, well-formed room is taken up again, for each kind", () => {
  assert.ok(G.restorableHostRoom(record(), NOW));
  assert.ok(G.restorableHostRoom(record({ kind: "open", pin: null }), NOW));
  assert.ok(G.restorableHostRoom(record({ kind: "code", pin: null, roomSecret: "s", word: "correct horse" }), NOW));
  assert.ok(G.restorableHostRoom(record({ roomSecret: null }), NOW), "a room may have no link secret");
});

test("anything malformed is thrown away, not half-believed", () => {
  const bad = [
    null, undefined, "x", 5, [], {},
    record({ v: 2 }), record({ sessionId: "" }), record({ hostKey: undefined }), record({ token: 7 }),
    record({ kind: "party" }), record({ pin: "12345" }), record({ pin: 123456 }), record({ kind: "open" }),
    record({ kind: "code", pin: null, word: "" }), record({ kind: "code", pin: null, word: null }),
    record({ word: "stray" }), record({ roomSecret: "" }), record({ roomSecret: 9 }),
    record({ savedAt: "now" }), record({ savedAt: NaN })
  ];
  for (const r of bad) assert.equal(G.restorableHostRoom(r, NOW), null, JSON.stringify(r));
});

test("an old record, or one from the future, is thrown away", () => {
  assert.equal(G.restorableHostRoom(record({ savedAt: NOW - G.HOST_ROOM_MAX_AGE_MS - 1 }), NOW), null);
  assert.ok(G.restorableHostRoom(record({ savedAt: NOW - G.HOST_ROOM_MAX_AGE_MS + 1000 }), NOW));
  assert.equal(G.restorableHostRoom(record({ savedAt: NOW + 5000 }), NOW), null);
});

test("the page keeps its room a little longer than the server does, so the server is the one to say no", () => {
  assert.ok(G.HOST_ROOM_MAX_AGE_MS > 10 * 60 * 1000);
});

/* ══════════════════════════════════════════
   The block, run
══════════════════════════════════════════ */

const BLOCK = between("/* ── Taking a waiting room back ──", "function recreateRoom(");

function storage({ broken = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem: k => { if (broken) throw new Error("denied"); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { if (broken) throw new Error("denied"); map.set(k, String(v)); },
    removeItem: k => { if (broken) throw new Error("denied"); map.delete(k); }
  };
}

function page({ store = storage(), state = {} } = {}) {
  const log = { sent: [], tabs: [], status: [] };
  const lobbyStatus = { children: [], replaceChildren(...c) { this.children = c; log.status.push(c.map(x => x.textContent)); } };
  const start = { isHost: false, currentSession: null, hostKey: null, roomKind: "pin", roomSecret: null, pakeCode: null,
                  roomReadyInfo: null, autoJoin: false, ...state };
  const api = new Function(
    "G", "t", "sessionStorage", "lobbyStatus", "document", "wsSend", "showLobbyTab", "start",
    `let isHost = start.isHost, currentSession = start.currentSession, hostKey = start.hostKey, roomKind = start.roomKind;
     let roomSecret = start.roomSecret, pakeCode = start.pakeCode, roomReadyInfo = start.roomReadyInfo;
     let reclaimPending = false, reclaimRedraw = false, meeting = start.meeting || null;
     const _isAutoJoin = start.autoJoin;
     ${BLOCK}
     return { saveHostRoom, forgetHostRoom, awaitReclaim, sendReclaim, restoreHostRoom,
              state: () => ({ isHost, currentSession, hostKey, roomKind, roomSecret, pakeCode, roomReadyInfo, reclaimPending, reclaimRedraw }) };`
  )(G, k => k, store, lobbyStatus, { createElement: () => ({ style: {}, textContent: "" }) },
    m => log.sent.push(m), n => log.tabs.push(n), start);
  return { ...api, log, store, lobbyStatus };
}

const hosting = (over = {}) => ({
  isHost: true, currentSession: { sessionId: "bat-room", token: "tok" }, hostKey: "host-key", roomKind: "pin",
  roomSecret: "secret", roomReadyInfo: { sessionId: "bat-room", pin: "123456", token: "tok", kind: "pin" }, ...over
});

test("a hosted waiting room is kept for this tab, and taken up again by a page opened fresh", () => {
  const store = storage();
  page({ store, state: hosting() }).saveHostRoom();
  const saved = JSON.parse(store.map.get("dc-host-room"));
  assert.equal(saved.sessionId, "bat-room");
  assert.equal(saved.hostKey, "host-key");
  assert.equal(saved.pin, "123456");
  assert.equal(saved.roomSecret, "secret", "so the link already sent still verifies");

  const fresh = page({ store });
  fresh.restoreHostRoom();
  const s = fresh.state();
  assert.equal(s.isHost, true);
  assert.deepEqual(s.currentSession, { sessionId: "bat-room", token: "tok" });
  assert.equal(s.hostKey, "host-key");
  assert.equal(s.roomSecret, "secret");
  assert.equal(s.reclaimPending, true);
  assert.equal(s.reclaimRedraw, true, "the panel is drawn once the server agrees");
  assert.deepEqual(fresh.log.tabs, ["create"]);
  fresh.sendReclaim();
  assert.deepEqual(fresh.log.sent, [{ type: "reclaim-session", sessionId: "bat-room", hostKey: "host-key" }],
    "the host key and the room's name — never its secret or its word");
});

test("a code room keeps its word, and no PIN", () => {
  const store = storage();
  page({ store, state: hosting({ roomKind: "code", pakeCode: "correct horse",
    roomReadyInfo: { sessionId: "bat-room", pin: null, token: "tok", kind: "code" } }) }).saveHostRoom();
  const saved = JSON.parse(store.map.get("dc-host-room"));
  assert.equal(saved.word, "correct horse");
  assert.equal(saved.pin, null);
  const fresh = page({ store });
  fresh.restoreHostRoom();
  assert.equal(fresh.state().pakeCode, "correct horse");
  assert.equal(fresh.state().roomKind, "code");
});

test("taken up once, at the first connection only", () => {
  const store = storage();
  page({ store, state: hosting() }).saveHostRoom();
  const fresh = page({ store });
  fresh.restoreHostRoom();
  fresh.forgetHostRoom();
  page({ store, state: hosting() }).saveHostRoom();
  fresh.restoreHostRoom();
  assert.equal(fresh.log.tabs.length, 1);
});

test("a page opened from an invite link is a guest: it takes up no room", () => {
  const store = storage();
  page({ store, state: hosting() }).saveHostRoom();
  const guest = page({ store, state: { autoJoin: true } });
  guest.restoreHostRoom();
  assert.equal(guest.state().isHost, false);
  assert.deepEqual(guest.log.sent, []);
});

test("a page opened from a knock is meeting someone: it takes up no room either", () => {
  const store = storage();
  page({ store, state: hosting() }).saveHostRoom();
  const knocked = page({ store, state: { meeting: { name: "Anu", room: `~${"a".repeat(43)}` } } });
  knocked.restoreHostRoom();
  assert.equal(knocked.state().isHost, false);
  assert.deepEqual(knocked.log.sent, []);
});

test("a stale or broken record is thrown away and nothing is taken up", () => {
  const store = storage();
  store.map.set("dc-host-room", "{not json");
  const p = page({ store });
  p.restoreHostRoom();
  assert.equal(p.state().isHost, false);
  assert.equal(store.map.has("dc-host-room"), false);

  store.map.set("dc-host-room", JSON.stringify(record({ savedAt: 1 })));
  const q = page({ store });
  q.restoreHostRoom();
  assert.equal(q.state().isHost, false);
  assert.equal(store.map.has("dc-host-room"), false);
});

test("nothing is kept without a host key — a room from an older server cannot be taken back", () => {
  const store = storage();
  page({ store, state: hosting({ hostKey: null }) }).saveHostRoom();
  assert.equal(store.map.size, 0);
});

test("storage switched off breaks nothing", () => {
  const p = page({ store: storage({ broken: true }), state: hosting() });
  p.saveHostRoom();
  p.forgetHostRoom();
  page({ store: storage({ broken: true }) }).restoreHostRoom();
});

test("the link dropping shows a note and takes the room back on reconnecting; with nothing pending, nothing is sent", () => {
  const p = page({ state: hosting() });
  p.sendReclaim();
  assert.deepEqual(p.log.sent, []);
  p.awaitReclaim();
  assert.deepEqual(p.log.status, [["⏳ reconnectingRoom"]]);
  p.sendReclaim();
  assert.deepEqual(p.log.sent.map(m => m.type), ["reclaim-session"]);
});

/* ══════════════════════════════════════════
   The answers, run
══════════════════════════════════════════ */

const CASES = between('    case "host-back":', '    case "guest-joined":');

function answers({ isHost = true, ours = true, redraw = false, seatPending = false } = {}) {
  const log = { drawn: [], saved: 0, forgot: 0, lost: 0, sys: [], watching: 0, status: 0, lists: 0, screenOn: [],
                repairs: 0, gone: 0 };
  const run = new Function(
    "roomEventIsOurs", "lobbyStatus", "showRoomReady", "keepScreenOn", "saveHostRoom", "forgetHostRoom",
    "renderSessionList", "loseWaitingRoom", "appendSys", "watchConnecting", "t", "start",
    "repairChatNow", "roomGoneForGood",
    `let isHost = start.isHost, reclaimPending = !start.seatPending, reclaimRedraw = start.redraw, _lastSessionList = [];
     let seatPending = start.seatPending, serverRoomGone = false;
     let currentSession = { sessionId: "bat-room", token: "old" };
     let roomReadyInfo = { sessionId: "bat-room", pin: "123456", token: "old", kind: "pin" };
     function deliver(data) { switch (data.type) {\n${CASES}\n} }
     return { deliver, state: () => ({ reclaimPending, reclaimRedraw, currentSession, roomReadyInfo, seatPending, serverRoomGone }) };`
  )(() => ours, { replaceChildren: () => log.status++ }, d => log.drawn.push(d), on => log.screenOn.push(on),
    () => log.saved++, () => log.forgot++, () => log.lists++, () => log.lost++, k => log.sys.push(k),
    () => log.watching++, k => k, { isHost, redraw, seatPending }, () => log.repairs++, () => log.gone++);
  return { ...run, log };
}

const RECLAIMED = { type: "session-reclaimed", sessionId: "bat-room", pin: "123456", token: "tok", kind: "pin", open: false, guestWaiting: false };

test("taken back: the note goes, the room is kept again, and the screen stays on", () => {
  const a = answers();
  a.deliver(RECLAIMED);
  assert.equal(a.state().reclaimPending, false);
  assert.equal(a.log.status, 1);
  assert.equal(a.state().currentSession.token, "tok");
  assert.deepEqual(a.log.screenOn, [true]);
  assert.equal(a.log.saved, 1);
  assert.deepEqual(a.log.drawn, [], "the panel already on screen is left as it is");
});

test("taken back by a page opened fresh: the panel is drawn", () => {
  const a = answers({ redraw: true });
  a.deliver(RECLAIMED);
  assert.equal(a.log.drawn.length, 1);
  assert.equal(a.log.drawn[0].pin, "123456");
  assert.equal(a.state().reclaimRedraw, false);
});

test("not taken back: forgotten, and said to be closed, with Create again", () => {
  const a = answers();
  a.deliver({ type: "reclaim-failed", sessionId: "bat-room" });
  assert.equal(a.log.forgot, 1);
  assert.equal(a.log.lost, 1);
  assert.equal(a.state().reclaimPending, false);
});

test("taken back mid-chat: the chat goes on and is repaired — the waiting room's panel is not touched", () => {
  /* The server now keeps a chat's seat through a dropped link, and says
     resumed: true when the host takes a chat back rather than a waiting room. */
  const a = answers({ seatPending: true });
  a.deliver({ ...RECLAIMED, resumed: true });
  assert.equal(a.state().seatPending, false);
  assert.equal(a.state().serverRoomGone, false);
  assert.equal(a.log.repairs, 1, "the chat's link repaired now, through the seat taken back");
  assert.equal(a.log.saved + a.log.status + a.log.drawn.length, 0, "nothing of the waiting room");
  assert.equal(a.state().currentSession.token, "old");
});

test("not taken back mid-chat: the room is gone, but the chat is not ended for that alone", () => {
  const a = answers({ seatPending: true });
  a.deliver({ type: "reclaim-failed", sessionId: "bat-room" });
  assert.equal(a.log.gone, 1, "the chat goes on while its own link is up — roomGoneForGood decides");
  assert.equal(a.log.lost, 0, "not the waiting room's loss");
  assert.equal(a.log.forgot, 0);
});

test("someone else's answer, or a guest page, changes nothing", () => {
  const notOurs = answers({ ours: false });
  notOurs.deliver(RECLAIMED);
  notOurs.deliver({ type: "reclaim-failed", sessionId: "other" });
  assert.equal(notOurs.log.saved + notOurs.log.lost, 0);
  const guest = answers({ isHost: false });
  guest.deliver(RECLAIMED);
  assert.equal(guest.log.saved, 0);
});

test("the guest is told when the host is back, and the wait for a connection starts then", () => {
  const g = answers({ isHost: false });
  g.deliver({ type: "host-back", sessionId: "bat-room" });
  assert.deepEqual(g.log.sys, ["hostBack"]);
  assert.equal(g.log.watching, 1);
  const h = answers({ isHost: true });
  h.deliver({ type: "host-back", sessionId: "bat-room" });
  assert.deepEqual(h.log.sys, [], "a host is not told about itself");
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

test("a guest who arrives while the host is away waits, rather than counting down to 'could not connect'", () => {
  const joined = between('    case "session-joined":', '    case "host-back":');
  assert.match(joined, /if \(data\.hostAway === true\) \{\s*\n\s*clearConnectWatch\(\);\s*\n\s*appendSys\(roomKind === "saved" && meeting \? I18N\[LANG\]\.savedWaitingFor\(meeting\.name\) : t\("waitingForHost"\)\);/,
    "and a saved person is waited for by name");
});

test("the room is kept from creation, and let go when the chat starts, the room ends, or the host leaves", () => {
  const created = between('case "session-created": {', "setCreateButtons(false);");
  assert.match(created, /hostKey = typeof data\.hostKey === "string" \? data\.hostKey : null;/);
  assert.match(created, /saveHostRoom\(\);/);
  assert.match(between('    case "guest-joined":', "switchToChat("), /forgetHostRoom\(\);/);
  assert.match(between('case "session-expired": {', "currentSession = null;"), /forgetHostRoom\(\);/);
  assert.match(between("leaveBtn.onclick = () => {", "wsSend("), /forgetHostRoom\(\);/);
  assert.match(fn("loseWaitingRoom"), /forgetHostRoom\(\);/);
  assert.match(fn("returnToWaitingRoom"), /saveHostRoom\(\);/, "a code room's host waiting again is hosting a waiting room");
});

test("the host key is never put in a link", () => {
  assert.match(fn("showRoomReady"), /DC\.buildInviteHash\(data\.sessionId, data\.token, roomSecret\)/);
  assert.doesNotMatch(fn("showRoomReady"), /hostKey/);
});

test("a page that found no room at its first connection does not go looking at the next", () => {
  /* Reconnecting happens often — every dropped link. The record is read once,
     when the page opens; after that this page is the one that writes it. */
  const store = storage();
  const p = page({ store });
  p.restoreHostRoom();                       // nothing stored yet
  store.map.set("dc-host-room", JSON.stringify(record({ savedAt: Date.now() - 1000 })));
  p.restoreHostRoom();                       // a later reconnect
  assert.equal(p.state().isHost, false);
  assert.deepEqual(p.log.tabs, []);
});
