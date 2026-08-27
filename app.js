/*
  Direct Connection — app.js  v20260518
  ─────────────────────────────────────────────
  Dual-language support: Mongolian (default) / English
  All user-visible strings routed through t() / I18N
  ─────────────────────────────────────────────
*/

"use strict";

/* Wire-protocol primitives — invite links, key derivation, chunk framing.
   See protocol.js; it is loaded before this file and covered by test/. */
const DC = window.DCProtocol;

/* ── Read hash immediately ───────────────────── */
const _invite        = DC.parseInviteHash(location.hash);
const _autoSessionId = _invite.sessionId;
const _autoToken     = _invite.token;
const _autoSecret    = _invite.secret;
const _isAutoJoin    = _invite.isInvite;
if (_isAutoJoin) history.replaceState({}, "", location.pathname);


/** Get a plain string from the current language */
function t(key) {
  return I18N[LANG][key] ?? I18N.en[key] ?? key;
}

/** Update all static DOM elements tagged with data-i18n / data-i18n-ph */
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.dataset.i18n;
    const val = I18N[LANG][key];
    if (typeof val === "string") el.textContent = val;
    if (key === "leaveHint" && typeof val === "function") el.textContent = val(leaveAttachMaxMbRounded());
  });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => {
    const key = el.dataset.i18nPh;
    const val = I18N[LANG][key];
    if (typeof val === "string") el.placeholder = val;
  });
  // lang toggle active state
  document.querySelectorAll(".lang-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.lang === LANG);
  });
  // update document lang attribute
  document.documentElement.lang = LANG === "mn" ? "mn" : "en";
  // re-render session list so timeAgo labels update
  renderSessionList(_lastSessionList);
  // update voice record button title
  if (voiceRecordBtn) voiceRecordBtn.title = t("recordVoice");
  // update typing indicator if visible
  if (typingIndicator && !typingIndicator.classList.contains("hidden")) {
    typingIndicator.textContent = t("peerTyping");
  }
  // the path badge carries a translated label and tooltip — redraw both
  renderConnectionPath(_lastPath);
}

/* ── Language switcher ───────────────────────── */
document.querySelectorAll(".lang-btn").forEach(btn => {
  btn.onclick = () => {
    LANG = btn.dataset.lang;
    localStorage.setItem("lang", LANG);
    applyI18n();
  };
});

/* ── DOM refs ────────────────────────────────── */
const overlay          = document.getElementById("overlay");
const approveBtn       = document.getElementById("approveBtn");
const lobbyScreen      = document.getElementById("lobbyScreen");
const chatScreen       = document.getElementById("chatScreen");
const sessionIdInput   = document.getElementById("sessionId");
const createBtn        = document.getElementById("createBtn");
const createInfo       = document.getElementById("createInfo");
const sessionsList     = document.getElementById("sessionsList");
const refreshBtn       = document.getElementById("refreshBtn");
const pinOverlay       = document.getElementById("pinOverlay");
const pinSessionLabel  = document.getElementById("pinSessionLabel");
const pinInput         = document.getElementById("pinInput");
const pinJoinBtn       = document.getElementById("pinJoinBtn");
const pinCancelBtn     = document.getElementById("pinCancelBtn");
const pinError         = document.getElementById("pinError");
const chatSessionLabel = document.getElementById("chatSessionLabel");
const connectionQuality= document.getElementById("connectionQuality");
const connectionState  = document.getElementById("connectionState");
const connectionPath   = document.getElementById("connectionPath");
const statsBar         = document.getElementById("statsBar");
const leaveBtn         = document.getElementById("leaveBtn");
const chatMessages     = document.getElementById("chatMessages");
const typingIndicator  = document.getElementById("typingIndicator");
const messageInput     = document.getElementById("messageInput");
const sendBtn          = document.getElementById("sendBtn");
const attachBtn        = document.getElementById("attachBtn");
const attachMenu       = document.getElementById("attachMenu");
const sendImageBtn     = document.getElementById("sendImageBtn");
const sendFileBtn      = document.getElementById("sendFileBtn");
const imageInput       = document.getElementById("imageInput");
const fileInput        = document.getElementById("fileInput");
const voiceRecordBtn   = document.getElementById("voiceRecordBtn");
const voiceCallBtn     = document.getElementById("voiceCallBtn");
const videoCallBtn     = document.getElementById("videoCallBtn");
const callOverlay      = document.getElementById("callOverlay");
const callStatusLabel  = document.getElementById("callStatusLabel");
const remoteVideo      = document.getElementById("remoteVideo");
const localVideo       = document.getElementById("localVideo");
const toggleMuteBtn    = document.getElementById("toggleMuteBtn");
const toggleCamBtn     = document.getElementById("toggleCamBtn");
const endCallBtn       = document.getElementById("endCallBtn");
const senderName       = document.getElementById("senderName");
const leaveMessage     = document.getElementById("leaveMessage");
const leaveFileBtn     = document.getElementById("leaveFileBtn");
const leaveFile        = document.getElementById("leaveFile");
const leaveFileName    = document.getElementById("leaveFileName");
const leaveSendBtn     = document.getElementById("leaveSendBtn");
const leaveStatus      = document.getElementById("leaveStatus");
const callRequestModal = document.getElementById("callRequestModal");
const callRequestTitle = document.getElementById("callRequestTitle");
const callRequestIcon  = document.getElementById("callRequestIcon");
const callAcceptBtn    = document.getElementById("callAcceptBtn");
const callDeclineBtn   = document.getElementById("callDeclineBtn");
const keyVerifyDropdown = document.getElementById("keyVerifyDropdown");
const keyVerifyCode  = document.getElementById("keyVerifyCode");
const keyVerifyInput = document.getElementById("keyVerifyInput");
const keyVerifyStatus= document.getElementById("keyVerifyStatus");

/* ── State ───────────────────────────────────── */
let ws              = null;
let pc              = null;
let callPc          = null;
let dataChannel     = null;
let inCall          = false;
let pendingCallVideo = false;
let currentSession  = null;
let isConnecting    = false;
let isHost          = false;
let iceQueue        = [];
let callIceQueue    = [];

let localStream     = null;
let remoteCallStream = null;
let isMuted         = false;
let isCamOff        = false;
let mediaRecorder   = null;
let voiceChunks     = [];
let voiceStream     = null;   // the live mic stream, so any path can release it
let voiceSession    = null;   // the room a recording belongs to
let voiceDiscard    = false;  // set when the result must be dropped, not sent

let statsInterval   = null;
let msgIdCounter    = 0;
const pendingAcks   = {};
let typingTimeout   = null;
let peerTyping      = false;

let _lastSessionList = [];  // cache for re-render on language change

/* Last known connection path, so the header badge can be redrawn in the new
   language. Declared here rather than beside renderConnectionPath(): applyI18n()
   runs while this file is still parsing and reads it, which a `let` further down
   would refuse — the badge is translated, so it has to be reachable that early. */
let _lastPath = null;

const recvBuffers = {};

/* ── Early-chunk parking ────────────────────
   transfer-meta travels inside the encrypted e2e-dc envelope, so it is decrypted
   asynchronously, while binary chunks are handled synchronously. A chunk can
   therefore land before its metadata is registered. Park those here instead of
   dropping them; transfer-meta adopts them the moment it lands.               */
const orphanChunks     = {};
let   orphanChunkCount = 0;
const ORPHAN_CHUNK_MAX = 64;   // ~4 MB ceiling — the race window is a few chunks at most

/** Removes and returns chunks parked for `id` (empty array if none). */
function takeOrphanChunks(id) {
  const early = orphanChunks[id];
  if (!early) return [];
  delete orphanChunks[id];
  orphanChunkCount -= early.length;
  return early;
}

/* ── Blob URL memory management ─────────────
   Every createObjectURL() is tracked here.
   revokeTrackedBlobUrls() is called on leave
   so memory is freed when the chat closes.     */
const _trackedBlobUrls = [];
function trackBlobUrl(url) { _trackedBlobUrls.push(url); return url; }
function revokeTrackedBlobUrls() {
  while (_trackedBlobUrls.length) URL.revokeObjectURL(_trackedBlobUrls.pop());
}

/* ── In-app toast (replaces alert()) ────────
   type: "info" | "warn" | "error" | "ok"      */
function showToast(msg, type = "info") {
  const container = document.getElementById("dcToastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `dc-toast dc-toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.remove(); }, 4000);
}

/* ── Reconnect / back-to-lobby button ───────
   Shown in chat when the peer disconnects.    */
function showReconnectButton() {
  const wrap = document.createElement("div");
  wrap.className = "reconnect-sys-wrap";
  const btn = document.createElement("button");
  btn.className = "reconnect-sys-btn";
  btn.textContent = t("reconnectBtn");
  btn.onclick = () => leaveBtn.click();
  wrap.appendChild(btn);
  chatMessages.appendChild(wrap);
  scrollBottom();
}

/* ══════════════════════════════════════════════
   E2E ENCRYPTION  (ECDH P-256 → HKDF → AES-GCM 256)
   ─────────────────────────────────────────────
   App-layer key for text, photos, files, voice notes and call signaling on the
   data channel. Voice/video media rides WebRTC's own DTLS-SRTP.

   Plain ECDH alone cannot detect a man-in-the-middle: the signaling server sees
   both public keys and could swap in its own. Two defences:

     Link joins  — the host's browser mints a random room secret, carries it in
                   the invite-link fragment (never sent to the server) and mixes
                   it into HKDF. An attacker without the secret derives a
                   different key, so the confirmation below fails and the chat
                   never opens. No user action required.
     PIN joins   — no shared secret exists, so we fall back to plain ECDH and the
                   manual verification code. The UI says plainly which one you
                   got, so a forced downgrade is visible rather than silent.

   The host cannot know in advance how the guest will join, so it derives BOTH
   candidate keys and lets the guest's confirmation packet select one.

   Flow:
     1. dataChannel.onopen → e2eInit() → e2e-pubkey exchange
     2. both sides derive; guest sends e2e-confirm sealed with its key
     3. host tries each candidate, adopts the one that opens it, confirms back
     4. neither opens → e2e-fail, channel stays shut
══════════════════════════════════════════════ */

let e2eKey      = null;   // CryptoKey AES-GCM 256 (derived, after confirmation)
let e2eKeyPair  = null;   // ECDH ephemeral key pair
let e2eReady    = false;
let e2eVerifyCode = "";
let e2eVerified = false;
let e2eLocalPubRaw = null;

let roomSecret       = null;   // host: minted locally; guest: read from invite link
let pendingRoomSecret = null;  // secret for the join currently in flight
let e2eCandidates    = null;   // host only: { secure, plain } awaiting selection
let e2eKeyPending    = null;   // guest only: key awaiting the host's confirmation
let e2eSecureMode    = false;  // true = room secret authenticated this exchange
let e2ePendingConfirm = null;  // confirm that landed before derivation finished
let e2eConfirmTimer  = null;

const E2E_CONFIRM_TIMEOUT_MS = 15_000;

const makeRoomSecret = DC.makeRoomSecret;

async function e2eInit() {
  e2eVerifyCode = "";
  e2eVerified = false;
  e2eSecureMode = false;
  e2eLocalPubRaw = null;
  e2eCandidates = null;
  e2eKeyPending = null;
  e2ePendingConfirm = null;
  updateKeyVerifyUi();
  e2eKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey", "deriveBits"]
  );
  const pubJwk = await crypto.subtle.exportKey("jwk", e2eKeyPair.publicKey);
  e2eLocalPubRaw = await crypto.subtle.exportKey("raw", e2eKeyPair.publicKey);
  // Send over already-open data channel (raw, not through dcSend so we bypass e2eReady guard)
  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.send(JSON.stringify({ type: "e2e-pubkey", key: pubJwk }));
  }
}

