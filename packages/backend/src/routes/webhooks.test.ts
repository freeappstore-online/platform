import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(opts: {
  user?: Record<string, unknown> | null;
  webhooks?: Array<Record<string, unknown>>;
  count?: number;
}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      return {
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (trimmed.includes('FROM users')) return opts.user ?? null;
            if (trimmed.includes('FROM apps'))
              return opts.user ? { owner_id: (opts.user as Record<string, unknown>).id } : null;
            if (trimmed.includes('COUNT(*)')) return { n: opts.count ?? 0 };
            if (trimmed.includes('FROM app_webhooks') && trimmed.includes('id = ?'))
              return opts.webhooks?.[0] ?? null;
            return null;
          },
          all: async () => ({ results: opts.webhooks ?? [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      };
    },
  } as unknown as D1Database;
}

function env(db: D1Database) {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY };
}

async function authHeader(userId = 'u1') {
  const token = await signSession(userId, SIGNING_KEY, { aud: 'console' });
  return `Bearer ${token}`;
}

describe('webhook routes', () => {
  const user = { id: 'u1', github_login: 'test', avatar_url: null, date_of_birth: null };

  it('GET /v1/apps/:appId/webhooks returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/timer/webhooks', {}, env(fakeDB({})));
    expect(res.status).toBe(401);
  });

  it('GET /v1/apps/:appId/webhooks returns webhook list', async () => {
    const webhooks = [
      {
        id: 'w1',
        event: 'kv.changed',
        url: 'https://example.com/hook',
        active: 1,
        created_at: 1000,
      },
    ];
    const res = await app.request(
      '/v1/apps/timer/webhooks',
      {
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user, webhooks })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { webhooks: unknown[]; supported_events: string[] };
    expect(data.webhooks).toHaveLength(1);
    expect(data.supported_events.length).toBeGreaterThan(0);
  });

  it('POST /v1/apps/:appId/webhooks returns 400 for missing fields', async () => {
    const res = await app.request(
      '/v1/apps/timer/webhooks',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env(fakeDB({ user })),
    );
    expect(res.status).toBe(400);
  });

  it('POST /v1/apps/:appId/webhooks returns 400 for unsupported event', async () => {
    const res = await app.request(
      '/v1/apps/timer/webhooks',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'invalid.event', url: 'https://example.com/hook' }),
      },
      env(fakeDB({ user })),
    );
    expect(res.status).toBe(400);
  });

  it('POST /v1/apps/:appId/webhooks returns 400 for non-HTTPS URL', async () => {
    const res = await app.request(
      '/v1/apps/timer/webhooks',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'kv.changed', url: 'http://example.com/hook' }),
      },
      env(fakeDB({ user })),
    );
    expect(res.status).toBe(400);
  });

  it('POST /v1/apps/:appId/webhooks returns 409 when at cap', async () => {
    const res = await app.request(
      '/v1/apps/timer/webhooks',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'kv.changed', url: 'https://example.com/hook' }),
      },
      env(fakeDB({ user, count: 5 })),
    );
    expect(res.status).toBe(409);
  });

  it('POST /v1/apps/:appId/webhooks creates webhook', async () => {
    const res = await app.request(
      '/v1/apps/timer/webhooks',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'kv.changed', url: 'https://example.com/hook' }),
      },
      env(fakeDB({ user, count: 0 })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string; secret: string };
    expect(data.id).toBeDefined();
    expect(data.secret).toBeDefined();
    expect(data.secret.length).toBeGreaterThan(30);
  });

  it('DELETE /v1/apps/:appId/webhooks/:id deletes webhook', async () => {
    const res = await app.request(
      '/v1/apps/timer/webhooks/w1',
      {
        method: 'DELETE',
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user })),
    );
    expect(res.status).toBe(200);
  });

  describe('hardening (#465)', () => {
    afterEach(() => vi.unstubAllGlobals());

    it.each([
      'https://127.1/hook',
      'https://0x7f000001/hook',
      'https://2130706433/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://[fd00::1]/hook',
      'https://example.com:8443/hook',
      'https://user:pw@example.com/hook',
      'https://intranet/hook',
      'https://100.64.0.1/hook',
    ])('refuses to register %s', async (url) => {
      const res = await app.request(
        '/v1/apps/timer/webhooks',
        {
          method: 'POST',
          headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'kv.changed', url }),
        },
        env(fakeDB({ user })),
      );
      expect(res.status).toBe(400);
    });

    const hook = { url: 'https://hooks.example.com/in', secret: 's3cret', event: 'kv.changed' };
    const test = async () =>
      app.request(
        '/v1/apps/timer/webhooks/w1/test',
        { method: 'POST', headers: { Authorization: await authHeader() } },
        env(fakeDB({ user, webhooks: [hook] })),
      );

    it('test delivery returns only the status, signs with timestamp and delivery id, refuses redirects', async () => {
      const sent: { headers: Headers; redirect?: string | undefined }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (u: string, init?: RequestInit) => {
          if (String(u).startsWith('https://cloudflare-dns.com/')) {
            return Response.json({ Answer: [{ type: 1, data: '93.184.216.34' }] });
          }
          sent.push({ headers: new Headers(init?.headers), redirect: init?.redirect });
          return new Response('SECRET INTERNAL BODY', { status: 200 });
        }),
      );
      const res = await test();
      expect(await res.json()).toEqual({ status: 200 });
      expect(sent).toHaveLength(1);
      const h = sent[0]!.headers;
      expect(h.get('X-FAS-Signature')).toMatch(/^[0-9a-f]{64}$/);
      expect(h.get('X-FAS-Signature-V2')).toMatch(/^[0-9a-f]{64}$/);
      expect(h.get('X-FAS-Signature-V2')).not.toBe(h.get('X-FAS-Signature'));
      expect(Number(h.get('X-FAS-Timestamp'))).toBeGreaterThan(1_700_000_000);
      expect(h.get('X-FAS-Delivery-Id')).toMatch(/^[0-9a-f-]{36}$/);
      expect(sent[0]!.redirect).toBe('manual');
    });

    it('does not deliver to a name that resolves to a private address', async () => {
      const upstream = vi.fn();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (u: string) => {
          if (String(u).startsWith('https://cloudflare-dns.com/')) {
            return Response.json({ Answer: [{ type: 1, data: '10.0.0.5' }] });
          }
          upstream();
          return new Response('', { status: 200 });
        }),
      );
      const res = await test();
      expect(await res.json()).toEqual({ status: 0 });
      expect(upstream).not.toHaveBeenCalled();
    });
  });
});
