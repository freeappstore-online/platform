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

function setSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

/** Capture #fas_session= from URL hash after OAuth redirect */
export async function handleAuthCallback(): Promise<Session | null> {
  const hash = window.location.hash;
  if (!hash.startsWith("#fas_session=")) return null;

  // Clear hash immediately so reload won't retry
  history.replaceState(null, "", window.location.pathname + window.location.search);

  let token: string;
  try {
    token = decodeURIComponent(hash.slice("#fas_session=".length));
  } catch {
    return null;
  }
  if (!token) return null;

  const res = await fetch(`${API_URL}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;

  const user = (await res.json()) as User;
  const session = { token, user };
  setSession(session);
  return session;
}

export function getSignInUrl(redirect: string): string {
  const url = new URL("/v1/auth/github/start", API_URL);
  url.searchParams.set("app_id", "create");
  url.searchParams.set("return_to", redirect);
  return url.toString();
}

export function signOut(): void {
  localStorage.removeItem(SESSION_KEY);
}
