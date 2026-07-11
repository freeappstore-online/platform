import { useState, useEffect, useCallback } from 'react'
import { AppList } from './AppList.tsx'
import { AppDetail } from './AppDetail.tsx'
import { ProvisionForm } from './ProvisionForm.tsx'
import { Overview } from './Overview.tsx'
import { AgentSessions } from './AgentSessions.tsx'
import { AgentSessionView } from './AgentSessionView.tsx'
import { AIKeys } from './AIKeys.tsx'

type View =
  | { page: 'overview' }
  | { page: 'apps' }
  | { page: 'detail'; id: string }
  | { page: 'provision' }
  | { page: 'ai-keys' }
  | { page: 'agent-sessions' }
  | { page: 'agent-session'; id: string }

function parseHash(): View {
  const hash = window.location.hash.slice(1)
  if (hash === '/provision') return { page: 'provision' }
  if (hash === '/apps') return { page: 'apps' }
  if (hash === '/ai-keys') return { page: 'ai-keys' }
  if (hash === '/agent') return { page: 'agent-sessions' }
  const agentMatch = hash.match(/^\/agent\/(.+)$/)
  if (agentMatch) return { page: 'agent-session', id: agentMatch[1]! }
  const detailMatch = hash.match(/^\/apps\/(.+)$/)
  if (detailMatch) return { page: 'detail', id: detailMatch[1]! }
  // Legacy #/games routes → apps list
  if (hash === '/games' || hash.startsWith('/games/')) return { page: 'apps' }
  return { page: 'overview' }
}

export default function App() {
  const [view, setView] = useState<View>(parseHash)

  useEffect(() => {
    const onHash = () => setView(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash
  }, [])

  return (
    <div className="min-h-[100dvh] flex flex-col">
      <Header navigate={navigate} view={view} />
      <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        {view.page === 'overview' && <Overview navigate={navigate} />}
        {view.page === 'apps' && <AppList navigate={navigate} />}
        {view.page === 'detail' && <AppDetail id={view.id} navigate={navigate} />}
        {view.page === 'provision' && <ProvisionForm navigate={navigate} />}
        {view.page === 'ai-keys' && <AIKeys />}
        {view.page === 'agent-sessions' && <AgentSessions navigate={navigate} />}
        {view.page === 'agent-session' && <AgentSessionView id={view.id} navigate={navigate} />}
      </main>
    </div>
  )
}

function Header({ navigate, view }: { navigate: (h: string) => void; view: View }) {
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
            <NavLink label="AI Grants" hash="/ai-keys" active={view.page === 'ai-keys'} navigate={navigate} />
          </nav>
        </div>
        <button
          onClick={() => navigate('/provision')}
          className="text-sm font-semibold px-3.5 py-1.5 rounded-lg"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          + Provision
        </button>
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
