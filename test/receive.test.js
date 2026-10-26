/*
  Receiving a file, actually run.

  The sending app refused files over 150 MB, and the receiving app trusted it:
  nothing on the receiving side checked a size, and the sender's own type went
  onto the assembled file. But the other side can run a changed app — and in a
  room with no PIN, the other side can be anyone. It could stream data until
  the phone filled up, or send a "picture" typed text/html that, opened from
  the chat, loads as a page from this site.

  These lift the real code out of app.js — sendBinary, handleTransferMeta,
  refuseTransfer, acceptChunk, handleBinaryChunk, assembleTransfer, and the
  transfer cases of the data-channel switch — and run two copies of it against
  each other. The network is a queue that delivers in order on a later tick,
  as a data channel does; the encryption is a pass-through. The limits, the
  checks and the bookkeeping are the shipped code.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const DC     = require("../protocol.js");
const G      = require("../guards.js");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

const fn = name => {
  const m = app.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} not found as a top-level function in app.js`);
  return m[0];
};
const decl = name => {
  const m = app.match(new RegExp(`^(?:const|let)\\s+${name}\\s*=[^\\n]*$`, "m"));
  assert.ok(m, `${name} not declared on one line in app.js`);
  return m[0];
};
/* The transfer cases of the data-channel message switch, as shipped. */
const CASES = (() => {
  const from = app.indexOf('    case "transfer-meta":');
  const to   = app.indexOf('    case "call-request":', from);
  assert.ok(from > 0 && to > from, "transfer cases not found in app.js");
  return app.slice(from, to);
})();

const DECLS = [
  "recvBuffers", "refusedTransfers", "REFUSED_REMEMBERED", "outgoingTransfers",
  "orphanChunks", "orphanChunkCount", "ORPHAN_CHUNK_MAX",
  "CHUNK_SIZE", "MAX_P2P_FILE_BYTES", "INCOMING_BUDGET_BYTES", "MAX_CHUNK_BODY", "DECRYPT_BATCH"
];
const FUNCS = [
  "rememberRefused", "takeOrphanChunks", "newRecvBuffer", "handleTransferMeta", "refuseTransfer",
  "acceptChunk", "handleBinaryChunk", "assembleTransfer", "sendBinary"
];
const SOURCE = [
  ...DECLS.map(decl), ...FUNCS.map(fn),
  `function deliver(data) { switch (data.type) {\n${CASES}\n} }`,
  "return { sendBinary, deliver, chunk: handleBinaryChunk,",
  "  state: () => ({ recvBuffers, refusedTransfers, outgoingTransfers, orphanChunkCount }) };"
].join("\n");

const LIMIT = 150 * 1024 * 1024;

/** One side of a chat: the real transfer code, with the screen and network stood in. */
function side(name) {
  const log = { sys: [], failed: [], shown: [], delivered: [], sent: [], chunksSent: 0, blobs: [], heard: [], noticed: 0 };
  let peer = null;
  const later = f => setImmediate(() => peer && f(peer));
  const env = {
    DC, G, Blob,
    console: { warn() {}, error() {}, log() {} },
    t: key => key,
    appendSys: key => log.sys.push(key),
    failTransfer: (id, key = "transferFailed") => log.failed.push({ id, key }),
    appendFileBubble: (who, url, n, size, id) => log.shown.push({ as: "file", who, id }),
    appendImagePlaceholder: (who, id) => log.shown.push({ as: "image", who, id }),
    appendVoicePlaceholder: (who, id) => log.shown.push({ as: "voice", who, id }),
    resolveImageNow: () => log.shown.push({ as: "image", who: "me" }),
    resolveVoiceNow: () => log.shown.push({ as: "voice", who: "me" }),
    resolveFileBubble: (id, url) => log.delivered.push({ id, as: "file", url }),
    resolveImagePlaceholder: (id, url) => log.delivered.push({ id, as: "image", url }),
    resolveVoicePlaceholder: (id, url) => log.delivered.push({ id, as: "voice", url }),
    reportTransferProgress() {}, setTransferProgress() {}, attachSendProgress() {}, clearSendProgress() {},
    showToast() {}, announce: text => log.heard.push(text), I18N: { en: { fileTooLargeP2P: () => "" } }, LANG: "en",
    noticeArrival: () => { log.noticed++; },
    dcReady: () => true, e2eReady: true,
    makeTransferId: DC.makeTransferId,
    trackBlobUrl: url => url,
    URL: { createObjectURL: blob => { log.blobs.push(blob); return `blob:${name}/${log.blobs.length}`; } },
    e2eEncryptBytes: async buf => ({ iv: new Uint8Array(DC.E2E_BIN_IV_LEN), ct: new Uint8Array(buf) }),
    e2eDecryptBytes: async ct => ct,
    drainBuffer: () => new Promise(r => setImmediate(r)),
    dcSendE2e: async msg => { log.sent.push(msg); later(p => p.deliver(msg)); },
    dataChannel: { send: buf => { log.chunksSent++; later(p => p.chunk(buf)); } }
  };
  const names = Object.keys(env);
  const api = new Function(...names, SOURCE)(...names.map(n => env[n]));
  return { ...api, log, connect: other => { peer = other; } };
}

