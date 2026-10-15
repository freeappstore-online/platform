import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from './auth.js';
import {
  Push,
  PushNotConfiguredError,
  PushNotSignedInError,
  PushNotSupportedError,
  PushPermissionDeniedError,
} from './push.js';
import { registerFasPushHandler } from './push-sw.js';

const API = 'https://api.example';
const VAPID = `B${'A'.repeat(86)}`; // shaped like a real key: 65 bytes as base64url
const SUB_JSON = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
};

function fakeAuth(token: string | null) {
  return { token, handleUnauthorized: vi.fn() } as unknown as Auth & {
    handleUnauthorized: ReturnType<typeof vi.fn>;
  };
}

/** A browser with the Push API; `existing` is a subscription already on this device. */
function stubBrowser(
  opts: {
    userAgent?: string;
    pushManager?: boolean;
    standalone?: boolean;
    permission?: NotificationPermission;
    grant?: NotificationPermission;
    existing?: boolean;
  } = {},
) {
  const subscription = {
    endpoint: SUB_JSON.endpoint,
    toJSON: () => SUB_JSON,
    unsubscribe: vi.fn(async () => true),
  };
  const pushManager = {
    getSubscription: vi.fn(async () => (opts.existing ? subscription : null)),
    subscribe: vi.fn(async () => subscription),
  };
  const Notification = {
    permission: opts.permission ?? 'default',
    requestPermission: vi.fn(async () => opts.grant ?? 'granted'),
  };
  vi.stubGlobal('window', {
    ...(opts.pushManager !== false && { PushManager: function PushManager() {} }),
    Notification,
  });
  vi.stubGlobal('Notification', Notification);
  vi.stubGlobal('navigator', {
    userAgent: opts.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0',
    platform: 'Linux x86_64',
    maxTouchPoints: 0,
    ...(opts.standalone !== undefined && { standalone: opts.standalone }),
    serviceWorker: { ready: Promise.resolve({ pushManager }) },
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  return { pushManager, subscription, Notification };
}

type Call = { url: string; method: string; body: unknown; auth: string | null };
/** fetch mock answering by "METHOD path"; records every call. */
function stubFetch(routes: Record<string, () => Response> = {}) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({
      url: url.pathname,
      method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init.headers as Record<string, string> | undefined)?.Authorization ?? null,
    });
    const route = routes[`${method} ${url.pathname}`];
    if (route) return route();
    if (url.pathname === '/v1/push/vapid-public-key') return Response.json({ publicKey: VAPID });
    return new Response(null, { status: method === 'POST' ? 201 : 204 });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const push = (token: string | null = 'tok') => new Push('cycle', API, fakeAuth(token));
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isSupported', () => {
  it('is ok in a browser with service workers, PushManager and Notification', () => {
    stubBrowser();
    expect(push().isSupported()).toEqual({ supported: true, reason: 'ok' });
  });

  it('needs the home screen on iPhone Safari when the app is not installed', () => {
    stubBrowser({ userAgent: IPHONE, pushManager: false, standalone: false });
    expect(push().isSupported()).toEqual({ supported: false, reason: 'requires-home-screen' });
  });

  it('is ok on iPhone once the app runs from the home screen', () => {
    stubBrowser({ userAgent: IPHONE, standalone: true });
    expect(push().isSupported()).toEqual({ supported: true, reason: 'ok' });
  });

  it('treats an iPad that reports as a Mac like iOS', () => {
    stubBrowser({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      pushManager: false,
    });
    (navigator as unknown as { platform: string; maxTouchPoints: number }).platform = 'MacIntel';
    (navigator as unknown as { maxTouchPoints: number }).maxTouchPoints = 5;
    expect(push().isSupported().reason).toBe('requires-home-screen');
  });

  it('is browser-unsupported without PushManager', () => {
    stubBrowser({ pushManager: false });
    expect(push().isSupported()).toEqual({ supported: false, reason: 'browser-unsupported' });
  });

  it('is browser-unsupported outside a browser', () => {
    expect(push().isSupported()).toEqual({ supported: false, reason: 'browser-unsupported' });
  });
});

describe('permission', () => {
  it('reports Notification.permission', () => {
    stubBrowser({ permission: 'granted' });
    expect(push().permission()).toBe('granted');
  });
});

