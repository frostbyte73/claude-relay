// Outpost service worker. Three responsibilities:
//   1. Standard install/activate (claim clients so the SW takes over without reload)
//   2. Web Push handler with foreground suppression (visible window → in-page message)
//   3. notificationclick handler that deep-links to /?session=<id>&approval=<id>, or for a
//      `kind: 'draft'` payload, /?job=<id> — see deep-links.js's SURFACE_PARAMS

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { /* malformed payload — keep defaults */ }
  const { title = 'Outpost', body = '', tag, data: payloadData = {} } = data;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisible = clients.some((c) => c.visibilityState === 'visible');
    if (hasVisible) {
      // Don't double-notify when the PWA is already on screen — app.js handles the
      // in-app toast via the existing notifications WS. We still forward the payload so
      // future push kinds (non-WS-mirrored) have a delivery path.
      for (const c of clients) {
        c.postMessage({ type: 'push', title, body, data: payloadData });
      }
      return;
    }
    await self.registration.showNotification(title, {
      body,
      tag,
      data: payloadData,
      icon: '/icon-512.png',
      badge: '/icon-512.png',
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  // A draft-ready push has no session of its own to jump into — a dispatch child's draft is
  // raised by a background subagent, not the job's top-level session — so it deep-links to
  // the job on the tracked surface instead, same shape deep-links.js's `?job=` param produces.
  const target = data.kind === 'draft' && data.jobId
    ? { surface: 'tracked', id: data.jobId }
    : { sessionId: data.sessionId, approvalId: data.approvalId };
  const url = target.surface
    ? `/?job=${encodeURIComponent(target.id)}`
    : target.sessionId
      ? `/?session=${encodeURIComponent(target.sessionId)}${target.approvalId ? `&approval=${encodeURIComponent(target.approvalId)}` : ''}`
      : '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // If a PWA window is already open, focus it and tell it which deep link to apply —
    // we can't change the URL of an existing tab without a navigation, so postMessage
    // lets the in-page code scroll to the card directly.
    for (const c of clients) {
      if ('focus' in c) {
        c.postMessage({ type: 'deepLink', ...target });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
