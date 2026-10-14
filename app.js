/*
  Direct Connection — app.js  v20260518
  ─────────────────────────────────────────────
  Dual-language support: Mongolian (default) / English
  All user-visible strings routed through t() / I18N
  ─────────────────────────────────────────────
*/

"use strict";

/* ══════════════════════════════════════════════
   IS THIS SCRIPT RUNNING IN THE PAGE THAT WAS BUILT WITH IT?
   ─────────────────────────────────────────────
   A browser keeps the page and each script on separate clocks, so after an
   update it can hold one from before and one from after. Old page plus this
   script was reproduced: the script looked for a button the old page does not
   have, threw while loading, and nothing on the page worked — not even the
   parts that had not changed.

   index.html loads this file as app.js?v=<build>. That stamp is the page saying
   which build it belongs to; APP_BUILD is this script saying which build it is.
   If they differ the page is the stale half, so fetch a fresh one and run
   nothing — before the invite is read, before a socket opens.

   This has to stand entirely on its own. It cannot use guards.js or i18n.js:
   in a mixed page those are exactly the files that cannot be trusted to match.

   APP_BUILD is written by tools/sync-build.js and by nothing else.
══════════════════════════════════════════════ */
const APP_BUILD = "202610141222-db5c1daf";

function refuseToRunInAStalePage() {
  let builtFor = null;
  try { builtFor = new URL(document.currentScript.src).searchParams.get("v"); }
  catch (_) { /* no script address to read — nothing to compare */ }
  if (!builtFor || builtFor === APP_BUILD) return;

  /* `?r=` marks a page we already went to fetch. The address is new to every
     cache between here and the server, so it comes back current — unless the
     update has not finished arriving, in which case asking again would only
     loop. Say so instead. The invite, if there is one, rides along in the
     fragment and is still never sent anywhere. */
  const alreadyFetched = String(new URLSearchParams(location.search).get("r") || "").startsWith(APP_BUILD);
  if (alreadyFetched) showStalePageNotice();
  else location.replace(`${location.pathname}?r=${encodeURIComponent(APP_BUILD)}${location.hash}`);

  throw new Error(`Stale page: built for ${builtFor}, but this script is ${APP_BUILD}. Not starting.`);
}

/** Shown only when fetching a fresh page did not produce one. Plain DOM and
    both languages spelled out: nothing else can be assumed to have loaded. */
function showStalePageNotice() {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#15151a;color:#e8e5de;" +
    "min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "gap:14px;text-align:center;padding:24px;box-sizing:border-box";
  const mn = document.createElement("p");
  mn.textContent = "Шинэчлэл татагдаж байна. Түр хүлээгээд дахин ачаална уу.";
  mn.style.cssText = "margin:0;font-size:16px;font-weight:600";
  const en = document.createElement("p");
  en.textContent = "An update is still arriving. Wait a moment, then reload.";
  en.style.cssText = "margin:0;font-size:14px;color:#9b98a4";
  const again = document.createElement("a");
  /* A new address each time, so a retry is never answered from a cache that
     stored the stale page under the last one. */
  again.href = `${location.pathname}?r=${encodeURIComponent(APP_BUILD)}.${Date.now()}${location.hash}`;
  again.textContent = "Дахин ачаалах / Reload";
  again.style.cssText = "margin-top:6px;padding:10px 18px;border-radius:8px;background:#7fa8d4;color:#12121a;text-decoration:none;font-size:14px";
  wrap.append(mn, en, again);
  document.body.replaceChildren(wrap);
}

refuseToRunInAStalePage();

/* Wire-protocol primitives — invite links, key derivation, chunk framing.
   See protocol.js; it is loaded before this file and covered by test/. */
const DC = window.DCProtocol;

/* Derived connection facts and the safety decisions. Both are pure and tested
   directly — see connstats.js and guards.js, and test/ for what they promise. */
const DCS = window.DCStats;
const G   = window.DCGuards;

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
const createOpenBtn    = document.getElementById("createOpenBtn");
const createCodeBtn    = document.getElementById("createCodeBtn");
const codeOverlay      = document.getElementById("codeOverlay");
const codeTitle        = document.getElementById("codeTitle");
const codeHint         = document.getElementById("codeHint");
const codeInput        = document.getElementById("codeInput");
const codeConfirmBtn   = document.getElementById("codeConfirmBtn");
const codeCancelBtn    = document.getElementById("codeCancelBtn");
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
const keyVerifyBtn   = document.getElementById("keyVerifyBtn");
const keyVerifyIcon  = document.getElementById("keyVerifyIcon");
const factWhoCanRead      = document.getElementById("factWhoCanRead");
const factCipherValue     = document.getElementById("factCipherValue");
const factCallsValue      = document.getElementById("factCallsValue");
const factPathValue       = document.getElementById("factPathValue");
const factYourIpValue     = document.getElementById("factYourIpValue");
const factPeerIpValue     = document.getElementById("factPeerIpValue");
const factYourDeviceValue = document.getElementById("factYourDeviceValue");
const factPeerDeviceValue = document.getElementById("factPeerDeviceValue");
const keyVerifyCode  = document.getElementById("keyVerifyCode");
const keyVerifyHint  = document.getElementById("keyVerifyHint");
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
let voiceOpening    = false;  // the mic is being opened — a second press must wait

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

/* What the shield's panel says about the two devices.

   _lastAddresses  from this browser's own connection statistics — nothing the
                   peer said goes into it
   peerDevice      what the other side said it is: two short codes. It can say
                   anything, so it is only ever shown through DCS.deviceLabel,
                   which turns known codes into words and everything else into
                   nothing
   peerInfoSent    this side has described itself on the current channel */
let _lastAddresses = null;
let peerDevice     = null;
let peerInfoSent   = false;

/* This device, described once. System and browser only — see describeDevice. */
const MY_DEVICE = DCS.describeDevice({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints });

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
let e2ePeerKeySeen   = false;  // a peer public key has arrived on this channel
let e2eConfirmTimer  = null;

/* ── Code rooms (SPAKE2) ──────────────────────
   A code room agrees its key from a secret word with SPAKE2 (see pake.js)
   instead of plain ECDH. Both sides must run the same path, so the kind is
   remembered for the life of the room. */