describe('subscribe', () => {
  it('asks permission, fetches the VAPID key, subscribes and registers the device', async () => {
    const { pushManager, Notification } = stubBrowser();
    const calls = stubFetch();
    await push().subscribe();

    expect(Notification.requestPermission).toHaveBeenCalledOnce();
    expect(calls[0]).toMatchObject({ url: '/v1/push/vapid-public-key', method: 'GET', auth: null });
    expect(pushManager.subscribe).toHaveBeenCalledOnce();
    const [opts] = pushManager.subscribe.mock.calls[0] as unknown as [
      { userVisibleOnly: boolean; applicationServerKey: Uint8Array },
    ];
    expect(opts.userVisibleOnly).toBe(true);
    expect(opts.applicationServerKey).toBeInstanceOf(Uint8Array);
    expect(opts.applicationServerKey.length).toBe(65);
    expect(calls[1]).toEqual({
      url: '/v1/apps/cycle/push/subscriptions',
      method: 'POST',
      body: { endpoint: SUB_JSON.endpoint, keys: SUB_JSON.keys },
      auth: 'Bearer tok',
    });
  });

  it("re-registers an existing subscription without asking again when permission's granted", async () => {
    const { pushManager, Notification } = stubBrowser({ existing: true, permission: 'granted' });
    const calls = stubFetch();
    await push().subscribe();
    expect(Notification.requestPermission).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /v1/apps/cycle/push/subscriptions',
    ]);
  });

  it('throws PushPermissionDeniedError when the user declines', async () => {
    const { pushManager } = stubBrowser({ grant: 'denied' });
    const calls = stubFetch();
    await expect(push().subscribe()).rejects.toBeInstanceOf(PushPermissionDeniedError);
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('throws PushNotSignedInError without a session, before prompting', async () => {
    const { Notification } = stubBrowser();
    await expect(push(null).subscribe()).rejects.toBeInstanceOf(PushNotSignedInError);
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('throws PushNotSupportedError with the reason', async () => {
    stubBrowser({ userAgent: IPHONE, pushManager: false, standalone: false });
    const err = await push()
      .subscribe()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushNotSupportedError);
    expect((err as PushNotSupportedError).reason).toBe('requires-home-screen');
  });

  it('throws PushNotConfiguredError while the platform has no VAPID key (503)', async () => {
    stubBrowser();
    stubFetch({
      'GET /v1/push/vapid-public-key': () => Response.json({ error: 'x' }, { status: 503 }),
    });
    await expect(push().subscribe()).rejects.toBeInstanceOf(PushNotConfiguredError);
  });

  it('signs out locally and throws PushNotSignedInError on a 401', async () => {
    stubBrowser();
    stubFetch({
      'POST /v1/apps/cycle/push/subscriptions': () => new Response(null, { status: 401 }),
    });
    const auth = fakeAuth('stale');
    await expect(new Push('cycle', API, auth).subscribe()).rejects.toBeInstanceOf(
      PushNotSignedInError,
    );
    expect(auth.handleUnauthorized).toHaveBeenCalledOnce();
  });
});

describe('unsubscribe', () => {
  it('removes the device on the server, then unsubscribes the browser', async () => {
    const { subscription } = stubBrowser({ existing: true });
    const calls = stubFetch();
    await push().unsubscribe();
    expect(calls).toEqual([
      {
        url: '/v1/apps/cycle/push/subscriptions',
        method: 'DELETE',
        body: { endpoint: SUB_JSON.endpoint },
        auth: 'Bearer tok',
      },
    ]);
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  });

  it("still unsubscribes the browser when the server didn't know the device (404)", async () => {
    const { subscription } = stubBrowser({ existing: true });
    stubFetch({
      'DELETE /v1/apps/cycle/push/subscriptions': () => new Response(null, { status: 404 }),
    });
    await push().unsubscribe();
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  });

  it('does nothing when this device has no subscription', async () => {
    stubBrowser();
    const calls = stubFetch();
    await push().unsubscribe();
    expect(calls).toHaveLength(0);
  });
});

describe('schedule, cancel, list', () => {
  const stored = {
    reminderId: 'log',
    rule: { type: 'daily', time: '21:00' },
    tz: 'Europe/London',
    quietHours: { start: '22:00', end: '07:00' },
    nextAt: Date.UTC(2026, 9, 16, 20, 0),
    createdAt: 1,
  };

  it.each([
    [{ daily: '21:00' }, { type: 'daily', time: '21:00' }],
    [
      { everyDays: 28, at: '09:00' },
      { type: 'every', days: 28, time: '09:00' },
    ],
    [{ at: new Date(Date.UTC(2026, 10, 2, 9)) }, { type: 'at', at: Date.UTC(2026, 10, 2, 9) }],
    [{ at: '2026-11-02T09:00:00Z' }, { type: 'at', at: Date.UTC(2026, 10, 2, 9) }],
  ])('schedule(%j) sends rule %j', async (when, rule) => {
    const calls = stubFetch({
      'PUT /v1/apps/cycle/push/schedules/log': () => Response.json(stored, { status: 201 }),
    });
    const reminder = await push().schedule('log', when, {
      tz: 'Europe/London',
      quietHours: { start: '22:00', end: '07:00' },
    });
    expect(calls[0]).toEqual({
      url: '/v1/apps/cycle/push/schedules/log',
      method: 'PUT',
      body: { rule, tz: 'Europe/London', quietHours: { start: '22:00', end: '07:00' } },
      auth: 'Bearer tok',
    });
    expect(reminder).toEqual({
      reminderId: 'log',
      when: { daily: '21:00' },
      tz: 'Europe/London',
      quietHours: { start: '22:00', end: '07:00' },
      nextAt: new Date(stored.nextAt),
    });
  });

  it("defaults tz to the device's time zone", async () => {
    const calls = stubFetch({
      'PUT /v1/apps/cycle/push/schedules/log': () => Response.json(stored, { status: 201 }),
    });
    await push().schedule('log', { daily: '21:00' });
    const body = calls[0]?.body as { tz: string };
    expect(body.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(body).not.toHaveProperty('quietHours');
  });

  it("surfaces the server's validation error", async () => {
    stubFetch({
      'PUT /v1/apps/cycle/push/schedules/log': () =>
        Response.json({ error: 'rule.time must be HH:MM (24-hour)' }, { status: 400 }),
    });
    await expect(push().schedule('log', { daily: '9pm' })).rejects.toThrow(/HH:MM/);
  });

  it('throws PushNotSignedInError without a session', async () => {
    const calls = stubFetch();
    await expect(push(null).schedule('log', { daily: '21:00' })).rejects.toBeInstanceOf(
      PushNotSignedInError,
    );
    await expect(push(null).cancel('log')).rejects.toBeInstanceOf(PushNotSignedInError);
    await expect(push(null).list()).rejects.toBeInstanceOf(PushNotSignedInError);
    expect(calls).toHaveLength(0);
  });

  it('cancel deletes the reminder, and ignores one that is already gone', async () => {
    const calls = stubFetch({
      'DELETE /v1/apps/cycle/push/schedules/gone': () => new Response(null, { status: 404 }),
    });
    await push().cancel('log');
    await push().cancel('gone');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'DELETE /v1/apps/cycle/push/schedules/log',
      'DELETE /v1/apps/cycle/push/schedules/gone',
    ]);
  });

  it('list returns the reminders in SDK form', async () => {
    stubFetch({
      'GET /v1/apps/cycle/push/schedules': () =>
        Response.json({
          schedules: [
            stored,
            {
              ...stored,
              reminderId: 'once',
              rule: { type: 'at', at: 1_800_000_000_000 },
              quietHours: null,
            },
          ],
        }),
    });
    const reminders = await push().list();
    expect(reminders.map((r) => [r.reminderId, r.when, r.quietHours])).toEqual([
      ['log', { daily: '21:00' }, { start: '22:00', end: '07:00' }],
      ['once', { at: new Date(1_800_000_000_000) }, null],
    ]);
    expect(reminders[0]?.nextAt).toEqual(new Date(stored.nextAt));
  });
});

