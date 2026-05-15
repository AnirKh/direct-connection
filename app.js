const overlay = document.getElementById("overlay");
const background = document.getElementById("background");

const approveBtn = document.getElementById("approveBtn");

const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");

const sessionInput = document.getElementById("sessionId");

const statusBox = document.getElementById("status");

/*
  Connect to signaling server
*/

const ws = new WebSocket("wss://tun3l.onrender.com");

ws.onopen = () => {
  console.log("Connected to signaling server");
};

background.classList.add("blur");

/*
  Approve
*/

approveBtn.onclick = () => {
  overlay.style.display = "none";
  background.classList.remove("blur");
};

/*
  Create Session
*/

createBtn.onclick = () => {

  const sessionId = sessionInput.value.trim();

  if (!sessionId) {
    alert("Enter session ID");
    return;
  }

  ws.send(JSON.stringify({
    type: "create-session",
    sessionId
  }));
};

/*
  Join Session
*/

joinBtn.onclick = () => {

  const sessionId = sessionInput.value.trim();

  if (!sessionId) {
    alert("Enter session ID");
    return;
  }

  ws.send(JSON.stringify({
    type: "join-session",
    sessionId
  }));
};

/*
  Receive server messages
*/

ws.onmessage = (event) => {

  const data = JSON.parse(event.data);

  if (data.type === "session-created") {

    statusBox.innerText =
      `Session created: ${data.sessionId}`;

  }

  if (data.type === "session-joined") {

    statusBox.innerText =
      `Joined session: ${data.sessionId}`;

  }

  if (data.type === "peer-connected") {

    statusBox.innerText =
      `Peer connected successfully`;

  }

  if (data.type === "error") {

    statusBox.innerText =
      data.message;

  }

};