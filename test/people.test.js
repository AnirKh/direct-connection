/*
  Saved people — actually run.

  Talking to the same person again took a room made from nothing each time: a
  name typed, a kind picked, a link copied and sent through another app, and
  tapped. Two people who have saved each other now just tap the other's name:
  whoever is first waits, the second tap connects them, green.

  The rules are in guards.js, the room's name in protocol.js, the meeting in
  server.js (see test/integration). The block "SAVED PEOPLE" is lifted out of
  app.js and run against a small stand-in page.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const crypto = require("node:crypto");
const G      = require("../guards.js");
const DC     = require("../protocol.js");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
const app    = read("app.js");
const html   = read("index.html");
const server = read("server.js");
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

async function person(name, side = "a") {
  const secret = DC.makeRoomSecret();
  return { name, secret, room: await DC.savedRoomName(secret), side, savedAt: 1 };
}

/* ══════════════════════════════════════════
   The rules
══════════════════════════════════════════ */

test("a name is kept as typed, tidied: spaces, invisible marks and the length", () => {
  assert.equal(G.personName("  Anu  "), "Anu");
  assert.equal(G.personName("Anu\n\t  Bat"), "Anu Bat");
  assert.equal(G.personName("An\u0000u​"), "Anu", "control characters and zero-width spaces go");
  assert.equal(G.personName("‮unA"), "unA", "nothing that turns the text round");
  assert.equal(G.personName("👨‍👩‍👧 family"), "👨‍👩‍👧 family", "an emoji made of several keeps its joins");
  assert.equal(G.personName("x".repeat(60)), "x".repeat(G.PERSON_NAME_MAX));
  assert.equal(G.personName("😀".repeat(45)), "😀".repeat(40), "counted as characters: no emoji cut in half");
  for (const nothing of ["", "   ", "​", null, undefined, 7, {}]) assert.equal(G.personName(nothing), null, JSON.stringify(nothing));
});

test("the saved list is believed only as far as it is well-formed", async () => {
  const anu = await person("Anu"), bat = await person("Bat", "b");
  assert.deepEqual(G.savedPeople({ v: 1, people: [anu, bat] }), [anu, bat]);
  assert.deepEqual(G.savedPeople({ v: 1, people: [{ ...anu, name: "  Anu  " }] })[0].name, "Anu");
  assert.equal(G.savedPeople({ v: 1, people: [{ ...anu, savedAt: "x" }] })[0].savedAt, 0);
  for (const bad of [
    { ...anu, name: " " }, { ...anu, secret: "short" }, { ...anu, secret: `${anu.secret}!`.slice(1) },
    { ...anu, room: anu.room.slice(1) }, { ...anu, room: "plain-room" }, { ...anu, side: "c" }, { ...anu, side: undefined },
    null, "Anu", 7
  ]) assert.deepEqual(G.savedPeople({ v: 1, people: [bad] }), [], JSON.stringify(bad));
  assert.deepEqual(G.savedPeople({ v: 1, people: [anu, { ...bat, secret: anu.secret }] }), [anu], "each secret once");
  assert.deepEqual(G.savedPeople({ v: 1, people: [anu, { ...bat, room: anu.room }] }), [anu], "each room once");
  for (const notAList of [null, undefined, "x", [], { v: 2, people: [anu] }, { v: 1, people: "x" }, { people: [anu] }]) {
    assert.deepEqual(G.savedPeople(notAList), [], JSON.stringify(notAList));
  }
  const many = await Promise.all(Array.from({ length: 60 }, (_, i) => person(`P${i}`)));
  assert.equal(G.savedPeople({ v: 1, people: many }).length, G.SAVED_PEOPLE_MAX);
});

test("saving is offered only in a checked chat, and not to someone already saved", () => {
  assert.equal(G.mayOfferSave({ ready: true, secure: true, verified: false, savedRoom: false }), true, "by link or word");
  assert.equal(G.mayOfferSave({ ready: true, secure: false, verified: true, savedRoom: false }), true, "by the code compared");
  assert.equal(G.mayOfferSave({ ready: true, secure: false, verified: false, savedRoom: false }), false, "amber: a middleman would get the key");
  assert.equal(G.mayOfferSave({ ready: false, secure: true, verified: true, savedRoom: false }), false);
  assert.equal(G.mayOfferSave({ ready: true, secure: true, verified: true, savedRoom: true }), false);
});

test("an offer is believed only with a secret of the shape this app makes", () => {
  assert.equal(G.saveOfferValid({ secret: DC.makeRoomSecret() }), true);
  for (const bad of [{ secret: "x" }, { secret: "a".repeat(44) }, { secret: `${"a".repeat(42)}=` }, { secret: 7 }, {}, null]) {
    assert.equal(G.saveOfferValid(bad), false, JSON.stringify(bad));
  }
});

test("offers that crossed: both sides keep the same one", () => {
  for (let i = 0; i < 50; i++) {
    const a = DC.makeRoomSecret(), b = DC.makeRoomSecret();
    assert.notEqual(G.keepTheirOffer(a, b), G.keepTheirOffer(b, a), "exactly one side answers the other's");
  }
  assert.equal(G.keepTheirOffer(null, "x"), false);
});

test("in a saved person's room a key made without the secret is never taken", () => {
  assert.equal(G.mayUsePlainKey("saved"), false);
  for (const kind of ["pin", "open", "code"]) assert.equal(G.mayUsePlainKey(kind), true, kind);
});

test("the room's name: worked out from the secret alone, the same on both sides, and nothing of it given away", async () => {
  const secret = DC.makeRoomSecret();
  const room = await DC.savedRoomName(secret);
  assert.match(room, G.SAVED_ROOM);
  assert.equal(await DC.savedRoomName(secret), room, "both devices arrive at the same name");
  assert.notEqual(await DC.savedRoomName(DC.makeRoomSecret()), room);
  assert.ok(!room.includes(secret) && !room.includes(secret.slice(0, 12)), "the secret is not in it");
  const expected = `~${crypto.createHash("sha256").update(`direct-connection/saved-room/v1:${secret}`).digest("base64url")}`;
  assert.equal(room, expected, "a SHA-256 of the secret, labelled for this one use");
  assert.equal(server.match(/const SAVED_ROOM_PATTERN = (\/.*\/);/)[1], String(G.SAVED_ROOM), "the server knows the same shape");
});

/* ══════════════════════════════════════════
   A small stand-in page
══════════════════════════════════════════ */

function element(tag) {
  const listeners = {};
  const el = {
    tag, type: "", dataset: {}, style: {}, attrs: {}, children: [], parent: null, onclick: null,
    disabled: false, title: "", value: "", _text: "", _class: "",
    get className() { return el._class; },
    set className(v) { el._class = v; },
    classList: {
      contains: c => el._class.split(/\s+/).includes(c),
      add: c => { if (!el.classList.contains(c)) el._class = `${el._class} ${c}`.trim(); },
      remove: c => { el._class = el._class.split(/\s+/).filter(x => x && x !== c).join(" "); },
      toggle: (c, on) => (on ? el.classList.add(c) : el.classList.remove(c))
    },
    get textContent() { return el._text + el.children.map(c => c.textContent).join(""); },
    set textContent(v) { el._text = String(v); el.children = []; },
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    getAttribute: k => el.attrs[k],
    appendChild: c => { c.parent = el; el.children.push(c); return c; },
    append: (...cs) => cs.forEach(c => el.appendChild(c)),
    replaceChildren: (...cs) => { el._text = ""; el.children = []; cs.forEach(c => el.appendChild(c)); },
    querySelectorAll: sel => {
      const cls = sel.replace(/^\./, "");
      const out = [];
      const walk = n => { for (const c of n.children || []) { if (c.classList && c.classList.contains(cls)) out.push(c); walk(c); } };
      walk(el);
      return out;
    },
    querySelector: sel => el.querySelectorAll(sel)[0] || null,
    addEventListener: (type, f) => { (listeners[type] = listeners[type] || []).push(f); },
    fire: (type, e) => (listeners[type] || []).forEach(f => f(e)),
    focus() {},
    click() { if (!el.disabled && el.onclick) el.onclick(); }
  };
  return el;
}

