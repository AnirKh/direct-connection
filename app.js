/*
  Direct Connection — app.js  v20260518
  ─────────────────────────────────────────────
  Dual-language support: Mongolian (default) / English
  All user-visible strings routed through t() / I18N
  ─────────────────────────────────────────────
*/

"use strict";

/* ── Read hash immediately ───────────────────── */
const _hash          = location.hash.slice(1);
// FIX: use indexOf(":") instead of split(":") so session names with colons work,
//      and decodeURIComponent so encoded names (spaces, Unicode, etc.) round-trip correctly.
const _colonIdx      = _hash.indexOf(":");
const _autoSessionId = _colonIdx > -1 ? decodeURIComponent(_hash.slice(0, _colonIdx)) : null;
const _autoToken     = _colonIdx > -1 ? _hash.slice(_colonIdx + 1) : null;
const _isAutoJoin    = Boolean(_autoSessionId && _autoToken);
if (_isAutoJoin) history.replaceState({}, "", location.pathname);

/* ══════════════════════════════════════════════
   I18N
══════════════════════════════════════════════ */

let LANG = localStorage.getItem("lang") || "mn";

const I18N = {
  mn: {
    // Modal
    modalTitle:      "Шууд холбоос",
    modalDesc:       "Энэхүү холбоосыг ямар нэгэн гуравдагч этгээдээр мэдээллээ дамжуулалгүйгээр харилцах зорилготой бүтээлээ.",
    modalBtn:        "Зөвшөөрөх & үргэлжлүүлэх",
    // Lobby
    lobbyTitle:      "Шууд холбогдох хэсэг",
    createLabel:     "Шинээр өрөө үүсгэх",
    sessionPlaceholder: "Өрөөний нэр оруулах",
    createBtnLabel:  "Өрөөг үүсгэх",
    roomsLabel:      "Идэвхтэй байгаа өрөөнүүд",
    refreshBtnLabel: "Ахин хайх",
    noRooms:         "Идэвхтэй өрөө байхгүй",
    joinBtn:         "Орох",
    sessionMeta:     (ago) => `${ago} өмнө үүсгэсэн`,
    timeS:           (n) => `${n}с`,
    timeM:           (n) => `${n}м`,
    timeH:           (n) => `${n}ц`,
    // Leave a message
    leaveLabel:      "Захиа шууд и-мэйлрүү явуулах",
    leaveHint:       (mb) => `Шууд харилцах боломжгүй үед миний и-мэйлрүү мэдээллээ илгээж болно. Хавсралтын дээд хэмжээ ~${mb} МБ.`,
    senderPlaceholder: "Таны нэр (эсвэл холбоо барих мэдээлэл)",
    msgPlaceholder:  "Энд явуулах мэдээллээ бичнэ үү",
    attachFile:      "Файл хавсаргах",
    changeFile:      "Файл солих",
    leaveSendLabel:  "Захиаг явуулах",
    // PIN modal
    pinTitle:        "Өрөөрүү нэвтрэх код",
    pinPlaceholder:  "6 оронтой PIN",
    pinCancel:       "Цуцлах",
    pinJoin:         "Нэгдэх",
    pinMustBe6:      "PIN 6 оронтой байх ёстой",
    sessionLabel:    (id) => `Өрөө: ${id}`,
    // Connection quality
    connecting:      "Холбогдож байна…",
    connected:       "Холбогдсон",
    fair:            "Дунд зэрэг",
    poor:            "Муу",
    reconnecting:    "Ахин холбогдож байна…",
    connFailed:      "Бүтсэнгүй — ахин оролдож байна…",
    connClosed:      "Холбоо тасарсан",
    // Attach menu / chat
    photoImage:      "Зураг / Фото",
    fileUpload:      "Файл",
    voiceHint:       "Дуу бичихийн тулд микрофон дарна уу",
    peerTyping:      "Бичиж байна…",
    chatPlaceholder: "Мэдээлэл…",
    // System messages
    sysConnected:    "Шууд холбоос тогтлоо 🔒 Мессеж/файл — аппын түлхүүр. Дуудлага — WebRTC шифрлэлт.",
    sysClosed:       "Холбоос хаагдлаа",
    sysPeerLeft:     "Харилцагч гарлаа",
    sysCallEnded:    "Дуудлага дууслаа",
    sysCallFailed:   (msg) => `Дуудлага бүтсэнгүй — ${msg}`,
    // Creating room
    creating:        "Үүсгэж байна…",
    enterSessionName: "Өрөөний нэр оруулна уу",
    joiningSession:  (id) => `⏳ "${id}" өрөөнд нэвтэрч байна…`,
    roomReady:       "✅ Өрөө бэлэн боллоо.",
    pinCode:         "КОД",
    pinCodeHint:     "Харилцах хүн энэ КОД-ыг хийж өрөөнд нэвтэрнэ",
    linkHint:        "Эсвэл харилцах хүнд энэ холбоосыг явуулж шууд нэвтрэх боломжтой (КОД шаардахгүй):",
    copyBtn:         "Хуулах",
    copiedBtn:       "✓ Хуулагдсан!",
    // Call
    videoCallingOut: "📹 Видео дуудлага хийж байна…",
    voiceCallingOut: "📞 Дуудлага хийж байна…",
    videoConnecting: "📹 Холбогдож байна…",
    voiceConnecting: "📞 Холбогдож байна…",
    callConnected:   "Холбогдсон",
    incomingVideo:   "Видео",
    incomingVoice:   "Дуу",
    incomingCall:    (kind) => `Ирж буй ${kind} дуудлага — зөвшөөрөх үү?`,
    // Voice record
    recordVoice:     "Дуу бичих",
    stopRecord:      "Зогсоох & илгээх",
    micDenied:       "Микрофон ашиглах эрхийг татгалзлаа",
    // Leave message status
    writeFirst:      "Эхлэн мэдээлэл бичнэ үү.",
    sending:         "Илгээж байна…",
    msgSent:         "✓ Мэдээлэл илгээгдлээ!",
    networkErr:      "Сүлжээний алдаа. Холболтоо шалгана уу.",
    leaveFileTooBig: (mb) => `Файлын хэмжээ ${mb} МБ-аас их байна. Жижиг файл эсвэл шахсан хувилбар ашиглана уу.`,
    // Binary transfer
    receiving:       "Хүлээн авч байна…",
    download:        "Татах",
    image:           "Зураг",
    // Auto-join errors
    couldNotJoin:    (msg) => `❌ Нэгдэж чадсангүй: ${msg}`,
    sessionExpired:  "Өрөө хугацаа дуусчсан байж магадгүй.",
    // PIN rate limit
    pinRateLimited:  (s) => `Олон удаа оролдлоо. ${s} секундын дараа дахин оролдоно уу.`,
    sessionJoinLocked: (s) => `Энэ өрөөнд олон удаа буруу оролдсон. ${s} секундын дараа дахин оролдоно уу.`,
    pinAttemptsLeft: (n) => `Буруу PIN. ${n} оролдлого үлдлээ.`,
    sessionNotFound: "Өрөө олдсонгүй — хугацаа дуусч байж магадгүй.",
    sessionFull:     "Өрөө дүүрсэн байна.",
    // E2E encryption
    sysE2eReady:     (fp) => `🔐 Шифрлэлт идэвхжлээ · Хурууны хээ: ${fp}`,
    e2eWaiting:      "Шифрлэлт тохируулж байна…",
    e2eFailed:       "Шифрлэлт амжилтгүй боллоо. Дахин холбогдоно уу.",
    sysCallSecure:   "Дуудлага холбогдлоо — аудио/видео WebRTC-ээр шифрлэгдэнэ (сервер уншихгүй).",
    callNeedLink:    "Эхлээд харилцагчтай холбогдохыг хүлээнэ үү (холбоос ногоон болмогц дахин оролдоно уу).",
    // Server wake
    serverWaking:    "Сервер асаж байна, түр хүлээнэ үү…",
    serverReady:     "Сервер бэлэн боллоо.",
    // P2P file size
    fileTooLargeP2P: (mb) => `Файлын хэмжээ ${mb}МБ-аас их байна. Жижиг файл ашиглана уу.`,
    // Reconnect
    reconnectBtn:    "← Лобби руу буцах",
    // Incoming call modal
    callAccept:      "Зөвшөөрөх",
    callDecline:     "Татгалзах",
  },
  en: {
    modalTitle:      "Direct Connection",
    modalDesc:       "This link was created to communicate without sharing your information through any third party.",
    modalBtn:        "Approve & Continue",
    lobbyTitle:      "Direct Connection",
    createLabel:     "Create a New Room",
    sessionPlaceholder: "Enter room name",
    createBtnLabel:  "Create Room",
    roomsLabel:      "Active Rooms",
    refreshBtnLabel: "Refresh",
    noRooms:         "No active rooms",
    joinBtn:         "Join",
    sessionMeta:     (ago) => `Created ${ago} ago`,
    timeS:           (n) => `${n}s`,
    timeM:           (n) => `${n}m`,
    timeH:           (n) => `${n}h`,
    leaveLabel:      "Send a Message to Email",
    leaveHint:       (mb) => `If direct connection is unavailable, you can send a message to my email. Attachments up to about ${mb} MB.`,
    senderPlaceholder: "Your name (or contact info)",
    msgPlaceholder:  "Write your message here",
    attachFile:      "Attach file",
    changeFile:      "Change file",
    leaveSendLabel:  "Send Message",
    pinTitle:        "Room Access Code",
    pinPlaceholder:  "6-digit PIN",
    pinCancel:       "Cancel",
    pinJoin:         "Join",
    pinMustBe6:      "PIN must be 6 digits",
    sessionLabel:    (id) => `Session: ${id}`,
    connecting:      "Connecting…",
    connected:       "Connected",
    fair:            "Fair",
    poor:            "Poor",
    reconnecting:    "Reconnecting…",
    connFailed:      "Failed — retrying…",
    connClosed:      "Disconnected",
    photoImage:      "Photo / Image",
    fileUpload:      "File",
    voiceHint:       "Tap mic to record voice",
    peerTyping:      "Peer is typing…",
    chatPlaceholder: "Message…",
    sysConnected:    "Direct link ready 🔒 Messages/files use app key. Calls use WebRTC encryption.",
    sysClosed:       "Connection closed",
    sysPeerLeft:     "Peer disconnected",
    sysCallEnded:    "Call ended",
    sysCallFailed:   (msg) => `Call failed — ${msg}`,
    creating:        "Creating…",
    enterSessionName: "Enter a session name",
    joiningSession:  (id) => `⏳ Joining session "${id}"…`,
    roomReady:       "✅ Room is ready.",
    pinCode:         "PIN",
    pinCodeHint:     "Share this PIN with your contact to enter the room",
    linkHint:        "Or send this link for direct access (no PIN needed):",
    copyBtn:         "Copy",
    copiedBtn:       "✓ Copied!",
    videoCallingOut: "📹 Video calling…",
    voiceCallingOut: "📞 Voice calling…",
    videoConnecting: "📹 Connecting…",
    voiceConnecting: "📞 Connecting…",
    callConnected:   "Connected",
    incomingVideo:   "Video",
    incomingVoice:   "Voice",
    incomingCall:    (kind) => `Incoming ${kind} call — accept?`,
    recordVoice:     "Record voice",
    stopRecord:      "Tap to stop & send",
    micDenied:       "Microphone access denied",
    writeFirst:      "Please write a message first.",
    sending:         "Sending…",
    msgSent:         "✓ Message sent!",
    networkErr:      "Network error. Check connection.",
    leaveFileTooBig: (mb) => `File is too large (max about ${mb} MB). Try a smaller file or a zip.`,
    receiving:       "Receiving…",
    download:        "Download",
    image:           "Image",
    couldNotJoin:    (msg) => `❌ Could not join: ${msg}`,
    sessionExpired:  "The session may have expired.",
    // PIN rate limit
    pinRateLimited:  (s) => `Too many attempts. Try again in ${s}s.`,
    sessionJoinLocked: (s) => `Too many failed join attempts for this room. Try again in ${s}s.`,
    pinAttemptsLeft: (n) => `Wrong PIN. ${n} attempt(s) remaining.`,
    sessionNotFound: "Session not found — it may have expired.",
    sessionFull:     "Session is full.",
    // E2E encryption
    sysE2eReady:     (fp) => `🔐 Encryption active · Fingerprint: ${fp}`,
    e2eWaiting:      "Setting up encryption…",
    e2eFailed:       "Encryption setup failed. Please reconnect.",
    sysCallSecure:   "Call connected — audio/video encrypted by WebRTC (server cannot listen in).",
    callNeedLink:    "Wait until you are connected to your contact (green status), then try again.",
    // Server wake
    serverWaking:    "Server is waking up, please wait…",
    serverReady:     "Server is ready.",
    // P2P file size
    fileTooLargeP2P: (mb) => `File too large (max ${mb} MB). Please use a smaller file.`,
    // Reconnect
    reconnectBtn:    "← Back to Lobby",
    // Incoming call modal
    callAccept:      "Accept",
    callDecline:     "Decline",
  }
};

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
let isMuted         = false;
let isCamOff        = false;
let mediaRecorder   = null;
let voiceChunks     = [];