const PAKE = window.DCPake;
let roomKind       = "pin";   // "pin" | "open" | "code" — set on create and on join
let pakeCode       = null;    // the secret word for this room (never sent to the server)
let pakeStarted    = null;    // our SPAKE2 start(): { state, message }
let pakeSession    = null;    // our SPAKE2 finish(): awaiting the peer's confirmation
let keyAgreement   = "ECDH";  // how the live key was agreed — for the shield panel
/* Host-side guard on wrong-code guesses; the server cannot see the word, so it
   cannot rate-limit it. See guards.js codeAttemptState. */
let codeFailures   = 0;
let codeLockedUntil = 0;

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
  e2ePeerKeySeen = false;
  /* A new channel is a new introduction. */
  peerDevice   = null;
  peerInfoSent = false;
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
  /* The one thing the chat says about connecting, and it says it here — once
     the key is agreed — rather than when the channel opens. "Connected" then
     always means the chat can be used, and a channel that fails the key check
     never gets to claim it.

     Three lines used to be written on every join: the transport, "setting up
     encryption…", and the verification code. That was more than anyone read.
     How the chat was verified is the shield's job now; the code is in its
     panel. */
  appendSys(t("sysConnected"));

  /* The guest introduces itself; the host answers when that arrives (see the
     peer-info case). Not both at once: the host reaches this line before it
     has sent the confirmation that makes the guest ready, and an envelope that
     overtook the confirmation would be dropped on arrival — the guest would
     never learn what it is talking to. The guest only gets here because the
     host is already listening. */
  if (!isHost) sendPeerInfo();
}

/** Tells the other side which system and browser this is — once per channel,
    and only inside the encrypted envelope. */
function sendPeerInfo() {
  if (peerInfoSent) return;
  peerInfoSent = true;
  dcSendE2e({ type: "peer-info", os: MY_DEVICE.os, browser: MY_DEVICE.browser }).catch(() => {});
}

/* ══════════════════════════════════════════════
   CODE ROOMS — SPAKE2 over the data channel
   ─────────────────────────────────────────────
   Symmetric: each side sends its message, answers the peer's message with a
   confirmation tag, and verifies the peer's tag. Matching words → the same key,
   authenticated, so the shield goes green with nothing to compare by hand. A
   wrong word → the tags do not verify and the channel never opens. The word
   itself never travels; only public values do (see pake.js, guards.js).
══════════════════════════════════════════════ */

/** Clears everything a code handshake holds. Called whenever a channel resets. */
function pakeReset() {
  pakeStarted = null;
  pakeSession = null;
}

/** Start the exchange when the channel opens. Both sides call this. */
async function pakeBegin() {
  pakeReset();
  updateKeyVerifyUi();
  appendSys(t("e2eWaiting"));

  /* Host holds the gate: a stranger cannot be let on for an endless stream of
     guesses. If locked from earlier wrong attempts, do not even start. */
  if (isHost) {
    const lock = G.codeAttemptState({ failures: codeFailures, lockedUntil: codeLockedUntil, now: Date.now() });
    if (lock.locked) { pakeFailClosed(true); return; }
  }
  if (!PAKE || !pakeCode || !currentSession) { pakeFailClosed(false); return; }

  try {
    pakeStarted = PAKE.start(isHost ? "host" : "guest", pakeCode, currentSession.sessionId);
    /* Raw send: the handshake runs before any key exists. */
    dataChannel.send(JSON.stringify({ type: "pake-msg", msg: pakeStarted.message }));
  } catch (err) {
    console.error("SPAKE2 start failed:", err);
    pakeFailClosed(false);
  }
}

/** The peer's SPAKE2 message arrived. Derive, and answer with our tag. */
async function handlePakeMessage(data) {
  if (!pakeStarted || pakeSession) return;   // not started, or already answered
  try {
    pakeSession = PAKE.finish(pakeStarted.state, data.msg);
    dataChannel.send(JSON.stringify({ type: "pake-confirm", tag: pakeSession.confirmToSend }));
  } catch (err) {
    /* An invalid point, or a degenerate shared value — never an honest peer. */
    console.warn("SPAKE2 message rejected:", err && err.message);
    pakeFailClosed(false);
  }
}

/** The peer's confirmation tag arrived. If it verifies, the word matched. */
async function handlePakeConfirm(data) {
  if (!pakeSession) return;
  if (!pakeSession.verifyPeerConfirm(String(data.tag || ""))) {
    pakeFailClosed(false);
    return;
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw", pakeSession.sessionKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    codeFailures = 0;             // a success clears the host's wrong-guess count
    keyAgreement = "SPAKE2";
    pakeReset();
    /* Authenticated by the shared word, exactly like the invite-link secret. */
    e2eActivate(key, true);
  } catch (err) {
    console.error("SPAKE2 key import failed:", err);
    pakeFailClosed(false);
  }
}

/**
 * The code handshake failed — a wrong word, a tampered message, or the lockout.
 * The channel never opens. The guest returns to the lobby so they can try again;
 * the host counts the miss and, past the limit, locks the room for a cooldown.
 */
function pakeFailClosed(locked) {
  pakeReset();
  keyAgreement = "ECDH";
  e2eReady = false; e2eVerified = false; e2eSecureMode = false;
  sendBtn.disabled = true; voiceCallBtn.disabled = true; videoCallBtn.disabled = true;
  updateKeyVerifyUi();

  if (isHost && !locked) {
    codeFailures++;
    const lock = G.codeAttemptState({ failures: codeFailures, lockedUntil: codeLockedUntil, now: Date.now() });
    if (lock.locked) codeLockedUntil = lock.until;
  }

  showToast(t("codeWrong"), "error");
  if (isHost) {
    /* Drop this guest; the room reopens for the next attempt (or the right one),
       unless we have now locked it. */
    appendSys(t(codeLockedUntil > Date.now() ? "codeLocked" : "codeWrong"));
  } else {
    /* Guest: leave, so the room's slot frees and they can rejoin with the
       right word. */
    appendSys(t("codeWrong"));
    setTimeout(() => { if (!e2eReady) leaveBtn.click(); }, 1200);
  }
}

