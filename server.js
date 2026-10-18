/*
  ─────────────────────────────────────────────
  Direct Connection — server.js
  Features:
  - Session create with 6-digit PIN, or open (no PIN, first guest in)
  - Session list broadcast
  - PIN verification on join
  - Offer / answer / ICE relay
  - Renegotiation offer/answer relay
  - (no call relay: call signalling travels end-to-end encrypted, peer to peer)
  - Peer disconnect notification
  - A code room outlives its guest: the seat is freed and the host told
  - A waiting room outlives its host's dropped link for HOST_AWAY_MS; the host
    takes it back with its host key (reclaim-session)
  - So does a chat, either side's link: the host takes its seat back with its
    host key, the guest with its guest key (rejoin-session); the other side
    hears peer-away / peer-back, and repair-request passes between them
  - At most UPLOADS_AT_ONCE leave-a-message uploads read at a time
  - Session cleanup on disconnect
  - WebSocket heartbeat (30s ping/pong) drops clients that vanished silently
  - Stale session pruner (10 min)
  - PIN brute-force protection (3 attempts → 30s lockout per IP)
  - Per-room failed join throttling (mitigates distributed PIN guessing)
  - A correct invite token is not held to either lock (see joinVerdict)
  - One room per socket; every room message names its room
  - WebSocket Origin allowlist (same as CORS)
  - list-sessions / create-session rate limits per IP
  - POST /api/send-message (Resend + optional file attachment; requires X-DC-Client header)
  - Optional PUBLIC_SESSION_LIST=0 to hide active room names from the lobby
  ─────────────────────────────────────────────

  Render environment variables required:
    RESEND_API_KEY  Resend API key
    MAIL_TO         recipient email address

  Optional:
    ALLOWED_ORIGINS       Comma-separated browser origins (must include your static site origin)
    PUBLIC_SESSION_LIST   Set to "0" to never expose other users' room names in the lobby
    HEARTBEAT_MS          Ping sweep interval, 1000–300000 (default 30000)
    HOST_AWAY_MS          How long a seat is kept for a side whose link dropped —
                          a waiting room's host, either side of a chat —
                          1000–3600000 (default 600000)
*/

"use strict";

const express    = require("express");
const http       = require("http");
const crypto     = require("crypto");
const path       = require("path");
const fs         = require("fs");
const WebSocket  = require("ws");
const multer     = require("multer");
const { Resend } = require("resend");

/* Policy lives in csp.js so the header here and the meta tag in index.html
   cannot drift apart unnoticed. See that file before editing either. */
const {
  buildCsp, DEFAULT_ALLOWED_ORIGINS, META_CSP, META_TAG_PATTERN
} = require("./csp");

/* Every rate limit below keys on the client address, so it is only as strong
   as this is hard to forge. See clientip.js. */
const { getClientIp, isLoopbackIp, TRUSTED_PROXY_HOPS } = require("./clientip");

/* Sliding-window counters and log sanitising — small, pure, and tested
   directly rather than through a running server. See ratelimit.js. */
const { slidingAllow, pruneExpired, safeLabel, joinVerdict } = require("./ratelimit");

const app    = express();
const server = http.createServer(app);

const PUBLIC_SESSION_LIST = process.env.PUBLIC_SESSION_LIST !== "0";

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

const API_CLIENT_HEADER = "x-dc-client";
const API_CLIENT_VALUE  = "1";

/* Which build of the client this server shipped with. Read out of app.js, which
   is where tools/sync-build.js writes it, so there is one copy and no way for
   the two to disagree. Every socket is told this on connecting; a page that
   finds it is older fetches the new one. Null if app.js has no well-formed id —
   then nothing is announced and nothing reloads. */
const CLIENT_BUILD = (() => {
  try {
    const src = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
    return (src.match(/^const APP_BUILD = "(\d{12}-[0-9a-f]{8})";/m) || [])[1] || null;
  } catch (_) {
    return null;
  }
})();

/* For pages older than the handshake above. They cannot update themselves and
   do not know to listen for a build id — but they do show the text of any
   "error" the server sends, so that is how they get told. Sent once per
   connection, to a socket that asks for the room list without having said
   hello first, which every such page does the moment it connects. Safe to
   delete once those pages are gone; none survives being closed. */
const RELOAD_NOTICE =
  "Шинэ хувилбар гарлаа — хуудсаа хааж дахин нээнэ үү. · A new version is out — please close and reopen this page.";

function nudgePageTooOldToUpdateItself(ws) {
  if (ws.saidHello || ws.nudged) return;
  ws.nudged = true;
  ws.send(JSON.stringify({ type: "error", message: RELOAD_NOTICE }));
}

/* Built once — ALLOWED_ORIGINS cannot change while the process is running. */
const CSP_HEADER = buildCsp(ALLOWED_ORIGINS, { asHeader: true });

/* index.html carries its own copy of the policy for the static (GitHub Pages)
   deployment, which cannot set headers. Nothing at runtime keeps the two in
   step, so say so loudly rather than letting the static build ship a stale one. */
