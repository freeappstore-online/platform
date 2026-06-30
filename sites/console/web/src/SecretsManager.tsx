import { useState, useEffect, useCallback } from 'react'

const API = 'https://api.freeappstore.online/v1'

interface Secret {
  name: string
  createdAt: number
  lastUsedAt: number | null
}

interface AllowlistRule {
  pattern: string
  injectKind: 'query' | 'header' | 'bearer'
  injectName: string
  secretName: string
  methods: string
  createdAt: number
}

interface Props {
  appId: string
  getToken: () => string | null
}

export function SecretsManager({ appId, getToken }: Props) {
  const [secrets, setSecrets] = useState<Secret[]>([])
  const [rules, setRules] = useState<AllowlistRule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAddSecret, setShowAddSecret] = useState(false)
  const [showAddRule, setShowAddRule] = useState(false)

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = getToken()
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }, [getToken])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [sRes, aRes] = await Promise.all([
        fetch(`${API}/apps/${appId}/secrets`, { headers: headers() }),
        fetch(`${API}/apps/${appId}/allowlist`, { headers: headers() }),
      ])
      if (sRes.ok) {
        const data = await sRes.json() as { secrets: Secret[] }
        setSecrets(data.secrets ?? [])
      }
      if (aRes.ok) {
        const data = await aRes.json() as { rules: AllowlistRule[] }
        setRules(data.rules ?? [])
      }
    } catch {
      setError('Failed to load secrets')
    } finally {
      setLoading(false)
    }
  }, [appId, headers])

  useEffect(() => { load() }, [load])

  const deleteSecret = async (name: string) => {
    if (!confirm(`Delete secret "${name}"? Any proxy rules using it will stop working.`)) return
    const res = await fetch(`${API}/apps/${appId}/secrets/${name}`, {
      method: 'DELETE', headers: headers(),
    })
    if (res.ok) load()
    else setError('Failed to delete secret')
  }

  const deleteRule = async (pattern: string) => {
    if (!confirm(`Remove allowlist rule for "${pattern}"?`)) return
    const res = await fetch(`${API}/apps/${appId}/allowlist`, {
      method: 'DELETE', headers: headers(),
      body: JSON.stringify({ pattern }),
    })
    if (res.ok) load()
    else setError('Failed to delete rule')
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5">
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide mb-3">API Proxy & Secrets</h3>
        <p className="text-sm text-[var(--muted)]">Loading...</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide">Secrets ({secrets.length}/5)</h3>
          <button
            onClick={() => setShowAddSecret(!showAddSecret)}
            className="text-xs font-semibold text-[var(--accent)] hover:underline min-h-[44px] px-2"
          >
            {showAddSecret ? 'Cancel' : '+ Add secret'}
          </button>
        </div>

        {error && <p className="text-sm text-[var(--error)] mb-3">{error}</p>}

        <p className="text-xs text-[var(--muted)] mb-3">
          Encrypted API keys injected server-side by the proxy. Apps never see plaintext values.
        </p>

        {showAddSecret && (
          <AddSecretForm
            appId={appId}
            headers={headers}
            onDone={() => { setShowAddSecret(false); load() }}
            onError={setError}
          />
        )}

        {secrets.length === 0 && !showAddSecret && (
          <p className="text-sm text-[var(--muted)] py-2">No secrets configured yet.</p>
        )}

        {secrets.map((s) => (
          <div key={s.name} className="flex items-center justify-between py-2.5 border-b border-[var(--line)] last:border-0">
            <div>
              <span className="font-mono text-sm font-semibold text-[var(--ink)]">{s.name}</span>
              <span className="text-xs text-[var(--muted)] ml-2">
                {s.lastUsedAt ? `used ${formatTimeAgo(s.lastUsedAt)}` : 'never used'}
              </span>
            </div>
            <button
              onClick={() => deleteSecret(s.name)}
              className="text-xs text-[var(--error)] hover:underline min-h-[44px] px-2"
            >
              Delete
            </button>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide">Proxy Allowlist ({rules.length}/5)</h3>
          <button
            onClick={() => setShowAddRule(!showAddRule)}
            className="text-xs font-semibold text-[var(--accent)] hover:underline min-h-[44px] px-2"
          >
            {showAddRule ? 'Cancel' : '+ Add rule'}
          </button>
        </div>

        <p className="text-xs text-[var(--muted)] mb-3">
          URL patterns the proxy will forward to. Each rule maps a URL prefix to a secret and an injection method.
        </p>

        {showAddRule && (
          <AddRuleForm
            appId={appId}
            secrets={secrets}
            headers={headers}
            onDone={() => { setShowAddRule(false); load() }}
            onError={setError}
          />
        )}

        {rules.length === 0 && !showAddRule && (
          <p className="text-sm text-[var(--muted)] py-2">No allowlist rules. The proxy will reject all requests.</p>
        )}

        {rules.map((r) => (
          <div key={r.pattern} className="py-2.5 border-b border-[var(--line)] last:border-0">
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm text-[var(--ink)] truncate">{r.pattern}</span>
              <button
                onClick={() => deleteRule(r.pattern)}
                className="text-xs text-[var(--error)] hover:underline min-h-[44px] px-2 flex-shrink-0"
              >
                Remove
              </button>
            </div>
            <div className="flex gap-2 mt-1 flex-wrap">
              <Tag>{r.injectKind === 'bearer' ? 'Bearer token' : `${r.injectKind}: ${r.injectName}`}</Tag>
              <Tag>secret: {r.secretName}</Tag>
              <Tag>{r.methods}</Tag>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
        <p className="text-xs text-[var(--muted)]">
          <strong>How it works:</strong> Your app calls <code className="text-[var(--ink)]">fas.proxy.fetch('api.example.com/data')</code>.
          The platform matches the URL against your allowlist, decrypts the secret, injects it into the request, and forwards it.
          The browser never sees the API key. Max 10,000 proxy requests/day.
        </p>
      </div>
    </div>
  )
}

function AddSecretForm({ appId, headers, onDone, onError }: {
  appId: string
  headers: () => Record<string, string>
  onDone: () => void
  onError: (msg: string) => void
}) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || !value) return
    setSaving(true)
    onError('')
    try {
      const res = await fetch(`${API}/apps/${appId}/secrets/${name}`, {
        method: 'PUT', headers: headers(),
        body: JSON.stringify({ value }),
      })
      if (res.ok) { onDone() }
      else {
        const data = await res.json().catch(() => ({})) as { error?: string }
        onError(data.error ?? `Failed (${res.status})`)
      }
    } catch {
      onError('Network error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="mb-3 p-3 rounded-xl border border-[var(--line)] bg-[var(--paper)]">
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className="text-xs font-semibold text-[var(--muted)] block mb-1">Name (UPPER_SNAKE)</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
            placeholder="OPENWEATHER_KEY"
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-mono text-[var(--ink)] focus:border-[var(--accent)] outline-none min-h-[44px]"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-[var(--muted)] block mb-1">Value</label>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sk-..."
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-mono text-[var(--ink)] focus:border-[var(--accent)] outline-none min-h-[44px]"
          />
        </div>
      </div>
      <button
        type="submit"
        disabled={!name || !value || saving}
        className="mt-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 min-h-[44px]"
      >
        {saving ? 'Saving...' : 'Save secret'}
      </button>
    </form>
  )
}

function AddRuleForm({ appId, secrets, headers, onDone, onError }: {
  appId: string
  secrets: Secret[]
  headers: () => Record<string, string>
  onDone: () => void
  onError: (msg: string) => void
}) {
  const [pattern, setPattern] = useState('https://')
  const [injectKind, setInjectKind] = useState<'bearer' | 'header' | 'query'>('bearer')
  const [injectName, setInjectName] = useState('')
  const [secretName, setSecretName] = useState(secrets[0]?.name ?? '')
  const [methods, setMethods] = useState('GET,POST')
  const [saving, setSaving] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pattern || !secretName) return
    setSaving(true)
    onError('')
    try {
      const res = await fetch(`${API}/apps/${appId}/allowlist`, {
        method: 'PUT', headers: headers(),
        body: JSON.stringify({
          pattern, injectKind, injectName,
          secretName, methods: methods.split(',').map(m => m.trim()).filter(Boolean),
        }),
      })
      if (res.ok) { onDone() }
      else {
        const data = await res.json().catch(() => ({})) as { error?: string }
        onError(data.error ?? `Failed (${res.status})`)
      }
    } catch {
      onError('Network error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="mb-3 p-3 rounded-xl border border-[var(--line)] bg-[var(--paper)]">
      <div className="grid gap-2">
        <div>
          <label className="text-xs font-semibold text-[var(--muted)] block mb-1">URL pattern (prefix match)</label>
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="https://api.openweathermap.org/data/2.5/"
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-mono text-[var(--ink)] focus:border-[var(--accent)] outline-none min-h-[44px]"
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div>
            <label className="text-xs font-semibold text-[var(--muted)] block mb-1">Injection method</label>
            <select
              value={injectKind}
              onChange={(e) => setInjectKind(e.target.value as 'bearer' | 'header' | 'query')}
              className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent)] outline-none min-h-[44px]"
            >
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
              <option value="query">Query parameter</option>
            </select>
          </div>
          {injectKind !== 'bearer' && (
            <div>
              <label className="text-xs font-semibold text-[var(--muted)] block mb-1">
                {injectKind === 'header' ? 'Header name' : 'Param name'}
              </label>
              <input
                value={injectName}
                onChange={(e) => setInjectName(e.target.value)}
                placeholder={injectKind === 'header' ? 'X-API-Key' : 'appid'}
                className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent)] outline-none min-h-[44px]"
              />
            </div>
          )}
          <div>
            <label className="text-xs font-semibold text-[var(--muted)] block mb-1">Secret</label>
            <select
              value={secretName}
              onChange={(e) => setSecretName(e.target.value)}
              className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-mono text-[var(--ink)] focus:border-[var(--accent)] outline-none min-h-[44px]"
            >
              {secrets.length === 0 && <option value="">Add a secret first</option>}
              {secrets.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-[var(--muted)] block mb-1">HTTP methods (comma-separated)</label>
          <input
            value={methods}
            onChange={(e) => setMethods(e.target.value.toUpperCase())}
            placeholder="GET,POST"
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-mono text-[var(--ink)] focus:border-[var(--accent)] outline-none min-h-[44px]"
          />
        </div>
      </div>
      <button
        type="submit"
        disabled={!pattern || !secretName || saving}
        className="mt-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 min-h-[44px]"
      >
        {saving ? 'Saving...' : 'Add rule'}
      </button>
    </form>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full border border-[var(--line)] px-2 py-0.5 text-xs text-[var(--muted)]">
      {children}
    </span>
  )
}

function formatTimeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
