import type { Server } from '../server.js';
import type { SubscriptionStore } from '../push-subscriptions.js';
import type { PushSender } from '../push-sender.js';
import type { UserPrsWatcher } from '../integrations/user-prs-watcher.js';
import { readJsonObject } from './util.js';

export interface PushRoutesDeps {
  pushStore: SubscriptionStore;
  pushSender: PushSender;
  userPrsWatcher: UserPrsWatcher;
}

export function registerPushRoutes(server: Server, deps: PushRoutesDeps): void {
  const { pushStore, pushSender, userPrsWatcher } = deps;

  // Body: { subscription: { endpoint, keys: { p256dh, auth } }, userAgent? }.
  // Idempotent on endpoint (unique per browser/device/origin); returns current count.
  server.route('POST', '/api/push/subscribe', async (req, res) => {
    const payload = await readJsonObject<{ subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; userAgent?: string }>(req, res);
    if (!payload) return;
    const sub = payload.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys
        || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') {
      res.statusCode = 400; res.end('subscription.endpoint + subscription.keys.{p256dh,auth} required'); return;
    }
    if (!/^https?:\/\//.test(sub.endpoint)) {
      res.statusCode = 400; res.end('subscription.endpoint must be http(s) URL'); return;
    }
    const now = Date.now();
    pushStore.add({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      userAgent: typeof payload.userAgent === 'string' ? payload.userAgent.slice(0, 500) : undefined,
      createdAt: now,
      lastSeenAt: now,
    });
    console.log(`[push] subscribe ${sub.endpoint.slice(0, 60)}… (total ${pushStore.list().length})`);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ count: pushStore.list().length }));
  });

  // Body: { endpoint: string }. 200 either way (no leaking presence).
  server.route('DELETE', '/api/push/subscribe', async (req, res) => {
    const payload = await readJsonObject<{ endpoint?: string }>(req, res);
    if (!payload) return;
    if (typeof payload.endpoint !== 'string') {
      res.statusCode = 400; res.end('endpoint required'); return;
    }
    pushStore.remove(payload.endpoint);
    console.log(`[push] unsubscribe ${payload.endpoint.slice(0, 60)}… (total ${pushStore.list().length})`);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ count: pushStore.list().length }));
  });

  server.route('GET', '/api/user-prs', (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(userPrsWatcher.get()));
  });

  server.route('POST', '/api/user-prs/refresh', async (_req, res) => {
    try {
      await userPrsWatcher.syncNow();
      res.statusCode = 200;
    } catch (e) {
      console.error('[user-prs] refresh failed:', (e as Error).message);
      res.statusCode = 200;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(userPrsWatcher.get()));
  });

  server.route('POST', '/api/push/test', async (_req, res) => {
    await pushSender.send({
      title: 'Outpost test push',
      body: 'If you can see this, push is wired correctly.',
      tag: 'outpost-test',
      data: { kind: 'test' },
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ count: pushStore.list().length }));
  });
}
