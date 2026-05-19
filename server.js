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
  - PIN brute-force protection (3 attempts → 30s lockout per IP)
  - POST /api/send-message (Resend + optional file attachment)
  ─────────────────────────────────────────────

  Render environment variables required:
    RESEND_API_KEY  Resend API key
    MAIL_TO         recipient email address
*/

"use strict";

const express    = require("express");
const http       = require("http");
const crypto     = require("crypto");
const WebSocket  = require("ws");
const multer     = require("multer");
const { Resend } = require("resend");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, maxPayload: 1024 * 1024 });
const DEFAULT_ALLOWED_ORIGINS = [
  "https://direct-connection.onrender.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

/* ── Resend client ─────────────────────────── */
let resend = null;

function getResendClient() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

/* ── Multer — store file in memory (max 10MB) ── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ── Ping endpoint — used by client to wake server ── */
app.get("/api/ping", (req, res) => res.json({ ok: true }));

/* ══════════════════════════════════════════════
   POST /api/send-message
══════════════════════════════════════════════ */

const MESSAGE_MAX = 5000;
const NAME_MAX = 200;
const EMAIL_WINDOW_MS = 60_000;
const EMAIL_MAX_PER_WINDOW = 5;
const emailAttempts = new Map();

function checkEmailRateLimit(ip) {
  const now = Date.now();
  const entry = emailAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    emailAttempts.set(ip, { count: 1, resetAt: now + EMAIL_WINDOW_MS });
    return { allowed: true };
  }
  if (entry.count >= EMAIL_MAX_PER_WINDOW) {
    return { allowed: false, remaining: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of emailAttempts) {
    if (entry.resetAt <= now) emailAttempts.delete(ip);
  }
}, 60_000);

function cleanHeaderValue(str) {
  return str.replace(/[\r\n]+/g, " ").trim();
}

