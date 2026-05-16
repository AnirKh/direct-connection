/*
  ─────────────────────────────────────────────
  Direct Connection — app.js
  Features:
  - Lobby with live session list + PIN join
  - WebSocket auto-reconnect
  - Multiple STUN servers
  - Full ICE gathering before offer/answer
  - ICE state monitoring + restartIce() recovery
  - Full renegotiation fallback on "failed"
  - Ghost PC cleanup
  - Connection stats display (RTT, bytes, candidate type)
  - Text chat with message IDs + delivery ack
  - Typing indicator
  - Image send (base64 over DataChannel)
  - File send (chunked ArrayBuffer over DataChannel)
  - Voice note (MediaRecorder → ArrayBuffer)
  - Voice call (audio track)
  - Video call (audio + video tracks)
  - Mute / camera toggle during call
  ─────────────────────────────────────────────
*/

"use strict";

/* ── Read URL params immediately on load ─────── */
/* Must happen before anything else — before WS, before approval */
const _urlParams     = new URLSearchParams(location.search);
const _autoSessionId = _urlParams.get("session");
const _autoToken     = _urlParams.get("token");
const _isAutoJoin    = Boolean(_autoSessionId && _autoToken);

/* Clean URL immediately so params don't persist or confuse */
if (_isAutoJoin) {
  history.replaceState({}, "", location.pathname);
}

/* ── DOM ──────────────────────────────────────── */

const overlay         = document.getElementById("overlay");
const approveBtn      = document.getElementById("approveBtn");

const lobbyScreen     = document.getElementById("lobbyScreen");
const chatScreen      = document.getElementById("chatScreen");

const sessionIdInput  = document.getElementById("sessionId");
const createBtn       = document.getElementById("createBtn");
const createInfo      = document.getElementById("createInfo");
const sessionsList    = document.getElementById("sessionsList");
const refreshBtn      = document.getElementById("refreshBtn");

const pinOverlay      = document.getElementById("pinOverlay");
const pinSessionLabel = document.getElementById("pinSessionLabel");
const pinInput        = document.getElementById("pinInput");
const pinJoinBtn      = document.getElementById("pinJoinBtn");
const pinCancelBtn    = document.getElementById("pinCancelBtn");
const pinError        = document.getElementById("pinError");

const chatSessionLabel  = document.getElementById("chatSessionLabel");
const connectionQuality = document.getElementById("connectionQuality");
const statsBar          = document.getElementById("statsBar");
const leaveBtn          = document.getElementById("leaveBtn");

const chatMessages    = document.getElementById("chatMessages");
const typingIndicator = document.getElementById("typingIndicator");
const messageInput    = document.getElementById("messageInput");
const sendBtn         = document.getElementById("sendBtn");
const attachBtn       = document.getElementById("attachBtn");
const attachMenu      = document.getElementById("attachMenu");
const sendImageBtn    = document.getElementById("sendImageBtn");
const sendFileBtn     = document.getElementById("sendFileBtn");
const imageInput      = document.getElementById("imageInput");
const fileInput       = document.getElementById("fileInput");
const voiceRecordBtn  = document.getElementById("voiceRecordBtn");

const voiceCallBtn    = document.getElementById("voiceCallBtn");
const videoCallBtn    = document.getElementById("videoCallBtn");
const callOverlay     = document.getElementById("callOverlay");
const callStatusLabel = document.getElementById("callStatusLabel");
const remoteVideo     = document.getElementById("remoteVideo");
const localVideo      = document.getElementById("localVideo");
const toggleMuteBtn   = document.getElementById("toggleMuteBtn");
const toggleCamBtn    = document.getElementById("toggleCamBtn");
const endCallBtn      = document.getElementById("endCallBtn");

/* ── STATE ────────────────────────────────────── */

let ws             = null;
let pc             = null;
let dataChannel    = null;
let currentSession = null;   // { sessionId, role: "host"|"guest" }
let isConnecting   = false;
let isHost         = false;

let localStream    = null;   // for calls
let isMuted        = false;
let isCamOff       = false;

let mediaRecorder  = null;
let voiceChunks    = [];

let statsInterval  = null;

let msgIdCounter   = 0;
const pendingAcks  = {};  // msgId → bubble element

