/*
  What a video call is receiving and sending — the line under the call's
  status.

  Added to find out why a laptop saw nothing of an iPhone. "Not sent", "not
  arriving" and "arriving but not decoded" all look like the same black
  picture; DCS.callVideoStats reads them apart from the call's own stats. A
  plain Map stands in for the stats report, as in connstats.test.js.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const DCS = require("../connstats.js");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

function report(entries) {
  return new Map(entries.map(e => [e.id, e]));
}
const codecs = [
  { id: "c1", type: "codec", mimeType: "video/H264" },
  { id: "c2", type: "codec", mimeType: "video/VP8" },
  { id: "c3", type: "codec", mimeType: "audio/opus" }
];

test("both ways: format, size, frames a second", () => {
  const v = DCS.callVideoStats(report([...codecs,
    { id: "in",  type: "inbound-rtp",  kind: "video", codecId: "c1", frameWidth: 640, frameHeight: 480, framesPerSecond: 24.4, framesDecoded: 300, bytesReceived: 500000, timestamp: 1000 },
    { id: "out", type: "outbound-rtp", kind: "video", codecId: "c1", frameWidth: 1280, frameHeight: 720, framesPerSecond: 29.6, framesSent: 400, bytesSent: 900000, timestamp: 1000 },
    { id: "a",   type: "inbound-rtp",  kind: "audio", codecId: "c3", bytesReceived: 99999, timestamp: 1000 }
  ]));
  assert.deepEqual(v.in,  { codec: "H264", width: 640,  height: 480, fps: 24, frames: 300, bytes: 500000, kbps: null });
  assert.deepEqual(v.out, { codec: "H264", width: 1280, height: 720, fps: 30, frames: 400, bytes: 900000, kbps: null });
});

test("the rate comes from the change since the last reading", () => {
  const first = DCS.callVideoStats(report([...codecs,
    { id: "in", type: "inbound-rtp", kind: "video", codecId: "c1", bytesReceived: 100000, timestamp: 1000 }]));
  const second = DCS.callVideoStats(report([...codecs,
    { id: "in", type: "inbound-rtp", kind: "video", codecId: "c1", bytesReceived: 350000, timestamp: 3000 }]), first);
  assert.equal(second.in.kbps, 1000, "250 000 bytes in 2 s is 1 000 kb/s");
});

test("arriving but not decoded: bytes come in, no frames, no size", () => {
  /* The case a black picture hides: the video gets there and is never shown. */
  const first = DCS.callVideoStats(report([...codecs,
    { id: "in", type: "inbound-rtp", kind: "video", codecId: "c1", bytesReceived: 0, framesDecoded: 0, timestamp: 1000 }]));
  const v = DCS.callVideoStats(report([...codecs,
    { id: "in", type: "inbound-rtp", kind: "video", codecId: "c1", bytesReceived: 75000, framesDecoded: 0, timestamp: 3000 }]), first);
  assert.deepEqual([v.in.frames, v.in.fps, v.in.width, v.in.kbps], [0, 0, 0, 300]);
});

test("no video arriving at all, or a voice call: that side is null", () => {
  const sendingOnly = DCS.callVideoStats(report([...codecs,
    { id: "out", type: "outbound-rtp", kind: "video", codecId: "c2", bytesSent: 1, timestamp: 1 }]));
  assert.equal(sendingOnly.in, null);
  assert.equal(sendingOnly.out.codec, "VP8");
  const voice = DCS.callVideoStats(report([...codecs,
    { id: "a", type: "inbound-rtp", kind: "audio", bytesReceived: 5, timestamp: 1 }]));
  assert.deepEqual([voice.in, voice.out], [null, null]);
});

test("while a sender is swapped, the one carrying the picture is the one reported", () => {
  const v = DCS.callVideoStats(report([...codecs,
    { id: "old", type: "outbound-rtp", kind: "video", codecId: "c2", bytesSent: 10,    timestamp: 1 },
    { id: "new", type: "outbound-rtp", kind: "video", codecId: "c1", bytesSent: 50000, timestamp: 1 }]));
  assert.equal(v.out.codec, "H264");
});

test("older browsers that say mediaType, not kind, are read too", () => {
  const v = DCS.callVideoStats(report([...codecs,
    { id: "in", type: "inbound-rtp", mediaType: "video", codecId: "c1", bytesReceived: 1, timestamp: 1 }]));
  assert.equal(v.in.codec, "H264");
});

test("nothing to read is not an error", () => {
  assert.deepEqual(DCS.callVideoStats(null), { in: null, out: null, at: 0 });
  assert.deepEqual(DCS.callVideoStats(new Map()), { in: null, out: null, at: 0 });
});

test("a call reads its figures while it lasts, and stops when it ends", () => {
  const fn = name => (app.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m")) || [])[0];
  assert.match(fn("attachCallMedia"), /watchCallStats\(true\);/);
  assert.match(fn("stopCallMedia"), /watchCallStats\(false\);/);
  assert.match(fn("updateCallStats"), /DCS\.callVideoStats\(report, callStatsLast\)/);
});
