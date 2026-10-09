/*
  Integration tests for the signaling server: join rules, brute-force limits,
  and the heartbeat that drops clients which vanish without disconnecting.

  Spawns a real server on a spare port with a short heartbeat interval, so the
  vanish test finishes in seconds rather than a minute.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path   = require("node:path");
const http   = require("node:http");
const WebSocket = require("ws");

const PORT   = 3199;
const URL    = `ws://127.0.0.1:${PORT}`;
const ORIGIN = "http://localhost:3000";   // must be in the server's allowlist

let server;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* The server keys its rate limits on the client IP, and getClientIp() trusts
   X-Forwarded-For. Handing every client its own address keeps one test's
   lockout from leaking into the next — without it, the brute-force test locks
   the shared address for 30s and everything after it fails to join. */
let nextIp = 0;
function freshIp() {
  nextIp++;
  return `10.${(nextIp >> 16) & 255}.${(nextIp >> 8) & 255}.${nextIp & 255}`;
}

function connect(ip = freshIp()) {
  const ws = new WebSocket(URL, { origin: ORIGIN, headers: { "x-forwarded-for": ip } });
  ws.inbox = [];
  ws.testIp = ip;
  ws.on("message", raw => { try { ws.inbox.push(JSON.parse(raw)); } catch (_) {} });
  ws.send_ = obj => ws.send(JSON.stringify(obj));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function waitFor(ws, type, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = ws.inbox.find(m => m.type === type);
    if (hit) return hit;
    await sleep(25);
  }
  return null;
}

const open = [];
async function client() {
  const ws = await connect();
  open.push(ws);
  return ws;
}

test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, "..", "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), HEARTBEAT_MS: "1000" },
    stdio: "ignore"
  });
  // wait for the port to accept connections
  for (let i = 0; i < 60; i++) {
    try { (await connect()).close(); return; } catch (_) { await sleep(100); }
  }
  throw new Error("server did not start");
});

test.after(() => {
  for (const ws of open) { try { ws.terminate(); } catch (_) {} }
  if (server) server.kill();
});

/* ══════════════════════════════════════════
   Session lifecycle
══════════════════════════════════════════ */

test("creating a room returns a 6-digit PIN and a token", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-basic" });
  const created = await waitFor(host, "session-created");
  assert.ok(created, "no session-created");
  assert.match(created.pin, /^\d{6}$/);
  assert.ok(created.token && created.token.length >= 20);
});

test("a duplicate room name is refused", async () => {
  const a = await client();
  a.send_({ type: "create-session", sessionId: "room-dup" });
  await waitFor(a, "session-created");

  const b = await client();
  b.send_({ type: "create-session", sessionId: "room-dup" });
  assert.ok(await waitFor(b, "error"), "duplicate name should be refused");
});

test("invalid room names are refused", async () => {
  const ws = await client();
  for (const bad of ["", "  padded  ", "x".repeat(81), "bad<>name"]) {
    ws.inbox.length = 0;
    ws.send_({ type: "create-session", sessionId: bad });
    assert.ok(await waitFor(ws, "error", 1500), `should reject: ${JSON.stringify(bad)}`);
  }
});

test("the correct PIN admits a guest and notifies the host", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-join" });
  const created = await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-join", pin: created.pin });
  assert.ok(await waitFor(guest, "session-joined"), "guest not admitted");
  assert.ok(await waitFor(host, "guest-joined"),   "host not told");
});

test("the invite token admits a guest without the PIN", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-token" });
  const created = await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-token", token: created.token });
  assert.ok(await waitFor(guest, "session-joined"));
});

test("joining an unknown room reports not-found", async () => {
  const ws = await client();
  ws.send_({ type: "join-session", sessionId: "no-such-room", pin: "123456" });
  const err = await waitFor(ws, "pin-error");
  assert.equal(err.code, "not-found");
});

test("a full room refuses a third participant", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-full" });
  const created = await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-full", pin: created.pin });
  await waitFor(guest, "session-joined");

  const third = await client();
  third.send_({ type: "join-session", sessionId: "room-full", pin: created.pin });
  const err = await waitFor(third, "pin-error");
  assert.equal(err.code, "full");
});

/* ══════════════════════════════════════════
   Brute-force protection
══════════════════════════════════════════ */

test("wrong PINs lock the joiner out after three attempts", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-brute" });
  const created = await waitFor(host, "session-created");
  const wrong = created.pin === "000000" ? "111111" : "000000";

  const guest = await client();
  const codes = [];
  for (let i = 0; i < 4; i++) {
    guest.inbox.length = 0;
    guest.send_({ type: "join-session", sessionId: "room-brute", pin: wrong });
    const err = await waitFor(guest, "pin-error");
    codes.push(err && err.code);
  }
  assert.deepEqual(codes.slice(0, 2), ["wrong-pin", "wrong-pin"]);
  assert.equal(codes[2], "rate-limited", "third wrong PIN should trigger lockout");
  assert.equal(codes[3], "rate-limited", "still locked out afterwards");
});

