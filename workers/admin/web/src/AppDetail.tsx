import { useState, useEffect, useCallback } from 'react'
import type { AppHealth, UnifiedApp, DeprovisionResult, AppSession } from './api.ts'
import { api } from './api.ts'
import { Loading, ErrorBox } from './Overview.tsx'
import { StatusBadge } from './AppList.tsx'

export function AppDetail({ id, navigate }: { id: string; navigate: (h: string) => void }) {
  const [app, setApp] = useState<UnifiedApp | null>(null)
  const [health, setHealth] = useState<AppHealth | null>(null)
  const [sessions, setSessions] = useState<AppSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    Promise.all([
      api<UnifiedApp[]>('/api/apps/all').then((all) => all.find((a) => a.id === id) ?? null),
      api<AppHealth>(`/api/apps/${encodeURIComponent(id)}/health`),
      api<AppSession[]>(`/api/apps/${encodeURIComponent(id)}/sessions`).catch(() => []),
    ])
      .then(([a, h, s]) => { setApp(a); setHealth(h); setSessions(s) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(load, [load])

  if (loading) return <Loading />
  if (error) return <ErrorBox message={error} />

  return (
    <div>
      <button
        onClick={() => navigate('/apps')}
        className="text-sm font-medium mb-4 inline-flex items-center gap-1"
        style={{ color: 'var(--muted)' }}
      >
        &larr; Back to Apps
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--ink)' }}>{app?.name ?? id}</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            <a href={`https://${health?.domain ?? `${id}.freeappstore.online`}`} target="_blank" rel="noopener" className="underline" style={{ color: 'var(--accent)' }}>
              {health?.domain ?? `${id}.freeappstore.online`}
            </a>
            {' '}&middot;{' '}
            <a href={`https://github.com/${app?.repo ?? `freeappstore-online/${id}`}`} target="_blank" rel="noopener" className="underline" style={{ color: 'var(--accent)' }}>
              {app?.repo ?? `freeappstore-online/${id}`}
            </a>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <HealthCard health={health} app={app} />
        <InfoCard app={app} />
      </div>

      {health?.ghActions && health.ghActions.length > 0 && (
        <div className="mb-6">
          <GhActionsCard runs={health.ghActions} repo={app?.repo ?? `freeappstore-online/${id}`} />
        </div>
      )}

      {sessions.length > 0 && (
        <div className="mb-6">
          <SessionsCard sessions={sessions} />
        </div>
      )}

      <ActionsPanel id={id} store="apps" onRefresh={load} navigate={navigate} />
    </div>
  )
}

function HealthCard({ health, app }: { health: AppHealth | null; app: UnifiedApp | null }) {
  return (
    <div className="rounded-xl p-5" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--muted)' }}>Health</h2>
      <div className="space-y-3">
        <Row label="HTTP">
          {health ? (
            <StatusBadge
              status={health.reachable ? 'success' : 'failure'}
              label={health.reachable ? `${health.httpStatus} OK` : `${health.httpStatus || 'unreachable'}`}
            />
          ) : (
            <span style={{ color: 'var(--muted)' }}>checking...</span>
          )}
        </Row>
        <Row label="Hosting">
          <StatusBadge
            status={app?.hostedOn === 'r2' ? 'success' : 'idle'}
            label={app?.hostedOn ?? health?.hostedOn ?? 'unknown'}
          />
        </Row>
        <Row label="Route">
          <StatusBadge
            status={health?.hasRoute ? 'active' : 'not_configured'}
            label={health?.hasRoute ? 'configured' : 'missing'}
          />
        </Row>
        <Row label="Registry">
          <StatusBadge
            status={app?.inRegistry ? 'active' : 'not_configured'}
            label={app?.inRegistry ? 'listed' : 'unlisted'}
          />
        </Row>
      </div>
    </div>
  )
}

function InfoCard({ app }: { app: UnifiedApp | null }) {
  if (!app) return null
  return (
    <div className="rounded-xl p-5" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--muted)' }}>Info</h2>
      <div className="space-y-3">
        <Row label="Owner">
          {app.owner ? (
            <OwnerProfile login={app.owner} avatar={app.ownerAvatar} />
          ) : (
            <span style={{ color: 'var(--muted)' }}>unknown</span>
          )}
        </Row>
        <Row label="Category">{app.category ?? '-'}</Row>
        <Row label="Type">{app.type ?? '-'}</Row>
        <Row label="Source">
          <a
            href={`https://github.com/${app.repo}`}
            target="_blank"
            rel="noopener"
            className="underline text-xs"
            style={{ color: 'var(--accent)' }}
          >
            {app.repo}
          </a>
        </Row>
        {app.createdAt && <Row label="Created">{formatDate(app.createdAt)}</Row>}
      </div>
    </div>
  )
}

