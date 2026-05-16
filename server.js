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
  - POST /api/send-message (SMTP + optional file attachment)
  ─────────────────────────────────────────────

  Render environment variables required:
    SMTP_HOST     e.g. smtp.gmail.com
    SMTP_PORT     e.g. 465
    SMTP_SECURE   true (for 465) | false (for 587)
    SMTP_USER     your sending email address
    SMTP_PASS     Gmail app password (not your login password)
    MAIL_TO       recipient email address (Anir's email)
*/

"use strict";

const express   = require("express");
const http      = require("http");
const WebSocket = require("ws");
const multer    = require("multer");
const { Resend } = require("resend");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

/* ── Resend client ─────────────────────────── */

const resend = new Resend(process.env.RESEND_API_KEY);

/* ── Multer — store file in memory (max 10MB) ── */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

/* ── CORS headers (GitHub Pages → Render) ─── */

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ══════════════════════════════════════════════
   POST /api/send-message
   Body (multipart/form-data):
     message  — text body (required)
     name     — sender name (optional)
     file     — attachment (optional, max 10MB)
══════════════════════════════════════════════ */

app.post("/api/send-message", upload.single("file"), async (req, res) => {
  const { message, name } = req.body;

  if (!message || message.trim() === "") {
    return res.status(400).json({ error: "Message is required" });
  }

  if (!process.env.MAIL_TO) {
    return res.status(500).json({ error: "Server email not configured" });
  }

  const senderLabel = name && name.trim() ? name.trim() : "Anonymous";
  const sentAt = new Date().toLocaleString("en-US", { timeZone: "UTC" }) + " UTC";

  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;background:#1b1f27;color:#fff;border-radius:12px;overflow:hidden">
      <div style="background:#2563eb;padding:20px 24px">
        <h2 style="margin:0;font-size:18px">📩 New message via Direct Connection</h2>
      </div>
      <div style="padding:24px">
        <p style="color:#9ca3af;font-size:13px;margin:0 0 4px">From</p>
        <p style="font-size:16px;font-weight:600;margin:0 0 16px">${senderLabel}</p>
        <p style="color:#9ca3af;font-size:13px;margin:0 0 4px">Message</p>
        <div style="background:#2a2f3a;padding:14px 16px;border-radius:8px;font-size:15px;line-height:1.6;white-space:pre-wrap">${escapeHtml(message.trim())}</div>
        <p style="color:#9ca3af;font-size:12px;margin:16px 0 0">Sent: ${sentAt}</p>
      </div>
    </div>
  `;

  const mailOptions = {
    from:    "Direct Connection <onboarding@resend.dev>",
    to:      process.env.MAIL_TO,
    subject: `📩 New message from ${senderLabel}`,
    text:    `From: ${senderLabel}\nSent: ${sentAt}\n\n${message.trim()}`,
    html:    htmlBody
  };

  /* Attach file if provided */
  if (req.file) {
    mailOptions.attachments = [{
      filename: req.file.originalname,
      content:  req.file.buffer
    }];
  }

  try {
    const { error } = await resend.emails.send(mailOptions);
    if (error) throw new Error(error.message);
    console.log(`Email sent from ${senderLabel}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Resend error:", err.message);
    res.status(500).json({ error: "Failed to send email", detail: err.message });
  }
});

/* ── HTML escape helper ─────────────────────── */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ══════════════════════════════════════════════
   WEBSOCKET — signaling
══════════════════════════════════════════════ */

const sessions = {};

function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generateToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 12; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

function broadcastSessionList() {
  const list = Object.entries(sessions)
    .filter(([, s]) => !s.guest)
    .map(([sessionId, s]) => ({ sessionId, createdAt: s.createdAt }));

  const msg = JSON.stringify({ type: "session-list", sessions: list });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function cleanupClient(ws) {
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session.host === ws || session.guest === ws) {
      const other = session.host === ws ? session.guest : session.host;
      if (other && other.readyState === WebSocket.OPEN) {
        other.send(JSON.stringify({ type: "peer-disconnected" }));
      }
      delete sessions[sessionId];
      console.log(`Session "${sessionId}" removed`);
      broadcastSessionList();
    }
  }
}

