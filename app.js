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

const ws = new WebSocket("wss://direct-connection.onrender.com");

ws.onopen = () => {
  console.log("Connected to signaling server");
};

ws.onerror = (err) => {
  console.error("WebSocket error:", err);
};

ws.onclose = () => {
  console.log("WebSocket closed");
};

/*
  Blur background initially
*/

background.classList.add("blur");

/*
  Approve popup
*/

approveBtn.onclick = () => {

  console.log("Approve clicked");

  overlay.style.display = "none";

  background.classList.remove("blur");
};

/*
  Create Session
*/

createBtn.onclick = () => {

  console.log("Create button clicked");

  const sessionId = sessionInput.value.trim();

  console.log("Session ID:", sessionId);

  if (!sessionId) {
    alert("Enter session ID");
    return;
  }

  statusBox.innerText =
    `Creating session: ${sessionId}`;

  ws.send(JSON.stringify({
    type: "create-session",
    sessionId
  }));

  console.log("Create-session sent");
};

/*
  Join Session
*/

joinBtn.onclick = () => {

  console.log("Join button clicked");

  const sessionId = sessionInput.value.trim();

  console.log("Session ID:", sessionId);

  if (!sessionId) {
    alert("Enter session ID");
    return;
  }

  statusBox.innerText =
    `Joining session: ${sessionId}`;

  ws.send(JSON.stringify({
    type: "join-session",
    sessionId
  }));

  console.log("Join-session sent");
};

/*
  Receive messages from signaling server
*/

ws.onmessage = (event) => {

  console.log("Received:", event.data);

  const data = JSON.parse(event.data);

  console.log(data);

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

  /*
    Peer connected
  */

  if (data.type === "peer-connected") {

    statusBox.innerText =
      `Peer connected successfully`;
  }

  /*
    Error
  */

  if (data.type === "error") {

    statusBox.innerText =
      data.message;
  }

};