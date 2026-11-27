import { authedFetch, type SessionAuth } from './authed-fetch.js';

/**
 * Outbound webhook management for the app owner. Devs register URLs to
 * receive HTTP POST when events fire: friend.requested, friend.accepted,
 * friend.removed, friend.blocked (delivered only to apps both users joined).
 *
 * Registering a webhook is an app setting, so it is console-only (Creator
 * Console → app → Webhooks; the API rejects app sessions, #495). From the app
 * the owner can list, test and delete them.
 *
 * The platform signs each delivery with HMAC-SHA256 using a per-webhook
 * secret (returned at registration time). Receivers verify the signature
 * via the X-FAS-Signature header.
 */

export interface Webhook {
  id: string;
  event: string;
  url: string;
  active: number;
  created_at: number;
}

export interface WebhookTestResult {
  status: number;
}

export class Webhooks {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: SessionAuth,
  ) {}

  private url(suffix = ''): string {
    return `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/webhooks${suffix}`;
  }

  /** List all webhooks for this app + supported events. */
  async list(): Promise<{ webhooks: Webhook[]; supported_events: string[] }> {
    const res = await authedFetch(this.auth, this.url());
    if (!res.ok) throw new Error(`webhooks.list failed: ${res.status}`);
    return res.json() as Promise<{ webhooks: Webhook[]; supported_events: string[] }>;
  }

  /** Delete a webhook by ID. */
  async delete(id: string): Promise<void> {
    const res = await authedFetch(this.auth, this.url(`/${encodeURIComponent(id)}`), {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`webhooks.delete failed: ${res.status}`);
  }

  /** Send a test event to a webhook. Returns the HTTP status the receiver answered with. */
  async test(id: string): Promise<WebhookTestResult> {
    const res = await authedFetch(this.auth, this.url(`/${encodeURIComponent(id)}/test`), {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`webhooks.test failed: ${res.status}`);
    return res.json() as Promise<WebhookTestResult>;
  }
}
