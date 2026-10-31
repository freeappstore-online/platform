import { Button, Input, TabButton } from './ui.tsx'
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
          <p className="text-sm mt-1 text-muted">
            Browse and delete user data stored by apps — KV entries, collection
            documents, and counters.
          </p>
        </div>
      </div>

      <div className="flex gap-1 mb-5">
        {(['kv', 'collections', 'counters'] as Tab[]).map((t) => (
          <TabButton key={t} onClick={() => setTab(t)} active={tab === t}>
            {t === 'kv' ? 'KV Store' : t.charAt(0).toUpperCase() + t.slice(1)}
          </TabButton>
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

  useEffect(() => {
    load()
  }, [load])

  const loadValue = async (entry: KvEntry) => {
    const cacheKey = `${entry.app_id}:${entry.user_id}:${entry.key}`
    if (valueCache[cacheKey] !== undefined) {
      setExpanded(expanded === cacheKey ? null : cacheKey)
      return
    }
    try {
      const params = new URLSearchParams({
        app: entry.app_id,
        user: entry.user_id,
        key: entry.key,
      })
      const data = await api<KvValueResponse>(`/api/content/kv/value?${params}`)
      setValueCache((prev) => ({ ...prev, [cacheKey]: data.value }))
      setExpanded(cacheKey)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const deleteEntry = async (entry: KvEntry) => {
    if (
      !window.confirm(
        `Delete KV entry "${entry.key}" for user ${entry.user_id} in ${entry.app_id}?`,
      )
    )
      return
    try {
      const params = new URLSearchParams({
        app: entry.app_id,
        user: entry.user_id,
        key: entry.key,
      })
      await api(`/api/content/kv?${params}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap">
        <Input
          value={appFilter}
          onChange={(e) => setAppFilter(e.target.value)}
          placeholder="Filter by app ID"
          className="w-[180px]"
        />
        <Input
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
          placeholder="Filter by user ID"
          className="w-[180px]"
        />
        <Button
          onClick={load}
          className="px-3 py-2 rounded-lg text-sm font-semibold"
          variant="outline"
        >
          Search
        </Button>
      </div>

      {error && <ErrorBox message={error} />}
      {loading ? (
        <Loading />
      ) : entries.length === 0 ? (
        <div className="py-12 text-center text-muted">No KV entries found.</div>
      ) : (
        <div className="rounded-xl overflow-hidden border border-line">
          {entries.map((entry) => {
            const cacheKey = `${entry.app_id}:${entry.user_id}:${entry.key}`
            return (
              <div key={cacheKey} className="border-b border-line">
                <div className="flex items-center gap-2 px-4 py-2.5 text-xs">
                  <span
                    className="font-mono font-semibold shrink-0 w-24 truncate text-accent"
                    title={entry.app_id}
                  >
                    {entry.app_id}
                  </span>
                  <span
                    className="font-mono shrink-0 w-16 truncate text-muted"
                    title={entry.user_id}
                  >
                    {entry.user_id.slice(0, 8)}
                  </span>
                  <Button
                    onClick={() => loadValue(entry)}
                    className="font-mono flex-1 text-left truncate hover:underline text-ink"
                    title={entry.key}
                  >
                    {entry.key}
                  </Button>
                  <span className="shrink-0 text-muted">{entry.size}B</span>
                  <Button
                    onClick={() => deleteEntry(entry)}
                    className="shrink-0 px-2 py-1 rounded text-xs font-semibold text-danger"
                  >
                    Del
                  </Button>
                </div>
                {expanded === cacheKey &&
                  valueCache[cacheKey] !== undefined && (
                    <pre className="px-4 py-2 text-xs font-mono whitespace-pre-wrap break-all overflow-auto max-h-[200px] bg-paper text-ink border-t border-line">
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
      const data = await api<CollectionsResponse>(
        `/api/content/collections?${params}`,
      )
      setDocs(data.documents)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [appFilter, collFilter])

  useEffect(() => {
    load()
  }, [load])

  const deleteDoc = async (doc: CollectionDoc) => {
    if (
      !window.confirm(
        `Delete document ${doc.id} from ${doc.collection} in ${doc.app_id}?`,
      )
    )
      return
    try {
      const params = new URLSearchParams({
        app: doc.app_id,
        collection: doc.collection,
        id: doc.id,
      })
      await api(`/api/content/collections?${params}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap">
        <Input
          value={appFilter}
          onChange={(e) => setAppFilter(e.target.value)}
          placeholder="Filter by app ID"
          className="w-[180px]"
        />
        <Input
          value={collFilter}
          onChange={(e) => setCollFilter(e.target.value)}
          placeholder="Collection name"
          className="w-[180px]"
        />
        <Button
          onClick={load}
          className="px-3 py-2 rounded-lg text-sm font-semibold"
          variant="outline"
        >
          Search
        </Button>
      </div>

      {error && <ErrorBox message={error} />}
      {loading ? (
        <Loading />
      ) : docs.length === 0 ? (
        <div className="py-12 text-center text-muted">No documents found.</div>
      ) : (
        <div className="rounded-xl overflow-hidden border border-line">
          {docs.map((doc, i) => (
            <div key={doc.id} className="border-b border-line">
              <div className="flex items-center gap-2 px-4 py-2.5 text-xs">
                <span
                  className="font-mono font-semibold shrink-0 w-24 truncate text-accent"
                  title={doc.app_id}
                >
                  {doc.app_id}
                </span>
                <span
                  className="font-mono shrink-0 w-24 truncate text-muted"
                  title={doc.collection}
                >
                  {doc.collection}
                </span>
                <Button
                  onClick={() => setExpanded(expanded === i ? null : i)}
                  className="font-mono flex-1 text-left truncate hover:underline text-ink"
                  title={doc.id}
                >
                  {doc.id.slice(0, 12)}
                </Button>
                <span
                  className="shrink-0 w-16 truncate text-muted"
                  title={doc.owner_id}
                >
                  {doc.owner_id.slice(0, 8)}
                </span>
                <Button
                  onClick={() => deleteDoc(doc)}
                  className="shrink-0 px-2 py-1 rounded text-xs font-semibold text-danger"
                >
                  Del
                </Button>
              </div>
              {expanded === i && (
                <pre className="px-4 py-2 text-xs font-mono whitespace-pre-wrap break-all overflow-auto max-h-[200px] bg-paper text-ink border-t border-line">
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
      const data = await api<CountersResponse>(
        `/api/content/counters?${params}`,
      )
      setCounters(data.counters)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [appFilter])

  useEffect(() => {
    load()
  }, [load])

  const deleteCounter = async (counter: Counter) => {
    if (
      !window.confirm(`Delete counter "${counter.name}" in ${counter.app_id}?`)
    )
      return
    try {
      const params = new URLSearchParams({
        app: counter.app_id,
        name: counter.name,
      })
      await api(`/api/content/counters?${params}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <Input
          value={appFilter}
          onChange={(e) => setAppFilter(e.target.value)}
          placeholder="Filter by app ID"
          className="w-[180px]"
        />
        <Button
          onClick={load}
          className="px-3 py-2 rounded-lg text-sm font-semibold"
          variant="outline"
        >
          Search
        </Button>
      </div>

      {error && <ErrorBox message={error} />}
      {loading ? (
        <Loading />
      ) : counters.length === 0 ? (
        <div className="py-12 text-center text-muted">No counters found.</div>
      ) : (
        <div className="rounded-xl overflow-hidden border border-line">
          {counters.map((counter, i) => (
            <div
              key={i}
              className="flex items-center gap-2 px-4 py-2.5 text-xs border-b border-line"
            >
              <span
                className="font-mono font-semibold shrink-0 w-24 truncate text-accent"
                title={counter.app_id}
              >
                {counter.app_id}
              </span>
              <span className="font-mono flex-1 truncate text-ink">
                {counter.name}
              </span>
              <span className="font-bold shrink-0 w-16 text-right text-ink">
                {counter.value}
              </span>
              <Button
                onClick={() => deleteCounter(counter)}
                className="shrink-0 px-2 py-1 rounded text-xs font-semibold text-danger"
              >
                Del
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
