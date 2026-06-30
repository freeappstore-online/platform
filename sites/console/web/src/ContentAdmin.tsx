import { useState, useEffect, useCallback } from 'react'

const API = 'https://api.freeappstore.online/v1'

type Tab = 'overview' | 'kv' | 'collections' | 'counters' | 'users'

interface Props {
  getToken: () => string | null
}

export function ContentAdmin({ getToken }: Props) {
  const [tab, setTab] = useState<Tab>('overview')
  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = getToken()
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }, [getToken])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {(['overview', 'kv', 'collections', 'counters', 'users'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap min-h-[36px] ${
              tab === t
                ? 'bg-[var(--ink)] text-[var(--paper)]'
                : 'text-[var(--muted)] border border-[var(--line)]'
            }`}
          >
            {t === 'kv' ? 'KV Store' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'overview' && <OverviewTab headers={headers} />}
      {tab === 'kv' && <KvTab headers={headers} />}
      {tab === 'collections' && <CollectionsTab headers={headers} />}
      {tab === 'counters' && <CountersTab headers={headers} />}
      {tab === 'users' && <UsersTab headers={headers} />}
    </div>
  )
}

function OverviewTab({ headers }: { headers: () => Record<string, string> }) {
  const [stats, setStats] = useState<Record<string, number> | null>(null)
  useEffect(() => {
    fetch(`${API}/admin/stats`, { headers: headers() })
      .then(r => r.ok ? r.json() : null)
      .then(d => setStats(d as Record<string, number>))
      .catch(() => {})
  }, [headers])

  if (!stats) return <p className="text-sm text-[var(--muted)]">Loading...</p>

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {Object.entries(stats).map(([k, v]) => (
        <div key={k} className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
          <p className="text-xs font-semibold text-[var(--muted)] uppercase">{k}</p>
          <p className="mt-1 text-2xl font-bold text-[var(--ink)]">{v}</p>
        </div>
      ))}
    </div>
  )
}

function KvTab({ headers }: { headers: () => Record<string, string> }) {
  const [entries, setEntries] = useState<Array<Record<string, unknown>>>([])
  const [appFilter, setAppFilter] = useState('')
  const [userFilter, setUserFilter] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [valueCache, setValueCache] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '50' })
    if (appFilter) params.set('app', appFilter)
    if (userFilter) params.set('user', userFilter)
    const res = await fetch(`${API}/admin/kv?${params}`, { headers: headers() })
    if (res.ok) {
      const data = await res.json() as { entries: Array<Record<string, unknown>> }
      setEntries(data.entries ?? [])
    }
    setLoading(false)
  }, [appFilter, userFilter, headers])

  useEffect(() => { load() }, [load])

  const loadValue = async (app: string, user: string, key: string) => {
    const cacheKey = `${app}:${user}:${key}`
    if (valueCache[cacheKey]) { setExpanded(cacheKey); return }
    const res = await fetch(`${API}/admin/kv/value?app=${app}&user=${user}&key=${encodeURIComponent(key)}`, { headers: headers() })
    if (res.ok) {
      const data = await res.json() as { value: unknown }
      setValueCache(prev => ({ ...prev, [cacheKey]: data.value }))
      setExpanded(cacheKey)
    }
  }

  const deleteEntry = async (app: string, user: string, key: string) => {
    if (!confirm(`Delete KV entry "${key}" for user ${user} in ${app}?`)) return
    await fetch(`${API}/admin/kv?app=${app}&user=${user}&key=${encodeURIComponent(key)}`, { method: 'DELETE', headers: headers() })
    load()
  }

  return (
    <div>
      <div className="flex gap-2 mb-3 flex-wrap">
        <input value={appFilter} onChange={e => setAppFilter(e.target.value)} placeholder="Filter by app" className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-sm text-[var(--ink)] min-h-[36px] w-32" />
        <input value={userFilter} onChange={e => setUserFilter(e.target.value)} placeholder="Filter by user" className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-sm text-[var(--ink)] min-h-[36px] w-32" />
        <button onClick={load} className="text-xs font-semibold text-[var(--accent)] min-h-[36px] px-2">Search</button>
      </div>
      {loading ? <p className="text-sm text-[var(--muted)]">Loading...</p> : entries.length === 0 ? <p className="text-sm text-[var(--muted)]">No entries found.</p> : (
        <div className="rounded-xl border border-[var(--line)] overflow-hidden">
          {entries.map((e, i) => {
            const cacheKey = `${e.app_id}:${e.user_id}:${e.key}`
            return (
              <div key={i} className="border-b border-[var(--line)] last:border-0">
                <div className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span className="font-mono text-[var(--accent)] w-20 truncate flex-shrink-0">{String(e.app_id)}</span>
                  <span className="font-mono text-[var(--muted)] w-20 truncate flex-shrink-0">{String(e.user_id).slice(0, 8)}</span>
                  <button onClick={() => loadValue(String(e.app_id), String(e.user_id), String(e.key))} className="font-mono text-[var(--ink)] truncate flex-1 text-left hover:underline">{String(e.key)}</button>
                  <span className="text-[var(--muted)] flex-shrink-0">{String(e.size)}B</span>
                  <button onClick={() => deleteEntry(String(e.app_id), String(e.user_id), String(e.key))} className="text-[var(--error)] font-semibold flex-shrink-0 min-h-[32px] px-1">Del</button>
                </div>
                {expanded === cacheKey && valueCache[cacheKey] !== undefined && (
                  <pre className="px-3 py-2 text-xs font-mono bg-[var(--paper)] text-[var(--ink)] whitespace-pre-wrap break-all max-h-[200px] overflow-auto border-t border-[var(--line)]">
                    {JSON.stringify(valueCache[cacheKey], null, 2)}
                  </pre>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CollectionsTab({ headers }: { headers: () => Record<string, string> }) {
  const [docs, setDocs] = useState<Array<Record<string, unknown>>>([])
  const [appFilter, setAppFilter] = useState('')
  const [collFilter, setCollFilter] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '50' })
    if (appFilter) params.set('app', appFilter)
    if (collFilter) params.set('collection', collFilter)
    const res = await fetch(`${API}/admin/collections?${params}`, { headers: headers() })
    if (res.ok) {
      const data = await res.json() as { documents: Array<Record<string, unknown>> }
      setDocs(data.documents ?? [])
    }
    setLoading(false)
  }, [appFilter, collFilter, headers])

  useEffect(() => { load() }, [load])

  const deleteDoc = async (app: string, collection: string, id: string) => {
    if (!confirm(`Delete document ${id} from ${collection} in ${app}?`)) return
    await fetch(`${API}/admin/collections?app=${app}&collection=${collection}&id=${id}`, { method: 'DELETE', headers: headers() })
    load()
  }

  return (
    <div>
      <div className="flex gap-2 mb-3 flex-wrap">
        <input value={appFilter} onChange={e => setAppFilter(e.target.value)} placeholder="Filter by app" className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-sm text-[var(--ink)] min-h-[36px] w-32" />
        <input value={collFilter} onChange={e => setCollFilter(e.target.value)} placeholder="Collection name" className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-sm text-[var(--ink)] min-h-[36px] w-32" />
        <button onClick={load} className="text-xs font-semibold text-[var(--accent)] min-h-[36px] px-2">Search</button>
      </div>
      {loading ? <p className="text-sm text-[var(--muted)]">Loading...</p> : docs.length === 0 ? <p className="text-sm text-[var(--muted)]">No documents found.</p> : (
        <div className="rounded-xl border border-[var(--line)] overflow-hidden">
          {docs.map((d, i) => (
            <div key={i} className="border-b border-[var(--line)] last:border-0">
              <div className="flex items-center gap-2 px-3 py-2 text-xs">
                <span className="font-mono text-[var(--accent)] w-20 truncate flex-shrink-0">{String(d.app_id)}</span>
                <span className="font-mono text-[var(--muted)] w-20 truncate flex-shrink-0">{String(d.collection)}</span>
                <button onClick={() => setExpanded(expanded === i ? null : i)} className="font-mono text-[var(--ink)] truncate flex-1 text-left hover:underline">{String(d.id).slice(0, 12)}</button>
                <span className="text-[var(--muted)] flex-shrink-0">{String(d.owner_id).slice(0, 8)}</span>
                <button onClick={() => deleteDoc(String(d.app_id), String(d.collection), String(d.id))} className="text-[var(--error)] font-semibold flex-shrink-0 min-h-[32px] px-1">Del</button>
              </div>
              {expanded === i && (
                <pre className="px-3 py-2 text-xs font-mono bg-[var(--paper)] text-[var(--ink)] whitespace-pre-wrap break-all max-h-[200px] overflow-auto border-t border-[var(--line)]">
                  {JSON.stringify(d.data, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CountersTab({ headers }: { headers: () => Record<string, string> }) {
  const [counters, setCounters] = useState<Array<Record<string, unknown>>>([])
  const [appFilter, setAppFilter] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '100' })
    if (appFilter) params.set('app', appFilter)
    const res = await fetch(`${API}/admin/counters?${params}`, { headers: headers() })
    if (res.ok) {
      const data = await res.json() as { counters: Array<Record<string, unknown>> }
      setCounters(data.counters ?? [])
    }
    setLoading(false)
  }, [appFilter, headers])

  useEffect(() => { load() }, [load])

  const deleteCounter = async (app: string, name: string) => {
    if (!confirm(`Delete counter "${name}" in ${app}?`)) return
    await fetch(`${API}/admin/counters?app=${app}&name=${encodeURIComponent(name)}`, { method: 'DELETE', headers: headers() })
    load()
  }

  return (
    <div>
      <div className="flex gap-2 mb-3">
        <input value={appFilter} onChange={e => setAppFilter(e.target.value)} placeholder="Filter by app" className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-sm text-[var(--ink)] min-h-[36px] w-40" />
        <button onClick={load} className="text-xs font-semibold text-[var(--accent)] min-h-[36px] px-2">Search</button>
      </div>
      {loading ? <p className="text-sm text-[var(--muted)]">Loading...</p> : counters.length === 0 ? <p className="text-sm text-[var(--muted)]">No counters found.</p> : (
        <div className="rounded-xl border border-[var(--line)] overflow-hidden">
          {counters.map((c, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2 text-xs border-b border-[var(--line)] last:border-0">
              <span className="font-mono text-[var(--accent)] w-20 truncate flex-shrink-0">{String(c.app_id)}</span>
              <span className="font-mono text-[var(--ink)] flex-1 truncate">{String(c.name)}</span>
              <span className="font-bold text-[var(--ink)] w-16 text-right flex-shrink-0">{String(c.value)}</span>
              <button onClick={() => deleteCounter(String(c.app_id), String(c.name))} className="text-[var(--error)] font-semibold flex-shrink-0 min-h-[32px] px-1">Del</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function UsersTab({ headers }: { headers: () => Record<string, string> }) {
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch(`${API}/admin/users?limit=50`, { headers: headers() })
    if (res.ok) {
      const data = await res.json() as { users: Array<Record<string, unknown>>; total: number }
      setUsers(data.users ?? [])
      setTotal(data.total ?? 0)
    }
    setLoading(false)
  }, [headers])

  useEffect(() => { load() }, [load])

  return (
    <div>
      <p className="text-xs text-[var(--muted)] mb-3">{total} total users</p>
      {loading ? <p className="text-sm text-[var(--muted)]">Loading...</p> : (
        <div className="rounded-xl border border-[var(--line)] overflow-hidden">
          {users.map((u, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2 text-xs border-b border-[var(--line)] last:border-0">
              {u.avatar_url ? (
                <img src={String(u.avatar_url)} className="w-6 h-6 rounded-full flex-shrink-0" alt="" />
              ) : (
                <div className="w-6 h-6 rounded-full bg-[var(--accent)] flex-shrink-0" />
              )}
              <span className="font-semibold text-[var(--ink)]">{String(u.github_login)}</span>
              <span className="text-[var(--muted)] font-mono">{String(u.id).slice(0, 8)}</span>
              <span className="text-[var(--muted)] ml-auto">{new Date(String(u.created_at)).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
