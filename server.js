const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

const sessions = {};

wss.on("connection", (ws) => {

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      /*
        Create Session
      */

      if (data.type === "create-session") {

        sessions[data.sessionId] = {
          host: ws,
          guest: null
        };

        ws.send(JSON.stringify({
          type: "session-created",
          sessionId: data.sessionId
        }));
      }

      /*
        Join Session
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

        ws.send(JSON.stringify({
          type: "session-joined",
          sessionId: data.sessionId
        }));

        session.host.send(JSON.stringify({
          type: "peer-connected"
        }));
      }

    } catch (err) {
      console.error(err);
    }
  });

});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});