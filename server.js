/*
  ─────────────────────────────────────────────
  Direct Connection — server.js
  Features:
  - Session create with 6-digit PIN
  - Session list broadcast
  - PIN verification on join
  - Offer / answer / ICE relay
  - Renegotiation offer/answer relay
  - Call offer/answer relay
  - Peer disconnect notification
  - Session cleanup on disconnect
  - Stale session pruner (10 min)
  ─────────────────────────────────────────────
*/

"use strict";

const express   = require("express");
const http      = require("http");
const WebSocket = require("ws");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// sessions map: sessionId → { host, guest, offer, pin, createdAt }
const sessions = {};

/* ── PIN generator ─────────────────────────── */
function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* ── Broadcast session list to all lobby clients ── */
function broadcastSessionList() {
  const list = Object.entries(sessions)
    .filter(([, s]) => !s.guest) // only open (waiting) sessions
    .map(([sessionId, s]) => ({ sessionId, createdAt: s.createdAt }));

  const msg = JSON.stringify({ type: "session-list", sessions: list });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

/* ── Cleanup on client disconnect ──────────── */
function cleanupClient(ws) {
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session.host === ws || session.guest === ws) {

      const other = session.host === ws ? session.guest : session.host;

      if (other && other.readyState === WebSocket.OPEN) {
        other.send(JSON.stringify({ type: "peer-disconnected" }));
      }

      delete sessions[sessionId];
      console.log(`Session "${sessionId}" removed on disconnect`);
      broadcastSessionList();
    }
  }
}

/* ── Relay helper ──────────────────────────── */
function relayToOther(ws, sessionId, payload) {
  const session = sessions[sessionId];
  if (!session) return;
  const other = ws === session.host ? session.guest : session.host;
  if (other && other.readyState === WebSocket.OPEN) {
    other.send(JSON.stringify(payload));
  }
}

/* ══════════════════════════════════════════════
   CONNECTION HANDLER
══════════════════════════════════════════════ */

wss.on("connection", (ws) => {
  console.log(`Client connected | sessions: ${Object.keys(sessions).length}`);

  ws.on("close", () => { console.log("Client disconnected"); cleanupClient(ws); });
  ws.on("error", (e) => { console.error("WS error:", e); cleanupClient(ws); });

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); }
    catch (e) { console.error("Parse error:", e); return; }

    console.log("MSG:", data.type);

    switch (data.type) {

      /* ── List sessions (lobby polling) ── */
      case "list-sessions": {
        const list = Object.entries(sessions)
          .filter(([, s]) => !s.guest)
          .map(([sessionId, s]) => ({ sessionId, createdAt: s.createdAt }));
        ws.send(JSON.stringify({ type: "session-list", sessions: list }));
        break;
      }

      /* ── Create session ── */
      case "create-session": {
        const { sessionId } = data;

        // overwrite if same host reconnects
        if (sessions[sessionId]) delete sessions[sessionId];

        const pin = generatePin();
        sessions[sessionId] = { host: ws, guest: null, offer: null, pin, createdAt: Date.now() };

        ws.send(JSON.stringify({ type: "session-created", sessionId, pin }));
        broadcastSessionList();
        console.log(`Session "${sessionId}" created | PIN: ${pin}`);
        break;
      }

      /* ── Join session (with PIN) ── */
      case "join-session": {
        const { sessionId, pin } = data;
        const session = sessions[sessionId];

        if (!session) {
          ws.send(JSON.stringify({ type: "pin-error", message: "Session not found" }));
          break;
        }
        if (session.guest) {
          ws.send(JSON.stringify({ type: "pin-error", message: "Session is full" }));
          break;
        }
        if (session.pin !== pin) {
          ws.send(JSON.stringify({ type: "pin-error", message: "Wrong PIN" }));
          break;
        }

        session.guest = ws;

        // notify guest
        ws.send(JSON.stringify({ type: "session-joined", sessionId }));

        // notify host that guest joined
        if (session.host && session.host.readyState === WebSocket.OPEN) {
          session.host.send(JSON.stringify({ type: "guest-joined", sessionId }));
        }

        broadcastSessionList(); // remove from open list
        console.log(`Session "${sessionId}" joined`);
        break;
      }

      /* ── Offer (host → server → guest) ── */
      case "offer": {
        const session = sessions[data.sessionId];
        if (!session) break;
        session.offer = data.offer;
        if (session.guest && session.guest.readyState === WebSocket.OPEN) {
          session.guest.send(JSON.stringify({ type: "offer", offer: data.offer }));
        }
        break;
      }

      /* ── Answer (guest → server → host) ── */
      case "answer": {
        relayToOther(ws, data.sessionId, { type: "answer", answer: data.answer });
        break;
      }

      /* ── ICE candidates ── */
      case "ice-candidate": {
        relayToOther(ws, data.sessionId, { type: "ice-candidate", candidate: data.candidate });
        break;
      }

      /* ── Renegotiation (ICE failed recovery) ── */
      case "renegotiate-offer": {
        relayToOther(ws, data.sessionId, { type: "renegotiate-offer", offer: data.offer });
        break;
      }
      case "renegotiate-answer": {
        relayToOther(ws, data.sessionId, { type: "renegotiate-answer", answer: data.answer });
        break;
      }

      /* ── Call offer/answer (media renegotiation) ── */
      case "call-offer": {
        relayToOther(ws, data.sessionId, { type: "call-offer", offer: data.offer, withVideo: data.withVideo });
        break;
      }
      case "call-answer": {
        relayToOther(ws, data.sessionId, { type: "call-answer", answer: data.answer });
        break;
      }

      /* ── Leave ── */
      case "leave-session": {
        cleanupClient(ws);
        break;
      }

      default:
        console.log("Unknown message type:", data.type);
    }
  });
});

/* ── Stale session pruner (runs every 60s) ─── */
setInterval(() => {
  const TEN_MIN = 10 * 60 * 1000;
  const now = Date.now();
  let pruned = 0;
  for (const [id, session] of Object.entries(sessions)) {
    if (!session.guest && now - session.createdAt > TEN_MIN) {
      delete sessions[id];
      pruned++;
    }
  }
  if (pruned) { console.log(`Pruned ${pruned} stale session(s)`); broadcastSessionList(); }
}, 60_000);

/* ── Start ─────────────────────────────────── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));