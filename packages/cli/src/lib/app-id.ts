/**
 * Validates an app id. The same shape is enforced by the publisher portal
 * and used for DNS subdomains and repo names.
 *
 * Rules: lowercase letter first, a letter or digit last, [a-z0-9-] between.
 * Total length 2-31. Same as packages/backend/src/lib/apps.ts APP_ID_RE.
 */
const APP_ID_RE = /^[a-z][a-z0-9-]{0,29}[a-z0-9]$/;

export function isValidAppId(s: string): boolean {
  return APP_ID_RE.test(s);
}

export function assertValidAppId(s: string): void {
  if (!isValidAppId(s)) {
    throw new Error(
      'app-id must start with a lowercase letter, end with a letter or digit, and contain only lowercase letters, digits, or hyphens (2-31 chars).',
    );
  }
}
