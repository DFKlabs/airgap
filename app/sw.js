// Retired. airgap no longer keeps an offline copy: an old copy on a phone is
// worse than a page that needs the network once. This worker exists only to
// remove itself, and its caches, from devices that installed an earlier one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
})()));
