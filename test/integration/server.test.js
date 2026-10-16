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
    env: { ...process.env, PORT: String(PORT), HEARTBEAT_MS: "1000", HOST_AWAY_MS: "1500" },
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

/* ══════════════════════════════════════════
   Open rooms — created without a PIN
══════════════════════════════════════════ */

async function listed(sessionId) {
  const probe = await client();
  probe.send_({ type: "list-sessions" });
  const list = await waitFor(probe, "session-list");
  return list.sessions.find(s => s.sessionId === sessionId) || null;
}

test("an open room is created without a PIN and listed as open", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-basic", open: true });
  const created = await waitFor(host, "session-created");
  assert.ok(created, "no session-created");
  assert.equal(created.open, true);
  assert.equal(created.pin, null, "an open room has no PIN to hand out");
  assert.ok(created.token && created.token.length >= 20, "it still gets a token for the invite link");

  const entry = await listed("open-basic");
  assert.ok(entry, "the open room should be in the list");
  assert.equal(entry.open, true);
});

test("an ordinary room is listed as not open", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-not" });
  const created = await waitFor(host, "session-created");
  assert.equal(created.open, false);
  assert.match(created.pin, /^\d{6}$/);
  assert.equal((await listed("open-not")).open, false);
});

test("only exactly open:true makes a room open", async () => {
  /* A room must never become open by accident — not from a string, a number,
     or a field someone added for another reason. */
  let n = 0;
  for (const value of ["true", 1, "yes", {}, [], null]) {
    const host = await client();
    const name = `open-strict-${n++}`;
    host.send_({ type: "create-session", sessionId: name, open: value });
    const created = await waitFor(host, "session-created");
    assert.equal(created.open, false, `open:${JSON.stringify(value)} must still make a PIN room`);
    assert.match(created.pin, /^\d{6}$/);

    const stranger = await client();
    stranger.send_({ type: "join-session", sessionId: name });
    const refused = await waitFor(stranger, "pin-error");
    assert.equal(refused && refused.code, "pin-required", `open:${JSON.stringify(value)} let a stranger in`);
  }
});

test("anyone can join an open room with nothing but its name", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-join", open: true });
  await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "open-join" });
  assert.ok(await waitFor(guest, "session-joined"), "the guest should be let straight in");
  assert.ok(await waitFor(host, "guest-joined"), "the host should be told");
});

test("an open room still holds only one guest", async () => {
  /* "No PIN" is not "no limit". */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-one", open: true });
  await waitFor(host, "session-created");

  const first = await client();
  first.send_({ type: "join-session", sessionId: "open-one" });
  assert.ok(await waitFor(first, "session-joined"));

  const second = await client();
  second.send_({ type: "join-session", sessionId: "open-one" });
  const refused = await waitFor(second, "pin-error");
  assert.equal(refused && refused.code, "full");

  assert.equal(await listed("open-one"), null, "an occupied open room should leave the list");
});

test("an open room lets in someone whose address is locked out of a PIN room", async () => {
  /* The lockout is for PIN guessing. It says nothing about a room with no PIN. */
  const pinHost = await client();
  pinHost.send_({ type: "create-session", sessionId: "open-vs-lock-pin" });
  const pinRoom = await waitFor(pinHost, "session-created");
  const wrong = pinRoom.pin === "000000" ? "111111" : "000000";

  const person = await client();
  for (let i = 0; i < 3; i++) person.send_({ type: "join-session", sessionId: "open-vs-lock-pin", pin: wrong });
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && person.inbox.filter(m => m.type === "pin-error").length < 3) await sleep(25);
  assert.equal(person.inbox.filter(m => m.code === "rate-limited").length >= 1, true, "setup: the address should be locked out");

  const openHost = await client();
  openHost.send_({ type: "create-session", sessionId: "open-vs-lock-open", open: true });
  await waitFor(openHost, "session-created");
  person.send_({ type: "join-session", sessionId: "open-vs-lock-open" });
  assert.ok(await waitFor(person, "session-joined"), "a PIN lockout must not keep someone out of an open room");
});

