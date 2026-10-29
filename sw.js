/*
  ─────────────────────────────────────────────
  Direct Connection — sw.js
  ─────────────────────────────────────────────

  For knocks, and nothing else. When a saved person taps this device's name
  and is first there, the server knocks (see knock.js); this shows it — "Anu
  wants to talk" — even with the app closed, and a tap on it opens the app
  and meets them.

  It answers no requests: there is no fetch handler, so every page and file
  still comes from the network exactly as before, and nothing here can hold
  on to an old version. It is registered only once alerts are turned on (see
  "KNOCKS" in app.js).

  The knock says only which room — the hash both devices name it by. The name
  shown is the one this device gave the person, read from the copy the page
  keeps for this worker in IndexedDB: rooms and names, no secrets.
*/

"use strict";

/* The words, from the same file the page reads them from. If it cannot be
   had, the English below stands in. */
try { importScripts("i18n.js"); } catch (_) { /* the fallback words below */ }

const ROOM = /^~[A-Za-z0-9_-]{43}$/;
const FALLBACK = {
  knockTitle: name => `${name} wants to talk`,
  knockSomeone: "Someone you saved wants to talk",
  knockBody: "Tap to connect."
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

/** What the page left for this worker: { lang, names: [[room, name], …] }. */
function keptForKnocks() {
  return new Promise(resolve => {
    try {
      const open = indexedDB.open("dc-knock", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        const db = open.result;
        try {
          const get = db.transaction("kv").objectStore("kv").get("people");
          get.onsuccess = () => { db.close(); resolve(get.result || null); };
          get.onerror = () => { db.close(); resolve(null); };
        } catch (_) { db.close(); resolve(null); }
      };
    } catch (_) { resolve(null); }
  });
}

function wordsFor(lang) {
  const table = typeof I18N === "object" && I18N ? I18N[lang === "en" ? "en" : "mn"] : null;
  const word = key => (table && table[key] !== undefined ? table[key] : FALLBACK[key]);
  return { title: word("knockTitle"), someone: word("knockSomeone"), body: word("knockBody") };
}

/** The room a push is about, if it is a knock and names one properly. */
function knockedRoom(data) {
  try {
    const message = data ? data.json() : null;
    return message && message.t === "knock" && ROOM.test(message.room) ? message.room : null;
  } catch (_) { return null; }
}

/** Every push is shown — a browser requires it. A knock from someone this
    device no longer has, or one it cannot read, says so without a name. */
async function showKnock(room) {
  const kept = await keptForKnocks();
  const words = wordsFor(kept && kept.lang);
  const names = new Map(kept && Array.isArray(kept.names) ? kept.names : []);
  const name = room && typeof names.get(room) === "string" ? names.get(room) : null;
  return self.registration.showNotification(name ? words.title(name) : words.someone, {
    body: words.body,
    tag: name ? room : "knock",          // a second knock replaces the first
    renotify: true,
    icon: "icons/icon-192.png",
    data: { room: name ? room : null }
  });
}

self.addEventListener("push", event => event.waitUntil(showKnock(knockedRoom(event.data))));

/** Tapped: to the app, and to them. An open page is brought forward and told
    who knocked; otherwise a new one opens, naming them in its address. */
async function openFor(room) {
  const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const page = pages.find(p => p.url.startsWith(self.registration.scope));
  if (page) {
    try { await page.focus(); } catch (_) { /* brought forward or not, it is told */ }
    if (room) page.postMessage({ type: "knock", room });
    return;
  }
  await self.clients.openWindow(room ? `${self.registration.scope}#knock=${room}` : self.registration.scope);
}

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const room = event.notification.data && ROOM.test(event.notification.data.room || "") ? event.notification.data.room : null;
  event.waitUntil(openFor(room));
});