/** ECDH → HKDF → AES-GCM. `secret` (or its absence) changes the resulting key. */
function deriveKeyWith(peerPub, secret) {
  return DC.deriveSharedKey(e2eKeyPair.privateKey, peerPub, secret);
}

/* The confirmation carries the verification code, binding it to both public
   keys — a relayed copy from a different exchange will not match. */
async function sealConfirm(key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify({ v: "confirm-1", code: e2eVerifyCode }));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt);
  return {
    type: "e2e-confirm",
    ct: btoa(String.fromCharCode(...new Uint8Array(ct))),
    iv: btoa(String.fromCharCode(...iv))
  };
}

async function opensConfirm(key, ctB64, ivB64) {
  try {
    const from64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: from64(ivB64) }, key, from64(ctB64));
    const obj = JSON.parse(new TextDecoder().decode(pt));
    return Boolean(obj) && obj.v === "confirm-1" && obj.code === e2eVerifyCode;
  } catch (_) { return false; }
}

function armConfirmTimeout() {
  clearTimeout(e2eConfirmTimer);
  e2eConfirmTimer = setTimeout(() => { if (!e2eReady) e2eFailClosed(); }, E2E_CONFIRM_TIMEOUT_MS);
}

/** Adopt the agreed key and open the chat. `secure` = room secret authenticated it. */
function e2eActivate(key, secure) {
  clearTimeout(e2eConfirmTimer);
  e2eKey        = key;
  e2eReady      = true;
  e2eSecureMode = secure;
  e2eVerified   = secure;   // the link secret already proves there is no middleman
  sendBtn.disabled      = false;
  voiceCallBtn.disabled = false;
  videoCallBtn.disabled = false;
  updateKeyVerifyUi();
  appendSys(secure ? t("sysE2eAuto") : I18N[LANG].sysE2eReady(e2eVerifyCode));
}

/** Refuse to open the channel. Better a dead chat than a silently readable one. */
function e2eFailClosed() {
  clearTimeout(e2eConfirmTimer);
  e2eKey = null; e2eKeyPending = null; e2eCandidates = null; e2ePendingConfirm = null;
  e2eReady = false; e2eVerified = false; e2eSecureMode = false;
  sendBtn.disabled      = true;
  voiceCallBtn.disabled = true;
  videoCallBtn.disabled = true;
  updateKeyVerifyUi();
  appendSys(t("e2eMismatch"));
  showToast(t("e2eMismatch"), "error");
}

async function e2eDeriveKey(peerPubJwk) {
  try {
    const peerPub = await crypto.subtle.importKey(
      "jwk", peerPubJwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,   // extractable only to compute fingerprint
      []
    );
    const peerRaw = await crypto.subtle.exportKey("raw", peerPub);
    e2eVerifyCode = await makeSharedVerificationCode(e2eLocalPubRaw, peerRaw);
    updateKeyVerifyUi();

    if (isHost) {
      /* Guest may hold the room secret (invite link) or not (PIN). Prepare both. */
      e2eCandidates = {
        secure: roomSecret ? await deriveKeyWith(peerPub, roomSecret) : null,
        plain:  await deriveKeyWith(peerPub, null)
      };
    } else {
      e2eKeyPending = await deriveKeyWith(peerPub, roomSecret);
      e2eSecureMode = Boolean(roomSecret);
      dataChannel.send(JSON.stringify(await sealConfirm(e2eKeyPending)));
    }
    armConfirmTimeout();

    /* A confirm can arrive while the derivation above is still running. */
    if (e2ePendingConfirm) {
      const queued = e2ePendingConfirm;
      e2ePendingConfirm = null;
      await handleE2eConfirm(queued);
    }
  } catch (err) {
    console.error("E2E key derivation failed:", err);
    e2eReady = false;
    sendBtn.disabled = true;
    appendSys(t("e2eFailed"));
  }
}

async function handleE2eConfirm(data) {
  if (e2eReady) return;

  if (isHost) {
    if (!e2eCandidates) { e2ePendingConfirm = data; return; }
    const { secure, plain } = e2eCandidates;
    if (secure && await opensConfirm(secure, data.ct, data.iv)) {
      e2eCandidates = null;
      e2eActivate(secure, true);
    } else if (await opensConfirm(plain, data.ct, data.iv)) {
      e2eCandidates = null;
      e2eActivate(plain, false);
    } else {
      /* Neither key opens it: a middleman swapped keys, or the peer is running
         an incompatible build. Either way, do not open the channel. */
      e2eCandidates = null;
      dcSend({ type: "e2e-fail" });
      e2eFailClosed();
      return;
    }
    dataChannel.send(JSON.stringify(await sealConfirm(e2eKey)));
  } else {
    if (!e2eKeyPending) { e2ePendingConfirm = data; return; }
    const key = e2eKeyPending;
    e2eKeyPending = null;
    if (await opensConfirm(key, data.ct, data.iv)) e2eActivate(key, e2eSecureMode);
    else e2eFailClosed();
  }
}

async function e2eEncrypt(plaintext) {
  const iv      = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ct      = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, e2eKey, encoded);
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return { ct: b64(ct), iv: b64(iv) };
}

async function e2eDecrypt(ctB64, ivB64) {
  const from64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const plain  = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: from64(ivB64) },
    e2eKey,
    from64(ctB64)
  );
  return new TextDecoder().decode(plain);
}

async function e2eEncryptBytes(data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const input = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, e2eKey, input);
  return { iv, ct: new Uint8Array(ct) };
}

async function e2eDecryptBytes(ct, iv) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, e2eKey, ct);
  return new Uint8Array(plain);
}

const E2E_BIN_IV_LEN = DC.E2E_BIN_IV_LEN;

/** Send JSON over the data channel inside the same E2E envelope as text. */
async function dcSendE2e(obj) {
  if (!dcReady() || !e2eReady) return false;
  const { ct, iv } = await e2eEncrypt(JSON.stringify(obj));
  dataChannel.send(JSON.stringify({ type: "e2e-dc", ct, iv }));
  return true;
}

/** Call signaling rides inside the E2E data-channel envelope. */
function dcSendCallSignal(obj) {
  return dcSendE2e(obj);
}

const DEFAULT_SERVER_URL = "https://direct-connection.onrender.com";
const SERVER_URL = window.DIRECT_CONNECTION_SERVER_URL ||
  (["localhost", "127.0.0.1"].includes(location.hostname)
    ? `${location.protocol}//${location.hostname}:3000`
    : DEFAULT_SERVER_URL);
const WS_URL = SERVER_URL.replace(/^http/, "ws");
const CHUNK_SIZE    = 65536;
const MAX_DC_MSG    = 200000;
const MAX_P2P_FILE_BYTES = 150 * 1024 * 1024; // 150 MB hard cap for P2P transfers

/** Max size for “leave a message” file; server may raise via /api/ping (Resend email ~40MB cap). */
let maxLeaveAttachBytes = 28 * 1024 * 1024;

function leaveAttachMaxMbRounded() {
  return Math.max(1, Math.round(maxLeaveAttachBytes / 1024 / 1024));
}

/* ══════════════════════════════════════════════
   SERVER WAKE-UP
   ─────────────────────────────────────────────
   Render free tier sleeps after ~15 min idle.
   On page load we hit /api/ping immediately so
   the server is warm by the time the user acts.
   If it takes >2s we surface a notice so the
   user knows to wait rather than retry-spam.
══════════════════════════════════════════════ */

let _serverWoke = false;

function wakeServer() {
  if (_serverWoke) return;
  const wakeNoticeTimer = setTimeout(() => {
    const msg = document.createElement("span");
    msg.className = "server-wake-status";
    msg.style.color = "var(--orange)";
    msg.textContent = `⏳ ${t("serverWaking")}`;
    createInfo.replaceChildren(msg);
  }, 2000);

  // Abort if server doesn't respond within 60s (Render cold start max)
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 60_000);

  fetch(`${SERVER_URL}/api/ping`, { signal: controller.signal })
    .then(r => (r.ok ? r.json() : null))
    .then(j => {
      if (j && typeof j.maxLeaveAttachBytes === "number" && j.maxLeaveAttachBytes >= 1048576) {
        maxLeaveAttachBytes = j.maxLeaveAttachBytes;
        applyI18n();
      }
    })
    .catch(() => {})
    .finally(() => {
      clearTimeout(wakeNoticeTimer);
      clearTimeout(timeout);
    });
}

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302"  },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ],
  iceTransportPolicy: "all"
};

/* ── Apply i18n on load ─────────────────────── */
applyI18n();

/* ══════════════════════════════════════════════
   APPROVAL / AUTO-JOIN
══════════════════════════════════════════════ */

if (_isAutoJoin) overlay.classList.add("hidden");

approveBtn.onclick = () => {
  overlay.classList.add("hidden");
  // WS already connecting in background — nothing else needed
};

function setLobbyButtons(disabled) {
  createBtn.disabled      = disabled;
  sessionIdInput.disabled = disabled;
  refreshBtn.disabled     = disabled;
}

let _autoJoinSent  = false;
let _autoJoinTimer = null;
const AUTO_JOIN_TIMEOUT_MS = 20_000;

