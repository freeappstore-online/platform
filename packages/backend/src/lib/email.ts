/** Transactional email sender — native Cloudflare Email Service binding. */

export interface SendEmailOpts {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Mailbox that should receive replies from recipients. */
  replyTo?: string;
  /** Platform sender identity; only Cloudflare-allowlisted addresses are valid. */
  sender?: 'auth' | 'noreply';
}

const FROM_ADDRESSES = {
  auth: { email: 'auth@freeappstore.online', name: 'FreeAppStore' },
  noreply: { email: 'noreply@freeappstore.online', name: 'FreeAppStore' },
} as const;

export async function sendEmail(email: SendEmail, opts: SendEmailOpts): Promise<void> {
  await email.send({
    from: FROM_ADDRESSES[opts.sender ?? 'auth'],
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
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
