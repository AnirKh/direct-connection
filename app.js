const overlay = document.getElementById("overlay");
const background = document.getElementById("background");
const approveBtn = document.getElementById("approveBtn");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const sessionInput = document.getElementById("sessionId");
const statusBox = document.getElementById("status");

/*
  Chat UI
*/

const chatBox = document.createElement("div");
const messageInput = document.createElement("input");
const sendBtn = document.createElement("button");

chatBox.id = "chatBox";
chatBox.style.marginTop = "20px";

messageInput.placeholder = "Type message";
messageInput.style.width = "70%";
messageInput.id = "messageInput";

sendBtn.innerText = "Send";
sendBtn.disabled = true;

document.querySelector(".card").appendChild(chatBox);
document.querySelector(".card").appendChild(messageInput);
document.querySelector(".card").appendChild(sendBtn);

/*
  Multiple STUN servers — redundancy across Google + Cloudflare
*/

const configuration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ],
  iceTransportPolicy: "all"
};

let pc = null;
let dataChannel = null;
let ws = null;
let isConnecting = false;

/*
  UI helpers
*/

function setStatus(msg, color = "#7dd3fc") {
  statusBox.innerText = msg;
  statusBox.style.color = color;
}

function setButtonsDisabled(disabled) {
  createBtn.disabled = disabled;
  joinBtn.disabled = disabled;
  sessionInput.disabled = disabled;
}

function appendMessage(who, text) {
  const msg = document.createElement("div");
  msg.style.padding = "4px 0";
  msg.style.color = who === "You" ? "#ffffff" : "#7dd3fc";
  msg.innerText = `${who}: ${text}`;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
}

/*
  WebSocket — with automatic reconnect
*/

function connectWebSocket() {

  ws = new WebSocket("wss://direct-connection.onrender.com");

  ws.onopen = () => {
    console.log("Connected to signaling server");
    setStatus("Ready");
  };

  ws.onclose = () => {
    console.log("WebSocket closed — reconnecting in 3s");
    setStatus("Signaling server disconnected — reconnecting...", "#f87171");
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  ws.onmessage = handleSignalingMessage;

}

connectWebSocket();

/*
  Wait for ICE gathering to fully complete before sending offer/answer
  — bundles all candidates into the description, avoids trickle race conditions
  — 5s timeout fallback in case gathering stalls
*/

function waitForICEGathering(peerConnection) {
  return new Promise((resolve) => {
    if (peerConnection.iceGatheringState === "complete") return resolve();

    const onStateChange = () => {
      if (peerConnection.iceGatheringState === "complete") {
        peerConnection.removeEventListener("icegatheringstatechange", onStateChange);
        resolve();
      }
    };

    peerConnection.addEventListener("icegatheringstatechange", onStateChange);

    setTimeout(() => {
      peerConnection.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    }, 5000);
  });
}

/*
  Close existing peer connection cleanly before creating a new one
  — prevents ghost RTCPeerConnections piling up on re-click
*/

function closePeerConnection() {
  if (pc) {
    pc.onicecandidate = null;
    pc.oniceconnectionstatechange = null;
    pc.onicegatheringstatechange = null;
    pc.ondatachannel = null;
    pc.close();
    pc = null;
  }
  dataChannel = null;
  sendBtn.disabled = true;
}

/*
  Create peer connection with ICE state monitoring
*/

function createPeerConnection() {

  closePeerConnection();

  pc = new RTCPeerConnection(configuration);

  /*
    Trickle ICE — send candidates as backup alongside bundled offer/answer
  */

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: "ice-candidate",
        candidate: event.candidate,
        sessionId: sessionInput.value.trim()
      }));
    }
  };

  /*
    ICE connection state monitoring + restartIce() on disconnect
  */

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    console.log("ICE state:", state);

    switch (state) {

      case "checking":
        setStatus("Establishing connection...");
        break;

      case "connected":
      case "completed":
        setStatus("Direct peer-to-peer connection established", "#4ade80");
        setButtonsDisabled(false);
        isConnecting = false;
        break;

      case "disconnected":
        setStatus("Connection lost — attempting recovery...", "#fb923c");
        /*
          restartIce() triggers new ICE gathering without full renegotiation
          — re-signals new candidates to recover from transient network drops
        */
        pc.restartIce();
        break;

      case "failed":
        setStatus("Connection failed. Please try again.", "#f87171");
        setButtonsDisabled(false);
        isConnecting = false;
        closePeerConnection();
        break;

      case "closed":
        setStatus("Connection closed.", "#9ca3af");
        break;

    }
  };

  /*
    Receive DataChannel (guest side)
  */

  pc.ondatachannel = (event) => {
    dataChannel = event.channel;
    setupDataChannel();
  };

}

