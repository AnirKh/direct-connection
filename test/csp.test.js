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
     a false sense of protection. The static build gets no header at all — see
     the framebust tests below, which are its only cover. */
  const header = buildCsp(DEFAULT_ALLOWED_ORIGINS, { asHeader: true });
  assert.ok(header.includes("frame-ancestors 'none'"));
  assert.ok(!META_CSP.includes("frame-ancestors"));
});

/* ══════════════════════════════════════════
   Framing — the static deployment

   GitHub Pages sets no headers, so neither frame-ancestors nor
   X-Frame-Options applies there. framebust.js is the whole defence, and it
   only works if it is present, loaded first, and paired with the CSS that
   hides the page until it runs.
══════════════════════════════════════════ */

const framebustSrc = fs.readFileSync(path.join(__dirname, "..", "framebust.js"), "utf8");

test("the page is hidden until the frame check has run", () => {
  /* Failing closed is the point: if framebust.js does not load, a blank page
     is correct and a visible one is a clickable target. */
  assert.match(indexHtml, /<style id="antiClickjack">[^<]*visibility:\s*hidden/,
    "index.html must hide the body up front");
  assert.ok(framebustSrc.includes("antiClickjack"),
    "framebust.js must be the thing that reveals it");
});

test("the frame check loads before any other script", () => {
  const scripts = Array.from(indexHtml.matchAll(/<script[^>]*\bsrc="([^"?]+)/g)).map(m => m[1]);
  assert.ok(scripts.length > 1, "expected the app scripts as well");
  assert.equal(scripts[0], "framebust.js",
    "framebust.js must come first — app.js opens a WebSocket as soon as it parses");
});

test("the frame check refuses to run the app inside a frame", () => {
  assert.match(framebustSrc, /window\.self\s*!==\s*window\.top/,
    "no frame detection found");
  assert.ok(framebustSrc.includes("window.stop()"),
    "must halt parsing so app.js never loads inside a frame");
  assert.match(framebustSrc, /catch\s*\([^)]*\)\s*\{[\s\S]{0,200}framed\s*=\s*true/,
    "a cross-origin throw when reading window.top must count as framed");
});

test("the server serves the frame check", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/["']\/framebust\.js["']/.test(serverSrc),
    "server.js does not serve framebust.js — the Render build would 404 on it");
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

/* ══════════════════════════════════════════
   Third-party assets
══════════════════════════════════════════ */

/** Every <link> and <script> in index.html pointing off-origin. */
function externalAssetTags() {
  return Array.from(indexHtml.matchAll(/<(?:link|script)\b[^>]*\bhttps?:\/\/[^>]*>/g))
    .map(m => m[0])
    /* The CSP meta tag lists origins in its content attribute; it fetches nothing. */
    .filter(tag => !/http-equiv=/i.test(tag));
}

test("index.html does load something from a CDN", () => {
  /* Guards the test below: if the icon font is ever self-hosted, that check
     would pass by matching nothing at all, and silently stop meaning anything. */
  assert.ok(externalAssetTags().length >= 1,
    "no external assets found — if that is deliberate, delete the SRI test too");
});

test("every third-party asset is pinned with an integrity hash", () => {
  /* style-src allows the CDN, and CSS alone can hide an element — a substituted
     stylesheet could suppress #verifyBanner, which is the only thing telling the
     user nobody has verified the connection. crossorigin is required or the
     browser skips the integrity check entirely rather than failing.

     Written against every external tag rather than the one URL we know about,
     so adding a second CDN link without a hash fails here. */
  for (const tag of externalAssetTags()) {
    const url = (tag.match(/https?:\/\/[^"'\s>]+/) || ["?"])[0];
    assert.match(tag, /\bintegrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/,
      `no integrity hash on ${url}`);
    assert.match(tag, /\bcrossorigin=/,
      `integrity is ignored without crossorigin on ${url}`);
    assert.match(tag, /@\d+\.\d+\.\d+\//,
      `${url} must pin an exact version, or the hash will break on the next release`);
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