let statsInterval   = null;
let msgIdCounter    = 0;
const pendingAcks   = {};
let typingTimeout   = null;
let peerTyping      = false;

let _lastSessionList = [];  // cache for re-render on language change

const recvBuffers = {};

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
   E2E ENCRYPTION  (ECDH P-256 → AES-GCM 256)
   ─────────────────────────────────────────────
   App-layer key (fingerprint shown in chat) for:
     - text, photos, files, voice notes on the data channel
   Voice/video calls use WebRTC’s built-in DTLS-SRTP (reliable in all
   major browsers; the server still cannot decrypt call media).
   Flow:
     1. dataChannel.onopen → e2eInit() → e2e-pubkey exchange
     2. e2eDeriveKey() → shared AES-GCM key + fingerprint
     3. Text: {type:"text", ct, iv}; other DC JSON via {type:"e2e-dc", ct, iv}
══════════════════════════════════════════════ */

let e2eKey      = null;   // CryptoKey AES-GCM 256 (derived)
let e2eKeyPair  = null;   // ECDH ephemeral key pair
let e2eReady    = false;

async function e2eInit() {
  e2eKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"]
  );
  const pubJwk = await crypto.subtle.exportKey("jwk", e2eKeyPair.publicKey);
  // Send over already-open data channel (raw, not through dcSend so we bypass e2eReady guard)
  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.send(JSON.stringify({ type: "e2e-pubkey", key: pubJwk }));
  }
}

