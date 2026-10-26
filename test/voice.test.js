/*
  Voice notes every phone can play — actually run.

  An iPhone showed "Error" in place of voice notes. Two reasons:

  - every note was labelled WebM, whatever it was. An iPhone records MP4, and
    picks how to play a sound by its label; and a computer recorded WebM.
    Notes are now recorded in MP4 with AAC wherever the browser can make it —
    an iPhone, Chrome, Edge — and labelled what they really are.
  - a tap with a second tap straight after recorded next to nothing (about a
    hundred bytes), which plays nowhere. A note shorter than a second is now
    not sent, and the sender is told.

  And a note this browser still cannot play becomes a line saying so, with a
  way to save it, instead of a player saying "Error".

  The rules are in guards.js (pickVoiceFormat, voiceType, voiceFileName,
  voiceLongEnough). toggleVoiceRecord, newVoiceRecorder, releaseVoiceCapture
  and voicePlayer are lifted out of app.js and run against a stand-in
  recorder, microphone and clock.
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
const fn = name => {
  const m = app.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} not found as a top-level function in app.js`);
  return m[0];
};

/* ══════════════════════════════════════════
   The rules
══════════════════════════════════════════ */

const supports = (...types) => type => types.includes(type);

test("the format asked for: AAC in MP4 where the browser can make it", () => {
  assert.equal(G.pickVoiceFormat(supports("audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm")), "audio/mp4;codecs=mp4a.40.2", "Chrome, Edge");
  assert.equal(G.pickVoiceFormat(supports("audio/mp4")), "audio/mp4", "an iPhone");
  assert.equal(G.pickVoiceFormat(supports("audio/webm;codecs=opus", "audio/webm")), "audio/webm;codecs=opus", "an older Chrome");
  assert.equal(G.pickVoiceFormat(supports("audio/ogg;codecs=opus")), "audio/ogg;codecs=opus", "Firefox");
  assert.equal(G.pickVoiceFormat(supports()), "", "none of them: the browser chooses");
  assert.equal(G.pickVoiceFormat(undefined), "", "cannot be asked");
  assert.equal(G.pickVoiceFormat(() => { throw new Error("no"); }), "");
  assert.equal(G.VOICE_FORMATS[0], "audio/mp4;codecs=mp4a.40.2");
});

test("a recording is labelled what it really is — never just WebM", () => {
  assert.equal(G.voiceType("audio/mp4", ""), "audio/mp4", "an iPhone");
  assert.equal(G.voiceType("audio/mp4;codecs=mp4a.40.2", "audio/mp4"), "audio/mp4");
  assert.equal(G.voiceType("audio/webm;codecs=opus", ""), "audio/webm");
  assert.equal(G.voiceType("audio/ogg", ""), "audio/ogg");
  assert.equal(G.voiceType("", "audio/mp4"), "audio/mp4", "the recorder says nothing: its data's type");
  assert.equal(G.voiceType("video/mp4", ""), "audio/mp4", "a sound called video is taken at its container");
  assert.equal(G.voiceType("", ""), "audio/webm", "nothing known at all: what it always was");
  assert.equal(G.voiceType("text/html", undefined), "audio/webm", "never anything but a sound");
});

test("its name matches", () => {
  assert.equal(G.voiceFileName("audio/mp4"), "voice.m4a");
  assert.equal(G.voiceFileName("audio/ogg"), "voice.ogg");
  assert.equal(G.voiceFileName("audio/webm"), "voice.webm");
  assert.equal(G.voiceFileName(undefined), "voice.webm");
});

test("a note shorter than a second, or with nothing in it, is not worth sending", () => {
  assert.equal(G.MIN_VOICE_MS, 1000);
  assert.equal(G.voiceLongEnough(1000, 5000), true);
  assert.equal(G.voiceLongEnough(999, 5000), false);
  assert.equal(G.voiceLongEnough(30, 110), false, "the quick double tap");
  assert.equal(G.voiceLongEnough(5000, 0), false, "nothing recorded");
  assert.equal(G.voiceLongEnough(NaN, 5000), false);
  assert.equal(G.voiceLongEnough(5000, undefined), false);
});

test("an MP4 note arriving is shown as a voice note, typed MP4", () => {
  assert.deepEqual(G.presentAs("voice", "audio/mp4"), { kind: "voice", blobType: "audio/mp4" });
});

test("the words are in both languages", () => {
  for (const key of ["voiceTooShort", "voiceCantPlay"]) {
    for (const lang of ["mn", "en"]) assert.equal(typeof I18N[lang][key], "string", `${lang}.${key}`);
  }
});

/* ══════════════════════════════════════════
   Recording, run
══════════════════════════════════════════ */

function classes() {
  const set = new Set();
  return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) };
}

/**
 * A phone or a browser: `supported` is what its recorder says it can make,
 * `ownChoice` what it makes when not told, `refuses` a recorder that says it
 * can and then will not.
 */
