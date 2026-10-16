/** Transactional email sender — native Cloudflare Email Service binding. */

export interface SendEmailOpts {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(email: SendEmail, opts: SendEmailOpts): Promise<void> {
  await email.send({
    from: { email: 'auth@freeappstore.online', name: 'FreeAppStore' },
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });
}

/** Normalize for storage + dedup: trim + lowercase. No validation here. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Minimal RFC 5322-ish validation. Cheaper than a full parser; good enough for a gate. */
export function isLikelyEmail(email: string): boolean {
  if (email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
