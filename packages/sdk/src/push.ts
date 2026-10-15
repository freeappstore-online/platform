import type { Auth } from './auth.js';

/**
 * Web Push reminders for the signed-in user (`fas.push`).
 *
 * Register this device with `subscribe()` (from a user gesture), then set
 * reminders with `schedule()`; the platform sends a push to every device the
 * user subscribed for this app when a reminder comes due (every 15 minutes,
 * so up to ~15 min late). Pushes carry no payload: the app's service worker
 * shows its own notification text, so nothing about the reminder travels
 * through the browser's push service. Use `@freeappstore/sdk/push-sw` in the
 * service worker.
 *
 * Limits (enforced server-side): 10 devices and 20 reminders per user per app.
 */

/** No session: sign in before subscribing or scheduling. */
export class PushNotSignedInError extends Error {
  constructor() {
    super('Not signed in.');
    this.name = 'PushNotSignedInError';
  }
}

/** This browser can't receive push here; `reason` says why (see `PushIsSupported`). */
export class PushNotSupportedError extends Error {
  constructor(readonly reason: Exclude<PushSupportReason, 'ok'>) {
    super(
      reason === 'requires-home-screen'
        ? 'Notifications need the app installed: on iPhone and iPad, Share → Add to Home Screen, then open it from there.'
        : "This browser doesn't support push notifications.",
    );
    this.name = 'PushNotSupportedError';
  }
}

/** The user declined (or previously blocked) notifications for this site. */
export class PushPermissionDeniedError extends Error {
  constructor() {
    super('Notification permission was not granted.');
    this.name = 'PushPermissionDeniedError';
  }
}

/** The platform has push turned off (its VAPID key isn't configured yet). */
export class PushNotConfiguredError extends Error {
  constructor() {
    super('Push notifications are not available on the platform yet.');
    this.name = 'PushNotConfiguredError';
  }
}

export type PushSupportReason = 'ok' | 'requires-home-screen' | 'browser-unsupported';

export interface PushIsSupported {
  supported: boolean;
  /**
   * `'requires-home-screen'`: iPhone/iPad Safari only allows web push for
   * apps added to the Home Screen and opened from there.
   */
  reason: PushSupportReason;
}

/** When a reminder fires. Times are wall-clock `HH:MM` (24-hour) in `tz`. */
export type PushWhen =
  /** Once, at this instant. */
  | { at: Date | string | number }
  /** Every day at this time. */
  | { daily: string }
  /** Every N days at `at` (HH:MM). */
  | { everyDays: number; at: string };

export interface PushScheduleOptions {
  /** IANA time zone, e.g. 'Europe/London'. Defaults to this device's zone. */
  tz?: string;
  /** Hold reminders that fall inside this daily window until it ends (may wrap midnight). */
  quietHours?: { start: string; end: string };
}

export interface PushReminder {
  reminderId: string;
  when: PushWhen;
  tz: string;
  quietHours: { start: string; end: string } | null;
  /** When it will next be sent. */
  nextAt: Date;
}

type BackendRule =
  | { type: 'at'; at: number }
  | { type: 'daily'; time: string }
  | { type: 'every'; days: number; time: string };

interface BackendSchedule {
  reminderId: string;
  rule: BackendRule;
  tz: string;
  quietHours: { start: string; end: string } | null;
  nextAt: number;
}

function toRule(when: PushWhen): BackendRule {
  if ('daily' in when) return { type: 'daily', time: when.daily };
  if ('everyDays' in when) return { type: 'every', days: when.everyDays, time: when.at };
  const at =
    when.at instanceof Date
      ? when.at.getTime()
      : typeof when.at === 'string'
        ? Date.parse(when.at)
        : when.at;
  if (!Number.isFinite(at)) throw new Error('push: `at` must be a valid date.');
  return { type: 'at', at };
}

function fromRule(rule: BackendRule): PushWhen {
  if (rule.type === 'daily') return { daily: rule.time };
  if (rule.type === 'every') return { everyDays: rule.days, at: rule.time };
  return { at: new Date(rule.at) };
}

/** base64url (the VAPID key format) → bytes for `applicationServerKey`. */
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function isIos(): boolean {
  const nav = navigator as Navigator & { maxTouchPoints?: number };
  return (
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    // iPadOS reports itself as a Mac.
    (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)
  );
}

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
  );
}

