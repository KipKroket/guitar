// Guitar — service worker
// Precaches the app shell so the pinned app opens and runs with no network.
// Song search (iTunes API) and the external chord/tab links still need a
// connection; everything else — tuner, metronome, saved library — works offline.

// Bump on every deploy, in lockstep with BUILD in js/app.js -- the two always
// move together, so the number shown in Settings identifies this exact cache.
const CACHE = "guitar-v21";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./manifest-piano.json",
  "./css/style.css",
  "./js/tuner.js",
  "./js/metronome-engine.js",
  "./js/app.js",
  "./js/metronome.js",
  "./js/library.js",
  "./js/chords.js",
  "./js/songsheet.js",
  "./js/sync.js",
  "./audio/E2.mp3",
  "./audio/A2.mp3",
  "./audio/D3.mp3",
  "./audio/G3.mp3",
  "./audio/B3.mp3",
  "./audio/E4.mp3",
  "./icons/icon.svg",
  "./icons/icon-monochrome.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon-piano.svg",
  "./icons/icon-piano-192.png",
  "./icons/icon-piano-512.png",
  "./icons/apple-touch-icon-piano.png",
];

self.addEventListener("install", (event) => {
  // `cache: "reload"` makes each precache fetch bypass the browser HTTP cache,
  // so a worker update always stores genuinely fresh files -- otherwise an
  // update can bake in stale copies and the new version only appears a
  // relaunch or two later.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont =
    url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";

  // Only the app shell + fonts go through the worker. Everything else
  // (the iTunes search API, external chord/tab links) is left entirely to
  // the browser -- intercepting it here only risks turning a transient blip
  // into a hard failure, and an offline cache can't answer a live search.
  if (!sameOrigin && !isFont) return;

  // App shell + local assets: serve from cache first, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
