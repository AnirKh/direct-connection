/*
  WebRTC encoded-frame E2E transform (same AES-GCM key as chat text).
  Used via RTCRtpScriptTransform on voice/video call senders and receivers.
*/
"use strict";

let keyPromise = null;

function initKey(keyBytes) {
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      "raw",
      new Uint8Array(keyBytes),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }
  return keyPromise;
}

async function encryptFrame(frame, controller) {
  const key = await keyPromise;
  const plain = new Uint8Array(frame.byteLength);
  frame.copyTo(plain);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  const Ctor = frame instanceof EncodedVideoFrame ? EncodedVideoFrame : EncodedAudioFrame;
  const opts = { type: frame.type, timestamp: frame.timestamp, data: out.buffer };
  if (frame instanceof EncodedVideoFrame && frame.duration != null) opts.duration = frame.duration;
  controller.enqueue(new Ctor(opts));
}

async function decryptFrame(frame, controller) {
  const key = await keyPromise;
  const data = new Uint8Array(frame.byteLength);
  frame.copyTo(data);
  if (data.byteLength < 28) return;
  const iv = data.slice(0, 12);
  const ct = data.slice(12);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    const Ctor = frame instanceof EncodedVideoFrame ? EncodedVideoFrame : EncodedAudioFrame;
    const opts = { type: frame.type, timestamp: frame.timestamp, data: plain };
    if (frame instanceof EncodedVideoFrame && frame.duration != null) opts.duration = frame.duration;
    controller.enqueue(new Ctor(opts));
  } catch (_) {
    /* drop corrupt frame */
  }
}

self.addEventListener("rtctransform", (event) => {
  const { readable, writable, options } = event.transformer;
  initKey(options.keyBytes);
  const encrypt = options.operation === "encrypt";
  const transform = new TransformStream({
    transform(frame, controller) {
      return (encrypt ? encryptFrame(frame, controller) : decryptFrame(frame, controller));
    }
  });
  readable.pipeThrough(transform).pipeTo(writable);
});