function checkAutoJoin() {
  if (!_isAutoJoin || _autoJoinSent) return;
  _autoJoinSent = true;
  isConnecting = true;
  pendingRoomSecret = _autoSecret;   // link join — carries the room secret
  setLobbyButtons(true);
  const msg = document.createElement("span");
  msg.style.color = "var(--accent-text)";
  msg.textContent = I18N[LANG].joiningSession(_autoSessionId);
  createInfo.replaceChildren(msg);
  wsSend({ type: "join-session", sessionId: _autoSessionId, token: _autoToken });

  /* The server always answers a join — unless the socket dies first. Without a
     deadline the lobby stays disabled behind "Joining…" with nothing to click
     and nothing coming. */
  clearTimeout(_autoJoinTimer);
  _autoJoinTimer = setTimeout(autoJoinTimedOut, AUTO_JOIN_TIMEOUT_MS);
}

/** A definitive answer arrived (joined, refused, or errored) — stop the clock. */
function autoJoinSettled() {
  clearTimeout(_autoJoinTimer);
  _autoJoinTimer = null;
}

function autoJoinTimedOut() {
  autoJoinSettled();
  if (currentSession) return;          // it landed after all
  isConnecting = false;
  setLobbyButtons(false);
  const msg = document.createElement("span");
  msg.style.color = "var(--danger-text)";
  msg.textContent = t("joinTimedOut");
  createInfo.replaceChildren(msg);
}

/* ══════════════════════════════════════════════
   WEBSOCKET
══════════════════════════════════════════════ */

function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  ws.onopen    = () => {
    _serverWoke = true;
    // Clear the "waking up" notice — WS open is the true ready signal
    if (createInfo.querySelector(".server-wake-status")) {
      const msg = document.createElement("span");
      msg.className = "server-ready-status";
      msg.style.color = "var(--green)";
      msg.textContent = `✓ ${t("serverReady")}`;
      createInfo.replaceChildren(msg);
      setTimeout(() => {
        if (createInfo.querySelector(".server-ready-status")) createInfo.textContent = "";
      }, 2000);
    }
    requestSessionList();
    checkAutoJoin();
    if (!_keepAliveInterval) {
      _keepAliveInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 10 * 60 * 1000);
    }
  };
  ws.onclose   = () => {
    // Clear keep-alive so it doesn't stack when we reconnect
    if (_keepAliveInterval) { clearInterval(_keepAliveInterval); _keepAliveInterval = null; }
    /* If the socket died between sending the join and hearing back, the answer
       is never coming. Let the reconnect send it again rather than leaving the
       lobby disabled behind "Joining…" forever. */
    if (_isAutoJoin && _autoJoinSent && !currentSession) {
      autoJoinSettled();
      _autoJoinSent = false;
    }
    setTimeout(connectWebSocket, 3000);
  };
  ws.onerror   = (e) => console.error("WS error", e);
  let _signalQueue = Promise.resolve();
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      _signalQueue = _signalQueue.then(() => handleSignaling(data).catch(e => console.error("WS signal error", e)));
    } catch (e) { console.error("WS parse error", e); }
  };
}

let _keepAliveInterval = null;

// Connect on page load — don't wait for approve click
// (no data is sent until user approves; WS just warms up)
connectWebSocket();
wakeServer();

/* Every place a room secret can be held. The join is sent while the secret is
   still in pendingRoomSecret — roomSecret is only assigned once the server
   confirms — so checking roomSecret alone would leave the guard inert during
   exactly the message most likely to leak it. */
function roomSecretsInPlay() {
  return [roomSecret, pendingRoomSecret, _autoSecret];
}

function wsSend(obj) {
  /* The room secret must never reach the server — see README, "Invite links".
     Refuse rather than send: dropping one signaling message is recoverable,
     whereas leaking the secret silently removes the man-in-the-middle
     protection with nothing appearing to be wrong. */
  for (const secret of roomSecretsInPlay()) {
    if (DC.payloadLeaksSecret(obj, secret)) {
      console.error(`Refusing to send "${obj && obj.type}": payload contains the room secret`);
      return;
    }
  }
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/* ══════════════════════════════════════════════
   LOBBY
══════════════════════════════════════════════ */

function requestSessionList() { wsSend({ type: "list-sessions" }); }
refreshBtn.onclick = requestSessionList;

function renderSessionList(sessions) {
  _lastSessionList = sessions || [];
  if (!_lastSessionList.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("noRooms");
    sessionsList.replaceChildren(empty);
    return;
  }
  sessionsList.replaceChildren();
  _lastSessionList.forEach(({ sessionId, createdAt }) => {
    const item = document.createElement("div");
    item.className = "session-item";
    const info = document.createElement("div");
    info.className = "session-item-info";
    const name = document.createElement("div");
    name.className = "session-item-name";
    name.textContent = `📡 ${sessionId}`;
    const meta = document.createElement("div");
    meta.className = "session-item-meta";
    meta.textContent = I18N[LANG].sessionMeta(timeAgo(createdAt));
    const joinBtn = document.createElement("button");
    joinBtn.className = "join-btn";
    joinBtn.dataset.id = sessionId;
    joinBtn.textContent = t("joinBtn");
    joinBtn.onclick = () => openPinModal(sessionId);
    info.append(name, meta);
    item.append(info, joinBtn);
    sessionsList.appendChild(item);
  });
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return I18N[LANG].timeS(s);
  if (s < 3600) return I18N[LANG].timeM(Math.floor(s / 60));
  return I18N[LANG].timeH(Math.floor(s / 3600));
}

createBtn.onclick = () => {
  const sessionId = sessionIdInput.value.trim();
  if (!sessionId) { showToast(t("enterSessionName"), "warn"); return; }
  if (isConnecting) return;
  isConnecting = true;
  createBtn.disabled = true;
  createInfo.textContent = t("creating");
  wsSend({ type: "create-session", sessionId });
};

/* ── PIN modal ───────────────────────────────── */
let pendingJoinId = null;

function openPinModal(sessionId) {
  pendingJoinId = sessionId;
  pinSessionLabel.textContent = I18N[LANG].sessionLabel(sessionId);
  pinInput.value = "";
  pinError.textContent = "";
  pinOverlay.classList.remove("hidden");
  setTimeout(() => pinInput.focus(), 100);
}

pinCancelBtn.onclick = () => { pinOverlay.classList.add("hidden"); pendingJoinId = null; };
pinJoinBtn.onclick = attemptJoin;
pinInput.addEventListener("keydown", e => { if (e.key === "Enter") attemptJoin(); });

function attemptJoin() {
  const pin = pinInput.value.trim();
  if (pin.length !== 6) { pinError.textContent = t("pinMustBe6"); return; }
  pinError.textContent = "";
  pinJoinBtn.disabled = true;
  pendingRoomSecret = null;   // PIN join — no shared secret, manual verification applies
  wsSend({ type: "join-session", sessionId: pendingJoinId, pin });
}

/* ══════════════════════════════════════════════
   WEBRTC — DATA CHANNEL PC
══════════════════════════════════════════════ */

function closePeerConnection() {
  /* A voice note belongs to the room it was recorded in. Leaving, or the peer
     leaving, ends both — and releases the microphone, which otherwise stayed
     live all the way back to the lobby. */
  abandonVoiceRecording();
  iceQueue = [];
  callIceQueue = [];
  e2eKey = null;
  e2eKeyPair = null;
  e2eReady = false;
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  renderConnectionPath(null);   // no connection, no path — the badge must not linger
  e2eVerifyCode = "";
  e2eVerified = false;
  e2eLocalPubRaw = null;
  e2eSecureMode = false;
  e2eCandidates = null;
  e2eKeyPending = null;
  e2ePendingConfirm = null;
  clearTimeout(e2eConfirmTimer);
  updateKeyVerifyUi();
  if (pc) {
    pc.onicecandidate = pc.oniceconnectionstatechange =
    pc.ondatachannel  = pc.ontrack = null;
    pc.close(); pc = null;
  }
  closeCallPeerConnection();
  dataChannel = null;
  sendBtn.disabled = true;
}

function createPeerConnection() {
  closePeerConnection();
  pc = new RTCPeerConnection(ICE_CONFIG);

  pc.onicecandidate = ({ candidate }) => {
    // Null candidate = gathering finished. currentSession can already be gone if
    // the user left mid-gathering — candidates now outlive the old blocking wait.
    if (!candidate || !currentSession) return;
    wsSend({ type: "ice-candidate", candidate, sessionId: currentSession.sessionId });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === "checking")                        setQuality(`⬤ ${t("connecting")}`, "");
    if (s === "connected" || s === "completed")  { setQuality(`⬤ ${t("connected")}`, "connected"); startStatsPolling(); }
    if (s === "disconnected")                    { setQuality(`⬤ ${t("reconnecting")}`, "poor"); pc.restartIce(); }
    if (s === "failed")                          { setQuality(`⬤ ${t("connFailed")}`, "failed"); handleFullRenegotiation(); }
    if (s === "closed")                          setQuality(`⬤ ${t("connClosed")}`, "failed");
  };

  pc.ondatachannel = ({ channel }) => { dataChannel = channel; setupDataChannel(); };

  pc.ontrack = null;
}

function createCallPeerConnection() {
  closeCallPeerConnection();
  remoteCallStream = new MediaStream();
  remoteVideo.srcObject = remoteCallStream;
  callPc = new RTCPeerConnection(ICE_CONFIG);

  callPc.onicecandidate = ({ candidate }) => {
    if (!candidate || !currentSession) return;
    dcSendCallSignal({ type: "call-ice", candidate });
  };

  callPc.onconnectionstatechange = () => {
    if (!callPc) return;
    const state = callPc.connectionState;
    if (state === "connected") {
      callStatusLabel.textContent = t("callConnected");
    }
    if (state === "failed" || state === "closed") {
      if (inCall) endCall(false);
    }
  };

  callPc.ontrack = ({ track }) => {
    // Always store the stream even if inCall hasn't been set yet —
    // the callee's ontrack fires during setRemoteDescription(offer),
    // which happens before inCall = true on their side.
    if (!remoteCallStream) {
      remoteCallStream = new MediaStream();
      remoteVideo.srcObject = remoteCallStream;
    }
    if (!remoteCallStream.getTracks().includes(track)) remoteCallStream.addTrack(track);
    track.onunmute = () => playRemoteCallMedia();

    // Play and update status only when the call is actually active
    if (inCall) {
      playRemoteCallMedia();
      callStatusLabel.textContent = t("callConnected");
    } else {
      // Store for later — play() is called again when inCall becomes true
      remoteVideo._pendingPlay = true;
    }
  };
}

function playRemoteCallMedia() {
  if (!remoteVideo.srcObject && remoteCallStream) remoteVideo.srcObject = remoteCallStream;
  remoteVideo.play().catch(() => {});
}

function closeCallPeerConnection() {
  if (callPc) {
    callPc.onicecandidate = callPc.onconnectionstatechange = callPc.ontrack = null;
    callPc.close();
    callPc = null;
  }
  remoteCallStream = null;
}