let typingTimeout  = null;
let peerTyping     = false;

// File receive state
const fileReceiveBuffers = {};  // transferId → { chunks, totalChunks, name, size, type }

/* ── CONSTANTS ────────────────────────────────── */

const WS_URL = "wss://direct-connection.onrender.com";

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302"  },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ],
  iceTransportPolicy: "all"
};

const FILE_CHUNK_SIZE = 16384; // 16 KB

/* ══════════════════════════════════════════════
   APPROVAL
══════════════════════════════════════════════ */

/* Update approval modal if this is an auto-join link */
if (_isAutoJoin) {
  document.querySelector(".modal h2").textContent  = "Join Session";
  document.querySelector(".modal p").textContent   =
    `You've been invited to join session "${_autoSessionId}". ` +
    "This will establish a direct encrypted peer-to-peer connection.";
  approveBtn.textContent = "Approve & Join";
}

approveBtn.onclick = () => {
  overlay.classList.add("hidden");
  if (_isAutoJoin) {
    /* Show joining state in lobby before WS connects */
    createInfo.textContent = `Joining session "${_autoSessionId}"…`;
    setButtonsDisabled(true);
  }
  connectWebSocket();
};

/* Auto-join — called from ws.onopen using pre-captured params */
function checkAutoJoin() {
  if (!_isAutoJoin) return;

  isConnecting = true;
  setButtonsDisabled(true);
  createInfo.textContent = `Connecting to session "${_autoSessionId}"…`;

  /* WS is already open when this is called from ws.onopen */
  wsSend({ type: "join-session", sessionId: _autoSessionId, token: _autoToken });
}

/* ══════════════════════════════════════════════
   WEBSOCKET — auto-reconnect
══════════════════════════════════════════════ */

function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("WS connected");
    requestSessionList();
    checkAutoJoin();
  };

  ws.onclose = () => {
    console.log("WS closed — reconnecting in 3s");
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (e) => console.error("WS error", e);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleSignaling(data);
    } catch (e) {
      console.error("WS parse error", e);
    }
  };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/* ══════════════════════════════════════════════
   LOBBY
══════════════════════════════════════════════ */

function requestSessionList() {
  wsSend({ type: "list-sessions" });
}

refreshBtn.onclick = requestSessionList;

function renderSessionList(sessions) {
  if (!sessions || sessions.length === 0) {
    sessionsList.innerHTML = '<div class="empty-state">No active sessions</div>';
    return;
  }
  sessionsList.innerHTML = "";
  sessions.forEach(({ sessionId, createdAt }) => {
    const item = document.createElement("div");
    item.className = "session-item";
    item.innerHTML = `
      <div>
        <div class="session-item-name">📡 ${sessionId}</div>
        <div class="session-item-meta">Created ${timeAgo(createdAt)}</div>
      </div>
      <button class="join-btn" data-id="${sessionId}">Join</button>
    `;
    item.querySelector(".join-btn").onclick = () => openPinModal(sessionId);
    sessionsList.appendChild(item);
  });
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  return `${Math.floor(diff/3600)}h ago`;
}

/* ── Create session ──────────────────────────── */

createBtn.onclick = async () => {
  const sessionId = sessionIdInput.value.trim();
  if (!sessionId) { alert("Enter a session name"); return; }
  if (isConnecting) return;

  isConnecting = true;
  createBtn.disabled = true;
  createInfo.textContent = "Creating…";

  wsSend({ type: "create-session", sessionId });
};

/* ══════════════════════════════════════════════
   PIN MODAL
══════════════════════════════════════════════ */

let pendingJoinSessionId = null;

function openPinModal(sessionId) {
  pendingJoinSessionId = sessionId;
  pinSessionLabel.textContent = `Session: ${sessionId}`;
  pinInput.value = "";
  pinError.textContent = "";
  pinOverlay.classList.remove("hidden");
  pinInput.focus();
}

pinCancelBtn.onclick = () => {
  pinOverlay.classList.add("hidden");
  pendingJoinSessionId = null;
};

pinJoinBtn.onclick = attemptJoin;
pinInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") attemptJoin();
});

