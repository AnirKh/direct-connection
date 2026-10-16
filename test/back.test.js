/*
  The phone's Back button during a chat — actually run.

  To a phone, Back means "leave this page", so it closed the page and the chat
  with it, for both people, mid-sentence. While a chat is on screen the page
  now holds one history entry of its own: Back lands on this page instead of
  leaving it, and asks "Leave the chat?". Closing the tab asks first too.

  The rule is G.backPress. The block in app.js from "The phone's Back button"
  to the connection watch is lifted out and run against a stand-in history,
  window and page — the real listeners are the ones exercised.
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

/* ══════════════════════════════════════════
   The rule
══════════════════════════════════════════ */

test("Back during a chat that is on asks; during the question it answers stay", () => {
  assert.equal(G.backPress({ chatOpen: true, chatEnded: false, asking: false }), "ask");
  assert.equal(G.backPress({ chatOpen: true, chatEnded: false, asking: true }), "stay");
});

test("Back after a chat has ended just goes to the lobby; with no chat it is ordinary navigation", () => {
  assert.equal(G.backPress({ chatOpen: true, chatEnded: true, asking: false }), "lobby");
  assert.equal(G.backPress({ chatOpen: false, chatEnded: false, asking: false }), "ignore");
  assert.equal(G.backPress({ chatOpen: "yes" }), "ignore");
  assert.equal(G.backPress(undefined), "ignore");
});

test("a chat is live while it shows and has not ended", () => {
  assert.equal(G.chatIsLive({ chatOpen: true, chatEnded: false }), true);
  assert.equal(G.chatIsLive({ chatOpen: true, chatEnded: true }), false);
  assert.equal(G.chatIsLive({ chatOpen: false, chatEnded: false }), false);
  assert.equal(G.chatIsLive(undefined), false);
});

/* ══════════════════════════════════════════
   The block, run
══════════════════════════════════════════ */

const BLOCK = between("/* ── The phone's Back button during a chat ──", "/* ── A connection that never comes up ───");

function classes(initial = []) {
  const set = new Set(initial);
  return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
           toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
}

/** A page with a history of [elsewhere, this page], a chat on screen. */
function phone({ touched = true, activationApi = true } = {}) {
  const entries = [{ state: "elsewhere" }, { state: null }];
  let index = 1;
  const winListeners = {}, docListeners = {};
  const log = { left: 0, pushed: 0, wentBack: 0, leftPage: false };
  const history = {
    get state() { return entries[index].state; },
    pushState(state) { entries.splice(index + 1); entries.push({ state }); index++; log.pushed++; },
    back() { log.wentBack++; pressBack(); }
  };
  const ended = { value: false };
  const els = {
    leaveChatOverlay: { classList: classes(["hidden"]), onclick: null },
    leaveChatStayBtn: { onclick: null }, leaveChatLeaveBtn: { onclick: null }
  };
  const chatScreen = { classList: classes() };
  const chatMessages = { querySelector: sel => (sel === ".reconnect-sys-wrap" && ended.value ? {} : null) };
  const leaveBtn = { click: () => { log.left++; chatScreen.classList.add("hidden"); api.disarmBackGuard(); } };
  const window = {
    addEventListener: (t, f) => { winListeners[t] = f; },
    removeEventListener: (t, f) => { if (winListeners[t] === f) delete winListeners[t]; }
  };
  const navigator = activationApi ? { userActivation: { get hasBeenActive() { return touched; } } } : {};
  const document = { getElementById: id => els[id], addEventListener: (t, f) => { docListeners[t] = f; } };
  const api = new Function("G", "history", "window", "navigator", "document", "chatScreen", "chatMessages", "leaveBtn",
    `${BLOCK}\nreturn { armBackGuard, disarmBackGuard, warnBeforeUnload, armed: () => backGuardArmed };`
  )(G, history, window, navigator, document, chatScreen, chatMessages, leaveBtn);
  /* The browser's Back: move one entry back, and if it is still this page, tell it. */
  function pressBack() {
    if (index === 0) return;
    index--;
    if (entries[index].state === "elsewhere") { log.leftPage = true; return; }
    winListeners.popstate && winListeners.popstate();
  }
  const enterChat = () => { api.armBackGuard(); window.addEventListener("beforeunload", api.warnBeforeUnload); };
  return { ...api, log, pressBack, enterChat, els, chatScreen, ended, winListeners, docListeners,
           asking: () => !els.leaveChatOverlay.classList.contains("hidden"), entries, index: () => index,
           touch: () => { touched = true; docListeners.pointerdown(); } };
}

test("Back during a chat stays on the page and asks", () => {
  const p = phone();
  p.enterChat();
  p.pressBack();
  assert.equal(p.log.leftPage, false, "the page — and the chat — are still there");
  assert.equal(p.asking(), true);
  assert.equal(p.armed(), true, "held again, for the next Back");
});

test("Back again answers the question: stay", () => {
  const p = phone();
  p.enterChat();
  p.pressBack();
  p.pressBack();
  assert.equal(p.asking(), false);
  assert.equal(p.log.leftPage, false);
  assert.equal(p.log.left, 0, "nobody left the chat");
});

