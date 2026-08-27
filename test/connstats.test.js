/*
  Tests for connstats.js.

  The route the app reported was wrong for a long time: it scanned every
  local-candidate and kept whichever came last, so with more than one route it
  named a candidate that was not carrying traffic. Catching that needed a
  browser and two peers. Here the report is a Map and the answer is asserted.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const S = require("../connstats.js");

/** Builds a report shaped like a real RTCStatsReport. */
function report({ local = "host", remote = "host", withTransport = true, decoys = 0,
                  rtt = 0.042, bytesSent = 900, bytesReceived = 800 } = {}) {
  const m = new Map();
  m.set("L", { id: "L", type: "local-candidate",  candidateType: local,  protocol: "udp" });
  m.set("R", { id: "R", type: "remote-candidate", candidateType: remote, protocol: "udp" });
  m.set("P", { id: "P", type: "candidate-pair", state: "succeeded", nominated: true,
               localCandidateId: "L", remoteCandidateId: "R",
               currentRoundTripTime: rtt, bytesSent, bytesReceived });
  /* Extra succeeded pairs that were not selected — the shape that produced the
     original wrong answer. Added AFTER the real one so a naive "keep the last"
     read picks the wrong one. */
  for (let i = 0; i < decoys; i++) {
    m.set("D" + i, { id: "D" + i, type: "local-candidate", candidateType: "relay", protocol: "tcp" });
    m.set("DP" + i, { id: "DP" + i, type: "candidate-pair", state: "succeeded", nominated: false,
                      localCandidateId: "D" + i, remoteCandidateId: "R" });
  }
  if (withTransport) m.set("T", { id: "T", type: "transport", selectedCandidatePairId: "P" });
  return m;
}

/* ══════════════════════════════════════════
   selectedCandidatePair
══════════════════════════════════════════ */

test("the pair named by the transport is the one chosen", () => {
  assert.equal(S.selectedCandidatePair(report()).id, "P");
});

test("decoy pairs do not win, even though they also succeeded", () => {
  /* The original bug in one line: other candidates exist, and the last one read
     was reported to the user. */
  assert.equal(S.selectedCandidatePair(report({ decoys: 3 })).id, "P");
});

test("without a transport row the nominated pair wins", () => {
  const pair = S.selectedCandidatePair(report({ withTransport: false, decoys: 3 }));
  assert.equal(pair.id, "P", "a nominated pair must beat a merely succeeded one");
});

test("an empty report yields nothing", () => {
  assert.equal(S.selectedCandidatePair(new Map()), null);
});

test("a missing or malformed report does not throw", () => {
  for (const bad of [null, undefined, {}, 42]) {
    assert.equal(S.selectedCandidatePair(bad), null, `failed on ${JSON.stringify(bad)}`);
  }
});

/* ══════════════════════════════════════════
   describePath
══════════════════════════════════════════ */

test("host to host is the local network", () => {
  assert.equal(S.describePath(report({ local: "host", remote: "host" })).kind, "local");
});

test("reflexive addresses mean a direct connection over the internet", () => {
  assert.equal(S.describePath(report({ local: "srflx", remote: "srflx" })).kind, "direct");
  assert.equal(S.describePath(report({ local: "host",  remote: "srflx" })).kind, "direct");
  assert.equal(S.describePath(report({ local: "prflx", remote: "srflx" })).kind, "direct");
});

test("a relay on either side makes the whole path relayed", () => {
  /* One relayed leg is enough for a third party to be carrying the traffic. */
  assert.equal(S.describePath(report({ local: "relay", remote: "srflx" })).kind, "relayed");
  assert.equal(S.describePath(report({ local: "srflx", remote: "relay" })).kind, "relayed");
  assert.equal(S.describePath(report({ local: "relay", remote: "relay" })).kind, "relayed");
});

test("the path is unknown until ICE has chosen", () => {
  assert.equal(S.describePath(new Map()), null);
});

test("a pair pointing at candidates that are not in the report yields nothing", () => {
  const m = new Map();
  m.set("P", { id: "P", type: "candidate-pair", state: "succeeded", nominated: true,
               localCandidateId: "missing", remoteCandidateId: "gone" });
  assert.equal(S.describePath(m), null);
});

