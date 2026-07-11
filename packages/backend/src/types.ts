export interface Env {
  DB: D1Database;
  ROOM: DurableObjectNamespace;
  /**
   * Optional R2 bucket for daily D1 backups. Bound only when R2 is
   * enabled on the CF account; the daily cron skips the backup if
   * this binding is missing.
   */
  BACKUPS?: R2Bucket;
  /**
   * R2 bucket holding deployed app assets. The host Worker serves app
   * content from here; the backend reads VCQA quality reports and badges
   * for the /v1/apps/:id/quality endpoint.
   */
  APPS_BUCKET?: R2Bucket;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Apple Sign In — Service ID (client_id), Team ID, Key ID, and PKCS#8 private key. */
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  /** Base64-encoded PKCS#8 private key (the .p8 file content, base64'd for env var storage). */
  APPLE_PRIVATE_KEY?: string;
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
  /**
   * Provisioning control-plane token shared ONLY with the admin Worker
   * (freeappstore-admin). Authenticates both directions: backend→admin
   * (/api/provision) and admin→backend (/v1/internal analytics callbacks).
   * Sourced from Doppler (fas/prd ADMIN_PROVISION_TOKEN) and synced to both
   * workers by CI — never set by hand. Internal routes 403 when unset.
   */
  ADMIN_PROVISION_TOKEN?: string;
  /**
   * Separate token for cross-store app registration (PAS → FAS
   * /v1/internal/register-app). Distinct from ADMIN_PROVISION_TOKEN so a PAS
   * compromise can't reach the provisioning plane. Doppler: CROSS_STORE_REGISTER_TOKEN.
   */
  CROSS_STORE_REGISTER_TOKEN?: string;
  /**
   * Workers Analytics Engine dataset binding. Each page-view from the
   * `/v1/analytics.js` loader writes one row; per-app rollups + the
   * `/v1/apps/:id/analytics/stats` dashboard query against this dataset
   * via CF's SQL API. Optional — analytics still works without it (CF Web
   * Analytics + BYO tags), but the in-platform dashboard returns "no data".
   */
  ANALYTICS?: AnalyticsEngineDataset;
  /**
   * CF API token with read access to Workers Analytics Engine ('Workers
   * Tail Logs:Read' + 'Account Analytics:Read'). Used by the stats endpoint
   * to query the dataset via the SQL API. Without it, /stats returns 503.
   */
  CF_ANALYTICS_API_TOKEN?: string;
  /** CF account ID; needed for the Analytics Engine SQL API endpoint. */
  CF_ACCOUNT_ID?: string;
  /**
   * Comma-separated GitHub logins (e.g. "serge-ivo,other-admin") allowed to
   * call admin-only endpoints — currently just /v1/analytics/admin/platform
   * which aggregates across all apps. Optional; when unset, no user is admin
   * and admin endpoints 403. Set via `wrangler secret put ADMIN_GITHUB_LOGINS`.
   */
  ADMIN_GITHUB_LOGINS?: string;
  /** Platform-funded AI provider keys used by complimentary VibeCode grants. */
  COMP_KEY_OPENAI?: string;
  COMP_KEY_ANTHROPIC?: string;
  COMP_KEY_GOOGLE?: string;
}

export interface SessionPayload {
  uid: string;
  /** Optional display/login claim from external credential issuers. */
  login?: string;
  /** Platform-level roles: 'user', 'creator', 'admin'. */
  roles?: string[];
  /** Per-app roles assigned by app creators: { appId: ['moderator', ...] }. */
  appRoles?: Record<string, string[]>;
  iat: number;
  exp: number;
}
