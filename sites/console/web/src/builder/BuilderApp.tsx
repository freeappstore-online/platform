import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthContext, useAuthProvider } from "./hooks/useAuth";
import { Create } from "./pages/Create";
import { Profile } from "./pages/Profile";
import { Admin } from "./pages/Admin";
import { AppKeys } from "./pages/AppKeys";

/**
 * The VibeCode builder, folded into the console as a self-contained island
 * (ported verbatim from the former create.freeappstore.online app).
 *
 * Mounted at /build — `basename` is passed in BASE-aware ("/build" on the
 * console origin, "/app/build" under the storefront proxy). It keeps its own
 * react-router and hand-rolled auth, which reads the shared `fas:session`
 * localStorage key the console SDK also writes — so on this one origin the
 * session is shared and no re-login is needed.
 *
 * Publishing lives in the console now, so /publish bounces back out to it.
 */
export default function BuilderApp({ basename }: { basename: string }) {
  const auth = useAuthProvider();
  return (
    <AuthContext.Provider value={auth}>
      <BrowserRouter basename={basename}>
        <Routes>
          <Route path="/" element={<Create />} />
          {/* Per-app URL — bookmarkable / pin-to-home-screen, scoped to one app. */}
          <Route path="/app/:id" element={<Create />} />
          {/* Per-app developer API keys (third-party proxy secrets). */}
          <Route path="/app/:id/keys" element={<AppKeys />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/publish" element={<PublishRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthContext.Provider>
  );
}

/** Publishing moved into the console; send any /build/publish hit there. */
function PublishRedirect() {
  useEffect(() => {
    const base = window.location.pathname.startsWith("/app") ? "/app" : "";
    window.location.replace(`${base}/publish`);
  }, []);
  return null;
}
