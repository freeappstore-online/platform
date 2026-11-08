const API_URL = "https://api.freeappstore.online";
const AGENT_URL = "https://agent.freeappstore.online";

export { API_URL, AGENT_URL };

export interface User {
  id: string;
  login: string;
  avatarUrl: string | null;
}

const SESSION_KEY = "fas:session";

interface Session {
  token: string;
  user: User;
}

export function getSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

/** JSON request headers, with the session's bearer token when signed in. */
export function authHeaders(): Record<string, string> {
  const s = getSession();
  return s?.token
    ? { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

function setSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

const CLIENT_STATE_KEY = "fas:auth-state";

/** The value this browser sends at sign-in start, shared with the SDK on this origin (#564). */
function clientState(): string {
  let value = localStorage.getItem(CLIENT_STATE_KEY);
  if (!value) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    value = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(CLIENT_STATE_KEY, value);
  }
  return value;
}

function claimClientState(state: string | undefined): boolean {
  if (!state || localStorage.getItem(CLIENT_STATE_KEY) !== state) return false;
  localStorage.removeItem(CLIENT_STATE_KEY);
  return true;
}

/** Capture #fas_session= from URL hash after OAuth redirect */
export async function handleAuthCallback(): Promise<Session | null> {
  const hash = window.location.hash;
  if (!hash.startsWith("#fas_session=")) return null;

  // Clear hash immediately so reload won't retry
  history.replaceState(null, "", window.location.pathname + window.location.search);

  const [rawToken = "", state] = hash.slice("#fas_session=".length).split("&fas_state=");
  let token: string;
  try {
    token = decodeURIComponent(rawToken);
  } catch {
    return null;
  }
  if (!token) return null;
  const startedHere = claimClientState(state);

  const res = await fetch(`${API_URL}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;

  const user = (await res.json()) as User;
  // A session this browser did not ask for may be someone else's account (#564).
  if (!startedHere && !window.confirm(`Sign in as ${user.login}?`)) return null;
  const session = { token, user };
  setSession(session);
  return session;
}

export function getSignInUrl(redirect: string): string {
  const url = new URL("/v1/auth/github/start", API_URL);
  // The builder is part of the console (same origin, same session): it signs
  // in as the console so its token can publish (#495). "create" is reserved.
  url.searchParams.set("app_id", "console");
  url.searchParams.set("return_to", redirect);
  url.searchParams.set("client_state", clientState());
  return url.toString();
}

export function signOut(): void {
  localStorage.removeItem(SESSION_KEY);
}
