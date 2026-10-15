/*
  Every word index.html asks i18n.js for, in both languages.

  t() and applyI18n() fall back quietly: a key missing from one language shows
  the Mongolian text left in the markup to an English reader, or the key's own
  name. Neither throws and neither looks broken on the side that was tested.

  Also here: the page opens straight to the lobby. "About this page" used to be
  a dialog in front of every visit, with an "approve" button that approved
  nothing — it only closed the dialog — so returning visitors dismissed it every
  time. It is now a dropdown beside the lobby title, opened on request.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const html = read("index.html");
const css  = read("style.css");
const I18N = new Function("localStorage", `${read("i18n.js")}; return I18N;`)({ getItem: () => null });

const withoutCssComments = src => src.replace(/\/\*[\s\S]*?\*\//g, "");

test("both languages have the same keys, of the same kind", () => {
  /* A key missing from one language shows "undefined" in that language only —
     the one nobody tested in. */
  const mn = Object.keys(I18N.mn).sort(), en = Object.keys(I18N.en).sort();
  assert.deepEqual(mn, en);
  for (const key of mn) {
    assert.equal(typeof I18N.mn[key], typeof I18N.en[key], `${key} is a ${typeof I18N.mn[key]} in mn, a ${typeof I18N.en[key]} in en`);
  }
});

test("every key app.js asks for by name exists in both languages", () => {
  const app = read("app.js");
  const keys = new Set([
    ...[...app.matchAll(/\bt\("([A-Za-z0-9_]+)"\)/g)].map(m => m[1]),
    ...[...app.matchAll(/I18N\[LANG\]\.([A-Za-z0-9_]+)/g)].map(m => m[1])
  ]);
  assert.ok(keys.size > 50, `expected app.js's keys, found ${keys.size}`);
  for (const key of keys) {
    for (const lang of ["mn", "en"]) assert.ok(key in I18N[lang], `${lang}.${key} is missing`);
  }
});

test("every key the page names exists in both languages", () => {
  const keys = new Set();
  for (const attr of ["data-i18n", "data-i18n-ph", "data-i18n-aria"]) {
    for (const m of html.matchAll(new RegExp(`${attr}="([^"]+)"`, "g"))) keys.add(m[1]);
  }
  assert.ok(keys.size > 20, `expected the page's keys, found ${keys.size}`);
  for (const key of keys) {
    for (const lang of ["mn", "en"]) {
      /* leaveHint is the one function, sized at run time — see applyI18n. */
      const kind = key === "leaveHint" ? "function" : "string";
      assert.equal(typeof I18N[lang][key], kind, `${lang}.${key} is missing`);
    }
  }
});

test("the page opens straight to the lobby", () => {
  assert.ok(!/id="approveBtn"/.test(html), "the approve dialog is back");
  assert.ok(!/id="overlay"/.test(html), "the approve dialog is back");
});

test("what the page is for is a dropdown beside the lobby title", () => {
  const head = html.match(/<div class="lobby-head">[\s\S]*?<\/details>\s*<\/div>/);
  assert.ok(head, "the about dropdown is not in the lobby's title row");
  assert.match(head[0], /<details id="aboutDropdown"/);
  assert.match(head[0], /data-i18n-aria="aboutLabel"/, "an icon-only button needs a spoken name");
  assert.match(head[0], /data-i18n="aboutDesc"/);
});

test("on a phone the about button starts below the language switcher", () => {
  /* The switcher is fixed in the top-right corner, and below 480px the title
     row reaches it: the button sat underneath, and a tap meant for one landed
     on the other. Measured clear at 320, 360, 375 and 414px wide. */
  const phone = withoutCssComments(css).match(/@media \(max-width: 480px\) \{([\s\S]*?)\n\}/);
  assert.ok(phone, "phone media query not found");
  assert.match(phone[1], /\.lobby-head\s*\{[^}]*margin-top:\s*28px/);
});
