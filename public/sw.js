'use strict';

const CACHE = 'remota-v6';
const SHELL = ['/', '/style.css', '/app.js', '/vendor/xterm.js', '/vendor/xterm.css', '/vendor/addon-fit.js', '/vendor/addon-web-links.js', '/vendor/jsqr.js', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'remota-meta').map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Network first so updates show up immediately; the cache only covers a flaky connection.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('/')))
  );
});

// Pushes come straight from each machine, which doesn't know what the phone calls it;
// the app keeps the names in the Cache API for this.
async function deviceName(id) {
  if (!id) return '';
  try {
    const res = await caches.match('/__remota/devices.json', { cacheName: 'remota-meta' });
    return res ? (await res.json())[id] || '' : '';
  } catch {
    return '';
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch {
    data = { title: 'Remota', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    deviceName(data.device).then((name) =>
      self.registration.showNotification(name ? `${name} / ${data.title || 'Remota'}` : data.title || 'Remota', {
        body: data.body || '',
        tag: data.tag || 'remota',
        renotify: true,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { sessionId: data.sessionId, device: data.device },
      })
    )
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const id = data.sessionId;
  const target = id && data.device ? `/#/s/${data.device}/${id}` : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage({ type: 'open', sessionId: id, device: data.device });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