const BLOCK = between("/* ══════════════════════════════════════════════\n   SAVED PEOPLE",
                      "/* ══════════════════════════════════════════════\n   WEBRTC — DATA CHANNEL PC");

const NAMES = ["G", "DC", "I18N", "LANG", "t", "localStorage", "window", "document",
  "chatMessages", "peopleSection", "peopleList", "saveOverlay", "saveTitle", "saveHint", "saveNameInput",
  "saveCancelBtn", "saveConfirmBtn", "leaveBtn", "lobbyStatus", "voiceCallBtn", "videoCallBtn", "statsBar", "chatScreen",
  "tablerIcon", "showToast", "keepScreenOn", "scrollBottom", "dcSendE2e", "wsSend", "ws", "WebSocket",
  "clearConnectWatch", "endCall", "closePeerConnection", "setQuality", "appendSys", "showReconnectButton",
  "setTimeout", "knockBtn", "knockIcon", "knockLabel", "Notification", "navigator", "location", "history", "indexedDB",
  "APP_BUILD", "installOverlay", "showLobbyTab", "runningInstalled", "env"];

/** A real P-256 public key and a 16-byte secret, as a browser's subscription has. */
function pushKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
}
const SERVER_KNOCK_KEY = (() => { const e = crypto.createECDH("prime256v1"); e.generateKeys(); return e.getPublicKey().toString("base64url"); })();

