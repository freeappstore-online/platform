import { json } from "../http";
import { ghApi, STORE_CONFIG } from "../publish";
import { APP_ID_RE, actorLogin, listOwnerTransfers, moveRepoAccess, parseTransferBody, transferAppOwner } from "../transfer-owner";
import type { RouteHandler } from "./types";

const PATH = "/api/apps/transfer-owner";

function noStore(res: Response): Response {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** POST transfers an app's owner. GET lists that app's transfer audit. */
export const transferOwnerRoutes: RouteHandler = async ({ request, env, url, auth }) => {
  if (url.pathname !== PATH) return null;
  if (request.method !== "POST" && request.method !== "GET") return null;

  const actor = actorLogin(auth);
  if (!actor) return noStore(json({ error: "admin session required" }, 403, request));

  if (request.method === "GET") {
    const appId = (url.searchParams.get("app_id") ?? "").trim();
    if (!APP_ID_RE.test(appId)) return noStore(json({ error: "invalid app id" }, 400, request));
    try {
      return noStore(json({ transfers: await listOwnerTransfers(env.DB, appId) }, 200, request));
    } catch {
      return noStore(json({ error: "could not read transfers" }, 500, request));
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(json({ error: "expected a JSON object" }, 400, request));
  }
  const parsed = parseTransferBody(body);
  if (!parsed.ok) return noStore(json({ error: parsed.error }, 400, request));

  try {
    const outcome = await transferAppOwner(env.DB, parsed.value, actor);
    if (outcome.status !== 200) return noStore(json(outcome.body, outcome.status, request));
    // Repo push access follows the owner (#279). Reported, not fatal: the
    // ownership change above is committed either way.
    const repoAccess = await moveRepoAccess(
      (path, method, body) => ghApi(env, path, method, body),
      STORE_CONFIG.apps.org,
      outcome.body.app_id,
      outcome.body.from_login,
      outcome.body.to_login,
    );
    return noStore(json({ ...outcome.body, repo_access: repoAccess }, 200, request));
  } catch {
    return noStore(json({ error: "transfer failed" }, 500, request));
  }
};
