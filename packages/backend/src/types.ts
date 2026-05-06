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
  SESSION_SIGNING_KEY: string;
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