function attemptJoin() {
  const pin = pinInput.value.trim();
  if (pin.length !== 6) { pinError.textContent = "PIN must be 6 digits"; return; }
  pinError.textContent = "";
  pinJoinBtn.disabled = true;
  wsSend({ type: "join-session", sessionId: pendingJoinSessionId, pin });
}

/* ══════════════════════════════════════════════
   WEBRTC SETUP
══════════════════════════════════════════════ */

function closePeerConnection() {
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  if (pc) {
    pc.onicecandidate          = null;
    pc.oniceconnectionstatechange = null;
    pc.onicegatheringstatechange  = null;
    pc.ondatachannel           = null;
    pc.ontrack                 = null;
    pc.close();
    pc = null;
  }
  dataChannel = null;
  sendBtn.disabled = true;
}

function createPeerConnection() {
  closePeerConnection();
  pc = new RTCPeerConnection(ICE_CONFIG);

  /* Trickle ICE */
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      wsSend({ type: "ice-candidate", candidate, sessionId: currentSession.sessionId });
    }
  };

  /* ICE state monitoring */
  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    console.log("ICE:", state);

    switch (state) {
      case "checking":
        setQuality("⬤ Connecting…", "");
        break;
      case "connected":
      case "completed":
        setQuality("⬤ Connected", "connected");
        startStatsPolling();
        break;
      case "disconnected":
        setQuality("⬤ Reconnecting…", "poor");
        pc.restartIce();
        break;
      case "failed":
        setQuality("⬤ Failed — retrying…", "failed");
        handleFullRenegotiation();
        break;
      case "closed":
        setQuality("⬤ Disconnected", "failed");
        break;
    }
  };

  /* Remote media tracks (for calls) */
  pc.ontrack = ({ streams }) => {
    remoteVideo.srcObject = streams[0];
  };

  /* DataChannel (guest receives) */
  pc.ondatachannel = ({ channel }) => {
    dataChannel = channel;
    setupDataChannel();
  };
}

/* ── Full renegotiation on "failed" ─────────── */

async function handleFullRenegotiation() {
  if (!pc || !currentSession) return;
  try {
    if (isHost) {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await waitForICEGathering(pc);
      wsSend({ type: "renegotiate-offer", offer: pc.localDescription, sessionId: currentSession.sessionId });
    }
  } catch (e) {
    console.error("Renegotiation error:", e);
  }
}

/* ── ICE gathering wait ──────────────────────── */

