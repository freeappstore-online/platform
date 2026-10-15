/**
 * Service-worker side of `fas.push`. Import it in your service worker entry
 * (vite-plugin-pwa `strategies: 'injectManifest'`, e.g. `src/sw.ts`):
 *
 * ```ts
 * import { registerFasPushHandler } from '@freeappstore/sdk/push-sw'
 * registerFasPushHandler({ title: 'Cycle', body: 'Time to check in.' })
 * ```
 *
 * Pushes from the platform carry no payload, so the reminder's text lives
 * here, in your app, and nothing about it passes through the browser's push
 * service. Keep it generic for anything sensitive ("Check your calendar"),
 * since it can show on a lock screen. Tapping the notification focuses an
 * open window of the app, or opens one.
 */

export interface FasPushHandlerOptions {
  /** Notification title. Default: 'Reminder'. */
  title?: string;
  /** Notification body. Default: 'Open the app to see what\'s due.' */
  body?: string;
  /** Icon URL. Default: '/icon-192.png' (the template's icon). */
  icon?: string;
  /** Replaces an earlier notification with the same tag instead of stacking. Default: 'fas-push'. */
  tag?: string;
  /** The URL to open or focus when tapped. Default: the service worker's scope (the app's start). */
  onClick?: () => string;
}

// Just the service-worker types used here; the SDK compiles against the DOM lib.
interface SwNotification {
  close(): void;
}
interface SwExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface SwNotificationEvent extends SwExtendableEvent {
  readonly notification: SwNotification;
}
interface SwWindowClient {
  readonly url: string;
  focus(): Promise<unknown>;
  navigate?(url: string): Promise<unknown>;
}
interface SwScope {
  registration: {
    scope: string;
    showNotification(title: string, options?: NotificationOptions): Promise<void>;
  };
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<SwWindowClient[]>;
    openWindow(url: string): Promise<unknown>;
  };
  addEventListener(type: 'push' | 'notificationclick', listener: (event: Event) => void): void;
}

/** Shows a notification for each fas.push push and focuses or opens the app when it's tapped. */
export function registerFasPushHandler(opts: FasPushHandlerOptions = {}): void {
  const sw = globalThis as unknown as SwScope;

  sw.addEventListener('push', (event) => {
    (event as SwExtendableEvent).waitUntil(
      sw.registration.showNotification(opts.title ?? 'Reminder', {
        body: opts.body ?? "Open the app to see what's due.",
        icon: opts.icon ?? '/icon-192.png',
        tag: opts.tag ?? 'fas-push',
      }),
    );
  });

  sw.addEventListener('notificationclick', (event) => {
    const e = event as SwNotificationEvent;
    e.notification.close();
    const target = new URL(opts.onClick?.() ?? sw.registration.scope, sw.registration.scope).href;
    e.waitUntil(
      sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
        const open = windows.find((w) => w.url.startsWith(sw.registration.scope));
        if (!open) return sw.clients.openWindow(target);
        await open.focus();
        if (open.url !== target && open.navigate) await open.navigate(target);
      }),
    );
  });
}
