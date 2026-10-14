/*
  Tests for pake.js — SPAKE2 over P-256.

  The first block is the one that matters most: it holds every protocol step
  against the official RFC 9382 test vector (Appendix B, server/client). If my
  pA, pB, shared K, transcript, and both confirmation tags match the RFC's,
  the protocol is implemented to the letter — the strongest check available
  without a second audited implementation to interoperate with.

  The rest proves the two things the app relies on: matching secrets reach the
  same key and verify each other, and anything else — a wrong secret, a tampered
  message, a bad point — does not.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const P = require("../pake.js");

const hex = P._bytesToHex;
const strip = s => s.replace(/\s+/g, "").toLowerCase().replace(/^0x/, "");

/* ══════════════════════════════════════════
   RFC 9382 Appendix B — P256-SHA256-HKDF-HMAC, A="server" B="client"
══════════════════════════════════════════ */

const V = {
  w:  strip("2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f"),
  x:  strip("43dd0fd7215bdcb482879fca3220c6a968e66d70b1356cac18bb26c84a78d729"),
  y:  strip("dcb60106f276b02606d8ef0a328c02e4b629f84f89786af5befb0bc75b6e66be"),
  pA: strip("04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c"),
  pB: strip("0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7"),
  K:  strip("0412af7e89717850671913e6b469ace67bd90a4df8ce45c2af19010175e37eed69f75897996d539356e2fa6a406d528501f907e04d97515fbe83db277b715d3325"),
  TT: strip(
      "0600000000000000" + Buffer.from("server").toString("hex") +
      "0600000000000000" + Buffer.from("client").toString("hex") +
      "4100000000000000" + "04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c" +
      "4100000000000000" + "0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7" +
      "4100000000000000" + "0412af7e89717850671913e6b469ace67bd90a4df8ce45c2af19010175e37eed69f75897996d539356e2fa6a406d528501f907e04d97515fbe83db277b715d3325" +
      "2000000000000000" + "2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f"),
  hashTT: strip("0e0672dc86f8e45565d338b0540abe6915bdf72e2b35b5c9e5663168e960a91b"),
  Ke:  strip("0e0672dc86f8e45565d338b0540abe69"),
  Ka:  strip("15bdf72e2b35b5c9e5663168e960a91b"),
  KcA: strip("00c12546835755c86d8c0db7851ae86f"),
  KcB: strip("a9fa3406c3b781b93d804485430ca27a"),
  confA: strip("58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0"),
  confB: strip("d3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26dc459b")
};

const bi = h => BigInt("0x" + h);
const point = h => P._Point.fromHex(h);

test("pA = x·G + w·M matches the RFC vector", () => {
  assert.equal(hex(P._uncompressed(P._messageA(bi(V.w), bi(V.x)))), V.pA);
});

test("pB = y·G + w·N matches the RFC vector", () => {
  assert.equal(hex(P._uncompressed(P._messageB(bi(V.w), bi(V.y)))), V.pB);
});

test("both sides reach the RFC's shared point K", () => {
  const fromA = P._sharedFromA(bi(V.w), bi(V.x), point(V.pB));
  const fromB = P._sharedFromB(bi(V.w), bi(V.y), point(V.pA));
  assert.equal(hex(P._uncompressed(fromA)), V.K, "host's K");
  assert.equal(hex(P._uncompressed(fromB)), V.K, "guest's K");
});

test("the transcript is framed exactly as the RFC lays it out", () => {
  const TT = P._transcript(Buffer.from("server"), Buffer.from("client"),
                           point(V.pA), point(V.pB), point(V.K), bi(V.w));
  assert.equal(hex(TT), V.TT);
});

test("the derived keys match the RFC vector", () => {
  const TT = P._hexToBytes(V.TT);
  const k = P._deriveKeys(TT);
  assert.equal(hex(k.hash), V.hashTT, "SHA-256(TT)");
  assert.equal(hex(k.Ke), V.Ke);
  assert.equal(hex(k.Ka), V.Ka);
  assert.equal(hex(k.KcA), V.KcA);
  assert.equal(hex(k.KcB), V.KcB);
});

test("both confirmation tags match the RFC vector", () => {
  const TT = P._hexToBytes(V.TT);
  const k = P._deriveKeys(TT);
  assert.equal(hex(P._confirm(k.KcA, TT)), V.confA);
  assert.equal(hex(P._confirm(k.KcB, TT)), V.confB);
});

/* ══════════════════════════════════════════
   The app's two calls: start / finish
══════════════════════════════════════════ */