/* ══════════════════════════════════════════
   qualityFromRtt
══════════════════════════════════════════ */

test("round-trip time falls into three buckets", () => {
  assert.equal(S.qualityFromRtt(0.010).key, "connected");
  assert.equal(S.qualityFromRtt(0.150).key, "fair");
  assert.equal(S.qualityFromRtt(0.400).key, "poor");
});

test("the bucket boundaries are where they claim to be", () => {
  assert.equal(S.qualityFromRtt(0.079).key, "connected");
  assert.equal(S.qualityFromRtt(0.080).key, "fair");
  assert.equal(S.qualityFromRtt(0.249).key, "fair");
  assert.equal(S.qualityFromRtt(0.250).key, "poor");
});

test("fair and poor share a style, connected does not", () => {
  assert.equal(S.qualityFromRtt(0.010).cls, "connected");
  assert.equal(S.qualityFromRtt(0.150).cls, "poor");
});

test("a missing round-trip time is not a quality reading", () => {
  for (const bad of [undefined, null, NaN, Infinity, -1, "80"]) {
    assert.equal(S.qualityFromRtt(bad), null, `failed on ${String(bad)}`);
  }
});

/* ══════════════════════════════════════════
   trafficTotals
══════════════════════════════════════════ */

test("call traffic is summed across every stream", () => {
  const m = new Map();
  m.set("a", { type: "outbound-rtp", bytesSent: 100 });
  m.set("b", { type: "outbound-rtp", bytesSent: 50 });
  m.set("c", { type: "inbound-rtp",  bytesReceived: 70 });
  assert.deepEqual(S.trafficTotals(m, null), { sent: 150, recv: 70 });
});

test("a text-only session reports the data channel's own totals", () => {
  /* There are no rtp reports without a call, so this displayed nothing at all
     until the candidate pair became the fallback. */
  const pair = { bytesSent: 1500, bytesReceived: 1400 };
  assert.deepEqual(S.trafficTotals(new Map(), pair), { sent: 1500, recv: 1400 });
});

test("call traffic is preferred over the pair totals when present", () => {
  const m = new Map();
  m.set("a", { type: "outbound-rtp", bytesSent: 10 });
  m.set("b", { type: "inbound-rtp",  bytesReceived: 20 });
  assert.deepEqual(S.trafficTotals(m, { bytesSent: 999, bytesReceived: 999 }), { sent: 10, recv: 20 });
});

test("nothing moving reports zero rather than throwing", () => {
  assert.deepEqual(S.trafficTotals(new Map(), null), { sent: 0, recv: 0 });
  assert.deepEqual(S.trafficTotals(null, null), { sent: 0, recv: 0 });
});

/* ══════════════════════════════════════════
   fmtBytes / timeAgo
══════════════════════════════════════════ */

test("byte counts switch unit at the right sizes", () => {
  assert.equal(S.fmtBytes(0), "0B");
  assert.equal(S.fmtBytes(1023), "1023B");
  assert.equal(S.fmtBytes(1024), "1.0KB");
  assert.equal(S.fmtBytes(1048575), "1024.0KB");
  assert.equal(S.fmtBytes(1048576), "1.0MB");
  assert.equal(S.fmtBytes(3145728), "3.0MB");
});

test("a nonsense byte count does not produce nonsense text", () => {
  for (const bad of [undefined, null, NaN, -5, "100"]) {
    assert.equal(S.fmtBytes(bad), "0B", `failed on ${String(bad)}`);
  }
});

test("age is reported in the largest unit that fits", () => {
  const now = 1_000_000_000;
  assert.deepEqual(S.timeAgo(now - 5_000, now),      { unit: "s", value: 5 });
  assert.deepEqual(S.timeAgo(now - 59_000, now),     { unit: "s", value: 59 });
  assert.deepEqual(S.timeAgo(now - 60_000, now),     { unit: "m", value: 1 });
  assert.deepEqual(S.timeAgo(now - 3_599_000, now),  { unit: "m", value: 59 });
  assert.deepEqual(S.timeAgo(now - 3_600_000, now),  { unit: "h", value: 1 });
});

test("a clock that runs backwards does not report a negative age", () => {
  const now = 1_000_000_000;
  assert.deepEqual(S.timeAgo(now + 10_000, now), { unit: "s", value: 0 });
});
