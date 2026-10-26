/*
  The last English, in the user's language.

  - The server's refusals — a room name taken or not allowed, too many rooms,
    a message it would not send — were shown as it wrote them, in English, to
    Mongolian readers too; and one passed on whatever the mail service said,
    as "detail". The server now says why with a code, and the page says it.
  - Nine of the chat's icon buttons were named in English only, so a screen
    reader read them in English whatever the page's language.

  The room-refusal case and leaveErrorText are lifted out of app.js and run;
  server.js and index.html are read. The server's answers themselves are
  checked in test/integration/server.test.js.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const G      = require("../guards.js");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
const app    = read("app.js");
const server = read("server.js");
const html   = read("index.html");
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

/* ══════════════════════════════════════════
   A room the server would not make
══════════════════════════════════════════ */

test("each of the server's room refusals has words, in both languages", () => {
  assert.deepEqual(Object.keys(G.SERVER_ERROR_KEYS).sort(), ["invalid-name", "name-taken", "too-many-rooms"]);
  for (const key of Object.values(G.SERVER_ERROR_KEYS)) {
    for (const lang of ["mn", "en"]) assert.equal(typeof I18N[lang][key], "string", `${lang}.${key}`);
  }
  assert.equal(G.serverErrorKey("name-taken"), "roomNameTaken");
  for (const code of [undefined, null, 7, "", "toString", "__proto__", "something-new"]) {
    assert.equal(G.serverErrorKey(code), null, String(code));
  }
});

const ERROR_CASE = between('    case "error": {', '    case "pin-error": {');

function refusal(data, { autoJoin = false, lang = "mn" } = {}) {
  const log = { toasts: [], status: [] };
  new Function("G", "t", "console", "document", "lobbyStatus", "createInfo", "showToast", "autoJoinSettled",
    "setLobbyButtons", "setCreateButtons", "settlePinJoin", "start", `
    let _isAutoJoin = start.autoJoin, isConnecting = true, pendingCreate = {};
    function deliver(data) { switch (data.type) {\n${ERROR_CASE}\n} }
    deliver(start.data);`
  )(G, k => I18N[lang][k], { error() {} }, { createElement: () => ({ style: {}, textContent: "" }) },
    { replaceChildren: el => log.status.push(el.textContent) }, {}, m => log.toasts.push(m), () => {},
    () => {}, () => {}, () => {}, { autoJoin, data });
  return log;
}

test("a room name already taken is said in Mongolian — it was shown in the server's English", () => {
  assert.deepEqual(refusal({ type: "error", code: "name-taken", message: "Session name is already in use" }).toasts,
    [I18N.mn.roomNameTaken]);
  assert.deepEqual(refusal({ type: "error", code: "invalid-name", message: "Invalid session name" }, { lang: "en" }).toasts,
    [I18N.en.roomNameInvalid]);
  assert.deepEqual(refusal({ type: "error", code: "too-many-rooms", message: "x" }).toasts, [I18N.mn.tooManyRooms]);
});

test("on an invite page it is said on the status line, in the same words", () => {
  assert.deepEqual(refusal({ type: "error", code: "name-taken", message: "x" }, { autoJoin: true }).status,
    [`❌ ${I18N.mn.roomNameTaken}`]);
});

test("a refusal with no code, or one this page does not know, is shown as the server wrote it", () => {
  const notice = "Шинэ хувилбар гарлаа — хуудсаа хааж дахин нээнэ үү. · A new version is out";
  assert.deepEqual(refusal({ type: "error", message: notice }).toasts, [notice]);
  assert.deepEqual(refusal({ type: "error", code: "from-the-future", message: "Later" }).toasts, ["Later"]);
});