test("knocking on a PIN room with nothing is not counted as a wrong guess", async () => {
  /* A stale list, or a client that has not asked for the PIN yet. Counting it
     would lock people out for looking — and lock the room for everyone. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-knock" });
  const created = await waitFor(host, "session-created");

  const guest = await client();
  for (let i = 0; i < 6; i++) {
    guest.inbox.length = 0;
    guest.send_({ type: "join-session", sessionId: "open-knock" });
    const answer = await waitFor(guest, "pin-error");
    assert.equal(answer && answer.code, "pin-required", `knock ${i + 1}`);
    assert.equal(answer.sessionId, "open-knock", "the answer should say which room wants a PIN");
  }
  /* Six knocks would be two lockouts' worth of wrong PINs. The right PIN still works. */
  guest.send_({ type: "join-session", sessionId: "open-knock", pin: created.pin });
  assert.ok(await waitFor(guest, "session-joined"), "knocking must not have used up the guest's attempts");
});

test("a host cannot join their own open room either", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-own", open: true });
  await waitFor(host, "session-created");
  host.send_({ type: "join-session", sessionId: "open-own" });
  const refused = await waitFor(host, "pin-error");
  assert.equal(refused && refused.code, "own-room");
});

test("an open room lets in someone who typed a PIN anyway", async () => {
  /* A browser that believed the room wanted a PIN sends one. There is no PIN
     to compare it with — the room's is null — and that must be a plain "no
     match", not an error that leaves the join unanswered. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-with-pin", open: true });
  await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "open-with-pin", pin: "123456" });
  assert.ok(await waitFor(guest, "session-joined"), "a PIN sent to an open room should be ignored, not choked on");
});

/* ══════════════════════════════════════════
   Telling pages which build the server is
══════════════════════════════════════════ */

test("the server names its build the moment a socket connects", async () => {
  /* Every open page reconnects a few seconds after the server restarts for an
     update, so this is how a page left open learns that it is old. */
  const ws = await client();
  const hello = await waitFor(ws, "hello", 2000);
  assert.ok(hello, "no hello on connecting");
  assert.match(hello.build, /^\d{12}-[0-9a-f]{8}$/);

  const fs = require("node:fs");
  const inApp = fs.readFileSync(path.join(__dirname, "..", "..", "app.js"), "utf8").match(/^const APP_BUILD = "([^"]+)";/m)[1];
  assert.equal(hello.build, inApp, "the server must announce the build of the client it ships");
  assert.equal(ws.inbox[0].type, "hello", "it should be the first thing said");
});

test("a page too old to update itself is told to reload", async () => {
  /* Pages from before the handshake cannot act on a build id, but they do show
     the text of an error. They ask for the room list the moment they connect,
     without saying hello — which is how the server recognises them. */
  const oldPage = await client();
  oldPage.send_({ type: "list-sessions" });
  assert.ok(await waitFor(oldPage, "session-list"), "it must still get its list");
  const notice = await waitFor(oldPage, "error", 2000);
  assert.ok(notice, "an old page was not told to reload");
  assert.match(notice.message, /reopen|reload/i);

  /* Once per connection, not on every refresh of the list. */
  oldPage.send_({ type: "list-sessions" });
  oldPage.send_({ type: "list-sessions" });
  await sleep(400);
  assert.equal(oldPage.inbox.filter(m => m.type === "error").length, 1, "the notice should not repeat");
});

test("a current page is not nagged", async () => {
  const page = await client();
  page.send_({ type: "hello", build: "202610131742-3fa9c1d2" });
  page.send_({ type: "list-sessions" });
  assert.ok(await waitFor(page, "session-list"));
  await sleep(400);
  assert.equal(page.inbox.filter(m => m.type === "error").length, 0, "a page that said hello must not get the reload notice");
});

test("a hello with nonsense in it is harmless", async () => {
  const live = await client();
  const ws = await client();
  for (const build of [null, 42, {}, [], "x".repeat(5000), "<script>"]) ws.send_({ type: "hello", build });
  ws.send_({ type: "list-sessions" });
  assert.ok(await waitFor(ws, "session-list"), "the socket should still work");
  assert.ok(await stillServing());
  assert.equal(live.readyState, WebSocket.OPEN);
});

/* ══════════════════════════════════════════
   Code rooms — created without a PIN, admit first-come
══════════════════════════════════════════ */

test("a code room is created without a PIN and listed as a code room", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "code-basic", code: true });
  const created = await waitFor(host, "session-created");
  assert.equal(created.kind, "code");
  assert.equal(created.pin, null, "a code room has no server PIN — the word is proven between the peers");
  assert.ok(created.token, "it still gets a token");

  const probe = await client();
  probe.send_({ type: "list-sessions" });
  const list = await waitFor(probe, "session-list");
  const entry = list.sessions.find(s => s.sessionId === "code-basic");
  assert.ok(entry && entry.kind === "code", "the list must mark it a code room");
});

