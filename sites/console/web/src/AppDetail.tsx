import { useState, useEffect, useCallback } from 'react'
import { RolesManager } from './RolesManager'
import { SecretsManager } from './SecretsManager'
import { WebhooksManager } from './WebhooksManager'
import { LogsViewer } from './LogsViewer'

const API_BASE = 'https://api.freeappstore.online/v1'

interface Props {
  appId: string
  appName: string
  getToken: () => string | null
  onBack: () => void
}

interface AppAnalytics {
  activeUsers30d: number
  totalEvents: number
}

interface DeployRun {
  conclusion: string | null
  status: string
  updated_at: string
  html_url: string
  head_sha: string
  name: string
}

type AppTab = 'overview' | 'data'

export function AppDetail({ appId, appName, getToken, onBack }: Props) {
  const [appTab, setAppTab] = useState<AppTab>('overview')
  const [analytics, setAnalytics] = useState<AppAnalytics | null>(null)
  const [deploys, setDeploys] = useState<DeployRun[]>([])
  const [loading, setLoading] = useState(true)
  const appUrl = `https://${appId}.freeappstore.online`
  const repoUrl = `https://github.com/freeappstore-online/${appId}`

  useEffect(() => {
    const token = getToken()
    if (!token) { setLoading(false); return }
    fetch(`${API_BASE}/apps/${encodeURIComponent(appId)}/analytics`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => setAnalytics(data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [appId, getToken])

  useEffect(() => {
    fetch(`https://api.github.com/repos/freeappstore-online/${appId}/actions/runs?per_page=5`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.workflow_runs) setDeploys(data.workflow_runs)
      })
      .catch(() => {})
  }, [appId])

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <button onClick={onBack} className="text-sm text-[var(--accent)] font-medium hover:underline min-h-[44px] flex items-center">&larr; Back</button>
        <div className="flex gap-1 ml-auto">
          {(['overview', 'data'] as AppTab[]).map(t => (
            <button
              key={t}
              onClick={() => setAppTab(t)}
              className={`px-3 py-1 rounded-full text-xs font-semibold min-h-[32px] ${
                appTab === t
                  ? 'bg-[var(--ink)] text-[var(--paper)]'
                  : 'text-[var(--muted)] border border-[var(--line)]'
              }`}
            >
              {t === 'data' ? 'Admin' : 'Overview'}
            </button>
          ))}
        </div>
      </div>

      {appTab === 'data' ? (
        <AppDataView appId={appId} getToken={getToken} />
      ) : (
      <>

      {/* Hero */}
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 sm:p-6">
        <h2 className="display-font text-xl sm:text-2xl font-bold text-[var(--ink)]">{appName}</h2>
        <p className="mt-1 text-sm text-[var(--muted)] font-mono truncate">{appId}.freeappstore.online</p>
        <div className="mt-4 flex gap-2.5 flex-wrap">
          <a href={appUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 no-underline min-h-[44px]">
            Open App
          </a>
          <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] hover:bg-[var(--panel-hover)] no-underline min-h-[44px]">
            Source
          </a>
        </div>
      </div>

      {/* Deploy History */}
      {deploys.length > 0 && (
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 sm:p-6">
          <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide mb-3">Recent Deploys</h3>
          <div className="space-y-2">
            {deploys.map((d) => (
              <a
                key={d.head_sha}
                href={d.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-3 py-2 px-3 rounded-lg hover:bg-[var(--panel-hover)] no-underline min-h-[44px]"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                    d.conclusion === 'success' ? 'bg-[var(--success)]' :
                    d.conclusion === 'failure' ? 'bg-[var(--error)]' :
                    d.status === 'in_progress' ? 'bg-[var(--warning)]' : 'bg-[var(--muted)]'
                  }`} />
                  <span className="text-sm text-[var(--ink)] truncate">{d.name}</span>
                </div>
                <span className="text-xs text-[var(--muted)] whitespace-nowrap flex-shrink-0">
                  {formatTimeAgo(new Date(d.updated_at))}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Stats */}
      {!loading && analytics && (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
            <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide">Active Users (30d)</p>
            <p className="mt-1 display-font text-2xl font-bold text-[var(--ink)]">{analytics.activeUsers30d}</p>
          </div>
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
            <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide">Total Events</p>
            <p className="mt-1 display-font text-2xl font-bold text-[var(--ink)]">{analytics.totalEvents}</p>
          </div>
        </div>
      )}

      {/* Roles */}
      <RolesManager appId={appId} getToken={getToken} />

      {/* API Proxy & Secrets */}
      <SecretsManager appId={appId} getToken={getToken} />

      {/* Webhooks */}
      <WebhooksManager appId={appId} getToken={getToken} />

      {/* Logs */}
      <LogsViewer appId={appId} getToken={getToken} />

      {/* Code Health */}
      <CodeHealth appId={appId} />

      {/* Info grid */}
      <div>
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide mb-3">App Info</h3>
        <div className="grid gap-3 grid-cols-2">
          <InfoCard label="Subdomain" value={`${appId}.freeappstore.online`} mono />
          <InfoCard label="Source" value={`freeappstore-online/${appId}`} href={repoUrl} />
          <InfoCard label="Deploy" value="Push to main = auto-deploy" />
          <InfoCard label="Hosting" value="R2 (edge)" />
          <InfoCard label="License" value="MIT" />
          <InfoCard label="Price" value="Free forever" />
        </div>
      </div>

      {/* SDK features */}
      <div>
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide mb-3">Platform Features</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard title="Auth" desc="GitHub OAuth SSO across all apps" />
          <FeatureCard title="Per-user KV" desc="1MB/user, 100 keys, scoped storage" />
          <FeatureCard title="Collections" desc="Firestore-style document database" />
          <FeatureCard title="Counters" desc="Atomic shared counters (votes, views)" />
          <FeatureCard title="Rooms" desc="WebSocket real-time (25 peers/room)" />
          <FeatureCard title="Proxy" desc="Secret-injecting API proxy (manage above)" />
        </div>
      </div>

      {/* Useful links */}
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6">
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide mb-3">Links</h3>
        <div className="space-y-2">
          <LinkRow href={appUrl} label="Live app" />
          <LinkRow href={repoUrl} label="GitHub repository" />
          <LinkRow href="https://freeappstore.online/docs" label="SDK documentation" />
          <LinkRow href="https://freeappstore.online/docs/ui" label="UI component library" />
          <LinkRow href={`https://freeappstore.online/apps/${appId}`} label="Store listing" />
        </div>
      </div>
      </>
      )}
    </div>
  )
}

function isImageUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i.test(u.pathname)
  } catch { return false }
}

/** Render a JSON value with clickable URLs and a copy button. */
function JsonView({ data, onPreview }: { data: unknown; onPreview: (url: string) => void }) {
  const json = JSON.stringify(data, null, 2)
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  // Split JSON into text segments and URL segments
  const parts: Array<{ type: 'text' | 'url'; value: string }> = []
  const urlRe = /https?:\/\/[^\s"',\]})]+/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = urlRe.exec(json)) !== null) {
    if (m.index > last) parts.push({ type: 'text', value: json.slice(last, m.index) })
    parts.push({ type: 'url', value: m[0] })
    last = m.index + m[0].length
  }
  if (last < json.length) parts.push({ type: 'text', value: json.slice(last) })

  return (
    <div className="relative border-t border-[var(--line)]">
      <button
        onClick={copy}
        title={copied ? 'Copied!' : 'Copy JSON'}
        className="absolute top-1.5 right-1.5 p-1 rounded bg-[var(--line)] text-[var(--muted)] hover:text-[var(--ink)] z-10"
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        )}
      </button>
      <pre className="px-3 py-2 pr-16 text-xs font-mono bg-[var(--paper)] text-[var(--ink)] whitespace-pre-wrap break-all max-h-[300px] overflow-auto select-text" style={{ userSelect: 'text', WebkitUserSelect: 'text' }}>
        {parts.map((p, i) =>
          p.type === 'url' ? (
            <a
              key={i}
              href={p.value}
              target="_blank"
              rel="noopener noreferrer"
              onClick={isImageUrl(p.value) ? (e) => { e.preventDefault(); onPreview(p.value) } : undefined}
              className="text-[var(--accent)] hover:underline cursor-pointer"
            >{p.value}</a>
          ) : (
            <span key={i}>{p.value}</span>
          )
        )}
      </pre>
    </div>
  )
}

/** Fullscreen preview dialog for images / URLs. */
function PreviewDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const isImage = isImageUrl(url)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="relative max-w-[90vw] max-h-[90vh] bg-[var(--panel-strong)] rounded-2xl overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-[var(--line)]">
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-[var(--accent)] truncate hover:underline">{url}</a>
          <button onClick={onClose} title="Close" className="text-[var(--muted)] hover:text-[var(--ink)] p-1 min-h-[32px] flex-shrink-0"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        {isImage ? (
          <div className="p-4 flex items-center justify-center" style={{ minWidth: 200, minHeight: 200 }}>
            <img src={url} alt="preview" className="max-w-[80vw] max-h-[75vh] object-contain rounded" />
          </div>
        ) : (
          <iframe src={url} className="w-[80vw] h-[75vh] border-0" title="preview" sandbox="allow-scripts allow-same-origin" />
        )}
      </div>
    </div>
  )
}

