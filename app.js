/*
  Direct Connection — app.js  v20260517-2
  ─────────────────────────────────────────────
  Fixes vs previous version:
  - Calls use a SEPARATE RTCPeerConnection (callPc)
    so call renegotiation never touches the data channel PC
  - Images chunked as binary (same protocol as files)
    so large images don't hit the 256 KB DC message limit
  - Voice notes chunked as binary (same protocol)
  - File/image/voice all share one robust binary transfer protocol
  - ICE candidate queue (prevents addIceCandidate before remoteDescription)
  - Hash URL auto-join (#sessionId:token)
  - Approval modal skipped for link joins
  ─────────────────────────────────────────────
*/

"use strict"; // v20260517-2

/* ── Read hash immediately ───────────────────── */
const _hash          = location.hash.slice(1);
const _hashParts     = _hash.split(":");
const _autoSessionId = _hashParts[0] || null;
const _autoToken     = _hashParts[1] || null;
const _isAutoJoin    = Boolean(_autoSessionId && _autoToken);
if (_isAutoJoin) history.replaceState({}, "", location.pathname);

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

/* ── State ───────────────────────────────────── */
let ws              = null;
let pc              = null;        // data channel peer connection
let callPc          = null;        // SEPARATE peer connection for calls
let dataChannel     = null;
let currentSession  = null;
let isConnecting    = false;
let isHost          = false;
let iceQueue        = [];

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

// Binary transfer receive buffers — shared by files, images, voice
// transferId → { chunks[], name, size, mimeType, kind: "file"|"image"|"voice" }
const recvBuffers = {};

const WS_URL        = "wss://direct-connection.onrender.com";
const SERVER_URL    = "https://direct-connection.onrender.com";
const CHUNK_SIZE    = 65536; // 64 KB — faster transfers, still safe for modern browsers
const MAX_DC_MSG    = 200000; // ~200 KB — safety cap for single JSON messages

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302"  },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ],
  iceTransportPolicy: "all"
};

/* ══════════════════════════════════════════════
   APPROVAL / AUTO-JOIN
══════════════════════════════════════════════ */

if (_isAutoJoin) overlay.classList.add("hidden");

approveBtn.onclick = () => {
  overlay.classList.add("hidden");
  connectWebSocket();
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
  createInfo.innerHTML = `<span style="color:#7dd3fc">⏳ Joining session "<strong>${_autoSessionId}</strong>"…</span>`;
  wsSend({ type: "join-session", sessionId: _autoSessionId, token: _autoToken });
}

/* ══════════════════════════════════════════════
   WEBSOCKET
══════════════════════════════════════════════ */

function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  ws.onopen    = () => { requestSessionList(); checkAutoJoin(); };
  ws.onclose   = () => setTimeout(connectWebSocket, 3000);
  ws.onerror   = (e) => console.error("WS error", e);
  ws.onmessage = (ev) => {
    try { handleSignaling(JSON.parse(ev.data)); }
    catch (e) { console.error("WS parse error", e); }
  };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/* ══════════════════════════════════════════════
   LOBBY
══════════════════════════════════════════════ */

function requestSessionList() { wsSend({ type: "list-sessions" }); }
refreshBtn.onclick = requestSessionList;