/* ══════════════════════════════════════════
   Heartbeat — clients that vanish silently
══════════════════════════════════════════ */

test("a peer that stops responding is dropped and the room is freed", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-ghost" });
  const created = await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-ghost", pin: created.pin });
  await waitFor(guest, "session-joined");
  await waitFor(host, "guest-joined");

  /* Simulate a phone losing signal: the socket stays open at the TCP level but
     the client never reads, so it never answers a ping. A close frame is never
     sent, which is exactly the case the heartbeat exists for. */
  host.inbox.length = 0;
  guest._socket.pause();

  const gone = await waitFor(host, "peer-disconnected", 6000);
  assert.ok(gone, "surviving peer was never told the other side vanished");

  /* The real symptom of a leaked room is its name staying reserved. */
  await sleep(300);
  const reuse = await client();
  reuse.send_({ type: "create-session", sessionId: "room-ghost" });
  assert.ok(await waitFor(reuse, "session-created", 2000), "room name was not released");
});

test("a healthy client survives several heartbeat sweeps", async () => {
  const ws = await client();
  ws.send_({ type: "create-session", sessionId: "room-healthy" });
  await waitFor(ws, "session-created");
  await sleep(3500);                       // ~3 sweeps at HEARTBEAT_MS=1000
  assert.equal(ws.readyState, WebSocket.OPEN);
});

/* ══════════════════════════════════════════
   POST /api/send-message

   The endpoint parses uploads, so a malformed request reaches real parsing code
   before any auth or rate limit applies. What matters in every case below is
   not the status code but that the process is still serving afterwards: an
   uncaught throw here kills the signaling server and every room with it.
══════════════════════════════════════════ */

function post(body, headers) {
  return new Promise(resolve => {
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: "/api/send-message", method: "POST",
      headers: { "Content-Length": Buffer.byteLength(body), ...headers }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", err => resolve({ error: err.code || err.message }));
    req.setTimeout(4000, () => { req.destroy(); resolve({ error: "TIMEOUT" }); });
    req.end(body);
  });
}

/** True while the server is still answering requests. */
async function stillServing() {
  const res = await new Promise(resolve => {
    const r = http.get({ host: "127.0.0.1", port: PORT, path: "/api/ping" }, res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode }));
    });
    r.on("error", err => resolve({ error: err.code }));
    r.setTimeout(3000, () => { r.destroy(); resolve({ error: "TIMEOUT" }); });
  });
  return res.status === 200;
}

test("a non-multipart body does not take the server down", async () => {
  /* multer only fills req.body for multipart requests, and no body parser is
     mounted, so req.body is undefined here. Destructuring it threw, and because
     the handler is async the rejection was unhandled — which ends the process.
     One request, with a header the client documents, dropped every live chat. */
  const live = await client();             // a real user, mid-session
  live.send_({ type: "create-session", sessionId: "room-survives-json" });
  assert.ok(await waitFor(live, "session-created"), "setup: room not created");

  const res = await post('{"message":"hi"}', {
    "Content-Type": "application/json",
    "X-DC-Client": "1"
  });

  assert.notEqual(res.error, "ECONNRESET", "the server dropped the connection — it crashed");
  assert.ok(await stillServing(), "the server stopped answering after one malformed request");
  assert.equal(live.readyState, WebSocket.OPEN, "a live session was dropped with the process");
});

test("an empty body with no content type does not take the server down", async () => {
  const res = await post("", { "X-DC-Client": "1" });
  assert.notEqual(res.error, "ECONNRESET");
  assert.ok(await stillServing(), "the server stopped answering");
});

test("a form-encoded body does not take the server down", async () => {
  const res = await post("message=hi", {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-DC-Client": "1"
  });
  assert.notEqual(res.error, "ECONNRESET");
  assert.ok(await stillServing(), "the server stopped answering");
});

test("a request without the client header is refused before any parsing", async () => {
  const res = await post('{"message":"hi"}', { "Content-Type": "application/json" });
  assert.equal(res.status, 403, "drive-by posts must be refused");
});

/* The status code is the evidence of ordering here. multer buffers the whole
   upload into memory, so a check placed after it has already spent the RAM. An
   over-sized body would trip multer's own limit and answer 413 — seeing the
   cheap header/limit rejection instead proves nothing read the body. */

