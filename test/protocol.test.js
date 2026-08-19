/*
  Tests for protocol.js — the security-critical pure logic.

  These exist because three separate bugs this code has had were invisible in
  normal use: chunks dropped in a race, a truncated file delivered silently, and
  a key exchange that could be substituted. All three are testable here.

  Run with: npm test
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const DC     = require("../protocol.js");

/* ══════════════════════════════════════════
   Invite link
══════════════════════════════════════════ */

test("invite link round-trips through build and parse", () => {
  const hash = DC.buildInviteHash("my room", "TOKEN123", "SECRET456");
  const out  = DC.parseInviteHash(hash);
  assert.equal(out.sessionId, "my room");
  assert.equal(out.token,  "TOKEN123");
  assert.equal(out.secret, "SECRET456");
  assert.equal(out.isInvite, true);
});

test("room names containing a colon survive the round trip", () => {
  /* The separator is ":", so an unescaped colon in the name would split wrong. */
  const hash = DC.buildInviteHash("a:b:c", "TOK", "SEC");
  const out  = DC.parseInviteHash(hash);
  assert.equal(out.sessionId, "a:b:c");
  assert.equal(out.token,  "TOK");
  assert.equal(out.secret, "SEC");
});

test("room names with unicode and spaces survive the round trip", () => {
  const name = "Шууд холбоос 1";
  const out  = DC.parseInviteHash(DC.buildInviteHash(name, "T", "S"));
  assert.equal(out.sessionId, name);
});

test("a link without a secret parses but reports no secret", () => {
  /* Pre-#5 links, and any link an attacker has stripped the secret from.
     The app must be able to tell the difference — that is what drives the
     unverified warning rather than a silent downgrade. */
  const out = DC.parseInviteHash("room:TOKEN");
  assert.equal(out.isInvite, true);
  assert.equal(out.secret, null);
});

test("malformed percent-encoding does not throw", () => {
  /* This runs at page load. A bare decodeURIComponent would throw URIError and
     take the entire app down before anything rendered. */
  assert.doesNotThrow(() => DC.parseInviteHash("%:tok:sec"));
  assert.equal(DC.parseInviteHash("%:tok:sec").isInvite, false);
});

test("empty and junk fragments are not treated as invites", () => {
  for (const input of ["", "#", null, undefined, "justaroomname", "#nocolon"]) {
    assert.equal(DC.parseInviteHash(input).isInvite, false, `input: ${input}`);
  }
});

test("a leading # is accepted, since location.hash includes it", () => {
  assert.equal(DC.parseInviteHash("#room:tok:sec").sessionId, "room");
});

/* ══════════════════════════════════════════
   Room secret
══════════════════════════════════════════ */

test("room secrets are 32 bytes of base64url and never repeat", () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const s = DC.makeRoomSecret();
    assert.match(s, /^[A-Za-z0-9_-]+$/, "must be URL-safe: it travels in a fragment");
    assert.equal(s.length, 43, "43 chars is 32 bytes unpadded base64url");
    assert.ok(!seen.has(s), "secrets must not repeat");
    seen.add(s);
  }
});

/* ══════════════════════════════════════════
   The room secret must never leave the browser

   Everything in "Why the secret is in the fragment" (README) depends on the
   server never seeing it. Nothing about a leak would look broken at runtime,
   so it is guarded rather than merely documented.
══════════════════════════════════════════ */

test("a payload carrying the secret at the top level is caught", () => {
  const secret = DC.makeRoomSecret();
  assert.equal(DC.payloadLeaksSecret({ type: "join-session", secret }, secret), true);
});

test("a payload carrying the secret nested or in an array is caught", () => {
  const secret = DC.makeRoomSecret();
  assert.equal(DC.payloadLeaksSecret({ a: { b: { c: secret } } }, secret), true);
  assert.equal(DC.payloadLeaksSecret({ list: ["x", secret] }, secret), true);
  assert.equal(DC.payloadLeaksSecret([{ deep: [{ deeper: secret }] }], secret), true);
});

test("a secret embedded inside a longer string is caught", () => {
  /* e.g. someone builds a share URL and sends it for logging. */
  const secret = DC.makeRoomSecret();
  assert.equal(
    DC.payloadLeaksSecret({ url: `https://x/y#room:tok:${secret}` }, secret), true);
});

