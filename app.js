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

chatBox.style.marginTop = "20px";

messageInput.placeholder = "Type message";
messageInput.style.width = "70%";

sendBtn.innerText = "Send";

document.querySelector(".card").appendChild(chatBox);
document.querySelector(".card").appendChild(messageInput);
document.querySelector(".card").appendChild(sendBtn);

/*
  WebSocket signaling
*/

const ws = new WebSocket("wss://direct-connection.onrender.com");

ws.onopen = () => {
  console.log("Connected to signaling server");
};

/*
  WebRTC
*/

let pc;
let dataChannel;

const configuration = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302"
    }
  ]
};

/*
  Create peer connection
*/

function createPeerConnection() {

  pc = new RTCPeerConnection(configuration);

  /*
    ICE candidates
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
    Receive DataChannel
  */

  pc.ondatachannel = (event) => {

    dataChannel = event.channel;

    setupDataChannel();

  };

}

/*
  Setup chat
*/

function setupDataChannel() {

  dataChannel.onopen = () => {

    console.log("Data channel open");

    statusBox.innerText =
      "Direct peer-to-peer connection established";

  };

  dataChannel.onmessage = (event) => {

    const msg = document.createElement("div");

    msg.innerText = `Peer: ${event.data}`;

    chatBox.appendChild(msg);

  };

}

/*
  Blur background initially
*/

background.classList.add("blur");

/*
  Approve popup
*/

approveBtn.onclick = () => {

  overlay.style.display = "none";

  background.classList.remove("blur");

};

/*
  Create Session
*/

createBtn.onclick = async () => {

  const sessionId = sessionInput.value.trim();

  if (!sessionId) {
    alert("Enter session ID");
    return;
  }

  createPeerConnection();

  /*
    Create DataChannel
  */

  dataChannel = pc.createDataChannel("chat");

  setupDataChannel();

  /*
    Create Offer
  */

  const offer = await pc.createOffer();

  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({
    type: "create-session",
    sessionId,
    offer
  }));

  statusBox.innerText =
    `Creating session: ${sessionId}`;

};

/*
  Join Session
*/

joinBtn.onclick = async () => {

  const sessionId = sessionInput.value.trim();

  if (!sessionId) {
    alert("Enter session ID");
    return;
  }

  createPeerConnection();

  ws.send(JSON.stringify({
    type: "join-session",
    sessionId
  }));

};

/*
  Receive signaling messages
*/

ws.onmessage = async (event) => {

  const data = JSON.parse(event.data);

  console.log(data);

  /*
    Receive Offer
  */

  if (data.type === "offer") {

    await pc.setRemoteDescription(
      new RTCSessionDescription(data.offer)
    );

    const answer = await pc.createAnswer();

    await pc.setLocalDescription(answer);

    ws.send(JSON.stringify({
      type: "answer",
      answer,
      sessionId: sessionInput.value.trim()
    }));

  }

  /*
    Receive Answer
  */

  if (data.type === "answer") {

    await pc.setRemoteDescription(
      new RTCSessionDescription(data.answer)
    );

  }

  /*
    ICE Candidate
  */

  if (data.type === "ice-candidate") {

    try {

      await pc.addIceCandidate(data.candidate);

    } catch (err) {

      console.error(err);

    }

  }

  /*
    Session created
  */

  if (data.type === "session-created") {

    statusBox.innerText =
      `Session created: ${data.sessionId}`;

  }

  /*
    Session joined
  */

  if (data.type === "session-joined") {

    statusBox.innerText =
      `Joined session: ${data.sessionId}`;

  }

};

/*
  Send chat message
*/

sendBtn.onclick = () => {

  const text = messageInput.value.trim();

  if (!text) return;

  dataChannel.send(text);

  const msg = document.createElement("div");

  msg.innerText = `You: ${text}`;

  chatBox.appendChild(msg);

  messageInput.value = "";

};