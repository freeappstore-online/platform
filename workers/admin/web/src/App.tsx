import { useState, useEffect, useCallback } from 'react'
import { AppList } from './AppList.tsx'
import { AppDetail } from './AppDetail.tsx'
import { ProvisionForm } from './ProvisionForm.tsx'
import { Overview } from './Overview.tsx'
import { AgentSessions } from './AgentSessions.tsx'
import { AgentSessionView } from './AgentSessionView.tsx'
import { AIKeys } from './AIKeys.tsx'
import { ContentData } from './ContentData.tsx'
import { type AdminUser, useAdminAuth } from './auth.ts'

type View =
  | { page: 'overview' }
  | { page: 'apps'; owner?: string }
  | { page: 'detail'; id: string }
  | { page: 'provision' }
  | { page: 'ai-keys' }
  | { page: 'content-data' }
  | { page: 'agent-sessions' }
  | { page: 'agent-session'; id: string }

function parseHash(): View {
  const hash = window.location.hash.slice(1)
  if (hash === '/provision') return { page: 'provision' }
  if (hash === '/apps') return { page: 'apps' }
  if (hash === '/ai-keys') return { page: 'ai-keys' }
  if (hash === '/content-data') return { page: 'content-data' }
  if (hash === '/agent') return { page: 'agent-sessions' }
  const agentMatch = hash.match(/^\/agent\/(.+)$/)
  if (agentMatch) return { page: 'agent-session', id: agentMatch[1]! }
  // All apps owned by one person — must be checked before the generic /apps/:id.
  const ownerMatch = hash.match(/^\/apps\/owner\/(.+)$/)
  if (ownerMatch) return { page: 'apps', owner: decodeURIComponent(ownerMatch[1]!) }
  const detailMatch = hash.match(/^\/apps\/(.+)$/)
  if (detailMatch) return { page: 'detail', id: detailMatch[1]! }
  // Legacy #/games routes → apps list
  if (hash === '/games' || hash.startsWith('/games/')) return { page: 'apps' }
  return { page: 'overview' }
}

export default function App() {
  const { user, loading, error, signIn, signOut } = useAdminAuth()
  const [view, setView] = useState<View>(parseHash)

  useEffect(() => {
    const onHash = () => setView(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash
  }, [])

  if (loading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center px-4">
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading...</p>
      </div>
    )
  }

  if (!user) return <SignIn error={error} onSignIn={signIn} />

  return (
    <div className="min-h-[100dvh] flex flex-col">
      <Header navigate={navigate} view={view} user={user} signOut={signOut} />
      <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        {view.page === 'overview' && <Overview navigate={navigate} />}
        {view.page === 'apps' && <AppList navigate={navigate} owner={view.owner} />}
        {view.page === 'detail' && <AppDetail id={view.id} navigate={navigate} />}
        {view.page === 'provision' && <ProvisionForm navigate={navigate} />}
        {view.page === 'ai-keys' && <AIKeys navigate={navigate} />}
        {view.page === 'content-data' && <ContentData />}
        {view.page === 'agent-sessions' && <AgentSessions navigate={navigate} />}
        {view.page === 'agent-session' && <AgentSessionView id={view.id} navigate={navigate} />}
      </main>
    </div>
  )
}

function SignIn({ error, onSignIn }: { error: string | null; onSignIn: () => void }) {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--ink)' }}>FAS Admin</h1>
        <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
          Sign in with a FreeAppStore admin account.
        </p>
        {error && (
          <p className="mt-4 rounded-md border px-3 py-2 text-sm" style={{ borderColor: 'var(--line)', color: '#fca5a5' }}>
            {error}
          </p>
        )}
        <button
          onClick={onSignIn}
          className="mt-6 w-full text-sm font-semibold px-4 py-2 rounded-lg"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          Sign in with GitHub
        </button>
      </div>
    </div>
  )
}

function Header({ navigate, view, user, signOut }: { navigate: (h: string) => void; view: View; user: AdminUser; signOut: () => void }) {
  return (
    <header
      className="sticky top-0 z-10 border-b px-4 sm:px-6 lg:px-8"
      style={{ borderColor: 'var(--line)', background: 'var(--panel-strong)', backdropFilter: 'blur(12px)' }}
    >
      <div className="mx-auto max-w-6xl flex items-center justify-between h-14">
        <div className="flex items-center gap-6">
          <button
            onClick={() => navigate('/')}
            className="text-lg font-bold tracking-tight"
            style={{ color: 'var(--ink)' }}
          >
            FAS Admin
          </button>
          <nav className="hidden sm:flex items-center gap-1">
            <NavLink label="Overview" hash="/" active={view.page === 'overview'} navigate={navigate} />
            <NavLink label="Apps" hash="/apps" active={view.page === 'apps' || view.page === 'detail'} navigate={navigate} />
            <NavLink label="Content Data" hash="/content-data" active={view.page === 'content-data'} navigate={navigate} />
            <NavLink label="AI Grants" hash="/ai-keys" active={view.page === 'ai-keys'} navigate={navigate} />
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline text-xs" style={{ color: 'var(--muted)' }}>{user.githubLogin || user.login}</span>
          <button
            onClick={() => navigate('/provision')}
            className="text-sm font-semibold px-3.5 py-1.5 rounded-lg"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            + Provision
          </button>
          <button
            onClick={signOut}
            className="text-sm font-semibold px-3.5 py-1.5 rounded-lg"
            style={{ background: 'var(--panel)', color: 'var(--muted)', border: '1px solid var(--line)' }}
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}

function NavLink({ label, hash, active, navigate }: { label: string; hash: string; active: boolean; navigate: (h: string) => void }) {
  return (
    <button
      onClick={() => navigate(hash)}
      className="px-3 py-1.5 rounded-md text-sm font-medium"
      style={{
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--muted)',
      }}
    >
      {label}
    </button>
  )
}
