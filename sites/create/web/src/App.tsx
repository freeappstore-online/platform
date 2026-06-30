import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthContext, useAuthProvider } from "./hooks/useAuth";
import { Create } from "./pages/Create";
import { Profile } from "./pages/Profile";
import { Publish } from "./pages/Publish";
import { Admin } from "./pages/Admin";
import { AppKeys } from "./pages/AppKeys";

export default function App() {
  const auth = useAuthProvider();

  return (
    <AuthContext.Provider value={auth}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Create />} />
          {/* Per-app URL — bookmarkable / pin-to-home-screen, scoped to one app. */}
          <Route path="/app/:id" element={<Create />} />
          {/* Per-app developer API keys (third-party proxy secrets). */}
          <Route path="/app/:id/keys" element={<AppKeys />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/publish" element={<Publish />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthContext.Provider>
  );
}