function warnIfCspDrifted() {
  try {
    const html  = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const match = html.match(META_TAG_PATTERN);
    if (!match) {
      console.warn("CSP: index.html has no Content-Security-Policy meta tag");
    } else if (match[2] !== META_CSP) {
      console.warn("CSP: index.html meta tag has drifted from csp.js — run `npm run sync-csp`");
    }
  } catch (err) {
    console.warn(`CSP: could not verify index.html — ${err.message}`);
  }
}


/** WebSocket upgrade: Origin must match allowlist (browsers always send Origin). */
function isAllowedWebSocketOrigin(req) {
  if (!ALLOWED_ORIGINS.length) return false;
  const origin = req.headers.origin;
  if (origin) return ALLOWED_ORIGINS.includes(origin);
  /* Non-browser clients have no Origin; allow loopback only in development. */
  const ip = getClientIp(req);
  if (process.env.NODE_ENV === "production") return false;
  return isLoopbackIp(ip);
}

const wss = new WebSocket.Server({
  server,
  maxPayload: 1024 * 1024,
  verifyClient: (info, cb) => {
    cb(isAllowedWebSocketOrigin(info.req));
  }
});

/* ── Resend client ─────────────────────────── */
let resend = null;

function getResendClient() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

/* ── Leave-a-message attachment (Resend caps whole email ~40MB after Base64) ── */
const LEAVE_MESSAGE_MAX_FILE_BYTES = (() => {
  const cap   = 35 * 1024 * 1024;
  const def   = 28 * 1024 * 1024;
  const parsed = parseInt(process.env.LEAVE_ATTACH_MAX_BYTES || "", 10);
  if (Number.isFinite(parsed) && parsed >= 1024 * 1024 && parsed <= cap) return parsed;
  return def;
})();

/* ── Multer — store file in memory ── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LEAVE_MESSAGE_MAX_FILE_BYTES }
});

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP_HEADER);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${API_CLIENT_HEADER}`);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get(["/app.js", "/protocol.js", "/i18n.js", "/framebust.js", "/connstats.js", "/guards.js", "/pake.js", "/vendor/noble.js", "/style.css",
         "/manifest.webmanifest", "/icons/icon.svg", "/icons/apple-touch-icon.png",
         "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png",
         "/icons/link-preview.png"], (req, res) => {
  res.sendFile(path.join(__dirname, req.path.slice(1)));
});

/* ── Ping endpoint — used by client to wake server ── */
app.get("/api/ping", (req, res) => res.json({
  ok: true,
  maxLeaveAttachBytes: LEAVE_MESSAGE_MAX_FILE_BYTES
}));

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

/* Express 4 does not await route handlers, so a rejected promise becomes an
   unhandled rejection and Node terminates the process — taking every open room
   and every call in progress with it. One malformed request could do it. Route
   every async handler through here so a throw becomes a 500 instead. */
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/* ── Gatekeepers, deliberately ahead of multer ──
   multer buffers the whole upload into memory before the handler runs, so any
   check placed after it has already let an unauthenticated stranger spend
   LEAVE_MESSAGE_MAX_FILE_BYTES of RAM. Both checks below are cheap, header-only
   and settle the request before a byte of body is read. Order matters here —
   keep them in front of upload.single(). */

/** Non-simple header forces CORS preflight; simple cross-site forms cannot set it. */
function requireClientHeader(req, res, next) {
  if ((req.headers[API_CLIENT_HEADER] || "") !== API_CLIENT_VALUE) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

/* At most this many uploads are read at once. multer holds each in memory —
   up to LEAVE_MESSAGE_MAX_FILE_BYTES — and the rate limit below is per
   address, so nothing else bounded how many arrive together: a handful of
   large ones from a few addresses could exhaust the instance's memory, and
   the restart would drop every live chat. One past the limit is turned away
   before a byte of its body is read, and does not count against its sender's
   allowance — it was the server that was busy, not them. */
const UPLOADS_AT_ONCE = 2;
let uploadsInFlight = 0;

function limitConcurrentUploads(req, res, next) {
  if (uploadsInFlight >= UPLOADS_AT_ONCE) {
    res.setHeader("Retry-After", "10");
    return res.status(503).json({ error: "The server is busy — try again in a moment." });
  }
  uploadsInFlight++;
  let released = false;
  const release = () => { if (!released) { released = true; uploadsInFlight--; } };
  res.on("finish", release);     // answered
  res.on("close", release);      // or the connection went first
  next();
}

function enforceEmailRateLimit(req, res, next) {
  const limit = checkEmailRateLimit(getClientIp(req));
  if (!limit.allowed) {
    return res.status(429).json({ error: `Too many messages. Try again in ${limit.remaining}s.` });
  }
  next();
}

app.post("/api/send-message",
  requireClientHeader,
  limitConcurrentUploads,
  enforceEmailRateLimit,
  upload.single("file"),
  asyncRoute(async (req, res) => {

  /* multer fills req.body only for multipart requests and leaves it undefined
     for anything else, and no body parser is mounted. The client always sends
     FormData, so a missing body is a malformed request — it must fall through
     to the "Message is required" check below, not throw. */
  const { message, name } = req.body || {};

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
}));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      const mb = Math.round(LEAVE_MESSAGE_MAX_FILE_BYTES / 1024 / 1024);
      return res.status(413).json({ error: `File is too large (max about ${mb} MB).` });
    }
    return res.status(400).json({ error: err.message });
  }
  /* Anything reaching here is a bug in a handler. Answer generically rather
     than calling next(err): Express's default handler replies with the stack
     trace unless NODE_ENV is production, which is not guaranteed to be set. */
  console.error("Unhandled request error:", (err && err.stack) || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Server error" });
});