/** A multipart body larger than LEAVE_MESSAGE_MAX_FILE_BYTES (28 MB default). */
function oversizedUpload() {
  const B = "----dcOversize";
  const head = Buffer.from(
    `--${B}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`);
  const payload = Buffer.alloc(30 * 1024 * 1024, 0x41);
  const tail = Buffer.from(`\r\n--${B}--\r\n`);
  return { body: Buffer.concat([head, payload, tail]), type: `multipart/form-data; boundary=${B}` };
}

test("an unauthorised upload is refused before its body is buffered", async () => {
  const up = oversizedUpload();
  const res = await post(up.body, { "Content-Type": up.type });   // no X-DC-Client
  assert.equal(res.status, 403,
    "expected the header check first; 413 would mean multer buffered 30 MB from a stranger");
  assert.ok(await stillServing());
});

test("a rate-limited upload is refused before its body is buffered", async () => {
  /* Burn the allowance with cheap requests, then send something large. */
  const headers = { "Content-Type": "application/json", "X-DC-Client": "1", "X-Forwarded-For": "198.51.100.44" };
  for (let i = 0; i < 6; i++) await post('{"message":"x"}', headers);

  const up = oversizedUpload();
  const res = await post(up.body, {
    "Content-Type": up.type, "X-DC-Client": "1", "X-Forwarded-For": "198.51.100.44"
  });
  assert.equal(res.status, 429,
    "expected the rate limit first; 413 would mean the limit ran after buffering");
  assert.ok(await stillServing());
});

test("an oversized upload from an allowed client is still rejected by multer", async () => {
  /* The guards must not have replaced the size limit — only moved ahead of it. */
  const up = oversizedUpload();
  const res = await post(up.body, {
    "Content-Type": up.type, "X-DC-Client": "1", "X-Forwarded-For": "198.51.100.55"
  });
  assert.equal(res.status, 413, "the file-size limit must still apply to legitimate clients");
  assert.ok(await stillServing());
});

/* ══════════════════════════════════════════
   Privacy
══════════════════════════════════════════ */

test("occupied rooms are hidden from the lobby list", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-listing" });
  const created = await waitFor(host, "session-created");

  const probe = await client();
  probe.send_({ type: "list-sessions" });
  const before = await waitFor(probe, "session-list");
  assert.ok(before.sessions.some(s => s.sessionId === "room-listing"), "waiting room should be listed");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-listing", pin: created.pin });
  await waitFor(guest, "session-joined");

  probe.inbox.length = 0;
  probe.send_({ type: "list-sessions" });
  const after = await waitFor(probe, "session-list");
  assert.ok(!after.sessions.some(s => s.sessionId === "room-listing"), "occupied room should be hidden");
});

/* ══════════════════════════════════════════
   WebSocket input that is valid JSON but not a message
══════════════════════════════════════════ */

test("a JSON value that is not an object does not take the server down", async () => {
  /* JSON.parse is happy with `null`, and reading `.type` off null throws. A
     "message" listener that throws is an uncaught exception, which ends the
     process — so four characters from anyone dropped every room and every call
     in progress. As with the upload tests above, the evidence that matters is
     that a bystander is still connected afterwards. */
  const live = await client();
  live.send_({ type: "create-session", sessionId: "room-survives-null" });
  assert.ok(await waitFor(live, "session-created"), "setup: room not created");

  const hostile = await client();
  for (const frame of ["null", "7", "\"text\"", "[]", "[null]", "true", "{}", "{\"type\":null}"]) {
    hostile.send(frame);
  }
  await sleep(300);

  assert.ok(await stillServing(), "the server stopped answering after a non-object message");
  assert.equal(live.readyState, WebSocket.OPEN, "a live session was dropped with the process");

  /* The socket that sent them is not punished either — it just was not heard. */
  hostile.send_({ type: "list-sessions" });
  assert.ok(await waitFor(hostile, "session-list"), "the sender's own socket should still work");
});

/* ══════════════════════════════════════════
   Which lock applies to which credential
══════════════════════════════════════════ */

/** Sends three wrong PINs from one address and waits for all three answers. */
async function threeWrongPins(sessionId, wrong) {
  const stranger = await client();
  for (let i = 0; i < 3; i++) stranger.send_({ type: "join-session", sessionId, pin: wrong });
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && stranger.inbox.filter(m => m.type === "pin-error").length < 3) await sleep(25);
}