function waitForICEGathering(peerConn) {
  return new Promise((resolve) => {
    if (peerConn.iceGatheringState === "complete") return resolve();
    const onChange = () => {
      if (peerConn.iceGatheringState === "complete") {
        peerConn.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    };
    peerConn.addEventListener("icegatheringstatechange", onChange);
    setTimeout(() => { peerConn.removeEventListener("icegatheringstatechange", onChange); resolve(); }, 5000);
  });
}

/* ── DataChannel setup ───────────────────────── */

function setupDataChannel() {
  dataChannel.binaryType = "arraybuffer";

  dataChannel.onopen = () => {
    console.log("DataChannel open");
    sendBtn.disabled = false;
    appendSys("Peer-to-peer connection established 🔒");
  };

  dataChannel.onclose = () => {
    sendBtn.disabled = true;
    appendSys("Connection closed");
  };

  dataChannel.onerror = (e) => console.error("DC error", e);

  dataChannel.onmessage = ({ data }) => {
    if (typeof data === "string") {
      handleTextMessage(JSON.parse(data));
    } else {
      handleBinaryChunk(data);
    }
  };
}

/* ══════════════════════════════════════════════
   SIGNALING HANDLER
══════════════════════════════════════════════ */

async function handleSignaling(data) {
  console.log("Signaling:", data.type);

  switch (data.type) {

    /* Lobby */
    case "session-list":
      renderSessionList(data.sessions);
      break;

    /* Host: session created — show PIN + shareable link */
    case "session-created": {
      isHost = true;
      currentSession = { sessionId: data.sessionId, token: data.token };

      const shareUrl = `${location.origin}${location.pathname}?session=${encodeURIComponent(data.sessionId)}&token=${data.token}`;

      createInfo.style.textAlign = "left";
      createInfo.innerHTML = `
        <div style="text-align:center;margin-bottom:14px">
          ✅ Session ready!
        </div>
        <div style="background:#12151c;border-radius:10px;padding:14px;margin-bottom:10px;text-align:center">
          <div style="font-size:11px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px">PIN</div>
          <div style="font-size:28px;font-weight:700;letter-spacing:10px;color:#fff">${data.pin}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:4px">Share manually with your peer</div>
        </div>
        <div style="font-size:12px;color:#9ca3af;margin-bottom:6px">Or share this link (no PIN needed):</div>
        <div style="display:flex;gap:6px;align-items:center">
          <input id="shareUrlInput" type="text"
            value="${shareUrl}"
            style="font-size:11px;padding:8px 10px;border-radius:8px;flex:1;min-width:0;background:#12151c;color:#7dd3fc;border:1px solid #2a2f3a;cursor:text"
            readonly>
          <button id="copyLinkBtn"
            style="width:auto;margin:0;padding:8px 14px;font-size:13px;min-height:36px;border-radius:8px;flex-shrink:0;background:#2563eb">
            Copy
          </button>
        </div>
      `;

      document.getElementById("copyLinkBtn").onclick = () => {
        navigator.clipboard.writeText(shareUrl).then(() => {
          document.getElementById("copyLinkBtn").textContent = "✓ Copied!";
          setTimeout(() => {
            const btn = document.getElementById("copyLinkBtn");
            if (btn) btn.textContent = "Copy";
          }, 2000);
        }).catch(() => {
          /* Fallback for browsers that block clipboard */
          const input = document.getElementById("shareUrlInput");
          input.select();
          document.execCommand("copy");
          document.getElementById("copyLinkBtn").textContent = "✓ Copied!";
        });
      };

      createBtn.disabled = false;
      isConnecting = false;
      requestSessionList();
      break;
    }

    /* Guest: joined — prepare to receive offer */
    case "session-joined":
      isHost = false;
      currentSession = { sessionId: data.sessionId };
      pinOverlay.classList.add("hidden");
      switchToChat(data.sessionId);
      createPeerConnection();
      break;

    /* Guest: receives offer */
    case "offer":
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForICEGathering(pc);
      wsSend({ type: "answer", answer: pc.localDescription, sessionId: currentSession.sessionId });
      break;

    /* Host: receives answer */
    case "answer":
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      break;

    /* Both: trickle ICE candidate */
    case "ice-candidate":
      if (pc) {
        try { await pc.addIceCandidate(data.candidate); } catch (e) { console.error(e); }
      }
      break;

    /* Host: guest joined — begin session */
    case "guest-joined":
      switchToChat(currentSession.sessionId);
      createPeerConnection();
      // Host creates DataChannel and offer
      dataChannel = pc.createDataChannel("chat");
      dataChannel.binaryType = "arraybuffer";
      setupDataChannel();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForICEGathering(pc);
      wsSend({ type: "offer", offer: pc.localDescription, sessionId: currentSession.sessionId });
      break;

    /* Renegotiation offer (host → guest after ICE failed) */
    case "renegotiate-offer":
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const reAnswer = await pc.createAnswer();
      await pc.setLocalDescription(reAnswer);
      await waitForICEGathering(pc);
      wsSend({ type: "renegotiate-answer", answer: pc.localDescription, sessionId: currentSession.sessionId });
      break;

    case "renegotiate-answer":
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      break;

    /* Call signaling */
    case "call-offer":
      await handleIncomingCall(data);
      break;

    case "call-answer":
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      callStatusLabel.textContent = "Connected";
      break;

    /* Peer events */
    case "peer-disconnected":
      appendSys("Peer disconnected");
      endCall(false);
      closePeerConnection();
      sendBtn.disabled = true;
      break;

    /* Errors */
    case "error":
      alert(data.message);
      createBtn.disabled = false;
      pinJoinBtn.disabled = false;
      isConnecting = false;
      break;

    case "pin-error":
      pinError.textContent = data.message;
      pinJoinBtn.disabled = false;
      break;
  }
}

/* ══════════════════════════════════════════════
   SCREEN TRANSITIONS
══════════════════════════════════════════════ */

function switchToChat(sessionId) {
  lobbyScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  chatSessionLabel.textContent = sessionId;
  setQuality("⬤ Connecting…", "");
  chatMessages.innerHTML = "";
  sendBtn.disabled = true;
}

leaveBtn.onclick = () => {
  wsSend({ type: "leave-session", sessionId: currentSession?.sessionId });
  closePeerConnection();
  endCall(false);
  currentSession = null;
  isHost = false;
  isConnecting = false;
  chatScreen.classList.add("hidden");
  lobbyScreen.classList.remove("hidden");
  createInfo.textContent = "";
  createBtn.disabled = false;
  sessionIdInput.value = "";
  requestSessionList();
};

/* ══════════════════════════════════════════════
   STATS POLLING
══════════════════════════════════════════════ */

function startStatsPolling() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(async () => {
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      let rtt = null, bytesSent = 0, bytesRecv = 0, candidateType = "";

      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded") {
          rtt = report.currentRoundTripTime;
        }
        if (report.type === "outbound-rtp") bytesSent += report.bytesSent || 0;
        if (report.type === "inbound-rtp")  bytesRecv += report.bytesReceived || 0;
        if (report.type === "transport" && report.selectedCandidatePairId) {
          // candidate type extracted in candidate-pair above
        }
        if (report.type === "local-candidate" && report.candidateType) {
          candidateType = report.candidateType; // host / srflx / relay
        }
      });

      const parts = [];
      if (rtt !== null) {
        const ms = Math.round(rtt * 1000);
        parts.push(`RTT: ${ms}ms`);
        // update quality indicator color
        if (ms < 80) setQuality("⬤ Connected", "connected");
        else if (ms < 250) setQuality("⬤ Fair", "poor");
        else setQuality("⬤ Poor", "poor");
      }
      if (bytesSent) parts.push(`↑ ${formatBytes(bytesSent)}`);
      if (bytesRecv) parts.push(`↓ ${formatBytes(bytesRecv)}`);
      if (candidateType) parts.push(`via: ${candidateType}`);

      statsBar.textContent = parts.join("   ");
    } catch (e) { /* ignore */ }
  }, 2000);
}

