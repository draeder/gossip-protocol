/* Minimal service worker for the Vue3 demo.
 *
 * Intentionally does not cache or intercept requests beyond a pass-through fetch.
 * Its purpose is to ensure one SW is registered per browser context/engine.
 */

self.addEventListener('install', (event) => {
  // Activate immediately on install.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through; do not cache.
  event.respondWith(fetch(event.request));
});