function isChatLinkUp() {
  if (!pc) return false;
  const ice = pc.iceConnectionState;
  return ice === "connected" || ice === "completed";
}

async function handleFullRenegotiation() {
  if (!pc || !currentSession || !isHost) return;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    // Send immediately — restarted ICE candidates trickle in behind it
    wsSend({ type: "renegotiate-offer", offer: pc.localDescription, sessionId: currentSession.sessionId });
  } catch (e) { console.error("Renegotiation error:", e); }
}

function setupDataChannel() {
  dataChannel.binaryType = "arraybuffer";

  dataChannel.onopen = async () => {
    // sendBtn stays disabled until E2E key exchange completes (usually <100ms)
    voiceCallBtn.disabled = true;
    videoCallBtn.disabled = true;
    appendSys(t("sysConnected"));
    appendSys(t("e2eWaiting"));
    e2eReady = false;
    await e2eInit();
    // sendBtn enabled in e2eDeriveKey() once shared key is ready
  };

  dataChannel.onclose = () => {
    sendBtn.disabled = true;
    voiceCallBtn.disabled = true;
    videoCallBtn.disabled = true;
    appendSys(t("sysClosed"));
    // Clean up unacknowledged messages and incomplete transfers to free memory
    for (const k of Object.keys(pendingAcks)) delete pendingAcks[k];
    for (const k of Object.keys(recvBuffers)) delete recvBuffers[k];
    for (const k of Object.keys(orphanChunks)) delete orphanChunks[k];
    orphanChunkCount = 0;
    showReconnectButton();
  };

  dataChannel.onerror = e => console.error("DC error", e);

  dataChannel.onmessage = ({ data }) => {
    if (typeof data === "string") {
      try { handleTextMessage(JSON.parse(data)); }
      catch (err) { console.error("DC parse error", err); }
    } else {
      handleBinaryChunk(data);
    }
  };
}

/* ══════════════════════════════════════════════
   SIGNALING HANDLER
══════════════════════════════════════════════ */

async function handleSignaling(data) {
  switch (data.type) {

    case "session-list":
      renderSessionList(data.sessions);
      break;

    case "session-created": {
      isHost = true;
      currentSession = { sessionId: data.sessionId, token: data.token };
      /* Minted here, in the browser — the server never learns it. */
      roomSecret = makeRoomSecret();

      const shareUrl = `${location.origin}${location.pathname}#${DC.buildInviteHash(data.sessionId, data.token, roomSecret)}`;

      createInfo.style.textAlign = "left";
      const ready = document.createElement("div");
      ready.style.cssText = "text-align:center;margin-bottom:14px";
      ready.textContent = t("roomReady");

      const pinBox = document.createElement("div");
      pinBox.style.cssText = "background:var(--sunken);border-radius:10px;padding:14px;margin-bottom:12px;text-align:center";
      const pinLabel = document.createElement("div");
      pinLabel.style.cssText = "font-size:11px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:1px";
      pinLabel.textContent = t("pinCode");
      const pinValue = document.createElement("div");
      pinValue.style.cssText = "font-size:28px;font-weight:700;letter-spacing:10px;color:var(--text)";
      pinValue.textContent = data.pin;
      const pinHint = document.createElement("div");
      pinHint.style.cssText = "font-size:11px;color:var(--muted);margin-top:4px";
      pinHint.textContent = t("pinCodeHint");
      pinBox.append(pinLabel, pinValue, pinHint);

      const linkHint = document.createElement("div");
      linkHint.style.cssText = "font-size:12px;color:var(--muted);margin-bottom:6px";
      linkHint.textContent = t("linkHint");
      const linkRow = document.createElement("div");
      linkRow.style.cssText = "display:flex;gap:6px;align-items:center";
      const shareUrlInput = document.createElement("input");
      shareUrlInput.id = "shareUrlInput";
      shareUrlInput.type = "text";
      shareUrlInput.value = shareUrl;
      shareUrlInput.readOnly = true;
      shareUrlInput.style.cssText = "font-size:11px;padding:8px 10px;border-radius:8px;flex:1;min-width:0;background:var(--sunken);color:var(--accent-text);border:1px solid var(--border)";
      const copyLinkBtn = document.createElement("button");
      copyLinkBtn.id = "copyLinkBtn";
      copyLinkBtn.style.cssText = "width:auto;margin:0;padding:8px 14px;font-size:13px;min-height:36px;border-radius:8px;flex-shrink:0";
      copyLinkBtn.textContent = t("copyBtn");
      linkRow.append(shareUrlInput, copyLinkBtn);
      createInfo.replaceChildren(ready, pinBox, linkHint, linkRow);

      copyLinkBtn.onclick = () => {
        navigator.clipboard.writeText(shareUrl).then(() => {
          copyLinkBtn.textContent = t("copiedBtn");
          setTimeout(() => { const b = document.getElementById("copyLinkBtn"); if (b) b.textContent = t("copyBtn"); }, 2000);
        }).catch(() => {
          shareUrlInput.select();
          document.execCommand("copy");
          copyLinkBtn.textContent = t("copiedBtn");
        });
      };

      createBtn.disabled = false;
      isConnecting = false;
      requestSessionList();
      break;
    }

    case "session-joined":
      autoJoinSettled();
      isHost = false;
      currentSession = { sessionId: data.sessionId };
      /* Present only when this join came from an invite link. */
      roomSecret = pendingRoomSecret;
      pendingRoomSecret = null;
      pinOverlay.classList.add("hidden");
      switchToChat(data.sessionId);
      createPeerConnection();
      break;

    case "guest-joined":
      switchToChat(currentSession.sessionId);
      createPeerConnection();
      dataChannel = pc.createDataChannel("chat");
      dataChannel.binaryType = "arraybuffer";
      setupDataChannel();
      {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        // Send immediately — trickle ICE candidates follow via ice-candidate messages
        wsSend({ type: "offer", offer: pc.localDescription, sessionId: currentSession.sessionId });
      }
      break;

    case "offer":
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      while (iceQueue.length) {
        try { await pc.addIceCandidate(iceQueue.shift()); } catch (e) { console.error(e); }
      }
      {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        // Send immediately — trickle ICE candidates follow via ice-candidate messages
        wsSend({ type: "answer", answer: pc.localDescription, sessionId: currentSession.sessionId });
      }
      break;

    case "answer":
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      while (iceQueue.length) {
        try { await pc.addIceCandidate(iceQueue.shift()); } catch (e) { console.error(e); }
      }
      break;

    case "ice-candidate":
      if (!pc) break;
      if (pc.remoteDescription && pc.remoteDescription.type) {
        try { await pc.addIceCandidate(data.candidate); } catch (e) { console.error(e); }
      } else {
        iceQueue.push(data.candidate);
      }
      break;

    case "renegotiate-offer":
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      {
        const ra = await pc.createAnswer();
        await pc.setLocalDescription(ra);
        // Send immediately — trickle ICE candidates follow via ice-candidate messages
        wsSend({ type: "renegotiate-answer", answer: pc.localDescription, sessionId: currentSession.sessionId });
      }
      break;

    case "renegotiate-answer":
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      break;

    /* No call-offer / call-answer / call-ice cases here on purpose. Call
       signaling arrives only through the encrypted data channel (see
       handleTextMessage). Accepting it from the WebSocket would let the
       signaling server inject a call offer and start getUserMedia without the
       peer ever asking, bypassing the end-to-end channel entirely. */

    case "peer-disconnected":
      appendSys(t("sysPeerLeft"));
      endCall(false);
      closePeerConnection();
      showReconnectButton();
      break;

    case "error":
      autoJoinSettled();
      console.error("[Server error]", data.message);
      if (_isAutoJoin && isConnecting) {
        const msg = document.createElement("span");
        msg.style.color = "var(--danger-text)";
        msg.textContent = `❌ ${data.message}`;
        createInfo.replaceChildren(msg);
        setLobbyButtons(false);
        isConnecting = false;
      } else {
        showToast(data.message, "error");
        createInfo.textContent = "";
        createBtn.disabled = false;
        pinJoinBtn.disabled = false;
        isConnecting = false;
      }
      break;

    case "pin-error": {
      autoJoinSettled();
      // Translate structured error codes from server
      let msg;
      if      (data.code === "rate-limited")        msg = I18N[LANG].pinRateLimited(data.remaining);
      else if (data.code === "session-join-locked") msg = I18N[LANG].sessionJoinLocked(data.remaining);
      else if (data.code === "wrong-pin")           msg = I18N[LANG].pinAttemptsLeft(data.attemptsLeft);
      else if (data.code === "not-found")     msg = t("sessionNotFound");
      else if (data.code === "full")          msg = t("sessionFull");
      else                                    msg = data.message || "Error";

      if (_isAutoJoin) {
        const wrap = document.createElement("span");
        wrap.style.color = "var(--danger-text)";
        wrap.append(document.createTextNode(I18N[LANG].couldNotJoin(msg)));
        wrap.appendChild(document.createElement("br"));
        const small = document.createElement("small");
        small.style.color = "var(--muted)";
        small.textContent = t("sessionExpired");
        wrap.appendChild(small);
        createInfo.replaceChildren(wrap);
        setLobbyButtons(false);
        isConnecting = false;
      } else {
        pinError.textContent = msg;
        pinJoinBtn.disabled  = false;
      }
      break;
    }
  }
}

/* ══════════════════════════════════════════════
   SCREEN TRANSITIONS
══════════════════════════════════════════════ */

function switchToChat(sessionId) {
  lobbyScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  document.getElementById("langSwitcher").style.display = "none";
  chatSessionLabel.textContent = sessionId;
  setQuality(`⬤ ${t("connecting")}`, "");
  chatMessages.replaceChildren();
  sendBtn.disabled = true;
  voiceCallBtn.disabled = true;
  videoCallBtn.disabled = true;
}

leaveBtn.onclick = () => {
  wsSend({ type: "leave-session", sessionId: currentSession?.sessionId });
  endCall(false);
  closePeerConnection();
  revokeTrackedBlobUrls(); // free all file/image/voice blob memory
  currentSession = null;
  roomSecret = null;
  pendingRoomSecret = null;
  isHost = false;
  isConnecting = false;
  chatScreen.classList.add("hidden");
  lobbyScreen.classList.remove("hidden");
  document.getElementById("langSwitcher").style.display = "";
  createInfo.textContent = "";
  createBtn.disabled = false;
  sessionIdInput.value = "";
  requestSessionList();
};

/* ══════════════════════════════════════════════
   STATS
══════════════════════════════════════════════ */

/**
 * The candidate pair ICE actually settled on.
 *
 * transport.selectedCandidatePairId names it outright where available; the scan
 * is a fallback for browsers that omit it. Reading any succeeded pair is not
 * good enough — several can succeed and only one carries traffic.
 */