function formatBytes(b) {
  if (b < 1024) return `${b}B`;
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
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
});

/* Auto-resize textarea */
messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
  sendTypingSignal();
});

function sendTypingSignal() {
  if (!dataChannel || dataChannel.readyState !== "open") return;
  dcSend({ type: "typing" });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => dcSend({ type: "typing-stop" }), 1500);
}

function sendTextMessage() {
  const text = messageInput.value.trim();
  if (!text || !dataChannel || dataChannel.readyState !== "open") return;

  const msgId = ++msgIdCounter;
  dcSend({ type: "text", text, msgId });

  const bubble = appendBubble("me", text, "text");
  addAckTick(bubble, msgId, "sent");
  pendingAcks[msgId] = bubble;

  messageInput.value = "";
  messageInput.style.height = "auto";
  dcSend({ type: "typing-stop" });
}

function handleTextMessage(data) {
  switch (data.type) {

    case "text":
      appendBubble("peer", data.text, "text");
      dcSend({ type: "ack", msgId: data.msgId });
      break;

    case "ack":
      if (pendingAcks[data.msgId]) {
        markDelivered(pendingAcks[data.msgId]);
        delete pendingAcks[data.msgId];
      }
      break;

    case "typing":
      if (!peerTyping) { peerTyping = true; typingIndicator.classList.remove("hidden"); }
      break;

    case "typing-stop":
      peerTyping = false;
      typingIndicator.classList.add("hidden");
      break;

    case "image":
      appendImageBubble("peer", data.dataUrl, data.name);
      dcSend({ type: "ack", msgId: data.msgId });
      break;

    case "voice":
      appendVoiceBubble("peer", data.dataUrl);
      break;

    case "file-meta":
      fileReceiveBuffers[data.transferId] = {
        chunks: [], totalChunks: data.totalChunks,
        name: data.name, size: data.size, mimeType: data.mimeType
      };
      break;

    case "file-done":
      assembleFile(data.transferId);
      break;

    /* Call signaling over DataChannel */
    case "call-request":
      handleCallRequest(data);
      break;

    case "call-reject":
      endCall(false);
      appendSys("Call declined");
      break;

    case "call-accept":
      // host: now exchange call offer via signaling
      initiateCallOffer(data.withVideo);
      break;
  }
}

