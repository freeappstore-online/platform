import type { AuthResult } from "../auth";
import type { Env } from "../helpers";

export interface RouteContext {
  request: Request;
  env: Env;
  url: URL;
  /** Result of the /api/* auth gate; null for non-/api paths. */
  auth: AuthResult | null;
}

/** A route module: returns a Response if it owns the request, else null so
 *  the router tries the next module. */
export type RouteHandler = (ctx: RouteContext) => Promise<Response | null>;
