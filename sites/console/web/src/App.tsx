import { useState, useEffect, useCallback } from 'react'
import { initApp } from '@freeappstore/sdk'
import type { User } from '@freeappstore/sdk'
import { useAuth, useTheme } from '@freeappstore/sdk/hooks'
import { Avatar, SignInButton, ThemeToggle, TextSizeToggle, ProfileMenu, ProfilePage, FasShell } from '@freeappstore/sdk/ui'
import { AppDetail } from './AppDetail'
import { ContentAdmin } from './ContentAdmin'

const fas = initApp({ appId: 'console' })

type View = 'dashboard' | 'app-detail' | 'publish' | 'settings' | 'ui-library' | 'content-admin'

interface AppEntry {
  id: string
  name: string
  createdAt: string
  category?: string | null
  description?: string | null
}

const API_BASE = 'https://api.freeappstore.online/v1'

async function fetchApps(token: string | null): Promise<AppEntry[]> {
  if (!token) return []
  try {
    const res = await fetch(`${API_BASE}/apps/mine`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return []
    const data = (await res.json()) as { apps: { id: string; ownerLogin: string; createdAt: number; category?: string | null; oneliner?: string | null; store?: string | null }[] }
    return (data.apps ?? []).map((a) => ({
      id: a.id,
      name: a.id,
      createdAt: new Date(a.createdAt).toISOString(),
      category: a.category,
      description: a.oneliner,
    })).sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    return []
  }
}

function parseRoute(): { view: View; appId: string | null } {
  const path = location.pathname
  const appMatch = path.match(/^\/apps\/([a-z0-9-]+)(?:\/(.+))?$/)
  if (appMatch) return { view: 'app-detail', appId: appMatch[1] }
  if (path === '/publish') return { view: 'publish', appId: null }
  if (path === '/settings') return { view: 'settings', appId: null }
  if (path === '/ui-library') return { view: 'ui-library', appId: null }
  if (path === '/admin') return { view: 'content-admin', appId: null }
  return { view: 'dashboard', appId: null }
}

// Global setter — assigned by App component on mount.
let _setRoute: ((r: { view: View; appId: string | null }) => void) | null = null

function navigate(view: View, appId?: string) {
  let path = '/'
  if (view === 'app-detail' && appId) path = `/apps/${appId}`
  else if (view === 'publish') path = '/publish'
  else if (view === 'settings') path = '/settings'
  else if (view === 'ui-library') path = '/ui-library'
  else if (view === 'content-admin') path = '/admin'
  history.pushState(null, '', path)
  const next = parseRoute()
  if (_setRoute) _setRoute(next)
}

export default function App() {
  const { user, loading } = useAuth(fas)
  const [route, setRoute] = useState(parseRoute)
  const [apps, setApps] = useState<AppEntry[]>([])

  // Register global setter + listen for browser back/forward
  useEffect(() => {
    _setRoute = setRoute
    const handler = () => setRoute(parseRoute())
    window.addEventListener('popstate', handler)
    return () => {
      _setRoute = null
      window.removeEventListener('popstate', handler)
    }
  }, [])

  const view = route.view
  const selectedAppId = route.appId

  const setView = useCallback((v: View) => navigate(v), [])

  const reloadApps = useCallback(async () => {
    try { setApps(await fetchApps(fas.auth.token)) } catch {}
  }, [])

  useEffect(() => {
    if (user) reloadApps()
  }, [user, reloadApps])

  const openAppDetail = useCallback((id: string) => {
    navigate('app-detail', id)
  }, [])

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center">
        <p className="text-[var(--muted)]">Loading...</p>
      </div>
    )
  }

  if (!user) return <Landing />

  return (
    <div className="min-h-[100dvh] flex flex-col">
      <Header user={user} view={view} onNavigate={setView} />
      <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        {view === 'dashboard' && (
          <Dashboard user={user} apps={apps} onOpenApp={openAppDetail} onPublish={() => setView('publish')} />
        )}
        {view === 'app-detail' && selectedAppId && (
          <AppDetail
            appId={selectedAppId}
            appName={apps.find((a) => a.id === selectedAppId)?.name ?? selectedAppId}
            getToken={() => fas.auth.token}
            onBack={() => navigate('dashboard')}
          />
        )}
        {view === 'publish' && <PublishView />}
        {view === 'settings' && <Settings />}
        {view === 'ui-library' && <UILibraryView />}
        {view === 'content-admin' && <ContentAdmin getToken={() => fas.auth.token} />}
      </main>
    </div>
  )
}

