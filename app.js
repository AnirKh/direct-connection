const overlay = document.getElementById("overlay");
const background = document.getElementById("background");

const approveBtn = document.getElementById("approveBtn");

const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");

const sessionInput = document.getElementById("sessionId");
const statusBox = document.getElementById("status");

/*
  Wake Render signaling server immediately
*/

const ws = new WebSocket("wss://tun3l.onrender.com");

ws.onopen = () => {
  console.log("Connected to signaling server");
};

ws.onerror = (err) => {
  console.error("WebSocket error:", err);
};

/*
  Blur background while modal active
*/

background.classList.add("blur");

/*
  Approve modal
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

  statusBox.innerText = `Session created: ${sessionId}`;

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

  statusBox.innerText = `Joining session: ${sessionId}`;

  ws.send(JSON.stringify({
    type: "join-session",
    sessionId
  }));
};

ws.onmessage = (event) => {
  console.log("Server:", event.data);
};