test("the server names every room refusal it sends — all but the bilingual reload notice", () => {
  const sends = [...server.matchAll(/ws\.send\(JSON\.stringify\(\{ type: "error",([^}]*)\}\)\)/g)].map(m => m[1]);
  assert.ok(sends.length >= 4, `expected the server's error sends, found ${sends.length}`);
  for (const body of sends) {
    if (/message: RELOAD_NOTICE/.test(body)) continue;
    assert.match(body, /code: "[a-z-]+"/, `no code: ${body.trim()}`);
  }
});

/* ══════════════════════════════════════════
   A message the server would not send
══════════════════════════════════════════ */

function leaveSays(json, lang = "mn") {
  return new Function("I18N", "LANG", "t", "leaveAttachMaxMbRounded", `${fn("leaveErrorText")}; return leaveErrorText;`)(
    I18N, lang, k => I18N[lang][k], () => 28)(json);
}

test("why a message was not sent, in the user's language", () => {
  assert.equal(leaveSays({ code: "rate-limited", remaining: 42 }), I18N.mn.emailRateLimited(42));
  assert.equal(leaveSays({ code: "message-too-long", max: 5000 }, "en"), I18N.en.emailTooLong(5000));
  assert.equal(leaveSays({ code: "file-too-large", maxMb: 28 }), I18N.mn.leaveFileTooBig(28));
  assert.equal(leaveSays({ code: "message-required" }), I18N.mn.writeFirst);
  assert.equal(leaveSays({ code: "not-configured" }), I18N.mn.emailUnavailable);
  assert.equal(leaveSays({ code: "send-failed" }), I18N.mn.emailFailed);
  assert.equal(leaveSays({}), I18N.mn.emailFailed, "anything else: that it failed");
  assert.equal(leaveSays(null), I18N.mn.emailFailed);
});

test("nothing the mail service says reaches the page — it used to, as \"detail\"", () => {
  assert.equal(leaveSays({ code: "send-failed", error: "Failed", detail: "API key is invalid (re_abc…)" }), I18N.mn.emailFailed);
  assert.ok(!/detail/.test(server.replace(/\/\*[\s\S]*?\*\//g, "")), "server.js no longer sends a detail");
  assert.ok(!/json\.detail|json\.error/.test(between("leaveSendBtn.onclick = async () => {", "function setLeaveStatus")),
    "the page shows neither the server's English nor any detail");
});

test("every refusal of a message from the server carries a code", () => {
  const answers = server.split("\n").filter(line => /res\.status\(\d+\)\.json\(/.test(line));
  assert.ok(answers.length >= 11, `expected the server's refusals, found ${answers.length}`);
  for (const line of answers) assert.match(line, /code: "[a-z-]+"/, `no code: ${line.trim()}`);
});

test("the words for a refused message are in both languages", () => {
  for (const key of ["emailRateLimited", "emailTooLong", "emailUnavailable", "emailFailed", "leaveFileTooBig", "writeFirst"]) {
    for (const lang of ["mn", "en"]) assert.ok(key in I18N[lang], `${lang}.${key}`);
  }
});

/* ══════════════════════════════════════════
   Buttons a screen reader names
══════════════════════════════════════════ */

test("no button is named in English only — each takes its name from the page's language", () => {
  for (const id of ["toggleMuteBtn", "toggleCamBtn", "endCallBtn", "leaveBtn", "voiceCallBtn", "videoCallBtn",
                    "attachBtn", "voiceRecordBtn", "sendBtn"]) {
    const tag = html.match(new RegExp(`<button id="${id}"[^>]*>`));
    assert.ok(tag, `${id} not found`);
    const key = tag[0].match(/data-i18n-aria="([^"]+)"/);
    assert.ok(key, `${id} is named in one language only`);
    for (const lang of ["mn", "en"]) assert.equal(typeof I18N[lang][key[1]], "string", `${lang}.${key[1]}`);
  }
  const english = [...html.matchAll(/aria-label="([A-Za-z][A-Za-z ]*)"/g)].map(m => m[1]);
  assert.deepEqual(english, [], "an English-only name is left in the page");
});