function Landing() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-4">
      <div className="text-center max-w-md">
        <h1 className="display-font text-4xl font-bold text-[var(--ink)]">Creator Console</h1>
        <p className="mt-4 text-[var(--muted)] text-lg">
          Sign in with GitHub to manage your apps on FreeAppStore.
        </p>
        <button
          onClick={() => fas.auth.signIn()}
          className="mt-8 inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-6 py-3 text-sm font-semibold text-white shadow-lg hover:opacity-90"
        >
          <GitHubIcon />
          Sign in with GitHub
        </button>
        <p className="mt-6 text-xs text-[var(--muted)]">
          Part of{' '}
          <a href="https://freeappstore.online" target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--ink)]">
            FreeAppStore
          </a>
        </p>
      </div>
    </div>
  )
}

const TABS: { key: View; label: string }[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'publish', label: 'Publish' },
  { key: 'settings', label: 'Settings' },
  { key: 'ui-library', label: 'UI Library' },
  { key: 'content-admin', label: 'Admin' },
]

function Header({ user, view, onNavigate }: { user: User; view: View; onNavigate: (v: View) => void }) {
  return (
    <header className="sticky top-0 z-30">
      <div className="border-b border-[var(--line)] bg-[var(--panel)] backdrop-blur-xl">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 flex h-11 items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => onNavigate('dashboard')}
              className="display-font text-sm font-bold text-[var(--ink)] tracking-tight no-underline"
            >
              Console
            </button>
            <nav className="hidden sm:flex items-center gap-2.5 text-xs font-medium text-[var(--muted)]">
              <a href="https://freeappstore.online" className="hover:text-[var(--ink)] no-underline">Store</a>
              <a href="https://freeappstore.online/docs" className="hover:text-[var(--ink)] no-underline">Docs</a>
              <a href="https://create.freeappstore.online" className="hover:text-[var(--ink)] no-underline">VibeCode</a>
            </nav>
          </div>
          <div className="flex items-center gap-2.5">
            <ThemeToggle />
            {user.avatarUrl && (
              <img src={user.avatarUrl} alt={user.login} className="h-6 w-6 rounded-full ring-1 ring-[var(--line-strong)]" />
            )}
            <button
              onClick={() => fas.auth.signOut()}
              className="text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)]"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
      <div className="border-b border-[var(--line)] bg-[var(--panel)]">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <nav className="flex gap-0 -mb-px overflow-x-auto scrollbar-none">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => onNavigate(tab.key)}
                className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap min-h-[44px] ${
                  (view === tab.key || (view === 'app-detail' && tab.key === 'dashboard'))
                    ? 'border-[var(--accent)] text-[var(--ink)]'
                    : 'border-transparent text-[var(--muted)] hover:text-[var(--ink)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>
    </header>
  )
}

