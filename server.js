const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();

const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

console.log("NEW WEBRTC SERVER ACTIVE");

const sessions = {};

wss.on("connection", (ws) => {

  console.log("Client connected");

  ws.on("message", (message) => {

    try {

      const data = JSON.parse(message);

      console.log("Received:", data.type);

      /*
        CREATE SESSION
      */

      if (data.type === "create-session") {

        sessions[data.sessionId] = {
          host: ws,
          guest: null,
          offer: data.offer
        };

        ws.send(JSON.stringify({
          type: "session-created",
          sessionId: data.sessionId
        }));

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

        session.guest = ws;

        /*
          IMPORTANT:
          Send session joined FIRST
        */

        ws.send(JSON.stringify({
          type: "session-joined",
          sessionId: data.sessionId
        }));

        /*
          THEN send offer
        */

        ws.send(JSON.stringify({
          type: "offer",
          offer: session.offer
        }));

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
        ICE CANDIDATES
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

      console.error(err);

    }

  });

});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {

  console.log(`Server running on port ${PORT}`);

});