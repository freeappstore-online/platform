import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';
import type { Env } from '../types.js';
import { buildLoaderJs } from './analytics.js';

const SIGNING_KEY = 'a'.repeat(64);

function summaryEnv(owner = 'alice'): Env {
  const users = [
    {
      id: 'gh:1',
      github_login: owner,
      avatar_url: null,
      display_name: null,
      email: null,
      date_of_birth: null,
    },
  ];
  const db = {
    prepare(sql: string) {
      const compact = sql.replace(/\s+/g, ' ').trim();
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async first<T>() {
          if (compact.startsWith('SELECT id, github_login, avatar_url')) {
            return (users.find((user) => user.id === args[0]) ?? null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          if (compact === 'SELECT id FROM apps WHERE owner_login = ?') {
            const ids = args[0] === owner ? [{ id: 'alpha' }, { id: 'bravo' }] : [];
            return { results: ids as T[] } as D1Result<T>;
          }
          return { results: [] as T[] } as D1Result<T>;
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return {
    DB: db,
    SESSION_SIGNING_KEY: SIGNING_KEY,
    CF_ACCOUNT_ID: 'account',
    CF_ANALYTICS_API_TOKEN: 'token',
  } as Env;
}

afterEach(() => vi.unstubAllGlobals());

const empty = {
  cf_beacon_token: null,
  ga4: null,
  plausible: null,
  custom_head: null,
  updated_at: null,
};

describe('buildLoaderJs', () => {
  it('always emits the first-party page-view beacon, even with no config', () => {
    const js = buildLoaderJs(null, 'myapp');
    expect(js).toContain('/v1/analytics/event');
    expect(js).toContain('"myapp"');
    expect(js).toContain('sendBeacon');
    expect(js).toContain('send("pageview")');
  });

  it('exposes a custom-event API on window.fasAnalytics', () => {
    const js = buildLoaderJs(empty, 'myapp');
    expect(js).toContain('window.fasAnalytics');
    expect(js).toContain('window.fasAnalytics.event');
  });

  it('patches history.pushState/replaceState for SPA route changes', () => {
    const js = buildLoaderJs(empty, 'myapp');
    expect(js).toContain('history.pushState');
    expect(js).toContain('history.replaceState');
    expect(js).toContain('popstate');
  });

  it('emits a CF Web Analytics beacon when cf_beacon_token is set', () => {
    const js = buildLoaderJs(
      { ...empty, cf_beacon_token: 'abc123abc123abc123abc123abc123ab' },
      'myapp',
    );
    expect(js).toContain('static.cloudflareinsights.com/beacon.min.js');
    expect(js).toContain('data-cf-beacon');
    expect(js).toContain('abc123abc123abc123abc123abc123ab');
  });

  it('rejects malformed cf_beacon_token (CF tag dropped; beacon still emitted)', () => {
    const js = buildLoaderJs({ ...empty, cf_beacon_token: 'not-hex' }, 'myapp');
    expect(js).not.toContain('static.cloudflareinsights.com');
    expect(js).toContain('/v1/analytics/event'); // first-party beacon still emitted
  });

  it('emits a GA4 loader when ga4 is set', () => {
    const js = buildLoaderJs({ ...empty, ga4: 'G-ABC123' }, 'myapp');
    expect(js).toContain('googletagmanager.com/gtag/js?id=');
    expect(js).toContain('G-ABC123');
  });

  it('rejects malformed ga4 (GA tag dropped)', () => {
    const js = buildLoaderJs({ ...empty, ga4: 'UA-1234' }, 'myapp');
    expect(js).not.toContain('googletagmanager.com');
  });

  it('emits a Plausible loader when plausible domain is set', () => {
    const js = buildLoaderJs({ ...empty, plausible: 'mysite.com' }, 'myapp');
    expect(js).toContain('plausible.io/js/script.js');
    expect(js).toContain('mysite.com');
  });

  it('rejects malformed plausible domain (tag dropped)', () => {
    const js = buildLoaderJs({ ...empty, plausible: 'not a domain!' }, 'myapp');
    expect(js).not.toContain('plausible.io');
  });

  it('emits the custom_head snippet when set', () => {
    const js = buildLoaderJs({ ...empty, custom_head: '<meta name="x" content="y" />' }, 'myapp');
    expect(js).toContain('<meta name=\\"x\\" content=\\"y\\" />');
  });

  it('drops custom_head when it exceeds 4 KB', () => {
    const big = 'x'.repeat(4097);
    const js = buildLoaderJs({ ...empty, custom_head: big }, 'myapp');
    expect(js).not.toContain('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('combines multiple providers + always-on beacon', () => {
    const js = buildLoaderJs(
      {
        ...empty,
        cf_beacon_token: 'abc123abc123abc123abc123abc123ab',
        ga4: 'G-ABC123',
        plausible: 'mysite.com',
      },
      'myapp',
    );
    expect(js).toContain('cloudflareinsights');
    expect(js).toContain('googletagmanager');
    expect(js).toContain('plausible.io');
    expect(js).toContain('/v1/analytics/event');
  });

  it('emits the IndexedDB outbox + drain wiring', () => {
    const js = buildLoaderJs(null, 'myapp');
    expect(js).toContain('indexedDB.open');
    expect(js).toContain('"fasA"');
    expect(js).toContain('"outbox"');
    expect(js).toContain('navigator.onLine');
    expect(js).toContain('addEventListener("online", drain)');
  });

  it('events include client timestamp `t` for replay accuracy', () => {
    const js = buildLoaderJs(null, 'myapp');
    expect(js).toContain('t:Date.now()');
  });

  it('drain posts a batch (events: [...]) not a single event', () => {
    const js = buildLoaderJs(null, 'myapp');
    expect(js).toContain('{events: events}');
  });
});

describe('GET /v1/analytics/summary', () => {
  it('requires an authenticated owner', async () => {
    const res = await app.request('/v1/analytics/summary?days=7', {}, summaryEnv());
    expect(res.status).toBe(401);
  });

  it('returns grouped KPI summaries only for the caller-owned apps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const sql = String(init.body);
        const data = sql.includes('unique_paths')
          ? [
              { appId: 'alpha', views: 12, unique_paths: 3 },
              { appId: 'bravo', views: 4, unique_paths: 2 },
            ]
          : [
              { appId: 'alpha', country: 'AU', views: 9 },
              { appId: 'bravo', country: 'US', views: 4 },
            ];
        return new Response(JSON.stringify({ data }), { status: 200 });
      }),
    );
    const token = await signSession('gh:1', SIGNING_KEY);
    const res = await app.request(
      '/v1/analytics/summary?days=7',
      { headers: { Authorization: `Bearer ${token}` } },
      summaryEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: number;
      summaries: Record<
        string,
        { total_views: number; unique_paths: number; top_country: string | null }
      >;
    };
    expect(body.days).toBe(7);
    expect(body.summaries).toEqual({
      alpha: { total_views: 12, unique_paths: 3, top_country: 'AU' },
      bravo: { total_views: 4, unique_paths: 2, top_country: 'US' },
    });
  });
});
