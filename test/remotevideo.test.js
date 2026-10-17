/*
  The other person's picture in a call, actually run.

  The bug: on an iPhone, sometimes, the other person's picture stayed black
  while their voice came through and they could see you. The call worked; the
  picture was never drawn.

  The cause: the <video> was handed an empty stream when the call began, and
  the other side's tracks were added to that stream as they arrived. Safari —
  the engine of every browser on an iPhone — keeps playing the sound of such a
  stream but may never draw a video track added after it was attached. Whether
  it did depended on timing, hence "sometimes".

  The fix: the picture is never given a stream to grow. Each time a track
  arrives it gets a fresh stream holding every track so far; and if frames
  start arriving while the picture is still blank, it is handed over again.

  Nothing here can run Safari, so this cannot prove the picture on a phone.
  What it does prove is the order of events the fix depends on: the real
  createCallPeerConnection(), showRemoteTracks() and playRemoteCallMedia() are
  lifted out of app.js and run against a stand-in <video> and connection.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

const grab = name => {
  const m = app.match(new RegExp(`^function ${name}\\(\\)\\s*\\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} not found as a top-level function in app.js`);
  return m[0];
};
const SOURCE = ["createCallPeerConnection", "closeCallPeerConnection", "showRemoteTracks", "playRemoteCallMedia"]
  .map(grab).join("\n");

class MediaStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  addTrack(track) { this.tracks.push(track); }
}

/** Starts a call's connection with the real code and hands back the controls. */
function call({ inCall = true } = {}) {
  const video = {
    srcObject: "left over from the last call", videoWidth: 0, plays: 0, attached: [],
    play() { this.plays++; return Promise.resolve(); }
  };
  /* Record every stream the picture is given, in order. */
  let current = video.srcObject;
  Object.defineProperty(video, "srcObject", {
    get: () => current,
    set: value => { current = value; video.attached.push(value); }
  });

  let connection = null;
  class RTCPeerConnection { constructor() { connection = this; } close() {} }

  const run = new Function(
    "MediaStream", "RTCPeerConnection", "remoteVideo", "callStatusLabel", "t",
    "ICE_CONFIG", "currentSession", "dcSendCallSignal", "endCall", "inCall",
    `let callPc = null, remoteCallStream = null;\nconst stopCallRecovery = () => {}, watchCallLink = () => {};\n${SOURCE}\ncreateCallPeerConnection();`
  );
  run(MediaStream, RTCPeerConnection, video, { textContent: "" }, key => key,
      {}, null, () => {}, () => {}, inCall);

  const track = kind => ({ kind, id: `${kind}-1` });
  const arrive = t => connection.ontrack({ track: t });
  return { video, track, arrive };
}

const kinds = stream => stream.getTracks().map(t => t.kind);

test("the picture is not handed an empty stream when a call begins", () => {
  /* The old code attached an empty stream here and grew it — the Safari case. */
  const c = call();
  assert.equal(c.video.srcObject, null, "nothing to show yet, and nothing left over from the last call");
});

test("every track that arrives reaches the picture in a fresh stream", () => {
  const c = call();
  const audio = c.track("audio"), video = c.track("video");
  c.arrive(audio);
  const first = c.video.srcObject;
  assert.deepEqual(kinds(first), ["audio"]);

  c.arrive(video);
  const second = c.video.srcObject;
  assert.notEqual(second, first, "a new stream, not the old one grown");
  assert.deepEqual(kinds(second), ["audio", "video"]);
  assert.deepEqual(kinds(first), ["audio"], "a stream already given to the picture is never added to");
});

test("video arriving before sound works the same", () => {
  const c = call();
  c.arrive(c.track("video"));
  c.arrive(c.track("audio"));
  assert.deepEqual(kinds(c.video.srcObject), ["video", "audio"]);
});

test("a track announced twice is not added twice", () => {
  const c = call();
  const video = c.track("video");
  c.arrive(video);
  c.arrive(video);
  assert.deepEqual(kinds(c.video.srcObject), ["video"]);
});

test("a picture still blank when frames start arriving is handed over again", () => {
  const c = call();
  const video = c.track("video");
  c.arrive(c.track("audio"));
  c.arrive(video);
  const before = c.video.attached.length;
  c.video.videoWidth = 0;
  video.onunmute();
  assert.equal(c.video.attached.length, before + 1, "should be re-attached");
  assert.deepEqual(kinds(c.video.srcObject), ["audio", "video"]);
});

test("a picture already showing is left alone", () => {
  /* Re-attaching restarts the player — a hiccup in the sound for nothing. */
  const c = call();
  const video = c.track("video");
  c.arrive(video);
  const before = c.video.attached.length;
  c.video.videoWidth = 640;
  video.onunmute();
  assert.equal(c.video.attached.length, before);
});

test("sound arriving is never a reason to restart the picture", () => {
  const c = call();
  const audio = c.track("audio");
  c.arrive(audio);
  const before = c.video.attached.length;
  audio.onunmute();
  assert.equal(c.video.attached.length, before);
});

test("tracks that arrive before the call is accepted are held, not played", () => {
  /* The answering side's tracks arrive during setRemoteDescription. */
  const c = call({ inCall: false });
  c.arrive(c.track("audio"));
  assert.equal(c.video.plays, 0);
  assert.equal(c.video._pendingPlay, true);
  assert.deepEqual(kinds(c.video.srcObject), ["audio"], "attached, so it is ready the moment the call is");
});
