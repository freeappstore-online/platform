import type { Auth } from './auth.js';

/**
 * App transactional email via the platform's Resend integration.
 *
 * Apps don't need their own email provider. The platform sends on behalf
 * of the app using the platform's Resend account.
 *
 * Rate limit: 100 emails/day per app (free tier).
 */
export class Email {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  /**
   * Send a transactional email.
   *
   * @param to - recipient email address
   * @param subject - email subject (max 200 chars, auto-prefixed with [appId])
   * @param opts - email body (at least one of html or text required)
   */
  async send(to: string, subject: string, opts: { html?: string; text?: string }): Promise<void> {
    if (!this.auth.token) {
      throw new Error('email.send: not signed in. Call fas.auth.signIn() first.');
    }
    if (!opts.html && !opts.text) {
      throw new Error('email.send: at least one of html or text is required.');
    }
    const res = await fetch(
      `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/email/send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ to, subject, ...opts }),
      },
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`email.send failed: ${data.error ?? res.statusText}`);
    }
  }
}