function Dashboard({ user, apps, onOpenApp, onPublish }: { user: User; apps: AppEntry[]; onOpenApp: (id: string) => void; onPublish: () => void }) {
  return (
    <div className="space-y-8">
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow-card)]">
        <div className="flex items-center gap-4">
          <Avatar user={user} size={56} />
          <div>
            <h2 className="display-font text-2xl font-bold text-[var(--ink)]">Welcome, {user.login}</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">Manage your apps on FreeAppStore</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Apps" value={apps.length} />
        <StatCard label="Platform" value="Free" />
        <StatCard label="License" value="MIT" />
      </div>

      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="display-font text-xl font-bold text-[var(--ink)]">Your Apps</h3>
          <button
            onClick={onPublish}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            + Publish New App
          </button>
        </div>

        {apps.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--line-strong)] p-12 text-center">
            <p className="text-[var(--muted)]">
              No apps yet. Create your first app with{' '}
              <a href="https://create.freeappstore.online" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] font-semibold underline">
                VibeCode
              </a>{' '}
              or the CLI.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            {apps.map((a) => (
              <button
                key={a.id}
                onClick={() => onOpenApp(a.id)}
                className="text-left rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 hover:bg-[var(--panel-hover)] shadow-sm min-h-[5rem]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-semibold text-[var(--ink)] block truncate">{a.name}</span>
                    <p className="mt-0.5 text-xs text-[var(--muted)] font-mono truncate">{a.id}.freeappstore.online</p>
                    {a.category && <p className="mt-0.5 text-xs text-[var(--muted)]">{a.category}</p>}
                  </div>
                </div>
                <DeployBadge appId={a.id} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6">
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide mb-4">Quick Links</h3>
        <div className="grid gap-2 sm:grid-cols-3">
          <QuickLink href="https://freeappstore.online/docs" label="SDK Docs" desc="Auth, KV, rooms, proxy" />
          <QuickLink href="https://freeappstore.online/docs/ui" label="UI Library" desc="Components & design tokens" />
          <QuickLink href="https://freeappstore.online/guidelines" label="Guidelines" desc="Quality & compliance rules" />
        </div>
      </div>
    </div>
  )
}

function PublishView() {
  return (
    <div className="space-y-8">
      <h2 className="display-font text-2xl font-bold text-[var(--ink)]">Publish an App</h2>

      <div className="grid gap-6 sm:grid-cols-2">
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6">
          <h3 className="display-font text-lg font-bold text-[var(--ink)] mb-2">VibeCode (AI Builder)</h3>
          <p className="text-sm text-[var(--muted)] mb-4">
            Describe your app in plain English and AI builds it for you. No coding required.
          </p>
          <a
            href="https://create.freeappstore.online"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 no-underline"
          >
            Open VibeCode
          </a>
        </div>

        <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6">
          <h3 className="display-font text-lg font-bold text-[var(--ink)] mb-2">CLI (Local Dev)</h3>
          <p className="text-sm text-[var(--muted)] mb-4">
            Build locally with React + Vite, then publish via the CLI.
          </p>
          <pre className="rounded-lg bg-[var(--panel)] border border-[var(--line)] p-3 text-xs font-mono text-[var(--ink)] overflow-x-auto mb-3">
{`npm i -g @freeappstore/cli
fas create my-app
cd my-app && pnpm dev`}
          </pre>
          <a
            href="https://freeappstore.online/get-started"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[var(--accent)] font-medium hover:underline no-underline"
          >
            Full guide &rarr;
          </a>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6">
        <h3 className="display-font text-lg font-bold text-[var(--ink)] mb-2">Publisher Portal</h3>
        <p className="text-sm text-[var(--muted)] mb-4">
          Already have an app? Submit it for review and get listed on the store.
        </p>
        <a
          href="https://publish.freeappstore.online"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] px-4 py-2 text-sm font-medium text-[var(--ink)] hover:bg-[var(--panel-hover)] no-underline"
        >
          Open Publisher Portal
        </a>
      </div>
    </div>
  )
}