/** The browser's push and notifications, stood in for. */
function pushBrowser(env, log) {
  let current = env.subscribed ? subscription(env.subscribedKey || SERVER_KNOCK_KEY) : null;
  function subscription(key) {
    const keys = pushKeys();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(8).toString("hex")}`;
    return {
      endpoint, options: { applicationServerKey: Uint8Array.from(Buffer.from(key, "base64url")).buffer },
      toJSON: () => ({ endpoint, keys }),
      unsubscribe: async () => { log.unsubscribed++; current = null; return true; }
    };
  }
  const reg = { pushManager: {
    getSubscription: async () => current,
    subscribe: async opts => {
      log.subscribed.push({ userVisibleOnly: opts.userVisibleOnly, key: Buffer.from(opts.applicationServerKey).toString("base64url") });
      current = subscription(Buffer.from(opts.applicationServerKey).toString("base64url"));
      return current;
    }
  } };
  const swListeners = {};
  const navigator = {
    userAgent: env.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/130", maxTouchPoints: env.touch || 0,
    serviceWorker: {
      register: async (url, opts) => { log.registered.push({ url, opts }); env.registered = true; return reg; },
      get ready() { return Promise.resolve(reg); },
      getRegistration: async () => (env.registered ? reg : undefined),
      addEventListener: (type, f) => { swListeners[type] = f; }
    }
  };
  const Notification = {
    permission: env.permission || "default",
    requestPermission: async () => { log.asked++; Notification.permission = env.answer || "granted"; return Notification.permission; }
  };
  return { navigator, Notification, swListeners, current: () => current };
}

/** IndexedDB, as much as the worker's copy needs. */
function fakeIndexedDB(idb) {
  return {
    open: () => {
      const db = {
        createObjectStore() {}, close() {},
        transaction: () => {
          const tx = { objectStore: () => ({ put: (v, k) => { idb.set(k, JSON.parse(JSON.stringify(v))); setTimeout(() => tx.oncomplete && tx.oncomplete()); } }) };
          return tx;
        }
      };
      const req = { result: db };
      setTimeout(() => req.onsuccess && req.onsuccess());
      return req;
    }
  };
}

/**
 * One page, with `saved` already kept. storage: "works", "readonly" (read but
 * not written), "full" (a small probe fits, the list does not), or "off"
 * (neither read nor written).
 */
function page({ saved = [], storage = "works", connected = true, checked = true, kind = "pin", wsOpen = true, inChat = false, lang = "mn",
                 knock = {} } = {}) {
  const log = { ws: [], sealed: [], toasts: [], sys: [], screen: [], left: 0, quality: [], reconnect: 0, closed: 0,
                asked: 0, registered: [], subscribed: [], unsubscribed: 0, replaced: [], tabs: [] };
  const store = new Map();
  if (saved.length) store.set("dc-people", JSON.stringify({ v: 1, people: saved }));
  const off = () => { throw new Error("storage off"); };
  const localStorage = {
    getItem: k => (storage === "off" ? off() : store.has(k) ? store.get(k) : null),
    setItem: (k, v) => (storage === "readonly" || storage === "off" || (storage === "full" && k === "dc-people") ? off() : store.set(k, String(v))),
    removeItem: k => { store.delete(k); }
  };
  const winListeners = {};
  const idb = new Map();
  const indexedDB = fakeIndexedDB(idb);
  const window = { indexedDB, addEventListener: (type, f) => { (winListeners[type] = winListeners[type] || []).push(f); } };
  const push = pushBrowser(knock, log);
  const document = { createElement: element, createTextNode: s => ({ tag: "#text", textContent: String(s), children: [] }) };
  const els = {};
  for (const n of ["chatMessages", "peopleSection", "peopleList", "saveOverlay", "saveTitle", "saveHint", "saveNameInput",
                   "saveCancelBtn", "saveConfirmBtn", "leaveBtn", "lobbyStatus", "voiceCallBtn", "videoCallBtn", "statsBar", "chatScreen",
                   "knockBtn", "knockIcon", "knockLabel", "installOverlay"]) {
    els[n] = element(n === "saveNameInput" ? "input" : "div");
  }
  els.peopleSection.classList.add("hidden");
  els.saveOverlay.classList.add("hidden");
  els.knockBtn.classList.add("hidden");
  els.installOverlay.classList.add("hidden");
  if (!inChat) els.chatScreen.classList.add("hidden");
  const env = { kind, connected, checked, onLeave: null, knockSupported: knock.supported !== false,
                knockKey: knock.serverKey === false || knock.keyLater ? null : SERVER_KNOCK_KEY };
  const location = { hash: knock.hash || "", pathname: "/direct-connection/", search: "" };
  const history = { replaceState: (s, title, url) => log.replaced.push(url) };
  els.leaveBtn.click = () => { log.left++; if (env.onLeave) env.onLeave(); };
  const ws = { readyState: wsOpen ? 1 : 3 };
  const tablerIcon = name => { const i = element("i"); i.className = `ti ti-${name}`; return i; };
  const api = new Function(...NAMES, `
    let people = [], meeting = null, pendingMeet = null, saveOffer = null, saveAsked = null, saveDialog = null, forgetting = null;
    let currentSession = null, isConnecting = false, listJoinId = null, pinJoinInFlight = false, isHost = false;
    let hostKey = null, reclaimPending = false, roomSecret = null, pendingRoomSecret = null, pakeCode = null;
    let roomKind = env.kind, guestKey = null, seatPending = false, dataChannel = null;
    let e2eReady = env.connected, e2eSecureMode = env.checked, e2eVerified = false;
    const knockSupported = env.knockSupported;
    let knockKey = env.knockKey, knockSub = null, knockSent = false, knockShared = false, savedInChat = null, knockEarly = null;
    ${BLOCK}
    return {
      drawPeople, meetPerson, sendPendingMeet, meetWaiting, endMeeting, savedSeatTaken, roomTitle,
      maybeOfferSave, startSaveOffer, receiveSaveOffer, receiveSaveAccept, receiveSaveDecline,
      renamePerson, askForget, forgetPerson, confirmSaveDialog, cancelSaveDialog,
      knockStateNow, knockKeyArrived, knocksOn, knocksOff, shareKnockAddress, sendKnockAddress, receiveKnockAddress,
      knockAnswered, answerKnock, savedInChatNow,
      get: () => ({ people, meeting, pendingMeet, saveOffer, saveAsked, saveDialog, forgetting, currentSession,
                    isConnecting, isHost, hostKey, roomSecret, pendingRoomSecret, roomKind, guestKey,
                    knockKey, knockSub, knockSent, knockShared, savedInChat, knockEarly }),
      set: o => { for (const [k, v] of Object.entries(o)) switch (k) {
        case "listJoinId": listJoinId = v; break;
        case "currentSession": currentSession = v; break;
        case "isConnecting": isConnecting = v; break;
        case "isHost": isHost = v; break;
        case "e2eSecureMode": e2eSecureMode = v; break;
        case "e2eVerified": e2eVerified = v; break;
        case "roomKind": roomKind = v; break;
        case "meeting": meeting = v; break;
        case "pendingMeet": pendingMeet = v; break;
        case "knockShared": knockShared = v; break;
        default: throw new Error("cannot set " + k);
      } }
    };`
  )(G, DC, I18N, lang, k => I18N[lang][k], localStorage, window, document,
    els.chatMessages, els.peopleSection, els.peopleList, els.saveOverlay, els.saveTitle, els.saveHint, els.saveNameInput,
    els.saveCancelBtn, els.saveConfirmBtn, els.leaveBtn, els.lobbyStatus, els.voiceCallBtn, els.videoCallBtn, els.statsBar, els.chatScreen,
    tablerIcon, (m, kind) => log.toasts.push(m), on => log.screen.push(on), () => {},
    async m => { if (!env.connected) return false; log.sealed.push(JSON.parse(JSON.stringify(m))); return true; },
    m => log.ws.push(JSON.parse(JSON.stringify(m))), ws, { OPEN: 1 },
    () => {}, () => {}, () => { log.closed++; }, q => log.quality.push(q), s => log.sys.push(s), () => { log.reconnect++; },
    f => f(), els.knockBtn, els.knockIcon, els.knockLabel, push.Notification, push.navigator, location, history, indexedDB,
    "202610290000-abcdef12", els.installOverlay, n => log.tabs.push(n), () => Boolean(knock.standalone), env);
  const rows = () => els.peopleList.children;
  const button = (row, cls) => row.children.find(c => c.classList.contains(cls));
  const stored = () => JSON.parse(store.get("dc-people") || "null");
  const storageEvent = () => (winListeners.storage || []).forEach(f => f({ key: "dc-people" }));
  const type = text => { els.saveNameInput.value = text; };
  return { api, log, els, env, ws, store, rows, button, stored, storageEvent, type, idb, push };
}

const settle = () => new Promise(r => setTimeout(r, 0));
/** Waits for `done` — for work behind the page's own crypto, which one turn
    of the event loop does not always cover. */
async function until(done, ms = 2000) {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise(r => setTimeout(r, 2));
}

/* ══════════════════════════════════════════
   The list
══════════════════════════════════════════ */

test("nobody saved: no list at all", () => {
  const p = page();
  assert.ok(p.els.peopleSection.classList.contains("hidden"));
  assert.equal(p.rows().length, 0);
});

test("everyone saved is a name to tap — with nothing of their secret or room on the page", async () => {
  const anu = await person("Anu"), bat = await person("Bat", "b");
  const p = page({ saved: [anu, bat] });
  assert.ok(!p.els.peopleSection.classList.contains("hidden"));
  assert.deepEqual(p.rows().map(r => r.querySelector(".person-name").textContent), ["Anu", "Bat"]);
  const all = p.rows().map(r => r.textContent).join(" ");
  assert.ok(all.includes(I18N.mn.personTap));
  for (const x of [anu.secret, anu.room, bat.secret, bat.room]) assert.ok(!all.includes(x));
  const tools = p.rows()[0].children.filter(c => c.classList.contains("person-tool"));
  assert.deepEqual(tools.map(c => c.attrs["aria-label"]), [`${I18N.mn.personRename}: Anu`, `${I18N.mn.personForget}: Anu`],
    "the small buttons say what they do, and to whom");
});

test("storage switched off: an empty list, and nothing breaks", () => {
  const p = page({ storage: "off" });
  assert.equal(p.rows().length, 0);
});

test("saved or forgotten in another tab: the same list here", async () => {
  const p = page();
  p.store.set("dc-people", JSON.stringify({ v: 1, people: [await person("Anu")] }));
  p.storageEvent();
  assert.equal(p.rows().length, 1);
});

/* ══════════════════════════════════════════
   Meeting
══════════════════════════════════════════ */

test("a tap on a name: one message — their room's name and our side, nothing else; the secret stays, for the key", async () => {
  const anu = await person("Anu", "b");
  const p = page({ saved: [anu] });
  p.button(p.rows()[0], "person-open").click();
  assert.deepEqual(p.log.ws, [{ type: "meet-session", sessionId: anu.room, side: "b" }]);
  const s = p.api.get();
  assert.equal(s.pendingRoomSecret, anu.secret, "mixed into the key once connected");
  assert.equal(s.roomKind, "saved");
  assert.equal(s.isConnecting, true);
  assert.equal(s.meeting.name, "Anu");
  assert.ok(p.rows()[0].textContent.includes(I18N.mn.personConnecting));
  assert.ok(!JSON.stringify(p.log.ws).includes(anu.secret));
});

test("while one is being met, no other name — nor the same one again — can be tapped", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  p.api.meetPerson(anu);
  assert.ok(p.rows().every(r => p.button(r, "person-open").disabled));
  p.api.meetPerson(bat);
  p.api.meetPerson(anu);
  assert.equal(p.log.ws.length, 1);
});

test("a tap while a join is under way does nothing; a waiting room of our own is given up for it", async () => {
  const anu = await person("Anu");
  const busy = page({ saved: [anu] });
  busy.api.set({ listJoinId: "someone's room" });
  busy.api.meetPerson(anu);
  busy.api.set({ listJoinId: null, isConnecting: true });       // "Creating…"
  busy.api.meetPerson(anu);
  assert.deepEqual(busy.log.ws, []);

  const hosting = page({ saved: [anu] });
  hosting.env.onLeave = () => hosting.api.set({ currentSession: null, isHost: false });
  hosting.api.set({ currentSession: { sessionId: "my-room" }, isHost: true });
  hosting.api.meetPerson(anu);
  assert.equal(hosting.log.left, 1, "left first: one room per page");
  assert.equal(hosting.log.ws.length, 1);
});

test("tapped with the link down: sent as soon as it is back, and again each time until answered", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], wsOpen: false });
  p.api.meetPerson(anu);
  assert.deepEqual(p.log.ws, []);
  p.ws.readyState = 1;
  p.api.sendPendingMeet();
  p.api.sendPendingMeet();
  assert.equal(p.log.ws.length, 2);
  p.api.meetWaiting({ sessionId: anu.room, hostKey: "k".repeat(32) });
  p.api.sendPendingMeet();
  assert.equal(p.log.ws.length, 2, "answered: not sent again");
});

test("first there: we wait on their row with the screen kept on, and the key's secret is theirs", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  p.api.meetPerson(anu);
  p.api.meetWaiting({ type: "session-created", sessionId: anu.room, hostKey: "k".repeat(32), kind: "saved" });
  const s = p.api.get();
  assert.equal(s.isHost, true);
  assert.deepEqual(s.currentSession, { sessionId: anu.room, token: null });
  assert.equal(s.hostKey, "k".repeat(32), "to take the room back if the link drops");
  assert.equal(s.roomSecret, anu.secret);
  assert.equal(s.pendingRoomSecret, null);
  assert.equal(s.isConnecting, false);
  assert.deepEqual(p.log.screen, [true]);
  const row = p.rows()[0];
  assert.ok(row.classList.contains("waiting"));
  assert.ok(row.textContent.includes(I18N.mn.personWaiting));
  const cancel = p.button(row, "person-small-btn");
  assert.equal(cancel.textContent, I18N.mn.personCancel);
  cancel.click();
  assert.equal(p.log.left, 1, "Cancel is leaving the room");
});

test("an answer to a tap already cancelled takes nothing up, and sends nothing", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  p.api.meetWaiting({ sessionId: anu.room, hostKey: "k".repeat(32) });
  const s = p.api.get();
  assert.equal(s.isHost, false);
  assert.equal(s.currentSession, null);
  assert.deepEqual(p.log.ws, [], "the cancel's own leave already let the room go");
});

test("the wait over — expired, lost or refused: their row is a name again, and the screen let go", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  p.api.meetPerson(anu);
  p.api.meetWaiting({ sessionId: anu.room, hostKey: "k".repeat(32) });
  p.api.endMeeting();
  const s = p.api.get();
  for (const k of ["meeting", "pendingMeet", "currentSession", "hostKey", "roomSecret", "pendingRoomSecret"]) assert.equal(s[k], null, k);
  assert.equal(s.isHost, false);
  assert.equal(s.roomKind, "pin");
  assert.deepEqual(p.log.screen, [true, false]);
  assert.ok(p.rows()[0].textContent.includes(I18N.mn.personTap));
  assert.ok(!p.button(p.rows()[0], "person-open").disabled);
});

test("opened elsewhere while waiting: said, and the row is a name again", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  p.api.meetPerson(anu);
  p.api.meetWaiting({ sessionId: anu.room, hostKey: "k".repeat(32) });
  p.api.savedSeatTaken();
  assert.deepEqual(p.log.toasts, [I18N.mn.savedElsewhere]);
  assert.equal(p.api.get().meeting, null);
  assert.equal(p.api.get().currentSession, null);
});

test("opened elsewhere mid-chat: this copy stops, says so, and offers the way back", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], inChat: true });
  p.api.meetPerson(anu);
  p.api.savedSeatTaken();
  assert.equal(p.log.closed, 1, "its connection let go");
  assert.deepEqual(p.log.sys, [I18N.mn.savedElsewhere]);
  assert.equal(p.log.reconnect, 1);
  assert.equal(p.log.quality.length, 1);
  assert.equal(p.api.get().guestKey, null, "nothing to take back");
  assert.deepEqual(p.log.ws, [p.log.ws[0]], "and nothing joins again by itself");
});

test("on screen, a saved person's room is called by their name — any other by its own", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  assert.equal(p.api.roomTitle(anu.room), anu.room);
  p.api.meetPerson(anu);
  assert.equal(p.api.roomTitle(anu.room), "Anu");
  assert.equal(p.api.roomTitle("other room"), "other room");
});

/* ══════════════════════════════════════════
   Saving each other
══════════════════════════════════════════ */

test("a checked chat offers to save the person, once; an amber one, or a saved person's own room, does not", () => {
  const green = page({ inChat: true });
  green.api.maybeOfferSave();
  green.api.maybeOfferSave();
  const lines = green.els.chatMessages.querySelectorAll(".save-sys");
  assert.equal(lines.length, 1);
  assert.ok(lines[0].textContent.includes(I18N.mn.saveLineBtn));

  const amber = page({ checked: false, inChat: true });
  amber.api.maybeOfferSave();
  assert.equal(amber.els.chatMessages.querySelectorAll(".save-sys").length, 0);
  amber.api.set({ e2eVerified: true });                      // the code compared by hand
  amber.api.maybeOfferSave();
  assert.equal(amber.els.chatMessages.querySelectorAll(".save-sys").length, 1);

  const saved = page({ kind: "saved", inChat: true });
  saved.api.maybeOfferSave();
  assert.equal(saved.els.chatMessages.querySelectorAll(".save-sys").length, 0);
});

test("Save: named, then offered with a fresh secret — sealed, over the chat, never through the server", async () => {
  const p = page({ inChat: true });
  p.api.maybeOfferSave();
  p.api.startSaveOffer();
  assert.ok(!p.els.saveOverlay.classList.contains("hidden"));
  assert.equal(p.els.saveTitle.textContent, I18N.mn.saveTitle);
  p.type("   ");
  p.api.confirmSaveDialog();
  assert.ok(!p.els.saveOverlay.classList.contains("hidden"), "no name, nothing done");
  p.type("  Anu  ");
  p.els.saveNameInput.fire("keydown", { key: "Enter", isComposing: false, preventDefault() {} });
  await settle();
  assert.ok(p.els.saveOverlay.classList.contains("hidden"));
  assert.equal(p.log.sealed.length, 1);
  assert.equal(p.log.sealed[0].type, "save-offer");
  assert.match(p.log.sealed[0].secret, G.SAVED_SECRET);
  assert.deepEqual(Object.keys(p.log.sealed[0]).sort(), ["secret", "type"], "the name stays here");
  assert.deepEqual(p.log.ws, []);
  assert.equal(p.api.get().saveOffer.name, "Anu");
  assert.ok(p.els.chatMessages.querySelector(".save-sys").textContent.includes(I18N.mn.saveLineWaiting));
  assert.deepEqual(p.stored(), null, "not saved until they say yes");
});

test("a name being typed with an input method: Enter picks the word, it does not save", () => {
  const p = page({ inChat: true });
  p.api.startSaveOffer();
  p.type("Ану");
  p.els.saveNameInput.fire("keydown", { key: "Enter", isComposing: true, preventDefault() {} });
  assert.ok(!p.els.saveOverlay.classList.contains("hidden"));
});

test("their yes: saved as side a, under the name given, its room worked out from the secret", async () => {
  const p = page({ inChat: true });
  p.api.maybeOfferSave();
  p.api.startSaveOffer();
  p.type("Anu");
  p.api.confirmSaveDialog();
  await settle();
  const secret = p.log.sealed[0].secret;
  await p.api.receiveSaveAccept();
  const kept = p.stored().people;
  assert.equal(kept.length, 1);
  assert.deepEqual({ ...kept[0], savedAt: 0 }, { name: "Anu", secret, room: await DC.savedRoomName(secret), side: "a", savedAt: 0 });
  assert.deepEqual(p.log.toasts, [I18N.mn.savedDone("Anu")]);
  assert.ok(p.els.chatMessages.querySelector(".save-sys").textContent.includes(I18N.mn.saveLineDone("Anu")));
  assert.equal(p.rows().length, 1, "and in the list at once");
  await p.api.receiveSaveAccept();
  assert.equal(p.stored().people.length, 1, "a second yes saves nothing more");
});

test("their offer: asked to name them back — yes saves them as side b and says so; Not now says no", async () => {
  const secret = DC.makeRoomSecret();
  const yes = page({ inChat: true });
  yes.api.maybeOfferSave();
  await yes.api.receiveSaveOffer({ type: "save-offer", secret });
  assert.equal(yes.els.saveTitle.textContent, I18N.mn.saveAskTitle);
  assert.equal(yes.els.saveCancelBtn.textContent, I18N.mn.saveNotNow);
  yes.type("Bat");
  yes.api.confirmSaveDialog();
  await until(() => yes.log.sealed.length >= 2);
  assert.deepEqual(yes.log.sealed, [{ type: "save-accept" }, { type: "knock-address", off: true }],
    "and where to knock for us — nowhere, with alerts off");
  assert.deepEqual(yes.stored().people.map(q => [q.name, q.secret, q.side]), [["Bat", secret, "b"]]);
  assert.ok(yes.els.chatMessages.querySelector(".save-sys").textContent.includes(I18N.mn.saveLineDone("Bat")));

  const no = page({ inChat: true });
  await no.api.receiveSaveOffer({ type: "save-offer", secret });
  no.api.cancelSaveDialog();
  await settle();
  assert.deepEqual(no.log.sealed, [{ type: "save-decline" }]);
  assert.equal(no.stored(), null);
  assert.equal(no.api.get().saveAsked, null);
});

test("an offer in a chat this side has not checked is turned down, and why is said on both", async () => {
  const p = page({ checked: false, inChat: true });
  await p.api.receiveSaveOffer({ type: "save-offer", secret: DC.makeRoomSecret() });
  await settle();
  assert.deepEqual(p.log.sealed, [{ type: "save-decline", reason: "unverified" }]);
  assert.deepEqual(p.log.toasts, [I18N.mn.savedVerifyFirst]);
  assert.ok(p.els.saveOverlay.classList.contains("hidden"), "not asked");
});

test("a malformed offer, or a second while one is asked, is ignored", async () => {
  const p = page({ inChat: true });
  await p.api.receiveSaveOffer({ type: "save-offer", secret: "x" });
  await p.api.receiveSaveOffer({ type: "save-offer" });
  assert.deepEqual(p.log.sealed, []);
  assert.ok(p.els.saveOverlay.classList.contains("hidden"));
  const first = DC.makeRoomSecret();
  await p.api.receiveSaveOffer({ type: "save-offer", secret: first });
  await p.api.receiveSaveOffer({ type: "save-offer", secret: DC.makeRoomSecret() });
  assert.equal(p.api.get().saveAsked.secret, first);
});

test("in a saved person's own room an offer is declined at once", async () => {
  const p = page({ kind: "saved", inChat: true });
  await p.api.receiveSaveOffer({ type: "save-offer", secret: DC.makeRoomSecret() });
  await settle();
  assert.deepEqual(p.log.sealed, [{ type: "save-decline" }]);
  assert.ok(p.els.saveOverlay.classList.contains("hidden"));
});

test("both pressed Save at once: both end up with the same secret, on opposite sides, under their own names", async () => {
  for (let i = 0; i < 6; i++) {
    const a = page({ inChat: true }), b = page({ inChat: true });
    for (const [p, name] of [[a, "Bat"], [b, "Anu"]]) {
      p.api.startSaveOffer();
      p.type(name);
      p.api.confirmSaveDialog();
    }
    await settle();
    const offerA = a.log.sealed.shift(), offerB = b.log.sealed.shift();
    await a.api.receiveSaveOffer(offerB);
    await b.api.receiveSaveOffer(offerA);
    await settle();
    for (const [from, to] of [[a, b], [b, a]]) {
      for (const m of from.log.sealed.splice(0)) if (m.type === "save-accept") await to.api.receiveSaveAccept();
    }
    const ka = a.stored().people, kb = b.stored().people;
    assert.equal(ka.length, 1, `round ${i}`);
    assert.equal(kb.length, 1);
    assert.equal(ka[0].secret, kb[0].secret, "the same secret on both");
    assert.equal(ka[0].room, kb[0].room);
    assert.notEqual(ka[0].side, kb[0].side, "one side each");
    assert.deepEqual([ka[0].name, kb[0].name], ["Bat", "Anu"]);
  }
});

test("their no: said in our words, whatever reason came, and the offer is open again", async () => {
  for (const [reason, said] of [["unverified", "savedPeerVerifyFirst"], ["storage", "savedPeerNoStorage"],
                                [undefined, "savedDeclined"], ["constructor", "savedDeclined"], ["<b>x</b>", "savedDeclined"]]) {
    const p = page({ inChat: true });
    p.api.maybeOfferSave();
    p.api.startSaveOffer();
    p.type("Anu");
    p.api.confirmSaveDialog();
    await settle();
    p.api.receiveSaveDecline({ type: "save-decline", reason });
    assert.deepEqual(p.log.toasts, [I18N.mn[said]], String(reason));
    assert.equal(p.api.get().saveOffer, null);
    assert.ok(p.els.chatMessages.querySelector(".save-sys").textContent.includes(I18N.mn.saveLineBtn));
  }
});

test("a yes or a no to no offer of ours is ignored", async () => {
  const p = page({ inChat: true });
  await p.api.receiveSaveAccept();
  p.api.receiveSaveDecline({ reason: "unverified" });
  assert.equal(p.stored(), null);
  assert.deepEqual(p.log.toasts, []);
});

test("a browser that cannot keep them: no offer made and none accepted — never saved on one side alone", async () => {
  for (const storage of ["readonly", "off"]) {
    const p = page({ storage, inChat: true });
    p.api.startSaveOffer();
    assert.ok(p.els.saveOverlay.classList.contains("hidden"), storage);
    assert.deepEqual(p.log.toasts, [I18N.mn.savedNoStorage]);
    await p.api.receiveSaveOffer({ type: "save-offer", secret: DC.makeRoomSecret() });
    await settle();
    assert.deepEqual(p.log.sealed, [{ type: "save-decline", reason: "storage" }]);
  }
});

test("storage full only when the list is written: their offer is turned down, not half-saved", async () => {
  const p = page({ storage: "full", inChat: true });
  await p.api.receiveSaveOffer({ type: "save-offer", secret: DC.makeRoomSecret() });
  assert.ok(!p.els.saveOverlay.classList.contains("hidden"), "the probe fitted, so they were asked");
  p.type("Bat");
  p.api.confirmSaveDialog();
  await until(() => p.log.sealed.length >= 1);
  await settle();
  assert.deepEqual(p.log.sealed, [{ type: "save-decline", reason: "storage" }], "no yes for what was not kept");
  assert.deepEqual(p.log.toasts, [I18N.mn.savedNoStorage]);
  assert.equal(p.rows().length, 0);
});

test("an offer made in an amber chat is refused before any dialog", () => {
  const p = page({ checked: false, inChat: true });
  p.api.startSaveOffer();
  assert.ok(p.els.saveOverlay.classList.contains("hidden"));
  assert.deepEqual(p.log.toasts, [I18N.mn.savedVerifyFirst]);
});

test("fifty at most", async () => {
  const many = await Promise.all(Array.from({ length: G.SAVED_PEOPLE_MAX }, (_, i) => person(`P${i}`)));
  const p = page({ saved: many, inChat: true });
  p.api.startSaveOffer();
  assert.deepEqual(p.log.toasts, [I18N.mn.savedFull]);
  await p.api.receiveSaveOffer({ type: "save-offer", secret: DC.makeRoomSecret() });
  await settle();
  assert.deepEqual(p.log.sealed, [{ type: "save-decline" }]);
});

/* ══════════════════════════════════════════
   Renaming and forgetting — this device only
══════════════════════════════════════════ */

test("renamed here, and only here", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  p.button(p.rows()[0], "person-tool").click();
  assert.equal(p.els.saveTitle.textContent, I18N.mn.renameTitle);
  assert.equal(p.els.saveNameInput.value, "Anu", "the old name to change");
  p.type("Anu (phone)");
  p.api.confirmSaveDialog();
  assert.deepEqual(p.stored().people.map(q => q.name), ["Anu (phone)", "Bat"], "only the one renamed");
  assert.equal(p.stored().people[0].secret, anu.secret);
  assert.equal(p.rows()[0].querySelector(".person-name").textContent, "Anu (phone)");
  assert.deepEqual(p.log.sealed, [], "nothing sent anywhere");
});

test("forget asks first, in the row; Keep keeps; Forget takes them off this device", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  p.rows()[0].children.filter(c => c.classList.contains("person-tool"))[1].click();
  assert.ok(p.rows()[0].classList.contains("asking"));
  assert.ok(p.rows()[0].textContent.includes(I18N.mn.forgetAsk("Anu")));
  p.rows()[0].children.find(c => c.textContent === I18N.mn.forgetNo).click();
  assert.equal(p.stored().people.length, 2);
  assert.ok(!p.rows()[0].classList.contains("asking"));
  p.api.askForget(anu);
  p.rows()[0].children.find(c => c.textContent === I18N.mn.forgetYes).click();
  assert.deepEqual(p.stored().people.map(q => q.name), ["Bat"]);
  assert.equal(p.rows().length, 1);
});

test("while one is being met, nobody can be renamed or forgotten", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  p.api.meetPerson(anu);
  assert.ok(p.rows()[1].children.filter(c => c.classList.contains("person-tool")).every(c => c.disabled));
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

test("a tap's message carries the room's name and the side, and nothing else", () => {
  const m = fn("meetPerson").match(/pendingMeet = (\{[^}]*\});/);
  assert.ok(m);
  assert.equal(m[1], '{ type: "meet-session", sessionId: p.room, side: p.side }');
});

test("the host takes no key made without the secret in a saved person's room", () => {
  const derive = fn("e2eDeriveKey");
  assert.match(derive, /plain:\s*G\.mayUsePlainKey\(roomKind\) \? await deriveKeyWith\(peerPub, null\) : null/);
  assert.match(fn("handleE2eConfirm"), /\} else if \(plain && await opensConfirm\(plain, data\.ct, data\.iv\)\) \{/,
    "and a missing one opens nothing");
});

test("the guard against sending a secret to the server covers every saved one", () => {
  const guarded = fn("roomSecretsInPlay");
  for (const holder of ["meeting && meeting.secret", "saveOffer && saveOffer.secret", "saveAsked && saveAsked.secret", "...people.map(p => p.secret)"]) {
    assert.ok(guarded.includes(holder), `roomSecretsInPlay omits ${holder}`);
  }
});

test("saving each other is believed only sealed", () => {
  for (const type of ["save-offer", "save-accept", "save-decline"]) {
    assert.equal(G.mayHandleFrame(type, false), false, `${type} in the clear`);
    assert.equal(G.mayHandleFrame(type, true), true, `${type} sealed`);
  }
});

test("an offer is let go of with the channel it came on, and its question closed", () => {
  const close = fn("closePeerConnection");
  assert.match(close, /saveOffer = null;\s*\n\s*saveAsked = null;\s*\n\s*if \(saveDialog && saveDialog\.mode !== "rename"\) closeSaveDialog\(\);/);
});

test("the chat offers once it is checked — by the key, or by the code compared by hand", () => {
  assert.match(fn("e2eActivate"), /appendSys\(t\("sysConnected"\)\);\s*\n\s*maybeOfferSave\(\);/);
  assert.match(between('keyVerifyInput.addEventListener("input"', "\n  });"), /updateShield\(\);\s*\n\s*maybeOfferSave\(\);/);
});

test("the room made for us is waited in; a saved room's name is never kept for a reload, nor shown", () => {
  assert.match(between('    case "session-created": {', "pendingCreate = null;"), /if \(data\.kind === "saved"\) \{ meetWaiting\(data\); break; \}/);
  assert.match(fn("saveHostRoom"), /roomKind === "saved"\) return;/);
  assert.match(fn("switchToChat"), /chatSessionLabel\.textContent = roomTitle\(sessionId\);/);
  assert.match(fn("showCallOverlay"), /nameEl\.textContent = roomTitle\(/);
});

test("the server's news about a saved person's room is taken the saved way", () => {
  const created = between('    case "session-created": {', "pendingCreate = null;");
  assert.match(created, /if \(meeting\) \{ meeting = null; pendingMeet = null; drawPeople\(\); \}/, "a room of our own made instead: the wait is given up");
  assert.match(between('    case "session-joined":', '    case "host-back":'), /if \(roomKind !== "saved" && meeting\) \{ meeting = null; drawPeople\(\); \}/,
    "another room joined instead: the same");
  const hostBack = between('    case "host-back":', '    case "session-reclaimed":');
  assert.match(hostBack, /if \(data\.restart === true\) \{\s*\n\s*if \(dataChannel\) dataChannel\.onclose = null;\s*\n\s*endCall\(false\);\s*\n\s*createPeerConnection\(\);/,
    "their side opened afresh: start again with it, quietly, keeping what was said");
  assert.match(between('    case "guest-joined":', '    case "offer":'), /roomKind === "saved" \? I18N\[LANG\]\.savedReopened\(roomTitle\(currentSession\.sessionId\)\) : t\("guestReopened"\)/);
  const seat = between('    case "seat-taken":', '    case "guest-left":');
  assert.match(seat, /if \(!roomEventIsOurs\(data\)\) break;\s*\n\s*if \(roomKind === "saved"\) \{ savedSeatTaken\(\); break; \}\s*\n\s*if \(isHost\) break;/,
    "the host side too, for a saved person's room");
  assert.match(between('    case "session-expired": {', '    case "error": {'), /if \(roomKind === "saved"\) \{[\s\S]*?endMeeting\(\);[\s\S]*?savedExpired/);
  assert.match(fn("loseWaitingRoom"), /if \(roomKind === "saved"\) \{ endMeeting\(\); showToast\(`⚠️ \$\{t\("savedLost"\)\}`, "warn"\); return; \}/);
});

test("the channel gone when Save is pressed: said, and nothing is left waiting", async () => {
  const p = page({ inChat: true });
  p.api.maybeOfferSave();
  p.api.startSaveOffer();
  p.env.connected = false;
  p.type("Anu");
  p.api.confirmSaveDialog();
  await settle();
  assert.deepEqual(p.log.toasts, [I18N.mn.messageNotSent]);
  assert.equal(p.api.get().saveOffer, null);
  assert.ok(p.els.chatMessages.querySelector(".save-sys").textContent.includes(I18N.mn.saveLineBtn), "the offer still there to press");
});

test("a tap while a PIN is being tried does nothing", () => {
  assert.match(fn("meetPerson"), /if \(meeting \|\| listJoinId \|\| pinJoinInFlight \|\| \(isConnecting && !currentSession\)\) return;/);
});

test("leaving lets go of the person being met, and the lobby shows them as a name again", () => {
  assert.match(between("leaveBtn.onclick = () => {", "\n};"),
    /meeting = null;\s*\n\s*pendingMeet = null;\s*\n\s*knockSent = false;\s*\n\s*savedInChat = null;\s*\n\s*drawPeople\(\);/);
});

test("after a chat joined from a link, the whole lobby works again — the name field and Refresh too", () => {
  /* Found checking this feature: a page that joined by link switched them off
     for the join, and nothing switched them on again after the chat. */
  assert.match(fn("checkAutoJoin"), /setLobbyButtons\(true\);/);
  assert.match(between("leaveBtn.onclick = () => {", "\n};"), /setLobbyButtons\(false\);/);
  assert.match(fn("setLobbyButtons"), /sessionIdInput\.disabled = disabled;\s*\n\s*refreshBtn\.disabled\s*= disabled;/);
});

test("the lobby has the list and the name dialog, and every word is in both languages", () => {
  for (const id of ["peopleSection", "peopleList", "saveOverlay", "saveTitle", "saveHint", "saveNameInput", "saveCancelBtn", "saveConfirmBtn"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.indexOf('id="peopleSection"') < html.indexOf('id="sessionsList"'), "above the rooms");
  assert.match(html, /id="saveNameInput"[^>]*maxlength="40"/);
  /* Every quoted word the block names, and every I18N[LANG].x it calls, that
     either language has — a class name or a mode is in neither. */
  const named = [...BLOCK.matchAll(/"(\w+)"/g), ...BLOCK.matchAll(/I18N\[LANG\]\.(\w+)/g)].map(m => m[1]);
  const words = [...new Set(named)].filter(k => k in I18N.en || k in I18N.mn);
  assert.ok(words.length > 28, `only ${words.length} words found`);
  for (const key of words) {
    for (const lang of ["mn", "en"]) assert.ok(key in I18N[lang], `${lang}.${key}`);
    assert.equal(typeof I18N.mn[key], typeof I18N.en[key], key);
  }
});

/* ══════════════════════════════════════════
   Knocks
══════════════════════════════════════════ */

const timers = () => new Promise(r => setTimeout(r, 5));

test("an address is believed only in the shape a browser gives one", () => {
  const keys = pushKeys();
  const ok = { endpoint: "https://fcm.googleapis.com/fcm/send/x", ...keys };
  assert.equal(G.knockAddressValid(ok), true);
  for (const bad of [
    { ...ok, endpoint: "fcm.googleapis.com/x" }, { ...ok, endpoint: "javascript:alert(1)//x" }, { ...ok, endpoint: "https://a b/x" },
    { ...ok, endpoint: `https://x.y/${"z".repeat(1100)}` }, { ...ok, p256dh: keys.p256dh.slice(1) }, { ...ok, p256dh: `A${keys.p256dh.slice(1)}` },
    { ...ok, auth: `${keys.auth}x` }, { ...ok, auth: 7 }, { endpoint: ok.endpoint }, null, "x"
  ]) assert.equal(G.knockAddressValid(bad), false, JSON.stringify(bad));
});

