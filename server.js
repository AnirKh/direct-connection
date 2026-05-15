const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

console.log("NEW WEBRTC SERVER ACTIVE");

const sessions = {};

/*
  Clean up all sessions a disconnected client was part of
  and notify the remaining peer
*/

function cleanupClient(ws) {

  for (const [sessionId, session] of Object.entries(sessions)) {

    if (session.host === ws || session.guest === ws) {

      const other = session.host === ws ? session.guest : session.host;

      if (other && other.readyState === WebSocket.OPEN) {
        other.send(JSON.stringify({ type: "peer-disconnected" }));
      }

      delete sessions[sessionId];
      console.log(`Session "${sessionId}" cleaned up`);

    }

  }

}

wss.on("connection", (ws) => {

  console.log("Client connected | Active sessions:", Object.keys(sessions).length);

  /*
    Session cleanup on disconnect
  */

  ws.on("close", () => {
    console.log("Client disconnected");
    cleanupClient(ws);
  });

  ws.on("error", (err) => {
    console.error("WebSocket client error:", err);
    cleanupClient(ws);
  });

  ws.on("message", (message) => {

    try {

      const data = JSON.parse(message);
      console.log("Received:", data.type);

      /*
        CREATE SESSION
      */

      if (data.type === "create-session") {

        /*
          If session ID already exists, clean it up first
        */
        if (sessions[data.sessionId]) {
          console.log(`Session "${data.sessionId}" already exists — overwriting`);
          delete sessions[data.sessionId];
        }

        sessions[data.sessionId] = {
          host: ws,
          guest: null,
          offer: data.offer,
          createdAt: Date.now()
        };

        ws.send(JSON.stringify({
          type: "session-created",
          sessionId: data.sessionId
        }));

        console.log(`Session "${data.sessionId}" created | Total sessions: ${Object.keys(sessions).length}`);

      }

      /*
        JOIN SESSION
      */

      else if (data.type === "join-session") {

        const session = sessions[data.sessionId];

        if (!session) {
          ws.send(JSON.stringify({
            type: "error",
            message: "Session not found"
          }));
          return;
        }

        if (session.guest) {
          ws.send(JSON.stringify({
            type: "error",
            message: "Session already has two peers"
          }));
          return;
        }

        session.guest = ws;

        ws.send(JSON.stringify({
          type: "session-joined",
          sessionId: data.sessionId
        }));

        ws.send(JSON.stringify({
          type: "offer",
          offer: session.offer
        }));

        console.log(`Session "${data.sessionId}" joined`);

      }

      /*
        ANSWER
      */

      else if (data.type === "answer") {

        const session = sessions[data.sessionId];
        if (!session || !session.host) return;

        session.host.send(JSON.stringify({
          type: "answer",
          answer: data.answer
        }));

      }

      /*
        ICE CANDIDATES — relay to the other peer
      */

      else if (data.type === "ice-candidate") {

        const session = sessions[data.sessionId];
        if (!session) return;

        if (ws === session.host && session.guest) {
          session.guest.send(JSON.stringify({
            type: "ice-candidate",
            candidate: data.candidate
          }));
        }

        else if (ws === session.guest && session.host) {
          session.host.send(JSON.stringify({
            type: "ice-candidate",
            candidate: data.candidate
          }));
        }

      }

    }

    catch (err) {
      console.error("Message handling error:", err);
    }

  });

});

/*
  Periodic stale session cleanup
  — removes sessions older than 10 minutes with no guest
*/

setInterval(() => {

  const now = Date.now();
  const TEN_MINUTES = 10 * 60 * 1000;

  for (const [sessionId, session] of Object.entries(sessions)) {
    if (!session.guest && (now - session.createdAt) > TEN_MINUTES) {
      delete sessions[sessionId];
      console.log(`Stale session "${sessionId}" removed`);
    }
  }

}, 60 * 1000); // runs every minute

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});