/* ══════════════════════════════════════════════
   BINARY — file chunks
══════════════════════════════════════════════ */

function handleBinaryChunk(buffer) {
  // first 36 bytes = transferId (UUID string), rest = chunk data
  const idBytes = new Uint8Array(buffer, 0, 36);
  const transferId = new TextDecoder().decode(idBytes);
  const chunkData = buffer.slice(36);

  if (fileReceiveBuffers[transferId]) {
    fileReceiveBuffers[transferId].chunks.push(chunkData);
  }
}

function assembleFile(transferId) {
  const info = fileReceiveBuffers[transferId];
  if (!info) return;
  const blob = new Blob(info.chunks, { type: info.mimeType });
  const url  = URL.createObjectURL(blob);
  appendFileBubble("peer", url, info.name, info.size);
  delete fileReceiveBuffers[transferId];
}

/* ══════════════════════════════════════════════
   IMAGE SEND
══════════════════════════════════════════════ */

sendImageBtn.onclick = () => { attachMenu.classList.add("hidden"); imageInput.click(); };
imageInput.onchange = () => {
  const file = imageInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const msgId = ++msgIdCounter;
    dcSend({ type: "image", dataUrl: reader.result, name: file.name, msgId });
    appendImageBubble("me", reader.result, file.name);
  };
  reader.readAsDataURL(file);
  imageInput.value = "";
};

/* ══════════════════════════════════════════════
   FILE SEND (chunked binary)
══════════════════════════════════════════════ */

sendFileBtn.onclick = () => { attachMenu.classList.add("hidden"); fileInput.click(); };
fileInput.onchange = () => {
  const file = fileInput.files[0];
  if (!file) return;
  sendFileOverDC(file);
  fileInput.value = "";
};

function generateId() {
  // 36-char UUID-like string (padded to exactly 36 bytes)
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

async function sendFileOverDC(file) {
  if (!dataChannel || dataChannel.readyState !== "open") return;

  const transferId = generateId(); // exactly 36 chars
  const totalChunks = Math.ceil(file.size / FILE_CHUNK_SIZE);

  dcSend({ type: "file-meta", transferId, name: file.name, size: file.size, mimeType: file.type, totalChunks });
  appendFileBubble("me", null, file.name, file.size);

  const idBytes = new TextEncoder().encode(transferId); // 36 bytes

  const ab = await file.arrayBuffer();
  for (let i = 0; i < totalChunks; i++) {
    const chunk = ab.slice(i * FILE_CHUNK_SIZE, (i + 1) * FILE_CHUNK_SIZE);
    // Prepend transferId as first 36 bytes
    const packet = new Uint8Array(36 + chunk.byteLength);
    packet.set(idBytes, 0);
    packet.set(new Uint8Array(chunk), 36);

    // Respect buffer threshold
    await waitForBufferDrain();
    dataChannel.send(packet.buffer);
  }

  dcSend({ type: "file-done", transferId });
}

function waitForBufferDrain() {
  return new Promise((resolve) => {
    const check = () => {
      if (!dataChannel || dataChannel.bufferedAmount < 65536) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
}

/* ══════════════════════════════════════════════
   VOICE NOTE
══════════════════════════════════════════════ */

voiceRecordBtn.addEventListener("mousedown",  startVoiceRecord);
voiceRecordBtn.addEventListener("touchstart", startVoiceRecord, { passive: true });
voiceRecordBtn.addEventListener("mouseup",    stopVoiceRecord);
voiceRecordBtn.addEventListener("touchend",   stopVoiceRecord);

async function startVoiceRecord() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => voiceChunks.push(e.data);
    mediaRecorder.onstop = () => {
      const blob = new Blob(voiceChunks, { type: "audio/webm" });
      stream.getTracks().forEach(t => t.stop());
      const reader = new FileReader();
      reader.onload = () => {
        dcSend({ type: "voice", dataUrl: reader.result });
        appendVoiceBubble("me", reader.result);
      };
      reader.readAsDataURL(blob);
    };
    mediaRecorder.start();
    voiceRecordBtn.classList.add("recording");
  } catch (e) {
    alert("Microphone access denied");
  }
}

function stopVoiceRecord() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    voiceRecordBtn.classList.remove("recording");
  }
}