test("a person keeps a good address, and loses a bad one — not themselves", async () => {
  const anu = await person("Anu");
  const knock = { endpoint: "https://fcm.googleapis.com/fcm/send/x", ...pushKeys() };
  assert.deepEqual(G.savedPeople({ v: 1, people: [{ ...anu, knock }] }), [{ ...anu, knock }]);
  assert.deepEqual(G.savedPeople({ v: 1, people: [{ ...anu, knock: { ...knock, auth: "x" } }] }), [anu]);
  assert.deepEqual(G.savedPeople({ v: 1, people: [{ ...anu, knock: { ...knock, extra: "kept?" } }] })[0].knock, knock, "only the three parts");
});

test("the alerts switch: only where it can work, and saying how where it cannot yet", () => {
  const base = { serverKey: true, supported: true, appleTouch: false, standalone: false, permission: "default", subscribed: false };
  assert.equal(G.knockState(base), "off");
  assert.equal(G.knockState({ ...base, permission: "granted", subscribed: true }), "on");
  assert.equal(G.knockState({ ...base, permission: "granted" }), "off", "allowed, but no subscription yet");
  assert.equal(G.knockState({ ...base, subscribed: true }), "off", "subscribed, but not allowed to show it");
  assert.equal(G.knockState({ ...base, permission: "denied", subscribed: true }), "blocked");
  assert.equal(G.knockState({ ...base, serverKey: false, permission: "granted", subscribed: true }), "hidden", "the server sends none");
  assert.equal(G.knockState({ ...base, supported: false }), "hidden", "a browser that cannot be woken");
  assert.equal(G.knockState({ ...base, supported: false, appleTouch: true }), "install", "an iPhone in Safari: the Home Screen first");
  assert.equal(G.knockState({ ...base, supported: false, appleTouch: true, standalone: true }), "hidden");
  assert.equal(G.knockState(null), "hidden");
});

