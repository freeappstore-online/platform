import { authedFetch, type SessionAuth } from './authed-fetch.js';

/**
 * App transactional email via the platform's Cloudflare Email Service integration.
 *
 * Apps don't need their own email provider. The platform sends on behalf
 * of the app using the platform's managed sending domain.
 *
 * Rate limit: 100 emails/day per app (free tier), 50/day per sender.
 * The app owner may send to any recipient; any other signed-in user must
 * hold a role in the app and may only send to their own verified address.
 */
export class Email {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: SessionAuth,
  ) {}

  /**
   * Send a transactional email.
   *
   * @param to - recipient email address
   * @param subject - email subject (max 200 chars, auto-prefixed with [appId])
   * @param opts - email body (at least one of html or text required)
   */
  async send(to: string, subject: string, opts: { html?: string; text?: string }): Promise<void> {
    if (!opts.html && !opts.text) {
      throw new Error('email.send: at least one of html or text is required.');
    }
    const res = await authedFetch(
      this.auth,
      `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/email/send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, ...opts }),
      },
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`email.send failed: ${data.error ?? res.statusText}`);
    }
  }
}