/* ── HTML escape helper ─────────────────────── */
function escapeHtml(str) {
  return str
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
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

/** Per-IP failed join (wrong PIN/token). ip → { count, lockedUntil, lastFailAt } */
const joinAttempts = new Map();

const SESSION_JOIN_FAIL_WINDOW_MS = 10 * 60 * 1000; // 10 min
const SESSION_JOIN_FAIL_MAX       = 15;           // failures from any IP before room lock
const SESSION_JOIN_LOCK_MS        = 5 * 60 * 1000;  // 5 min room-level join lock

/**
 * Returns { allowed: true } or { allowed: false, remaining: seconds }.
 */
function rateLimitCheck(ip) {
  const now = Date.now();
  const entry = joinAttempts.get(ip);
  if (!entry) return { allowed: true };
  if (entry.lockedUntil && entry.lockedUntil > now) {
    return { allowed: false, remaining: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

/**
 * Records a failed PIN attempt. Returns remaining attempts before lockout.
 * Returns 0 when just locked out.
 */
function rateLimitFail(ip) {
  const now = Date.now();
  const entry = joinAttempts.get(ip) || { count: 0, lockedUntil: 0, lastFailAt: now };
  entry.lastFailAt = now;
  entry.count++;
  const remaining = MAX_ATTEMPTS - entry.count;
  if (remaining <= 0) {
    entry.lockedUntil = now + LOCKOUT_MS;
    console.log(`Rate-limited IP ${ipLogId(ip)} for ${LOCKOUT_MS / 1000}s`);
  }
  joinAttempts.set(ip, entry);
  return Math.max(0, remaining);
}

/** Clears rate-limit state on successful join. */
function rateLimitClear(ip) {
  joinAttempts.delete(ip);
}

/* Prune stale per-IP join state (do not wipe in-progress counters). */
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of joinAttempts) {
    if (entry.lockedUntil && entry.lockedUntil > now) continue;
    if (entry.lockedUntil && entry.lockedUntil <= now) {
      joinAttempts.delete(ip);
      continue;
    }
    if (!entry.lockedUntil && entry.lastFailAt && now - entry.lastFailAt > 60 * 60 * 1000) {
      joinAttempts.delete(ip);
    }
  }
}, 60_000);

/* ══════════════════════════════════════════════
   WEBSOCKET — signaling
══════════════════════════════════════════════ */

const sessions = new Map();

/* ── A host whose link drops ─────────────────
   To send the link, the host switches to a messaging app; the phone pauses
   the page, and an iPhone cuts its link to the server almost at once. The room
   used to be deleted on the spot, so the link the friend received was dead by
   the time they tapped it. A room still waiting for its guest is now kept for
   HOST_AWAY_MS with no host, and the host takes it back on returning by
   presenting its host key — a secret only the host's page was given, never put
   in a link (reclaim-session). Leaving on purpose still closes it at once. */
const HOST_AWAY_MS = (() => {
  const parsed = parseInt(process.env.HOST_AWAY_MS || "", 10);
  if (Number.isFinite(parsed) && parsed >= 1000 && parsed <= 3_600_000) return parsed;
  return 10 * 60 * 1000;
})();

/** The host's link dropped and it has not come back in time. */
function hostAwayExpired(session, now = Date.now()) {
  return !session.host && now - session.hostAwaySince > HOST_AWAY_MS;
}

/* ── A seat kept for a page whose link dropped ──
   Reported, assessing why calls did not survive a phone changing networks:
   a room was deleted the moment either side's link to this server dropped
   mid-chat, and nothing could bring it back. Every repair of the chat's own
   link goes through the room, so after that blink nothing could be repaired.

   Now a dropped link — a network change, a locked screen, a blip — keeps the
   seat for the page to take back (rejoin-session for a guest, with the guest
   key it was given on joining; reclaim-session for a host, with its host key,
   as a waiting room's host already could). The other side is told
   (peer-away / peer-back), so it waits for the way to be repaired rather than
   giving up. Leaving on purpose (leave-session) still ends the room at once.
   A seat nobody comes back for goes after HOST_AWAY_MS, as before. */
function markAway(sessionId, session, side) {
  const now = Date.now();
  if (side === "host") { session.host = null;  session.hostAwaySince  = now; }
  else                 { session.guest = null; session.guestAwaySince = now; }
  const timer = `${side}AwayTimer`;
  clearTimeout(session[timer]);
  session[timer] = setTimeout(() => expireAway(sessionId, side), HOST_AWAY_MS + 100);
  if (session[timer].unref) session[timer].unref();
}

/** Nobody came back for the seat: the room goes — or, for a code room's
    guest, the seat opens to the next person, as when a guest leaves one. */
function expireAway(sessionId, side) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (side === "host" ? (session.host || !session.hostAwaySince) : (session.guest || !session.guestAwaySince)) return;   // came back
  if (side === "host") { dropSession(sessionId, session); broadcastSessionList(); return; }
  session.guestAwaySince = 0;
  session.guestKey = null;
  if (session.kind === "code" && session.host) { session.paired = false; freeGuestSeat(sessionId, session); return; }
  if (session.host && session.host.readyState === WebSocket.OPEN) {
    session.host.send(JSON.stringify({ type: "peer-disconnected", sessionId }));
  }
  clearTimeout(session.hostAwayTimer);
  sessions.delete(sessionId);
  console.log(`Session ${sessionLogId(sessionId)} removed — its guest did not come back`);
  broadcastSessionList();
}

