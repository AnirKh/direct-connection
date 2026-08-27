/*
  ─────────────────────────────────────────────
  Direct Connection — connstats.js
  ─────────────────────────────────────────────

  Everything the UI derives from an RTCStatsReport, as pure functions of it.

  Extracted because the reading was wrong for a long time and nothing could
  see it: the old code scanned every local-candidate and kept whichever came
  last, so with more than one route it named a candidate that was not carrying
  traffic. A browser and two peers were needed to notice. Here a plain Map
  stands in for the report and the answer can simply be asserted.

  Nothing in this file touches the DOM or any module state — pass the report in,
  get the answer back.
*/

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DCStats = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /** RTT thresholds for the quality label, in milliseconds. */
  const RTT_GOOD = 80;
  const RTT_FAIR = 250;

  /**
   * The candidate pair ICE actually settled on.
   *
   * transport.selectedCandidatePairId names it outright where the browser
   * provides it. The scan is a fallback: several pairs can reach "succeeded"
   * and only one carries traffic, so a nominated pair always wins over a merely
   * successful one.
   */
  function selectedCandidatePair(stats) {
    if (!stats || typeof stats.forEach !== "function") return null;

    let transport = null;
    stats.forEach(r => { if (r && r.type === "transport") transport = r; });
    if (transport && transport.selectedCandidatePairId && typeof stats.get === "function") {
      const named = stats.get(transport.selectedCandidatePairId);
      if (named) return named;
    }

    let pair = null;
    stats.forEach(r => {
      if (!r || r.type !== "candidate-pair" || r.state !== "succeeded") return;
      if (r.nominated || !pair) pair = r;
    });
    return pair;
  }

  /**
   * How the two sides are reaching each other.
   *
   *   local    both ends are host candidates — the traffic never left the
   *            local network
   *   direct   peer to peer across the internet
   *   relayed  a TURN server is carrying every packet
   *
   * "relayed" is the one worth surfacing. The payload stays end-to-end
   * encrypted either way, but a relay learns who is talking to whom and for how
   * long, which is a different trust situation. Relay on *either* side counts —
   * one relayed leg is enough for a third party to be in the path.
   *
   * @returns {{kind: string, local: object, remote: object}|null} null while ICE
   *          is still deciding, or when the report is incomplete.
   */
  function describePath(stats) {
    const pair = selectedCandidatePair(stats);
    if (!pair || typeof stats.get !== "function") return null;
    const local  = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    if (!local || !remote) return null;

    const types = [local.candidateType, remote.candidateType];
    let kind;
    if (types.includes("relay"))             kind = "relayed";
    else if (types.every(t => t === "host")) kind = "local";
    else                                     kind = "direct";
    return { kind, local, remote };
  }

  /**
   * Quality bucket for a round-trip time.
   * @param {number|null|undefined} seconds as reported by getStats
   * @returns {{ms: number, key: string, cls: string}|null}
   */
  function qualityFromRtt(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return null;
    const ms = Math.round(seconds * 1000);
    if (ms < RTT_GOOD) return { ms, key: "connected", cls: "connected" };
    if (ms < RTT_FAIR) return { ms, key: "fair",      cls: "poor" };
    return                     { ms, key: "poor",      cls: "poor" };
  }

  /**
   * Bytes moved in each direction.
   *
   * rtp reports only exist during a call, so a text-only session showed nothing
   * at all until the candidate pair was used as the fallback.
   */
  function trafficTotals(stats, pair) {
    let sent = 0, recv = 0;
    if (stats && typeof stats.forEach === "function") {
      stats.forEach(r => {
        if (!r) return;
        if (r.type === "outbound-rtp") sent += r.bytesSent || 0;
        if (r.type === "inbound-rtp")  recv += r.bytesReceived || 0;
      });
    }
    if (!sent && pair) sent = pair.bytesSent || 0;
    if (!recv && pair) recv = pair.bytesReceived || 0;
    return { sent, recv };
  }

  function fmtBytes(b) {
    if (typeof b !== "number" || !isFinite(b) || b < 0) return "0B";
    if (b < 1024)    return `${b}B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`;
    return `${(b / 1048576).toFixed(1)}MB`;
  }

  /** Coarse age of a timestamp, as {unit, value} for the caller to translate. */
  function timeAgo(ts, now = Date.now()) {
    const s = Math.max(0, Math.floor((now - ts) / 1000));
    if (s < 60)   return { unit: "s", value: s };
    if (s < 3600) return { unit: "m", value: Math.floor(s / 60) };
    return          { unit: "h", value: Math.floor(s / 3600) };
  }

  return {
    RTT_GOOD, RTT_FAIR,
    selectedCandidatePair, describePath,
    qualityFromRtt, trafficTotals, fmtBytes, timeAgo
  };
});