test("Stay keeps the chat; Leave leaves it, and gives the history entry back", () => {
  const p = phone();
  p.enterChat();
  p.pressBack();
  p.els.leaveChatStayBtn.onclick();
  assert.equal(p.asking(), false);
  assert.equal(p.log.left, 0);

  p.pressBack();
  p.els.leaveChatLeaveBtn.onclick();
  assert.equal(p.log.left, 1);
  assert.equal(p.armed(), false);
  assert.notDeepEqual(p.entries[p.index()].state, { dcChat: true }, "Back in the lobby goes where it always did");
  assert.equal(p.log.leftPage, false, "giving the entry back did not go past it");
});

test("a tap outside the question closes it; a tap on it does not", () => {
  const p = phone();
  p.enterChat();
  p.pressBack();
  p.els.leaveChatOverlay.onclick({ target: {} });
  assert.equal(p.asking(), true);
  p.els.leaveChatOverlay.onclick({ target: p.els.leaveChatOverlay });
  assert.equal(p.asking(), false);
});

test("Back after the chat has ended goes to the lobby, without asking", () => {
  const p = phone();
  p.enterChat();
  p.ended.value = true;
  p.pressBack();
  assert.equal(p.asking(), false);
  assert.equal(p.log.left, 1);
  assert.equal(p.log.leftPage, false, "to the lobby, not off the page");
  assert.equal(p.log.wentBack, 0, "the entry Back used is not given back a second time");
});

test("leaving by the arrow gives the entry back; leaving when it is not ours goes nowhere", () => {
  const p = phone();
  p.enterChat();
  p.chatScreen.classList.add("hidden");   // as the Leave handler does, before giving it back
  p.disarmBackGuard();
  assert.equal(p.log.wentBack, 1);
  assert.equal(p.log.leftPage, false);
  p.disarmBackGuard();               // twice: nothing more
  assert.equal(p.log.wentBack, 1);
  assert.equal(p.asking(), false, "the Back it queued found no chat, and asked nothing");
});

test("giving the entry back never goes back past an entry that is not ours", () => {
  /* Should the current entry not be the one we added — something replaced it,
     or the browser moved off it — going back would leave the page. */
  const p = phone();
  p.enterChat();
  p.entries[p.index()].state = null;
  p.chatScreen.classList.add("hidden");
  p.disarmBackGuard();
  assert.equal(p.log.wentBack, 0);
  assert.equal(p.log.leftPage, false);
});

test("a page nobody has touched yet holds no entry — Chrome would skip it — and takes one at the first tap", () => {
  const p = phone({ touched: false });
  p.enterChat();
  assert.equal(p.log.pushed, 0);
  p.touch();
  assert.equal(p.log.pushed, 1);
  p.touch();
  assert.equal(p.log.pushed, 1, "one entry, not one per tap");
});

test("a browser with no way to tell if the page was touched holds the entry at once", () => {
  const p = phone({ touched: false, activationApi: false });
  p.enterChat();
  assert.equal(p.log.pushed, 1);
});

test("closing the page mid-chat asks first; after the chat it does not", () => {
  const p = phone();
  p.enterChat();
  const e = { prevented: false, preventDefault() { this.prevented = true; }, returnValue: undefined };
  p.winListeners.beforeunload(e);
  assert.equal(e.prevented, true);
  assert.equal(e.returnValue, "");

  p.ended.value = true;
  const later = { prevented: false, preventDefault() { this.prevented = true; } };
  p.winListeners.beforeunload(later);
  assert.equal(later.prevented, false, "an ended chat has nothing to lose");
});

test("the close warning is listened for only while in a chat", () => {
  const p = phone();
  p.enterChat();
  assert.ok(p.winListeners.beforeunload);
  p.disarmBackGuard();
  assert.equal(p.winListeners.beforeunload, undefined, "listening for it can keep a browser from caching the page");
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

test("the hold is taken when a chat opens, and given back however it is left — once the chat is off screen", () => {
  const open = fn("switchToChat");
  assert.match(open, /armBackGuard\(\);/);
  assert.match(open, /window\.addEventListener\("beforeunload", warnBeforeUnload\);/);
  /* Giving the entry back queues a Back. Should it land while the chat still
     showed, it would ask "Leave the chat?" of someone who already left. */
  const leave = between("leaveBtn.onclick = () => {", "showLobbyTab(");
  const hide = 'chatScreen.classList.add("hidden")';
  assert.ok(leave.includes("disarmBackGuard()"), "Leave gives the entry back");
  assert.ok(leave.indexOf(hide) < leave.indexOf("disarmBackGuard()"), "Leave: chat hidden first");
  const wait = fn("returnToWaitingRoom");
  const afterHide = wait.slice(wait.indexOf(hide));
  assert.ok(afterHide.includes("disarmBackGuard()"), "back to waiting: given back once the chat is hidden");
  assert.match(wait, /if \(alreadyWaiting && !noteKey\) \{ disarmBackGuard\(\); return; \}/);
});