test("anyone is admitted to a code room with just its name — the word is not a join credential", async () => {
  /* The server never sees the word; it admits like an open room, and the SPAKE2
     handshake between the two browsers is the real gate. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "code-admit", code: true });
  await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "code-admit" });
  assert.ok(await waitFor(guest, "session-joined"), "the guest is admitted; the word is proven afterwards");
  assert.ok(await waitFor(host, "guest-joined"));
});

test("only an explicit code flag makes a code room", async () => {
  let n = 0;
  for (const value of ["code", 1, {}, "true"]) {
    const host = await client();
    const name = `code-strict-${n++}`;
    host.send_({ type: "create-session", sessionId: name, code: value });
    const created = await waitFor(host, "session-created");
    assert.notEqual(created.kind, "code", `code:${JSON.stringify(value)} must not make a code room`);
    assert.match(created.pin, /^\d{6}$/, "it stays a PIN room with a PIN");
  }
});

/* ══════════════════════════════════════════
   A code room outlives its guest

   Admission to a code room is first-come; the word is proven afterwards,
   between the browsers. A guest leaving used to delete the room, so one wrong
   guess — or one stranger joining and leaving — destroyed it, and the right
   word could only find "not found". Now the seat is freed and the host told.
══════════════════════════════════════════ */

async function codeRoomWithGuest(name) {
  const host = await client();
  host.send_({ type: "create-session", sessionId: name, code: true });
  assert.ok(await waitFor(host, "session-created"), "setup: room not created");
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: name });
  assert.ok(await waitFor(guest, "session-joined"), "setup: guest not admitted");
  assert.ok(await waitFor(host, "guest-joined"));
  return { host, guest };
}

async function listedNames() {
  const probe = await client();
  probe.send_({ type: "list-sessions" });
  const list = await waitFor(probe, "session-list");
  return list.sessions.map(s => s.sessionId);
}

test("a code room's guest leaving frees the seat, keeps the room, and tells the host", async () => {
  const { host, guest } = await codeRoomWithGuest("code-keep-leave");
  guest.send_({ type: "leave-session" });
  const left = await waitFor(host, "guest-left");
  assert.ok(left, "the host is told the seat is free");
  assert.equal(left.sessionId, "code-keep-leave");
  assert.ok(!host.inbox.some(m => m.type === "peer-disconnected"), "not told the room is gone");
  assert.ok((await listedNames()).includes("code-keep-leave"), "listed again for the next attempt");

  const next = await client();
  next.send_({ type: "join-session", sessionId: "code-keep-leave" });
  assert.ok(await waitFor(next, "session-joined"), "the next guest gets in");
});

test("a code room's guest vanishing also frees the seat rather than deleting the room", async () => {
  const { host, guest } = await codeRoomWithGuest("code-keep-close");
  guest.close();
  assert.ok(await waitFor(host, "guest-left"));
  assert.ok((await listedNames()).includes("code-keep-close"));
});

test("the host of a code room can turn its guest away, and the seat is free again", async () => {
  const { host, guest } = await codeRoomWithGuest("code-release");
  host.send_({ type: "release-guest", sessionId: "code-release" });
  const told = await waitFor(guest, "peer-disconnected");
  assert.ok(told && told.sessionId === "code-release", "the guest is told");
  assert.ok((await listedNames()).includes("code-release"));
  /* The guest leaving afterwards changes nothing: it is no longer in the room. */
  guest.send_({ type: "leave-session" });
  await sleep(300);
  assert.ok((await listedNames()).includes("code-release"));
});

test("only the host can turn a guest away, and only in a code room", async () => {
  const { host, guest } = await codeRoomWithGuest("code-release-guest-tries");
  guest.send_({ type: "release-guest", sessionId: "code-release-guest-tries" });
  const stranger = await client();
  stranger.send_({ type: "release-guest", sessionId: "code-release-guest-tries" });
  await sleep(400);
  assert.ok(!guest.inbox.some(m => m.type === "peer-disconnected"), "nobody but the host may free the seat");
  assert.ok(!(await listedNames()).includes("code-release-guest-tries"), "still occupied, so still unlisted");

  const pinHost = await client();
  pinHost.send_({ type: "create-session", sessionId: "pin-no-release" });
  const created = await waitFor(pinHost, "session-created");
  const pinGuest = await client();
  pinGuest.send_({ type: "join-session", sessionId: "pin-no-release", pin: created.pin });
  assert.ok(await waitFor(pinGuest, "session-joined"));
  pinHost.send_({ type: "release-guest", sessionId: "pin-no-release" });
  await sleep(400);
  assert.ok(!pinGuest.inbox.some(m => m.type === "peer-disconnected"), "a PIN room's guest is not turned away");
  host.close();
});

