const popup = document.getElementById("popup");
const main = document.getElementById("main");
const approveBtn = document.getElementById("approveBtn");

const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");

const sessionInput = document.getElementById("sessionId");
const statusBox = document.getElementById("status");

// Wake signaling server immediately
const ws = new WebSocket("wss://tun3l.onrender.com");

ws.onopen = () => {
  console.log("Connected to signaling server");
};

ws.onerror = (err) => {
  console.error("WebSocket error:", err);
};

approveBtn.onclick = () => {
  popup.style.display = "none";
  main.classList.remove("hidden");
};

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