function Settings() {
  const { preference, setPreference } = useTheme()
  return (
    <div className="space-y-8">
      <h2 className="display-font text-2xl font-bold text-[var(--ink)]">Settings</h2>
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6">
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide mb-4">Theme</h3>
        <div className="flex gap-2">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setPreference(t)}
              className={`rounded-lg px-4 py-2 text-sm font-medium capitalize ${
                preference === t
                  ? 'bg-[var(--accent)] text-white'
                  : 'border border-[var(--line-strong)] text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function UILibraryView() {
  const mockUser = { id: '1', login: 'demo-user', avatarUrl: 'https://github.com/serge-ivo.png', dateOfBirth: null }
  const noAvatar = { id: '2', login: 'jane', avatarUrl: null, dateOfBirth: null }
  return (
    <div className="space-y-10">
      <div>
        <h2 className="display-font text-2xl font-bold text-[var(--ink)]">UI Component Library</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Live preview of all <code className="text-xs bg-[var(--panel)] px-1.5 py-0.5 rounded">@freeappstore/sdk/ui</code> components.
        </p>
      </div>

      <Section title="Avatar" code="import { Avatar } from '@freeappstore/sdk/ui'">
        <Row label="With avatar"><Avatar user={mockUser} size={32} /><Avatar user={mockUser} size={48} /><Avatar user={mockUser} size={64} /></Row>
        <Row label="Fallback"><Avatar user={noAvatar} size={32} /><Avatar user={null} size={32} /></Row>
      </Section>

      <Section title="ThemeToggle" code="import { ThemeToggle } from '@freeappstore/sdk/ui'">
        <Row label="Interactive"><ThemeToggle /><span className="text-xs text-[var(--muted)]">Cycles: system, light, dark</span></Row>
      </Section>

      <Section title="TextSizeToggle" code="import { TextSizeToggle } from '@freeappstore/sdk/ui'">
        <Row label="Interactive"><TextSizeToggle /><span className="text-xs text-[var(--muted)]">Cycles: default, large, small</span></Row>
      </Section>

      <Section title="SignInButton" code="import { SignInButton } from '@freeappstore/sdk/ui'">
        <Row label="Default"><SignInButton app={fas} /></Row>
        <Row label="Custom label"><SignInButton app={fas} label="Get started" /></Row>
      </Section>

      <Section title="ProfileMenu" code="import { ProfileMenu } from '@freeappstore/sdk/ui'">
        <Row label="Live (requires sign-in)">
          <ProfileMenu app={fas} />
          <span className="text-xs text-[var(--muted)]">Sign in to see the avatar dropdown</span>
        </Row>
      </Section>

      <Section title="ProfilePage" code="import { ProfilePage } from '@freeappstore/sdk/ui'">
        <div className="border border-[var(--line)] rounded-xl overflow-hidden max-h-[500px] overflow-y-auto">
          <ProfilePage app={fas} />
        </div>
      </Section>

      <Section title="FasShell" code="import { FasShell } from '@freeappstore/sdk/ui'">
        <div className="border border-[var(--line)] rounded-xl overflow-hidden" style={{ height: 300 }}>
          <div style={{ transform: 'scale(0.6)', transformOrigin: 'top left', width: '166.67%', height: '166.67%' }}>
            <FasShell app={fas} appName="Demo App">
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>
                Your app content goes here
              </div>
            </FasShell>
          </div>
        </div>
      </Section>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
      <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide">{label}</p>
      <p className="mt-1 display-font text-2xl font-bold text-[var(--ink)]">{value}</p>
    </div>
  )
}

function QuickLink({ href, label, desc }: { href: string; label: string; desc: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="rounded-xl border border-[var(--line)] p-3 hover:bg-[var(--panel-hover)] no-underline block">
      <p className="font-semibold text-sm text-[var(--ink)]">{label}</p>
      <p className="text-xs text-[var(--muted)] mt-0.5">{desc}</p>
    </a>
  )
}

function Section({ title, code, children }: { title: string; code: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] overflow-hidden">
      <div className="px-5 py-4 border-b border-[var(--line)]">
        <h3 className="text-lg font-bold text-[var(--ink)]">{title}</h3>
        <code className="text-xs text-[var(--muted)] font-mono">{code}</code>
      </div>
      <div className="px-5 py-4 space-y-4">{children}</div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide mb-2">{label}</p>
      <div className="flex items-center gap-3 flex-wrap">{children}</div>
    </div>
  )
}

interface DeployInfo {
  status: 'success' | 'failure' | 'in_progress' | 'unknown'
  updatedAt: string | null
  url: string | null
}

function useDeployStatus(appId: string): DeployInfo {
  const [info, setInfo] = useState<DeployInfo>({ status: 'unknown', updatedAt: null, url: null })
  useEffect(() => {
    fetch(`https://api.github.com/repos/freeappstore-online/${appId}/actions/runs?per_page=1&status=completed`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const run = data?.workflow_runs?.[0]
        if (run) {
          setInfo({
            status: run.conclusion === 'success' ? 'success' : 'failure',
            updatedAt: run.updated_at,
            url: run.html_url,
          })
        }
      })
      .catch(() => {})
  }, [appId])
  return info
}

function DeployBadge({ appId }: { appId: string }) {
  const deploy = useDeployStatus(appId)
  if (deploy.status === 'unknown') return null
  const colors = {
    success: 'bg-[var(--success)] text-white',
    failure: 'bg-[var(--error)] text-white',
    in_progress: 'bg-[var(--warning)] text-white',
  }
  const labels = { success: 'Live', failure: 'Deploy failed', in_progress: 'Deploying' }
  const timeAgo = deploy.updatedAt ? formatTimeAgo(new Date(deploy.updatedAt)) : ''
  return (
    <div className="flex items-center gap-1.5 mt-1.5">
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${colors[deploy.status]}`}>
        {labels[deploy.status]}
      </span>
      {timeAgo && <span className="text-[10px] text-[var(--muted)]">{timeAgo}</span>}
    </div>
  )
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}