test("PIN and open rooms still close when their guest leaves; a code room still closes when its host does", async () => {
  const pinHost = await client();
  pinHost.send_({ type: "create-session", sessionId: "pin-closes" });
  const created = await waitFor(pinHost, "session-created");
  const pinGuest = await client();
  pinGuest.send_({ type: "join-session", sessionId: "pin-closes", pin: created.pin });
  assert.ok(await waitFor(pinGuest, "session-joined"));
  pinGuest.send_({ type: "leave-session" });
  assert.ok(await waitFor(pinHost, "peer-disconnected"), "a PIN room's host is told the room is gone");
  assert.ok(!(await listedNames()).includes("pin-closes"));

  const { host, guest } = await codeRoomWithGuest("code-host-leaves");
  host.send_({ type: "leave-session" });
  assert.ok(await waitFor(guest, "peer-disconnected"), "the guest is told");
  assert.ok(!(await listedNames()).includes("code-host-leaves"));
});

/* ══════════════════════════════════════════
   Uploads at once
══════════════════════════════════════════ */

/** An upload that has started but not finished: the server is reading it. */
function slowUpload(ip) {
  const B = "----dcSlow";
  const req = http.request({
    host: "127.0.0.1", port: PORT, path: "/api/send-message", method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${B}`, "X-DC-Client": "1",
               "X-Forwarded-For": ip, "Transfer-Encoding": "chunked" }
  });
  req.on("error", () => {});
  req.write(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="slow.bin"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n` + "A".repeat(64 * 1024));
  return req;
}

test("a third upload while two are being read is turned away, before its body is read", async () => {
  const first = slowUpload("198.51.100.71"), second = slowUpload("198.51.100.72");
  await sleep(400);
  const up = oversizedUpload();
  const third = await post(up.body, { "Content-Type": up.type, "X-DC-Client": "1", "X-Forwarded-For": "198.51.100.73" });
  assert.equal(third.status, 503, "the third is turned away; 413 would mean it was buffered first");
  assert.ok(await stillServing());

  /* The two finish — here, give up — and the server takes uploads again. */
  first.destroy(); second.destroy();
  await sleep(400);
  const after = await post('{"message":"hi"}', { "Content-Type": "application/json", "X-DC-Client": "1", "X-Forwarded-For": "198.51.100.74" });
  assert.notEqual(after.status, 503, "the slots were let go when those uploads ended");
});

/* ══════════════════════════════════════════
   A host whose link drops — the room waits

   To send the link, the host switches to a messaging app, and the phone cuts
   the page's link to the server. The room used to be deleted on the spot, so
   the link was dead by the time the friend tapped it. A waiting room is now
   kept for HOST_AWAY_MS (1.5 s here, ten minutes for real), and the host takes
   it back with its host key.
══════════════════════════════════════════ */

async function roomThenDrop(name, extra = {}) {
  const host = await client();
  host.send_({ type: "create-session", sessionId: name, ...extra });
  const created = await waitFor(host, "session-created");
  assert.ok(created, "setup: room not created");
  host.terminate();                        // the link drops: no leave, no goodbye
  await sleep(200);
  return created;
}

test("a new room comes with a host key, which is nothing like its token and is in no list", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "key-room" });
  const created = await waitFor(host, "session-created");
  assert.ok(typeof created.hostKey === "string" && created.hostKey.length >= 20);
  assert.notEqual(created.hostKey, created.token, "the link carries the token; the host key must be another secret");
  const probe = await client();
  probe.send_({ type: "list-sessions" });
  const list = await waitFor(probe, "session-list");
  assert.ok(!JSON.stringify(list).includes(created.hostKey));
});

