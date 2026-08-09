import { useState, useEffect, useCallback } from 'react'
import type {
  CollectionDoc,
  CollectionsResponse,
  Counter,
  CountersResponse,
  KvEntry,
  KvEntriesResponse,
  KvValueResponse,
} from './api.ts'
import { api } from './api.ts'
import { ErrorBox, Loading } from './Overview.tsx'

type Tab = 'kv' | 'collections' | 'counters'

export function ContentData() {
  const [tab, setTab] = useState<Tab>('kv')

  return (
    <div>
      <div className="flex items-start justify-between mb-5 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Content Data</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            Browse and delete user data stored by apps — KV entries, collection documents, and counters.
          </p>
        </div>
      </div>

      <div className="flex gap-1 mb-5">
        {(['kv', 'collections', 'counters'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-3 py-1.5 rounded-md text-sm font-medium"
            style={{
              background: tab === t ? 'var(--accent-soft)' : 'transparent',
              color: tab === t ? 'var(--accent)' : 'var(--muted)',
            }}
          >
            {t === 'kv' ? 'KV Store' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'kv' && <KvTab />}
      {tab === 'collections' && <CollectionsTab />}
      {tab === 'counters' && <CountersTab />}
    </div>
  )
}

function KvTab() {
  const [entries, setEntries] = useState<KvEntry[]>([])
  const [appFilter, setAppFilter] = useState('')
  const [userFilter, setUserFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [valueCache, setValueCache] = useState<Record<string, unknown>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (appFilter.trim()) params.set('app', appFilter.trim())
      if (userFilter.trim()) params.set('user', userFilter.trim())
      const data = await api<KvEntriesResponse>(`/api/content/kv?${params}`)
      setEntries(data.entries)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [appFilter, userFilter])

  useEffect(() => { load() }, [load])

  const loadValue = async (entry: KvEntry) => {
    const cacheKey = `${entry.app_id}:${entry.user_id}:${entry.key}`
    if (valueCache[cacheKey] !== undefined) {
      setExpanded(expanded === cacheKey ? null : cacheKey)
      return
    }
    try {
      const params = new URLSearchParams({ app: entry.app_id, user: entry.user_id, key: entry.key })
      const data = await api<KvValueResponse>(`/api/content/kv/value?${params}`)
      setValueCache((prev) => ({ ...prev, [cacheKey]: data.value }))
      setExpanded(cacheKey)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const deleteEntry = async (entry: KvEntry) => {
    if (!window.confirm(`Delete KV entry "${entry.key}" for user ${entry.user_id} in ${entry.app_id}?`)) return
    try {
      const params = new URLSearchParams({ app: entry.app_id, user: entry.user_id, key: entry.key })
      await api(`/api/content/kv?${params}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap">
        <input
          value={appFilter}
          onChange={(e) => setAppFilter(e.target.value)}
          placeholder="Filter by app ID"
          className="px-3 py-2 rounded-lg text-sm"
          style={{ border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--ink)', width: 180 }}
        />
        <input
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
          placeholder="Filter by user ID"
          className="px-3 py-2 rounded-lg text-sm"
          style={{ border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--ink)', width: 180 }}
        />
        <button
          onClick={load}
          className="px-3 py-2 rounded-lg text-sm font-semibold"
          style={{ border: '1px solid var(--line)', color: 'var(--ink)' }}
        >
          Search
        </button>
      </div>

      {error && <ErrorBox message={error} />}
      {loading ? (
        <Loading />
      ) : entries.length === 0 ? (
        <div className="py-12 text-center" style={{ color: 'var(--muted)' }}>No KV entries found.</div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--line)' }}>
          {entries.map((entry) => {
            const cacheKey = `${entry.app_id}:${entry.user_id}:${entry.key}`
            return (
              <div key={cacheKey} style={{ borderBottom: '1px solid var(--line)' }}>
                <div className="flex items-center gap-2 px-4 py-2.5 text-xs">
                  <span
                    className="font-mono font-semibold flex-shrink-0 w-24 truncate"
                    style={{ color: 'var(--accent)' }}
                    title={entry.app_id}
                  >
                    {entry.app_id}
                  </span>
                  <span
                    className="font-mono flex-shrink-0 w-16 truncate"
                    style={{ color: 'var(--muted)' }}
                    title={entry.user_id}
                  >
                    {entry.user_id.slice(0, 8)}
                  </span>
                  <button
                    onClick={() => loadValue(entry)}
                    className="font-mono flex-1 text-left truncate hover:underline"
                    style={{ color: 'var(--ink)' }}
                    title={entry.key}
                  >
                    {entry.key}
                  </button>
                  <span className="flex-shrink-0" style={{ color: 'var(--muted)' }}>
                    {entry.size}B
                  </span>
                  <button
                    onClick={() => deleteEntry(entry)}
                    className="flex-shrink-0 px-2 py-1 rounded text-xs font-semibold"
                    style={{ color: 'var(--danger)' }}
                  >
                    Del
                  </button>
                </div>
                {expanded === cacheKey && valueCache[cacheKey] !== undefined && (
                  <pre
                    className="px-4 py-2 text-xs font-mono whitespace-pre-wrap break-all overflow-auto"
                    style={{
                      maxHeight: 200,
                      background: 'var(--paper)',
                      color: 'var(--ink)',
                      borderTop: '1px solid var(--line)',
                    }}
                  >
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

function CollectionsTab() {
  const [docs, setDocs] = useState<CollectionDoc[]>([])
  const [appFilter, setAppFilter] = useState('')
  const [collFilter, setCollFilter] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (appFilter.trim()) params.set('app', appFilter.trim())
      if (collFilter.trim()) params.set('collection', collFilter.trim())
      const data = await api<CollectionsResponse>(`/api/content/collections?${params}`)
      setDocs(data.documents)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [appFilter, collFilter])

  useEffect(() => { load() }, [load])

  const deleteDoc = async (doc: CollectionDoc) => {
    if (!window.confirm(`Delete document ${doc.id} from ${doc.collection} in ${doc.app_id}?`)) return
    try {
      const params = new URLSearchParams({ app: doc.app_id, collection: doc.collection, id: doc.id })
      await api(`/api/content/collections?${params}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap">
        <input
          value={appFilter}
          onChange={(e) => setAppFilter(e.target.value)}
          placeholder="Filter by app ID"
          className="px-3 py-2 rounded-lg text-sm"
          style={{ border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--ink)', width: 180 }}
        />
        <input
          value={collFilter}
          onChange={(e) => setCollFilter(e.target.value)}
          placeholder="Collection name"
          className="px-3 py-2 rounded-lg text-sm"
          style={{ border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--ink)', width: 180 }}
        />
        <button
          onClick={load}
          className="px-3 py-2 rounded-lg text-sm font-semibold"
          style={{ border: '1px solid var(--line)', color: 'var(--ink)' }}
        >
          Search
        </button>
      </div>

      {error && <ErrorBox message={error} />}
      {loading ? (
        <Loading />
      ) : docs.length === 0 ? (
        <div className="py-12 text-center" style={{ color: 'var(--muted)' }}>No documents found.</div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--line)' }}>
          {docs.map((doc, i) => (
            <div key={doc.id} style={{ borderBottom: '1px solid var(--line)' }}>
              <div className="flex items-center gap-2 px-4 py-2.5 text-xs">
                <span
                  className="font-mono font-semibold flex-shrink-0 w-24 truncate"
                  style={{ color: 'var(--accent)' }}
                  title={doc.app_id}
                >
                  {doc.app_id}
                </span>
                <span
                  className="font-mono flex-shrink-0 w-24 truncate"
                  style={{ color: 'var(--muted)' }}
                  title={doc.collection}
                >
                  {doc.collection}
                </span>
                <button
                  onClick={() => setExpanded(expanded === i ? null : i)}
                  className="font-mono flex-1 text-left truncate hover:underline"
                  style={{ color: 'var(--ink)' }}
                  title={doc.id}
                >
                  {doc.id.slice(0, 12)}
                </button>
                <span
                  className="flex-shrink-0 w-16 truncate"
                  style={{ color: 'var(--muted)' }}
                  title={doc.owner_id}
                >
                  {doc.owner_id.slice(0, 8)}
                </span>
                <button
                  onClick={() => deleteDoc(doc)}
                  className="flex-shrink-0 px-2 py-1 rounded text-xs font-semibold"
                  style={{ color: 'var(--danger)' }}
                >
                  Del
                </button>
              </div>
              {expanded === i && (
                <pre
                  className="px-4 py-2 text-xs font-mono whitespace-pre-wrap break-all overflow-auto"
                  style={{
                    maxHeight: 200,
                    background: 'var(--paper)',
                    color: 'var(--ink)',
                    borderTop: '1px solid var(--line)',
                  }}
                >
                  {JSON.stringify(doc.data, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CountersTab() {
  const [counters, setCounters] = useState<Counter[]>([])
  const [appFilter, setAppFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ limit: '100' })
      if (appFilter.trim()) params.set('app', appFilter.trim())
      const data = await api<CountersResponse>(`/api/content/counters?${params}`)
      setCounters(data.counters)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [appFilter])

  useEffect(() => { load() }, [load])

  const deleteCounter = async (counter: Counter) => {
    if (!window.confirm(`Delete counter "${counter.name}" in ${counter.app_id}?`)) return
    try {
      const params = new URLSearchParams({ app: counter.app_id, name: counter.name })
      await api(`/api/content/counters?${params}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <input
          value={appFilter}
          onChange={(e) => setAppFilter(e.target.value)}
          placeholder="Filter by app ID"
          className="px-3 py-2 rounded-lg text-sm"
          style={{ border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--ink)', width: 180 }}
        />
        <button
          onClick={load}
          className="px-3 py-2 rounded-lg text-sm font-semibold"
          style={{ border: '1px solid var(--line)', color: 'var(--ink)' }}
        >
          Search
        </button>
      </div>

      {error && <ErrorBox message={error} />}
      {loading ? (
        <Loading />
      ) : counters.length === 0 ? (
        <div className="py-12 text-center" style={{ color: 'var(--muted)' }}>No counters found.</div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--line)' }}>
          {counters.map((counter, i) => (
            <div
              key={i}
              className="flex items-center gap-2 px-4 py-2.5 text-xs"
              style={{ borderBottom: '1px solid var(--line)' }}
            >
              <span
                className="font-mono font-semibold flex-shrink-0 w-24 truncate"
                style={{ color: 'var(--accent)' }}
                title={counter.app_id}
              >
                {counter.app_id}
              </span>
              <span className="font-mono flex-1 truncate" style={{ color: 'var(--ink)' }}>
                {counter.name}
              </span>
              <span className="font-bold flex-shrink-0 w-16 text-right" style={{ color: 'var(--ink)' }}>
                {counter.value}
              </span>
              <button
                onClick={() => deleteCounter(counter)}
                className="flex-shrink-0 px-2 py-1 rounded text-xs font-semibold"
                style={{ color: 'var(--danger)' }}
              >
                Del
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