/** Refuse to open the channel. Better a dead chat than a silently readable one. */
function e2eFailClosed() {
  clearTimeout(e2eConfirmTimer);
  e2eKey = null; e2eKeyPending = null; e2eCandidates = null; e2ePendingConfirm = null;
  e2eReady = false; e2eVerified = false; e2eSecureMode = false;
  e2ePeerKeySeen = false;
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
   VISIBLE AREA
   ─────────────────────────────────────────────
   A phone keyboard covers the bottom of the screen, and on iOS and in most
   in-app browsers nothing in CSS finds out: the page stays full height. The
   message box is the bottom-most thing on the page, so it sat underneath the
   keyboard while the user typed into it.

   The visual viewport is the one measurement that does get shorter, so the
   page's height follows it. Every screen is sized from --app-height — see
   :root in style.css.
══════════════════════════════════════════════ */

/* Was the newest message in view before the visible area changed? Noted on
   scroll rather than read at resize time: by then the list has already been
   cut short from the bottom and can no longer say where it was. */
let _stickToBottom = true;
chatMessages.addEventListener("scroll", () => {
  _stickToBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 48;
});

function fitToVisibleArea() {
  const vv = window.visualViewport;

  /* Pinch-zoom shrinks the visual viewport as well, and is not a keyboard.
     Resizing the page to a zoomed-in view would fight the zoom. */
  if (vv && Math.abs(vv.scale - 1) > 0.01) return;

  const height = vv ? vv.height : window.innerHeight;
  if (!(height > 0)) return;   // a hidden or not-yet-laid-out page reports 0

  document.documentElement.style.setProperty("--app-height", `${height}px`);

  /* iOS scrolls the whole page to lift a focused field above the keyboard. The
     page now fits in what is visible, so there is nothing to scroll to — and
     leaving it scrolled pushes the header off the top. */
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);

  /* The message list just got shorter from the bottom up. Keep the newest
     message in view, unless the user had scrolled back to read older ones. */
  if (_stickToBottom) scrollBottom();
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", fitToVisibleArea);
  window.visualViewport.addEventListener("scroll", fitToVisibleArea);
}
window.addEventListener("resize", fitToVisibleArea);
fitToVisibleArea();

/* ══════════════════════════════════════════════
   APPROVAL / AUTO-JOIN
══════════════════════════════════════════════ */

if (_isAutoJoin) overlay.classList.add("hidden");

approveBtn.onclick = () => {
  overlay.classList.add("hidden");
  // WS already connecting in background — nothing else needed
};

/** Both create buttons, always together — a second create while one is in
    flight is the same mistake whichever button it comes from. */
function setCreateButtons(disabled) {
  createBtn.disabled     = disabled;
  createOpenBtn.disabled = disabled;
  createCodeBtn.disabled = disabled;
}

/* ── The shared-word dialog ───────────────────
   Used both ways: the host choosing a word, the guest entering it. One
   callback, set per use. */
let _codeOnConfirm = null;
function askForCode({ title, hint, confirmLabel, onConfirm }) {
  _codeOnConfirm = onConfirm;
  codeTitle.textContent = title;
  codeHint.textContent = hint;
  codeConfirmBtn.textContent = confirmLabel;
  codeInput.value = "";
  codeOverlay.classList.remove("hidden");
  setTimeout(() => codeInput.focus(), 100);
}
function closeCodeDialog() { codeOverlay.classList.add("hidden"); _codeOnConfirm = null; }
function submitCode() {
  const word = codeInput.value.trim();
  if (!word) { codeInput.focus(); return; }
  const cb = _codeOnConfirm;
  closeCodeDialog();
  if (cb) cb(word);
}
codeConfirmBtn.onclick = submitCode;
codeCancelBtn.onclick = closeCodeDialog;
codeInput.addEventListener("keydown", e => { if (e.key === "Enter") submitCode(); });

function setLobbyButtons(disabled) {
  setCreateButtons(disabled);
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
  roomKind = "pin"; pakeCode = null;   // an invite link is the ECDH path, not a code room
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
    /* First thing said on every connection, ahead of the list request: it is
       how the server tells a current page from one that predates this
       handshake and so cannot update itself. */
    wsSend({ type: "hello", build: APP_BUILD });
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
    if (G.shouldRetryAutoJoin({ isAutoJoin: _isAutoJoin, joinSent: _autoJoinSent, joined: Boolean(currentSession) })) {
      autoJoinSettled();
      _autoJoinSent = false;
    }
    /* Same for a tap on an open room: its answer died with the socket, and
       while this stays set no other open room can be joined. */
    listJoinId = null;
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
  _lastSessionList.forEach(({ sessionId, createdAt, open, kind }) => {
    /* Three kinds. Anything an older server did not label is a PIN room; only
       an explicit flag makes it anything else, so a room never changes kind by
       accident. */
    const roomIs = kind === "code" ? "code" : (open === true || kind === "open") ? "open" : "pin";
    const glyph  = { pin: "🔒", open: "🔓", code: "🔑" }[roomIs];
    const label  = { pin: "roomKindPin", open: "roomKindOpen", code: "roomKindCode" }[roomIs];
    const item = document.createElement("div");
    item.className = "session-item";
    const info = document.createElement("div");
    info.className = "session-item-info";
    const name = document.createElement("div");
    name.className = "session-item-name";
    name.textContent = `${glyph} ${sessionId}`;
    const meta = document.createElement("div");
    meta.className = "session-item-meta";
    const kindTag = document.createElement("span");
    kindTag.className = roomIs === "pin" ? "room-kind" : `room-kind ${roomIs}`;
    kindTag.textContent = t(label);
    meta.append(document.createTextNode(I18N[LANG].sessionMeta(timeAgo(createdAt))), kindTag);
    const joinBtn = document.createElement("button");
    joinBtn.className = "join-btn";
    joinBtn.dataset.id = sessionId;
    joinBtn.textContent = t("joinBtn");
    /* An open room has nothing to type. A code room asks for the shared word. A
       PIN room asks for the PIN. If the list is wrong about a room, the server
       says so and the right dialog opens then — see the pin-required case. */
    joinBtn.onclick = () =>
      roomIs === "open" ? joinOpenRoom(sessionId) :
      roomIs === "code" ? openCodeJoin(sessionId) :
                          openPinModal(sessionId);
    info.append(name, meta);
    item.append(info, joinBtn);
    sessionsList.appendChild(item);
  });
}

function timeAgo(ts) {
  const { unit, value } = DCS.timeAgo(ts);
  return { s: I18N[LANG].timeS, m: I18N[LANG].timeM, h: I18N[LANG].timeH }[unit](value);
}