test("the host's link dropping keeps the room; its host key takes it back, with the same PIN and token", async () => {
  const created = await roomThenDrop("away-reclaim");
  assert.ok((await listedNames()).includes("away-reclaim"), "still listed while its host is away");

  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-reclaim", hostKey: created.hostKey });
  const reclaimed = await waitFor(back, "session-reclaimed");
  assert.ok(reclaimed, "taken back");
  assert.equal(reclaimed.pin, created.pin);
  assert.equal(reclaimed.token, created.token, "the link already sent still works");
  assert.equal(reclaimed.guestWaiting, false);
});

test("a wrong host key takes nothing", async () => {
  const created = await roomThenDrop("away-wrong-key");
  const thief = await client();
  for (const hostKey of ["nope", created.token, undefined, null, 7]) {
    thief.inbox.length = 0;
    thief.send_({ type: "reclaim-session", sessionId: "away-wrong-key", hostKey });
    assert.ok(await waitFor(thief, "reclaim-failed", 1500), `${JSON.stringify(hostKey)} must not take the room`);
  }
  assert.ok(!thief.inbox.some(m => m.type === "session-reclaimed"));
  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-wrong-key", hostKey: created.hostKey });
  assert.ok(await waitFor(back, "session-reclaimed"), "the real host still can");
});

test("a guest who arrives while the host is away gets in and is told to wait; the host's return connects them", async () => {
  const created = await roomThenDrop("away-guest", { open: true });
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "away-guest" });
  const joined = await waitFor(guest, "session-joined");
  assert.ok(joined, "admitted");
  assert.equal(joined.hostAway, true, "and told the host is away");

  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-guest", hostKey: created.hostKey });
  const reclaimed = await waitFor(back, "session-reclaimed");
  assert.equal(reclaimed.guestWaiting, true);
  assert.ok(await waitFor(back, "guest-joined"), "the host hears of the guest on returning");
  assert.ok(await waitFor(guest, "host-back"), "the guest hears the host is back");
});

test("a guest with a PIN who arrives while the host is away is told too", async () => {
  const created = await roomThenDrop("away-pin-guest");
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "away-pin-guest", pin: created.pin });
  const joined = await waitFor(guest, "session-joined");
  assert.equal(joined && joined.hostAway, true);
});

test("a guest leaving a room whose host is away frees the seat and keeps the room", async () => {
  const created = await roomThenDrop("away-guest-leaves", { open: true });
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "away-guest-leaves" });
  assert.ok(await waitFor(guest, "session-joined"));
  guest.send_({ type: "leave-session" });
  await sleep(200);
  assert.ok((await listedNames()).includes("away-guest-leaves"));
  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-guest-leaves", hostKey: created.hostKey });
  const reclaimed = await waitFor(back, "session-reclaimed");
  assert.equal(reclaimed && reclaimed.guestWaiting, false);
});

test("leaving on purpose still closes the room at once", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "away-leaves" });
  const created = await waitFor(host, "session-created");
  host.send_({ type: "leave-session" });
  await sleep(200);
  assert.ok(!(await listedNames()).includes("away-leaves"));
  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-leaves", hostKey: created.hostKey });
  assert.ok(await waitFor(back, "reclaim-failed"));
});

test("a host who does not come back in time loses the room: not listed, not joinable, not taken back", async () => {
  const created = await roomThenDrop("away-too-long");
  await sleep(1800);                       // past HOST_AWAY_MS
  assert.ok(!(await listedNames()).includes("away-too-long"));
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "away-too-long" });
  const refused = await waitFor(guest, "pin-error");
  assert.equal(refused && refused.code, "not-found");
  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-too-long", hostKey: created.hostKey });
  assert.ok(await waitFor(back, "reclaim-failed"));
});

test("a host whose link drops mid-chat still ends the room, as before", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "away-mid-chat" });
  const created = await waitFor(host, "session-created");
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "away-mid-chat", pin: created.pin });
  assert.ok(await waitFor(guest, "session-joined"));
  host.terminate();
  assert.ok(await waitFor(guest, "peer-disconnected"), "the guest is told; the chat itself decides whether it goes on");
});

test("a host who comes back too late cannot take the room back, even if nobody else touched it", async () => {
  const created = await roomThenDrop("away-late-reclaim");
  await sleep(1800);                       // past HOST_AWAY_MS, nothing else asks about the room
  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-late-reclaim", hostKey: created.hostKey });
  assert.ok(await waitFor(back, "reclaim-failed"), "a room kept too long is gone, whoever asks first");
  assert.ok(!back.inbox.some(m => m.type === "session-reclaimed"));
});
