import { json } from "../http";
import type { RouteHandler } from "./types";

// Cheap authenticated round-trip target for the backend's /status probe.
// Reaching here means the caller's ADMIN_PROVISION_TOKEN matched (or a valid
// admin session) — i.e. the provisioning auth path is healthy. No side effects.
export const pingRoutes: RouteHandler = async ({ request, url }) => {
  if (url.pathname !== "/api/ping") return null;
  return json({ ok: true, worker: "freeappstore-admin" }, 200, request);
};
