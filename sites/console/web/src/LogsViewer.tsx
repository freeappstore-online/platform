import { useState, useEffect, useCallback } from 'react'

const API = 'https://api.freeappstore.online/v1'

interface LogEntry {
  ts: number
  level: string
  category: string
  message: string
  data?: unknown
  userId: string
  build?: Record<string, unknown>
}

interface Props {
  appId: string
  getToken: () => string | null
}

const LEVELS = ['all', 'error', 'warn', 'info', 'debug'] as const

export function LogsViewer({ appId, getToken }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [level, setLevel] = useState<string>('all')
  const [limit, setLimit] = useState(50)
  const [buildMeta, setBuildMeta] = useState<Record<string, unknown> | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
    const token = getToken()
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }, [getToken])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(limit) })
      if (level !== 'all') params.set('level', level)
      const res = await fetch(`${API}/apps/${appId}/logs?${params}`, { headers: headers() })
      if (res.ok) {
        const data = await res.json() as { logs: LogEntry[] }
        setLogs(data.logs ?? [])
        const withBuild = (data.logs ?? []).find(l => l.build)
        if (withBuild?.build) setBuildMeta(withBuild.build)
      }
    } catch {}
    setLoading(false)
  }, [appId, level, limit, headers])

  useEffect(() => { load() }, [load])

  const levelColor = (l: string) => {
    if (l === 'error') return 'var(--error, #dc2626)'
    if (l === 'warn') return 'var(--warning, #ca8a04)'
    if (l === 'info') return 'var(--accent, #2563eb)'
    return 'var(--muted, #64748b)'
  }

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide">Logs</h3>
        <div className="flex items-center gap-2">
          <select
            value={level}
            onChange={e => setLevel(e.target.value)}
            className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs text-[var(--ink)] min-h-[36px]"
          >
            {LEVELS.map(l => <option key={l} value={l}>{l === 'all' ? 'All levels' : l.toUpperCase()}</option>)}
          </select>
          <select
            value={limit}
            onChange={e => setLimit(Number(e.target.value))}
            className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs text-[var(--ink)] min-h-[36px]"
          >
            {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n} entries</option>)}
          </select>
          <button
            onClick={load}
            className="text-xs font-semibold text-[var(--accent)] hover:underline min-h-[36px] px-2"
          >
            Refresh
          </button>
        </div>
      </div>

      {buildMeta && (
        <div className="mb-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-xs font-mono text-[var(--muted)]">
          {buildMeta.appVersion ? <span className="mr-3">{'v' + String(buildMeta.appVersion)}</span> : null}
          {buildMeta.commitSha ? <span className="mr-3">{String(buildMeta.commitSha).slice(0, 7)}</span> : null}
          {buildMeta.sdkVersion ? <span className="mr-3">{'SDK ' + String(buildMeta.sdkVersion)}</span> : null}
          {buildMeta.viewport ? <span>{String(buildMeta.viewport)}</span> : null}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-[var(--muted)] py-4">Loading logs...</p>
      ) : logs.length === 0 ? (
        <p className="text-sm text-[var(--muted)] py-4">No logs found. Logs are captured automatically when users interact with your app.</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[500px]">
            {logs.map((entry, i) => {
              const time = new Date(entry.ts).toISOString().slice(11, 23)
              const isOpen = expanded === i
              return (
                <button
                  key={`${entry.ts}-${i}`}
                  onClick={() => setExpanded(isOpen ? null : i)}
                  className="flex items-start gap-2 w-full text-left py-1.5 px-1 border-b border-[var(--line)] last:border-0 hover:bg-[var(--panel-hover)] min-h-[32px]"
                  style={{ background: 'none', border: 'none', borderBottom: '1px solid var(--line)', fontFamily: 'inherit', color: 'inherit', cursor: 'pointer' }}
                >
                  <span className="text-[10px] font-mono text-[var(--muted)] flex-shrink-0 w-[72px] pt-0.5">{time}</span>
                  <span
                    className="text-[10px] font-bold flex-shrink-0 w-[40px] pt-0.5 uppercase"
                    style={{ color: levelColor(entry.level) }}
                  >
                    {entry.level}
                  </span>
                  <span className="text-[10px] text-[var(--muted)] flex-shrink-0 w-[52px] pt-0.5">{entry.category}</span>
                  <span className="text-xs text-[var(--ink)] flex-1 min-w-0 truncate">{entry.message}</span>
                  {entry.data ? <span className="text-[10px] text-[var(--muted)] flex-shrink-0">+data</span> : null}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Expanded entry detail */}
      {expanded !== null && logs[expanded] && (
        <div className="mt-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-[var(--ink)]">Log Detail</span>
            <button onClick={() => setExpanded(null)} className="text-xs text-[var(--muted)]">close</button>
          </div>
          <pre className="text-xs font-mono text-[var(--ink)] whitespace-pre-wrap break-all overflow-auto max-h-[300px]">
{JSON.stringify({
  timestamp: new Date(logs[expanded].ts).toISOString(),
  level: logs[expanded].level,
  category: logs[expanded].category,
  message: logs[expanded].message,
  data: logs[expanded].data,
  userId: logs[expanded].userId,
  build: logs[expanded].build,
}, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
