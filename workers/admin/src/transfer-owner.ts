/** Admin compare-and-set app ownership transfer (#274). */

import type { AuthResult } from "./auth";

/** FreeAppStore app ids; same as packages/backend/src/lib/apps.ts APP_ID_RE (#279). */
export const APP_ID_RE = /^[a-z][a-z0-9-]{0,29}[a-z0-9]$/;
/** GitHub login: 1–39 of [A-Za-z0-9-], not starting or ending with a hyphen. */
const LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const REASON_MAX = 500;

export interface TransferInput {
  app_id: string;
  from_login: string;
  to_login: string;
  reason: string;
}

export interface TransferAudit {
  id: number;
  app_id: string;
  from_login: string;
  to_login: string;
  reason: string;
  actor_login: string;
  created_at: number;
}

export type TransferOutcome =
  | {
      status: 200;
      body: {
        ok: true;
        app_id: string;
        from_login: string;
        to_login: string;
        owner_login: string;
        audit_id: number;
      };
    }
  | { status: 400; body: { error: string; login?: string } }
  | { status: 404; body: { error: string; app_id: string } }
  | { status: 409; body: { error: string; app_id: string; owner_login: string } };

/** GitHub login of the signed-in admin, or null when this caller is not one.
 *  Service tokens and local bypasses are not an admin session: the audit
 *  record has to name a person. */
export function actorLogin(auth: AuthResult | null): string | null {
  if (!auth?.ok || auth.kind !== "admin") return null;
  const login = (auth.user.githubLogin || auth.user.login || "").trim();
  return login || null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseTransferBody(body: unknown): { ok: true; value: TransferInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const raw = body as Record<string, unknown>;
  const app_id = text(raw.app_id);
  const from_login = text(raw.from_login);
  const to_login = text(raw.to_login);
  const reason = text(raw.reason);
  if (!app_id) return { ok: false, error: "app_id is required" };
  if (!APP_ID_RE.test(app_id)) return { ok: false, error: "invalid app id" };
  if (!from_login) return { ok: false, error: "from_login is required" };
  if (!LOGIN_RE.test(from_login)) return { ok: false, error: "invalid from_login" };
  if (!to_login) return { ok: false, error: "to_login is required" };
  if (!LOGIN_RE.test(to_login)) return { ok: false, error: "invalid to_login" };
  if (!reason) return { ok: false, error: "reason is required" };
  if (reason.length > REASON_MAX) return { ok: false, error: "reason is too long" };
  return { ok: true, value: { app_id, from_login, to_login, reason } };
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

interface AppRow {
  id: string;
  owner_login: string;
}

function changes(result: D1Result | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

async function readApp(db: D1Database, appId: string): Promise<AppRow | null> {
  return db.prepare("SELECT id, owner_login FROM apps WHERE id = ?1").bind(appId).first<AppRow>();
}

/** Canonical `users.github_login` for this login, or null when nobody has it. */
async function canonicalLogin(db: D1Database, login: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT github_login FROM users WHERE lower(github_login) = lower(?1) LIMIT 1")
    .bind(login)
    .first<{ github_login: string }>();
  return row?.github_login ?? null;
}

/**
 * Move `apps.owner_login` from `from_login` to `to_login`.
 *
 * The UPDATE's WHERE is the compare-and-set: it changes a row only when the
 * stored owner still matches `from_login`. The audit insert uses the same
 * predicate and runs in the same batch, so a refused transfer writes nothing.
 *
 * `to_login` must be a real account. `from_login` is checked against the
 * stored owner, not the users table — a departed creator may have no row,
 * and naming that recorded owner is the proof required to move the app.
 */
export async function transferAppOwner(db: D1Database, input: TransferInput, actor: string): Promise<TransferOutcome> {
  const app = await readApp(db, input.app_id);
  if (!app) return { status: 404, body: { error: "unknown app", app_id: input.app_id } };
  if (!same(app.owner_login, input.from_login)) {
    return { status: 409, body: { error: "owner mismatch", app_id: input.app_id, owner_login: app.owner_login } };
  }

  const toLogin = await canonicalLogin(db, input.to_login);
  if (!toLogin) return { status: 400, body: { error: "unknown login", login: input.to_login } };
  if (same(app.owner_login, toLogin)) {
    return { status: 400, body: { error: "app is already owned by this login", login: toLogin } };
  }

  const now = Date.now();
  const insert = db
    .prepare(
      `INSERT INTO app_owner_transfers (app_id, from_login, to_login, reason, actor_login, created_at)
       SELECT ?1, owner_login, ?2, ?3, ?4, ?5
       FROM apps
       WHERE id = ?1 AND lower(owner_login) = lower(?6) AND lower(owner_login) != lower(?2)`,
    )
    .bind(input.app_id, toLogin, input.reason, actor, now, input.from_login);
  const update = db
    .prepare(
      `UPDATE apps SET owner_login = ?1
       WHERE id = ?2 AND lower(owner_login) = lower(?3) AND lower(owner_login) != lower(?1)`,
    )
    .bind(toLogin, input.app_id, input.from_login);

  const [inserted, updated] = await db.batch([insert, update]);
  if (changes(inserted) !== 1 || changes(updated) !== 1) {
    const again = await readApp(db, input.app_id);
    if (!again) return { status: 404, body: { error: "unknown app", app_id: input.app_id } };
    return { status: 409, body: { error: "owner mismatch", app_id: input.app_id, owner_login: again.owner_login } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      app_id: input.app_id,
      from_login: app.owner_login,
      to_login: toLogin,
      owner_login: toLogin,
      audit_id: Number(inserted?.meta?.last_row_id ?? 0),
    },
  };
}

export async function listOwnerTransfers(db: D1Database, appId: string): Promise<TransferAudit[]> {
  const res = await db
    .prepare(
      `SELECT id, app_id, from_login, to_login, reason, actor_login, created_at
       FROM app_owner_transfers
       WHERE app_id = ?1
       ORDER BY id DESC
       LIMIT 50`,
    )
    .bind(appId)
    .all<TransferAudit>();
  return res.results ?? [];
}
