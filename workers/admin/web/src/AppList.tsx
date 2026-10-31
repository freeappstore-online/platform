import { Button, Input, StatusBadge } from './ui.tsx'
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
  if (
    ['failure', 'timed_out', 'cancelled', 'startup_failure'].includes(
      d.conclusion ?? '',
    )
  )
    return 'failed'
  return 'unknown'
}

export function AppList({
  navigate,
  owner,
}: {
  navigate: (h: string) => void
  owner?: string
}) {
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
    api<DeployStatusMap>('/api/apps/deploy-status')
      .then(setDeploys)
      .catch(() => {})
  }, [])

  const failingCount = useMemo(
    () => items.filter((a) => deployKind(deploys[a.id]) === 'failed').length,
    [items, deploys],
  )

  const filtered = useMemo(() => {
    let list = items
    // Owner drill-down (#/apps/owner/<login>): only this person's apps.
    if (owner)
      list = list.filter(
        (a) => (a.owner ?? '').toLowerCase() === owner.toLowerCase(),
      )
    if (failingOnly)
      list = list.filter((a) => deployKind(deploys[a.id]) === 'failed')
    if (!search) return list
    const q = search.toLowerCase()
    return list.filter(
      (a) =>
        a.id.includes(q) ||
        a.name.toLowerCase().includes(q) ||
        (a.owner ?? '').toLowerCase().includes(q) ||
        a.domain.includes(q),
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
          <h1 className="text-2xl font-bold">
            {owner ? `Apps by @${owner}` : 'Apps'}
          </h1>
          {owner && (
            <Button
              onClick={() => navigate('/apps')}
              className="text-xs mt-0.5 text-accent"
            >
              ← All apps
            </Button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {failingCount > 0 && (
            <Button
              onClick={() => setFailingOnly((v) => !v)}
              className={`text-xs font-semibold px-3 py-2 rounded-lg ${failingOnly ? 'bg-danger text-white' : 'border border-danger text-danger bg-transparent'}`}
              title="Apps whose latest deploy failed"
            >
              ⚠ {failingCount} failing
            </Button>
          )}
          <Input
            type="text"
            placeholder="Search apps..."
            aria-label="Search apps"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-[220px]"
          />
          <Button
            onClick={() => navigate('/provision')}
            className="text-sm font-semibold px-3.5 py-1.5 rounded-lg"
            variant="primary"
          >
            + Provision
          </Button>
        </div>
      </div>

      <div className="text-xs mb-3 text-muted">
        {filtered.length} app{filtered.length !== 1 ? 's' : ''}
        {search ? ` matching "${search}"` : ''}
        {totalPages > 1 ? ` — page ${page} of ${totalPages}` : ''}
      </div>

      <div className="rounded-xl overflow-hidden border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-panel border-b border-line">
              <th className="text-left px-4 py-3 font-semibold text-muted">
                Name
              </th>
              <th className="text-left px-4 py-3 font-semibold hidden sm:table-cell text-muted">
                Domain
              </th>
              <th className="text-left px-4 py-3 font-semibold text-muted">
                Hosting
              </th>
              <th className="text-left px-4 py-3 font-semibold hidden sm:table-cell text-muted">
                Deploy
              </th>
              <th className="text-left px-4 py-3 font-semibold hidden md:table-cell text-muted">
                Registry
              </th>
              <th className="text-left px-4 py-3 font-semibold hidden md:table-cell text-muted">
                Owner
              </th>
            </tr>
          </thead>
          <tbody>
            {pageItems.map((app) => (
              <tr
                key={`${app.id}-${app.domain}`}
                onClick={() => navigate(`/apps/${app.id}`)}
                className="cursor-pointer hover:bg-panel border-b border-line"
              >
                <td className="px-4 py-3">
                  <p className="font-medium text-ink">{app.name}</p>
                  <p className="text-xs mt-0.5 text-muted">{app.id}</p>
                </td>
                <td className="px-4 py-3 hidden sm:table-cell">
                  <span className="text-xs font-mono text-muted">
                    {app.domain}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge
                    status={app.hostedOn === 'r2' ? 'success' : 'unknown'}
                    label={app.hostedOn === 'r2' ? 'R2' : app.hostedOn}
                  />
                </td>
                <td className="px-4 py-3 hidden sm:table-cell">
                  <DeployBadge
                    kind={deployKind(deploys[app.id])}
                    loaded={Object.keys(deploys).length > 0}
                  />
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  <StatusBadge
                    status={app.inRegistry ? 'active' : 'not_configured'}
                    label={app.inRegistry ? 'listed' : 'unlisted'}
                  />
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  {app.owner ? (
                    <Button
                      onClick={(e) => {
                        e.stopPropagation()
                        navigate(
                          '/apps/owner/' + encodeURIComponent(app.owner!),
                        )
                      }}
                      className="text-xs hover:underline text-accent"
                      title={`All apps by ${app.owner}`}
                    >
                      {app.owner}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pageItems.length === 0 && (
          <div className="py-12 text-center text-muted">
            {search ? `No apps matching "${search}"` : 'No apps found.'}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <Button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className={`px-3 py-1.5 rounded-lg text-sm ${page === 1 ? 'opacity-40' : 'opacity-100'} ${page === 1 ? 'cursor-default' : 'cursor-pointer'}`}
            variant="outline"
          >
            ← Prev
          </Button>
          <span className="text-sm text-muted">
            {page} / {totalPages}
          </span>
          <Button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className={`px-3 py-1.5 rounded-lg text-sm ${page === totalPages ? 'opacity-40' : 'opacity-100'} ${page === totalPages ? 'cursor-default' : 'cursor-pointer'}`}
            variant="outline"
          >
            Next →
          </Button>
        </div>
      )}
    </div>
  )
}

function DeployBadge({ kind, loaded }: { kind: DeployKind; loaded: boolean }) {
  if (!loaded && kind === 'unknown')
    return <span className="text-xs text-muted">…</span>
  if (kind === 'success')
    return <StatusBadge status="success" label="deployed" />
  if (kind === 'failed')
    return <StatusBadge status="failure" label="build failed" />
  if (kind === 'building') return <StatusBadge status="idle" label="building" />
  return <span className="text-xs text-muted">—</span>
}
