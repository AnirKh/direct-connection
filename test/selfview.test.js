/*
  Tests for the self-view in a video call — your own picture, in the corner.

  Two things were asked for:

    mirrored    you see yourself as in a mirror, the other side sees you the
                right way round. So the flip is a CSS transform on #localVideo
                and nothing else: the camera track that is sent is never
                touched, and #remoteVideo is never flipped.
    movable     it can be dragged anywhere inside the call, and can never end
                up outside it — not when dragged past an edge, not when the
                phone turns on its side, not when the call is hidden and
                reports a size of 0.

  Dragging needs a real pointer and a real page, so what is run here is the
  placement: selfViewPosition, moveSelfView and keepSelfViewInside are lifted
  out of app.js and run against stand-in elements.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const css  = read("style.css");
const app  = read("app.js");

const withoutCssComments = src => src.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every CSS rule, media queries included, as { selector, body }. */
function rules() {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(withoutCssComments(css)))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

/** The declarations of one top-level CSS rule, by exact selector. */
function rule(selector) {
  return (rules().find(r => r.selector === selector) || {}).body || null;
}

const lift = name => (app.match(new RegExp(`^function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m")) || [])[0];
const positionSrc = lift("selfViewPosition");
const moveSrc     = lift("moveSelfView");
const keepSrc     = lift("keepSelfViewInside");

/* ══════════════════════════════════════════
   Mirrored here, not on the wire
══════════════════════════════════════════ */

test("your own picture is mirrored", () => {
  const body = rule("#localVideo");
  assert.ok(body, "#localVideo rule not found");
  assert.match(body, /transform:\s*scaleX\(-1\)/);
});

test("the other person's picture is never mirrored", () => {
  /* Text in their background would read backwards, and it is not how they
     look. Any rule that reaches #remoteVideo must leave its transform alone. */
  const touching = rules().filter(r => /#remoteVideo\b/.test(r.selector));
  assert.ok(touching.length, "no rule for #remoteVideo found");
  for (const r of touching) {
    assert.ok(!/(^|[\s;])transform\s*:/.test(r.body), `${r.selector} sets a transform`);
    assert.ok(!/(^|[\s;])scale\s*:/.test(r.body), `${r.selector} sets a scale`);
  }
});

test("the mirror is the stylesheet's alone — app.js flips nothing", () => {
  /* Flipping in script — on an element, or by redrawing the camera through a
     canvas — is how a mirror image would end up being sent. */
  assert.ok(!/\.style\.transform\b/.test(app), "app.js sets a transform on an element");
  assert.ok(!/setProperty\(\s*["']transform["']/.test(app), "app.js sets a transform on an element");
  assert.ok(!/captureStream\s*\(/.test(app), "app.js redraws a stream — the sent picture may no longer be the camera's");
});

test("what is sent is the camera's own tracks", () => {
  const body = (app.match(/^async function attachCallMedia\([^)]*\)\s*\{[\s\S]*?^\}/m) || [])[0];
  assert.ok(body, "attachCallMedia not found as a top-level function in app.js");
  assert.match(body, /localStream = await navigator\.mediaDevices\.getUserMedia\(/);
  assert.match(body, /for \(const track of localStream\.getTracks\(\)\)\s*\{\s*await attachCallTrack\(track, localStream\);/);
});

/* ══════════════════════════════════════════
   selfViewPosition, actually run
══════════════════════════════════════════ */

const selfViewPosition = positionSrc && new Function(`${positionSrc}; return selfViewPosition;`)();
const place = (x, y, more = {}) =>
  selfViewPosition({ x, y, w: 156, h: 88, areaW: 800, areaH: 600, margin: 8, ...more });

test("the placement functions are where the test expects them", () => {
  assert.ok(positionSrc, "selfViewPosition not found as a top-level function in app.js");
  assert.ok(moveSrc, "moveSelfView not found as a top-level function in app.js");
  assert.ok(keepSrc, "keepSelfViewInside not found as a top-level function in app.js");
});

test("it goes where it is put", () => {
  assert.deepEqual(place(300, 200), { x: 300, y: 200 });
});

test("it cannot be dragged past any edge", () => {
  assert.deepEqual(place(-500, 200), { x: 8, y: 200 }, "left");
  assert.deepEqual(place(300, -500), { x: 300, y: 8 }, "top");
  assert.deepEqual(place(5000, 200), { x: 800 - 156 - 8, y: 200 }, "right");
  assert.deepEqual(place(300, 5000), { x: 300, y: 600 - 88 - 8 }, "bottom");
  assert.deepEqual(place(5000, 5000), { x: 636, y: 504 }, "corner");
});

test("a picture bigger than the call is pinned to the top left, not pushed off it", () => {
  assert.deepEqual(place(300, 200, { areaW: 100, areaH: 50 }), { x: 8, y: 8 });
});

test("with nothing to measure against, there is no answer", () => {
  /* The call is hidden between calls and reports a size of 0. Clamping to that
     would throw the picture into the corner the user moved it out of. */
  for (const more of [{ areaW: 0 }, { areaH: 0 }, { w: 0 }, { h: 0 }, { areaW: NaN }]) {
    assert.equal(place(300, 200, more), null, JSON.stringify(more));
  }
  assert.equal(place(NaN, 200), null);
  assert.equal(place(300, Infinity), null);
});

/* ══════════════════════════════════════════
   moveSelfView / keepSelfViewInside against stand-in elements
══════════════════════════════════════════ */

function stage({ left = "", top = "", w = 156, h = 88, areaW = 800, areaH = 600, mini = false } = {}) {
  const localVideo  = { offsetWidth: w, offsetHeight: h, style: { left, top, right: "", bottom: "" } };
  const callOverlay = { clientWidth: areaW, clientHeight: areaH };
  const fns = new Function("localVideo", "callOverlay", "SELF_VIEW_MARGIN", "callMini",
    `${positionSrc}\n${moveSrc}\n${keepSrc}\nreturn { moveSelfView, keepSelfViewInside };`
  )(localVideo, callOverlay, 8, mini);
  return { localVideo, callOverlay, ...fns };
}

test("moving it takes it out of its corner", () => {
  /* The CSS corner is set with right/bottom; left/top alone would stretch it. */
  const s = stage();
  s.moveSelfView(120, 90);
  assert.deepEqual(s.localVideo.style, { left: "120px", top: "90px", right: "auto", bottom: "auto" });
});

test("one never moved is left to the stylesheet", () => {
  const s = stage();
  s.keepSelfViewInside();
  assert.deepEqual(s.localVideo.style, { left: "", top: "", right: "", bottom: "" });
});

test("turning the phone brings it back inside", () => {
  /* Put near the bottom right in landscape, then the call becomes portrait. */
  const s = stage({ areaW: 800, areaH: 400 });
  s.moveSelfView(630, 300);
  s.callOverlay.clientWidth = 390;
  s.callOverlay.clientHeight = 760;
  s.keepSelfViewInside();
  assert.equal(s.localVideo.style.left, `${390 - 156 - 8}px`);
  assert.equal(s.localVideo.style.top, "300px");
});

test("hiding the call does not lose where it was put", () => {
  const s = stage();
  s.moveSelfView(400, 300);
  s.callOverlay.clientWidth = 0;
  s.callOverlay.clientHeight = 0;
  s.keepSelfViewInside();
  assert.equal(s.localVideo.style.left, "400px");
  assert.equal(s.localVideo.style.top, "300px");
});

test("making the call small, to use the chat, does not lose where it was put either", () => {
  /* Small, the self-view sits beside theirs in the small call (style.css), and the
     small call measures a fraction of the full one: held to that, it would
     come back somewhere else. */
  const s = stage({ mini: true, left: "400px", top: "300px" });
  s.callOverlay.clientWidth = 117;
  s.callOverlay.clientHeight = 156;
  s.keepSelfViewInside();
  assert.equal(s.localVideo.style.left, "400px");
  assert.equal(s.localVideo.style.top, "300px");
});

/* ══════════════════════════════════════════
   That it is wired up
══════════════════════════════════════════ */

test("a finger or the mouse can drag it", () => {
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    assert.match(app, new RegExp(`localVideo\\.addEventListener\\("${type}"`), `no ${type} listener on localVideo`);
  }
  assert.match(app, /localVideo\.setPointerCapture\(/, "without capture a fast drag slips off the picture and stops");
  const body = rule("#localVideo");
  assert.match(body, /touch-action:\s*none/, "without it a finger drag scrolls the page instead");
});

test("it is put back inside whenever the call or the picture changes size", () => {
  assert.match(app, /new ResizeObserver\(keepSelfViewInside\)/);
  assert.match(app, /\.observe\(callOverlay\)/);
  assert.match(app, /\.observe\(localVideo\)/);
});