function selectedCandidatePair(stats) {
  let transport = null;
  stats.forEach(r => { if (r.type === "transport") transport = r; });
  if (transport && transport.selectedCandidatePairId) {
    const named = stats.get(transport.selectedCandidatePairId);
    if (named) return named;
  }
  let pair = null;
  stats.forEach(r => {
    if (r.type === "candidate-pair" && r.state === "succeeded" && (r.nominated || !pair)) pair = r;
  });
  return pair;
}

/**
 * How the two sides are actually reaching each other.
 *
 * "relayed" is the one that matters: it means a TURN server sits in the middle
 * carrying every packet. The contents stay encrypted end to end, but that
 * server learns who is talking to whom and for how long — a different trust
 * situation from a direct connection, and one the user should not have to infer
 * from a candidate type like "srflx".
 *
 * Returns null while ICE is still deciding.
 */
function describeConnectionPath(stats) {
  const pair = selectedCandidatePair(stats);
  if (!pair) return null;
  const local  = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  if (!local || !remote) return null;

  const types = [local.candidateType, remote.candidateType];
  let kind;
  if (types.includes("relay"))                kind = "relayed";
  else if (types.every(t => t === "host"))    kind = "local";
  else                                        kind = "direct";
  return { kind, local, remote };
}

/** Writes the path badge that sits after the connection state in the header. */
function renderConnectionPath(path) {
  _lastPath = path;
  if (!path) { connectionPath.classList.add("hidden"); connectionPath.title = ""; return; }
  const label = { direct: "pathDirect", local: "pathLocal", relayed: "pathRelayed" }[path.kind];
  const hint  = { direct: "pathDirectHint", local: "pathLocalHint", relayed: "pathRelayedHint" }[path.kind];
  connectionPath.textContent = t(label);
  connectionPath.title       = t(hint);
  connectionPath.className   = `path-badge path-${path.kind}`;
}

function startStatsPolling() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(async () => {
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      const path  = describeConnectionPath(stats);
      const pair  = selectedCandidatePair(stats);

      let sent = 0, recv = 0;
      stats.forEach(r => {
        if (r.type === "outbound-rtp") sent += r.bytesSent || 0;
        if (r.type === "inbound-rtp")  recv += r.bytesReceived || 0;
      });
      /* Data-channel traffic shows up on the pair, not on rtp reports, so fall
         back to it — otherwise a chat-only session reports nothing moving. */
      if (!sent && pair) sent = pair.bytesSent || 0;
      if (!recv && pair) recv = pair.bytesReceived || 0;

      const rtt = pair && typeof pair.currentRoundTripTime === "number"
        ? pair.currentRoundTripTime : null;

      const parts = [];
      if (rtt !== null) {
        const ms = Math.round(rtt * 1000);
        parts.push(`RTT: ${ms}ms`);
        if (ms < 80)       setQuality(`⬤ ${t("connected")}`, "connected");
        else if (ms < 250) setQuality(`⬤ ${t("fair")}`, "poor");
        else               setQuality(`⬤ ${t("poor")}`, "poor");
      }
      renderConnectionPath(path);

      if (sent)  parts.push(`↑ ${fmtBytes(sent)}`);
      if (recv)  parts.push(`↓ ${fmtBytes(recv)}`);
      /* The header says direct or relayed in words; the detail belongs here. */
      if (path) parts.push(`${path.local.candidateType} → ${path.remote.candidateType}`);
      statsBar.textContent = parts.join("   ");
    } catch (_) {}
  }, 2000);
}

function fmtBytes(b) {
  if (b < 1024)    return `${b}B`;
  if (b < 1048576) return `${(b/1024).toFixed(1)}KB`;
  return `${(b/1048576).toFixed(1)}MB`;
}

function setQuality(text, cls) {
  /* Writes the state only. The path badge is a separate child of
     #connectionQuality so it survives every state change. */
  connectionState.textContent = text;
  connectionQuality.className = "quality-label " + cls;
}

/* ══════════════════════════════════════════════
   TEXT MESSAGING + TYPING
══════════════════════════════════════════════ */

sendBtn.onclick = sendTextMessage;
messageInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
});
messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
  sendTypingSignal();
});

function sendTypingSignal() {
  if (!dcReady()) return;
  dcSend({ type: "typing" });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => dcSend({ type: "typing-stop" }), 1500);
}

async function sendTextMessage() {
  const text = messageInput.value.trim();
  if (!text || !dcReady()) return;
  if (!e2eReady) {
    appendSys(t("e2eWaiting"));
    return;
  }
  const msgId = ++msgIdCounter;

  const { ct, iv } = await e2eEncrypt(text);
  dataChannel.send(JSON.stringify({ type: "text", ct, iv, msgId }));

  const row = appendBubble("me", text);
  addAckTick(row, msgId);
  pendingAcks[msgId] = row;
  messageInput.value = "";
  messageInput.style.height = "auto";
  dataChannel.send(JSON.stringify({ type: "typing-stop" }));
}

function handleTextMessage(data) {
  switch (data.type) {

    case "e2e-dc":
      if (!e2eReady) break;
      e2eDecrypt(data.ct, data.iv)
        .then(json => handleTextMessage(JSON.parse(json)))
        .catch(err => console.error("E2E envelope decrypt failed:", err));
      break;

    case "text":
      /* Only ever show a message the agreed key opened. sendTextMessage refuses
         to send until e2eReady, so an unencrypted body is never a real peer —
         and rendering one would undo e2eFailClosed(): that disables sending, but
         a middleman caught swapping keys could still write into this window.
         Same rule, and same silent drop, as the e2e-dc envelope above. */
      if (!e2eReady || !data.ct) {
        console.warn("Dropping a text message that was not end-to-end encrypted");
        break;
      }
      e2eDecrypt(data.ct, data.iv)
        .then(plain => {
          appendBubble("peer", plain);
          dcSend({ type: "ack", msgId: data.msgId });
        })
        .catch(err => {
          console.error("Decrypt failed:", err);
          appendBubble("peer", "⚠️ [decrypt error]");
        });
      break;

    case "e2e-pubkey":
      e2eDeriveKey(data.key);
      break;

    case "e2e-confirm":
      handleE2eConfirm(data).catch(err => {
        console.error("E2E confirmation failed:", err);
        e2eFailClosed();
      });
      break;

    case "e2e-fail":
      e2eFailClosed();
      break;

    case "ack":
      if (pendingAcks[data.msgId]) { markDelivered(pendingAcks[data.msgId]); delete pendingAcks[data.msgId]; }
      break;

    case "typing":
      if (!peerTyping) {
        peerTyping = true;
        typingIndicator.textContent = t("peerTyping");
        typingIndicator.classList.remove("hidden");
      }
      break;

    case "typing-stop":
      peerTyping = false;
      typingIndicator.classList.add("hidden");
      break;

    case "transfer-meta": {
      const info = newRecvBuffer(data);
      recvBuffers[data.id] = info;
      if (data.kind === "file")  appendFileBubble("peer", null, data.name, data.size, data.id);
      if (data.kind === "image") appendImagePlaceholder("peer", data.id, data.name);
      if (data.kind === "voice") appendVoicePlaceholder("peer", data.id);
      /* Chunks that outran this message: feed them through in arrival order. */
      for (const early of takeOrphanChunks(data.id)) acceptChunk(info, data.id, early);
      break;
    }

    case "transfer-done":
      assembleTransfer(data.id).catch(err => {
        console.error("Transfer assemble failed:", err);
        failTransfer(data.id);
      });
      break;

    case "call-request":
      handleCallRequest(data);
      break;

    case "call-reject":
      endCall(false);
      appendSys(t("sysCallEnded"));
      break;

    case "call-accept":
      initiateCallOffer(data.withVideo);
      break;

    case "call-offer":
      handleIncomingCallOffer(data);
      break;

    case "call-answer":
      handleCallAnswer(data);
      break;

    case "call-ice":
      handleCallIce(data.candidate);
      break;
  }
}

/* ══════════════════════════════════════════════
   BINARY TRANSFER PROTOCOL
══════════════════════════════════════════════ */

const makeTransferId = DC.makeTransferId;

async function sendBinary(file, kind) {
  if (!dcReady()) return;
  if (!e2eReady) { appendSys(t("e2eWaiting")); return; }

  // File size limit — prevent OOM and very long transfers
  const maxMb = Math.round(MAX_P2P_FILE_BYTES / 1024 / 1024);
  if (file.size > MAX_P2P_FILE_BYTES) {
    showToast(I18N[LANG].fileTooLargeP2P(maxMb), "warn");
    return;
  }

  const id = makeTransferId();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  await dcSendE2e({
    type: "transfer-meta", id,
    name: file.name || "voice.webm", size: file.size,
    mimeType: file.type || "audio/webm", kind, totalChunks
  });

  const localUrl = trackBlobUrl(URL.createObjectURL(file));  // tracked — revoked on leave
  if (kind === "file")  appendFileBubble("me", localUrl, file.name, file.size, null);
  if (kind === "image") resolveImageNow("me", localUrl, file.name);
  if (kind === "voice") resolveVoiceNow("me", localUrl);
  attachSendProgress(id);

  const idBytes = new TextEncoder().encode(id);
  let lastPct = -1;
  for (let i = 0; i < totalChunks; i++) {
    /* Read one slice at a time. file.arrayBuffer() would pull the whole file
       into the JS heap — 150 MB of it in the worst case — when only 64 KB is
       needed; the File itself stays backed by disk. */
    const chunk = await file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer();
    const { iv, ct } = await e2eEncryptBytes(chunk);
    const packet = DC.packChunk(idBytes, iv, ct);
    await drainBuffer();
    dataChannel.send(packet.buffer);

    const pct = Math.floor(((i + 1) / totalChunks) * 100);
    if (pct !== lastPct) { lastPct = pct; setTransferProgress(id, pct, "sending"); }
  }

  clearSendProgress(id);
  await dcSendE2e({ type: "transfer-done", id });
}

/* Plaintext chunks are folded into a Blob every DECRYPT_BATCH, so the JS heap
   holds at most one batch instead of the whole file. Blobs of this size get
   spilled to disk by the browser rather than kept in the heap. */
const DECRYPT_BATCH = 32;   // ~2 MB of plaintext per fold

/** Fresh receive state for one incoming transfer. */
function newRecvBuffer(meta) {
  return {
    blobParts: [],            // decrypted batches, already out of the heap
    pending:   [],            // decrypted chunks awaiting the next fold
    received:  0,
    failed:    false,
    lastPct:   -1,
    chain:     Promise.resolve(),   // serialises decryption so order is preserved
    name: meta.name, size: meta.size, mimeType: meta.mimeType,
    kind: meta.kind, totalChunks: meta.totalChunks
  };
}

