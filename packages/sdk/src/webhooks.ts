import type { Auth } from './auth.js';

/**
 * Outbound webhook management. Devs register URLs to receive HTTP POST
 * when events fire (user.first_visit, kv.changed, collection.created, etc.).
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
  body: string;
}

export class Webhooks {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.auth.token) h.Authorization = `Bearer ${this.auth.token}`;
    return h;
  }

  /** List all webhooks for this app + supported events. */
  async list(): Promise<{ webhooks: Webhook[]; supported_events: string[] }> {
    const res = await fetch(`${this.apiBase}/v1/apps/${this.appId}/webhooks`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`webhooks.list failed: ${res.status}`);
    return res.json() as Promise<{ webhooks: Webhook[]; supported_events: string[] }>;
  }

  /** Register a new webhook. Returns the webhook ID and signing secret. */
  async create(event: string, url: string): Promise<{ id: string; secret: string }> {
    const res = await fetch(`${this.apiBase}/v1/apps/${this.appId}/webhooks`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ event, url }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`webhooks.create failed: ${data.error ?? res.statusText}`);
    }
    return res.json() as Promise<{ id: string; secret: string }>;
  }

  /** Delete a webhook by ID. */
  async delete(id: string): Promise<void> {
    const res = await fetch(`${this.apiBase}/v1/apps/${this.appId}/webhooks/${id}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`webhooks.delete failed: ${res.status}`);
  }

  /** Send a test event to a webhook. Returns the HTTP status and response body. */
  async test(id: string): Promise<WebhookTestResult> {
    const res = await fetch(`${this.apiBase}/v1/apps/${this.appId}/webhooks/${id}/test`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`webhooks.test failed: ${res.status}`);
    return res.json() as Promise<WebhookTestResult>;
  }
}