function pair() {
  const a = side("a"), b = side("b");
  a.connect(b); b.connect(a);
  return { a, b };
}

/** Let every queued message, chunk and decryption run. */
async function settle(rounds = 60) {
  for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r));
}

const bytes = n => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
const packet = (id, body) => DC.packChunk(new TextEncoder().encode(id), new Uint8Array(DC.E2E_BIN_IV_LEN), body).buffer;
const meta = over => ({ type: "transfer-meta", id: DC.makeTransferId(), kind: "file",
                        name: "x.bin", size: 100, mimeType: "application/octet-stream", totalChunks: 1, ...over });
const sameBytes = async (blob, expected) =>
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), expected);

/* ══════════════════════════════════════════
   Honest transfers still arrive
══════════════════════════════════════════ */

test("an honest file arrives whole, and downloads as plain bytes whatever type it claimed", async () => {
  const { a, b } = pair();
  const content = bytes(200_000);   // four chunks
  await a.sendBinary(new File([content], "page.html", { type: "text/html" }), "file");
  await settle();

  assert.deepEqual(b.log.shown.map(s => s.as), ["file"]);
  assert.equal(b.log.delivered.length, 1);
  assert.equal(b.log.blobs[0].type, "application/octet-stream", "not text/html");
  await sameBytes(b.log.blobs[0], content);
  assert.deepEqual(b.log.sys, []);
  assert.deepEqual(b.log.failed, []);
});

test("a real picture arrives as a picture, typed as one", async () => {
  const { a, b } = pair();
  const content = bytes(70_000);
  await a.sendBinary(new File([content], "cat.png", { type: "image/png" }), "image");
  await settle();

  assert.deepEqual(b.log.delivered.map(d => d.as), ["image"]);
  assert.equal(b.log.blobs[0].type, "image/png");
  await sameBytes(b.log.blobs[0], content);
});

test("a voice note arrives as sound", async () => {
  const { a, b } = pair();
  await a.sendBinary(new File([bytes(5_000)], "", { type: "audio/webm;codecs=opus" }), "voice");
  await settle();

  assert.deepEqual(b.log.delivered.map(d => d.as), ["voice"]);
  assert.equal(b.log.blobs[0].type, "audio/webm");
});

test("an SVG picked as a picture is sent as a file, so both sides show a file", async () => {
  const { a, b } = pair();
  await a.sendBinary(new File([bytes(300)], "logo.svg", { type: "image/svg+xml" }), "image");
  await settle();

  assert.equal(a.log.sent[0].kind, "file", "announced as a file");
  assert.deepEqual(a.log.shown.map(s => s.as), ["file"], "the sender's own bubble is a file too");
  assert.deepEqual(b.log.delivered.map(d => d.as), ["file"]);
  assert.equal(b.log.blobs[0].type, "application/octet-stream");
});

/* ══════════════════════════════════════════
   A changed app on the other side
══════════════════════════════════════════ */

test("a 'picture' typed as a web page arrives as a plain download, never as a page", async () => {
  const b = side("b");
  const m = meta({ kind: "image", mimeType: "text/html", size: 20, name: "x.png" });
  const html = new TextEncoder().encode("<script>1</script>xx");
  b.deliver(m);
  b.chunk(packet(m.id, html));
  b.deliver({ type: "transfer-done", id: m.id });
  await settle();

  assert.deepEqual(b.log.shown.map(s => s.as), ["file"], "not drawn as a picture");
  assert.deepEqual(b.log.delivered.map(d => d.as), ["file"]);
  assert.equal(b.log.blobs[0].type, "application/octet-stream");
});

