/*
  The chat during a call — actually run.

  A call covered the whole chat: nothing could be read, typed or sent, nor a
  file looked at, until it ended. The chat button among the call's controls
  now makes the call small — the other side's picture in the corner for a
  video call, a strip for a voice call — with the chat usable underneath. A
  tap on it brings it back; its red button hangs up. While the call fills the
  screen, what arrives in the chat is counted on the chat button.

  The block "The call made small, to use the chat" is lifted out of app.js
  and run against stand-in elements; the markup and the stylesheet are read.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
const app  = read("app.js");
const html = read("index.html");
const css  = read("style.css").replace(/\/\*[\s\S]*?\*\//g, "");
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
   The block, run
══════════════════════════════════════════ */

const BLOCK = between("/* ── The call made small, to use the chat ──", "function tablerIcon(");

function classes(initial = []) {
  const set = new Set(initial);
  return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
           toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
}

function call({ onScreen = true } = {}) {
  const log = { chromeShown: 0, chromeStopped: 0, ended: [] };
  const listeners = {};
  const callOverlay = { classList: classes(onScreen ? [] : ["hidden"]),
                        addEventListener: (type, f) => { listeners[type] = f; } };
  const els = {
    callChatBtn: { onclick: null }, callChatCount: { textContent: "", classList: classes(["hidden"]) },
    callExpandBtn: { onclick: null }, callMiniEndBtn: { onclick: null }
  };
  const api = new Function("document", "callOverlay", "showCallChrome", "stopCallChrome", "endCall", `
    ${BLOCK}
    return { setCallMini, resetCallMini, noteCallChat, mini: () => callMini };`
  )({ getElementById: id => els[id] }, callOverlay,
    () => { log.chromeShown++; }, () => { log.chromeStopped++; }, notify => log.ended.push(notify));
  /* A click as the browser makes one: on the button, then up to the call. */
  const click = target => {
    let stopped = false;
    const e = { stopPropagation: () => { stopped = true; } };
    if (target) els[target].onclick(e);
    if (!stopped && listeners.click) listeners.click(e);
  };
  const count = () => (els.callChatCount.classList.contains("hidden") ? null : els.callChatCount.textContent);
  return { ...api, log, click, count, small: () => callOverlay.classList.contains("mini"), callOverlay };
}

test("the chat button makes the call small, with the chat usable underneath", () => {
  const c = call();
  c.click("callChatBtn");
  assert.equal(c.small(), true, "and stays small — its click does not reach the call and make it big again");
  assert.equal(c.mini(), true);
  assert.equal(c.log.chromeStopped, 1, "nothing to fade in the small call");
});

test("a tap on the small call, or its expand button, brings it back", () => {
  const c = call();
  c.click("callChatBtn");
  c.click(null);                        // the picture itself
  assert.equal(c.small(), false);
  assert.equal(c.log.chromeShown, 1, "with its controls showing");
  c.click("callChatBtn");
  c.click("callExpandBtn");
  assert.equal(c.small(), false);
});

test("a tap on the call at full size does nothing of the kind", () => {
  const c = call();
  c.click(null);
  assert.equal(c.small(), false);
  assert.equal(c.log.chromeShown, 0);
});

test("the small call's red button hangs up, telling the other side — and does not make it big first", () => {
  const c = call();
  c.click("callChatBtn");
  c.click("callMiniEndBtn");
  assert.deepEqual(c.log.ended, [true]);
  assert.equal(c.small(), true, "the end of the call tidies it, not the tap");
});

test("while the call fills the screen, what arrives is counted on the chat button, and shown", () => {
  const c = call();
  c.noteCallChat();
  assert.equal(c.count(), "1");
  assert.equal(c.log.chromeShown, 1, "faded controls come back, so the count is seen");
  for (let i = 0; i < 11; i++) c.noteCallChat();
  assert.equal(c.count(), "9+");
});

test("opening the chat clears the count; while it is open, nothing is counted", () => {
  const c = call();
  c.noteCallChat(); c.noteCallChat();
  c.click("callChatBtn");
  assert.equal(c.count(), null);
  c.noteCallChat();
  assert.equal(c.count(), null, "it is in view");
  c.click(null);
  c.noteCallChat();
  assert.equal(c.count(), "1", "full size again: counting again");
});

test("with no call on screen, nothing is counted", () => {
  const c = call({ onScreen: false });
  c.noteCallChat();
  assert.equal(c.count(), null);
});