function renderSessionList(sessions) {
  if (!sessions || !sessions.length) {
    sessionsList.innerHTML = '<div class="empty-state">Одоогоор идэвхтэй өрөө байхгүй</div>';
    return;
  }
  sessionsList.innerHTML = "";
  sessions.forEach(({ sessionId, createdAt }) => {
    const item = document.createElement("div");
    item.className = "session-item";
    item.innerHTML = `
      <div class="session-item-info">
        <div class="session-item-name">📡 ${sessionId}</div>
        <div class="session-item-meta">Created ${timeAgo(createdAt)}</div>
      </div>
      <button class="join-btn" data-id="${sessionId}">Join</button>`;
    item.querySelector(".join-btn").onclick = () => openPinModal(sessionId);
    sessionsList.appendChild(item);
  });
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

createBtn.onclick = () => {
  const sessionId = sessionIdInput.value.trim();
  if (!sessionId) { alert("Enter a session name"); return; }
  if (isConnecting) return;
  isConnecting = true;
  createBtn.disabled = true;
  createInfo.textContent = "Creating…";
  wsSend({ type: "create-session", sessionId });
};

/* ── PIN modal ───────────────────────────────── */
let pendingJoinId = null;

function openPinModal(sessionId) {
  pendingJoinId = sessionId;
  pinSessionLabel.textContent = `Session: ${sessionId}`;
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
  if (pin.length !== 6) { pinError.textContent = "PIN must be 6 digits"; return; }
  pinError.textContent = "";
  pinJoinBtn.disabled = true;
  wsSend({ type: "join-session", sessionId: pendingJoinId, pin });
}

/* ══════════════════════════════════════════════
   WEBRTC — DATA CHANNEL PC
══════════════════════════════════════════════ */

function closePeerConnection() {
  iceQueue = [];
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  if (pc) {
    pc.onicecandidate = pc.oniceconnectionstatechange =
    pc.ondatachannel  = pc.ontrack = null;
    pc.close(); pc = null;
  }
  dataChannel = null;
  sendBtn.disabled = true;
}

function createPeerConnection() {
  closePeerConnection();
  pc = new RTCPeerConnection(ICE_CONFIG);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) wsSend({ type: "ice-candidate", candidate, sessionId: currentSession.sessionId });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    console.log("ICE:", s);
    if (s === "checking")                   setQuality("⬤ Connecting…", "");
    if (s === "connected" || s === "completed") { setQuality("⬤ Connected", "connected"); startStatsPolling(); }
    if (s === "disconnected")               { setQuality("⬤ Reconnecting…", "poor"); pc.restartIce(); }
    if (s === "failed")                     { setQuality("⬤ Failed — retrying…", "failed"); handleFullRenegotiation(); }
    if (s === "closed")                     setQuality("⬤ Disconnected", "failed");
  };

  // ontrack here handles remote media from callPc — set on callPc below
  pc.ondatachannel = ({ channel }) => { dataChannel = channel; setupDataChannel(); };
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
    if (peerConn.iceGatheringState === "complete") return resolve();
    const fn = () => { if (peerConn.iceGatheringState === "complete") { peerConn.removeEventListener("icegatheringstatechange", fn); resolve(); } };
    peerConn.addEventListener("icegatheringstatechange", fn);
    setTimeout(() => { peerConn.removeEventListener("icegatheringstatechange", fn); resolve(); }, 5000);
  });
}

function setupDataChannel() {
  dataChannel.binaryType = "arraybuffer";

  dataChannel.onopen = () => {
    sendBtn.disabled = false;
    voiceCallBtn.disabled = false;
    videoCallBtn.disabled = false;
    appendSys("Peer-to-peer connection established 🔒");
  };

  dataChannel.onclose = () => {
    sendBtn.disabled = true;
    appendSys("Connection closed");
  };

  dataChannel.onerror = e => console.error("DC error", e);

  dataChannel.onmessage = ({ data }) => {
    if (typeof data === "string") handleTextMessage(JSON.parse(data));
    else                          handleBinaryChunk(data);
  };
}

/* ══════════════════════════════════════════════
   SIGNALING HANDLER
══════════════════════════════════════════════ */

