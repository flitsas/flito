/* FLIT — Service Worker (hecho a mano, sin Workbox).
 *
 * Objetivo Fase 2: instalabilidad (CA-14) + carga offline del app-shell. El offline de ESCRITURA
 * (recogidas/entregas) NO vive aquí: lo maneja una cola en IndexedDB en la capa de app (RN-06),
 * así que este SW deja pasar TODO /api/ a la red y no lo cachea. El precache de assets es en
 * caliente (stale-while-revalidate) para no precachear todo el bundle: el offline solo se exige
 * en las rutas del mensajero (§9.8), y el shell + los assets que ya visitó bastan para cargarlas.
 */
const VERSION = 'flit-sw-v1';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/pwa-192.png', '/pwa-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Permite forzar la actualización desde la app (botón "nueva versión").
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Solo GET del mismo origen; el resto (POST, /api, terceros) va directo a la red.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Navegación (SPA): red primero; si no hay señal, servir el shell cacheado.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
    );
    return;
  }

  // Assets estáticos: stale-while-revalidate (sirve de caché y refresca en segundo plano).
  event.respondWith(
    caches.open(ASSETS).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.status === 200) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    }),
  );
});