test("no knocks from the server, or a browser without push: no switch", async () => {
  for (const knock of [{ serverKey: false }, { supported: false }]) {
    const p = page({ saved: [await person("Anu")], knock });
    assert.ok(p.els.knockBtn.classList.contains("hidden"), JSON.stringify(knock));
  }
  const iphone = page({ saved: [await person("Anu")], knock: { supported: false, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" } });
  assert.equal(iphone.els.knockBtn.dataset.state, "install");
  assert.equal(iphone.els.knockLabel.textContent, I18N.mn.knockInstall);
  iphone.els.knockBtn.onclick();
  assert.ok(!iphone.els.installOverlay.classList.contains("hidden"), "the Home Screen steps");
});

test("turning alerts on: asked inside the tap, the worker registered for this build, subscribed for the server's key", async () => {
  const p = page({ saved: [await person("Anu")] });
  assert.equal(p.els.knockBtn.dataset.state, "off");
  assert.equal(p.els.knockLabel.textContent, I18N.mn.knockOff);
  assert.equal(p.els.knockBtn.title, I18N.mn.knockHint);
  p.els.knockBtn.onclick();
  assert.equal(p.log.asked, 1, "the question is asked in the tap itself");
  await timers();
  assert.deepEqual(p.log.registered, [{ url: "sw.js?v=202610290000-abcdef12", opts: { updateViaCache: "none" } }]);
  assert.deepEqual(p.log.subscribed, [{ userVisibleOnly: true, key: SERVER_KNOCK_KEY }]);
  assert.equal(p.els.knockBtn.dataset.state, "on");
  assert.equal(p.els.knockBtn.attrs["aria-pressed"], "true");
  assert.equal(p.els.knockLabel.textContent, I18N.mn.knockOn);
  assert.deepEqual(p.log.toasts, [I18N.mn.knockOnDone]);
});

test("refused: said where to allow it, and the switch says blocked; a tap then only says so again", async () => {
  const p = page({ saved: [await person("Anu")], knock: { answer: "denied" } });
  await p.api.knocksOn();
  assert.deepEqual(p.log.subscribed, []);
  assert.equal(p.els.knockBtn.dataset.state, "blocked");
  assert.deepEqual(p.log.toasts, [I18N.mn.knockBlockedHint]);
  p.els.knockBtn.onclick();
  assert.equal(p.log.asked, 1, "not asked again — the browser would not show it");
  const later = page({ saved: [await person("Anu")], knock: { answer: "default" } });
  await later.api.knocksOn();
  assert.equal(later.els.knockBtn.dataset.state, "off", "dismissed: still off, nothing said");
  assert.deepEqual(later.log.toasts, []);
});

test("turning alerts off unsubscribes", async () => {
  const p = page({ saved: [await person("Anu")] });
  await p.api.knocksOn();
  p.log.toasts.length = 0;
  p.els.knockBtn.onclick();
  await timers();
  assert.equal(p.log.unsubscribed, 1);
  assert.equal(p.els.knockBtn.dataset.state, "off");
  assert.deepEqual(p.log.toasts, [I18N.mn.knockOffDone]);
});

test("the worker's copy: each person's room and name and the language — no secrets — and only while alerts are on", async () => {
  const anu = await person("Anu", "a"), bat = await person("Bat", "b");
  const p = page({ saved: [anu, bat] });
  await timers();
  assert.equal(p.idb.size, 0, "nothing kept for a worker that is not there");
  await p.api.knocksOn();
  await timers();
  assert.deepEqual(p.idb.get("people"), { lang: "mn", names: [[anu.room, "Anu"], [bat.room, "Bat"]] });
  assert.ok(!JSON.stringify([...p.idb]).includes(anu.secret));
  p.api.renamePerson(anu);
  p.type("Anu (phone)");
  p.api.confirmSaveDialog();
  await timers();
  assert.equal(p.idb.get("people").names[0][1], "Anu (phone)", "kept up to date");
});

test("alerts on at an earlier visit: taken up again — and made afresh if the server's key changed", async () => {
  const same = page({ saved: [await person("Anu")], knock: { keyLater: true, registered: true, subscribed: true, permission: "granted" } });
  await same.api.knockKeyArrived(SERVER_KNOCK_KEY);
  assert.equal(same.els.knockBtn.dataset.state, "on");
  assert.equal(same.log.unsubscribed, 0);
  assert.equal(same.log.registered.length, 1, "the worker brought to this build");

  const changed = page({ saved: [await person("Anu")], knock: { keyLater: true, registered: true, subscribed: true, permission: "granted",
                                                                  subscribedKey: pushKeys().p256dh } });
  await changed.api.knockKeyArrived(SERVER_KNOCK_KEY);
  assert.equal(changed.log.unsubscribed, 1);
  assert.deepEqual(changed.log.subscribed, [{ userVisibleOnly: true, key: SERVER_KNOCK_KEY }]);
  assert.equal(changed.els.knockBtn.dataset.state, "on");

  const never = page({ saved: [await person("Anu")], knock: { keyLater: true } });
  await never.api.knockKeyArrived(SERVER_KNOCK_KEY);
  assert.deepEqual(never.log.registered, [], "nothing registered for someone who never turned alerts on");
  assert.equal(never.els.knockBtn.dataset.state, "off");
});

test("in a saved person's chat, each side says where to knock for it — once a channel — or that alerts are off", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], kind: "saved", inChat: true });
  p.api.set({ meeting: anu });
  p.api.shareKnockAddress();
  p.api.shareKnockAddress();
  await settle();
  assert.deepEqual(p.log.sealed, [{ type: "knock-address", off: true }]);
  const on = page({ saved: [anu], kind: "saved", inChat: true });
  on.api.set({ meeting: anu });
  await on.api.knocksOn();
  on.log.sealed.length = 0;
  on.api.set({ knockShared: false });
  on.api.shareKnockAddress();
  await settle();
  const sent = on.log.sealed[0];
  assert.equal(sent.type, "knock-address");
  assert.ok(G.knockAddressValid(sent), "the subscription's endpoint and keys");
  const normal = page({ saved: [anu], inChat: true });
  normal.api.shareKnockAddress();
  await settle();
  assert.deepEqual(normal.log.sealed, [], "not in any other room");
});

