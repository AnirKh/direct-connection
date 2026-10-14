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

/* ══════════════════════════════════════════
   pathAddresses — what the two devices show each other
══════════════════════════════════════════ */

/** A report with addresses on it. `extra` adds further candidates ICE gathered
    but is not using — which is where a device's public address usually is. */
function addressed({ local, remote, extra = [] }) {
  const m = new Map();
  m.set("L", Object.assign({ id: "L", type: "local-candidate",  protocol: "udp" }, local));
  m.set("R", Object.assign({ id: "R", type: "remote-candidate", protocol: "udp" }, remote));
  m.set("P", { id: "P", type: "candidate-pair", state: "succeeded", nominated: true,
               localCandidateId: "L", remoteCandidateId: "R" });
  extra.forEach((c, i) => m.set("X" + i, Object.assign({ id: "X" + i, type: "local-candidate", protocol: "udp" }, c)));
  m.set("T", { id: "T", type: "transport", selectedCandidatePairId: "P" });
  return m;
}

/* Addresses below are from the ranges reserved for documentation. */

test("a direct connection shows your public address, not your address at home", () => {
  /* The usual shape: the route's local end is the device's address on its own
     network, and the public one sits on a candidate that is not in the pair.
     The other side sees the public one, so that is the one worth showing. */
  const a = S.pathAddresses(addressed({
    local:  { candidateType: "host",  address: "192.168.1.20" },
    remote: { candidateType: "srflx", address: "198.51.100.24" },
    extra:  [{ candidateType: "srflx", address: "203.0.113.7" }]
  }));
  assert.deepEqual(a, { local: "203.0.113.7", remote: "198.51.100.24" });
});

test("your public address is found even when the browser hides your local one", () => {
  const a = S.pathAddresses(addressed({
    local:  { candidateType: "host",  address: "3f9a1c2e-77aa-4b1c-9d0e-5a6b7c8d9e0f.local" },
    remote: { candidateType: "srflx", address: "198.51.100.24" },
    extra:  [{ candidateType: "srflx", address: "203.0.113.7" }]
  }));
  assert.deepEqual(a, { local: "203.0.113.7", remote: "198.51.100.24" });
});

test("the public address shown is the one in the same family as the route", () => {
  /* A device with both IPv4 and IPv6 has two. Showing the IPv4 one for an IPv6
     route names an address the other side is not looking at. */
  const extra = [{ candidateType: "srflx", address: "203.0.113.7" }, { candidateType: "srflx", address: "2001:db8::7" }];
  const v6 = S.pathAddresses(addressed({
    local: { candidateType: "host", address: "xx.local" }, remote: { candidateType: "srflx", address: "2001:db8:1::24" }, extra }));
  assert.equal(v6.local, "2001:db8::7");
  const v4 = S.pathAddresses(addressed({
    local: { candidateType: "host", address: "xx.local" }, remote: { candidateType: "srflx", address: "198.51.100.24" }, extra }));
  assert.equal(v4.local, "203.0.113.7");
});

test("a device reachable directly keeps its own address when no public one of that family was reported", () => {
  /* IPv6 with no translation in the way: the local address IS the public one,
     and STUN reports nothing separate. An IPv4 address must not be put in its place. */
  const a = S.pathAddresses(addressed({
    local:  { candidateType: "host",  address: "2001:db8::20" },
    remote: { candidateType: "host",  address: "2001:db8:1::24" , },
    extra:  [{ candidateType: "srflx", address: "203.0.113.7" }]
  }));
  assert.equal(a.local, "2001:db8::20");
});

test("a local end that is already the public address is shown as it is", () => {
  const a = S.pathAddresses(addressed({
    local:  { candidateType: "prflx", address: "203.0.113.99" },
    remote: { candidateType: "srflx", address: "198.51.100.24" },
    extra:  [{ candidateType: "srflx", address: "203.0.113.7" }]
  }));
  assert.equal(a.local, "203.0.113.99");
});

test("on the same network both local addresses are shown, when the browser gives them", () => {
  const a = S.pathAddresses(addressed({
    local:  { candidateType: "host", address: "192.168.1.20" },
    remote: { candidateType: "host", address: "192.168.1.31" },
    extra:  [{ candidateType: "srflx", address: "203.0.113.7" }]
  }));
  assert.deepEqual(a, { local: "192.168.1.20", remote: "192.168.1.31" },
    "on a shared network the public address is not what the other side sees");
});

test("an address the browser hides comes back as null, never as text", () => {
  /* A random `.local` name is not an address anyone could use, and a blank is
     a blank. Neither may be passed off as an IP. */
  const a = S.pathAddresses(addressed({
    local:  { candidateType: "host", address: "3f9a1c2e-77aa-4b1c-9d0e-5a6b7c8d9e0f.local" },
    remote: { candidateType: "host", address: "" }
  }));
  assert.deepEqual(a, { local: null, remote: null });

  for (const hidden of [undefined, null, "", "abc.local", "ABC.LOCAL", "abc.local.", 42, {}]) {
    assert.equal(S.usableAddress({ address: hidden }), null, `${JSON.stringify(hidden)} is not an address`);
  }
  assert.equal(S.usableAddress(null), null);
  assert.equal(S.usableAddress({ ip: "203.0.113.7" }), "203.0.113.7", "older browsers call the field `ip`");
});

test("a relayed connection shows no addresses at all", () => {
  /* The addresses on a relayed route belong to the relay. Printing one under
     "your IP" would be wrong, and under "their IP" would be the relay's. */
  for (const [local, remote] of [["relay", "srflx"], ["host", "relay"], ["relay", "relay"]]) {
    assert.equal(S.pathAddresses(addressed({
      local: { candidateType: local, address: "192.0.2.50" }, remote: { candidateType: remote, address: "198.51.100.24" }
    })), null, `${local} → ${remote}`);
  }
});

