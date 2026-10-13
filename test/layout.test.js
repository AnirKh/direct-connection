/*
  Tests for how the page sizes itself — the phone-keyboard fix.

  The bug: on a phone, the message box sat underneath the keyboard while the
  user typed into it. Two causes, one in each file:

    style.css   every full-height rule read
                    height: 100dvh; height: -webkit-fill-available;
                and the second line wins wherever it is understood, which is
                every phone browser — so the first never applied.
    app.js      nothing watched the visual viewport, the one measurement that
                actually gets shorter when a keyboard opens. On iOS and in most
                in-app browsers no CSS unit does.

  A real keyboard needs a real phone, so nothing here can prove the result on
  a device. What these do prove is that the pieces which make it work are still
  in place and still connected — and fitToVisibleArea() is lifted out of app.js
  and actually run, against a stand-in window, for every case it has to judge.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const css  = read("style.css");
const html = read("index.html");
const app  = read("app.js");

const withoutCssComments = src => src.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of one top-level CSS rule, by exact selector. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = withoutCssComments(css).match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return m ? m[1] : null;
}

/* ══════════════════════════════════════════
   index.html
══════════════════════════════════════════ */

test("the page asks the browser to make room for the keyboard", () => {
  /* Where this is honoured (Android Chrome and Firefox) the page itself gets
     shorter and the message box stays above the keyboard with no script. */
  const meta = html.match(/<meta\s+name="viewport"\s+content="([^"]*)"/);
  assert.ok(meta, "viewport meta tag not found");
  assert.match(meta[1], /interactive-widget=resizes-content/);
  assert.match(meta[1], /width=device-width/);
  assert.match(meta[1], /viewport-fit=cover/, "the safe-area insets in style.css depend on this");
});

/* ══════════════════════════════════════════
   style.css
══════════════════════════════════════════ */

test("every full-height thing is sized from --app-height", () => {
  for (const selector of ["body", ".screen", "#chatScreen", ".overlay"]) {
    const body = rule(selector);
    assert.ok(body, `no rule found for ${selector}`);
    assert.match(body, /height:\s*var\(--app-height\)/, `${selector} must take its height from --app-height`);
  }
});

test("no rule sets a full height of its own", () => {
  /* The original bug in one line: a second `height:` after the first replaces
     it. Any rule that brings back its own 100vh / 100dvh / fill-available
     stops following the keyboard, and nothing would look wrong on a desktop. */
  const src = withoutCssComments(css);
  assert.ok(!/-webkit-fill-available/.test(src), "-webkit-fill-available is back — it overrides whatever comes before it");
  for (const line of src.split("\n")) {
    if (!/\b100d?vh\b/.test(line)) continue;
    if (/^\s*@supports\b/.test(line)) continue;   // the feature test guarding --app-height itself
    assert.match(line, /--app-height:/, `a full viewport height is set outside --app-height: ${line.trim()}`);
  }
});

