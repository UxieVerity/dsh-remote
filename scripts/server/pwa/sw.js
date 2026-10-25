// Minimal service worker: makes the DSH web app installable and caches nothing.
// The app talks to the PC over the tunnel; a stale cache here would be a support
// nightmare, so this SW is deliberately network-only.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // no respondWith -> every request goes to the network as usual
});