/** Tells whoever is still there that the other side's link is back, or gone for now. */
function tellOther(session, from, type, sessionId) {
  const other = from === "host" ? session.guest : session.host;
  if (other && other.readyState === WebSocket.OPEN) other.send(JSON.stringify({ type, sessionId }));
}

/** Deletes a room, telling its guest if there is one. */
function dropSession(sessionId, session) {
  if (session.guest && session.guest.readyState === WebSocket.OPEN) {
    session.guest.send(JSON.stringify({ type: "peer-disconnected", sessionId }));
  }
  clearTimeout(session.hostAwayTimer);
  clearTimeout(session.guestAwayTimer);
  sessions.delete(sessionId);
  console.log(`Session ${sessionLogId(sessionId)} removed`);
}
/** Unknown message types logged per socket before going quiet. */
const UNKNOWN_TYPE_LOG_MAX = 5;
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
  if (!PUBLIC_SESSION_LIST) return [];
  return Array.from(sessions)
    .filter(([, s]) => !s.guest && !s.guestAwaySince && !hostAwayExpired(s))   // a seat kept for a guest is not free
    /* `open` lets the lobby show which rooms can be entered without a PIN, and
       skip the PIN dialog for them. It gives nothing away: the server answers
       the same question for anyone who tries the door. */
    .map(([sessionId, s]) => ({ sessionId, createdAt: s.createdAt, open: s.open === true, kind: s.kind || "pin" }));
}

const listSessionsHits   = new Map();
const createSessionHits  = new Map();
const LIST_SESSIONS_WINDOW_MS  = 60_000;
const LIST_SESSIONS_MAX        = 40;
const CREATE_SESSION_WINDOW_MS = 10 * 60 * 1000;
const CREATE_SESSION_MAX       = 10;

/* joinAttempts and emailAttempts each have a sweep above; these two were
   missed, and without one they keep an entry per address seen since startup.
   See ratelimit.js — pruneExpired explains why slidingAllow cannot do it. */
setInterval(() => {
  pruneExpired(listSessionsHits, LIST_SESSIONS_WINDOW_MS);
  pruneExpired(createSessionHits, CREATE_SESSION_WINDOW_MS);
}, 60_000);

function recordSessionJoinFailure(sessionId, session) {
  const now = Date.now();
  if (!session.failedJoinWindowStart || now - session.failedJoinWindowStart > SESSION_JOIN_FAIL_WINDOW_MS) {
    session.failedJoinWindowStart = now;
    session.failedJoinCount = 0;
  }
  session.failedJoinCount++;
  if (session.failedJoinCount >= SESSION_JOIN_FAIL_MAX) {
    session.joinLockedUntil = now + SESSION_JOIN_LOCK_MS;
    console.log(`Session ${sessionLogId(sessionId)} join-locked ${SESSION_JOIN_LOCK_MS / 1000}s`);
  }
}

function generatePin() {
  return String(crypto.randomInt(100000, 1000000));
}

function generateToken() {
  return crypto.randomBytes(24).toString("base64url");
}

/** Compares a PIN or token in constant time. A correct token is admitted even
    while the join locks are on (see joinVerdict), so nothing limits how often
    one may be tried — which makes this a comparison that must not leak how
    close a wrong value came. */
