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
   * Admin Worker base URL (e.g. https://admin.freeappstore.online) and the
   * CF Access service token credentials it accepts. Optional: when not set,
   * /v1/publish returns 503 with a setup hint instead of a runtime error.
   */
  ADMIN_API_BASE?: string;
  ADMIN_CF_ACCESS_CLIENT_ID?: string;
  ADMIN_CF_ACCESS_CLIENT_SECRET?: string;
}

export interface SessionPayload {
  uid: string;
  iat: number;
  exp: number;
}
