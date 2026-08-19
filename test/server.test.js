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
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
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