/* Three kinds of room, one per button.

     PIN room   the guest types the 6-digit PIN, or uses the invite link
     open room  no secret: anyone who can see the list taps Join and is in
     code room  the host invents a word, shares it, and the guest types it;
                SPAKE2 proves the word and turns the chat green with nothing to
                compare by hand (see pake.js)

   All three hold the host and one guest. */
function createRoom(kind) {
  const sessionId = sessionIdInput.value.trim();
  if (!sessionId) { showToast(t("enterSessionName"), "warn"); return; }
  if (isConnecting) return;
  if (kind === "code" && !pakeCode) { openChooseCode(sessionId); return; }
  isConnecting = true;
  setCreateButtons(true);
  createInfo.textContent = t("creating");
  roomKind = kind;   // so the host takes the code path when the channel opens
  wsSend({ type: "create-session", sessionId, open: kind === "open", code: kind === "code" });
}
createBtn.onclick     = () => createRoom("pin");
createOpenBtn.onclick = () => createRoom("open");
createCodeBtn.onclick = () => createRoom("code");

/** Host: ask for the word, remember it, then create the room. The word stays
    in this browser — it is never put in the create message. */
function openChooseCode(sessionId) {
  askForCode({
    title: t("chooseCodeTitle"), hint: t("chooseCodeHint"), confirmLabel: t("createBtnLabelCode"),
    onConfirm: word => { pakeCode = word; createRoom("code"); }
  });
}

/** Guest: ask for the word, then join. Admission is first-come like an open
    room; the word is proven peer to peer once connected, not sent to join. */
function openCodeJoin(sessionId) {
  if (isConnecting || listJoinId || pinJoinInFlight) return;
  askForCode({
    title: I18N[LANG].codeJoinTitle(sessionId), hint: t("codeJoinHint"), confirmLabel: t("joinBtn"),
    onConfirm: word => {
      pakeCode = word;
      roomKind = "code";
      listJoinId = sessionId;
      pendingRoomSecret = null;
      wsSend({ type: "join-session", sessionId });
    }
  });
}

/* ── Joining an open room ────────────────────── */
let listJoinId = null;   // a join sent straight from the list, not yet answered

function joinOpenRoom(sessionId) {
  /* One join at a time: a second tap, or a tap while an invite link is still
     being answered, would leave two answers and no way to tell them apart. */
  if (isConnecting || listJoinId || pinJoinInFlight) return;
  listJoinId = sessionId;
  roomKind = "open"; pakeCode = null;   // ECDH path, no shared word
  pendingRoomSecret = null;   // no link, so no shared secret — the shield starts amber
  wsSend({ type: "join-session", sessionId });
}

/* ── PIN modal ───────────────────────────────── */
let pendingJoinId = null;
let pinJoinInFlight = false;   // a join sent from this dialog, not yet answered

/** The dialog's join has been answered, or no longer matters. Join was only
    ever re-enabled after a refusal, so one successful join left it disabled
    for every room after — the dialog opened with a button that did nothing. */
function settlePinJoin() {
  pinJoinInFlight = false;
  pinJoinBtn.disabled = false;
}