function AppDataView({ appId, getToken }: { appId: string; getToken: () => string | null }) {
  const [tab, setTab] = useState<'kv' | 'collections' | 'counters'>('kv')
  const [entries, setEntries] = useState<Array<Record<string, unknown>>>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [valueCache, setValueCache] = useState<Record<string, unknown>>({})
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = getToken()
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }, [getToken])

  const load = useCallback(async () => {
    setLoading(true)
    setExpanded(null)
    let url = ''
    if (tab === 'kv') url = `${API_BASE}/admin/kv?app=${appId}&limit=100`
    else if (tab === 'collections') url = `${API_BASE}/admin/collections?app=${appId}&limit=100`
    else url = `${API_BASE}/admin/counters?app=${appId}&limit=200`

    try {
      const res = await fetch(url, { headers: headers() })
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>
        setEntries((data.entries ?? data.documents ?? data.counters ?? []) as Array<Record<string, unknown>>)
      } else {
        setEntries([])
      }
    } catch { setEntries([]) }
    setLoading(false)
  }, [appId, tab, headers])

  useEffect(() => { load() }, [load])

  const deleteItem = async (params: string) => {
    if (!confirm('Delete this item?')) return
    const base = API_BASE
    await fetch(`${base}/admin/${tab === 'collections' ? 'collections' : tab}?${params}`, {
      method: 'DELETE', headers: headers(),
    })
    load()
  }

  const loadKvValue = async (user: string, key: string) => {
    const cacheKey = `${user}:${key}`
    if (valueCache[cacheKey]) return
    const base = API_BASE
    const res = await fetch(`${base}/admin/kv/value?app=${appId}&user=${user}&key=${encodeURIComponent(key)}`, { headers: headers() })
    if (res.ok) {
      const data = await res.json() as { value: unknown }
      setValueCache(prev => ({ ...prev, [cacheKey]: data.value }))
    }
  }

  return (
    <div>
      <div className="flex gap-1 mb-4">
        {(['kv', 'collections', 'counters'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-1 rounded-full text-xs font-semibold min-h-[32px] ${tab === t ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] border border-[var(--line)]'}`}>
            {t === 'kv' ? 'KV' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
        <span className="text-xs text-[var(--muted)] ml-auto self-center">{entries.length} entries</span>
      </div>

      {loading ? <p className="text-sm text-[var(--muted)]">Loading...</p> : entries.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">No {tab} data for this app.</p>
      ) : (
        <div className="rounded-xl border border-[var(--line)] overflow-hidden">
          {entries.map((e, i) => {
            if (tab === 'kv') {
              const cacheKey = `${e.user_id}:${e.key}`
              return (
                <div key={i} className="border-b border-[var(--line)] last:border-0">
                  <div className="flex items-center gap-2 px-3 py-2 text-xs">
                    <span className="font-mono text-[var(--muted)] w-16 truncate flex-shrink-0">{String(e.user_id).slice(0, 8)}</span>
                    <button onClick={() => { loadKvValue(String(e.user_id), String(e.key)); setExpanded(expanded === i ? null : i) }} className="font-mono text-[var(--ink)] truncate flex-1 text-left hover:underline">{String(e.key)}</button>
                    <span className="text-[var(--muted)] flex-shrink-0">{String(e.size)}B</span>
                    <button onClick={() => deleteItem(`app=${appId}&user=${e.user_id}&key=${encodeURIComponent(String(e.key))}`)} className="text-[var(--error)] hover:text-[var(--error)] opacity-40 hover:opacity-100 min-h-[32px] px-1" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
                  </div>
                  {expanded === i && valueCache[cacheKey] !== undefined && (
                    <JsonView data={valueCache[cacheKey]} onPreview={setPreviewUrl} />
                  )}
                </div>
              )
            }
            if (tab === 'collections') {
              return (
                <div key={i} className="border-b border-[var(--line)] last:border-0">
                  <div className="flex items-center gap-2 px-3 py-2 text-xs">
                    <span className="font-mono text-[var(--muted)] w-16 truncate flex-shrink-0">{String(e.collection)}</span>
                    <button onClick={() => setExpanded(expanded === i ? null : i)} className="font-mono text-[var(--ink)] truncate flex-1 text-left hover:underline">{String(e.id).slice(0, 12)}</button>
                    <span className="text-[var(--muted)] flex-shrink-0">{String(e.owner_id).slice(0, 8)}</span>
                    <button onClick={() => deleteItem(`app=${appId}&collection=${e.collection}&id=${e.id}`)} className="text-[var(--error)] hover:text-[var(--error)] opacity-40 hover:opacity-100 min-h-[32px] px-1" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
                  </div>
                  {expanded === i && (
                    <JsonView data={e.data} onPreview={setPreviewUrl} />
                  )}
                </div>
              )
            }
            // counters
            return (
              <div key={i} className="flex items-center gap-2 px-3 py-2 text-xs border-b border-[var(--line)] last:border-0">
                <span className="font-mono text-[var(--ink)] flex-1 truncate">{String(e.name)}</span>
                <span className="font-bold text-[var(--ink)] w-16 text-right flex-shrink-0">{String(e.value)}</span>
                <button onClick={() => deleteItem(`app=${appId}&name=${encodeURIComponent(String(e.name))}`)} className="text-[var(--error)] hover:text-[var(--error)] opacity-40 hover:opacity-100 min-h-[32px] px-1" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
              </div>
            )
          })}
        </div>
      )}
      {previewUrl && <PreviewDialog url={previewUrl} onClose={() => setPreviewUrl(null)} />}
    </div>
  )
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function InfoCard({ label, value, href, mono }: { label: string; value: string; href?: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
      <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide">{label}</p>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="mt-1 text-sm text-[var(--accent)] font-medium block">{value}</a>
      ) : (
        <p className={`mt-1 text-sm text-[var(--ink)] ${mono ? 'font-mono' : ''}`}>{value}</p>
      )}
    </div>
  )
}

function FeatureCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
      <p className="font-semibold text-sm text-[var(--ink)]">{title}</p>
      <p className="text-xs text-[var(--muted)] mt-0.5">{desc}</p>
    </div>
  )
}

