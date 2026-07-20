import { useState, useEffect, useMemo } from 'react'
import type { UnifiedApp, DeployStatus, DeployStatusMap } from './api.ts'
import { api } from './api.ts'
import { Loading, ErrorBox } from './Overview.tsx'

const PAGE_SIZE = 25

type DeployKind = 'success' | 'failed' | 'building' | 'unknown'
function deployKind(d?: DeployStatus): DeployKind {
  if (!d || !d.status) return 'unknown'
  if (d.status !== 'completed') return 'building'
  if (d.conclusion === 'success') return 'success'
  if (['failure', 'timed_out', 'cancelled', 'startup_failure'].includes(d.conclusion ?? '')) return 'failed'
  return 'unknown'
}

export function AppList({ navigate, owner }: { navigate: (h: string) => void; owner?: string }) {
  const [items, setItems] = useState<UnifiedApp[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [deploys, setDeploys] = useState<DeployStatusMap>({})
  const [failingOnly, setFailingOnly] = useState(false)

  useEffect(() => {
    setLoading(true)
    setError(null)
    api<UnifiedApp[]>('/api/apps/all')
      .then((all) => setItems(all.filter((a) => a.store === 'apps')))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
    // Deploy status is a GitHub fan-out (cached 5 min server-side) — load it
    // separately so the list renders immediately and badges fill in after.
    api<DeployStatusMap>('/api/apps/deploy-status').then(setDeploys).catch(() => {})
  }, [])

  const failingCount = useMemo(
    () => items.filter((a) => deployKind(deploys[a.id]) === 'failed').length,
    [items, deploys],
  )

  const filtered = useMemo(() => {
    let list = items
    // Owner drill-down (#/apps/owner/<login>): only this person's apps.
    if (owner) list = list.filter((a) => (a.owner ?? '').toLowerCase() === owner.toLowerCase())
    if (failingOnly) list = list.filter((a) => deployKind(deploys[a.id]) === 'failed')
    if (!search) return list
    const q = search.toLowerCase()
    return list.filter((a) =>
      a.id.includes(q) || a.name.toLowerCase().includes(q) || (a.owner ?? '').toLowerCase().includes(q) || a.domain.includes(q),
    )
  }, [items, search, owner, failingOnly, deploys])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // Reset to page 1 when the search / owner / failing filter changes
  useEffect(() => setPage(1), [search, owner, failingOnly])

  if (loading) return <Loading />
  if (error) return <ErrorBox message={error} />

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">{owner ? `Apps by @${owner}` : 'Apps'}</h1>
          {owner && (
            <button onClick={() => navigate('/apps')} className="text-xs mt-0.5" style={{ color: 'var(--accent)' }}>
              ← All apps
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {failingCount > 0 && (
            <button
              onClick={() => setFailingOnly((v) => !v)}
              className="text-xs font-semibold px-3 py-2 rounded-lg"
              title="Apps whose latest deploy failed"
              style={failingOnly
                ? { background: 'var(--danger)', color: '#fff' }
                : { border: '1px solid var(--danger)', color: 'var(--danger)', background: 'transparent' }}
            >
              ⚠ {failingCount} failing
            </button>
          )}
          <input
            type="text"
            placeholder="Search apps..."
            aria-label="Search apps"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-2 rounded-lg text-sm"
            style={{ border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--ink)', width: 220 }}
          />
          <button
            onClick={() => navigate('/provision')}
            className="text-sm font-semibold px-3.5 py-1.5 rounded-lg"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            + Provision
          </button>
        </div>
      </div>

      <div className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
        {filtered.length} app{filtered.length !== 1 ? 's' : ''}{search ? ` matching "${search}"` : ''}
        {totalPages > 1 ? ` — page ${page} of ${totalPages}` : ''}
      </div>

      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--line)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--panel)', borderBottom: '1px solid var(--line)' }}>
              <th className="text-left px-4 py-3 font-semibold" style={{ color: 'var(--muted)' }}>Name</th>
              <th className="text-left px-4 py-3 font-semibold hidden sm:table-cell" style={{ color: 'var(--muted)' }}>Domain</th>
              <th className="text-left px-4 py-3 font-semibold" style={{ color: 'var(--muted)' }}>Hosting</th>
              <th className="text-left px-4 py-3 font-semibold hidden sm:table-cell" style={{ color: 'var(--muted)' }}>Deploy</th>
              <th className="text-left px-4 py-3 font-semibold hidden md:table-cell" style={{ color: 'var(--muted)' }}>Registry</th>
              <th className="text-left px-4 py-3 font-semibold hidden md:table-cell" style={{ color: 'var(--muted)' }}>Owner</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.map((app) => (
              <tr
                key={`${app.id}-${app.domain}`}
                onClick={() => navigate(`/apps/${app.id}`)}
                className="cursor-pointer"
                style={{ borderBottom: '1px solid var(--line)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--panel)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <td className="px-4 py-3">
                  <p className="font-medium" style={{ color: 'var(--ink)' }}>{app.name}</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{app.id}</p>
                </td>
                <td className="px-4 py-3 hidden sm:table-cell">
                  <span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>{app.domain}</span>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge
                    status={app.hostedOn === 'r2' ? 'success' : 'unknown'}
                    label={app.hostedOn === 'r2' ? 'R2' : app.hostedOn}
                  />
                </td>
                <td className="px-4 py-3 hidden sm:table-cell">
                  <DeployBadge kind={deployKind(deploys[app.id])} loaded={Object.keys(deploys).length > 0} />
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  <StatusBadge
                    status={app.inRegistry ? 'active' : 'not_configured'}
                    label={app.inRegistry ? 'listed' : 'unlisted'}
                  />
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  {app.owner ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); navigate('/apps/owner/' + encodeURIComponent(app.owner!)) }}
                      className="text-xs hover:underline"
                      style={{ color: 'var(--accent)' }}
                      title={`All apps by ${app.owner}`}
                    >
                      {app.owner}
                    </button>
                  ) : (
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pageItems.length === 0 && (
          <div className="py-12 text-center" style={{ color: 'var(--muted)' }}>
            {search ? `No apps matching "${search}"` : 'No apps found.'}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 rounded-lg text-sm"
            style={{ border: '1px solid var(--line)', color: 'var(--ink)', opacity: page === 1 ? 0.4 : 1, cursor: page === 1 ? 'default' : 'pointer' }}
          >
            ← Prev
          </button>
          <span className="text-sm" style={{ color: 'var(--muted)' }}>
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1.5 rounded-lg text-sm"
            style={{ border: '1px solid var(--line)', color: 'var(--ink)', opacity: page === totalPages ? 0.4 : 1, cursor: page === totalPages ? 'default' : 'pointer' }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

function DeployBadge({ kind, loaded }: { kind: DeployKind; loaded: boolean }) {
  if (!loaded && kind === 'unknown') return <span className="text-xs" style={{ color: 'var(--muted)' }}>…</span>
  if (kind === 'success') return <StatusBadge status="success" label="deployed" />
  if (kind === 'failed') return <StatusBadge status="failure" label="build failed" />
  if (kind === 'building') return <StatusBadge status="idle" label="building" />
  return <span className="text-xs" style={{ color: 'var(--muted)' }}>—</span>
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const display = label ?? status
  let bg: string
  let fg: string
  switch (status) {
    case 'success':
    case 'active':
      bg = 'rgba(47, 143, 87, 0.12)'
      fg = 'var(--success)'
      break
    case 'failure':
    case 'fail':
    case 'not_configured':
      bg = 'rgba(199, 79, 67, 0.12)'
      fg = 'var(--danger)'
      break
    case 'idle':
    case 'none':
    case 'no_project':
      bg = 'rgba(198, 134, 42, 0.12)'
      fg = 'var(--warning)'
      break
    default:
      bg = 'var(--line)'
      fg = 'var(--muted)'
  }
  return (
    <span
      className="inline-block px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ background: bg, color: fg }}
    >
      {display}
    </span>
  )
}