async function e2eDeriveKey(peerPubJwk) {
  try {
    const peerPub = await crypto.subtle.importKey(
      "jwk", peerPubJwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,   // extractable only to compute fingerprint
      []
    );
    e2eKey = await crypto.subtle.deriveKey(
      { name: "ECDH", public: peerPub },
      e2eKeyPair.privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    e2eReady = true;
    sendBtn.disabled = false;

    // Compute a short fingerprint from the peer's raw public key
    const raw  = await crypto.subtle.exportKey("raw", peerPub);
    const hash = await crypto.subtle.digest("SHA-256", raw);
    const fp   = Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16)
      .replace(/(.{4})/g, "$1 ")
      .trim();

    appendSys(I18N[LANG].sysE2eReady(fp));
  } catch (err) {
    console.error("E2E key derivation failed:", err);
    e2eReady = false;
    sendBtn.disabled = true;
    appendSys(t("e2eFailed"));
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

const E2E_BIN_IV_LEN = 12;

/** Send JSON over the data channel inside the same E2E envelope as text. */
async function dcSendE2e(obj) {
  if (!dcReady() || !e2eReady) return false;
  const { ct, iv } = await e2eEncrypt(JSON.stringify(obj));
  dataChannel.send(JSON.stringify({ type: "e2e-dc", ct, iv }));
  return true;
}

/** Call signaling on the data channel (plain JSON — must arrive reliably). */
function dcSendCallSignal(obj) {
  if (!dcReady()) return false;
  dcSend(obj);
  return true;
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
    msg.style.color = "#fbbf24";
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

let _autoJoinSent = false;

function checkAutoJoin() {
  if (!_isAutoJoin || _autoJoinSent) return;
  _autoJoinSent = true;
  isConnecting = true;
  setLobbyButtons(true);
  const msg = document.createElement("span");
  msg.style.color = "#7dd3fc";
  msg.textContent = I18N[LANG].joiningSession(_autoSessionId);
  createInfo.replaceChildren(msg);
  wsSend({ type: "join-session", sessionId: _autoSessionId, token: _autoToken });
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
      msg.style.color = "#4ade80";
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

function wsSend(obj) {
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
  wsSend({ type: "join-session", sessionId: pendingJoinId, pin });
}

/* ══════════════════════════════════════════════
   WEBRTC — DATA CHANNEL PC
══════════════════════════════════════════════ */

function closePeerConnection() {
  iceQueue = [];
  callIceQueue = [];
  e2eKey = null;
  e2eKeyPair = null;
  e2eReady = false;
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
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
    if (!candidate) return;
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
  callPc = new RTCPeerConnection(ICE_CONFIG);

  callPc.onicecandidate = ({ candidate }) => {
    if (!candidate || !currentSession) return;
    wsSend({ type: "call-ice", candidate, sessionId: currentSession.sessionId });
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

  callPc.ontrack = ({ track, streams }) => {
    // Always store the stream even if inCall hasn't been set yet —
    // the callee's ontrack fires during setRemoteDescription(offer),
    // which happens before inCall = true on their side.
    if (streams && streams.length > 0) {
      if (remoteVideo.srcObject !== streams[0]) {
        remoteVideo.srcObject = streams[0];
      }
    } else {
      if (!(remoteVideo.srcObject instanceof MediaStream)) {
        remoteVideo.srcObject = new MediaStream();
      }
      const existing = remoteVideo.srcObject.getTracks();
      if (!existing.includes(track)) remoteVideo.srcObject.addTrack(track);
    }
    // Play and update status only when the call is actually active
    if (inCall) {
      remoteVideo.play().catch(() => {});
      callStatusLabel.textContent = t("callConnected");
    } else {
      // Store for later — play() is called again when inCall becomes true
      remoteVideo._pendingPlay = true;
    }
  };
}

function closeCallPeerConnection() {
  if (callPc) {
    callPc.onicecandidate = callPc.onconnectionstatechange = callPc.ontrack = null;
    callPc.close();
    callPc = null;
  }
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
    await waitForICEGathering(pc);
    wsSend({ type: "renegotiate-offer", offer: pc.localDescription, sessionId: currentSession.sessionId });
  } catch (e) { console.error("Renegotiation error:", e); }
}

function waitForICEGathering(peerConn) {
  return new Promise(resolve => {
    // Do NOT check iceGatheringState immediately — after setLocalDescription, the
    // browser may still show "complete" from the previous round while new gathering
    // is about to start. Wait a tick first, then watch for the event.
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      peerConn.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (peerConn.iceGatheringState === "complete") finish();
    };
    peerConn.addEventListener("icegatheringstatechange", onChange);
    // Hard timeout — always resolve after 5s regardless
    const fallback = setTimeout(finish, 5000);
    // After 250ms, check if state is already complete (no new gathering needed)
    setTimeout(() => {
      if (peerConn.iceGatheringState === "complete") finish();
    }, 250);
  });
}

function setupDataChannel() {
  dataChannel.binaryType = "arraybuffer";

  dataChannel.onopen = async () => {
    // sendBtn stays disabled until E2E key exchange completes (usually <100ms)
    voiceCallBtn.disabled = false;
    videoCallBtn.disabled = false;
    appendSys(t("sysConnected"));
    appendSys(t("e2eWaiting"));
    e2eReady = false;
    await e2eInit();
    // sendBtn enabled in e2eDeriveKey() once shared key is ready
  };

  dataChannel.onclose = () => {
    sendBtn.disabled = true;
    appendSys(t("sysClosed"));
    // Clean up unacknowledged messages and incomplete transfers to free memory
    for (const k of Object.keys(pendingAcks)) delete pendingAcks[k];
    for (const k of Object.keys(recvBuffers)) delete recvBuffers[k];
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

      const shareUrl = `${location.origin}${location.pathname}#${encodeURIComponent(data.sessionId)}:${data.token}`;

      createInfo.style.textAlign = "left";
      const ready = document.createElement("div");
      ready.style.cssText = "text-align:center;margin-bottom:14px";
      ready.textContent = t("roomReady");

      const pinBox = document.createElement("div");
      pinBox.style.cssText = "background:#12151c;border-radius:10px;padding:14px;margin-bottom:12px;text-align:center";
      const pinLabel = document.createElement("div");
      pinLabel.style.cssText = "font-size:11px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px";
      pinLabel.textContent = t("pinCode");
      const pinValue = document.createElement("div");
      pinValue.style.cssText = "font-size:28px;font-weight:700;letter-spacing:10px;color:#fff";
      pinValue.textContent = data.pin;
      const pinHint = document.createElement("div");
      pinHint.style.cssText = "font-size:11px;color:#9ca3af;margin-top:4px";
      pinHint.textContent = t("pinCodeHint");
      pinBox.append(pinLabel, pinValue, pinHint);

      const linkHint = document.createElement("div");
      linkHint.style.cssText = "font-size:12px;color:#9ca3af;margin-bottom:6px";
      linkHint.textContent = t("linkHint");
      const linkRow = document.createElement("div");
      linkRow.style.cssText = "display:flex;gap:6px;align-items:center";
      const shareUrlInput = document.createElement("input");
      shareUrlInput.id = "shareUrlInput";
      shareUrlInput.type = "text";
      shareUrlInput.value = shareUrl;
      shareUrlInput.readOnly = true;
      shareUrlInput.style.cssText = "font-size:11px;padding:8px 10px;border-radius:8px;flex:1;min-width:0;background:#12151c;color:#7dd3fc;border:1px solid #2a2f3a";
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
      isHost = false;
      currentSession = { sessionId: data.sessionId };
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
        await waitForICEGathering(pc);
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
        await waitForICEGathering(pc);
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
        await waitForICEGathering(pc);
        wsSend({ type: "renegotiate-answer", answer: pc.localDescription, sessionId: currentSession.sessionId });
      }
      break;

    case "renegotiate-answer":
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      break;

    case "call-offer":
      await handleIncomingCallOffer(data);
      break;

    case "call-answer":
      if (callPc && inCall) {
        await callPc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await drainCallIceQueue();
        callStatusLabel.textContent = t("callConnected");
        appendSys(t("sysCallSecure"));
        // If ontrack fired early and deferred play, do it now
        if (remoteVideo._pendingPlay) {
          remoteVideo._pendingPlay = false;
          remoteVideo.play().catch(() => {});
        }
      }
      break;

    case "call-ice":
      if (!data.candidate) break;
      if (callPc && callPc.remoteDescription && callPc.remoteDescription.type) {
        try { await callPc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
        catch (e) { console.warn("call-ice add failed:", e); }
      } else {
        callIceQueue.push(data.candidate);
      }
      break;

    case "peer-disconnected":
      appendSys(t("sysPeerLeft"));
      endCall(false);
      closePeerConnection();
      showReconnectButton();
      break;

    case "error":
      console.error("[Server error]", data.message);
      if (_isAutoJoin && isConnecting) {
        const msg = document.createElement("span");
        msg.style.color = "#f87171";
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
        wrap.style.color = "#f87171";
        wrap.append(document.createTextNode(I18N[LANG].couldNotJoin(msg)));
        wrap.appendChild(document.createElement("br"));
        const small = document.createElement("small");
        small.style.color = "#9ca3af";
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

function startStatsPolling() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(async () => {
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      let rtt = null, sent = 0, recv = 0, ctype = "";
      stats.forEach(r => {
        if (r.type === "candidate-pair" && r.state === "succeeded") rtt = r.currentRoundTripTime;
        if (r.type === "outbound-rtp") sent += r.bytesSent || 0;
        if (r.type === "inbound-rtp")  recv += r.bytesReceived || 0;
        if (r.type === "local-candidate" && r.candidateType) ctype = r.candidateType;
      });
      const parts = [];
      if (rtt !== null) {
        const ms = Math.round(rtt * 1000);
        parts.push(`RTT: ${ms}ms`);
        if (ms < 80)       setQuality(`⬤ ${t("connected")}`, "connected");
        else if (ms < 250) setQuality(`⬤ ${t("fair")}`, "poor");
        else               setQuality(`⬤ ${t("poor")}`, "poor");
      }
      if (sent)  parts.push(`↑ ${fmtBytes(sent)}`);
      if (recv)  parts.push(`↓ ${fmtBytes(recv)}`);
      if (ctype) parts.push(`via: ${ctype}`);
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
  connectionQuality.textContent = text;
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
      if (data.ct && e2eReady) {
        e2eDecrypt(data.ct, data.iv)
          .then(plain => {
            appendBubble("peer", plain);
            dcSend({ type: "ack", msgId: data.msgId });
          })
          .catch(err => {
            console.error("Decrypt failed:", err);
            appendBubble("peer", "⚠️ [decrypt error]");
          });
      } else {
        appendBubble("peer", data.text ?? "");
        dcSend({ type: "ack", msgId: data.msgId });
      }
      break;

    case "e2e-pubkey":
      e2eDeriveKey(data.key);
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

    case "transfer-meta":
      recvBuffers[data.id] = {
        chunks: [], name: data.name, size: data.size,
        mimeType: data.mimeType, kind: data.kind, e2e: true
      };
      if (data.kind === "file")  appendFileBubble("peer", null, data.name, data.size, data.id);
      if (data.kind === "image") appendImagePlaceholder("peer", data.id, data.name);
      if (data.kind === "voice") appendVoicePlaceholder("peer", data.id);
      break;

    case "transfer-done":
      assembleTransfer(data.id).catch(err => console.error("Transfer assemble failed:", err));
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
  }
}

/* ══════════════════════════════════════════════
   BINARY TRANSFER PROTOCOL
══════════════════════════════════════════════ */

function makeTransferId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

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

  const idBytes = new TextEncoder().encode(id);
  const ab = await file.arrayBuffer();
  for (let i = 0; i < totalChunks; i++) {
    const chunk = ab.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const { iv, ct } = await e2eEncryptBytes(chunk);
    const packet = new Uint8Array(36 + E2E_BIN_IV_LEN + ct.byteLength);
    packet.set(idBytes, 0);
    packet.set(iv, 36);
    packet.set(ct, 36 + E2E_BIN_IV_LEN);
    await drainBuffer();
    dataChannel.send(packet.buffer);
  }

  await dcSendE2e({ type: "transfer-done", id });
}

function handleBinaryChunk(buffer) {
  const id = new TextDecoder().decode(new Uint8Array(buffer, 0, 36));
  const chunkData = buffer.slice(36);
  if (recvBuffers[id]) recvBuffers[id].chunks.push(new Uint8Array(chunkData));
}

async function assembleTransfer(id) {
  const info = recvBuffers[id];
  if (!info) return;

  let blob;
  if (info.e2e) {
    const parts = [];
    for (const packet of info.chunks) {
      if (packet.byteLength < E2E_BIN_IV_LEN) continue;
      const iv = packet.slice(0, E2E_BIN_IV_LEN);
      const ct = packet.slice(E2E_BIN_IV_LEN);
      parts.push(await e2eDecryptBytes(ct, iv));
    }
    blob = new Blob(parts, { type: info.mimeType });
  } else {
    blob = new Blob(info.chunks, { type: info.mimeType });
  }
  const url = trackBlobUrl(URL.createObjectURL(blob));  // tracked — revoked on leave

  if (info.kind === "file")  resolveFileBubble(id, url, info.name);
  if (info.kind === "image") resolveImagePlaceholder(id, url, info.name);
  if (info.kind === "voice") resolveVoicePlaceholder(id, url);

  delete recvBuffers[id];
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

async function toggleVoiceRecord() {
  if (!dcReady()) return;
  if (!e2eReady) { appendSys(t("e2eWaiting")); return; }

  if (!_isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceChunks   = [];
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = e => voiceChunks.push(e.data);

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(voiceChunks, { type: "audio/webm" });
        const file = new File([blob], "voice.webm", { type: "audio/webm" });
        sendBinary(file, "voice");
        _isRecording = false;
        voiceRecordBtn.classList.remove("recording");
        voiceRecordBtn.title = t("recordVoice");
      };

      mediaRecorder.start();
      _isRecording = true;
      voiceRecordBtn.classList.add("recording");
      voiceRecordBtn.title = t("stopRecord");

    } catch (_) {
      showToast(t("micDenied"), "warn");
    }

  } else {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
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
      remoteVideo.play().catch(() => {});
      callStatusLabel.textContent = t("callConnected");
    }
  };
}

async function attachCallMedia(withVideo) {
  stopCallMedia(false);
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: withVideo ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false
  });
  localVideo.srcObject = localStream;
  localVideo.muted = true;
  localVideo.play().catch(() => {}); // explicit play — needed on some mobile browsers
  localStream.getTracks().forEach(track => attachCallTrack(track, localStream));
}

function attachCallTrack(track, stream) {
  if (!callPc) return;
  const reusable = callPc.getTransceivers().find(transceiver =>
    transceiver.receiver?.track?.kind === track.kind &&
    !transceiver.sender?.track &&
    !transceiver.stopped
  );

  if (reusable) {
    reusable.direction = "sendrecv";
    reusable.sender.replaceTrack(track);
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

async function initiateCallOffer(withVideo) {
  if (!pc || !currentSession) return;
  showCallOverlay(withVideo ? t("videoConnecting") : t("voiceConnecting"), withVideo);
  try {
    createCallPeerConnection();
    await attachCallMedia(withVideo);
    const offer = await callPc.createOffer();
    await callPc.setLocalDescription(offer);
    // Send offer immediately — trickle ICE candidates will follow via call-ice messages
    wsSend({
      type: "call-offer",
      offer: callPc.localDescription,
      withVideo,
      sessionId: currentSession.sessionId
    });
  } catch (e) {
    console.error("Call offer error:", e);
    endCall(false);
    appendSys(I18N[LANG].sysCallFailed(e.message));
  }
}

async function handleIncomingCallOffer(data) {
  if (!pc || !currentSession) return;
  const withVideo = Boolean(data.withVideo);
  showCallOverlay(t("connecting"), withVideo);
  try {
    createCallPeerConnection();
    // setRemoteDescription fires ontrack immediately — stream is stored but
    // not played yet (inCall may not be true here if WS delivered offer fast)
    await callPc.setRemoteDescription(new RTCSessionDescription(data.offer));
    await drainCallIceQueue();
    await attachCallMedia(withVideo);
    const answer = await callPc.createAnswer();
    await callPc.setLocalDescription(answer);
    // Send answer immediately — trickle ICE candidates follow via call-ice messages
    wsSend({
      type: "call-answer",
      answer: callPc.localDescription,
      sessionId: currentSession.sessionId
    });
    callStatusLabel.textContent = t("callConnected");
    appendSys(t("sysCallSecure"));
    // If ontrack already fired and stored a stream, play it now
    if (remoteVideo._pendingPlay) {
      remoteVideo._pendingPlay = false;
      remoteVideo.play().catch(() => {});
    }
  } catch (e) {
    console.error("Call answer error:", e);
    endCall(false);
    appendSys(I18N[LANG].sysCallFailed(e.message));
  }
}

function stopCallMedia(clearOverlay = true) {
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
  wrap.appendChild(tablerIcon("microphone", 18, "#06b6d4"));
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
  label.style.cssText = "color:#9ca3af;font-size:13px";
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
  const row = chatMessages.querySelector(`[data-tid="${id}"]`);
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
    pending.className = "file-pending";
    pending.style.cssText = "color:#94a3b8;font-size:12px";
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
  const row = chatMessages.querySelector(`[data-tid="${id}"]`);
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
  pending.style.cssText = "color:#9ca3af;font-size:12px";
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
  const row = chatMessages.querySelector(`[data-tid="${id}"]`);
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
