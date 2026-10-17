/*
  Headphones connected mid-call.

  Reported: Bluetooth headphones connected during a video call on an iPhone,
  and the other person went on coming out of the phone's speaker. There a
  call's sound goes wherever its microphone is, and the call's microphone was
  the phone's own, opened before the headphones arrived.

  So a change in the phone's microphones, mid-call, opens the microphone again
  — picking what the phone now prefers — and swaps it into the call in place.
  The decision is G.mayMoveMic; followAudioDevice() is lifted out of app.js and
  run against stand-in devices for what it has to get right:

    - only a change in microphones does anything, not a camera
    - the new microphone goes into the same sender: no new call
    - the old one is stopped only once the new one is in, so a failure leaves
      the call its sound
    - muted stays muted; a hang-up while it opens leaves nothing running

  Whether the sound then reaches the headphones is the phone's doing, and only
  a phone can show it.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const G   = require("../guards.js");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

/* ══════════════════════════════════════════
   The decision
══════════════════════════════════════════ */

test("the microphone is opened again only in a call that has one, one change at a time", () => {
  for (const inCall of [true, false, "true", undefined]) {
    for (const hasAudio of [true, false, undefined]) {
      for (const busy of [true, false, undefined]) {
        assert.equal(G.mayMoveMic({ inCall, hasAudio, busy }), inCall === true && hasAudio === true && !busy,
          `inCall ${inCall}, hasAudio ${hasAudio}, busy ${busy}`);
      }
    }
  }
  assert.equal(G.mayMoveMic(undefined), false);
});

/* ══════════════════════════════════════════
   followAudioDevice(), actually run
══════════════════════════════════════════ */

const grab = (pattern, what) => {
  const m = app.match(pattern);
  assert.ok(m, `${what} not found in app.js`);
  return m[0];
};
const SOURCE = [
  grab(/^async function audioInputsNow\(\)\s*\{[\s\S]*?^\}/m,     "audioInputsNow"),
  grab(/^async function followAudioDevice\(\)\s*\{[\s\S]*?^\}/m,  "followAudioDevice")
].join("\n");

const PHONE   = [{ kind: "audioinput", deviceId: "a1", label: "iPhone Microphone" }, { kind: "videoinput", deviceId: "v1", label: "Front Camera" }];
const AIRPODS = [...PHONE, { kind: "audioinput", deviceId: "a2", label: "AirPods" }];

function call({ inCall = true, audio = true, muted = false, busy = false, refuse = false, devices = AIRPODS } = {}) {
  const log = { order: [], asked: [], replaced: [], attached: [], watched: [] };
  let gate = null;
  const track = (kind, name) => ({ kind, name, readyState: "live", enabled: true,
    stop() { this.readyState = "ended"; log.order.push(`stop ${name}`); } });
  class MediaStream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
  }
  const mic = audio ? track("audio", "phone mic") : null, cam = track("video", "camera");
  const senders = [mic, cam].filter(Boolean).map(t => ({
    track: t, replaceTrack(n) { log.order.push(`replace with ${n.name}`); log.replaced.push(n); this.track = n; return Promise.resolve(); }
  }));
  const env = {
    G, MediaStream,
    console: { error() {} },
    watchCallTrack: t => log.watched.push(t),
    attachCallTrack: async t => { log.attached.push(t); },
    navigator: { mediaDevices: {
      enumerateDevices: async () => devices,
      getUserMedia: async constraints => {
        log.asked.push(constraints);
        log.order.push("open");
        if (gate) await gate;
        if (refuse) throw new Error("NotReadableError");
        return new MediaStream([track("audio", "headphones mic")]);
      }
    } },
    state: { inCall, isMuted: muted, restartingCallMedia: busy, callPc: { getSenders: () => senders },
             localStream: new MediaStream([mic, cam].filter(Boolean)),
             audioInputsSeen: "a1|iPhone Microphone" }
  };
  const names = Object.keys(env).filter(n => n !== "state");
  const api = new Function(...names, "state", `
    let { inCall, isMuted, restartingCallMedia, callPc, localStream, audioInputsSeen } = state;
    ${SOURCE}
    return {
      followAudioDevice,
      now: () => ({ inCall, restartingCallMedia, localStream, audioInputsSeen }),
      hangUp: () => { inCall = false; localStream = null; }
    };
  `)(...names.map(n => env[n]), env.state);
  return { ...api, log, mic, cam, senders,
           hold: () => { let open; gate = new Promise(r => { open = r; }); return () => { gate = null; open(); }; } };
}

