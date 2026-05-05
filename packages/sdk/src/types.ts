export interface User {
  id: string;
  login: string;
  avatarUrl: string | null;
}

export interface FasInitOptions {
  appId: string;
  apiBase?: string;
}

export type Unsubscribe = () => void;