test("the next call starts full size, with nothing counted", () => {
  const c = call();
  c.noteCallChat();
  c.click("callChatBtn");
  c.noteCallChat();
  c.resetCallMini();
  assert.equal(c.small(), false);
  assert.equal(c.mini(), false);
  assert.equal(c.count(), null);
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

test("ending a call puts it back to full size; the small call never fades; arrivals are told to it first", () => {
  const stop = fn("stopCallMedia");
  assert.match(stop, /if \(clearOverlay\) \{[\s\S]*resetCallMini\(\);[\s\S]*\}/);
  assert.match(fn("hideCallChrome"), /if \(callMini\) return;/);
  assert.match(fn("noticeArrival"), /^function noticeArrival\(\) \{\n\s*noteCallChat\(\);/,
    "before the looked-at check: someone looking at the call is not looking at the chat");
});

test("the chat button is among the call's controls, before hanging up; the small call has its own two", () => {
  const controls = html.match(/<div class="call-controls">([\s\S]*?)\n      <\/div>/);
  assert.ok(controls, "call controls not found");
  const chat = controls[1].indexOf('id="callChatBtn"'), end = controls[1].indexOf('id="endCallBtn"');
  assert.ok(chat > -1 && end > chat);
  assert.match(controls[1], /<button id="callChatBtn" class="call-btn" type="button" data-i18n-aria="callShowChat"/);
  assert.match(controls[1], /<span id="callChatCount" class="call-chat-count hidden"><\/span>/);
  const bar = html.match(/<div class="call-mini-bar">([\s\S]*?)<\/div>/);
  assert.ok(bar, "the small call's bar not found");
  assert.match(bar[1], /id="callExpandBtn"[^>]*data-i18n-aria="callBackToCall"/);
  assert.match(bar[1], /id="callMiniEndBtn" class="call-mini-btn end-call"[^>]*data-i18n-aria="callEnd"/);
  assert.ok(html.indexOf('<div class="call-mini-bar">') > html.indexOf('id="callOverlay"') &&
            html.indexOf('<div class="call-mini-bar">') < html.indexOf('<header class="chat-header">'), "inside the call");
});

/* ══════════════════════════════════════════
   How it looks
══════════════════════════════════════════ */

const rule = selector => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `${selector} not found in style.css`);
  return m[1];
};

test("small, the call is a picture in the corner under the header, not the whole screen", () => {
  const mini = rule(".call-overlay.mini");
  assert.match(mini, /inset:\s*auto;/);
  const top = mini.match(/top:\s*calc\((\d+)px \+ var\(--safe-top\)\)/);
  assert.ok(top && Number(top[1]) >= 80, "below the header and the figures under it, so their buttons stay usable");
  assert.match(mini, /width:\s*clamp\(/);
});

test("small, only the picture (or who it is) and the two buttons show", () => {
  const hidden = css.match(/((?:\.call-overlay\.mini [^,{]+,\s*)+\.call-overlay\.mini [^{]+)\{\s*display:\s*none;\s*\}/);
  assert.ok(hidden, "the rule hiding the rest not found");
  for (const part of ["#localVideo", ".call-status-label", ".call-stats", ".call-pause-note", ".call-controls"]) {
    assert.ok(hidden[1].includes(part), `${part} still shows in the small call`);
  }
  assert.ok(!hidden[1].includes("#remoteVideo"), "the other side's picture stays — and with it the sound");
  assert.match(rule(".call-mini-bar"), /display:\s*none;/, "the two buttons only in the small call");
  assert.match(rule(".call-overlay.mini .call-mini-bar"), /display:\s*flex;/);
});

test("six call buttons fit across a phone", () => {
  /* An iPhone in a video call: mute, camera, flip, loudspeaker, chat, end. */
  const fits = (media, screen) => {
    const block = css.match(new RegExp(`@media \\(max-width: ${media}px\\) \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(block, `${media}px media query not found`);
    const size = Number(block[1].match(/\.call-btn \{ width: (\d+)px;/)[1]);
    const gap  = Number(block[1].match(/\.call-controls \{ gap: (\d+)px;/)[1]);
    const row = 6 * size + 5 * gap;
    assert.ok(row <= screen - 16, `${row}px of buttons on a ${screen}px screen`);
    assert.ok(size >= 44, "still big enough to hit");
  };
  fits(480, 375);
  fits(360, 320);
});
