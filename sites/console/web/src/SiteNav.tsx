import { useEffect, useRef, useState } from 'react'
import { ThemeToggle } from '@freeappstore/sdk/ui'
import { API_URL, getSession } from './builder/lib/api'

// The console is served at console.freeappstore.online/ (no prefix) AND at
// freeappstore.online/app/ (the storefront proxy strips /app server-side but the
// browser URL keeps it). Normalize so client-side routing works under either mount.
export const BASE =
  typeof location !== 'undefined' && (location.pathname === '/app' || location.pathname.startsWith('/app/')) ? '/app' : ''

/** Client-side navigation that both routers follow: the console's path router
 *  and the builder's react-router each listen for `popstate`. */
export function go(path: string) {
  history.pushState(null, '', BASE + path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const SECTIONS = [
  { path: '/', label: 'Apps' },
  { path: '/build', label: 'Build' },
  { path: '/publish', label: 'Publish' },
]

function currentSection(): string | null {
  const path = (typeof location === 'undefined' ? '/' : location.pathname.slice(BASE.length)) || '/'
  if (path === '/' || path.startsWith('/apps/')) return '/'
  if (path === '/build' || path === '/build/' || path.startsWith('/build/app/')) return '/build'
  if (path === '/publish') return '/publish'
  return null
}

function NavLink({ path, className, onNavigate, children }: { path: string; className: string; onNavigate?: () => void; children: React.ReactNode }) {
  return (
    <a
      href={BASE + path}
      className={className}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        onNavigate?.()
        go(path)
      }}
    >
      {children}
    </a>
  )
}

// The session user carries no role; /auth/me reports them live. One request per
// session token, shared by every header mount.
let adminCheck: { token: string; result: Promise<boolean> } | null = null
function isAdmin(token: string): Promise<boolean> {
  if (adminCheck?.token !== token) {
    const result = fetch(`${API_URL}/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => (res.ok ? (res.json() as Promise<{ roles?: string[] }>) : null))
      .then((me) => !!me?.roles?.includes('admin'))
      .catch(() => false)
    adminCheck = { token, result }
  }
  return adminCheck.result
}

const EXTERNAL = [
  { href: 'https://freeappstore.online/docs', label: 'Docs' },
  { href: 'https://freeappstore.online', label: 'Store' },
]

/** The one header for every console page, the VibeCode builder included (#587). */
export function SiteNav({ user, onSignIn, onSignOut }: {
  user: { login: string; avatarUrl: string | null } | null
  onSignIn: () => void
  onSignOut: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const section = currentSection()
  const [admin, setAdmin] = useState(false)

  useEffect(() => {
    const token = getSession()?.token
    if (!user || !token) return
    let live = true
    isAdmin(token).then((yes) => { if (live) setAdmin(yes) })
    return () => { live = false }
  }, [user?.login])

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  const menuItem = 'block w-full text-left px-3 py-2 text-sm no-underline bg-transparent border-0 cursor-pointer text-ink hover:bg-panel-hover'

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-panel backdrop-blur-xl">
      <div className="mx-auto flex h-12 max-w-5xl items-center gap-4 px-4 sm:px-6 lg:px-8">
        <NavLink path="/" className="display-font text-sm font-bold tracking-tight text-ink no-underline">
          Console
        </NavLink>
        <nav className="flex flex-1 items-center gap-1">
          {SECTIONS.map((s) => (
            <NavLink
              key={s.path}
              path={s.path}
              className={`rounded-lg px-2.5 py-1.5 text-sm font-semibold no-underline ${
                section === s.path ? 'bg-(--accent-soft) text-accent' : 'text-muted hover:text-ink'
              }`}
            >
              {s.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          {EXTERNAL.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className="hidden sm:inline text-xs font-medium text-muted hover:text-ink no-underline">
              {l.label}
            </a>
          ))}
          <ThemeToggle />
          {user ? (
            <div ref={menuRef} className="relative">
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                aria-label="Account menu"
                aria-expanded={menuOpen}
                className="flex bg-transparent border-0 p-0 cursor-pointer"
              >
                {user.avatarUrl ? (
                  <img src={user.avatarUrl} alt={user.login} className={`h-7 w-7 rounded-full border-2 ${menuOpen ? 'border-accent' : 'border-line'}`} />
                ) : (
                  <span className="text-sm font-semibold text-ink">{user.login}</span>
                )}
              </button>
              {menuOpen && (
                <div className="absolute right-0 mt-2 w-48 rounded-xl border border-line bg-paper py-1 shadow-lg">
                  <div className="truncate border-b border-line px-3 py-2 text-sm font-semibold text-ink">{user.login}</div>
                  <NavLink path="/build/profile" className={menuItem} onNavigate={() => setMenuOpen(false)}>Settings</NavLink>
                  {admin && <NavLink path="/build/admin" className={menuItem} onNavigate={() => setMenuOpen(false)}>Admin</NavLink>}
                  {EXTERNAL.map((l) => (
                    <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className={`${menuItem} sm:hidden`}>
                      {l.label}
                    </a>
                  ))}
                  <button onClick={onSignOut} className={`${menuItem} border-t border-line text-danger`}>Sign out</button>
                </div>
              )}
            </div>
          ) : (
            <button onClick={onSignIn} className="text-sm font-semibold text-accent bg-transparent border-0 cursor-pointer">
              Sign in
            </button>
          )}
        </div>
      </div>
    </header>
  )
}