function relayToOther(ws, sessionId, payload) {
  const session = sessions[sessionId];
  if (!session) return;
  const other = ws === session.host ? session.guest : session.host;
  if (other && other.readyState === WebSocket.OPEN) {
    other.send(JSON.stringify(payload));
  }
}

wss.on("connection", (ws) => {
  console.log(`Client connected | sessions: ${Object.keys(sessions).length}`);

  ws.on("close", () => { console.log("Client disconnected"); cleanupClient(ws); });
  ws.on("error", (e) => { console.error("WS error:", e); cleanupClient(ws); });

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    console.log("MSG:", data.type);

    switch (data.type) {

      case "list-sessions": {
        const list = Object.entries(sessions)
          .filter(([, s]) => !s.guest)
          .map(([sessionId, s]) => ({ sessionId, createdAt: s.createdAt }));
        ws.send(JSON.stringify({ type: "session-list", sessions: list }));
        break;
      }

      case "create-session": {
        if (sessions[data.sessionId]) delete sessions[data.sessionId];
        const pin   = generatePin();
        const token = generateToken();
        sessions[data.sessionId] = { host: ws, guest: null, offer: null, pin, token, createdAt: Date.now() };
        ws.send(JSON.stringify({ type: "session-created", sessionId: data.sessionId, pin, token }));
        broadcastSessionList();
        console.log(`Session "${data.sessionId}" created | PIN: ${pin}`);
        break;
      }

      case "join-session": {
        const session = sessions[data.sessionId];
        if (!session) { ws.send(JSON.stringify({ type: "pin-error", message: "Session not found" })); break; }
        if (session.guest) { ws.send(JSON.stringify({ type: "pin-error", message: "Session is full" })); break; }
        const pinOk   = data.pin   && session.pin   === data.pin;
        const tokenOk = data.token && session.token === data.token;
        if (!pinOk && !tokenOk) { ws.send(JSON.stringify({ type: "pin-error", message: "Wrong PIN or invalid link" })); break; }

        session.guest = ws;
        ws.send(JSON.stringify({ type: "session-joined", sessionId: data.sessionId }));
        if (session.host?.readyState === WebSocket.OPEN) {
          session.host.send(JSON.stringify({ type: "guest-joined", sessionId: data.sessionId }));
        }
        broadcastSessionList();
        break;
      }

      case "offer": {
        const session = sessions[data.sessionId];
        if (!session) break;
        session.offer = data.offer;
        if (session.guest?.readyState === WebSocket.OPEN) {
          session.guest.send(JSON.stringify({ type: "offer", offer: data.offer }));
        }
        break;
      }

      case "answer":             relayToOther(ws, data.sessionId, { type: "answer",             answer:   data.answer });   break;
      case "ice-candidate":      relayToOther(ws, data.sessionId, { type: "ice-candidate",      candidate: data.candidate }); break;
      case "renegotiate-offer":  relayToOther(ws, data.sessionId, { type: "renegotiate-offer",  offer:    data.offer });    break;
      case "renegotiate-answer": relayToOther(ws, data.sessionId, { type: "renegotiate-answer", answer:   data.answer });   break;
      case "call-offer":         relayToOther(ws, data.sessionId, { type: "call-offer",         offer:    data.offer,  withVideo: data.withVideo }); break;
      case "call-answer":        relayToOther(ws, data.sessionId, { type: "call-answer",        answer:   data.answer }); break;

      case "leave-session": cleanupClient(ws); break;

      default: console.log("Unknown:", data.type);
    }
  });
});

/* ── Stale session pruner ───────────────────── */
setInterval(() => {
  const TEN_MIN = 10 * 60 * 1000;
  const now = Date.now(); let pruned = 0;
  for (const [id, s] of Object.entries(sessions)) {
    if (!s.guest && now - s.createdAt > TEN_MIN) { delete sessions[id]; pruned++; }
  }
  if (pruned) { console.log(`Pruned ${pruned} stale session(s)`); broadcastSessionList(); }
}, 60_000);

/* ── Start ─────────────────────────────────── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));