test("a valid invite link still works while wrong PINs have the room locked", async () => {
  /* Room names are listed publicly, so anyone can lock any room: fifteen wrong
     PINs. That used to turn away the invited guest as well, for five minutes
     at a time, for as long as someone kept it up. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-locked" });
  const created = await waitFor(host, "session-created");
  const wrong = created.pin === "000000" ? "111111" : "000000";

  for (let i = 0; i < 5; i++) await threeWrongPins("room-locked", wrong);   // 5 addresses x 3

  /* The lock is real, and it holds even against the right PIN — otherwise it
     would stop nothing and a guesser would just carry on. */
  const typed = await client();
  typed.send_({ type: "join-session", sessionId: "room-locked", pin: created.pin });
  const refused = await waitFor(typed, "pin-error");
  assert.equal(refused && refused.code, "session-join-locked", "setup: the room should be locked by now");

  const invited = await client();
  invited.send_({ type: "join-session", sessionId: "room-locked", token: created.token });
  assert.ok(await waitFor(invited, "session-joined"),
    "the holder of a valid invite link was locked out by someone else's wrong PINs");
});

test("a wrong token during a lock learns nothing but that the room is locked", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-locked-2" });
  const created = await waitFor(host, "session-created");
  const wrong = created.pin === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) await threeWrongPins("room-locked-2", wrong);

  const guesser = await client();
  guesser.send_({ type: "join-session", sessionId: "room-locked-2", token: "x".repeat(created.token.length) });
  const err = await waitFor(guesser, "pin-error");
  assert.equal(err && err.code, "session-join-locked");
});

/* ══════════════════════════════════════════
   One room per socket
══════════════════════════════════════════ */

test("a host cannot join their own room", async () => {
  /* It is in the lobby list like any other room and the PIN is on screen. It
     used to be admitted, leaving one browser negotiating with itself. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-own" });
  const created = await waitFor(host, "session-created");

  host.send_({ type: "join-session", sessionId: "room-own", pin: created.pin });
  const err = await waitFor(host, "pin-error");
  assert.equal(err && err.code, "own-room");

  /* ...and the attempt did not damage the room. */
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-own", token: created.token });
  assert.ok(await waitFor(guest, "session-joined"), "the room should still accept its real guest");
});

test("opening a second room lets go of the first", async () => {
  /* The first used to stay listed with nobody behind it: a guest who joined
     waited on a host who was elsewhere, and its expiry ten minutes later ended
     the chat in the second room. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-first" });
  const first = await waitFor(host, "session-created");
  host.inbox.length = 0;
  host.send_({ type: "create-session", sessionId: "room-second" });
  const second = await waitFor(host, "session-created");
  assert.equal(second && second.sessionId, "room-second");

  const late = await client();
  late.send_({ type: "join-session", sessionId: "room-first", token: first.token });
  const err = await waitFor(late, "pin-error");
  assert.equal(err && err.code, "not-found", "the abandoned room should be gone, not waiting on a host who left it");

  const other = await client();
  other.send_({ type: "create-session", sessionId: "room-first" });
  assert.ok(await waitFor(other, "session-created", 2000), "the abandoned room's name was not released");
});

test("a failed attempt to open a second room leaves the first alone", async () => {
  const taken = await client();
  taken.send_({ type: "create-session", sessionId: "room-taken" });
  await waitFor(taken, "session-created");

  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-keeps" });
  const kept = await waitFor(host, "session-created");
  host.send_({ type: "create-session", sessionId: "room-taken" });   // refused: name in use
  assert.ok(await waitFor(host, "error"), "setup: the duplicate name should be refused");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-keeps", token: kept.token });
  assert.ok(await waitFor(guest, "session-joined"), "a refused create must not cost the host the room they had");
});

test("joining someone else's room lets go of your own", async () => {
  const other = await client();
  other.send_({ type: "create-session", sessionId: "room-theirs" });
  const theirs = await waitFor(other, "session-created");

  const mover = await client();
  mover.send_({ type: "create-session", sessionId: "room-mine" });
  const mine = await waitFor(mover, "session-created");
  mover.send_({ type: "join-session", sessionId: "room-theirs", token: theirs.token });
  assert.ok(await waitFor(mover, "session-joined"), "setup: the move should succeed");

  const late = await client();
  late.send_({ type: "join-session", sessionId: "room-mine", token: mine.token });
  const err = await waitFor(late, "pin-error");
  assert.equal(err && err.code, "not-found", "the room its host walked away from should be gone");
});

test("a peer leaving is reported with the room it happened in", async () => {
  /* Without a name the client had to assume its current room, and was wrong
     whenever it had moved on. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-named" });
  const created = await waitFor(host, "session-created");
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-named", token: created.token });
  await waitFor(guest, "session-joined");

  guest.send_({ type: "leave-session" });
  const gone = await waitFor(host, "peer-disconnected");
  assert.equal(gone && gone.sessionId, "room-named");
});