/** Decrypt on arrival rather than hoarding ciphertext until transfer-done. */
function acceptChunk(info, id, packet) {
  info.received++;
  info.chain = info.chain
    .then(async () => {
      if (info.failed) return;
      /* Too short to hold an IV — the stream is corrupt, so fail the transfer
         instead of skipping bytes and delivering a damaged file. */
      const split = DC.splitChunkBody(packet);
      if (!split) throw new Error(`chunk shorter than IV (${packet.byteLength}B)`);
      info.pending.push(await e2eDecryptBytes(split.ct, split.iv));
      if (info.pending.length >= DECRYPT_BATCH) {
        info.blobParts.push(new Blob(info.pending));
        info.pending = [];
      }
    })
    .catch(err => {
      info.failed = true;
      console.error(`Transfer ${id}: chunk could not be decrypted —`, err);
    });
  reportTransferProgress(id, info);
}

function handleBinaryChunk(buffer) {
  const { id, body: chunkData } = DC.unpackChunk(buffer);

  const info = recvBuffers[id];
  if (info) { acceptChunk(info, id, chunkData); return; }

  /* Metadata is still decrypting — hold the chunk rather than dropping it.
     Past the cap we do drop, and assembleTransfer reports the gap. */
  if (orphanChunkCount >= ORPHAN_CHUNK_MAX) return;
  if (!orphanChunks[id]) orphanChunks[id] = [];
  orphanChunks[id].push(chunkData);
  orphanChunkCount++;
}

/* ── Transfer progress ──────────────────────── */

/** The one place a transfer id becomes a selector.
    The id arrives in transfer-meta, so the peer chooses it: unescaped, a
    crafted value could break the selector or steer it at a different message's
    bubble. Every lookup goes through here so no call site can forget. */
function findTransferRow(id) {
  return chatMessages.querySelector(`[data-tid="${CSS.escape(String(id))}"]`);
}

function setTransferProgress(id, pct, mode) {
  const row = findTransferRow(id);
  const el  = row && row.querySelector(".transfer-pending");
  if (el) el.textContent = `${t(mode)} ${pct}%`;
}

function reportTransferProgress(id, info) {
  if (!Number.isFinite(info.totalChunks) || info.totalChunks <= 0) return;
  /* Hold at 99% until assembly finishes, so 100% means genuinely done. */
  const pct = Math.min(99, Math.floor((info.received / info.totalChunks) * 100));
  if (pct === info.lastPct) return;
  info.lastPct = pct;
  setTransferProgress(id, pct, "receiving");
}

/** Tag the just-appended local bubble so the sender sees progress too. */
function attachSendProgress(id) {
  const row = chatMessages.lastElementChild;
  if (!row || !row.classList.contains("bubble-row")) return;
  row.dataset.tid = id;
  const host = row.querySelector(".bubble") || row;
  const line = document.createElement("div");
  line.className = "transfer-pending send-progress";
  line.style.cssText = "color:var(--muted);font-size:11px;margin-top:4px";
  line.textContent = `${t("sending")} 0%`;
  host.appendChild(line);
}

function clearSendProgress(id) {
  const row = findTransferRow(id);
  const line = row && row.querySelector(".send-progress");
  if (line) line.remove();
}

async function assembleTransfer(id) {
  const info = recvBuffers[id];
  delete recvBuffers[id];
  takeOrphanChunks(id);          // metadata never arrived for these, if any

  if (!info) {
    console.error(`Transfer ${id}: no metadata received`);
    appendSys(t("transferFailed"));
    return;
  }

  await info.chain;   // let any still-queued decryptions finish

  if (info.failed) { failTransfer(id); return; }

  /* totalChunks is authoritative. A short count means chunks were lost, and a
     silently truncated file is worse than a visible failure. Older peers may
     omit the field — skip the check rather than fail their transfers. */
  if (Number.isFinite(info.totalChunks) && info.received !== info.totalChunks) {
    console.error(`Transfer ${id}: expected ${info.totalChunks} chunks, got ${info.received}`);
    failTransfer(id);
    return;
  }

  if (info.pending.length) {
    info.blobParts.push(new Blob(info.pending));
    info.pending = [];
  }
  const blob = new Blob(info.blobParts, { type: info.mimeType });
  info.blobParts = [];
  const url = trackBlobUrl(URL.createObjectURL(blob));  // tracked — revoked on leave

  if (info.kind === "file")  resolveFileBubble(id, url, info.name);
  if (info.kind === "image") resolveImagePlaceholder(id, url, info.name);
  if (info.kind === "voice") resolveVoicePlaceholder(id, url);
}

/** Marks a receiving placeholder as failed rather than delivering a truncated file. */
function failTransfer(id) {
  const row     = findTransferRow(id);
  const pending = row && row.querySelector(".transfer-pending");
  if (!pending) { appendSys(t("transferFailed")); return; }
  pending.textContent = `⚠️ ${t("transferFailed")}`;
  pending.classList.remove("transfer-pending");
  pending.classList.add("transfer-failed");
  pending.style.color = "var(--danger-text)";   // beats the inline colour set on the placeholder
  scrollBottom();
}

function drainBuffer() {
  return new Promise(resolve => {
    const deadline = Date.now() + 30_000; // give up after 30s — don't freeze forever
    const check = () => {
      if (!dataChannel || dataChannel.bufferedAmount < 262144) { resolve(); return; }
      if (Date.now() > deadline) { resolve(); return; } // channel stalled — proceed anyway
      setTimeout(check, 50);
    };
    check();
  });
}

/* ══════════════════════════════════════════════
   IMAGE SEND
══════════════════════════════════════════════ */

sendImageBtn.onclick = () => { attachMenu.classList.add("hidden"); imageInput.click(); };
imageInput.onchange = () => {
  const file = imageInput.files[0];
  if (!file) return;
  sendBinary(file, "image");
  imageInput.value = "";
};

/* ══════════════════════════════════════════════
   FILE SEND
══════════════════════════════════════════════ */

sendFileBtn.onclick = () => { attachMenu.classList.add("hidden"); fileInput.click(); };
fileInput.onchange = () => {
  const file = fileInput.files[0];
  if (!file) return;
  sendBinary(file, "file");
  fileInput.value = "";
};

/* ══════════════════════════════════════════════
   VOICE NOTE
══════════════════════════════════════════════ */

voiceRecordBtn.addEventListener("click", toggleVoiceRecord);
voiceRecordBtn.title = t("recordVoice");

let _isRecording = false;

/**
 * Releases the microphone and resets the button. Safe to call repeatedly, and
 * from anywhere — the stream is held at module scope precisely so that any code
 * path can switch the hardware off, not just the one that turned it on.
 */
function releaseVoiceCapture() {
  if (voiceStream) {
    voiceStream.getTracks().forEach(track => track.stop());
    voiceStream = null;
  }
  _isRecording = false;
  voiceRecordBtn.classList.remove("recording");
  voiceRecordBtn.title = t("recordVoice");
}

/**
 * Throws away a recording in progress: microphone off, audio dropped, nothing
 * sent. Called when the room goes away, since a recording only ever belongs to
 * the room it started in.
 */
function abandonVoiceRecording() {
  if (!_isRecording && !voiceStream) return;
  voiceDiscard = true;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch (_) { /* onstop may not fire — clean up below */ }
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") return;   // onstop will finish it
  voiceChunks = [];
  voiceSession = null;
  releaseVoiceCapture();
}

async function toggleVoiceRecord() {
  /* Stopping comes first and is never gated on the connection: a recording in
     progress must always be stoppable, including after the peer has gone. */
  if (_isRecording) {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    else releaseVoiceCapture();
    return;
  }

  if (!dcReady()) return;
  if (!e2eReady) { appendSys(t("e2eWaiting")); return; }

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceStream  = stream;
    voiceChunks  = [];
    voiceDiscard = false;
    /* Remember which room this belongs to. onstop can run long after, in a
       different room entirely — see the check there. */
    voiceSession = currentSession && currentSession.sessionId;

    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => voiceChunks.push(e.data);

    mediaRecorder.onstop = () => {
      const chunks = voiceChunks;
      voiceChunks = [];
      const discard  = voiceDiscard;
      const sameRoom = Boolean(voiceSession) && currentSession &&
                       currentSession.sessionId === voiceSession;
      voiceDiscard = false;
      voiceSession = null;
      releaseVoiceCapture();

      /* Refuse to deliver audio to anyone but the room it was recorded in. The
         recorder outlives the room otherwise: leave while recording, join
         somewhere else, press the button again, and this would hand the new
         peer everything captured since — including the time in between. */
      if (discard || !sameRoom || !dcReady()) {
        if (!discard && chunks.length) console.warn("Discarding a voice note: the room it was recorded in is gone");
        return;
      }
      const blob = new Blob(chunks, { type: "audio/webm" });
      sendBinary(new File([blob], "voice.webm", { type: "audio/webm" }), "voice");
    };

    mediaRecorder.start();
    _isRecording = true;
    voiceRecordBtn.classList.add("recording");
    voiceRecordBtn.title = t("stopRecord");

  } catch (err) {
    /* getUserMedia may well have succeeded and MediaRecorder then failed — an
       unsupported codec does exactly that. The stream is live either way and
       must not be left running, which would keep the microphone on with the
       browser's recording indicator lit until the tab closed. */
    if (stream) stream.getTracks().forEach(track => track.stop());
    voiceStream = null;
    releaseVoiceCapture();
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    showToast(denied ? t("micDenied") : t("micFailed"), "warn");
    if (!denied) console.error("Voice recording failed to start:", err);
  }
}

/* ══════════════════════════════════════════════
   CALLS
══════════════════════════════════════════════ */

voiceCallBtn.onclick = () => requestCall(false);
videoCallBtn.onclick = () => requestCall(true);

function requestCall(withVideo) {
  if (inCall) return;
  if (!dcReady() || !pc) { appendSys(t("callNeedLink")); return; }
  if (!e2eReady) { appendSys(t("e2eWaiting")); return; }
  if (!isChatLinkUp()) { appendSys(t("callNeedLink")); return; }
  inCall = true;
  pendingCallVideo = withVideo;
  dcSendCallSignal({ type: "call-request", withVideo });
  showCallOverlay(withVideo ? t("videoCallingOut") : t("voiceCallingOut"), withVideo);
}