function openPinModal(sessionId) {
  pendingJoinId = sessionId;
  pinSessionLabel.textContent = I18N[LANG].sessionLabel(sessionId);
  pinInput.value = "";
  pinError.textContent = "";
  settlePinJoin();   // a freshly opened dialog always has a working button
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
  pinJoinInFlight = true;
  roomKind = "pin"; pakeCode = null;   // a PIN join is the ECDH path, not a code room
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
  /* Nor may the last chat's addresses or device: the panel would be describing
     someone who is no longer there. */
  _lastAddresses = null;
  peerDevice     = null;
  peerInfoSent   = false;
  /* The code handshake belongs to the channel that just closed. The word and
     the room kind are kept — a dropped connection to the same room reconnects
     and runs the handshake again. */
  pakeReset();
  keyAgreement = "ECDH";
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
  /* Collects what the other side sends. Not given to the picture yet: it is
     empty, and Safari would keep that empty stream — see showRemoteTracks. */
  remoteCallStream = new MediaStream();
  remoteVideo.srcObject = null;
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
    if (!remoteCallStream) remoteCallStream = new MediaStream();
    if (!remoteCallStream.getTracks().includes(track)) remoteCallStream.addTrack(track);
    showRemoteTracks();
    track.onunmute = () => {
      /* Frames have started to arrive. A picture that is still blank by now is
         the Safari case below in some other order of events: hand it over again. */
      if (track.kind === "video" && !remoteVideo.videoWidth) showRemoteTracks();
      playRemoteCallMedia();
    };

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

/* Safari — every browser on an iPhone — keeps playing the sound of a stream
   while never drawing a video track that was added to it after it was given to
   the <video>: the other person's picture stays black and their voice comes
   through. It happened only sometimes, by timing. So the picture is never given
   a stream to grow; each time a track arrives it gets a fresh one holding
   every track so far, and so sees the video from its first moment. */
function showRemoteTracks() {
  if (!remoteCallStream || !remoteCallStream.getTracks().length) return;
  remoteVideo.srcObject = new MediaStream(remoteCallStream.getTracks());
}

function playRemoteCallMedia() {
  if (!remoteVideo.srcObject) showRemoteTracks();
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
    // sendBtn stays disabled until the key exchange completes (usually <100ms)
    voiceCallBtn.disabled = true;
    videoCallBtn.disabled = true;
    /* Nothing is announced yet. The channel being open is not the chat being
       usable — e2eActivate() says "connected" once the key is agreed. */
    e2eReady = false;
    /* A code room proves a shared word with SPAKE2; every other room does the
       plain ECDH exchange. The kind was fixed when the room was created or
       joined, so both sides take the same branch. */
    if (roomKind === "code") await pakeBegin();
    else                     await e2eInit();
    // sendBtn enabled in e2eActivate() once the shared key is confirmed
  };

  dataChannel.onclose = () => {
    sendBtn.disabled = true;
    voiceCallBtn.disabled = true;
    videoCallBtn.disabled = true;
    appendSys(t("sysClosed"));
    // Clean up unacknowledged messages and incomplete transfers to free memory.
    /* Mark them failed in the UI first: clearing the state alone left every
       in-flight bubble showing "Receiving…" with nothing ever to finish it. */
    for (const k of Object.keys(recvBuffers)) failTransfer(k);
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

/* ── Noticing an update ──────────────────────
   The server names its build on every connection, and every page reconnects
   within seconds of the server restarting for an update. So a page that was
   left open finds out it is old almost as soon as it becomes old — and fetches
   the new one, provided nobody is in the middle of anything. */

let updatePending     = null;    // a newer build to fetch once this page is idle
let updateNoticeShown = false;

/** In a room, joining one, or part-way through typing something — any of which
    a reload would throw away. */
function pageIsBusy() {
  return Boolean(currentSession) || isConnecting || pinJoinInFlight || Boolean(listJoinId) ||
         sessionIdInput.value.trim() !== "" || leaveMessage.value.trim() !== "" || senderName.value.trim() !== "";
}

/** Loads the page again under an address no cache has seen, so what comes back
    is current. The same trick as refuseToRunInAStalePage(). */
function fetchNewPage(build) {
  try { sessionStorage.setItem("dc-self-reload", String(Date.now())); } catch (_) { /* storage off — the ?r= marker still stops a loop */ }
  location.replace(`${location.pathname}?r=${encodeURIComponent(build)}${location.hash}`);
}

function handleServerBuild(serverBuild) {
  let recentlyReloaded = false;
  try { recentlyReloaded = Date.now() - Number(sessionStorage.getItem("dc-self-reload") || 0) < 60_000; } catch (_) {}

  const action = G.updateAction({
    serverBuild, pageBuild: APP_BUILD,
    retriedFor: new URLSearchParams(location.search).get("r"),
    recentlyReloaded, busy: pageIsBusy()
  });

  if (action === "reload") fetchNewPage(serverBuild);
  else if (action === "later") updatePending = serverBuild;
  else if (action === "notify" && !updateNoticeShown) {
    updateNoticeShown = true;
    showToast(t("updateOnItsWay"), "info");
  }
}

/** Is this server message about the room on screen? See mayApplyRoomEvent. */
function roomEventIsOurs(data) {
  return G.mayApplyRoomEvent({
    eventRoom: data.sessionId,
    currentRoom: currentSession && currentSession.sessionId
  });
}

async function handleSignaling(data) {
  switch (data.type) {

    case "hello":
      handleServerBuild(data.build);
      break;

    case "session-list":
      renderSessionList(data.sessions);
      break;

    case "session-created": {
      isHost = true;
      roomKind = data.kind === "code" ? "code" : (data.open === true ? "open" : "pin");
      currentSession = { sessionId: data.sessionId, token: data.token };
      /* Minted here, in the browser — the server never learns it. */
      roomSecret = makeRoomSecret();

      const shareUrl = `${location.origin}${location.pathname}#${DC.buildInviteHash(data.sessionId, data.token, roomSecret)}`;

      createInfo.style.textAlign = "left";
      const ready = document.createElement("div");
      ready.style.cssText = "text-align:center;margin-bottom:14px";
      ready.textContent = t("roomReady");

      const isOpen = roomKind === "open";
      const isCode = roomKind === "code";

      const pinBox = document.createElement("div");
      pinBox.style.cssText = "background:var(--sunken);border-radius:10px;padding:14px;margin-bottom:12px;text-align:center";
      const pinLabel = document.createElement("div");
      pinLabel.style.cssText = "font-size:11px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:1px";
      /* Each kind fills the same box: a PIN to read out, an open-room notice, or
         — for a code room — the word the host chose, to share the same way. */
      pinLabel.textContent = isCode ? t("codeRoomTitle") : isOpen ? t("openRoomTitle") : t("pinCode");
      const pinValue = document.createElement("div");
      pinValue.style.cssText = isCode
        ? "font-size:24px;font-weight:700;color:var(--accent-text);word-break:break-word"
        : isOpen
          ? "font-size:28px;line-height:1.2;color:var(--orange)"
          : "font-size:28px;font-weight:700;letter-spacing:10px;color:var(--text)";
      if (isCode)     pinValue.textContent = pakeCode || "";
      else if (isOpen) pinValue.appendChild(tablerIcon("lock-open"));
      else            pinValue.textContent = data.pin;
      const pinHint = document.createElement("div");
      pinHint.style.cssText = "font-size:11px;color:var(--muted);margin-top:4px";
      pinHint.textContent = isCode ? t("codeRoomHint") : isOpen ? t("openRoomHint") : t("pinCodeHint");
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
      /* No invite link for a code room: the link carries the room secret for
         the ECDH path, which a code room does not use. The word is the only way
         in, and a link would just fail to connect. */
      if (isCode) createInfo.replaceChildren(ready, pinBox);
      else        createInfo.replaceChildren(ready, pinBox, linkHint, linkRow);

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

      setCreateButtons(false);
      isConnecting = false;
      requestSessionList();
      break;
    }

    case "session-joined":
      autoJoinSettled();
      settlePinJoin();
      listJoinId = null;
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
      if (!roomEventIsOurs(data)) break;
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
      /* Named by room since the server learned to say which. It used not to,
         and a room this browser had moved on from could still end the chat in
         the room it was actually in. */
      if (!roomEventIsOurs(data)) break;
      appendSys(t("sysPeerLeft"));
      endCall(false);
      closePeerConnection();
      showReconnectButton();
      break;

    case "session-expired": {
      /* Nobody joined in time and the server has dropped the room. This used to
         arrive as peer-disconnected, which wrote "peer left" into the hidden
         chat screen and left the lobby showing a PIN and a link for a room that
         no longer existed — the host waited on it with nothing to say so. */
      if (!roomEventIsOurs(data)) break;
      currentSession = null;
      roomSecret = null;
      isHost = false;
      isConnecting = false;
      const msg = document.createElement("span");
      msg.style.color = "var(--orange)";
      msg.textContent = `⌛ ${t("roomExpired")}`;
      createInfo.style.textAlign = "";
      createInfo.replaceChildren(msg);
      setCreateButtons(false);
      break;
    }

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
        setCreateButtons(false);
        settlePinJoin();
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
      else if (data.code === "own-room")      msg = t("ownRoom");
      else                                    msg = data.message || "Error";

      /* Route by which join is waiting for an answer, not by how the page was
         opened. _isAutoJoin stays true for the life of a page that arrived by
         invite link, so a wrong PIN typed there later was reported in the lobby
         — behind the dialog — and left the dialog's button disabled. */
      const listJoin = listJoinId;
      listJoinId = null;
      const target = G.joinRefusalTarget({
        pinJoin: pinJoinInFlight, listJoin: Boolean(listJoin), autoJoinPage: _isAutoJoin
      });

      if (target === "toast") {
        /* A tap on a room the list showed as open. If it wants a PIN after all
           — the list was stale — ask for it rather than complain: that is what
           the user would have been shown had the list been right. */
        if (data.code === "pin-required") openPinModal(listJoin);
        else { showToast(msg, "error"); requestSessionList(); }
      } else if (target === "lobby") {
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
        settlePinJoin();
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
  /* Leaving ends the code room entirely — the word and the wrong-guess count go
     with it. */
  roomKind = "pin";
  pakeCode = null;
  codeFailures = 0;
  codeLockedUntil = 0;
  isHost = false;
  isConnecting = false;
  chatScreen.classList.add("hidden");
  lobbyScreen.classList.remove("hidden");
  document.getElementById("langSwitcher").style.display = "";
  createInfo.textContent = "";
  setCreateButtons(false);
  sessionIdInput.value = "";
  requestSessionList();
  /* An update arrived while the chat was going. This is the moment it stops
     costing anything to take it. */
  if (updatePending) fetchNewPage(updatePending);
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
const selectedCandidatePair = DCS.selectedCandidatePair;

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
const describeConnectionPath = DCS.describePath;

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

async function pollStats() {
  const conn = pc;
  if (!conn) return;
  try {
    const stats = await conn.getStats();
    /* The connection can end, or be replaced, while that was being fetched.
       What came back then describes a chat that is over, and writing it would
       put the last peer's route and address back on screen. */
    if (pc !== conn) return;
    const path  = describeConnectionPath(stats);
    const pair  = selectedCandidatePair(stats);

    const { sent, recv } = DCS.trafficTotals(stats, pair);
    const quality = DCS.qualityFromRtt(pair && pair.currentRoundTripTime);

    const parts = [];
    if (quality) {
      parts.push(`RTT: ${quality.ms}ms`);
      setQuality(`⬤ ${t(quality.key)}`, quality.cls);
    }
    renderConnectionPath(path);
    _lastAddresses = DCS.pathAddresses(stats);
    renderShieldFacts();

    if (sent)  parts.push(`↑ ${fmtBytes(sent)}`);
    if (recv)  parts.push(`↓ ${fmtBytes(recv)}`);
    /* The header says direct or relayed in words; the detail belongs here. */
    if (path) parts.push(`${path.local.candidateType} → ${path.remote.candidateType}`);
    statsBar.textContent = parts.join("   ");
  } catch (_) {}
}

function startStatsPolling() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(pollStats, 2000);
  /* And once now. The route is known the moment the connection is up; waiting
     for the first tick left the badge and the panel blank for two seconds. */
  pollStats();
}

const fmtBytes = DCS.fmtBytes;

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
  /* A taller box takes its extra lines out of the message list above it. */
  if (_stickToBottom) scrollBottom();
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

/**
 * Every message from the data channel lands here — once as it arrived, and once
 * more for whatever an `e2e-dc` envelope held. `sealed` tells the two apart and
 * is true only on that second pass, so it cannot be claimed by the sender.
 */
function handleTextMessage(data, sealed = false) {
  /* File announcements and call setup are sent sealed, so they are believed
     only sealed. Checking `text` alone left every other type open: a clear
     transfer-meta drew a file bubble with any name, and a clear call-request
     raised the incoming-call prompt — after e2eFailClosed() as well as before.
     See mayHandleFrame for who is in a position to send one. */
  const type = data && data.type;
  if (!G.mayHandleFrame(type, sealed)) {
    console.warn(`Dropping "${type}" — it arrived outside the encrypted envelope`);
    return;
  }

  switch (type) {

    case "e2e-dc":
      if (!e2eReady) break;
      e2eDecrypt(data.ct, data.iv)
        .then(json => handleTextMessage(JSON.parse(json), true))
        .catch(err => console.error("E2E envelope decrypt failed:", err));
      break;

    case "text":
      /* Only ever show a message the agreed key opened. sendTextMessage refuses
         to send until e2eReady, so an unencrypted body is never a real peer —
         and rendering one would undo e2eFailClosed(): that disables sending, but
         a middleman caught swapping keys could still write into this window.
         Same rule, and same silent drop, as the e2e-dc envelope above. */
      if (!G.mayRenderText(data, e2eReady)) {
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
      /* Exactly one exchange per channel. A second key re-derived the
         verification code while leaving the key in use untouched, so the code
         on screen stopped matching the key it was supposed to describe. */
      if (!G.mayAcceptPeerKey({ peerKeySeen: e2ePeerKeySeen })) {
        console.warn("Ignoring a second e2e-pubkey — this channel already agreed a key");
        break;
      }
      e2ePeerKeySeen = true;
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

    case "pake-msg":
      /* Only ever on a code room, and only one per channel. */
      if (roomKind === "code") handlePakeMessage(data);
      break;

    case "pake-confirm":
      if (roomKind === "code") handlePakeConfirm(data);
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

    case "peer-info":
      /* The other side describing its device. Two fields are kept and nothing
         else, and neither is ever written to the page as it arrived — see
         peerDevice. Reaching here at all means the envelope opened it:
         peer-info is not on the list of types accepted in the clear, so whoever
         carries the packets cannot plant a device name in the security panel. */
      peerDevice = { os: data.os, browser: data.browser };
      renderShieldFacts();
      sendPeerInfo();   // the host's answer; a no-op for the guest, who went first
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

    case "transfer-abort":
      /* The sender gave up. Without this the placeholder waits for a
         transfer-done that is never coming. */
      delete recvBuffers[data.id];
      takeOrphanChunks(data.id);
      failTransfer(data.id);
      break;

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
  try {
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
  } catch (err) {
    /* The peer leaving mid-transfer is the ordinary case: dataChannel is set to
       null underneath the loop and send() throws. Nothing caught it, so the
       progress line stopped updating and sat at whatever percentage it had
       reached — for good. The sender was told the peer had left, while the file
       still claimed to be uploading. */
    console.error(`Transfer ${id} failed while sending:`, err);
    failTransfer(id);
    /* If the channel survived, the receiver is still waiting on a
       transfer-done that will never arrive. Tell it. */
    dcSendE2e({ type: "transfer-abort", id }).catch(() => {});
    return;
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

  /* Opening the microphone takes a moment and _isRecording only turns true once
     it has opened. A second press in that gap — a double-click — opened a second
     stream over the first, and the first could then never be stopped. */
  if (!G.mayStartRecording({ recording: _isRecording, opening: voiceOpening })) return;

  if (!dcReady()) return;
  if (!e2eReady) { appendSys(t("e2eWaiting")); return; }

  let stream = null;
  /* The room this press was made in. Read before the await below: by the time
     the microphone opens it may no longer be the room on screen. */
  const askedIn = currentSession && currentSession.sessionId;
  voiceOpening = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    /* A permission prompt can stay up for as long as the user likes, and the
       room can end underneath it. abandonVoiceRecording() ran then and found
       nothing to stop, so without this the microphone came on afterwards — in
       the lobby, with no button left to turn it off. */
    if (!G.mayKeepMicOpen({ askedIn, currentRoom: currentSession && currentSession.sessionId,
                            channelOpen: dcReady() })) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    voiceStream  = stream;
    voiceChunks  = [];
    voiceDiscard = false;
    /* Remember which room this belongs to. onstop can run long after, in a
       different room entirely — see the check there. */
    voiceSession = askedIn;

    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => voiceChunks.push(e.data);

    mediaRecorder.onstop = () => {
      const chunks     = voiceChunks;
      const discard    = voiceDiscard;
      const recordedIn = voiceSession;
      voiceChunks  = [];
      voiceDiscard = false;
      voiceSession = null;
      releaseVoiceCapture();

      /* Refuse to deliver audio to anyone but the room it was recorded in. The
         recorder outlives the room otherwise: leave while recording, join
         somewhere else, press the button again, and this would hand the new
         peer everything captured since — including the time in between. */
      if (!G.mayDeliverRecording({ recordedIn, currentRoom: currentSession && currentSession.sessionId,
                                   discarded: discard, channelOpen: dcReady() })) {
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
  } finally {
    voiceOpening = false;
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
  return G.consentedVideo(pendingCallVideo, peerWantsVideo);
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

/* ══════════════════════════════════════════════
   THE SELF-VIEW: MIRRORED HERE, MOVABLE
   ─────────────────────────────────────────────
   The mirror belongs to style.css alone — a transform on #localVideo. It flips
   the picture on this screen and nothing else: the track sent to the other side
   is the camera's own, so they see you the right way round. Flipping the track
   instead would send them a mirror image.

   The self-view can be dragged anywhere inside the call. Until it is, CSS keeps
   it in its corner; once moved it is placed by left/top, and put back inside
   whenever the call or the picture changes size — a phone turned on its side,
   a camera whose shape is known only once it starts — so it can never end up
   off screen with no way to reach it.
══════════════════════════════════════════════ */

const SELF_VIEW_MARGIN = 8;

/** Where the self-view goes when asked to sit at (x, y): the nearest spot that
    keeps all of it inside the call, `margin` clear of every edge. Null when the
    call or the picture has no size — hidden, so nothing to measure against —
    because believing a size of 0 would throw it into the top-left corner. */
function selfViewPosition(o) {
  if (!(o.w > 0 && o.h > 0 && o.areaW > 0 && o.areaH > 0)) return null;
  if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return null;
  const maxX = Math.max(o.margin, o.areaW - o.w - o.margin);
  const maxY = Math.max(o.margin, o.areaH - o.h - o.margin);
  return {
    x: Math.min(Math.max(o.x, o.margin), maxX),
    y: Math.min(Math.max(o.y, o.margin), maxY)
  };
}

function moveSelfView(x, y) {
  const at = selfViewPosition({
    x, y,
    w: localVideo.offsetWidth, h: localVideo.offsetHeight,
    areaW: callOverlay.clientWidth, areaH: callOverlay.clientHeight,
    margin: SELF_VIEW_MARGIN
  });
  if (!at) return;
  localVideo.style.left   = `${at.x}px`;
  localVideo.style.top    = `${at.y}px`;
  localVideo.style.right  = "auto";
  localVideo.style.bottom = "auto";
}

let selfViewDrag = null;   // { id, dx, dy } while a finger or the mouse holds it

localVideo.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const box = localVideo.getBoundingClientRect();
  selfViewDrag = { id: e.pointerId, dx: e.clientX - box.left, dy: e.clientY - box.top };
  localVideo.setPointerCapture(e.pointerId);
  localVideo.classList.add("dragging");
  e.preventDefault();
});

localVideo.addEventListener("pointermove", (e) => {
  if (!selfViewDrag || e.pointerId !== selfViewDrag.id) return;
  const area = callOverlay.getBoundingClientRect();
  moveSelfView(e.clientX - area.left - selfViewDrag.dx, e.clientY - area.top - selfViewDrag.dy);
});

function endSelfViewDrag(e) {
  if (!selfViewDrag || e.pointerId !== selfViewDrag.id) return;
  selfViewDrag = null;
  localVideo.classList.remove("dragging");
}
localVideo.addEventListener("pointerup", endSelfViewDrag);
localVideo.addEventListener("pointercancel", endSelfViewDrag);
localVideo.addEventListener("lostpointercapture", endSelfViewDrag);

/* Never moved: CSS has it, and keeps it in its corner. Moved: hold it where it
   was put, as far as the new size allows. */
function keepSelfViewInside() {
  if (!localVideo.style.left) return;
  moveSelfView(parseFloat(localVideo.style.left), parseFloat(localVideo.style.top));
}
if (window.ResizeObserver) {
  const selfViewSizes = new ResizeObserver(keepSelfViewInside);
  selfViewSizes.observe(callOverlay);
  selfViewSizes.observe(localVideo);
}

const makeSharedVerificationCode = DC.makeSharedVerificationCode;
const normalizeVerifyCode        = DC.normalizeVerifyCode;

/* Each state changes three things together — colour (the class), glyph and
   label — so none of them has to carry the meaning alone: colour is no use to
   someone who cannot tell amber from green, and a tick drawn in amber would
   say "checked" about a chat nobody has checked. */
const SHIELD_LOOK = {
  idle: { icon: "shield",             label: () => t("verifyKeys") },
  warn: { icon: "shield-exclamation", label: () => t("verifyWarn") },
  ok:   { icon: "shield-check",       label: () => t(e2eSecureMode ? "verifyAuto" : "verifyOk") }
};

/** Redraws the shield in the header. Amber is the case that matters: the link
    is up but unauthenticated — precisely where a man-in-the-middle would
    otherwise be invisible. This used to be a banner across the whole chat; the
    shield now does that job on its own, so every change to the verification
    state has to come through here. */
function updateShield() {
  if (!keyVerifyDropdown || !keyVerifyBtn || !keyVerifyIcon) return;
  const state = G.shieldState({ ready: e2eReady, secure: e2eSecureMode, verified: e2eVerified });
  for (const name of Object.keys(SHIELD_LOOK)) {
    keyVerifyDropdown.classList.toggle(`verify-${name}`, name === state);
  }
  const look  = SHIELD_LOOK[state];
  const label = look.label();
  keyVerifyIcon.className = `ti ti-${look.icon}`;
  keyVerifyBtn.title = label;
  keyVerifyBtn.setAttribute("aria-label", label);
  /* The panel's first line says in a sentence what the shield says in a
     colour, so the two are redrawn together and cannot disagree. */
  renderShieldFacts();
}

/* What the chat is encrypted with. Written out rather than read from the keys,
   which do not expose it in a form worth showing — so test/client-source.test.js
   checks these words against the calls that actually do the work. The second
   half names how the key was agreed: ECDH for most rooms, SPAKE2 for a code one. */
const MESSAGE_CIPHER_ECDH   = "AES-256-GCM · ECDH P-256";
const MESSAGE_CIPHER_SPAKE2 = "AES-256-GCM · SPAKE2 P-256";
const CALL_CIPHER           = "DTLS-SRTP";

/** Fills in the facts under the verification code. Called whenever any of them
    can have changed: the shield's state, the route, or what the peer said. */
function renderShieldFacts() {
  if (!factWhoCanRead) return;
  const state = G.shieldState({ ready: e2eReady, secure: e2eSecureMode, verified: e2eVerified });
  const live  = state !== "idle";

  /* "Only the two of you" is a claim about there being no middleman, and it is
     only true once that has been checked. An unverified chat is encrypted to
     whoever is on the other end of the key exchange — which is the peer, unless
     someone got in between. So the amber sentence says that instead. */
  factWhoCanRead.textContent = t({ idle: "factReadIdle", warn: "factReadWarn", ok: "factReadOk" }[state]);
  factWhoCanRead.className   = `fact-read ${state}`;

  factCipherValue.textContent = live ? (keyAgreement === "SPAKE2" ? MESSAGE_CIPHER_SPAKE2 : MESSAGE_CIPHER_ECDH) : "—";
  factCallsValue.textContent  = live ? CALL_CIPHER : "—";

  const path = _lastPath;
  factPathValue.textContent = path
    ? t({ direct: "pathDirect", local: "pathLocal", relayed: "pathRelayed" }[path.kind])
    : "—";

  /* An address the browser will not give is said to be hidden. A dash means
     there is nothing to show yet, or that a relay stands in for the devices.
     Only a real address is set in the fixed-width face — words in it read as
     if they were one. */
  const showAddress = (el, value) => {
    el.textContent = _lastAddresses ? (value || t("factHidden")) : "—";
    el.classList.toggle("mono",  Boolean(_lastAddresses && value));
    el.classList.toggle("quiet", Boolean(_lastAddresses && !value));
  };
  showAddress(factYourIpValue, _lastAddresses && _lastAddresses.local);
  showAddress(factPeerIpValue, _lastAddresses && _lastAddresses.remote);

  factYourDeviceValue.textContent = DCS.deviceLabel(MY_DEVICE) || t("factUnknown");
  factPeerDeviceValue.textContent = live ? (DCS.deviceLabel(peerDevice) || t("factUnknown")) : "—";
}

function updateKeyVerifyUi() {
  updateShield();
  if (!keyVerifyCode || !keyVerifyInput || !keyVerifyStatus) return;

  /* A code room (SPAKE2) verifies from the shared word and produces no
     comparison code, so the code box and the "compare the code" hint would sit
     empty and misleading. Show them only when there is a code to compare — the
     ECDH paths, whether verified by hand or by the invite link. */
  const hasCode = Boolean(e2eVerifyCode);
  keyVerifyCode.classList.toggle("hidden", !hasCode);
  if (keyVerifyHint) keyVerifyHint.classList.toggle("hidden", !hasCode);
  keyVerifyCode.textContent = e2eVerifyCode || "----";
  if (!e2eVerifyCode) keyVerifyInput.value = "";

  if (e2eSecureMode) {
    /* Authenticated by the invite-link secret or the shared word — nothing for
       the user to compare. */
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
    updateShield();
  });
}

/* Draw the shield and its panel once at load, so neither is ever blank — the
   markup alone has an empty sentence and no state. Placed here because
   everything they read is declared above this line. */
updateShield();

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

/** A call that could not be set up: no camera, a refused permission, a
    description the browser would not take.

    Ended here every time — the call may have been hung up while the camera was
    still opening, and ending it again is what turns that camera back off. The
    other side is told only if the call was still on; if it was not, whoever
    ended it already told them. It used to end quietly on every path, and the
    other side sat on a dark "Connecting…" screen until someone pressed End. */
function callSetupFailed(where, err) {
  const stillOn = inCall;
  endCall(stillOn);
  if (!stillOn) return;
  console.error(`${where}:`, err);
  appendSys(I18N[LANG].sysCallFailed(err?.message || String(err)));
}

async function handleCallAnswer(data) {
  if (!callPc || !inCall) return;
  try {
    await callPc.setRemoteDescription(new RTCSessionDescription(data.answer));
  } catch (e) {
    callSetupFailed("Call answer rejected", e);
    return;
  }
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
  if (!G.mayCaptureForCall(inCall)) {
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
    callSetupFailed("Call offer error", e);
  }
}

async function handleIncomingCallOffer(data) {
  if (!pc || !currentSession) return;
  /* An offer is only legitimate after call-request → the user pressing accept,
     which is what sets inCall. Without this check a peer could skip straight to
     call-offer and attachCallMedia() would open the camera and microphone with
     no prompt shown. (handleTextMessage only lets call signaling through when
     it came out of the encrypted envelope, so the sender is always the peer.) */
  if (!G.mayCaptureForCall(inCall)) {
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
    callSetupFailed("Call answer error", e);
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
