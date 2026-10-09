/*
  Tests for ratelimit.js.

  Two of the four rate-limit maps in server.js grew without bound because
  slidingAllow only ever trims the entry of whoever is calling right now.
  Nothing observable from outside the process shows that, which is exactly why
  these are unit tests on the pure functions rather than integration tests.

  safeLabel is here too: it is what stands between a client-chosen message type
  and the log file.

  Control characters below are written as escape sequences on purpose. Raw
  control bytes in the source make git treat this file as binary and stop
  producing diffs for it.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const { slidingAllow, pruneExpired, safeLabel } = require("../ratelimit.js");

const WINDOW = 60_000;

/* ══════════════════════════════════════════
   slidingAllow
══════════════════════════════════════════ */

test("requests under the limit are allowed", () => {
  const map = new Map();
  for (let i = 0; i < 5; i++) {
    assert.equal(slidingAllow(map, "a", 5, WINDOW), true, `call ${i + 1} should pass`);
  }
});

test("the request past the limit is refused", () => {
  const map = new Map();
  for (let i = 0; i < 5; i++) slidingAllow(map, "a", 5, WINDOW);
  assert.equal(slidingAllow(map, "a", 5, WINDOW), false);
});

test("the window slides — old hits stop counting", () => {
  const map = new Map();
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) slidingAllow(map, "a", 5, WINDOW, t0);
  assert.equal(slidingAllow(map, "a", 5, WINDOW, t0), false, "still inside the window");
  assert.equal(slidingAllow(map, "a", 5, WINDOW, t0 + WINDOW + 1), true, "window has passed");
});

test("callers are counted separately", () => {
  const map = new Map();
  for (let i = 0; i < 5; i++) slidingAllow(map, "a", 5, WINDOW);
  assert.equal(slidingAllow(map, "a", 5, WINDOW), false);
  assert.equal(slidingAllow(map, "b", 5, WINDOW), true, "one caller must not limit another");
});

test("a refused caller cannot grow its entry without bound", () => {
  /* Someone hammering a limited endpoint keeps calling. If refusals appended,
     the array would grow forever for exactly the caller behaving worst. */
  const map = new Map();
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) slidingAllow(map, "a", 5, WINDOW, t0);
  for (let i = 0; i < 500; i++) slidingAllow(map, "a", 5, WINDOW, t0);
  assert.equal(map.get("a").length, 5, "refusals must not be recorded as hits");
});

/* ══════════════════════════════════════════
   pruneExpired — the leak
══════════════════════════════════════════ */

test("entries whose hits have all expired are removed", () => {
  const map = new Map();
  const t0 = 1_000_000;
  slidingAllow(map, "gone", 5, WINDOW, t0);
  assert.equal(map.size, 1);
  assert.equal(pruneExpired(map, WINDOW, t0 + WINDOW + 1), 1);
  assert.equal(map.size, 0, "a visitor who never returns must not be kept forever");
});

test("entries still inside the window are kept", () => {
  const map = new Map();
  const t0 = 1_000_000;
  slidingAllow(map, "active", 5, WINDOW, t0);
  assert.equal(pruneExpired(map, WINDOW, t0 + 1000), 0);
  assert.ok(map.has("active"), "an in-window counter must survive the sweep");
});

test("a sweep does not reset someone who is mid-limit", () => {
  /* Dropping a live counter would hand an attacker a fresh allowance every
     time the sweep ran. */
  const map = new Map();
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) slidingAllow(map, "a", 5, WINDOW, t0);
  pruneExpired(map, WINDOW, t0 + 1000);
  assert.equal(slidingAllow(map, "a", 5, WINDOW, t0 + 1000), false, "still limited after the sweep");
});

test("many one-off visitors leave nothing behind", () => {
  /* The lobby sends list-sessions on every page load, so this is one entry per
     unique address — the shape the leak actually took. */
  const map = new Map();
  const t0 = 1_000_000;
  for (let i = 0; i < 1000; i++) slidingAllow(map, `visitor-${i}`, 40, WINDOW, t0);
  assert.equal(map.size, 1000);
  pruneExpired(map, WINDOW, t0 + WINDOW + 1);
  assert.equal(map.size, 0, "the map must not keep every address ever seen");
});

/* ══════════════════════════════════════════
   safeLabel — log injection
══════════════════════════════════════════ */

test("newlines cannot be used to forge extra log lines", () => {
  const forged = "ping\nRate-limited IP deadbeef99 for 30s";
  const out = safeLabel(forged);
  assert.ok(!out.includes("\n"), "a newline would start a line the attacker controls");
  assert.ok(!out.includes("\r"));
});

test("carriage returns cannot overwrite the line", () => {
  assert.ok(!safeLabel("ping\rSession abc join-locked").includes("\r"));
});

