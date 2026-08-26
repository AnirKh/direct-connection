/*
  ─────────────────────────────────────────────
  Direct Connection — ratelimit.js
  ─────────────────────────────────────────────

  The sliding-window counters behind the `list-sessions` and `create-session`
  limits, kept here for the same reason clientip.js is separate: they are small,
  pure, and the thing several limits rest on, so they are worth testing directly
  rather than through a running server.

  Shape of the state: Map<clientIp, number[]> — a list of request timestamps.
*/

"use strict";

/**
 * Records a hit and reports whether it is allowed.
 *
 * Trims expired timestamps for this caller on the way through, which keeps an
 * active entry bounded but does nothing for callers who never return — see
 * pruneExpired.
 *
 * @returns {boolean} false when the caller is over `max` within `windowMs`
 */
function slidingAllow(map, key, max, windowMs, now = Date.now()) {
  const times = (map.get(key) || []).filter(t => now - t < windowMs);
  if (times.length >= max) {
    /* Store the trimmed list even when refusing, so a caller hammering the
       endpoint cannot pin an ever-growing array in memory. */
    map.set(key, times);
    return false;
  }
  times.push(now);
  map.set(key, times);
  return true;
}

/**
 * Drops entries whose timestamps have all aged out.
 *
 * Without this the map keeps one entry per address seen since the process
 * started: slidingAllow only ever trims the entry belonging to whoever is
 * asking right now, so an address that never comes back is never touched
 * again. The lobby calls list-sessions on every page load, which makes that
 * one entry per unique visitor, permanently.
 *
 * @returns {number} how many entries were removed
 */
function pruneExpired(map, windowMs, now = Date.now()) {
  let removed = 0;
  for (const [key, times] of map) {
    if (!times.some(t => now - t < windowMs)) {
      map.delete(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Makes a client-supplied value safe to put in a log line.
 *
 * A WebSocket `data.type` is whatever the client sent, up to maxPayload and
 * newlines included. Printed raw it lets anyone forge log entries: a type
 * containing "\n" writes as many lines as it likes and can imitate the real
 * ones ("Rate-limited IP ...", "Session ... join-locked"). Real message types
 * are short ASCII identifiers, so anything else is an attack or a bug.
 */
function safeLabel(value, max = 32) {
  const text = typeof value === "string" ? value : String(value);
  const clean = text.replace(/[^\x20-\x7E]/g, "·");
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

module.exports = { slidingAllow, pruneExpired, safeLabel };
