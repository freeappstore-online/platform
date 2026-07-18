import { useState, useRef, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useTheme } from "../lib/theme";

function ThemeToggle() {
  const { pref, cycle } = useTheme();
  const icon = pref === "dark" ? "☽" : pref === "light" ? "☀︎" : "◑";
  const label = pref === "system" ? "Theme: system" : pref === "light" ? "Theme: light" : "Theme: dark";
  return (
    <button
      onClick={cycle}
      title={label}
      aria-label={label}
      style={{
        width: 36, height: 36, borderRadius: "999px", border: "1px solid var(--line)",
        background: "var(--panel)", color: "var(--ink)", cursor: "pointer", fontSize: "0.95rem",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <span aria-hidden>{icon}</span>
    </button>
  );
}

const NAV_LINKS = [
  { to: "https://freeappstore.online", label: "Apps", external: true },
  { to: "https://freegamestore.online", label: "Games", external: true },
  { to: "https://freeappstore.online/about.html", label: "About", external: true },
  { to: "https://freeappstore.online/build-with-ai.html", label: "Build", external: true },
  { to: "/", label: "VibeCode" },
  { to: "https://proappstore.online", label: "Pro", external: true, className: "pro-link" },
];

export function Nav() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);
  const { user, signIn, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!avatarMenuOpen) return;
    function handleClick(e: MouseEvent) {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) {
        setAvatarMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [avatarMenuOpen]);

  return (
    <header className="border-b" style={{ borderColor: "var(--line)", padding: "0.75rem 0" }}>
      <div className="container flex items-center justify-between">
        <Link to="/" className="font-display text-2xl font-extrabold tracking-tight no-underline" style={{ color: "var(--ink-strong)" }}>
          Free <span style={{ color: "var(--accent)" }}>Apps</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden sm:flex items-center gap-5">
          <ThemeToggle />
          {NAV_LINKS.map((link) =>
            link.external ? (
              <a
                key={link.to}
                href={link.to}
                className={`text-sm font-semibold no-underline ${link.className || ""}`}
                style={{ color: link.className === "pro-link" ? "var(--pro)" : "var(--muted)" }}
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.to}
                to={link.to}
                className="text-sm font-semibold no-underline"
                style={{ color: location.pathname === link.to ? "var(--ink)" : "var(--muted)" }}
              >
                {link.label}
              </Link>
            ),
          )}
          {user ? (
            <div ref={avatarRef} style={{ position: "relative" }}>
              <button
                onClick={() => setAvatarMenuOpen(!avatarMenuOpen)}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
              >
                <img
                  src={user.avatarUrl || ""}
                  alt={user.login}
                  className="rounded-full border-2"
                  style={{ width: 28, height: 28, borderColor: avatarMenuOpen ? "var(--accent)" : "var(--line)" }}
                />
              </button>
              {avatarMenuOpen && (
                <div
                  className="absolute right-0 mt-2 rounded-xl border shadow-lg"
                  style={{ background: "var(--panel)", borderColor: "var(--line)", width: 200, zIndex: 100, padding: "0.5rem 0" }}
                >
                  <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--line)" }}>
                    <div className="text-sm font-semibold truncate">{user.login}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>GitHub</div>
                  </div>
                  <button
                    onClick={() => { setAvatarMenuOpen(false); navigate("/profile"); }}
                    className="w-full text-left px-3 py-2 text-sm"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink)" }}
                  >
                    Profile & Settings
                  </button>
                  <button
                    onClick={() => { setAvatarMenuOpen(false); navigate("/admin"); }}
                    className="w-full text-left px-3 py-2 text-sm"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink)" }}
                  >
                    Admin
                  </button>
                  <div style={{ borderTop: "1px solid var(--line)", margin: "0.25rem 0" }} />
                  <button
                    onClick={() => { setAvatarMenuOpen(false); signOut(); navigate("/"); }}
                    className="w-full text-left px-3 py-2 text-sm"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)" }}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={signIn}
              className="text-sm font-semibold"
              style={{ color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
            >
              Sign in
            </button>
          )}
        </nav>

        {/* Mobile controls */}
        <div className="flex items-center gap-2 sm:hidden">
          <ThemeToggle />
          <button
            onClick={() => setMenuOpen(true)}
            style={{ width: 36, height: 36, background: "none", border: "1px solid var(--line)", borderRadius: "999px", fontSize: "1.1rem", color: "var(--ink)", cursor: "pointer" }}
            aria-label="Menu"
          >
            &#9776;
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            style={{ background: "rgba(0,0,0,0.3)" }}
            onClick={() => setMenuOpen(false)}
          />
          <nav
            className="fixed top-0 right-0 z-50 flex flex-col gap-1 p-4"
            style={{
              width: 220,
              height: "100dvh",
              background: "var(--panel)",
              borderLeft: "1px solid var(--line)",
              boxShadow: "-4px 0 20px rgba(0,0,0,0.1)",
            }}
          >
            <button
              onClick={() => setMenuOpen(false)}
              className="self-end mb-2"
              style={{ background: "none", border: "none", color: "var(--muted)", fontSize: "1rem", cursor: "pointer" }}
            >
              &#10005;
            </button>
            {NAV_LINKS.map((link) =>
              link.external ? (
                <a
                  key={link.to}
                  href={link.to}
                  className="block py-2 text-base font-semibold no-underline"
                  style={{ color: link.className === "pro-link" ? "var(--pro)" : "var(--muted)" }}
                  onClick={() => setMenuOpen(false)}
                >
                  {link.label}
                </a>
              ) : (
                <Link
                  key={link.to}
                  to={link.to}
                  className="block py-2 text-base font-semibold no-underline"
                  style={{ color: location.pathname === link.to ? "var(--ink)" : "var(--muted)" }}
                  onClick={() => setMenuOpen(false)}
                >
                  {link.label}
                </Link>
              ),
            )}
            {user ? (
              <>
                <Link to="/profile" className="flex items-center gap-2 mt-4" onClick={() => setMenuOpen(false)}>
                  <img
                    src={user.avatarUrl || ""}
                    alt={user.login}
                    className="rounded-full"
                    style={{ width: 24, height: 24 }}
                  />
                  <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{user.login}</span>
                </Link>
                <button
                  onClick={() => { setMenuOpen(false); signOut(); navigate("/"); }}
                  className="mt-2 text-sm"
                  style={{ color: "var(--danger)", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                onClick={() => { setMenuOpen(false); signIn(); }}
                className="mt-4 text-sm font-semibold"
                style={{ color: "var(--accent)", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
              >
                Sign in
              </button>
            )}
          </nav>
        </>
      )}
    </header>
  );
}
