export interface Env {
  DB: D1Database;
  ROOM: DurableObjectNamespace;
  /**
   * Optional R2 bucket for daily D1 backups. Bound only when R2 is
   * enabled on the CF account; the daily cron skips the backup if
   * this binding is missing.
   */
  BACKUPS?: R2Bucket;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Resend API key for transactional email (magic-link auth).
   * Optional so the Worker boots without it in dev; the /auth/email/*
   * routes return 503 when unset.
   */
  RESEND_API_KEY?: string;
  /**
   * From address for transactional email, e.g.
   * "FreeAppStore <auth@freeappstore.online>". Required for email auth.
   */
  EMAIL_FROM?: string;
  SESSION_SIGNING_KEY: string;
  /**
   * Master key-encryption-key for the app-secret proxy. 32 random bytes,
   * base64-encoded. Set with: `wrangler secret put APP_SECRET_KEK`.
   * Optional only so the Worker can boot without it in dev; the secret
   * routes will 503 if unset.
   */
  APP_SECRET_KEK?: string;
  /**
   * Service binding to the admin Worker. When present (production), /v1/publish
   * calls admin's /api/provision via env.ADMIN.fetch — direct worker-to-worker,
   * no CF edge round-trip, no CF Access gate (intentional: both are trusted
   * internal). Replaced the earlier ADMIN_API_BASE + service-token approach
   * which was hitting 522 due to edge loop detection between two CF Workers
   * on the same custom-domain zone.
   */
  ADMIN?: Fetcher;
}

export interface SessionPayload {
  uid: string;
  iat: number;
  exp: number;
}
