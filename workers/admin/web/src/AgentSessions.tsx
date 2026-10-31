import { Button, Input, StatusBadge } from './ui.tsx'
import { useState, useEffect } from 'react'
import type { AgentSessionsResponse } from './api.ts'
import { api } from './api.ts'
import { Loading, ErrorBox } from './Overview.tsx'

export function AgentSessions({ navigate }: { navigate: (h: string) => void }) {
  const [data, setData] = useState<AgentSessionsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ page: String(page) })
    if (search) params.set('q', search)
    api<AgentSessionsResponse>(`/api/agent/sessions?${params}`)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [page, search])

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">VibeCode Sessions</h1>
          {data && (
            <p className="text-sm mt-1 text-muted">
              {data.total} total sessions
            </p>
          )}
        </div>
        <Input
          type="text"
          placeholder="Search sessions..."
          aria-label="Search sessions"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          className="w-64"
        />
      </div>

      {loading && <Loading />}
      {error && <ErrorBox message={error} />}

      {data && !loading && (
        <>
          <div className="rounded-xl overflow-hidden border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-panel border-b border-line">
                  <th className="text-left px-4 py-3 font-semibold text-muted">
                    Project
                  </th>
                  <th className="text-left px-4 py-3 font-semibold hidden sm:table-cell text-muted">
                    App ID
                  </th>
                  <th className="text-left px-4 py-3 font-semibold text-muted">
                    Status
                  </th>
                  <th className="text-left px-4 py-3 font-semibold hidden md:table-cell text-muted">
                    Last Activity
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((s) => (
                  <tr
                    key={s.sessionId}
                    onClick={() => navigate(`/agent/${s.sessionId}`)}
                    className="cursor-pointer hover:bg-panel border-b border-line"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink">{s.name}</p>
                      <p className="text-xs mt-0.5 font-mono text-muted">
                        {s.sessionId.slice(0, 12)}...
                      </p>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      {s.appId ? (
                        <span className="text-xs font-mono text-accent">
                          {s.appId}
                        </span>
                      ) : (
                        <span className="text-xs text-muted">not deployed</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        status={
                          s.deployed
                            ? 'success'
                            : s.deployState?.phase === 'error'
                              ? 'failure'
                              : 'idle'
                        }
                        label={
                          s.deployed
                            ? 'deployed'
                            : (s.deployState?.phase ?? 'building')
                        }
                      />
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className="text-xs text-muted">
                        {timeAgo(s.updatedAt)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.sessions.length === 0 && (
              <div className="py-12 text-center text-muted">
                No sessions found.
              </div>
            )}
          </div>

          {data.pages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-4">
              <Button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className={`px-3 py-1.5 rounded-lg text-sm ${page === 1 ? 'opacity-40' : 'opacity-100'}`}
                variant="outline"
              >
                Previous
              </Button>
              <span className="text-sm text-muted">
                Page {page} of {data.pages}
              </span>
              <Button
                onClick={() => setPage((p) => Math.min(data.pages, p + 1))}
                disabled={page === data.pages}
                className={`px-3 py-1.5 rounded-lg text-sm ${page === data.pages ? 'opacity-40' : 'opacity-100'}`}
                variant="outline"
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function timeAgo(ts: number): string {
  if (!ts || Number.isNaN(ts)) return '-'
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