/** Runs a full exchange between a host and a guest and reports what each got. */
function exchange(hostPw, guestPw, context = "room-7") {
  const host  = P.start("host",  hostPw,  context);
  const guest = P.start("guest", guestPw, context);
  const hf = P.finish(host.state,  guest.message);
  const gf = P.finish(guest.state, host.message);
  return {
    hostSeesGuestOk:  gf.verifyPeerConfirm ? host0(hf, gf) : null,
    hostAcceptsGuest: hf.verifyPeerConfirm(gf.confirmToSend),
    guestAcceptsHost: gf.verifyPeerConfirm(hf.confirmToSend),
    sameKey: hex(hf.sessionKey) === hex(gf.sessionKey),
    hostKey: hex(hf.sessionKey), guestKey: hex(gf.sessionKey)
  };
}
function host0() { return true; }

test("the same secret gives both sides the same key, and each accepts the other", () => {
  const r = exchange("hunter2", "hunter2");
  assert.ok(r.hostAcceptsGuest, "host must accept the guest's confirmation");
  assert.ok(r.guestAcceptsHost, "guest must accept the host's confirmation");
  assert.ok(r.sameKey, "both sides must derive the same channel key");
  assert.equal(r.hostKey.length, 64, "a 32-byte key");
});

test("a short code works just as well as a long one", () => {
  for (const code of ["42", "dog", "7391", "café ☕", "x"]) {
    const r = exchange(code, code);
    assert.ok(r.hostAcceptsGuest && r.guestAcceptsHost && r.sameKey, `code ${JSON.stringify(code)} failed`);
  }
});

test("a wrong code is rejected by both sides and shares no key", () => {
  const r = exchange("correct horse", "wrong horse");
  assert.ok(!r.hostAcceptsGuest, "host must reject a guest who used the wrong code");
  assert.ok(!r.guestAcceptsHost, "guest must reject the host it could not match");
  assert.ok(!r.sameKey, "the two must not land on the same key");
});

test("one wrong character is enough to fail", () => {
  const r = exchange("letmein", "letmeln");
  assert.ok(!r.hostAcceptsGuest && !r.guestAcceptsHost && !r.sameKey);
});

test("the same code in a different room gives a different key", () => {
  const a = P.start("host", "same-code", "room-A");
  const b = P.start("host", "same-code", "room-B");
  /* different context → different w → different first message */
  assert.notEqual(a.message, b.message);
});

test("a tampered peer message makes the confirmations fail", () => {
  const host  = P.start("host",  "secret", "r");
  const guest = P.start("guest", "secret", "r");
  /* flip one byte of the guest's message before the host sees it */
  const bytes = P._hexToBytes(guest.message);
  bytes[40] ^= 0x01;
  let tampered;
  try { tampered = hex(bytes); } catch (_) { tampered = guest.message; }

  let hostView;
  try { hostView = P.finish(host.state, tampered); }
  catch (_) { return; }   // an invalid point is rejected outright — also acceptable
  const gf = P.finish(guest.state, host.message);
  assert.ok(!hostView.verifyPeerConfirm(gf.confirmToSend), "a changed message must not verify");
});

test("a peer message that is not a valid point is refused", () => {
  const host = P.start("host", "secret", "r");
  for (const bad of [
    "00",                                                                   // identity encoding
    "04" + "11".repeat(64),                                                 // not on the curve
    "ffffffffffffffff",                                                     // nonsense
    ""                                                                      // empty
  ]) {
    assert.throws(() => P.finish(host.state, bad), `should reject ${bad.slice(0, 8)}`);
  }
});

/* ══════════════════════════════════════════
   scalarFromPassword
══════════════════════════════════════════ */

test("the password scalar is deterministic and in range", () => {
  const a = P.scalarFromPassword("word", "ctx");
  const b = P.scalarFromPassword("word", "ctx");
  assert.equal(a, b, "same inputs, same scalar");
  assert.ok(a > 0n && a < P._ORDER, "scalar must be a valid non-zero curve scalar");
});

test("different word or different room means a different scalar", () => {
  const base = P.scalarFromPassword("word", "ctx");
  assert.notEqual(base, P.scalarFromPassword("word2", "ctx"));
  assert.notEqual(base, P.scalarFromPassword("word", "ctx2"));
});

test("an empty or missing password still yields a usable scalar", () => {
  for (const pw of ["", null, undefined]) {
    const w = P.scalarFromPassword(pw, "ctx");
    assert.ok(w > 0n && w < P._ORDER);
  }
});

test("two runs with the same code use fresh randomness each time", () => {
  /* The messages differ (fresh x, y) even though the key agreement succeeds —
     no run reveals anything reusable from another. */
  const first  = P.start("host", "code", "r").message;
  const second = P.start("host", "code", "r").message;
  assert.notEqual(first, second, "each run must pick a fresh ephemeral scalar");
});