function secretMatches(expected, supplied) {
  /* An open room has no PIN at all — `expected` is null there, and null must
     match nothing rather than throw. */
  if (typeof expected !== "string" || typeof supplied !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function broadcastSessionList() {
  const list = publicSessions();

  const msg = JSON.stringify({ type: "session-list", sessions: list });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

/* Every message about a room says which room. A client that could not tell had
   to assume its current one, and was wrong whenever it had moved on. */

/** Removes every room this socket is part of and tells whoever is left in it.
    Also what enforces one room per socket: creating or joining calls it first. */
function cleanupClient(ws, { dropped = false } = {}) {
  for (const [sessionId, session] of sessions) {
    /* The host's link dropped — not a leave: keep the room, for the host to
       take back (see HOST_AWAY_MS). A room still waiting for its guest always
       was kept; one with a chat in it now is too, and the guest is told. */
    if (dropped && session.host === ws) {
      markAway(sessionId, session, "host");
      if (session.paired) tellOther(session, "host", "peer-away", sessionId);
      console.log(`Session ${sessionLogId(sessionId)} host away`);
      continue;
    }
    /* A guest in a chat whose link dropped: its seat is kept for it to take
       back with its guest key, and the host is told. */
    if (dropped && session.guest === ws && session.paired) {
      markAway(sessionId, session, "guest");
      tellOther(session, "guest", "peer-away", sessionId);
      console.log(`Session ${sessionLogId(sessionId)} guest away`);
      continue;
    }
    /* A guest leaving a room whose host is away: nobody to tell, and the room
       is still the host's — free the seat. */
    if (session.guest === ws && !session.host) {
      session.guest = null;
      session.paired = false;
      session.guestKey = null;
      session.waitingSince = Date.now();
      broadcastSessionList();
      continue;
    }
    /* A code room outlives its guest. Admission to one is first-come — the
       word is proven afterwards, between the two browsers — so anyone can take
       the seat, and leaving used to delete the room: one wrong guess, or one
       stranger joining and leaving, and the room was gone, the right word with
       it. Now the seat is freed and the host told; the host knows whether a
       chat just ended or an attempt failed, and says which (guest-left). */
    if (session.kind === "code" && session.guest === ws) {
      freeGuestSeat(sessionId, session);
      continue;
    }
    if (session.host === ws || session.guest === ws) {
      const other = session.host === ws ? session.guest : session.host;
      if (other && other.readyState === WebSocket.OPEN) {
        other.send(JSON.stringify({ type: "peer-disconnected", sessionId }));
      }
      sessions.delete(sessionId);
      console.log(`Session ${sessionLogId(sessionId)} removed`);
      broadcastSessionList();
    }
  }
}

/** Empties a code room's seat and opens it to the next guest. The host is
    told; the guest, if still connected, already knows — it left, or was
    turned away (release-guest). */
function freeGuestSeat(sessionId, session) {
  session.guest = null;
  session.paired = false;
  session.guestKey = null;
  session.guestAwaySince = 0;
  clearTimeout(session.guestAwayTimer);
  session.waitingSince = Date.now();     // the ten minutes to find a guest start again
  if (session.host && session.host.readyState === WebSocket.OPEN) {
    session.host.send(JSON.stringify({ type: "guest-left", sessionId }));
  }
  broadcastSessionList();
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
  const clientIp = getClientIp(req);

  ws.clientIp = clientIp;
  /* Heartbeat state — reset by every pong; see the sweep below. Browsers answer
     protocol-level pings automatically, so no client-side change is needed. */
  ws.isAlive  = true;
  ws.on("pong", () => { ws.isAlive = true; });
  console.log(`Client connected ${ipLogId(clientIp)} | sessions: ${sessions.size}`);

  /* Said first, on every connection — including the reconnect every open page
     makes a few seconds after this process restarts for an update. That is the
     moment a page left open finds out it is old. */
  if (CLIENT_BUILD) ws.send(JSON.stringify({ type: "hello", build: CLIENT_BUILD }));

  ws.on("close", () => { console.log(`Client disconnected ${ipLogId(clientIp)}`); cleanupClient(ws, { dropped: true }); });
  ws.on("error", (e) => { console.error("WS error:", e); cleanupClient(ws, { dropped: true }); });

  /* Nothing catches what a "message" listener throws: it becomes an uncaught
     exception and Node ends the process, taking every room and every call with
     it. The four characters `null` did exactly that — see handleMessage. This
     is the backstop for whichever input nobody has thought of yet, the same job
     asyncRoute() does for the HTTP side. */
  ws.on("message", (raw) => {
    try {
      handleMessage(raw);
    } catch (err) {
      console.error(`Message handler error for ${ipLogId(clientIp)}:`, (err && err.stack) || err);
    }
  });

  function handleMessage(raw) {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    /* Parsing succeeding does not make it a message. `null`, `7`, `"x"` and
       `[]` are all valid JSON, and reading `.type` off null throws. */
    if (data === null || typeof data !== "object" || Array.isArray(data)) return;
    console.log(`MSG ${ipLogId(clientIp)}: ${safeLabel(data.type)}`);

    switch (data.type) {

      /* ── List sessions ──────────────────────── */
      case "list-sessions": {
        if (!slidingAllow(listSessionsHits, clientIp, LIST_SESSIONS_MAX, LIST_SESSIONS_WINDOW_MS)) {
          ws.send(JSON.stringify({ type: "session-list", sessions: [], throttled: true }));
          break;
        }
        ws.send(JSON.stringify({ type: "session-list", sessions: publicSessions() }));
        nudgePageTooOldToUpdateItself(ws);
        break;
      }

      /* A current page introducing itself. The build it names is not used for
         anything — saying hello at all is the signal. */
      case "hello":
        ws.saidHello = true;
        break;

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
        if (!slidingAllow(createSessionHits, clientIp, CREATE_SESSION_MAX, CREATE_SESSION_WINDOW_MS)) {
          ws.send(JSON.stringify({ type: "error", message: "Too many rooms created from this network. Try again later." }));
          break;
        }
        /* One room per socket. A browser that opened a room and then opened
           another used to keep hosting both: the first stayed listed with
           nobody behind it, a guest who joined it waited on a host that was
           elsewhere, and when it expired the notice ended the chat in the
           second. Opening a room now lets go of the previous one. */
        cleanupClient(ws);
        /* Three kinds of room. "pin" is the default and stays the default for
           anything not spelled out — a room must never change kind by accident.
           "open" admits the first person with no secret at all. "code" admits
           the first person too, but the two of them then prove a secret word to
           each other with SPAKE2 (see pake.js); the server never sees that word,
           so for admission a code room behaves exactly like an open one.
           Both open and code get a token, for the invite link. */
        const kind = data.code === true ? "code" : (data.open === true ? "open" : "pin");
        const open = kind === "open" || kind === "code";   // admission: first come
        const pin  = kind === "pin" ? generatePin() : null;
        const token = generateToken();
        const hostKey = generateToken();     // the host's alone: never in a link
        sessions.set(data.sessionId, {
          host: ws, guest: null, offer: null,
          kind, open, pin, token, hostKey, createdAt: Date.now(), hostAwaySince: 0,
          joinLockedUntil: 0,
          failedJoinWindowStart: 0,
          failedJoinCount: 0
        });
        ws.send(JSON.stringify({ type: "session-created", sessionId: data.sessionId, pin, token, hostKey, open, kind }));
        broadcastSessionList();
        console.log(`Session ${sessionLogId(data.sessionId)} created`);
        break;
      }

      /* ── Join session ───────────────────────── */
      case "join-session": {
        const ip = ws.clientIp;

        /* 1. Session lookup — unknown rooms do not affect per-IP join counters */
        {
          const away = sessions.get(data.sessionId);
          if (away && hostAwayExpired(away)) dropSession(data.sessionId, away);
        }
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

        /* 2. Your own room. Its name is in the lobby list like any other, and
           the PIN is on your screen, so this is one click away. It used to be
           admitted, which left one browser negotiating with itself. */
        if (session.host === ws) {
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "own-room",
            message: "This is the room you created."
          }));
          break;
        }

        /* 3. A room-level lock that has run its course */
        if (session.joinLockedUntil && session.joinLockedUntil <= Date.now()) {
          session.joinLockedUntil = 0;
          session.failedJoinCount = 0;
          session.failedJoinWindowStart = 0;
        }

        /* 4. Decide. Which lock applies to which credential is joinVerdict's
           job — see ratelimit.js. The short of it: the locks are there to slow
           PIN guessing, so a correct invite token is not held to them. */
        const rl = rateLimitCheck(ip);
        const tokenOk = secretMatches(session.token, data.token);
        const verdict = joinVerdict({
          open:         session.open === true,
          tokenOk,
          pinOk:        typeof data.pin === "string" && /^\d{6}$/.test(data.pin) && secretMatches(session.pin, data.pin),
          noCredential: typeof data.pin !== "string" && typeof data.token !== "string",
          /* A seat kept for a guest whose link dropped is still taken. */
          full:         Boolean(session.guest) || session.guestAwaySince > 0,
          /* Taken through the link — by another socket. The same socket asking
             twice is not a second copy of anything, and "replacing" it would
             run cleanupClient on the room's own guest and delete the room. */
          seatByLink:   session.guestByLink === true && session.guest !== ws,
          /* Whether anyone is looking at the page asking. Only such a copy may
             take a seat from another — see joinVerdict. */
          visible:      data.visible === true,
          roomLocked:   session.joinLockedUntil > Date.now(),
          ipLimited:    !rl.allowed
        });

        /* Arrived with nothing to show, at a room that wants a PIN. Not a guess,
           so nothing is counted — the client just asks for the PIN. */
        if (verdict === "pin-required") {
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "pin-required",
            sessionId: data.sessionId,
            message: "This room needs a PIN."
          }));
          break;
        }

        if (verdict === "room-locked") {
          const rem = Math.ceil((session.joinLockedUntil - Date.now()) / 1000);
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "session-join-locked",
            remaining: rem,
            message: `Too many failed join attempts for this room. Try again in ${rem}s.`
          }));
          break;
        }

        if (verdict === "full") {
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "full",
            message: "Session is full"
          }));
          break;
        }

        if (verdict === "held-elsewhere") {
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "held-elsewhere",
            sessionId: data.sessionId,
            message: "This link is open in another browser."
          }));
          break;
        }

        if (verdict === "ip-limited") {
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "rate-limited",
            remaining: rl.remaining,
            message: `Too many attempts. Try again in ${rl.remaining}s.`
          }));
          break;
        }

        if (verdict === "wrong") {
          recordSessionJoinFailure(data.sessionId, session);
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

        /* 5. Admitted — clear the limits and let go of any room this socket was
           already in. One room per socket; see create-session. */
        rateLimitClear(ip);
        cleanupClient(ws);
        session.joinLockedUntil = 0;
        session.failedJoinCount = 0;
        session.failedJoinWindowStart = 0;
        /* The same link, opened again in another browser: the seat moves to
           the newer copy. The room is kept — the guest has not left, only
           changed browsers — and the copy left behind is told, so it stops
           rather than joining again and taking the seat back. Once it is no
           longer the guest, its socket closing ends nothing. */
        const replaced = verdict === "replace" ? session.guest : null;
        session.guest = ws;
        session.guestByLink = tokenOk;
        /* A seat kept for a copy whose link had dropped is taken over too:
           that copy's key no longer brings it back. */
        session.guestAwaySince = 0;
        clearTimeout(session.guestAwayTimer);
        /* This guest's alone, to take the seat back with if its link drops —
           never in a link, never shown. */
        session.guestKey = generateToken();
        if (replaced && replaced.readyState === WebSocket.OPEN) {
          replaced.send(JSON.stringify({ type: "seat-taken", sessionId: data.sessionId }));
        }
        /* A host who is away hears of the guest when it takes the room back;
           the guest is told to wait meanwhile. */
        const hostHere = session.host?.readyState === WebSocket.OPEN;
        session.paired = hostHere;          // the host knows this guest: a chat, not a wait
        ws.send(JSON.stringify({ type: "session-joined", sessionId: data.sessionId, hostAway: !hostHere, guestKey: session.guestKey }));
        if (hostHere) {
          session.host.send(JSON.stringify({ type: "guest-joined", sessionId: data.sessionId, replaced: verdict === "replace" }));
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

      /* Call signaling deliberately has no relay here: offers, answers and
         candidates travel inside the end-to-end encrypted data channel, so the
         server cannot read or inject them. Do not add one back. */

      case "leave-session": cleanupClient(ws); break;

      /* The host, back after its link dropped, taking its room again. The host
         key proves it: a secret this server gave only the host's page, never in
         a link, so a guest who has the link cannot take the room. A key that
         does not match, or a room no longer kept, is refused alike. */
      case "reclaim-session": {
        const found = sessions.get(data.sessionId);
        if (found && hostAwayExpired(found)) dropSession(data.sessionId, found);
        const session = sessions.get(data.sessionId);
        if (!session || !secretMatches(session.hostKey, data.hostKey)) {
          ws.send(JSON.stringify({ type: "reclaim-failed", sessionId: data.sessionId }));
          break;
        }
        if (session.host !== ws) cleanupClient(ws);    // one room per socket
        /* Back to a chat it was in (the guest was known before the link
           dropped): the chat goes on — nothing is started again, and the guest
           is told the way to repair it is open. Back to a waiting room: as
           before, with any guest who arrived meanwhile introduced now. */
        const resumed = session.paired === true;
        session.host = ws;
        session.hostAwaySince = 0;
        clearTimeout(session.hostAwayTimer);
        if (!resumed) session.waitingSince = Date.now();   // a fresh ten minutes to find a guest
        ws.send(JSON.stringify({
          type: "session-reclaimed", sessionId: data.sessionId,
          pin: session.pin, token: session.token, kind: session.kind, open: session.open,
          guestWaiting: Boolean(session.guest), resumed
        }));
        if (resumed) {
          tellOther(session, "host", "peer-back", data.sessionId);
        } else if (session.guest?.readyState === WebSocket.OPEN) {
          session.guest.send(JSON.stringify({ type: "host-back", sessionId: data.sessionId }));
          ws.send(JSON.stringify({ type: "guest-joined", sessionId: data.sessionId }));
          session.paired = true;
        }
        broadcastSessionList();
        break;
      }

      /* A guest whose link dropped mid-chat, back on a new one, taking its seat
         again with the guest key it was given on joining — which never left
         its page, so nobody else can present it. Its old link may not have
         been noticed as gone yet; the seat is the new one's either way. */
      case "rejoin-session": {
        const session = sessions.get(data.sessionId);
        if (!session || !session.guestKey || !secretMatches(session.guestKey, data.guestKey)) {
          ws.send(JSON.stringify({ type: "rejoin-failed", sessionId: data.sessionId }));
          break;
        }
        if (session.guest !== ws) cleanupClient(ws);   // one room per socket
        session.guest = ws;
        session.guestAwaySince = 0;
        clearTimeout(session.guestAwayTimer);
        const hostHere = session.host?.readyState === WebSocket.OPEN;
        ws.send(JSON.stringify({ type: "session-rejoined", sessionId: data.sessionId, hostAway: !hostHere }));
        if (hostHere) tellOther(session, "guest", "peer-back", data.sessionId);
        break;
      }

      /* The guest asking the host to start a fresh route for their chat — only
         the host makes the offer, so two never cross. Passed on like the
         rest of the repair. */
      case "repair-request": relayToOther(ws, data.sessionId, { type: "repair-request", sessionId: data.sessionId }); break;

      /* The host of a code room turning away a guest whose word did not match,
         so the seat is free for the next attempt — or the right one. Only the
         host, only a code room, and only a seat that is taken. The guest is
         told the way any guest is told its host has gone. */
      case "release-guest": {
        const session = sessions.get(data.sessionId);
        if (!session || session.host !== ws || session.kind !== "code" || !session.guest) break;
        const guest = session.guest;
        if (guest.readyState === WebSocket.OPEN) {
          guest.send(JSON.stringify({ type: "peer-disconnected", sessionId: data.sessionId }));
        }
        session.guest = null;
        session.paired = false;
        session.guestKey = null;          // turned away: its key takes nothing back
        session.waitingSince = Date.now();
        broadcastSessionList();
        break;
      }

      case "ping": /* keep-alive, no-op */ break;

      default:
        /* An unknown type is either an old client or someone probing. Either
           way one socket must not be able to fill the log with novel types. */
        ws.unknownTypeLogs = (ws.unknownTypeLogs || 0) + 1;
        if (ws.unknownTypeLogs <= UNKNOWN_TYPE_LOG_MAX) {
          console.log(`Unknown msg type from ${ipLogId(clientIp)}: ${safeLabel(data.type)}` +
            (ws.unknownTypeLogs === UNKNOWN_TYPE_LOG_MAX ? " (further ones from this client not logged)" : ""));
        }
    }
  }
});

