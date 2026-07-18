import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { getSession, handleAuthCallback, getSignInUrl, signOut as clearSession, type User } from "../lib/api";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signIn: () => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  signIn: () => {},
  signOut: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export { AuthContext };

export function useAuthProvider(): AuthContextValue {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // Check for OAuth callback hash first
        const callbackSession = await handleAuthCallback();
        if (callbackSession) {
          setUser(callbackSession.user);
          return;
        }
        // Otherwise restore from localStorage
        const session = getSession();
        if (session) setUser(session.user);
      } catch {
        // not authenticated
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const signIn = useCallback(() => {
    window.location.href = getSignInUrl(window.location.href);
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setUser(null);
  }, []);

  return { user, loading, signIn, signOut };
}
