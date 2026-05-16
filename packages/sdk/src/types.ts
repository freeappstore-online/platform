/** Authenticated user profile from GitHub OAuth. */
export interface User {
  id: string;
  login: string;
  avatarUrl: string | null;
}

/** Options for initializing the SDK via `initApp()`. */
export interface FasInitOptions {
  /** The app's unique identifier (e.g. "tuner", "quicknotes"). */
  appId: string;
  /** Override the API base URL (defaults to https://api.freeappstore.online). */
  apiBase?: string;
}

/** Callback returned by subscribe methods — call to unsubscribe. */
export type Unsubscribe = () => void;