function handleCallRequest(data) {
  if (inCall) {
    dcSendCallSignal({ type: "call-reject" });
    return;
  }
  const kind = data.withVideo ? t("incomingVideo") : t("incomingVoice");
  // Show a styled in-app modal instead of the browser's confirm() dialog
  callRequestIcon.textContent = data.withVideo ? "📹" : "📞";
  callRequestTitle.textContent = I18N[LANG].incomingCall(kind);
  callAcceptBtn.textContent  = t("callAccept");
  callDeclineBtn.textContent = t("callDecline");
  callRequestModal.classList.remove("hidden");

  const cleanup = () => callRequestModal.classList.add("hidden");

  callDeclineBtn.onclick = () => {
    cleanup();
    dcSendCallSignal({ type: "call-reject" });
  };

  callAcceptBtn.onclick = () => {
    cleanup();
    if (!pc || !isChatLinkUp()) {
      appendSys(t("callNeedLink"));
      dcSendCallSignal({ type: "call-reject" });
      return;
    }
    inCall = true;
    pendingCallVideo = data.withVideo;
    dcSendCallSignal({ type: "call-accept", withVideo: data.withVideo });
    showCallOverlay(t("connecting"), data.withVideo);
    // If ontrack already fired and stored the remote stream, play it now
    if (remoteVideo.srcObject && remoteVideo._pendingPlay) {
      remoteVideo._pendingPlay = false;
      playRemoteCallMedia();
      callStatusLabel.textContent = t("callConnected");
    }
  };
}

/** How much capture the user actually agreed to.

    pendingCallVideo is set the moment they press a call button or Accept, so it
    is the only record of what they consented to. The peer's withVideo flag rides
    in on every later message and cannot be trusted on its own: answering a voice
    call with `withVideo: true` would otherwise turn the camera on.

    The peer may still ask for less — no camera on their side is a fair reason to
    answer a video call with audio only — so this is an AND, not an override. */
function consentedVideo(peerWantsVideo) {
  return Boolean(pendingCallVideo) && Boolean(peerWantsVideo);
}

async function attachCallMedia(withVideo) {
  stopLocalCallMedia();
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: withVideo ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false
  });
  localVideo.srcObject = localStream;
  localVideo.muted = true;
  updateLocalVideoAspect();
  localVideo.onloadedmetadata = updateLocalVideoAspect;
  localStream.getVideoTracks().forEach(track => {
    track.onunmute = updateLocalVideoAspect;
    track.onended = () => localVideo.style.removeProperty("--local-video-aspect");
  });
  localVideo.play().catch(() => {}); // explicit play — needed on some mobile browsers
  for (const track of localStream.getTracks()) {
    await attachCallTrack(track, localStream);
  }
}

function updateLocalVideoAspect() {
  const videoTrack = localStream?.getVideoTracks()[0];
  const settings = videoTrack?.getSettings?.() || {};
  const width = localVideo.videoWidth || settings.width;
  const height = localVideo.videoHeight || settings.height;
  if (width && height) {
    localVideo.style.setProperty("--local-video-aspect", `${width} / ${height}`);
  }
}

const makeSharedVerificationCode = DC.makeSharedVerificationCode;
const normalizeVerifyCode        = DC.normalizeVerifyCode;

/** Warn only when the link is up but unauthenticated — precisely the case where
    a man-in-the-middle would otherwise be invisible. */
function updateVerifyBanner() {
  const banner = document.getElementById("verifyBanner");
  if (!banner) return;
  const nag = e2eReady && !e2eSecureMode && !e2eVerified;
  banner.textContent = nag ? `⚠️ ${t("verifyBannerWarn")}` : "";
  banner.classList.toggle("hidden", !nag);
}

function updateKeyVerifyUi() {
  updateVerifyBanner();
  if (!keyVerifyCode || !keyVerifyInput || !keyVerifyStatus) return;
  keyVerifyCode.textContent = e2eVerifyCode || "----";
  if (!e2eVerifyCode) keyVerifyInput.value = "";
  if (e2eSecureMode) {
    /* Authenticated by the invite-link secret — nothing for the user to compare. */
    keyVerifyInput.classList.add("hidden");
    keyVerifyStatus.textContent = t("verifyAuto");
  } else {
    keyVerifyInput.classList.remove("hidden");
    keyVerifyStatus.textContent = e2eVerified ? t("verifyMatch") : t("verifyPending");
  }
  keyVerifyStatus.classList.toggle("ok", e2eVerified || e2eSecureMode);
  keyVerifyStatus.classList.toggle("bad", false);
}

if (keyVerifyInput) {
  keyVerifyInput.addEventListener("input", () => {
    const typed = normalizeVerifyCode(keyVerifyInput.value);
    const expected = normalizeVerifyCode(e2eVerifyCode);
    e2eVerified = Boolean(expected && typed && typed === expected);
    keyVerifyStatus.textContent = e2eVerified
      ? t("verifyMatch")
      : (typed ? t("verifyMismatch") : t("verifyPending"));
    keyVerifyStatus.classList.toggle("ok", e2eVerified);
    keyVerifyStatus.classList.toggle("bad", Boolean(typed && !e2eVerified));
    updateVerifyBanner();
  });
}

function ensureOutgoingCallTransceivers(withVideo) {
  if (!callPc) return;
  const hasAudio = callPc.getTransceivers().some(t => t.receiver?.track?.kind === "audio" && !t.stopped);
  const hasVideo = callPc.getTransceivers().some(t => t.receiver?.track?.kind === "video" && !t.stopped);
  if (!hasAudio) callPc.addTransceiver("audio", { direction: "sendrecv" });
  if (withVideo && !hasVideo) callPc.addTransceiver("video", { direction: "sendrecv" });
}

function stopLocalCallMedia() {
  if (localStream) {
    localStream.getTracks().forEach(tr => tr.stop());
    localStream = null;
  }
  if (callPc) {
    callPc.getSenders().forEach(sender => {
      if (sender.track && (sender.track.kind === "audio" || sender.track.kind === "video")) {
        try { callPc.removeTrack(sender); } catch (_) {}
      }
    });
  }
  localVideo.srcObject = null;
  localVideo.onloadedmetadata = null;
  localVideo.style.removeProperty("--local-video-aspect");
}

async function attachCallTrack(track, stream) {
  if (!callPc) return;
  const reusable = callPc.getTransceivers().find(transceiver =>
    transceiver.receiver?.track?.kind === track.kind &&
    !transceiver.sender?.track &&
    !transceiver.stopped
  );

  if (reusable) {
    reusable.direction = "sendrecv";
    await reusable.sender.replaceTrack(track);
    return;
  }

  callPc.addTrack(track, stream);
}

async function drainCallIceQueue() {
  if (!callPc || !callPc.remoteDescription || !callPc.remoteDescription.type) return;
  while (callIceQueue.length) {
    try { await callPc.addIceCandidate(new RTCIceCandidate(callIceQueue.shift())); }
    catch (e) { console.warn("queued call-ice add failed:", e); }
  }
}

async function handleCallAnswer(data) {
  if (!callPc || !inCall) return;
  await callPc.setRemoteDescription(new RTCSessionDescription(data.answer));
  await drainCallIceQueue();
  callStatusLabel.textContent = t("callConnected");
  appendSys(t("sysCallSecure"));
  if (remoteVideo._pendingPlay) {
    remoteVideo._pendingPlay = false;
    playRemoteCallMedia();
  }
}

async function handleCallIce(candidate) {
  if (!candidate) return;
  if (callPc && callPc.remoteDescription && callPc.remoteDescription.type) {
    try { await callPc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.warn("call-ice add failed:", e); }
  } else {
    callIceQueue.push(candidate);
  }
}

async function initiateCallOffer(peerWantsVideo) {
  if (!pc || !currentSession) return;
  /* Reached only by the peer answering a call we placed, which is what set
     inCall in requestCall(). Without this check a peer could send call-accept
     out of the blue and attachCallMedia() below would open the camera and
     microphone with nothing on screen having asked. Mirrors the guard in
     handleIncomingCallOffer — both doors reach the same getUserMedia. */
  if (!inCall) {
    console.warn("Ignoring unsolicited call-accept — no call was placed");
    dcSendCallSignal({ type: "call-reject" });
    return;
  }
  const withVideo = consentedVideo(peerWantsVideo);
  showCallOverlay(withVideo ? t("videoConnecting") : t("voiceConnecting"), withVideo);
  try {
    createCallPeerConnection();
    ensureOutgoingCallTransceivers(withVideo);
    await attachCallMedia(withVideo);
    const offer = await callPc.createOffer();
    await callPc.setLocalDescription(offer);
    // Send offer immediately — trickle ICE candidates will follow via call-ice messages
    dcSendCallSignal({
      type: "call-offer",
      offer: callPc.localDescription,
      withVideo
    });
  } catch (e) {
    console.error("Call offer error:", e);
    endCall(false);
    appendSys(I18N[LANG].sysCallFailed(e.message));
  }
}

async function handleIncomingCallOffer(data) {
  if (!pc || !currentSession) return;
  /* An offer is only legitimate after call-request → the user pressing accept,
     which is what sets inCall. Without this check a peer could skip straight to
     call-offer and attachCallMedia() would open the camera and microphone with
     no prompt shown. (Call signaling arrives only over the encrypted data
     channel now, so the sender is always the peer.) */
  if (!inCall) {
    console.warn("Ignoring unsolicited call offer — no call was accepted");
    dcSendCallSignal({ type: "call-reject" });
    return;
  }
  const withVideo = consentedVideo(data.withVideo);
  showCallOverlay(t("connecting"), withVideo);
  try {
    createCallPeerConnection();
    // setRemoteDescription fires ontrack immediately, before the local media is
    // attached below, so the stream is stored and played once we are ready
    await callPc.setRemoteDescription(new RTCSessionDescription(data.offer));
    await drainCallIceQueue();
    await attachCallMedia(withVideo);
    const answer = await callPc.createAnswer();
    await callPc.setLocalDescription(answer);
    // Send answer immediately — trickle ICE candidates follow via call-ice messages
    dcSendCallSignal({
      type: "call-answer",
      answer: callPc.localDescription
    });
    callStatusLabel.textContent = t("callConnected");
    appendSys(t("sysCallSecure"));
    // If ontrack already fired and stored a stream, play it now
    if (remoteVideo._pendingPlay) {
      remoteVideo._pendingPlay = false;
      playRemoteCallMedia();
    }
  } catch (e) {
    console.error("Call answer error:", e);
    endCall(false);
    appendSys(I18N[LANG].sysCallFailed(e.message));
  }
}

function stopCallMedia(clearOverlay = true) {
  stopLocalCallMedia();
  remoteVideo.srcObject = null;
  isMuted = false;
  isCamOff = false;
  toggleMuteBtn.replaceChildren(tablerIcon("microphone"));
  toggleCamBtn.replaceChildren(tablerIcon("camera"));
  if (clearOverlay) {
    callOverlay.classList.add("hidden");
    callOverlay.classList.remove("voice-only");
    remoteVideo.classList.remove("hidden");
    localVideo.classList.remove("hidden");
  }
}

