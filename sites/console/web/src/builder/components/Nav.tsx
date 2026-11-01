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
      className="w-9 h-9 rounded-full border border-line bg-panel text-ink cursor-pointer text-[0.95rem] inline-flex items-center justify-center"
    >
      <span aria-hidden>{icon}</span>
    </button>
  );
}

// Aligned with the console Header's links (this is one app now, not the old
// standalone marketing site). "← Console" is added separately in the component.
const NAV_LINKS = [
  { to: "https://freeappstore.online", label: "Store", external: true },
  { to: "https://freeappstore.online/docs", label: "Docs", external: true },
];

export function Nav() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);
  const { user, signIn, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // Full-page escape back to the console shell (dashboard/publish/manage). The
  // builder lives under /build; the console home is the mount root — BASE-aware
  // so it works both under the /app/ proxy and on the console origin directly.
  const consoleHome = typeof window !== "undefined" && window.location.pathname.startsWith("/app") ? "/app/" : "/";

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
    <header className="sticky top-0 z-30 border-b backdrop-blur-xl border-line bg-panel p-[0.5rem_0]">
      <div className="container flex items-center justify-between">
        <Link to="/" className="font-display text-lg font-bold tracking-tight no-underline text-ink">
          Free<span className="text-accent">Apps</span> <span className="font-sans text-sm font-medium text-muted">Studio</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden sm:flex items-center gap-5">
          <ThemeToggle />
          <a href={consoleHome} className="text-sm font-semibold no-underline text-accent">&#8592; Console</a>
          {NAV_LINKS.map((link) =>
            link.external ? (
              <a
                key={link.to}
                href={link.to}
                className="text-sm font-semibold no-underline text-muted"
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.to}
                to={link.to}
                className={`text-sm font-semibold no-underline ${location.pathname === link.to ? "text-ink" : "text-muted"}`}
              >
                {link.label}
              </Link>
            ),
          )}
          {user ? (
            <div ref={avatarRef} className="relative">
              <button
                onClick={() => setAvatarMenuOpen(!avatarMenuOpen)}
                className="bg-transparent border-0 cursor-pointer p-0"
              >
                <img
                  src={user.avatarUrl || ""}
                  alt={user.login}
                  className={`rounded-full border-2 w-7 h-7 ${avatarMenuOpen ? "border-accent" : "border-line"}`}
                />
              </button>
              {avatarMenuOpen && (
                <div
                  className="absolute right-0 mt-2 rounded-xl border shadow-lg bg-paper border-line w-[200px] z-[100] p-[0.5rem_0]"
                >
                  <div className="px-3 py-2 border-b border-line">
                    <div className="text-sm font-semibold truncate">{user.login}</div>
                    <div className="text-xs text-muted">GitHub</div>
                  </div>
                  <button
                    onClick={() => { setAvatarMenuOpen(false); navigate("/profile"); }}
                    className="w-full text-left px-3 py-2 text-sm bg-transparent border-0 cursor-pointer text-ink"
                  >
                    Profile & Settings
                  </button>
                  <button
                    onClick={() => { setAvatarMenuOpen(false); navigate("/admin"); }}
                    className="w-full text-left px-3 py-2 text-sm bg-transparent border-0 cursor-pointer text-ink"
                  >
                    Admin
                  </button>
                  <div className="border-t border-line m-[0.25rem_0]" />
                  <button
                    onClick={() => { setAvatarMenuOpen(false); signOut(); navigate("/"); }}
                    className="w-full text-left px-3 py-2 text-sm bg-transparent border-0 cursor-pointer text-danger"
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={signIn}
              className="text-sm font-semibold text-accent bg-transparent border-0 cursor-pointer"
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
            className="w-9 h-9 bg-transparent border border-line rounded-full text-[1.1rem] text-ink cursor-pointer"
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
            className="fixed inset-0 z-40 bg-black/30"
            onClick={() => setMenuOpen(false)}
          />
          <nav
            className="fixed top-0 right-0 z-50 flex flex-col gap-1 p-4 w-[220px] h-[100dvh] bg-paper border-l border-line shadow-[-4px_0_20px_rgba(0,0,0,0.1)]"
          >
            <button
              onClick={() => setMenuOpen(false)}
              className="self-end mb-2 bg-transparent border-0 text-muted text-base cursor-pointer"
            >
              &#10005;
            </button>
            <a href={consoleHome} className="block py-2 text-base font-semibold no-underline text-accent" onClick={() => setMenuOpen(false)}>&#8592; Console</a>
            {NAV_LINKS.map((link) =>
              link.external ? (
                <a
                  key={link.to}
                  href={link.to}
                  className="block py-2 text-base font-semibold no-underline text-muted"
                  onClick={() => setMenuOpen(false)}
                >
                  {link.label}
                </a>
              ) : (
                <Link
                  key={link.to}
                  to={link.to}
                  className={`block py-2 text-base font-semibold no-underline ${location.pathname === link.to ? "text-ink" : "text-muted"}`}
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
                    className="rounded-full w-6 h-6"
                  />
                  <span className="text-sm font-semibold text-ink">{user.login}</span>
                </Link>
                <button
                  onClick={() => { setMenuOpen(false); signOut(); navigate("/"); }}
                  className="mt-2 text-sm text-danger bg-transparent border-0 cursor-pointer text-left"
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                onClick={() => { setMenuOpen(false); signIn(); }}
                className="mt-4 text-sm font-semibold text-accent bg-transparent border-0 cursor-pointer text-left"
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