/*
  Setup DataChannel events
*/

function setupDataChannel() {

  dataChannel.onopen = () => {
    console.log("Data channel open");
    setStatus("Direct peer-to-peer connection established", "#4ade80");
    sendBtn.disabled = false;
  };

  dataChannel.onclose = () => {
    setStatus("Data channel closed.", "#9ca3af");
    sendBtn.disabled = true;
  };

  dataChannel.onerror = (err) => {
    console.error("Data channel error:", err);
  };

  dataChannel.onmessage = (event) => {
    appendMessage("Peer", event.data);
  };

}

/*
  Blur background until approved
*/

background.classList.add("blur");

approveBtn.onclick = () => {
  overlay.style.display = "none";
  background.classList.remove("blur");
};

/*
  Create Session
*/

createBtn.onclick = async () => {

  if (isConnecting) return;

  const sessionId = sessionInput.value.trim();
  if (!sessionId) { alert("Enter session ID"); return; }

  isConnecting = true;
  setButtonsDisabled(true);
  setStatus("Creating session...");

  createPeerConnection();

  dataChannel = pc.createDataChannel("chat");
  setupDataChannel();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  /*
    Wait for full ICE gathering — all candidates bundled into localDescription
  */
  setStatus("Gathering network candidates...");
  await waitForICEGathering(pc);

  ws.send(JSON.stringify({
    type: "create-session",
    sessionId,
    offer: pc.localDescription
  }));

};

/*
  Join Session
*/

joinBtn.onclick = async () => {

  if (isConnecting) return;

  const sessionId = sessionInput.value.trim();
  if (!sessionId) { alert("Enter session ID"); return; }

  isConnecting = true;
  setButtonsDisabled(true);
  setStatus("Joining session...");

  createPeerConnection();

  ws.send(JSON.stringify({
    type: "join-session",
    sessionId
  }));

};

/*
  Handle all signaling messages
*/

async function handleSignalingMessage(event) {

  const data = JSON.parse(event.data);
  console.log("Signaling:", data.type);

  /*
    Receive Offer — guest side
  */

  if (data.type === "offer") {

    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    setStatus("Gathering network candidates...");
    await waitForICEGathering(pc);

    ws.send(JSON.stringify({
      type: "answer",
      answer: pc.localDescription,
      sessionId: sessionInput.value.trim()
    }));

  }

  /*
    Receive Answer — host side
  */

  if (data.type === "answer") {
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
  }

  /*
    Receive ICE candidate — trickle fallback
  */

  if (data.type === "ice-candidate") {
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (err) {
      console.error("ICE candidate error:", err);
    }
  }

  /*
    Session created — waiting for peer
  */

  if (data.type === "session-created") {
    setStatus(`Session "${data.sessionId}" ready — waiting for peer...`);
  }

  /*
    Session joined
  */

  if (data.type === "session-joined") {
    setStatus(`Joined session "${data.sessionId}" — connecting...`);
  }

  /*
    Peer disconnected (server notifies us)
  */

  if (data.type === "peer-disconnected") {
    setStatus("Peer disconnected.", "#f87171");
    sendBtn.disabled = true;
    setButtonsDisabled(false);
    isConnecting = false;
    closePeerConnection();
  }

  /*
    Error
  */

  if (data.type === "error") {
    setStatus(`Error: ${data.message}`, "#f87171");
    setButtonsDisabled(false);
    isConnecting = false;
    closePeerConnection();
  }

}

/*
  Send chat message
*/

sendBtn.onclick = () => {
  const text = messageInput.value.trim();
  if (!text || !dataChannel || dataChannel.readyState !== "open") return;

  dataChannel.send(text);
  appendMessage("You", text);
  messageInput.value = "";
};

/*
  Send on Enter key
*/

messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.onclick();
});