/* ══════════════════════════════════════════════
   HEARTBEAT
   ─────────────────────────────────────────────
   A phone that sleeps or drops off the network never sends a close frame, so
   without this the socket looks connected forever: the room stays occupied,
   its name stays taken, and the surviving peer is never told the other side
   is gone. Ping every client each sweep; a client that did not answer the
   previous sweep is terminated, which fires "close" → cleanupClient().
   Detection takes between one and two sweeps.
══════════════════════════════════════════════ */

const HEARTBEAT_MS = (() => {
  const parsed = parseInt(process.env.HEARTBEAT_MS || "", 10);
  if (Number.isFinite(parsed) && parsed >= 1000 && parsed <= 300_000) return parsed;
  return 30_000;
})();

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      console.log(`Terminating unresponsive client ${ipLogId(ws.clientIp || "unknown")}`);
      ws.terminate();          // fires "close" → cleanupClient frees the session
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { ws.terminate(); }
  });
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

/* ── Stale session pruner (10 min, host-only) ── */
setInterval(() => {
  const TEN_MIN = 10 * 60 * 1000;
  const now = Date.now();
  let pruned = 0;
  for (const [id, s] of sessions) {
    /* A host whose link dropped, kept waiting for: gone once its time is up. */
    if (!s.host) {
      if (hostAwayExpired(s, now)) { dropSession(id, s); pruned++; }
      continue;
    }
    /* A socket already gone but "close" never fired — a backstop. Treated as
       the drop it is: the seat is kept, for its page to take back. */
    if (s.host.readyState !== WebSocket.OPEN) {
      markAway(id, s, "host");
      if (s.paired) tellOther(s, "host", "peer-away", id);
      continue;
    }
    if (s.guest && s.guest.readyState !== WebSocket.OPEN && s.paired) {
      markAway(id, s, "guest");
      tellOther(s, "guest", "peer-away", id);
    }
    if (!s.guest && now - (s.waitingSince || s.createdAt) > TEN_MIN) {
      /* Its own message, not peer-disconnected: there never was a peer. The
         host is in the lobby looking at a PIN and a link, and needs telling
         that both have stopped working — the old message said "peer left" into
         a chat screen that was not showing. */
      if (s.host?.readyState === WebSocket.OPEN) {
        s.host.send(JSON.stringify({ type: "session-expired", sessionId: id }));
      }
      sessions.delete(id);
      pruned++;
    }
  }
  if (pruned) { console.log(`Pruned ${pruned} stale session(s)`); broadcastSessionList(); }
}, 60_000);

/* ── Start ─────────────────────────────────── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  warnIfCspDrifted();
  console.log(`Trusting ${TRUSTED_PROXY_HOPS} proxy hop(s) for client addresses`);
  if (TRUSTED_PROXY_HOPS > 0 && process.env.TRUSTED_PROXY_HOPS === undefined) {
    console.log("  (default: correct behind Render/Fly/Heroku/nginx.");
    console.log("   Set TRUSTED_PROXY_HOPS=0 if this process is exposed directly,");
    console.log("   otherwise clients can forge their address and evade rate limits.)");
  }
  console.log(`Server running on port ${PORT}`);
});
