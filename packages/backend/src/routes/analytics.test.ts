import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';
import type { Env } from '../types.js';
import {
  type AdminUsageReport,
  buildAdminUsage,
  buildLoaderJs,
  usageDayKeys,
} from './analytics.js';

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

describe('admin cross-app usage (#271)', () => {
  function adminEnv(): Env {
    const env = summaryEnv('alice');
    const base = env.DB.prepare.bind(env.DB);
    const db = {
      prepare(sql: string) {
        const compact = sql.replace(/\s+/g, ' ').trim();
        if (compact.startsWith('SELECT id, owner_login FROM apps')) {
          return {
            async all<T>() {
              return {
                results: [
                  { id: 'alpha', owner_login: 'alice' },
                  { id: 'bravo', owner_login: 'bob' },
                  { id: 'quiet', owner_login: 'carol' },
                ] as T[],
              } as D1Result<T>;
            },
          } as unknown as D1PreparedStatement;
        }
        return base(sql);
      },
    } as unknown as D1Database;
    return { ...env, DB: db, ADMIN_GITHUB_LOGINS: 'root' } as Env;
  }

  function stubAnalytics() {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const sql = String(init.body);
      const data = sql.includes('toStartOfDay')
        ? [
            { appId: 'alpha', t: '2026-10-17 00:00:00', views: 5 },
            { appId: 'alpha', t: '2026-10-18 00:00:00', views: 7 },
            { appId: 'bravo', t: '2026-10-18 00:00:00', views: 3 },
            { appId: 'ghost', t: '2026-10-18 00:00:00', views: 2 },
          ]
        : [
            { appId: 'alpha', views: 12, unique_paths: 4 },
            { appId: 'bravo', views: 3, unique_paths: 1 },
            { appId: 'ghost', views: 2, unique_paths: 1 },
          ];
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('rejects anonymous callers with 401', async () => {
    const fetchMock = stubAnalytics();
    const res = await app.request('/v1/analytics/admin/apps?days=7', {}, adminEnv());
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects signed-in non-admins with 403 before querying analytics', async () => {
    const fetchMock = stubAnalytics();
    const token = await signSession('gh:1', SIGNING_KEY);
    const res = await app.request(
      '/v1/analytics/admin/apps?days=7',
      { headers: { Authorization: `Bearer ${token}` } },
      adminEnv(),
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists every registered app for an admin, flagging apps with no views', async () => {
    const fetchMock = stubAnalytics();
    const token = await signSession('gh:1', SIGNING_KEY, { roles: ['user', 'admin'] });
    const res = await app.request(
      '/v1/analytics/admin/apps?days=30',
      { headers: { Authorization: `Bearer ${token}` } },
      adminEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminUsageReport;
    expect(body.days).toBe(30);
    expect(body.apps.map((a) => [a.id, a.owner, a.views, a.unique_paths, a.no_views])).toEqual([
      ['alpha', 'alice', 12, 4, false],
      ['bravo', 'bob', 3, 1, false],
      ['quiet', 'carol', 0, 0, true],
    ]);
    expect(body.totals).toMatchObject({
      views: 15,
      apps: 3,
      apps_with_views: 2,
      apps_without_views: 1,
    });
    expect(body.unregistered).toEqual([{ id: 'ghost', views: 2 }]);
    // Both queries cover the requested window and only count page views.
    for (const [, init] of fetchMock.mock.calls) {
      expect(String(init.body)).toContain("INTERVAL '30' DAY");
      expect(String(init.body)).toContain("blob2 = 'pageview'");
    }
  });
});

describe('buildAdminUsage (#271)', () => {
  const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

  it('fills a zeroed daily series for the whole window and sums the totals per day', () => {
    const report = buildAdminUsage(
      [
        { id: 'alpha', owner_login: 'alice' },
        { id: 'quiet', owner_login: 'carol' },
      ],
      [{ appId: 'alpha', views: 12, unique_paths: 4 }],
      [
        { appId: 'alpha', t: '2026-10-17 00:00:00', views: 5 },
        { appId: 'alpha', t: '2026-10-18 00:00:00', views: 7 },
        { appId: 'alpha', t: '2026-09-01 00:00:00', views: 99 }, // outside the window: ignored
      ],
      7,
      NOW,
    );
    const keys = usageDayKeys(7, NOW);
    expect(keys[0]).toBe('2026-10-11');
    expect(keys[keys.length - 1]).toBe('2026-10-18');
    const alpha = report.apps.find((a) => a.id === 'alpha');
    const quiet = report.apps.find((a) => a.id === 'quiet');
    expect(alpha?.series.map((p) => p.t)).toEqual(keys);
    expect(alpha?.series.slice(-2).map((p) => p.views)).toEqual([5, 7]);
    expect(quiet?.series.every((p) => p.views === 0)).toBe(true);
    expect(quiet?.no_views).toBe(true);
    expect(report.totals.series.slice(-2).map((p) => p.views)).toEqual([5, 7]);
    expect(report.totals.views).toBe(12);
  });

  it('ignores zero-view rows for unknown app ids', () => {
    const report = buildAdminUsage([], [{ appId: 'gone', views: 0, unique_paths: 0 }], [], 7, NOW);
    expect(report.unregistered).toEqual([]);
    expect(report.totals).toMatchObject({ views: 0, apps: 0 });
  });
});