function GhActionsCard({ runs, repo }: { runs: AppHealth['ghActions']; repo: string }) {
  return (
    <div className="rounded-xl p-5" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--muted)' }}>GitHub Actions</h2>
        <a
          href={`https://github.com/${repo}/actions`}
          target="_blank"
          rel="noopener"
          className="text-xs underline"
          style={{ color: 'var(--accent)' }}
        >
          View on GitHub
        </a>
      </div>
      <div className="space-y-2">
        {runs.map((run) => (
          <div key={run.id} className="flex items-center gap-3 text-sm">
            <StatusBadge
              status={run.conclusion === 'success' ? 'success' : run.conclusion === 'failure' ? 'failure' : 'idle'}
              label={run.conclusion ?? run.status}
            />
            <span className="font-mono text-xs" style={{ color: 'var(--muted)' }}>{run.headSha}</span>
            <span className="truncate flex-1" style={{ color: 'var(--ink)' }}>{run.commitMsg}</span>
            <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>{timeAgo(run.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function SessionsCard({ sessions }: { sessions: AppSession[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <div className="rounded-xl p-5" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--muted)' }}>
        VibeCode Sessions ({sessions.length})
      </h2>
      <div className="space-y-3">
        {sessions.map((s) => (
          <div key={s.sessionId}>
            <button
              onClick={() => setExpanded(expanded === s.sessionId ? null : s.sessionId)}
              className="w-full text-left flex items-center gap-3 text-sm"
            >
              <StatusBadge
                status={s.deployed ? 'success' : 'idle'}
                label={s.deployed ? 'deployed' : s.deployState?.phase ?? 'building'}
              />
              <span className="font-medium truncate" style={{ color: 'var(--ink)' }}>{s.name}</span>
              <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>
                {s.messages.length} msgs &middot; {timeAgo(new Date(s.updatedAt).toISOString())}
              </span>
              <span className="text-xs ml-auto" style={{ color: 'var(--accent)' }}>
                {expanded === s.sessionId ? 'collapse' : 'expand'}
              </span>
            </button>
            {expanded === s.sessionId && (
              <div className="mt-3 ml-2 space-y-2 border-l-2 pl-4" style={{ borderColor: 'var(--line)' }}>
                <div className="text-xs mb-2" style={{ color: 'var(--muted)' }}>
                  User: {s.userId.slice(0, 12)}... &middot; Session: {s.sessionId.slice(0, 12)}...
                </div>
                {s.messages.map((msg, i) => {
                  const isUser = msg.role === 'user'
                  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                  return (
                    <div key={i} className="text-sm rounded-lg p-3" style={{
                      background: isUser ? 'var(--accent-soft, rgba(37, 99, 235, 0.08))' : 'var(--paper, #fff)',
                      border: `1px solid ${isUser ? 'var(--accent, #2563eb)' : 'var(--line)'}`,
                      borderLeftWidth: '3px',
                    }}>
                      <span className="text-xs font-bold uppercase" style={{ color: isUser ? 'var(--accent)' : 'var(--muted)' }}>
                        {isUser ? 'User' : 'Agent'}
                      </span>
                      <pre className="mt-1 whitespace-pre-wrap break-words text-xs" style={{ color: 'var(--ink)', fontFamily: 'inherit' }}>
                        {content.slice(0, 500)}{content.length > 500 ? '...' : ''}
                      </pre>
                      {msg.toolCalls && msg.toolCalls.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {msg.toolCalls.map((tc, j) => (
                            <span key={j} className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background: 'var(--line)', color: 'var(--ink)' }}>
                              {tc.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                {s.messages.length === 0 && (
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>No messages recorded.</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function ActionsPanel({ id, store, onRefresh, navigate }: { id: string; store: string; onRefresh: () => void; navigate: (h: string) => void }) {
  const [showDeprovision, setShowDeprovision] = useState(false)
  const [deprovisioning, setDeprovisioning] = useState(false)
  const [deprovisionResult, setDeprovisionResult] = useState<DeprovisionResult | null>(null)

  const handleDeprovision = async (deleteRepo: boolean) => {
    setDeprovisioning(true)
    try {
      const res = await api<DeprovisionResult>('/api/deprovision', {
        method: 'POST',
        body: JSON.stringify({ id, store, deleteRepo }),
      })
      setDeprovisionResult(res)
      if (res.ok) setTimeout(() => navigate('/apps'), 3000)
    } catch (e: unknown) {
      setDeprovisionResult({ ok: false, id, steps: [{ name: 'Error', status: 'fail', detail: e instanceof Error ? e.message : String(e) }] })
    } finally {
      setDeprovisioning(false)
    }
  }

  return (
    <div className="rounded-xl p-5" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--muted)' }}>Actions</h2>
      <div className="flex flex-wrap gap-3">
        <button
          onClick={onRefresh}
          className="px-4 py-2 rounded-lg text-sm font-medium"
          style={{ border: '1px solid var(--line)', color: 'var(--ink)' }}
        >
          Refresh
        </button>
        <a
          href={`https://${id}.freeappstore.online`}
          target="_blank"
          rel="noopener"
          className="px-4 py-2 rounded-lg text-sm font-medium inline-flex items-center"
          style={{ border: '1px solid var(--line)', color: 'var(--ink)' }}
        >
          Open App
        </a>
        <button
          onClick={() => setShowDeprovision(true)}
          className="px-4 py-2 rounded-lg text-sm font-medium"
          style={{ background: 'rgba(199, 79, 67, 0.12)', color: 'var(--error)' }}
        >
          Deprovision
        </button>
      </div>

      {showDeprovision && !deprovisionResult && (
        <DeprovisionModal
          appId={id}
          loading={deprovisioning}
          onConfirm={handleDeprovision}
          onCancel={() => setShowDeprovision(false)}
        />
      )}

      {deprovisionResult && (
        <div className="mt-4 space-y-2">
          {deprovisionResult.steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <StatusBadge status={s.status} />
              <span className="font-medium">{s.name}</span>
              <span style={{ color: 'var(--muted)' }}>{s.detail}</span>
            </div>
          ))}
          {deprovisionResult.ok && (
            <p className="text-sm font-medium mt-2" style={{ color: 'var(--success)' }}>
              Deprovisioned. Redirecting...
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function DeprovisionModal({ appId, loading, onConfirm, onCancel }: {
  appId: string; loading: boolean; onConfirm: (deleteRepo: boolean) => void; onCancel: () => void
}) {
  const [deleteRepo, setDeleteRepo] = useState(false)
  return (
    <div className="mt-4 rounded-xl p-5" style={{ background: 'var(--paper-deep)', border: '1px solid var(--error)' }}>
      <h3 className="text-base font-bold mb-2" style={{ color: 'var(--error)' }}>Deprovision "{appId}"</h3>
      <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>
        This will remove the route, registry entry, and DNS records.
      </p>
      <label className="flex items-center gap-2 text-sm mb-4 cursor-pointer" style={{ color: 'var(--ink)' }}>
        <input type="checkbox" checked={deleteRepo} onChange={(e) => setDeleteRepo(e.target.checked)} className="rounded" />
        Also delete GitHub repo
      </label>
      <div className="flex gap-3">
        <button onClick={() => onConfirm(deleteRepo)} disabled={loading}
          className="px-4 py-2 rounded-lg text-sm font-semibold"
          style={{ background: 'var(--error)', color: '#fff', opacity: loading ? 0.6 : 1 }}>
          {loading ? 'Deprovisioning...' : 'Confirm'}
        </button>
        <button onClick={onCancel} disabled={loading}
          className="px-4 py-2 rounded-lg text-sm font-medium"
          style={{ border: '1px solid var(--line)', color: 'var(--muted)' }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function OwnerProfile({ login, avatar }: { login: string; avatar: string | null }) {
  const avatarUrl = avatar ?? `https://avatars.githubusercontent.com/${login}?size=80`
  return (
    <div className="flex items-center gap-2">
      <img src={avatarUrl} alt="" width="24" height="24" className="rounded-full" loading="lazy" />
      <div className="flex items-center gap-2 text-xs">
        <a
          href={`https://freeappstore.online/u/${login}.html`}
          target="_blank"
          rel="noopener"
          className="font-medium underline"
          style={{ color: 'var(--accent)' }}
        >
          @{login}
        </a>
        <a
          href={`https://github.com/${login}`}
          target="_blank"
          rel="noopener"
          className="underline"
          style={{ color: 'var(--muted)' }}
        >
          GitHub
        </a>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-24 shrink-0 font-medium" style={{ color: 'var(--muted)' }}>{label}</span>
      <span style={{ color: 'var(--ink)' }}>{children}</span>
    </div>
  )
}

function timeAgo(iso: string): string {
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) return '-'
  const diff = Date.now() - ms
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