test("--app-height has a value before any script runs", () => {
  /* The page must be the right height with JavaScript slow, blocked or broken. */
  const src = withoutCssComments(css);
  assert.match(src, /:root\s*\{[^}]*--app-height:\s*100vh/, "needs a plain 100vh starting value");
  assert.match(src, /@supports\s*\(height:\s*100dvh\)\s*\{\s*:root\s*\{\s*--app-height:\s*100dvh/,
    "should prefer 100dvh where the browser has it");
});

test("toasts are placed from the top of the visible area", () => {
  /* Errors are shown as toasts. Anchored to the bottom of the screen they
     appear behind an open keyboard. */
  const body = rule(".dc-toast-container");
  assert.ok(body, ".dc-toast-container rule not found");
  assert.match(body, /top:\s*calc\(var\(--app-height\)/);
  assert.ok(!/\bbottom:/.test(body), "a bottom anchor puts toasts behind the keyboard");
});

/* ══════════════════════════════════════════
   app.js — fitToVisibleArea, actually run
══════════════════════════════════════════ */

const fnSource = (app.match(/^function fitToVisibleArea\(\)\s*\{[\s\S]*?^\}/m) || [])[0];

/** Runs the real function against a stand-in window and reports what it did. */
function fit({ visualViewport, innerHeight = 800, scrollX = 0, scrollY = 0, stick = true }) {
  const did = { appHeight: undefined, scrolledWindowTo: null, scrolledListToBottom: false };
  const window = {
    visualViewport, innerHeight, scrollX, scrollY,
    scrollTo: (x, y) => { did.scrolledWindowTo = [x, y]; }
  };
  const document = { documentElement: { style: { setProperty: (name, value) => { if (name === "--app-height") did.appHeight = value; } } } };
  const scrollBottom = () => { did.scrolledListToBottom = true; };
  new Function("window", "document", "scrollBottom", "_stickToBottom", `${fnSource}; fitToVisibleArea();`)(
    window, document, scrollBottom, stick);
  return did;
}

test("fitToVisibleArea is where the test expects it", () => {
  assert.ok(fnSource, "fitToVisibleArea not found as a top-level function in app.js");
});

test("the page takes the height of what is visible", () => {
  /* Keyboard up: the window still says 812, the visible part is 476. */
  assert.equal(fit({ visualViewport: { height: 476, scale: 1 }, innerHeight: 812 }).appHeight, "476px");
  /* Keyboard down again. */
  assert.equal(fit({ visualViewport: { height: 812, scale: 1 }, innerHeight: 812 }).appHeight, "812px");
});

test("pinch-zoom is not mistaken for a keyboard", () => {
  /* Zooming in shrinks the visible area too. Resizing the page to match would
     fight the zoom the user just asked for. */
  for (const scale of [1.5, 2, 3, 0.5]) {
    assert.equal(fit({ visualViewport: { height: 406, scale } }).appHeight, undefined, `scale ${scale} must leave the page alone`);
  }
});

test("a scale that is one in all but rounding still counts as not zoomed", () => {
  assert.equal(fit({ visualViewport: { height: 476, scale: 1.0000001 } }).appHeight, "476px");
  assert.equal(fit({ visualViewport: { height: 476, scale: 0.999 } }).appHeight, "476px");
});

test("a page with no size yet is left alone", () => {
  /* A hidden tab reports a height of 0. Believing it collapses every screen. */
  for (const height of [0, -1, NaN, undefined]) {
    assert.equal(fit({ visualViewport: { height, scale: 1 } }).appHeight, undefined, `height ${height} must be ignored`);
  }
});

test("a browser without a visual viewport falls back to the window", () => {
  assert.equal(fit({ visualViewport: undefined, innerHeight: 640 }).appHeight, "640px");
});

test("a page the browser scrolled to reveal the text box is put back", () => {
  /* iOS scrolls the whole page to lift a focused field above the keyboard.
     Once the page fits, that scroll only pushes the header off the top. */
  assert.deepEqual(fit({ visualViewport: { height: 476, scale: 1 }, scrollY: 180 }).scrolledWindowTo, [0, 0]);
  assert.equal(fit({ visualViewport: { height: 476, scale: 1 }, scrollY: 0 }).scrolledWindowTo, null);
});

test("the newest message stays in view when the keyboard opens", () => {
  assert.equal(fit({ visualViewport: { height: 476, scale: 1 }, stick: true }).scrolledListToBottom, true);
});

test("someone reading older messages is not yanked to the bottom", () => {
  assert.equal(fit({ visualViewport: { height: 476, scale: 1 }, stick: false }).scrolledListToBottom, false);
});

/* ══════════════════════════════════════════
   app.js — that it is wired up
══════════════════════════════════════════ */

test("fitToVisibleArea runs at load and whenever the visible area changes", () => {
  /* A correct function nothing calls is worth nothing. */
  assert.match(app, /visualViewport\.addEventListener\("resize",\s*fitToVisibleArea\)/);
  assert.match(app, /visualViewport\.addEventListener\("scroll",\s*fitToVisibleArea\)/);
  assert.match(app, /window\.addEventListener\("resize",\s*fitToVisibleArea\)/);
  assert.match(app, /^fitToVisibleArea\(\);/m, "must also run once at load, before any resize happens");
});