/* ══════════════════════════════════════════════
   CALLS — voice + video
══════════════════════════════════════════════ */

voiceCallBtn.onclick = () => requestCall(false);
videoCallBtn.onclick = () => requestCall(true);

function requestCall(withVideo) {
  dcSend({ type: "call-request", withVideo });
  callStatusLabel.textContent = withVideo ? "📹 Video calling…" : "📞 Voice calling…";
  callOverlay.classList.remove("hidden");
  if (!withVideo) {
    remoteVideo.classList.add("hidden");
    localVideo.classList.add("hidden");
  }
}

function handleCallRequest(data) {
  const kind = data.withVideo ? "Video" : "Voice";
  const accept = confirm(`Incoming ${kind} call — accept?`);
  if (!accept) {
    dcSend({ type: "call-reject" });
    return;
  }
  dcSend({ type: "call-accept", withVideo: data.withVideo });
  startLocalMedia(data.withVideo).then(() => {
    callOverlay.classList.remove("hidden");
    callStatusLabel.textContent = "Connecting…";
    if (!data.withVideo) {
      remoteVideo.classList.add("hidden");
      localVideo.classList.add("hidden");
    }
  });
}

async function initiateCallOffer(withVideo) {
  await startLocalMedia(withVideo);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type: "call-offer", offer: pc.localDescription, withVideo, sessionId: currentSession.sessionId });
  callStatusLabel.textContent = "Ringing…";
}

async function handleIncomingCall(data) {
  await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsSend({ type: "call-answer", answer: pc.localDescription, sessionId: currentSession.sessionId });
  callStatusLabel.textContent = "Connected";
}

async function startLocalMedia(withVideo) {
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
  localVideo.srcObject = localStream;
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
}

toggleMuteBtn.onclick = () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  toggleMuteBtn.textContent = isMuted ? "🔇" : "🎙️";
};

toggleCamBtn.onclick = () => {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  toggleCamBtn.textContent = isCamOff ? "🚫" : "📷";
};

endCallBtn.onclick = () => endCall(true);