function device({ supported = [], ownChoice = "audio/webm;codecs=opus", refuses = false, noAsking = false, bytes = 8000 } = {}) {
  const log = { asked: [], sent: [], toasts: [], sys: [] };
  const clock = { now: 1_000_000 };
  class MediaRecorder {
    constructor(stream, options) {
      log.asked.push(options ? options.mimeType : "(its own choice)");
      if (options && options.mimeType && refuses) throw new Error("NotSupportedError");
      this.mimeType = (options && options.mimeType) || ownChoice;
      this.state = "inactive";
    }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
      this.onstop();
    }
  }
  if (!noAsking) MediaRecorder.isTypeSupported = type => supported.includes(type);
  const env = {
    G, t: k => k, MediaRecorder, Blob, File, console: { warn() {}, error() {} },
    Date: { now: () => clock.now },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    dcReady: () => true, e2eReady: true, currentSession: { sessionId: "voice-room" },
    appendSys: k => log.sys.push(k), showToast: m => log.toasts.push(m),
    sendBinary: (file, kind) => log.sent.push({ name: file.name, type: file.type, size: file.size, kind }),
    voiceRecordBtn: { classList: classes(), title: "" }
  };
  const names = Object.keys(env);
  const api = new Function(...names, `
    let _isRecording = false, mediaRecorder = null, voiceChunks = [], voiceStream = null,
        voiceSession = null, voiceDiscard = false, voiceOpening = false;
    ${["releaseVoiceCapture", "newVoiceRecorder", "toggleVoiceRecord"].map(fn).join("\n")}
    return { press: toggleVoiceRecord };`
  )(...names.map(n => env[n]));
  const speak = async ms => { await api.press(); clock.now += ms; await api.press(); };
  return { ...api, log, speak };
}

test("an iPhone: recorded as MP4 and sent as MP4 — it used to go out called WebM", async () => {
  const d = device({ supported: ["audio/mp4"], ownChoice: "audio/mp4" });
  await d.speak(2000);
  assert.deepEqual(d.log.asked, ["audio/mp4"]);
  assert.deepEqual(d.log.sent, [{ name: "voice.m4a", type: "audio/mp4", size: 8000, kind: "voice" }]);
});

test("Chrome and Edge: asked for AAC in MP4, the one an iPhone plays, and labelled so", async () => {
  const d = device({ supported: ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"] });
  await d.speak(2000);
  assert.deepEqual(d.log.asked, ["audio/mp4;codecs=mp4a.40.2"]);
  assert.equal(d.log.sent[0].type, "audio/mp4");
  assert.equal(d.log.sent[0].name, "voice.m4a");
});

test("Firefox: Ogg, labelled Ogg", async () => {
  const d = device({ supported: ["audio/ogg;codecs=opus"], ownChoice: "audio/ogg" });
  await d.speak(2000);
  assert.equal(d.log.sent[0].type, "audio/ogg");
  assert.equal(d.log.sent[0].name, "voice.ogg");
});

test("a recorder that says it can and then will not: its own choice, labelled what it made", async () => {
  const d = device({ supported: ["audio/mp4"], refuses: true, ownChoice: "audio/webm;codecs=opus" });
  await d.speak(2000);
  assert.deepEqual(d.log.asked, ["audio/mp4", "(its own choice)"]);
  assert.deepEqual(d.log.toasts, [], "no error: it still records");
  assert.equal(d.log.sent[0].type, "audio/webm");
});

test("a browser that cannot be asked records in its own choice", async () => {
  const d = device({ noAsking: true, ownChoice: "audio/mp4" });
  await d.speak(2000);
  assert.deepEqual(d.log.asked, ["(its own choice)"]);
  assert.equal(d.log.sent[0].type, "audio/mp4");
});

test("too short: not sent, and the sender is told — it used to arrive broken on both sides", async () => {
  const d = device({ supported: ["audio/mp4"] });
  await d.speak(30);
  assert.deepEqual(d.log.sent, []);
  assert.deepEqual(d.log.toasts, ["voiceTooShort"]);
  const at = device({ supported: ["audio/mp4"] });
  await at.speak(1000);
  assert.equal(at.log.sent.length, 1, "a second exactly is enough");
});

test("a recording with nothing in it is not sent either", async () => {
  const d = device({ supported: ["audio/mp4"], bytes: 0 });
  await d.speak(3000);
  assert.deepEqual(d.log.sent, []);
  assert.deepEqual(d.log.toasts, ["voiceTooShort"]);
});

/* ══════════════════════════════════════════
   A note this browser cannot play
══════════════════════════════════════════ */

function element(tag) {
  const el = { tag, textContent: "", replacedBy: null, replaceWith(n) { el.replacedBy = n; } };
  return el;
}

test("a note that will not play here says so and can be saved — no bare \"Error\"", () => {
  const player = new Function("document", "t", `${fn("voicePlayer")}; return voicePlayer;`)({ createElement: element }, k => k);
  const audio = player("blob:x/1", "voice.m4a");
  assert.equal(audio.tag, "audio");
  assert.equal(audio.src, "blob:x/1");
  assert.equal(audio.controls, true);
  assert.equal(audio.replacedBy, null, "a note that plays stays a player");
  audio.onerror();
  const link = audio.replacedBy;
  assert.equal(link.tag, "a");
  assert.equal(link.href, "blob:x/1");
  assert.equal(link.download, "voice.m4a");
  assert.equal(link.textContent, "⚠️ voiceCantPlay");
  const unnamed = player("blob:x/2", "");
  unnamed.onerror();
  assert.equal(unnamed.replacedBy.download, "voice", "a note with no name still saves under one");
});

test("both of a note's bubbles use that player, under the note's own name", () => {
  assert.match(fn("resolveVoiceNow"), /voicePlayer\(url, name\)/);
  assert.match(fn("resolveVoicePlaceholder"), /voicePlayer\(url, name\)/);
  assert.match(fn("sendBinary"), /resolveVoiceNow\("me", localUrl, file\.name\)/);
  assert.match(fn("assembleTransfer"), /resolveVoicePlaceholder\(id, url, info\.name\)/);
});