test("a file announced over the limit is turned away before a byte is stored", async () => {
  const b = side("b");
  const m = meta({ size: LIMIT + 1, totalChunks: 3 });
  b.deliver(m);
  for (let i = 0; i < 3; i++) b.chunk(packet(m.id, bytes(1000)));
  b.deliver({ type: "transfer-done", id: m.id });
  await settle();

  assert.deepEqual(b.log.shown, [], "no bubble for it");
  assert.deepEqual(b.log.sys, ["transferRefused"], "said once — not again when transfer-done came");
  assert.deepEqual(b.log.sent, [{ type: "transfer-abort", id: m.id }], "the sender was told");
  assert.deepEqual(b.log.blobs, []);
  const s = b.state();
  assert.deepEqual(Object.keys(s.recvBuffers), []);
  assert.equal(s.orphanChunkCount, 0, "its chunks were dropped, not parked");

  /* Announced again under the same id, now small: still turned away — its
     chunks are being dropped, so it could never complete. */
  b.deliver({ ...m, size: 10 });
  await settle();
  assert.deepEqual(b.log.shown, []);
});

test("a sender that sends more than it announced is cut off at the first extra byte", async () => {
  const b = side("b");
  const m = meta({ size: 100, totalChunks: 2 });
  b.deliver(m);
  b.chunk(packet(m.id, bytes(60)));
  b.chunk(packet(m.id, bytes(60)));   // 120 > 100
  await settle();

  assert.deepEqual(b.log.failed, [{ id: m.id, key: "transferRefused" }]);
  assert.deepEqual(b.log.sent, [{ type: "transfer-abort", id: m.id }]);
  assert.deepEqual(Object.keys(b.state().recvBuffers), [], "what it held is let go now, not at transfer-done");

  /* Whatever follows says nothing more and stores nothing. */
  for (let i = 0; i < 5; i++) b.chunk(packet(m.id, bytes(60)));
  b.deliver({ type: "transfer-abort", id: m.id });
  b.deliver({ type: "transfer-done", id: m.id });
  await settle();
  assert.equal(b.log.failed.length, 1);
  assert.deepEqual(b.log.sys, []);
  assert.deepEqual(b.log.blobs, []);
  assert.equal(b.state().orphanChunkCount, 0);
});

test("a sender that sends less than it announced does not deliver a short file", async () => {
  const b = side("b");
  const m = meta({ size: 100, totalChunks: 1 });
  b.deliver(m);
  b.chunk(packet(m.id, bytes(50)));
  b.deliver({ type: "transfer-done", id: m.id });
  await settle();

  assert.deepEqual(b.log.failed, [{ id: m.id, key: "transferFailed" }]);
  assert.deepEqual(b.log.blobs, []);
});

test("a chunk bigger than any honest sender makes is refused, and never parked", async () => {
  const b = side("b");
  /* packet() adds the IV; this is the sealed part after it: a full 64 KB
     chunk plus AES-GCM's 16-byte tag is the most an honest sender makes. */
  const honestMost = 65536 + 16;

  const m = meta({ size: 10_000_000, totalChunks: 200 });
  b.deliver(m);
  b.chunk(packet(m.id, bytes(honestMost + 1)));
  await settle();
  assert.deepEqual(b.log.failed, [{ id: m.id, key: "transferRefused" }]);

  /* One nobody announced: an honest-size chunk is parked for its metadata,
     an oversized one is not. */
  b.chunk(packet(DC.makeTransferId(), bytes(honestMost + 1)));
  assert.equal(b.state().orphanChunkCount, 0);
  b.chunk(packet(DC.makeTransferId(), bytes(honestMost)));
  assert.equal(b.state().orphanChunkCount, 1);
});

test("an id already arriving is not taken over by a second announcement", async () => {
  const b = side("b");
  const m = meta({ size: 10 });
  b.deliver(m);
  b.deliver({ ...m, size: 50, kind: "image", mimeType: "image/png" });
  b.chunk(packet(m.id, bytes(10)));
  b.deliver({ type: "transfer-done", id: m.id });
  await settle();

  assert.equal(b.log.shown.length, 1);
  assert.deepEqual(b.log.delivered.map(d => d.as), ["file"], "the first announcement stands");
});

/* ══════════════════════════════════════════
   Too much at once
══════════════════════════════════════════ */