test("no route yet means no addresses, and a broken report does not throw", () => {
  assert.equal(S.pathAddresses(new Map()), null);
  for (const bad of [null, undefined, {}, [], "stats", 42]) {
    assert.doesNotThrow(() => S.pathAddresses(bad));
    assert.equal(S.pathAddresses(bad), null);
  }
});

/* ══════════════════════════════════════════
   describeDevice / deviceLabel
══════════════════════════════════════════ */

const UA = {
  androidChrome: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  samsung:       "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36",
  iphoneSafari:  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iphoneChrome:  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1",
  iphoneFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15",
  windowsEdge:   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  windowsFirefox:"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
  windowsOpera:  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/120.0.0.0",
  macSafari:     "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  linuxChrome:   "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  chromeOs:      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
};
const says = (userAgent, maxTouchPoints = 0) => S.deviceLabel(S.describeDevice({ userAgent, maxTouchPoints }));

test("common devices are described by system and browser", () => {
  assert.equal(says(UA.androidChrome, 5),  "Android · Chrome");
  assert.equal(says(UA.iphoneSafari, 5),   "iPhone · Safari");
  assert.equal(says(UA.windowsFirefox),    "Windows · Firefox");
  assert.equal(says(UA.macSafari),         "macOS · Safari");
  assert.equal(says(UA.linuxChrome),       "Linux · Chrome");
  assert.equal(says(UA.chromeOs),          "ChromeOS · Chrome");
});

test("a browser is not mistaken for the ones it claims to be", () => {
  /* Edge, Opera and Samsung Internet all say "Chrome" and "Safari" as well;
     Chrome and Firefox on an iPhone both say "Safari". */
  assert.equal(says(UA.windowsEdge),       "Windows · Edge");
  assert.equal(says(UA.windowsOpera),      "Windows · Opera");
  assert.equal(says(UA.samsung, 5),        "Android · Samsung Internet");
  assert.equal(says(UA.iphoneChrome, 5),   "iPhone · Chrome");
  assert.equal(says(UA.iphoneFirefox, 5),  "iPhone · Firefox");
});

test("an iPad is recognised although it says it is a Mac", () => {
  assert.equal(says(UA.macSafari, 5), "iPad · Safari");
  assert.equal(says(UA.macSafari, 0), "macOS · Safari", "a real Mac has no touch screen");
});

test("an unknown device is described as unknown, not guessed at", () => {
  assert.deepEqual(S.describeDevice({ userAgent: "SomethingNew/1.0" }), { os: "other", browser: "other" });
  assert.equal(says("SomethingNew/1.0"), null);
  for (const bad of [undefined, null, {}, { userAgent: null }, { userAgent: 42 }]) {
    assert.doesNotThrow(() => S.describeDevice(bad));
  }
});

test("a description carries no version and no model", () => {
  /* The less it says, the less it identifies. */
  const d = S.describeDevice({ userAgent: UA.androidChrome, maxTouchPoints: 5 });
  assert.deepEqual(Object.keys(d).sort(), ["browser", "os"]);
  assert.ok(!/\d/.test(JSON.stringify(d)), "no version number should appear");
});

test("every code describeDevice can produce has words to show", () => {
  for (const userAgent of Object.values(UA)) {
    const d = S.describeDevice({ userAgent, maxTouchPoints: 0 });
    assert.ok(d.os in S.OS_NAMES, `no name for system "${d.os}"`);
    assert.ok(d.browser in S.BROWSER_NAMES, `no name for browser "${d.browser}"`);
  }
});

test("nothing a peer sends as a device reaches the screen as it was sent", () => {
  /* The label is shown in the security panel. A device "name" of the peer's
     choosing there — "✅ verified by server" — would be believed. Only codes
     from the fixed tables turn into text, and the text is ours. */
  const hostile = [
    { os: "✅ verified by server", browser: "trusted" },
    { os: "<img src=x onerror=alert(1)>", browser: "<b>x</b>" },
    { os: "Android", browser: "Chrome" },                    // the display names are not codes
    { os: "__proto__", browser: "constructor" },
    { os: "toString", browser: "hasOwnProperty" },
    { os: ["android"], browser: { name: "chrome" } },
    { os: 1, browser: true },
    { os: "x".repeat(100000), browser: "" }
  ];
  for (const device of hostile) {
    assert.equal(S.deviceLabel(device), null, `shown something for ${JSON.stringify(device).slice(0, 60)}`);
  }
  for (const notADevice of [null, undefined, "android", 42, [], true]) {
    assert.equal(S.deviceLabel(notADevice), null);
  }
});

test("a half-recognised device shows the half that is known", () => {
  assert.equal(S.deviceLabel({ os: "android", browser: "something-else" }), "Android");
  assert.equal(S.deviceLabel({ os: "other", browser: "firefox" }), "Firefox");
});

test("whatever comes back is one of our own words", () => {
  const ours = new Set([...Object.values(S.OS_NAMES), ...Object.values(S.BROWSER_NAMES)]);
  for (const os of [...Object.keys(S.OS_NAMES), "other", "nonsense"]) {
    for (const browser of [...Object.keys(S.BROWSER_NAMES), "other", "nonsense"]) {
      const label = S.deviceLabel({ os, browser });
      if (label === null) continue;
      for (const part of label.split(" · ")) assert.ok(ours.has(part), `"${part}" is not from the tables`);
    }
  }
});