function endCall(notify = true) {
  if (notify && dataChannel && dataChannel.readyState === "open") {
    dcSend({ type: "call-reject" }); // reuse as "end"
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  remoteVideo.srcObject = null;
  localVideo.srcObject  = null;
  remoteVideo.classList.remove("hidden");
  localVideo.classList.remove("hidden");
  callOverlay.classList.add("hidden");
  isMuted = false; isCamOff = false;
  toggleMuteBtn.textContent = "🎙️";
  toggleCamBtn.textContent  = "📷";
}

/* ══════════════════════════════════════════════
   ATTACH MENU
══════════════════════════════════════════════ */

attachBtn.onclick = (e) => {
  e.stopPropagation();
  attachMenu.classList.toggle("hidden");
};
document.addEventListener("click", () => attachMenu.classList.add("hidden"));

/* ══════════════════════════════════════════════
   BUBBLE RENDERERS
══════════════════════════════════════════════ */

function appendBubble(who, content, kind) {
  const row = document.createElement("div");
  row.className = `bubble-row ${who}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (kind === "text") bubble.textContent = content;

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = timestamp();

  bubble.appendChild(meta);
  row.appendChild(bubble);
  chatMessages.appendChild(row);
  scrollBottom();
  return row;
}

function appendImageBubble(who, dataUrl, name) {
  const row = document.createElement("div");
  row.className = `bubble-row ${who}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = name;
  img.onclick = () => window.open(dataUrl, "_blank");

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = name + " · " + timestamp();

  bubble.appendChild(img);
  bubble.appendChild(meta);
  row.appendChild(bubble);
  chatMessages.appendChild(row);
  scrollBottom();
}

function appendFileBubble(who, url, name, size) {
  const row = document.createElement("div");
  row.className = `bubble-row ${who}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  bubble.innerHTML = `
    <div class="file-bubble">
      <div class="file-icon">📄</div>
      <div>
        <div class="file-name">${name}</div>
        <div class="file-size">${formatBytes(size)}</div>
        ${url ? `<a href="${url}" download="${name}">Download</a>` : "<span style='color:#9ca3af;font-size:12px'>Sending…</span>"}
      </div>
    </div>
  `;

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = timestamp();
  bubble.appendChild(meta);

  row.appendChild(bubble);
  chatMessages.appendChild(row);
  scrollBottom();
}

function appendVoiceBubble(who, dataUrl) {
  const row = document.createElement("div");
  row.className = `bubble-row ${who}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const wrap = document.createElement("div");
  wrap.className = "voice-bubble";
  wrap.innerHTML = `<span>🎤</span>`;

  const audio = document.createElement("audio");
  audio.src = dataUrl;
  audio.controls = true;
  wrap.appendChild(audio);

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = timestamp();

  bubble.appendChild(wrap);
  bubble.appendChild(meta);
  row.appendChild(bubble);
  chatMessages.appendChild(row);
  scrollBottom();
}

function appendSys(text) {
  const el = document.createElement("div");
  el.className = "sys-msg";
  el.textContent = text;
  chatMessages.appendChild(el);
  scrollBottom();
}

function addAckTick(row, msgId, state) {
  const meta = row.querySelector(".bubble-meta");
  const tick = document.createElement("span");
  tick.className = `ack-tick ${state}`;
  tick.textContent = "✓";
  tick.dataset.msgId = msgId;
  meta.appendChild(tick);
}

function markDelivered(row) {
  const tick = row.querySelector(".ack-tick");
  if (tick) { tick.className = "ack-tick delivered"; tick.textContent = "✓✓"; }
}

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function scrollBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/* ══════════════════════════════════════════════
   LEAVE A MESSAGE (SMTP via server HTTP endpoint)
══════════════════════════════════════════════ */

const SERVER_URL = "https://direct-connection.onrender.com";

const senderName    = document.getElementById("senderName");
const leaveMessage  = document.getElementById("leaveMessage");
const leaveFileBtn  = document.getElementById("leaveFileBtn");
const leaveFile     = document.getElementById("leaveFile");
const leaveFileName = document.getElementById("leaveFileName");
const leaveSendBtn  = document.getElementById("leaveSendBtn");
const leaveStatus   = document.getElementById("leaveStatus");

/* File picker */
leaveFileBtn.onclick = () => leaveFile.click();

leaveFile.onchange = () => {
  const file = leaveFile.files[0];
  if (file) {
    leaveFileName.textContent = `${file.name} (${formatLeaveBytes(file.size)})`;
    leaveFileBtn.textContent = "📎 Change file";
  } else {
    leaveFileName.textContent = "";
    leaveFileBtn.textContent = "📎 Attach file";
  }
};

/* Send */
leaveSendBtn.onclick = async () => {
  const msg = leaveMessage.value.trim();
  if (!msg) {
    setLeaveStatus("Please write a message first.", "err");
    return;
  }

  leaveSendBtn.disabled = true;
  setLeaveStatus("Sending…", "sending");

  const formData = new FormData();
  formData.append("message", msg);
  formData.append("name", senderName.value.trim());

  const file = leaveFile.files[0];
  if (file) formData.append("file", file);

  try {
    const res = await fetch(`${SERVER_URL}/api/send-message`, {
      method: "POST",
      body: formData
    });

    const json = await res.json();

    if (res.ok && json.ok) {
      setLeaveStatus("✓ Message sent successfully!", "ok");
      leaveMessage.value = "";
      senderName.value = "";
      leaveFile.value = "";
      leaveFileName.textContent = "";
      leaveFileBtn.textContent = "📎 Attach file";
    } else {
      setLeaveStatus(json.error || "Failed to send. Try again.", "err");
    }

  } catch (e) {
    setLeaveStatus("Network error. Check connection.", "err");
  } finally {
    leaveSendBtn.disabled = false;
  }
};

function setLeaveStatus(text, type) {
  leaveStatus.textContent = text;
  leaveStatus.className = "leave-status " + type;
}

function formatLeaveBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}


/* ══════════════════════════════════════════════
   DataChannel helper
══════════════════════════════════════════════ */

function dcSend(obj) {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(obj));
  }
}