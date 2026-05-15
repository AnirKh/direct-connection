const express = require("express");

console.log("NEW WEBRTC SERVER ACTIVE");

const http = require("http");
const WebSocket = require("ws");

const app = express();

const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

/*
  Session storage
*/

const sessions = {};

/*
  WebSocket connection
*/

wss.on("connection", (ws) => {

  console.log("Client connected");

  ws.on("message", (message) => {

    try {

      const data = JSON.parse(message);

      console.log("Received:", data.type);

      /*
        Create session
      */

      if (data.type === "create-session") {

        sessions[data.sessionId] = {
          host: ws,
          guest: null
        };

        /*
          Store offer temporarily
        */

        sessions[data.sessionId].offer = data.offer;

        ws.send(JSON.stringify({
          type: "session-created",
          sessionId: data.sessionId
        }));

      }

      /*
        Join session
      */

      if (data.type === "join-session") {

        const session = sessions[data.sessionId];

        if (!session) {

          ws.send(JSON.stringify({
            type: "error",
            message: "Session not found"
          }));

          return;

        }

        session.guest = ws;

        /*
          Send offer to guest
        */

        ws.send(JSON.stringify({
          type: "offer",
          offer: session.offer
        }));

        ws.send(JSON.stringify({
          type: "session-joined",
          sessionId: data.sessionId
        }));

      }

      /*
        Receive answer from guest
      */

      if (data.type === "answer") {

        const session = sessions[data.sessionId];

        if (!session) return;

        session.host.send(JSON.stringify({
          type: "answer",
          answer: data.answer
        }));

      }

      /*
        ICE candidate relay
      */

      if (data.type === "ice-candidate") {

        const session = sessions[data.sessionId];

        if (!session) return;

        /*
          Send candidate to opposite peer
        */

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

      console.error(err);

    }

  });

  ws.on("close", () => {

    console.log("Client disconnected");

  });

});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {

  console.log(`Server running on port ${PORT}`);

});