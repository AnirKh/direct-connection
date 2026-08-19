/*
  ─────────────────────────────────────────────
  Direct Connection — protocol.js
  ─────────────────────────────────────────────

  The parts of the wire protocol that are pure functions of their inputs:
  invite-link encoding, key derivation, the verification code, and the binary
  chunk framing. Everything here is security-relevant and none of it touches
  the DOM, a socket, or module state — which is exactly why it lives apart from
  app.js: it can be tested directly (see test/protocol.test.js).

  Loaded as a plain script in the browser (window.DCProtocol) and required by
  the tests in Node. No build step, no dependencies.
*/

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DCProtocol = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /** Transfer ids are UUID-shaped, so every chunk carries a fixed 36-byte prefix. */
  const TRANSFER_ID_LEN   = 36;
  /** AES-GCM nonce length, in bytes. */
  const E2E_BIN_IV_LEN    = 12;
  /** Domain separator for HKDF. Bump the version if the derivation changes. */
  const E2E_INFO_LABEL    = "direct-connection/e2e/v2";
  /** Room-secret size. Large enough that guessing is hopeless, so mixing it
      straight into HKDF is sufficient and no password-style exchange is needed. */
  const ROOM_SECRET_BYTES = 32;

  const subtle = globalThis.crypto.subtle;
  const utf8   = new TextEncoder();

  /* ══════════════════════════════════════════
     Encoding helpers
  ══════════════════════════════════════════ */

  function b64urlBytes(bytes) {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** Fresh per-room secret, generated in the host's browser and never sent to
      the server. See parseInviteHash for how it reaches the guest. */
  function makeRoomSecret() {
    return b64urlBytes(globalThis.crypto.getRandomValues(new Uint8Array(ROOM_SECRET_BYTES)));
  }

  /* ══════════════════════════════════════════
     Invite link
     #<encoded room name>:<join token>:<room secret>

     The room name is URI-encoded (a literal ":" becomes %3A) and the token and
     secret are base64url, so no part can contain ":" — splitting is safe.

     The secret rides in the fragment because fragments are never sent in HTTP
     requests. Only sessionId + token ever go over the WebSocket.
  ══════════════════════════════════════════ */

  function buildInviteHash(sessionId, token, secret) {
    return `${encodeURIComponent(sessionId)}:${token}:${secret}`;
  }

  /**
   * Never throws: a malformed fragment must not take the whole app down at
   * load time, which is what a bare decodeURIComponent would do on input like
   * "#%".
   */
  function parseInviteHash(hash) {
    const empty = { sessionId: null, token: null, secret: null, isInvite: false };
    const raw   = String(hash == null ? "" : hash).replace(/^#/, "");
    if (!raw) return empty;

    const parts = raw.split(":");
    if (parts.length < 2) return empty;

    let sessionId;
    try {
      sessionId = decodeURIComponent(parts[0]);
    } catch (_) {
      return empty;   // malformed percent-encoding
    }
    const token  = parts[1];
    const secret = parts.length >= 3 && parts[2] ? parts[2] : null;
    return { sessionId, token, secret, isInvite: Boolean(sessionId && token) };
  }

  /**
   * Guards the invariant the whole man-in-the-middle defence rests on: the room
   * secret must never leave the browser. Returns true if `payload` contains it
   * anywhere — nested or in an array counts, since a secret one level down
   * leaks exactly as thoroughly as one at the top.
   *
   * Worth enforcing rather than merely documenting: adding the secret to an
   * outgoing message would remove the protection while everything carried on
   * working, with no error and nothing visibly wrong.
   */
  function payloadLeaksSecret(payload, secret) {
    if (!secret) return false;
    const seen = new Set();
    let found = false;
    (function walk(value) {
      if (found || value === null || value === undefined) return;
      if (typeof value === "string") {
        if (value.includes(secret)) found = true;
        return;
      }
      if (typeof value !== "object") return;
      if (seen.has(value)) return;        // tolerate cycles
      seen.add(value);
      if (Array.isArray(value)) { value.forEach(walk); return; }
      for (const key of Object.keys(value)) walk(value[key]);
    })(payload);
    return found;
  }

  /* ══════════════════════════════════════════
     Key agreement
  ══════════════════════════════════════════ */

  /**
   * ECDH → HKDF → AES-GCM. Passing a different `secret` (or none) yields a
   * different key, which is what stops a signaling server that swapped the
   * public keys from reaching a usable one.
   */
  async function deriveSharedKey(privateKey, peerPublicKey, secret) {
    const bits = await subtle.deriveBits(
      { name: "ECDH", public: peerPublicKey }, privateKey, 256);
    const hkdf = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: secret ? utf8.encode(secret) : new Uint8Array(0),
        info: utf8.encode(E2E_INFO_LABEL)
      },
      hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  /* ══════════════════════════════════════════
     Verification code
  ══════════════════════════════════════════ */

  function compareBytes(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  }

  /**
   * Both peers must arrive at the same string, so the two public keys are
   * sorted before hashing rather than concatenated in local-then-remote order.
   */
  async function makeSharedVerificationCode(localRaw, peerRaw) {
    const local  = new Uint8Array(localRaw);
    const peer   = new Uint8Array(peerRaw);
    const first  = compareBytes(local, peer) <= 0 ? local : peer;
    const second = first === local ? peer : local;
    const joined = new Uint8Array(first.length + second.length);
    joined.set(first, 0);
    joined.set(second, first.length);
    const hash = await subtle.digest("SHA-256", joined);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 20)
      .replace(/(.{4})/g, "$1 ")
      .trim()
      .toUpperCase();
  }

  function normalizeVerifyCode(value) {
    return String(value == null ? "" : value).replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  }

  /* ══════════════════════════════════════════
     Binary chunk framing
     [ 36-byte transfer id ][ 12-byte IV ][ ciphertext ]
  ══════════════════════════════════════════ */

  function packChunk(idBytes, iv, ct) {
    const packet = new Uint8Array(TRANSFER_ID_LEN + E2E_BIN_IV_LEN + ct.byteLength);
    packet.set(idBytes, 0);
    packet.set(iv, TRANSFER_ID_LEN);
    packet.set(ct, TRANSFER_ID_LEN + E2E_BIN_IV_LEN);
    return packet;
  }

  /** Splits off the transfer id; the remainder still holds IV + ciphertext. */
  function unpackChunk(buffer) {
    const id   = new TextDecoder().decode(new Uint8Array(buffer, 0, TRANSFER_ID_LEN));
    const body = new Uint8Array(buffer.slice(TRANSFER_ID_LEN));
    return { id, body };
  }

  /** null when the body is too short to hold an IV — i.e. a corrupt chunk. */
  function splitChunkBody(body) {
    if (body.byteLength < E2E_BIN_IV_LEN) return null;
    return { iv: body.slice(0, E2E_BIN_IV_LEN), ct: body.slice(E2E_BIN_IV_LEN) };
  }

  /** UUID v4 shape, used as the transfer id. */
  function makeTransferId() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = globalThis.crypto.getRandomValues(new Uint8Array(1))[0] % 16;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  return {
    TRANSFER_ID_LEN, E2E_BIN_IV_LEN, E2E_INFO_LABEL, ROOM_SECRET_BYTES,
    b64urlBytes, makeRoomSecret,
    buildInviteHash, parseInviteHash, payloadLeaksSecret,
    deriveSharedKey,
    compareBytes, makeSharedVerificationCode, normalizeVerifyCode,
    packChunk, unpackChunk, splitChunkBody, makeTransferId
  };
});