async function handleSignaling(data) {
  console.log("Signaling:", data.type);

  switch (data.type) {

    case "session-list":
      renderSessionList(data.sessions);
      break;

    case "session-created": {
      isHost = true;
      currentSession = { sessionId: data.sessionId, token: data.token };

      const shareUrl = `${location.origin}${location.pathname}#${encodeURIComponent(data.sessionId)}:${data.token}`;

      createInfo.style.textAlign = "left";
      createInfo.innerHTML = `
        <div style="text-align:center;margin-bottom:14px">✅ Session ready!</div>
        <div style="background:#12151c;border-radius:10px;padding:14px;margin-bottom:12px;text-align:center">
          <div style="font-size:11px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px">PIN</div>
          <div style="font-size:28px;font-weight:700;letter-spacing:10px;color:#fff">${data.pin}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:4px">Share manually with your peer</div>
        </div>
        <div style="font-size:12px;color:#9ca3af;margin-bottom:6px">Or share this link (no PIN needed):</div>
        <div style="display:flex;gap:6px;align-items:center">
          <input id="shareUrlInput" type="text" value="${shareUrl}" readonly
            style="font-size:11px;padding:8px 10px;border-radius:8px;flex:1;min-width:0;background:#12151c;color:#7dd3fc;border:1px solid #2a2f3a">
          <button id="copyLinkBtn"
            style="width:auto;margin:0;padding:8px 14px;font-size:13px;min-height:36px;border-radius:8px;flex-shrink:0">
            Copy
          </button>
        </div>`;

      document.getElementById("copyLinkBtn").onclick = () => {
        navigator.clipboard.writeText(shareUrl).then(() => {
          document.getElementById("copyLinkBtn").textContent = "✓ Copied!";
          setTimeout(() => { const b = document.getElementById("copyLinkBtn"); if (b) b.textContent = "Copy"; }, 2000);
        }).catch(() => {
          document.getElementById("shareUrlInput").select();
          document.execCommand("copy");
          document.getElementById("copyLinkBtn").textContent = "✓ Copied!";
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

    /* ── Call signaling — uses callPc, not pc ── */
    case "call-offer":
      await handleIncomingCallOffer(data);
      break;

    case "call-answer":
      if (callPc) {
        await callPc.setRemoteDescription(new RTCSessionDescription(data.answer));
        callStatusLabel.textContent = "Connected";
      }
      break;

    case "call-ice":
      if (callPc && callPc.remoteDescription) {
        try { await callPc.addIceCandidate(data.candidate); } catch (e) { console.error(e); }
      }
      break;

    case "peer-disconnected":
      appendSys("Peer disconnected");
      endCall(false);
      closePeerConnection();
      break;

    case "error":
      console.error("[Server error]", data.message);
      if (_isAutoJoin && isConnecting) {
        createInfo.innerHTML = `<span style="color:#f87171">❌ ${data.message}</span>`;
        setLobbyButtons(false);
        isConnecting = false;
      } else {
        alert(data.message);
        createBtn.disabled = false;
        pinJoinBtn.disabled = false;
        isConnecting = false;
      }
      break;

    case "pin-error":
      if (_isAutoJoin) {
        createInfo.innerHTML = `<span style="color:#f87171">❌ Could not join: ${data.message}<br>
          <small style="color:#9ca3af">The session may have expired.</small></span>`;
        setLobbyButtons(false);
        isConnecting = false;
      } else {
        pinError.textContent = data.message;
        pinJoinBtn.disabled = false;
      }
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
  voiceCallBtn.disabled = true;
  videoCallBtn.disabled = true;
}

leaveBtn.onclick = () => {
  wsSend({ type: "leave-session", sessionId: currentSession?.sessionId });
  endCall(false);
  closePeerConnection();
  closeCallPc();
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
        setQuality(ms < 80 ? "⬤ Connected" : ms < 250 ? "⬤ Fair" : "⬤ Poor",
                   ms < 80 ? "connected" : "poor");
      }
      if (sent) parts.push(`↑ ${fmtBytes(sent)}`);
      if (recv) parts.push(`↓ ${fmtBytes(recv)}`);
      if (ctype) parts.push(`via: ${ctype}`);
      statsBar.textContent = parts.join("   ");
    } catch (_) {}
  }, 2000);
}

function fmtBytes(b) {
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

function sendTextMessage() {
  const text = messageInput.value.trim();
  if (!text || !dcReady()) return;
  const msgId = ++msgIdCounter;
  dcSend({ type: "text", text, msgId });
  const row = appendBubble("me", text);
  addAckTick(row, msgId);
  pendingAcks[msgId] = row;
  messageInput.value = "";
  messageInput.style.height = "auto";
  dcSend({ type: "typing-stop" });
}

function handleTextMessage(data) {
  switch (data.type) {

    case "text":
      appendBubble("peer", data.text);
      dcSend({ type: "ack", msgId: data.msgId });
      break;

    case "ack":
      if (pendingAcks[data.msgId]) { markDelivered(pendingAcks[data.msgId]); delete pendingAcks[data.msgId]; }
      break;

    case "typing":
      if (!peerTyping) { peerTyping = true; typingIndicator.classList.remove("hidden"); }
      break;

    case "typing-stop":
      peerTyping = false; typingIndicator.classList.add("hidden");
      break;

    case "transfer-meta":
      // Start of a binary transfer (file, image, or voice)
      recvBuffers[data.id] = { chunks: [], name: data.name, size: data.size, mimeType: data.mimeType, kind: data.kind };
      // Create placeholder for ALL kinds on receiver side
      if (data.kind === "file")  appendFileBubble("peer", null, data.name, data.size, data.id);
      if (data.kind === "image") appendImagePlaceholder("peer", data.id, data.name);
      if (data.kind === "voice") appendVoicePlaceholder("peer", data.id);
      break;

    case "transfer-done":
      assembleTransfer(data.id);
      break;

    /* Call signaling over DataChannel */
    case "call-request":
      handleCallRequest(data);
      break;

    case "call-reject":
      endCall(false);
      appendSys("Call ended");
      break;

    case "call-accept":
      initiateCallOffer(data.withVideo);
      break;
  }
}

/* ══════════════════════════════════════════════
   BINARY TRANSFER PROTOCOL
   Used for: files, images, voice notes
   Each message: [ 36 bytes transferId ][ N bytes chunk ]
══════════════════════════════════════════════ */

function makeTransferId() {
  // produces exactly 36 char UUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function sendBinary(file, kind) {
  // kind: "file" | "image" | "voice"
  if (!dcReady()) return;
  const id = makeTransferId(); // exactly 36 chars
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  dcSend({ type: "transfer-meta", id, name: file.name || "voice.webm", size: file.size, mimeType: file.type || "audio/webm", kind, totalChunks });

  // Sender already has the data — show immediately using a local object URL
  const localUrl = URL.createObjectURL(file);
  if (kind === "file")  appendFileBubble("me", localUrl, file.name, file.size, null);
  if (kind === "image") resolveImageNow("me", localUrl, file.name);
  if (kind === "voice") resolveVoiceNow("me", localUrl);

  const idBytes = new TextEncoder().encode(id); // always 36 bytes
  const ab = await file.arrayBuffer();
  for (let i = 0; i < totalChunks; i++) {
    const chunk  = ab.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const packet = new Uint8Array(36 + chunk.byteLength);
    packet.set(idBytes, 0);
    packet.set(new Uint8Array(chunk), 36);
    await drainBuffer();
    dataChannel.send(packet.buffer);
  }

  dcSend({ type: "transfer-done", id });
}

function handleBinaryChunk(buffer) {
  const id        = new TextDecoder().decode(new Uint8Array(buffer, 0, 36));
  const chunkData = buffer.slice(36);
  if (recvBuffers[id]) recvBuffers[id].chunks.push(chunkData);
}

function assembleTransfer(id) {
  const info = recvBuffers[id];
  if (!info) return;
  const blob = new Blob(info.chunks, { type: info.mimeType });
  const url  = URL.createObjectURL(blob);

  if (info.kind === "file")  resolveFileBubble(id, url, info.name);
  if (info.kind === "image") resolveImagePlaceholder(id, url, info.name);
  if (info.kind === "voice") resolveVoicePlaceholder(id, url);

  delete recvBuffers[id];
}

function drainBuffer() {
  return new Promise(resolve => {
    const check = () => {
      if (!dataChannel || dataChannel.bufferedAmount < 262144) resolve();
      else setTimeout(check, 50);
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

let _isRecording = false;

async function toggleVoiceRecord() {
  if (!dcReady()) return;

  if (!_isRecording) {
    /* ── Start recording ── */
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
        voiceRecordBtn.title = "Record voice";
      };

      mediaRecorder.start();
      _isRecording = true;
      voiceRecordBtn.classList.add("recording");
      voiceRecordBtn.title = "Tap to stop & send";

    } catch (_) {
      alert("Microphone access denied");
    }

  } else {
    /* ── Stop and send ── */
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  }
}

/* ══════════════════════════════════════════════
   CALLS — separate callPc for media
   Signaling: call-request/accept/reject via DataChannel
              call-offer/answer/ice via WebSocket (needs relay)
══════════════════════════════════════════════ */

voiceCallBtn.onclick = () => requestCall(false);
videoCallBtn.onclick = () => requestCall(true);

function requestCall(withVideo) {
  if (!dcReady()) return;
  dcSend({ type: "call-request", withVideo });
  showCallOverlay(withVideo ? "📹 Video calling…" : "📞 Voice calling…", withVideo);
}

function handleCallRequest(data) {
  const kind   = data.withVideo ? "Video" : "Voice";
  const accept = confirm(`Incoming ${kind} call — accept?`);
  if (!accept) { dcSend({ type: "call-reject" }); return; }
  dcSend({ type: "call-accept", withVideo: data.withVideo });
  showCallOverlay("Connecting…", data.withVideo);
  // Caller (who sent call-request) will now initiate the WebRTC offer
}

async function initiateCallOffer(withVideo) {
  // Called on the side that originally requested the call
  showCallOverlay(withVideo ? "📹 Connecting…" : "📞 Connecting…", withVideo);
  try {
    await setupCallPc(withVideo);
    const offer = await callPc.createOffer();
    await callPc.setLocalDescription(offer);
    await waitForICEGathering(callPc);
    wsSend({ type: "call-offer", offer: callPc.localDescription, withVideo, sessionId: currentSession.sessionId });
  } catch (e) {
    console.error("Call offer error:", e);
    endCall(false);
    appendSys("Call failed — " + e.message);
  }
}

async function handleIncomingCallOffer(data) {
  // Called on the side that accepted the call
  showCallOverlay("Connecting…", data.withVideo);
  try {
    await setupCallPc(data.withVideo);
    await callPc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await callPc.createAnswer();
    await callPc.setLocalDescription(answer);
    await waitForICEGathering(callPc);
    wsSend({ type: "call-answer", answer: callPc.localDescription, sessionId: currentSession.sessionId });
    callStatusLabel.textContent = "Connected";
  } catch (e) {
    console.error("Call answer error:", e);
    endCall(false);
    appendSys("Call failed — " + e.message);
  }
}

function setupCallPc(withVideo) {
  return new Promise(async (resolve, reject) => {
    try {
      closeCallPc(); // close any previous call PC

      callPc = new RTCPeerConnection(ICE_CONFIG);

      // ICE candidates for call go through WebSocket relay
      callPc.onicecandidate = ({ candidate }) => {
        if (candidate) wsSend({ type: "call-ice", candidate, sessionId: currentSession.sessionId });
      };

      // Remote media track → show in remoteVideo
      callPc.ontrack = ({ streams }) => {
        remoteVideo.srcObject = streams[0];
        callStatusLabel.textContent = "Connected";
      };

      // Get local media and add to callPc
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
      localVideo.srcObject = localStream;
      localStream.getTracks().forEach(track => callPc.addTrack(track, localStream));

      resolve();
    } catch (e) { reject(e); }
  });
}

function closeCallPc() {
  if (callPc) { callPc.onicecandidate = callPc.ontrack = null; callPc.close(); callPc = null; }
}

function showCallOverlay(statusText, withVideo) {
  callStatusLabel.textContent = statusText;
  callOverlay.classList.remove("hidden");
  if (withVideo) {
    remoteVideo.classList.remove("hidden");
    localVideo.classList.remove("hidden");
  } else {
    remoteVideo.classList.add("hidden");
    localVideo.classList.add("hidden");
  }
}

toggleMuteBtn.onclick = () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  toggleMuteBtn.innerHTML = isMuted ? '<i class="ti ti-microphone-off" aria-hidden="true"></i>' : '<i class="ti ti-microphone" aria-hidden="true"></i>';
};

toggleCamBtn.onclick = () => {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  toggleCamBtn.innerHTML = isCamOff ? '<i class="ti ti-camera-off" aria-hidden="true"></i>' : '<i class="ti ti-camera" aria-hidden="true"></i>';
};

endCallBtn.onclick = () => endCall(true);

function endCall(notify = true) {
  if (notify && dcReady()) dcSend({ type: "call-reject" });
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  remoteVideo.srcObject = localVideo.srcObject = null;
  remoteVideo.classList.remove("hidden");
  localVideo.classList.remove("hidden");
  callOverlay.classList.add("hidden");
  isMuted = false; isCamOff = false;
  toggleMuteBtn.innerHTML = '<i class="ti ti-microphone" aria-hidden="true"></i>';
  toggleCamBtn.innerHTML  = '<i class="ti ti-camera" aria-hidden="true"></i>';
  closeCallPc();
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
  /* Timestamp outside bubble */
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = now();
  row.appendChild(meta);
  chatMessages.appendChild(row);
  scrollBottom();
  return row;
}

/* Immediate bubble — used by sender who already has the data */
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
  wrap.innerHTML = '<i class="ti ti-microphone" style="font-size:18px;color:#06b6d4"></i>';
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
  bubble.innerHTML = `<div style="color:#9ca3af;font-size:13px">🖼️ ${name || "Image"} — receiving…</div>`;
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
  bubble.innerHTML = "";
  bubble.appendChild(img);
  /* meta outside bubble */
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
  bubble.innerHTML = `
    <div class="file-bubble">
      <div class="file-icon"><i class="ti ti-file" style="font-size:22px"></i></div>
      <div>
        <div class="file-name">${name}</div>
        <div class="file-size">${fmtBytes(size)}</div>
        ${url
          ? `<a href="${url}" download="${name}">Download</a>`
          : `<span style="color:#94a3b8;font-size:12px" class="file-pending">Receiving…</span>`}
      </div>
    </div>`;
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
  if (pending) pending.outerHTML = `<a href="${url}" download="${name}">Download</a>`;
}

function appendVoicePlaceholder(who, id) {
  const row    = document.createElement("div");
  row.className = `bubble-row ${who}`;
  row.dataset.tid = id;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = `<div class="voice-bubble"><span>🎤</span><span style="color:#9ca3af;font-size:12px">Receiving…</span></div>`;
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
  vb.innerHTML = "<span>🎤</span>";
  vb.appendChild(audio);
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
  /* meta is now a direct child of row, outside bubble */
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
   LEAVE A MESSAGE — Resend email via server
══════════════════════════════════════════════ */

leaveFileBtn.onclick = () => leaveFile.click();

leaveFile.onchange = () => {
  const f = leaveFile.files[0];
  leaveFileName.textContent = f ? `${f.name} (${fmtBytes(f.size)})` : "";
  leaveFileBtn.textContent  = f ? "📎 Change file" : "📎 Attach file";
};

leaveSendBtn.onclick = async () => {
  const msg = leaveMessage.value.trim();
  if (!msg) { setLeaveStatus("Please write a message first.", "err"); return; }
  leaveSendBtn.disabled = true;
  setLeaveStatus("Sending…", "sending");

  const fd = new FormData();
  fd.append("message", msg);
  fd.append("name", senderName.value.trim());
  const lf = leaveFile.files[0];
  if (lf) fd.append("file", lf);

  try {
    const res  = await fetch(`${SERVER_URL}/api/send-message`, { method: "POST", body: fd });
    const json = await res.json();
    if (res.ok && json.ok) {
      setLeaveStatus("✓ Message sent!", "ok");
      leaveMessage.value = "";
      senderName.value   = "";
      leaveFile.value    = "";
      leaveFileName.textContent = "";
      leaveFileBtn.textContent  = "📎 Attach file";
    } else {
      setLeaveStatus((json.error || "Failed") + (json.detail ? ": " + json.detail : ""), "err");
    }
  } catch (_) {
    setLeaveStatus("Network error. Check connection.", "err");
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

/* Also relay call-ice over WebSocket on server — add to server.js handler */

/* ── Auto-connect for hash-based link joins ── */
if (_isAutoJoin) connectWebSocket();