test("headphones connected: the microphone is opened again, swapped in, and only then the old one stopped", async () => {
  const c = call();
  await c.followAudioDevice();
  assert.deepEqual(c.log.asked, [{ audio: true, video: false }], "the phone's preferred microphone, the camera untouched");
  assert.deepEqual(c.log.order, ["open", "replace with headphones mic", "stop phone mic"],
    "stopped after the swap, so a failure would have left the call its sound");
  assert.equal(c.senders[0].track.name, "headphones mic", "the same sender: no new call");
  assert.equal(c.senders[1].track, c.cam, "the camera's sender is left alone");
  assert.equal(c.log.attached.length, 0);
  assert.equal(c.log.watched[0].name, "headphones mic", "watched like every call track, for a lock");
});

test("the call's stream holds the new microphone and the same camera", async () => {
  const c = call();
  await c.followAudioDevice();
  const { localStream } = c.now();
  assert.deepEqual(localStream.getAudioTracks().map(t => t.name), ["headphones mic"]);
  assert.deepEqual(localStream.getVideoTracks(), [c.cam]);
});

test("muted stays muted", async () => {
  const c = call({ muted: true });
  await c.followAudioDevice();
  assert.equal(c.now().localStream.getAudioTracks()[0].enabled, false);
});

test("a change that is only a camera leaves the microphone alone", async () => {
  const c = call({ devices: [...PHONE, { kind: "videoinput", deviceId: "v2", label: "Back Camera" }] });
  await c.followAudioDevice();
  assert.equal(c.log.asked.length, 0);
});

test("no call, a call without a microphone, or another change under way: nothing opens", async () => {
  for (const setup of [{ inCall: false }, { audio: false }, { busy: true }]) {
    const c = call(setup);
    await c.followAudioDevice();
    assert.equal(c.log.asked.length, 0, JSON.stringify(setup));
  }
});

test("hung up while it was opening: the new microphone is put straight back", async () => {
  const c = call();
  const release = c.hold();
  const moving = c.followAudioDevice();
  c.hangUp();
  release();
  await moving;
  assert.deepEqual(c.log.order, ["open", "stop headphones mic"]);
  assert.equal(c.log.replaced.length, 0);
});

test("the new microphone will not open: the call keeps the one it had", async () => {
  const c = call({ refuse: true });
  await c.followAudioDevice();
  assert.equal(c.mic.readyState, "live", "not stopped — the call still has its sound");
  assert.equal(c.senders[0].track, c.mic);
  assert.equal(c.now().restartingCallMedia, false, "the flip and the restart after a lock may run again");
});

/* ══════════════════════════════════════════
   That it is wired up
══════════════════════════════════════════ */

test("a device change mid-call is followed, once it settles; each call notes what it started with", () => {
  assert.match(app, /navigator\.mediaDevices\?\.addEventListener\?\.\("devicechange", \(\) => \{\s*\n\s*clearTimeout\(audioChangeTimer\);\s*\n\s*audioChangeTimer = setTimeout\(followAudioDevice, \d+\);/);
  const attach = grab(/^async function attachCallMedia\([^)]*\)\s*\{[\s\S]*?^\}/m, "attachCallMedia");
  assert.ok(attach.lastIndexOf("noteAudioInputs()") > attach.lastIndexOf("attachCallTrack("),
    "noted once the call's own microphone is open, so the list includes it");
});