interface VcqaIssue {
  severity: string
  message: string
  file?: string
  line?: number
  rule?: string
}

interface VcqaCheck {
  name: string
  score: number
  grade: string
  issues?: VcqaIssue[]
}

interface VcqaReport {
  score: number
  grade: string
  version: string
  timestamp: string
  checks: VcqaCheck[]
}

function CodeHealth({ appId }: { appId: string }) {
  const [report, setReport] = useState<VcqaReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [badgeError, setBadgeError] = useState(false)

  useEffect(() => {
    fetch(`https://${appId}.freeappstore.online/.vcqa/report.json`)
      .then(r => r.ok ? r.json() : null)
      .then(data => setReport(data as VcqaReport | null))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [appId])

  if (loading) return null
  if (!report) {
    return (
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5">
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide mb-2">Code Health</h3>
        <p className="text-sm text-[var(--muted)]">No scan data yet. Code health runs automatically on each deploy.</p>
      </div>
    )
  }

  const gradeColor = (g: string) => {
    if (g === 'A') return 'var(--success, #16a34a)'
    if (g === 'B') return 'var(--success, #16a34a)'
    if (g === 'C') return 'var(--warning, #ca8a04)'
    return 'var(--error, #dc2626)'
  }

  const activeChecks = report.checks?.filter(c => c.score !== undefined && c.grade !== 'skip') ?? []
  const totalIssues = activeChecks.reduce((n, c) => n + (c.issues?.length ?? 0), 0)

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide">Code Health</h3>
        <span className="text-xs text-[var(--muted)]">
          via <a href="https://vibecodeqa.online" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)]">vcqa</a>
          {report.timestamp && ` · ${new Date(report.timestamp).toLocaleDateString()}`}
        </span>
      </div>

      <div className="flex items-center gap-4 mb-4">
        <div className="display-font text-4xl font-bold" style={{ color: gradeColor(report.grade) }}>
          {report.grade}
        </div>
        <div>
          <div className="text-2xl font-bold text-[var(--ink)]">{report.score}/100</div>
          <div className="text-xs text-[var(--muted)]">{activeChecks.length} checks · {totalIssues} issues</div>
        </div>
        {!badgeError && (
          <div className="ml-auto">
            <img
              src={`https://${appId}.freeappstore.online/.vcqa/badge.svg`}
              alt={`vcqa ${report.grade} ${report.score}`}
              className="h-5"
              onError={() => setBadgeError(true)}
            />
          </div>
        )}
      </div>

      {activeChecks.length > 0 && (
        <div className="grid gap-0.5">
          {activeChecks.map(check => {
            const issues = check.issues ?? []
            const hasIssues = issues.length > 0
            const isOpen = expanded === check.name
            return (
              <div key={check.name}>
                <button
                  onClick={() => hasIssues && setExpanded(isOpen ? null : check.name)}
                  className="flex items-center gap-2 py-1.5 w-full text-left min-h-[36px]"
                  style={{ cursor: hasIssues ? 'pointer' : 'default', background: 'none', border: 'none', fontFamily: 'inherit', color: 'inherit' }}
                >
                  <span
                    className="inline-block w-6 text-center text-xs font-bold rounded flex-shrink-0"
                    style={{ color: gradeColor(check.grade), background: `color-mix(in srgb, ${gradeColor(check.grade)} 15%, transparent)` }}
                  >
                    {check.grade}
                  </span>
                  <span className="text-sm text-[var(--ink)] flex-1">{check.name}</span>
                  {hasIssues && (
                    <span className="text-xs text-[var(--muted)]">{issues.length} issue{issues.length > 1 ? 's' : ''}</span>
                  )}
                  <span className="text-xs text-[var(--muted)] font-mono w-6 text-right flex-shrink-0">{check.score}</span>
                  <div className="w-16 h-1.5 rounded bg-[var(--line)] overflow-hidden flex-shrink-0">
                    <div className="h-full rounded" style={{ width: `${check.score}%`, background: gradeColor(check.grade) }} />
                  </div>
                  {hasIssues && (
                    <span className="text-xs text-[var(--muted)] flex-shrink-0">{isOpen ? '▾' : '▸'}</span>
                  )}
                </button>
                {isOpen && issues.length > 0 && (
                  <div className="ml-8 mb-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] overflow-hidden">
                    {issues.slice(0, 20).map((issue, i) => (
                      <div key={i} className="flex items-start gap-2 px-3 py-1.5 border-b border-[var(--line)] last:border-0 text-xs">
                        <span className={`flex-shrink-0 font-semibold ${issue.severity === 'error' ? 'text-[var(--error,#dc2626)]' : 'text-[var(--warning,#ca8a04)]'}`}>
                          {issue.severity === 'error' ? '!' : '~'}
                        </span>
                        <div className="min-w-0 flex-1">
                          <span className="text-[var(--ink)]">{issue.message}</span>
                          {issue.file && (
                            <span className="text-[var(--muted)] font-mono ml-1.5">
                              {issue.file.split('/').slice(-2).join('/')}{issue.line ? `:${issue.line}` : ''}
                            </span>
                          )}
                        </div>
                        {issue.rule && <span className="text-[var(--muted)] font-mono flex-shrink-0">{issue.rule}</span>}
                      </div>
                    ))}
                    {issues.length > 20 && (
                      <div className="px-3 py-1.5 text-xs text-[var(--muted)]">+{issues.length - 20} more issues</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function LinkRow({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between py-1.5 text-sm text-[var(--accent)] font-medium hover:underline no-underline">
      {label}
      <span className="text-[var(--muted)]">&rarr;</span>
    </a>
  )
}
