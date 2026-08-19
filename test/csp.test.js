/*
  The Content-Security-Policy exists twice: as a header from server.js and as a
  <meta> tag in index.html, because GitHub Pages cannot set headers. csp.js is
  the single definition both come from — this makes drift a test failure rather
  than something you notice in production, on the static deployment only.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const { buildCsp, DEFAULT_ALLOWED_ORIGINS, META_CSP, META_TAG_PATTERN } = require("../csp.js");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

test("index.html carries a CSP meta tag", () => {
  assert.ok(META_TAG_PATTERN.test(indexHtml));
});

test("the meta tag matches what csp.js generates", () => {
  const match = indexHtml.match(META_TAG_PATTERN);
  assert.equal(match[2], META_CSP, "run `npm run sync-csp` to regenerate index.html");
});

test("frame-ancestors is header-only", () => {
  /* Browsers ignore frame-ancestors in a meta tag; emitting it there would be
     a false sense of protection. X-Frame-Options covers the static build. */
  const header = buildCsp(DEFAULT_ALLOWED_ORIGINS, { asHeader: true });
  assert.ok(header.includes("frame-ancestors 'none'"));
  assert.ok(!META_CSP.includes("frame-ancestors"));
});

test("the two forms differ only by frame-ancestors", () => {
  const header = buildCsp(DEFAULT_ALLOWED_ORIGINS, { asHeader: true });
  assert.equal(header.replace("frame-ancestors 'none'; ", ""), META_CSP);
});

test("every allowed origin gets its WebSocket counterpart", () => {
  const csp = buildCsp(["https://example.com", "http://localhost:3000"], { asHeader: true });
  const connect = csp.match(/connect-src ([^;]*)/)[1];
  for (const expected of [
    "https://example.com", "wss://example.com",
    "http://localhost:3000", "ws://localhost:3000", "'self'"
  ]) {
    assert.ok(connect.includes(expected), `connect-src is missing ${expected}`);
  }
});

test("scripts may only come from our own origin", () => {
  /* The app's confidentiality rests on the served JavaScript being ours; a CDN
     or inline allowance here would undo the end-to-end encryption entirely. */
  const csp = buildCsp(DEFAULT_ALLOWED_ORIGINS, { asHeader: true });
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.ok(!/script-src[^;]*unsafe-eval/.test(csp));
});
