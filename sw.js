// Guarda los archivos de la app para que abra rápido aunque haya poca cobertura.
// Primero intenta la red (así siempre tienes la última versión) y si falla usa la copia guardada.
const CACHE = "manhunt-v2";
const FILES = ["./", "index.html", "app.js", "firebase-config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Solo los archivos propios; Firebase, el mapa y las fuentes van siempre por la red.
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, {ignoreSearch: true}))
  );
});