test("forgotten with alerts on: the address made afresh and the old one ended, so they can no longer knock", async () => {
  /* Found in a security assessment: forgetting took them off this device and
     nothing more — they still held where to knock for it. */
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  await p.api.knocksOn();
  const old = p.api.get().knockSub.endpoint;
  p.log.toasts.length = 0;
  p.api.askForget(anu);
  p.rows()[0].children.find(c => c.textContent === I18N.mn.forgetYes).click();
  await timers();
  assert.equal(p.log.unsubscribed, 1, "the address they hold is ended: the push service now calls it gone");
  assert.equal(p.log.subscribed.length, 2, "and a new one made, for the same server key");
  assert.equal(p.log.subscribed[1].key, SERVER_KNOCK_KEY);
  assert.notEqual(p.api.get().knockSub.endpoint, old);
  assert.equal(p.els.knockBtn.dataset.state, "on", "alerts stay on");
  assert.deepEqual(p.log.toasts, [I18N.mn.forgetRenewed("Anu")], "said, with what it costs the others");
  assert.deepEqual(p.idb.get("people").names, [[bat.room, "Bat"]], "and the worker no longer names them");
});

test("forgotten, the others still saved learn the new address the next time they connect", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat], kind: "saved", inChat: true });
  await p.api.knocksOn();
  p.api.forgetPerson(anu);
  await timers();
  const fresh = p.api.get().knockSub.endpoint;
  p.api.set({ meeting: p.api.get().people[0] });
  p.api.shareKnockAddress();
  await settle();
  assert.equal(p.log.sealed.at(-1).endpoint, fresh);
});

