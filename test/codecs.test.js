/*
  The call's video format: H.264 first, on both sides.

  Reported: a laptop (Edge) calling an iPhone heard it but never saw it,
  while the iPhone saw the laptop. The format is chosen from the list of
  whoever places the call; Chrome and Edge list VP8 first, so the iPhone had
  to send VP8, which it can only do in software, and its picture never
  arrived. An iPhone placing the call lists H.264 first, and phone-to-phone
  calls always worked.

  h264First() and preferCallVideoCodecs() are lifted out of app.js and run
  against stand-in transceivers. Whether an iPhone's picture then reaches
  Edge is checked with the two devices or not at all.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

const grab = (pattern, what) => {
  const m = app.match(pattern);
  assert.ok(m, `${what} not found in app.js`);
  return m[0];
};
const SOURCE = [
  grab(/^function h264First\([^)]*\)\s*\{[\s\S]*?^\}/m,        "h264First"),
  grab(/^function preferCallVideoCodecs\(\)\s*\{[\s\S]*?^\}/m, "preferCallVideoCodecs")
].join("\n");

/* What Chrome and Edge report they can receive, in their own order. */
const CHROME = [
  { mimeType: "video/VP8" }, { mimeType: "video/rtx" },
  { mimeType: "video/VP9", sdpFmtpLine: "profile-id=0" },
  { mimeType: "video/H264", sdpFmtpLine: "profile-level-id=42001f;packetization-mode=1" },
  { mimeType: "video/H264", sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1" },
  { mimeType: "video/AV1" }, { mimeType: "video/red" }, { mimeType: "video/ulpfec" }
];

function run({ codecs = CHROME, hasApi = true, refuse = false, stopped = false } = {}) {
  const set = [];
  const transceiver = (kind, extra = {}) => ({
    receiver: { track: { kind } }, stopped: false,
    setCodecPreferences(list) { if (refuse) throw new Error("InvalidModificationError"); set.push([kind, list]); },
    ...extra
  });
  const callPc = { getTransceivers: () => [transceiver("audio"), transceiver("video", { stopped })] };
  const RTCRtpReceiver = hasApi ? { getCapabilities: kind => (kind === "video" ? { codecs } : null) } : undefined;
  const api = new Function("callPc", "RTCRtpReceiver", `${SOURCE}\nreturn { h264First, preferCallVideoCodecs };`)(callPc, RTCRtpReceiver);
  return { ...api, set };
}

test("H.264 goes to the top; everything else keeps its place", () => {
  const { h264First } = run();
  const ordered = h264First(CHROME);
  assert.deepEqual(ordered.map(c => c.mimeType), [
    "video/H264", "video/H264", "video/VP8", "video/rtx", "video/VP9", "video/AV1", "video/red", "video/ulpfec"
  ]);
  assert.deepEqual(ordered.slice(0, 2).map(c => c.sdpFmtpLine), [CHROME[3].sdpFmtpLine, CHROME[4].sdpFmtpLine],
    "the H.264 profiles keep the browser's own order among themselves");
  assert.equal(ordered.length, CHROME.length, "nothing dropped: the rest is the fallback");
});

test("a browser without H.264 keeps its list as it was", () => {
  const { h264First } = run();
  const noH264 = CHROME.filter(c => c.mimeType !== "video/H264");
  assert.deepEqual(h264First(noH264), noH264);
});

test("the browser's own list is not changed in place", () => {
  const { h264First } = run();
  const copy = CHROME.slice();
  h264First(CHROME);
  assert.deepEqual(CHROME, copy);
});

test("the call's video is given the H.264-first list; its sound is left alone", () => {
  const r = run();
  r.preferCallVideoCodecs();
  assert.equal(r.set.length, 1);
  assert.equal(r.set[0][0], "video");
  assert.equal(r.set[0][1][0].mimeType, "video/H264");
});

test("a browser that refuses the preference, or has no way to take one, is left to its own order", () => {
  assert.doesNotThrow(() => run({ refuse: true }).preferCallVideoCodecs(), "a refusal is not a failed call");
  assert.doesNotThrow(() => run({ hasApi: false }).preferCallVideoCodecs());
  assert.equal(run({ codecs: [] }).set.length, 0);
});

test("a stopped transceiver is not touched", () => {
  const r = run({ stopped: true });
  r.preferCallVideoCodecs();
  assert.equal(r.set.length, 0);
});

test("both sides set it once their camera is in, before the offer and before the answer", () => {
  for (const [name, next] of [["initiateCallOffer", "createOffer()"], ["handleIncomingCallOffer", "createAnswer()"]]) {
    const body = grab(new RegExp(`^async function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"), name);
    const prefer = body.indexOf("preferCallVideoCodecs()");
    assert.ok(prefer > body.indexOf("attachCallMedia("), `${name}: after the camera is in its transceiver`);
    assert.ok(prefer < body.indexOf(next), `${name}: before ${next}, where the list is written`);
  }
});
