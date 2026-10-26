/*
  Reading older messages — actually run.

  Every arrival scrolled the chat to the bottom, even while someone had
  scrolled up to read something earlier: it was pulled away from under them.
  Now the chat stays put while they read, a "↓ New messages" button says
  something came, and it takes them down. Their own messages still go to the
  bottom — they want to see what they sent.

  scrollBottom, its button and the scroll listener are lifted out of app.js
  and run against a stand-in message list; which calls force the way down is
  read from the source.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
const app  = read("app.js");
const html = read("index.html");
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

/** A chat 600px tall holding 2000px of messages, at its newest. */
function chat() {
  let onScroll = null;
  const list = {
    scrollHeight: 2000, clientHeight: 600, scrollTop: 1400,
    addEventListener: (type, f) => { if (type === "scroll") onScroll = f; }
  };
  const button = { classList: classes(["hidden"]), onclick: null };
  const api = new Function("chatMessages", "newMessagesBtn", `
    ${between("let _stickToBottom = true;", "function fitToVisibleArea")}
    ${fn("scrollBottom")}
    newMessagesBtn.onclick = () => scrollBottom(true);
    return { scrollBottom, sticking: () => _stickToBottom };`
  )(list, button);
  const scrollTo = top => { list.scrollTop = top; onScroll(); };
  const arrive = (force = false) => { list.scrollHeight += 100; api.scrollBottom(force); };
  return { ...api, list, button, scrollTo, arrive, shown: () => !button.classList.contains("hidden") };
}

test("at the newest, what arrives is followed down, as before", () => {
  const c = chat();
  c.arrive();
  assert.equal(c.list.scrollTop, c.list.scrollHeight);
  assert.equal(c.shown(), false);
});

test("reading older messages, the chat stays put and says something came — it used to pull them down", () => {
  const c = chat();
  c.scrollTo(300);                      // up, reading
  assert.equal(c.sticking(), false);
  c.arrive();
  c.arrive();
  assert.equal(c.list.scrollTop, 300, "not moved");
  assert.equal(c.shown(), true, "\"↓ New messages\"");
});

test("the button takes them down, and goes", () => {
  const c = chat();
  c.scrollTo(300);
  c.arrive();
  c.button.onclick();
  assert.equal(c.list.scrollTop, c.list.scrollHeight);
  assert.equal(c.shown(), false);
  c.arrive();
  assert.equal(c.list.scrollTop, c.list.scrollHeight, "and the next one is followed again");
});

test("scrolling down to the newest by hand puts the button away too", () => {
  const c = chat();
  c.scrollTo(300);
  c.arrive();
  c.scrollTo(c.list.scrollHeight - c.list.clientHeight - 10);   // within a finger of the bottom
  assert.equal(c.shown(), false);
  assert.equal(c.sticking(), true);
});

test("what you send yourself always goes to the bottom, so you see it", () => {
  const c = chat();
  c.scrollTo(300);
  c.arrive(true);
  assert.equal(c.list.scrollTop, c.list.scrollHeight);
  assert.equal(c.shown(), false);
});

test("which arrivals force the way down: your own bubbles, never theirs", () => {
  for (const name of ["appendBubble", "resolveImageNow", "resolveVoiceNow", "appendFileBubble"]) {
    assert.match(fn(name), /scrollBottom\(who === "me"\);/, `${name}: yours to the bottom, theirs left to the reader`);
  }
  for (const name of ["appendSys", "appendImagePlaceholder", "appendVoicePlaceholder", "resolveImagePlaceholder", "resolveVoicePlaceholder"]) {
    assert.ok(!/scrollBottom\(true\)/.test(fn(name)), `${name} never pulls a reader down`);
  }
});

test("a new chat starts at its newest, with nothing waiting", () => {
  assert.match(fn("switchToChat"), /chatMessages\.replaceChildren\(\);\s*\n\s*_stickToBottom = true;[^\n]*\n\s*newMessagesBtn\.classList\.add\("hidden"\);/);
});

test("the button is on the chat screen, hidden until needed, in both languages", () => {
  assert.match(html, /<button id="newMessagesBtn" class="new-messages-btn hidden" type="button">[\s\S]*?data-i18n="newMessages"/);
  const chatScreen = html.indexOf('<div id="chatScreen"'), btn = html.indexOf('id="newMessagesBtn"');
  assert.ok(btn > chatScreen, "inside the chat screen");
  for (const lang of ["mn", "en"]) assert.equal(typeof I18N[lang].newMessages, "string");
  /* Declared with the page's other elements: fitToVisibleArea calls
     scrollBottom while the page is still loading. */
  assert.ok(app.indexOf('const newMessagesBtn   = document.getElementById("newMessagesBtn")') < app.indexOf("fitToVisibleArea();"));
});