test("forgotten with alerts off: nothing to take back, nothing made, nothing said", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  p.api.forgetPerson(anu);
  await timers();
  assert.equal(p.log.unsubscribed, 0);
  assert.deepEqual(p.log.subscribed, []);
  assert.deepEqual(p.log.toasts, []);
});

test("the new address cannot be made: the old one is still ended, and alerts are said to be off", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  await p.api.knocksOn();
  const reg = await p.push.navigator.serviceWorker.ready;
  reg.pushManager.subscribe = async () => { throw new Error("offline"); };
  p.log.toasts.length = 0;
  p.api.forgetPerson(anu);
  await timers();
  assert.equal(p.log.unsubscribed, 1, "what they hold is ended regardless");
  assert.equal(p.api.get().knockSub, null);
  assert.equal(p.els.knockBtn.dataset.state, "off", "so the switch can turn them on again");
  assert.deepEqual(p.log.toasts, [I18N.mn.knockFailed]);
});

test("turned on or off mid-chat with a saved person: they are told at once", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], kind: "saved", inChat: true });
  p.api.set({ meeting: anu });
  await p.api.knocksOn();
  await settle();
  assert.equal(p.log.sealed.at(-1).type, "knock-address");
  assert.ok(p.log.sealed.at(-1).endpoint);
  await p.api.knocksOff();
  await settle();
  assert.deepEqual(p.log.sealed.at(-1), { type: "knock-address", off: true });
});