describe('registerFasPushHandler (service worker)', () => {
  function stubServiceWorker(
    windows: Array<{
      url: string;
      focus: ReturnType<typeof vi.fn>;
      navigate?: ReturnType<typeof vi.fn>;
    }> = [],
  ) {
    const listeners: Record<string, (event: unknown) => void> = {};
    const scope = {
      registration: {
        scope: 'https://cycle.freeappstore.online/',
        showNotification: vi.fn(async () => {}),
      },
      clients: { matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null) },
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners[type] = fn;
      },
    };
    vi.stubGlobal('registration', scope.registration);
    vi.stubGlobal('clients', scope.clients);
    vi.stubGlobal('addEventListener', scope.addEventListener);
    const fire = async (type: string, extra: Record<string, unknown> = {}) => {
      let pending: Promise<unknown> = Promise.resolve();
      listeners[type]?.({ waitUntil: (p: Promise<unknown>) => (pending = p), ...extra });
      await pending;
    };
    return { scope, fire };
  }

  it('shows a generic notification for each push (pushes carry no payload)', async () => {
    const { scope, fire } = stubServiceWorker();
    registerFasPushHandler({ title: 'Cycle', body: 'Time to check in.' });
    await fire('push');
    expect(scope.registration.showNotification).toHaveBeenCalledWith('Cycle', {
      body: 'Time to check in.',
      icon: '/icon-192.png',
      tag: 'fas-push',
    });
  });

  it('opens the app when tapped and no window is open', async () => {
    const { scope, fire } = stubServiceWorker();
    registerFasPushHandler();
    const close = vi.fn();
    await fire('notificationclick', { notification: { close } });
    expect(close).toHaveBeenCalled();
    expect(scope.clients.openWindow).toHaveBeenCalledWith('https://cycle.freeappstore.online/');
  });

  it("focuses an open window and moves it to onClick's URL", async () => {
    const win = {
      url: 'https://cycle.freeappstore.online/',
      focus: vi.fn(async () => {}),
      navigate: vi.fn(async () => {}),
    };
    const { scope, fire } = stubServiceWorker([win]);
    registerFasPushHandler({ onClick: () => '/calendar' });
    await fire('notificationclick', { notification: { close: vi.fn() } });
    expect(win.focus).toHaveBeenCalled();
    expect(win.navigate).toHaveBeenCalledWith('https://cycle.freeappstore.online/calendar');
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });
});