test("the messages the client actually sends are not flagged", () => {
  const secret = DC.makeRoomSecret();
  const real = [
    { type: "create-session", sessionId: "room" },
    { type: "join-session", sessionId: "room", pin: "123456" },
    { type: "join-session", sessionId: "room", token: "TOKEN" },
    { type: "offer", offer: { type: "offer", sdp: "v=0..." }, sessionId: "room" },
    { type: "ice-candidate", candidate: { candidate: "candidate:1 ..." }, sessionId: "room" },
    { type: "list-sessions" },
    { type: "leave-session", sessionId: "room" }
  ];
  for (const msg of real) {
    assert.equal(DC.payloadLeaksSecret(msg, secret), false, `false positive on ${msg.type}`);
  }
});

test("the guard is inert when there is no secret (PIN joins)", () => {
  assert.equal(DC.payloadLeaksSecret({ anything: "here" }, null), false);
  assert.equal(DC.payloadLeaksSecret({ anything: "here" }, ""), false);
});

test("the guard terminates on a cyclic payload", () => {
  const secret = DC.makeRoomSecret();
  const cyclic = { type: "x" };
  cyclic.self = cyclic;
  assert.equal(DC.payloadLeaksSecret(cyclic, secret), false);
  cyclic.leak = secret;
  assert.equal(DC.payloadLeaksSecret(cyclic, secret), true);
});

/* ══════════════════════════════════════════
   Key agreement — the heart of the MITM defence
══════════════════════════════════════════ */

async function makePair() {
  return globalThis.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey", "deriveBits"]);
}

/** Proves two keys are the same by encrypting with one and decrypting with the other. */
async function keysInterop(a, b) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, a, new TextEncoder().encode("hello"));
  try {
    const pt = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv }, b, ct);
    return new TextDecoder().decode(pt) === "hello";
  } catch (_) {
    return false;
  }
}

test("both peers derive the same key from the same room secret", async () => {
  const alice = await makePair();
  const bob   = await makePair();
  const secret = DC.makeRoomSecret();
  const ka = await DC.deriveSharedKey(alice.privateKey, bob.publicKey,   secret);
  const kb = await DC.deriveSharedKey(bob.privateKey,   alice.publicKey, secret);
  assert.equal(await keysInterop(ka, kb), true);
});

test("a different room secret yields a key that cannot decrypt", async () => {
  /* The attack: a signaling server relays a guest whose link secret was altered.
     Both sides must end up unable to talk, rather than silently succeeding. */
  const alice = await makePair();
  const bob   = await makePair();
  const ka = await DC.deriveSharedKey(alice.privateKey, bob.publicKey,   DC.makeRoomSecret());
  const kb = await DC.deriveSharedKey(bob.privateKey,   alice.publicKey, DC.makeRoomSecret());
  assert.equal(await keysInterop(ka, kb), false);
});

test("having the secret differs from not having it", async () => {
  /* A PIN joiner (no secret) and a link joiner (secret) must not land on the
     same key by accident — that is what lets the host detect which happened. */
  const alice = await makePair();
  const bob   = await makePair();
  const secret = DC.makeRoomSecret();
  const withSecret = await DC.deriveSharedKey(alice.privateKey, bob.publicKey, secret);
  const without    = await DC.deriveSharedKey(bob.privateKey, alice.publicKey, null);
  assert.equal(await keysInterop(withSecret, without), false);
});

test("no secret on both sides still agrees (the PIN path)", async () => {
  const alice = await makePair();
  const bob   = await makePair();
  const ka = await DC.deriveSharedKey(alice.privateKey, bob.publicKey,   null);
  const kb = await DC.deriveSharedKey(bob.privateKey,   alice.publicKey, null);
  assert.equal(await keysInterop(ka, kb), true);
});