test("terminal escapes and control characters are neutralised", () => {
  const out = safeLabel("ping\u001b[31mDANGER\u001b[0m" + "\u0000");
  assert.ok(!/[\u0000-\u001f]/.test(out), "no control byte may reach the log");
  assert.ok(out.startsWith("ping"), "the printable part should survive");
});

test("long values are truncated", () => {
  /* maxPayload is 1 MB, so an unbounded type is a log-flooding tool. */
  const out = safeLabel("x".repeat(10_000));
  assert.ok(out.length <= 33, `expected a short label, got ${out.length} chars`);
  assert.ok(out.endsWith("…"), "truncation should be visible");
});

test("ordinary message types pass through unchanged", () => {
  for (const type of ["offer", "answer", "ice-candidate", "join-session", "list-sessions"]) {
    assert.equal(safeLabel(type), type);
  }
});

test("non-string values do not throw", () => {
  /* data.type comes from JSON.parse, so it can be any type at all. */
  for (const value of [undefined, null, 42, true, {}, []]) {
    assert.equal(typeof safeLabel(value), "string", `failed on ${JSON.stringify(value)}`);
  }
});

/* ══════════════════════════════════════════
   joinVerdict — which lock applies to which credential
══════════════════════════════════════════ */

const { joinVerdict } = require("../ratelimit.js");

const attempt = o => Object.assign(
  { tokenOk: false, pinOk: false, full: false, roomLocked: false, ipLimited: false }, o);

test("a correct PIN is admitted when nothing is locked", () => {
  assert.equal(joinVerdict(attempt({ pinOk: true })), "admit");
});

test("a correct invite token is admitted when nothing is locked", () => {
  assert.equal(joinVerdict(attempt({ tokenOk: true })), "admit");
});

test("a correct invite token is admitted through a locked room", () => {
  /* The bug: room names are public, so fifteen wrong PINs from anyone locked
     the room — and the invited guest, holding a valid link, was turned away
     with everyone else. The locks slow PIN guessing; a 192-bit token is not a
     guess. */
  assert.equal(joinVerdict(attempt({ tokenOk: true, roomLocked: true })), "admit");
});

test("a correct invite token is admitted from a locked-out address", () => {
  /* Same reasoning for the per-address lock — a guest behind the same router
     as someone who mistyped the PIN three times still holds a valid link. */
  assert.equal(joinVerdict(attempt({ tokenOk: true, ipLimited: true })), "admit");
  assert.equal(joinVerdict(attempt({ tokenOk: true, ipLimited: true, roomLocked: true })), "admit");
});

test("a correct PIN is NOT admitted through a locked room", () => {
  /* The other half, and the one that must not be "fixed" to match: if a right
     PIN got in during the lock, the lock would stop nothing — the guesser
     would simply keep going until one landed. */
  assert.equal(joinVerdict(attempt({ pinOk: true, roomLocked: true })), "room-locked");
});

test("a correct PIN is NOT admitted from a locked-out address", () => {
  assert.equal(joinVerdict(attempt({ pinOk: true, ipLimited: true })), "ip-limited");
});

test("a wrong attempt during a lock is told about the lock, not that it was wrong", () => {
  /* Answering "wrong" here would turn the lock into a free guess-checker. */
  assert.equal(joinVerdict(attempt({ roomLocked: true })), "room-locked");
  assert.equal(joinVerdict(attempt({ ipLimited: true })), "ip-limited");
});

test("a full room turns even a valid token away", () => {
  assert.equal(joinVerdict(attempt({ tokenOk: true, full: true })), "full");
  assert.equal(joinVerdict(attempt({ pinOk: true, full: true })), "full");
});

test("neither credential being right is a wrong attempt", () => {
  assert.equal(joinVerdict(attempt({})), "wrong");
});

test("every combination gives one of the five known answers", () => {
  const known = new Set(["admit", "full", "room-locked", "ip-limited", "wrong"]);
  for (let bits = 0; bits < 32; bits++) {
    const o = {
      tokenOk: Boolean(bits & 1), pinOk: Boolean(bits & 2), full: Boolean(bits & 4),
      roomLocked: Boolean(bits & 8), ipLimited: Boolean(bits & 16)
    };
    const verdict = joinVerdict(o);
    assert.ok(known.has(verdict), `unexpected verdict ${verdict} for ${JSON.stringify(o)}`);
    /* Nobody is ever admitted without a correct credential, or into a full room. */
    if (verdict === "admit") {
      assert.ok(o.tokenOk || o.pinOk, `admitted with no credential: ${JSON.stringify(o)}`);
      assert.equal(o.full, false, `admitted into a full room: ${JSON.stringify(o)}`);
    }
  }
});
