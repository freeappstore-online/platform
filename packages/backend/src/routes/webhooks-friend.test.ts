import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';
import { dispatchWebhookPlatform } from './webhooks.js';

describe.skipIf(!hasSqlite)('friend webhook delivery (#568)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const { db, d1 } = sqliteD1();
    for (const app of ['timer', 'chess']) {
      db.prepare('INSERT INTO apps (id, owner_login, created_at) VALUES (?, ?, 1)').run(
        app,
        'owner',
      );
      db.prepare(
        "INSERT INTO app_webhooks (id, app_id, event, url, secret) VALUES (?, ?, 'friend.request', 'https://example.com/h', 's')",
      ).run(`w-${app}`, app);
    }
    const role = db.prepare(
      'INSERT INTO app_roles (app_id, user_id, role_name, granted_by) VALUES (?, ?, ?, ?)',
    );
    // timer: both users joined themselves. chess: the owner planted both rows.
    role.run('timer', 'u1', 'member', null);
    role.run('timer', 'u2', 'member', null);
    role.run('chess', 'u1', 'editor', 'owner-id');
    role.run('chess', 'u2', 'member', 'owner-id');
    const bodies: string[] = [];
    const deliveryIds: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        if (String(u).startsWith('https://cloudflare-dns.com/')) {
          return Response.json({ Answer: [{ type: 1, data: '93.184.216.34' }] });
        }
        bodies.push(String(init?.body));
        deliveryIds.push(new Headers(init?.headers).get('X-FAS-Delivery-Id') ?? '');
        return new Response('ok');
      }),
    );
    return { db, d1, bodies, deliveryIds };
  }

  it('delivers only to apps both users joined themselves', async () => {
    const { d1, bodies } = setup();
    await dispatchWebhookPlatform(d1, 'friend.request', { userId: 'u1', friendId: 'u2' });
    expect(bodies.map((b) => JSON.parse(b).appId)).toEqual(['timer']);
  });

  it('sends the recorded delivery id as X-FAS-Delivery-Id (#764)', async () => {
    const { db, d1, deliveryIds } = setup();
    await dispatchWebhookPlatform(d1, 'friend.request', { userId: 'u1', friendId: 'u2' });
    const rows = db.prepare('SELECT id, status FROM webhook_deliveries').all();
    expect(rows).toEqual([{ id: deliveryIds[0], status: 200 }]);
  });
});