test("their address is kept with them, and the bell shows by their name; off forgets it; a bad one changes nothing", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], kind: "saved" });
  p.api.set({ meeting: anu });
  const address = { endpoint: "https://web.push.apple.com/QGu", ...pushKeys() };
  p.api.receiveKnockAddress({ type: "knock-address", ...address });
  assert.deepEqual(p.stored().people[0].knock, address);
  assert.deepEqual(p.api.get().meeting.knock, address, "the person being met, too");
  const name = p.rows()[0].querySelector(".person-name");
  assert.ok(name.children.some(c => c.classList && c.classList.contains("person-knock")), "a bell by the name");
  p.api.receiveKnockAddress({ type: "knock-address", endpoint: "nope", p256dh: "x", auth: "y" });
  assert.deepEqual(p.stored().people[0].knock, address, "a bad one changes nothing");
  p.api.receiveKnockAddress({ type: "knock-address", off: true });
  assert.equal(p.stored().people[0].knock, undefined);
  assert.ok(!p.rows()[0].querySelector(".person-name").children.some(c => c.classList && c.classList.contains("person-knock")));
});

test("saved just now: their address, come before the save finished here, is kept for them — and ours goes to them", async () => {
  const p = page({ inChat: true });
  const address = { endpoint: "https://fcm.googleapis.com/fcm/send/early", ...pushKeys() };
  p.api.receiveKnockAddress({ type: "knock-address", ...address });          // ahead of their yes being handled
  assert.deepEqual(p.api.get().knockEarly, { type: "knock-address", ...address });
  p.api.startSaveOffer();
  p.type("Anu");
  p.api.confirmSaveDialog();
  await settle();
  p.log.sealed.length = 0;
  await p.api.receiveSaveAccept();
  assert.deepEqual(p.stored().people[0].knock, address);
  assert.deepEqual(p.log.sealed, [{ type: "knock-address", off: true }], "and they learn ours");
});

test("first in their room, and they get alerts: a knock with their address — and none for someone without", async () => {
  const knock = { endpoint: "https://fcm.googleapis.com/fcm/send/x", ...pushKeys() };
  const anu = { ...await person("Anu"), knock };
  const p = page({ saved: [anu] });
  p.api.meetPerson(p.api.get().people[0]);
  p.api.meetWaiting({ sessionId: anu.room, hostKey: "k".repeat(32) });
  assert.deepEqual(p.log.ws.at(-1), { type: "knock", sessionId: anu.room, to: knock });
  assert.ok(!JSON.stringify(p.log.ws).includes(anu.secret), "nothing of the secret");
  p.api.knockAnswered({ type: "knock-result", sessionId: anu.room, ok: true, gone: false });
  assert.ok(p.rows()[0].textContent.includes(I18N.mn.personKnocked));

  const bat = await person("Bat");
  const q = page({ saved: [bat] });
  q.api.meetPerson(bat);
  q.api.meetWaiting({ sessionId: bat.room, hostKey: "k".repeat(32) });
  assert.deepEqual(q.log.ws.map(m => m.type), ["meet-session"]);
});

test("an address the push service says is gone is forgotten; another room's answer changes nothing", async () => {
  const knock = { endpoint: "https://fcm.googleapis.com/fcm/send/x", ...pushKeys() };
  const anu = { ...await person("Anu"), knock };
  const p = page({ saved: [anu] });
  p.api.meetPerson(p.api.get().people[0]);
  p.api.meetWaiting({ sessionId: anu.room, hostKey: "k".repeat(32) });
  p.api.knockAnswered({ sessionId: "~other", ok: false, gone: true });
  assert.deepEqual(p.stored().people[0].knock, knock);
  p.api.knockAnswered({ sessionId: anu.room, ok: false, gone: true });
  assert.equal(p.stored().people[0].knock, undefined);
  assert.ok(p.rows()[0].textContent.includes(I18N.mn.personWaiting), "still waiting, not knocked");
});

test("opened by tapping a knock: the address tidied, and them met at once", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], knock: { hash: `#knock=${anu.room}` } });
  assert.deepEqual(p.log.replaced, ["/direct-connection/"]);
  assert.deepEqual(p.log.ws, [{ type: "meet-session", sessionId: anu.room, side: "a" }]);
  assert.deepEqual(p.log.tabs, ["rooms"]);
  const stranger = page({ saved: [anu], knock: { hash: `#knock=~${"z".repeat(43)}` } });
  assert.deepEqual(stranger.log.ws, [], "someone not saved here: nothing");
  const bad = page({ saved: [anu], knock: { hash: `#knock=${anu.room}x` } });
  assert.deepEqual(bad.log.replaced, [], "not a room's shape: left alone");
});

test("tapped with the page open: met if it is free; if it is busy, only said", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  p.push.swListeners.message({ data: { type: "knock", room: anu.room } });
  assert.equal(p.log.ws.at(-1).sessionId, anu.room);
  p.push.swListeners.message({ data: { type: "knock", room: bat.room } });
  assert.equal(p.log.ws.length, 1, "already meeting someone: not dropped for another");
  assert.deepEqual(p.log.toasts, [I18N.mn.knockTitle("Bat")]);
  p.push.swListeners.message({ data: { type: "knock", room: anu.room } });
  assert.equal(p.log.toasts.length, 1, "their own knock again: nothing more");
  p.push.swListeners.message({ data: { type: "other", room: bat.room } });
  p.push.swListeners.message({ data: { type: "knock", room: "<b>" } });
  assert.equal(p.log.toasts.length, 1);
  const chatting = page({ saved: [anu], inChat: true });
  chatting.push.swListeners.message({ data: { type: "knock", room: anu.room } });
  assert.deepEqual(chatting.log.ws, []);
  assert.deepEqual(chatting.log.toasts, [I18N.mn.knockTitle("Anu")]);
});