function cleanAttachmentName(name) {
  const cleaned = String(name || "attachment")
    .replace(/[\r\n/\\:*?"<>|]+/g, "_")
    .slice(0, 180)
    .trim();
  return cleaned || "attachment";
}

app.post("/api/send-message", upload.single("file"), async (req, res) => {
  const { message, name } = req.body;
  const clientIp =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const emailLimit = checkEmailRateLimit(clientIp);
  if (!emailLimit.allowed) {
    return res.status(429).json({ error: `Too many messages. Try again in ${emailLimit.remaining}s.` });
  }

  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "Message is required" });
  }
  const trimmedMessage = message.trim();
  if (trimmedMessage.length > MESSAGE_MAX) {
    return res.status(400).json({ error: `Message must be ${MESSAGE_MAX} characters or fewer` });
  }
  if (!process.env.MAIL_TO) {
    return res.status(500).json({ error: "Server email not configured" });
  }
  const resendClient = getResendClient();
  if (!resendClient) {
    return res.status(500).json({ error: "Server email not configured" });
  }

  const rawName = typeof name === "string" ? name : "";
  const senderLabel = cleanHeaderValue(rawName.trim() ? rawName.trim() : "Anonymous").slice(0, NAME_MAX) || "Anonymous";
  const safeSenderLabel = escapeHtml(senderLabel);
  const sentAt = new Date().toLocaleString("en-US", { timeZone: "UTC" }) + " UTC";

  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;background:#1b1f27;color:#fff;border-radius:12px;overflow:hidden">
      <div style="background:#2563eb;padding:20px 24px">
        <h2 style="margin:0;font-size:18px">📩 New message via Direct Connection</h2>
      </div>
      <div style="padding:24px">
        <p style="color:#9ca3af;font-size:13px;margin:0 0 4px">From</p>
        <p style="font-size:16px;font-weight:600;margin:0 0 16px">${safeSenderLabel}</p>
        <p style="color:#9ca3af;font-size:13px;margin:0 0 4px">Message</p>
        <div style="background:#2a2f3a;padding:14px 16px;border-radius:8px;font-size:15px;line-height:1.6;white-space:pre-wrap">${escapeHtml(trimmedMessage)}</div>
        <p style="color:#9ca3af;font-size:12px;margin:16px 0 0">Sent: ${sentAt}</p>
      </div>
    </div>
  `;

  const mailOptions = {
    from:    "Direct Connection <onboarding@resend.dev>",
    to:      process.env.MAIL_TO,
    subject: `📩 New message from ${senderLabel}`,
    text:    `From: ${senderLabel}\nSent: ${sentAt}\n\n${trimmedMessage}`,
    html:    htmlBody
  };

  if (req.file) {
    mailOptions.attachments = [{
      filename: cleanAttachmentName(req.file.originalname),
      content:  req.file.buffer
    }];
  }

  try {
    const { error } = await resendClient.emails.send(mailOptions);
    if (error) throw new Error(error.message);
    console.log("Email sent");
    res.json({ ok: true });
  } catch (err) {
    console.error("Resend error:", err.message);
    res.status(500).json({ error: "Failed to send email", detail: err.message });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ error: err.message });
  }
  next(err);
});

/* ── HTML escape helper ─────────────────────── */
function escapeHtml(str) {
  return str
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;");
}

/* ══════════════════════════════════════════════
   PIN BRUTE-FORCE PROTECTION
   ─────────────────────────────────────────────
   Per-IP tracking:
     - up to MAX_ATTEMPTS wrong PINs before lockout
     - lockout duration: LOCKOUT_MS
     - successful join clears the counter for that IP
     - entries pruned every minute to prevent memory growth
══════════════════════════════════════════════ */

const MAX_ATTEMPTS = 3;
const LOCKOUT_MS   = 30_000;  // 30 seconds

// ip → { count: number, lockedUntil: timestamp }
const joinAttempts = new Map();

/**
 * Returns { allowed: true } or { allowed: false, remaining: seconds }.
 */
function rateLimitCheck(ip) {
  const now   = Date.now();
  const entry = joinAttempts.get(ip);
  if (!entry) return { allowed: true };

  if (entry.lockedUntil && entry.lockedUntil > now) {
    return { allowed: false, remaining: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  // Lockout expired — reset
  if (entry.lockedUntil && entry.lockedUntil <= now) {
    joinAttempts.delete(ip);
    return { allowed: true };
  }
  return { allowed: true };
}

/**
 * Records a failed PIN attempt. Returns remaining attempts before lockout.
 * Returns 0 when just locked out.
 */
function rateLimitFail(ip) {
  const entry = joinAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count++;
  const remaining = MAX_ATTEMPTS - entry.count;
  if (remaining <= 0) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    console.log(`Rate-limited IP ${ipLogId(ip)} for ${LOCKOUT_MS / 1000}s`);
  }
  joinAttempts.set(ip, entry);
  return Math.max(0, remaining);
}

/** Clears rate-limit state on successful join. */
function rateLimitClear(ip) {
  joinAttempts.delete(ip);
}

/* Prune expired entries every 60s */
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of joinAttempts) {
    if (!entry.lockedUntil || entry.lockedUntil <= now) joinAttempts.delete(ip);
  }
}, 60_000);

/* ══════════════════════════════════════════════
   WEBSOCKET — signaling
══════════════════════════════════════════════ */

const sessions = new Map();
const SESSION_ID_MAX = 80;
const SESSION_ID_PATTERN = /^[\p{L}\p{N} _.:~-]+$/u;

function isValidSessionId(sessionId) {
  return typeof sessionId === "string" &&
    sessionId.trim() === sessionId &&
    sessionId.length > 0 &&
    sessionId.length <= SESSION_ID_MAX &&
    SESSION_ID_PATTERN.test(sessionId);
}

function sessionLogId(sessionId) {
  return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 10);
}

function ipLogId(ip) {
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 10);
}

function publicSessions() {
  return Array.from(sessions)
    .filter(([, s]) => !s.guest)
    .map(([sessionId, s]) => ({ sessionId, createdAt: s.createdAt }));
}

function generatePin() {
  return String(crypto.randomInt(100000, 1000000));
}

function generateToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function broadcastSessionList() {
  const list = publicSessions();

  const msg = JSON.stringify({ type: "session-list", sessions: list });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function cleanupClient(ws) {
  for (const [sessionId, session] of sessions) {
    if (session.host === ws || session.guest === ws) {
      const other = session.host === ws ? session.guest : session.host;
      if (other && other.readyState === WebSocket.OPEN) {
        other.send(JSON.stringify({ type: "peer-disconnected" }));
      }
      sessions.delete(sessionId);
      console.log(`Session ${sessionLogId(sessionId)} removed`);
      broadcastSessionList();
    }
  }
}

function relayToOther(ws, sessionId, payload) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (ws !== session.host && ws !== session.guest) return;
  const other = ws === session.host ? session.guest : session.host;
  if (other && other.readyState === WebSocket.OPEN) {
    other.send(JSON.stringify(payload));
  }
}

wss.on("connection", (ws, req) => {
  /* Resolve real client IP (works behind Render's proxy) */
  const clientIp =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";

  ws.clientIp = clientIp;
  console.log(`Client connected ${ipLogId(clientIp)} | sessions: ${sessions.size}`);

  ws.on("close", () => { console.log(`Client disconnected ${ipLogId(clientIp)}`); cleanupClient(ws); });
  ws.on("error", (e) => { console.error("WS error:", e); cleanupClient(ws); });

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    console.log(`MSG ${ipLogId(clientIp)}: ${data.type}`);

    switch (data.type) {

      /* ── List sessions ──────────────────────── */
      case "list-sessions": {
        ws.send(JSON.stringify({ type: "session-list", sessions: publicSessions() }));
        break;
      }

      /* ── Create session ─────────────────────── */
      case "create-session": {
        if (!isValidSessionId(data.sessionId)) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid session name" }));
          break;
        }
        if (sessions.has(data.sessionId)) {
          ws.send(JSON.stringify({ type: "error", message: "Session name is already in use" }));
          break;
        }
        const pin   = generatePin();
        const token = generateToken();
        sessions.set(data.sessionId, {
          host: ws, guest: null, offer: null,
          pin, token, createdAt: Date.now()
        });
        ws.send(JSON.stringify({ type: "session-created", sessionId: data.sessionId, pin, token }));
        broadcastSessionList();
        console.log(`Session ${sessionLogId(data.sessionId)} created`);
        break;
      }

      /* ── Join session ───────────────────────── */
      case "join-session": {
        const ip = ws.clientIp;

        /* 1. Rate-limit check */
        const rl = rateLimitCheck(ip);
        if (!rl.allowed) {
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "rate-limited",
            remaining: rl.remaining,
            message: `Too many attempts. Try again in ${rl.remaining}s.`
          }));
          break;
        }

        /* 2. Session lookup */
        const session = sessions.get(data.sessionId);
        if (!session) {
          console.log(`Session lookup failed from ${ipLogId(ip)}`);
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "not-found",
            message: "Session not found — it may have expired."
          }));
          break;
        }

        /* 3. Already full */
        if (session.guest) {
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "full",
            message: "Session is full"
          }));
          break;
        }

        /* 4. Auth: valid PIN or valid token */
        const pinOk   = typeof data.pin === "string" && /^\d{6}$/.test(data.pin) && session.pin === data.pin;
        const tokenOk = data.token && session.token === data.token;

        if (!pinOk && !tokenOk) {
          const left = rateLimitFail(ip);
          if (left === 0) {
            ws.send(JSON.stringify({
              type: "pin-error",
              code: "rate-limited",
              remaining: Math.ceil(LOCKOUT_MS / 1000),
              message: `Too many attempts. Try again in ${Math.ceil(LOCKOUT_MS / 1000)}s.`
            }));
          } else {
            ws.send(JSON.stringify({
              type: "pin-error",
              code: "wrong-pin",
              attemptsLeft: left,
              message: `Wrong PIN. ${left} attempt(s) remaining.`
            }));
          }
          break;
        }

        /* 5. Success — clear rate limit, admit guest */
        rateLimitClear(ip);
        session.guest = ws;
        ws.send(JSON.stringify({ type: "session-joined", sessionId: data.sessionId }));
        if (session.host?.readyState === WebSocket.OPEN) {
          session.host.send(JSON.stringify({ type: "guest-joined", sessionId: data.sessionId }));
        }
        broadcastSessionList();
        console.log(`Session ${sessionLogId(data.sessionId)} guest joined from ${ipLogId(ip)}`);
        break;
      }

      /* ── WebRTC signaling ───────────────────── */
      case "offer": {
        const session = sessions.get(data.sessionId);
        if (!session) break;
        if (ws !== session.host) break;
        session.offer = data.offer;
        if (session.guest?.readyState === WebSocket.OPEN) {
          session.guest.send(JSON.stringify({ type: "offer", offer: data.offer }));
        }
        break;
      }

      case "answer":             relayToOther(ws, data.sessionId, { type: "answer",             answer:    data.answer });    break;
      case "ice-candidate":      relayToOther(ws, data.sessionId, { type: "ice-candidate",      candidate: data.candidate }); break;
      case "renegotiate-offer":  relayToOther(ws, data.sessionId, { type: "renegotiate-offer",  offer:     data.offer });    break;
      case "renegotiate-answer": relayToOther(ws, data.sessionId, { type: "renegotiate-answer", answer:    data.answer });   break;
      case "call-offer":         relayToOther(ws, data.sessionId, { type: "call-offer",         offer:     data.offer, withVideo: data.withVideo }); break;
      case "call-answer":        relayToOther(ws, data.sessionId, { type: "call-answer",        answer:    data.answer }); break;
      case "call-ice":           relayToOther(ws, data.sessionId, { type: "call-ice",           candidate: data.candidate }); break;

      case "leave-session": cleanupClient(ws); break;

      case "ping": /* keep-alive, no-op */ break;

      default: console.log("Unknown msg type:", data.type);
    }
  });
});

/* ── Stale session pruner (10 min, host-only) ── */
setInterval(() => {
  const TEN_MIN = 10 * 60 * 1000;
  const now = Date.now();
  let pruned = 0;
  for (const [id, s] of sessions) {
    if (!s.guest && now - s.createdAt > TEN_MIN) {
      // Notify host if still connected
      if (s.host?.readyState === WebSocket.OPEN) {
        s.host.send(JSON.stringify({ type: "peer-disconnected" }));
      }
      sessions.delete(id);
      pruned++;
    }
  }
  if (pruned) { console.log(`Pruned ${pruned} stale session(s)`); broadcastSessionList(); }
}, 60_000);

/* ── Start ─────────────────────────────────── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