test("two maximum-size files may arrive side by side; a third is turned away until one ends", async () => {
  const b = side("b");
  const first = meta({ size: LIMIT, totalChunks: 2400 });
  b.deliver(first);
  b.deliver(meta({ size: LIMIT, totalChunks: 2400 }));
  b.deliver(meta({ size: 1 }));
  await settle();
  assert.equal(b.log.shown.length, 2);
  assert.deepEqual(b.log.sys, ["transferRefused"]);

  /* The first one's sender gives up; its share is free again. */
  b.deliver({ type: "transfer-abort", id: first.id });
  b.deliver(meta({ size: 1 }));
  await settle();
  assert.equal(b.log.shown.length, 3);
});

test("too many arriving at once: the next is refused, and its sender stops sending", async () => {
  const { a, b } = pair();
  for (let i = 0; i < G.INCOMING_MAX_AT_ONCE; i++) b.deliver(meta({ size: 10 }));

  const chunks = 20;
  await a.sendBinary(new File([bytes(chunks * 65536)], "big.bin"), "file");
  await settle();

  const id = a.log.sent[0].id;
  assert.ok(b.log.sys.includes("transferRefused"));
  assert.ok(a.log.chunksSent < chunks, `the sender stopped early (sent ${a.log.chunksSent} of ${chunks})`);
  assert.ok(!a.log.sent.some(m => m.type === "transfer-done"), "and never claimed it was done");
  assert.deepEqual(a.log.failed, [{ id, key: "transferRefused" }], "the sender's bubble says it was not accepted");
  assert.equal(a.state().outgoingTransfers.size, 0);
  assert.equal(b.state().orphanChunkCount, 0);
});

/* ══════════════════════════════════════════
   The picture bubble
══════════════════════════════════════════ */

/** The real resolveImagePlaceholder, against a stand-in bubble. */
function pictureBubble() {
  const opened = [];
  const bubble = { child: null, replaceChildren(c) { this.child = c; } };
  const row = { querySelector: sel => (sel === ".bubble" ? bubble : { textContent: "" }) };
  const document = {
    createElement: tag => ({ tag, replaceWith(x) { bubble.child = x; } })
  };
  const run = new Function(
    "document", "window", "openImageViewer", "findTransferRow", "t", "now", "scrollBottom",
    `${fn("resolveImagePlaceholder")}\nreturn resolveImagePlaceholder;`
  )(document, { open: (url, target) => opened.push({ url, target, newTab: true }) },
    (url, name) => opened.push({ url, name }), () => row, key => key, () => "12:00", () => {});
  run("id-1", "blob:b/1", "cat.png");
  return { img: bubble.child, bubble, opened };
}

test("a received picture can be opened full size only once it has drawn as a picture", () => {
  const { img, opened } = pictureBubble();
  assert.equal(img.tag, "img");
  assert.equal(img.onclick, undefined, "nothing to open before it has drawn");

  img.onload();
  img.onclick();
  assert.deepEqual(opened, [{ url: "blob:b/1", name: "cat.png" }], "in the chat's own viewer — not a new tab, which left the chat");
});

test("a received picture that will not draw becomes a download, not a broken image to open", () => {
  const { img, bubble, opened } = pictureBubble();
  img.onerror();

  const link = bubble.child;
  assert.equal(link.tag, "a");
  assert.equal(link.href, "blob:b/1");
  assert.equal(link.download, "cat.png", "saved, not navigated to");
  assert.equal(img.onclick, undefined);
  assert.deepEqual(opened, []);
});

/* ══════════════════════════════════════════
   Read aloud
══════════════════════════════════════════ */

test("an arriving file, picture or voice note is read out to a screen reader", async () => {
  const { a, b } = pair();
  await a.sendBinary(new File([bytes(10)], "notes.pdf", { type: "application/pdf" }), "file");
  await a.sendBinary(new File([bytes(10)], "cat.png", { type: "image/png" }), "image");
  await a.sendBinary(new File([bytes(10)], "", { type: "audio/webm" }), "voice");
  await settle();
  assert.deepEqual(b.log.heard, ["srNewFile: notes.pdf", "srNewImage: cat.png", "srNewVoice"]);
  assert.deepEqual(a.log.heard, [], "your own sends are not read back to you");
  assert.equal(b.log.noticed, 3, "each is noticed — a chime if nobody is looking");
  assert.equal(a.log.noticed, 0);
});

test("a refused file is not announced as arriving", async () => {
  const b = side("b");
  b.deliver(meta({ size: LIMIT + 1 }));
  await settle();
  assert.deepEqual(b.log.heard, []);
  assert.equal(b.log.noticed, 0, "nor chimed for");
});