export class Push {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  /** Whether this browser can receive push for this app right now, and if not, why. */
  isSupported(): PushIsSupported {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return { supported: false, reason: 'browser-unsupported' };
    }
    // iOS hides the Push API until the app runs from the Home Screen, so check this first.
    if (isIos() && !isStandalone()) return { supported: false, reason: 'requires-home-screen' };
    if (
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)
    ) {
      return { supported: false, reason: 'browser-unsupported' };
    }
    return { supported: true, reason: 'ok' };
  }

  /** The notification permission for this site: 'default' (not asked yet), 'granted' or 'denied'. */
  permission(): NotificationPermission {
    return typeof Notification === 'undefined' ? 'denied' : Notification.permission;
  }

  /**
   * Asks for notification permission and registers this device for the
   * signed-in user. Call it from a user gesture (a button tap): browsers
   * ignore or block permission prompts that aren't. Safe to call again; it
   * re-registers the existing subscription.
   *
   * @throws PushNotSignedInError, PushNotSupportedError, PushPermissionDeniedError, PushNotConfiguredError
   */
  async subscribe(): Promise<void> {
    const token = this.requireToken();
    const support = this.isSupported();
    if (!support.supported)
      throw new PushNotSupportedError(support.reason as Exclude<PushSupportReason, 'ok'>);
    // Ask first, while the user gesture is still active.
    const permission =
      Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') throw new PushPermissionDeniedError();

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(await this.vapidPublicKey()),
      });
    }
    const json = subscription.toJSON();
    await this.request(token, 'POST', '/push/subscriptions', {
      endpoint: json.endpoint,
      keys: json.keys,
    });
  }

  /** Stops push on this device: removes it from the user's devices and unsubscribes the browser. */
  async unsubscribe(): Promise<void> {
    const token = this.requireToken();
    if (!this.isSupported().supported) return;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    await this.request(
      token,
      'DELETE',
      '/push/subscriptions',
      { endpoint: subscription.endpoint },
      [404],
    );
    await subscription.unsubscribe();
  }

  /**
   * Creates or replaces a reminder. `reminderId` is yours to choose
   * (1-64 letters, digits, `_` or `-`); scheduling the same id again replaces it.
   *
   * ```ts
   * await fas.push.schedule('period-due', { at: new Date('2026-11-02T09:00') })
   * await fas.push.schedule('log', { daily: '21:00' }, { quietHours: { start: '22:00', end: '07:00' } })
   * await fas.push.schedule('refill', { everyDays: 28, at: '09:00' }, { tz: 'Europe/London' })
   * ```
   */
  async schedule(
    reminderId: string,
    when: PushWhen,
    opts: PushScheduleOptions = {},
  ): Promise<PushReminder> {
    const token = this.requireToken();
    const body = {
      rule: toRule(when),
      tz: opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(opts.quietHours && { quietHours: opts.quietHours }),
    };
    const res = await this.request(
      token,
      'PUT',
      `/push/schedules/${encodeURIComponent(reminderId)}`,
      body,
    );
    return toReminder((await res.json()) as BackendSchedule);
  }

  /** Cancels a reminder. Does nothing if it doesn't exist. */
  async cancel(reminderId: string): Promise<void> {
    const token = this.requireToken();
    await this.request(
      token,
      'DELETE',
      `/push/schedules/${encodeURIComponent(reminderId)}`,
      undefined,
      [404],
    );
  }

  /** The user's reminders for this app, soonest first. */
  async list(): Promise<PushReminder[]> {
    const token = this.requireToken();
    const res = await this.request(token, 'GET', '/push/schedules');
    const { schedules } = (await res.json()) as { schedules: BackendSchedule[] };
    return schedules.map(toReminder);
  }

  private requireToken(): string {
    const token = this.auth.token;
    if (!token) throw new PushNotSignedInError();
    return token;
  }

  private async vapidPublicKey(): Promise<string> {
    const res = await fetch(new URL('/v1/push/vapid-public-key', this.apiBase));
    if (res.status === 503) throw new PushNotConfiguredError();
    if (!res.ok) throw new Error(`push: couldn't get the VAPID key (${res.status})`);
    return ((await res.json()) as { publicKey: string }).publicKey;
  }

  /** An app-scoped API call; `allow` lists non-2xx statuses to treat as success. */
  private async request(
    token: string,
    method: string,
    path: string,
    body?: unknown,
    allow: number[] = [],
  ): Promise<Response> {
    const res = await fetch(
      new URL(`/v1/apps/${encodeURIComponent(this.appId)}${path}`, this.apiBase),
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      },
    );
    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new PushNotSignedInError();
    }
    if (!res.ok && !allow.includes(res.status)) {
      const detail = await res
        .json()
        .then((j: { error?: string }) => j.error)
        .catch(() => undefined);
      throw new Error(
        `push: ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }
    return res;
  }
}

function toReminder(s: BackendSchedule): PushReminder {
  return {
    reminderId: s.reminderId,
    when: fromRule(s.rule),
    tz: s.tz,
    quietHours: s.quietHours,
    nextAt: new Date(s.nextAt),
  };
}
