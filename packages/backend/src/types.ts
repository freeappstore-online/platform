export interface Env {
  DB: D1Database;
  ROOM: DurableObjectNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SIGNING_KEY: string;
}

export interface SessionPayload {
  uid: string;
  iat: number;
  exp: number;
}
