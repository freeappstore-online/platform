import { useState, useEffect, useMemo } from 'react'
import type { UnifiedApp } from './api.ts'
import { api } from './api.ts'
import { Loading, ErrorBox } from './Overview.tsx'

const PAGE_SIZE = 25

export function AppList({ navigate }: { navigate: (h: string) => void }) {
  const [items, setItems] = useState<UnifiedApp[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    setLoading(true)
    setError(null)
    api<UnifiedApp[]>('/api/apps/all')
      .then((all) => setItems(all.filter((a) => a.store === 'apps')))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    if (!search) return items
    const q = search.toLowerCase()
    return items.filter((a) =>
      a.id.includes(q) || a.name.toLowerCase().includes(q) || (a.owner ?? '').toLowerCase().includes(q) || a.domain.includes(q),
    )
  }, [items, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // Reset to page 1 when search changes
  useEffect(() => setPage(1), [search])

  if (loading) return <Loading />
  if (error) return <ErrorBox message={error} />

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">Apps</h1>
        <div className="flex items-center gap-3">
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
                <td className="px-4 py-3 hidden md:table-cell">
                  <StatusBadge
                    status={app.inRegistry ? 'active' : 'not_configured'}
                    label={app.inRegistry ? 'listed' : 'unlisted'}
                  />
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>{app.owner ?? '-'}</span>
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
      fg = 'var(--error)'
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