function showCallOverlay(statusText, withVideo) {
  callStatusLabel.textContent = statusText;
  callOverlay.classList.remove("hidden");
  callOverlay.classList.toggle("voice-only", !withVideo);
  // Show the peer name in voice-only avatar
  const nameEl = document.getElementById("voiceCallPeerName");
  if (nameEl) nameEl.textContent = currentSession?.sessionId || "";
  if (withVideo) {
    remoteVideo.classList.remove("hidden");
    localVideo.classList.remove("hidden");
  } else {
    remoteVideo.classList.remove("hidden");
    localVideo.classList.add("hidden");
  }
}

function tablerIcon(name, size, color) {
  const icon = document.createElement("i");
  icon.className = `ti ti-${name}`;
  icon.setAttribute("aria-hidden", "true");
  if (size) icon.style.fontSize = `${size}px`;
  if (color) icon.style.color = color;
  return icon;
}

toggleMuteBtn.onclick = () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  toggleMuteBtn.replaceChildren(tablerIcon(isMuted ? "microphone-off" : "microphone"));
};

toggleCamBtn.onclick = () => {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  toggleCamBtn.replaceChildren(tablerIcon(isCamOff ? "camera-off" : "camera"));
};

endCallBtn.onclick = () => endCall(true);

function endCall(notify = true) {
  inCall = false;
  pendingCallVideo = false;
  callIceQueue = [];
  remoteVideo._pendingPlay = false;
  callRequestModal.classList.add("hidden");
  if (notify && dcReady()) dcSendCallSignal({ type: "call-reject" });
  stopCallMedia(true);
  closeCallPeerConnection();
}

/* ══════════════════════════════════════════════
   ATTACH MENU
══════════════════════════════════════════════ */

attachBtn.onclick = e => { e.stopPropagation(); attachMenu.classList.toggle("hidden"); };
document.addEventListener("click", () => attachMenu.classList.add("hidden"));

/* ══════════════════════════════════════════════
   BUBBLE RENDERERS
══════════════════════════════════════════════ */

function appendBubble(who, text) {
  const row    = document.createElement("div");
  row.className = `bubble-row ${who}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  row.appendChild(bubble);
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = now();
  row.appendChild(meta);
  chatMessages.appendChild(row);
  scrollBottom();
  return row;
}

function resolveImageNow(who, url, name) {
  const row    = document.createElement("div");
  row.className = `bubble-row ${who}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const img = document.createElement("img");
  img.src = url; img.alt = name;
  img.onclick = () => window.open(url, "_blank");
  bubble.appendChild(img);
  row.appendChild(bubble);
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = now();
  row.appendChild(meta);
  chatMessages.appendChild(row);
  scrollBottom();
}

function resolveVoiceNow(who, url) {
  const row    = document.createElement("div");
  row.className = `bubble-row ${who}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const wrap = document.createElement("div");
  wrap.className = "voice-bubble";
  wrap.appendChild(tablerIcon("microphone", 18, "var(--accent-text)"));
  const audio = document.createElement("audio");
  audio.src = url; audio.controls = true;
  wrap.appendChild(audio);
  bubble.appendChild(wrap);
  row.appendChild(bubble);
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = now();
  row.appendChild(meta);
  chatMessages.appendChild(row);
  scrollBottom();
}

function appendImagePlaceholder(who, id, name) {
  const row    = document.createElement("div");
  row.className = `bubble-row ${who}`;
  row.dataset.tid = id;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const label = document.createElement("div");
  label.className = "transfer-pending";
  label.style.cssText = "color:var(--muted);font-size:13px";
  label.textContent = `🖼️ ${name || t("image")} — ${t("receiving")}`;
  bubble.appendChild(label);
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = now();
  bubble.appendChild(meta);
  row.appendChild(bubble);
  chatMessages.appendChild(row);
  scrollBottom();
}

function resolveImagePlaceholder(id, url, name) {
  const row = findTransferRow(id);
  if (!row) return;
  const bubble = row.querySelector(".bubble");
  const img = document.createElement("img");
  img.src = url; img.alt = name;
  img.onclick = () => window.open(url, "_blank");
  bubble.replaceChildren(img);
  let meta = row.querySelector(".bubble-meta");
  if (!meta) { meta = document.createElement("div"); meta.className = "bubble-meta"; row.appendChild(meta); }
  meta.textContent = now();
  scrollBottom();
}

function appendFileBubble(who, url, name, size, id) {
  const row    = document.createElement("div");
  row.className = `bubble-row ${who}`;
  if (id) row.dataset.tid = id;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const fileBubble = document.createElement("div");
  fileBubble.className = "file-bubble";
  const icon = document.createElement("div");
  icon.className = "file-icon";
  icon.appendChild(tablerIcon("file", 22));
  const info = document.createElement("div");
  const fileName = document.createElement("div");
  fileName.className = "file-name";
  fileName.textContent = name;
  const fileSize = document.createElement("div");
  fileSize.className = "file-size";
  fileSize.textContent = fmtBytes(size);
  info.append(fileName, fileSize);
  if (url) {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.textContent = t("download");
    info.appendChild(link);
  } else {
    const pending = document.createElement("span");
    pending.className = "file-pending transfer-pending";
    pending.style.cssText = "color:var(--muted);font-size:12px";
    pending.textContent = t("receiving");
    info.appendChild(pending);
  }
  fileBubble.append(icon, info);
  bubble.appendChild(fileBubble);
  row.appendChild(bubble);
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = now();
  row.appendChild(meta);
  chatMessages.appendChild(row);
  scrollBottom();
}

function resolveFileBubble(id, url, name) {
  const row = findTransferRow(id);
  if (!row) return;
  const pending = row.querySelector(".file-pending");
  if (pending) {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.textContent = t("download");
    pending.replaceWith(link);
  }
}

function appendVoicePlaceholder(who, id) {
  const row    = document.createElement("div");
  row.className = `bubble-row ${who}`;
  row.dataset.tid = id;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const vb = document.createElement("div");
  vb.className = "voice-bubble";
  const mic = document.createElement("span");
  mic.textContent = "🎤";
  const pending = document.createElement("span");
  pending.className = "transfer-pending";
  pending.style.cssText = "color:var(--muted);font-size:12px";
  pending.textContent = t("receiving");
  vb.append(mic, pending);
  bubble.appendChild(vb);
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = now();
  bubble.appendChild(meta);
  row.appendChild(bubble);
  chatMessages.appendChild(row);
  scrollBottom();
}

function resolveVoicePlaceholder(id, url) {
  const row = findTransferRow(id);
  if (!row) return;
  const vb = row.querySelector(".voice-bubble");
  if (!vb) return;
  const audio = document.createElement("audio");
  audio.src = url; audio.controls = true;
  const mic = document.createElement("span");
  mic.textContent = "🎤";
  vb.replaceChildren(mic, audio);
  scrollBottom();
}

function appendSys(text) {
  const el = document.createElement("div");
  el.className = "sys-msg";
  el.textContent = text;
  chatMessages.appendChild(el);
  scrollBottom();
}

function addAckTick(row, msgId) {
  let meta = row.querySelector(".bubble-meta");
  if (!meta) {
    meta = document.createElement("div");
    meta.className = "bubble-meta";
    row.appendChild(meta);
  }
  const tick = document.createElement("span");
  tick.className = "ack-tick sent";
  tick.textContent = "✓";
  tick.dataset.msgId = msgId;
  meta.appendChild(tick);
}

function markDelivered(row) {
  const tick = row.querySelector(".ack-tick");
  if (tick) { tick.className = "ack-tick delivered"; tick.textContent = "✓✓"; }
}

function now() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function scrollBottom() { chatMessages.scrollTop = chatMessages.scrollHeight; }

/* ══════════════════════════════════════════════
   LEAVE A MESSAGE
══════════════════════════════════════════════ */

leaveFileBtn.onclick = () => leaveFile.click();

leaveFile.onchange = () => {
  const f = leaveFile.files[0];
  const mb = leaveAttachMaxMbRounded();
  if (f && f.size > maxLeaveAttachBytes) {
    setLeaveStatus(I18N[LANG].leaveFileTooBig(mb), "err");
    leaveFile.value = "";
    leaveFileName.textContent = "";
    const span = leaveFileBtn.querySelector("span[data-i18n]");
    if (span) span.textContent = t("attachFile");
    return;
  }
  leaveFileName.textContent = f ? `${f.name} (${fmtBytes(f.size)})` : "";
  // Update the text span inside leaveFileBtn
  const span = leaveFileBtn.querySelector("span[data-i18n]");
  if (span) span.textContent = f ? t("changeFile") : t("attachFile");
};

leaveSendBtn.onclick = async () => {
  const msg = leaveMessage.value.trim();
  if (!msg) { setLeaveStatus(t("writeFirst"), "err"); return; }
  const lf = leaveFile.files[0];
  const mb = leaveAttachMaxMbRounded();
  if (lf && lf.size > maxLeaveAttachBytes) {
    setLeaveStatus(I18N[LANG].leaveFileTooBig(mb), "err");
    return;
  }
  leaveSendBtn.disabled = true;
  setLeaveStatus(t("sending"), "sending");

  const fd = new FormData();
  fd.append("message", msg);
  fd.append("name", senderName.value.trim());
  if (lf) fd.append("file", lf);

  try {
    const res  = await fetch(`${SERVER_URL}/api/send-message`, {
      method: "POST",
      headers: { "X-DC-Client": "1" },
      body: fd
    });
    const json = await res.json();
    if (res.ok && json.ok) {
      setLeaveStatus(t("msgSent"), "ok");
      leaveMessage.value = "";
      senderName.value   = "";
      leaveFile.value    = "";
      leaveFileName.textContent = "";
      const span = leaveFileBtn.querySelector("span[data-i18n]");
      if (span) span.textContent = t("attachFile");
    } else {
      setLeaveStatus((json.error || "Failed") + (json.detail ? ": " + json.detail : ""), "err");
    }
  } catch (_) {
    setLeaveStatus(t("networkErr"), "err");
  } finally {
    leaveSendBtn.disabled = false;
  }
};

function setLeaveStatus(text, type) {
  leaveStatus.textContent = text;
  leaveStatus.className   = "leave-status " + type;
}

/* ══════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════ */

function dcReady() {
  return dataChannel && dataChannel.readyState === "open";
}

function dcSend(obj) {
  if (dcReady()) dataChannel.send(JSON.stringify(obj));
}
