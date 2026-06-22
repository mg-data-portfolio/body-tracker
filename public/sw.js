// Simple offline-first service worker.
// Bump CACHE_VERSION whenever you want clients to refetch the app shell.
const CACHE_VERSION = "body-tracker-v1";
const CORE = ["./", "./index.html", "./manifest.webmanifest", "./apple-touch-icon.png", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // Network-first for navigation (so deploys update), cache fallback offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_VERSION).then((c) => c.put("./index.html", copy));
      return res;
    }).catch(() => caches.match("./index.html")));
    return;
  }
  // Cache-first for hashed static assets.
  e.respondWith(caches.match(req).then((cached) => cached || fetch(req).then((res) => {
    const copy = res.clone();
    caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
    return res;
  }).catch(() => cached)));
});