test("a man in the middle cannot bridge the two sides", async () => {
  /* Full substitution: the server hands each peer the attacker's public key.
     Without the room secret the attacker's own derived keys match neither peer. */
  const alice    = await makePair();
  const bob      = await makePair();
  const attacker = await makePair();
  const secret   = DC.makeRoomSecret();

  const aliceKey = await DC.deriveSharedKey(alice.privateKey, attacker.publicKey, secret);
  const bobKey   = await DC.deriveSharedKey(bob.privateKey,   attacker.publicKey, secret);
  // attacker knows both ECDH secrets but not the room secret
  const attackerVsAlice = await DC.deriveSharedKey(attacker.privateKey, alice.publicKey, null);
  const attackerVsBob   = await DC.deriveSharedKey(attacker.privateKey, bob.publicKey,   null);

  assert.equal(await keysInterop(aliceKey, attackerVsAlice), false);
  assert.equal(await keysInterop(bobKey,   attackerVsBob),   false);
  assert.equal(await keysInterop(aliceKey, bobKey),          false);
});

/* ══════════════════════════════════════════
   Verification code
══════════════════════════════════════════ */

test("both peers compute the same code regardless of argument order", async () => {
  const a = globalThis.crypto.getRandomValues(new Uint8Array(65));
  const b = globalThis.crypto.getRandomValues(new Uint8Array(65));
  assert.equal(
    await DC.makeSharedVerificationCode(a, b),
    await DC.makeSharedVerificationCode(b, a));
});

test("different keys produce different codes", async () => {
  const a = globalThis.crypto.getRandomValues(new Uint8Array(65));
  const b = globalThis.crypto.getRandomValues(new Uint8Array(65));
  const c = globalThis.crypto.getRandomValues(new Uint8Array(65));
  assert.notEqual(
    await DC.makeSharedVerificationCode(a, b),
    await DC.makeSharedVerificationCode(a, c));
});

test("the code is readable: 5 groups of 4 uppercase hex", async () => {
  const a = globalThis.crypto.getRandomValues(new Uint8Array(65));
  const b = globalThis.crypto.getRandomValues(new Uint8Array(65));
  assert.match(await DC.makeSharedVerificationCode(a, b), /^[0-9A-F]{4}( [0-9A-F]{4}){4}$/);
});

test("typed codes are normalised before comparison", () => {
  assert.equal(DC.normalizeVerifyCode("07d8 2a37"), "07D82A37");
  assert.equal(DC.normalizeVerifyCode("07-d8:2a37"), "07D82A37");
  assert.equal(DC.normalizeVerifyCode(null), "");
});

/* ══════════════════════════════════════════
   Binary chunk framing
══════════════════════════════════════════ */

test("a packed chunk unpacks to the same id, iv and ciphertext", () => {
  const id      = DC.makeTransferId();
  const idBytes = new TextEncoder().encode(id);
  const iv      = globalThis.crypto.getRandomValues(new Uint8Array(DC.E2E_BIN_IV_LEN));
  const ct      = globalThis.crypto.getRandomValues(new Uint8Array(500));

  const packet = DC.packChunk(idBytes, iv, ct);
  const { id: outId, body } = DC.unpackChunk(packet.buffer);
  const split = DC.splitChunkBody(body);

  assert.equal(outId, id);
  assert.deepEqual(split.iv, iv);
  assert.deepEqual(split.ct, ct);
});

test("transfer ids are exactly the framing length", () => {
  /* unpackChunk slices a fixed prefix; an id of another length corrupts every
     chunk silently. */
  for (let i = 0; i < 20; i++) {
    assert.equal(new TextEncoder().encode(DC.makeTransferId()).length, DC.TRANSFER_ID_LEN);
  }
});

test("transfer ids are unique", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const id = DC.makeTransferId();
    assert.ok(!seen.has(id));
    seen.add(id);
  }
});

test("a body too short to hold an IV is rejected, not silently skipped", () => {
  /* Skipping such a chunk is how a damaged file used to be delivered as if fine. */
  assert.equal(DC.splitChunkBody(new Uint8Array(0)), null);
  assert.equal(DC.splitChunkBody(new Uint8Array(DC.E2E_BIN_IV_LEN - 1)), null);
  assert.notEqual(DC.splitChunkBody(new Uint8Array(DC.E2E_BIN_IV_LEN)), null);
});

test("an empty-ciphertext chunk is still well formed", () => {
  const idBytes = new TextEncoder().encode(DC.makeTransferId());
  const iv      = new Uint8Array(DC.E2E_BIN_IV_LEN);
  const packet  = DC.packChunk(idBytes, iv, new Uint8Array(0));
  const split   = DC.splitChunkBody(DC.unpackChunk(packet.buffer).body);
  assert.equal(split.ct.length, 0);
});
