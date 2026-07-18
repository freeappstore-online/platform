import { useState, useEffect, useCallback, type FormEvent } from 'react'

const API = 'https://api.freeappstore.online/v1'

// Categories accepted by the backend's /v1/publish validator. Keep in sync with
// packages/backend/src/routes/publish.ts VALID_CATEGORIES.
const CATEGORIES = [
  'Learning', 'Strategy', 'Discovery', 'Brain Training', 'Social',
  'Productivity', 'Health & Fitness', 'Finance', 'News & Weather',
  'Utilities', 'Other (specify in description)',
] as const

interface MyApp {
  id: string
  store: string
  category: string
  type: string
  oneliner: string
  createdAt: number
  appUrl: string
  repoUrl: string
}

interface AdminStep {
  name: string
  status: string
  detail?: string
}

interface PublishResult {
  appId: string
  appUrl: string
  repoUrl: string
  admin?: { steps?: AdminStep[] }
}

interface Props {
  getToken: () => string | null
}

// Mirror the backend's APP_ID_RE: /^[a-z][a-z0-9-]{1,30}$/ (2–31 chars, starts
// with a letter). Client-side check just gives a friendlier error than a 400.
function validateId(id: string): string | null {
  if (!id) return null
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(id))
    return '2–31 chars: lowercase letters, digits, hyphens; must start with a letter.'
  if (id.startsWith('free') || id.startsWith('pro')) return "Cannot start with 'free' or 'pro'"
  return null
}

export function PublishForm({ getToken }: Props) {
  const [apps, setApps] = useState<MyApp[]>([])
  const [loadingApps, setLoadingApps] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState<PublishResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [idError, setIdError] = useState<string | null>(null)
  const [idValue, setIdValue] = useState('')

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = getToken()
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }, [getToken])

  const refreshApps = useCallback(() => {
    fetch(`${API}/apps/mine`, { headers: headers() })
      .then((r) => (r.ok ? r.json() : { apps: [] }))
      .then((data) => setApps(data.apps ?? []))
      .catch(() => setApps([]))
      .finally(() => setLoadingApps(false))
  }, [headers])

  useEffect(() => { refreshApps() }, [refreshApps])

  async function handlePublish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPublishing(true)
    setResult(null)
    setError(null)
    const form = new FormData(e.currentTarget)
    // Map the form to the backend /v1/publish contract. The store is apps-only;
    // the admin Worker assigns the storefront icon, so there's no icon field here.
    const payload = {
      name: String(form.get('id') ?? ''),
      store: 'apps',
      category: String(form.get('category') ?? ''),
      type: String(form.get('type') ?? 'standalone'),
      oneliner: String(form.get('oneliner') ?? ''),
      description: String(form.get('description') ?? ''),
      repo: null,
      demo: null,
    }
    try {
      const res = await fetch(`${API}/publish`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.hint || data.error || `Publish failed (HTTP ${res.status})`)
      } else {
        setResult(data as PublishResult)
        refreshApps()
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setPublishing(false)
    }
  }

  const fieldCls = 'p-2 rounded-lg border bg-[var(--panel)] border-[var(--line)] text-[var(--ink)] w-full'

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6 space-y-6">
      <div>
        <h3 className="display-font text-lg font-bold text-[var(--ink)] mb-2">Publisher Portal</h3>
        <p className="text-sm text-[var(--muted)]">
          Already built an app? Publish it to the store — provisions the repo, subdomain, and store listing.
        </p>
      </div>

      {/* Your Apps */}
      <div>
        <h4 className="text-sm font-bold text-[var(--accent)] mb-2">Your Apps</h4>
        {loadingApps ? (
          <p className="text-sm text-[var(--muted)]">Loading…</p>
        ) : apps.length ? (
          <div className="flex flex-col gap-2">
            {apps.map((app) => (
              <div key={app.id} className="rounded-xl border border-[var(--line)] p-3">
                <strong className="text-[var(--ink)]">{app.id}</strong>
                {app.oneliner && <span className="text-sm text-[var(--muted)]"> — {app.oneliner}</span>}
                <div className="text-xs text-[var(--muted)] mt-1">{app.category} · {app.type}</div>
                <div className="flex gap-3 mt-2">
                  <a href={app.appUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-[var(--accent)] no-underline">Visit</a>
                  <a href={app.repoUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-[var(--accent)] no-underline">Code</a>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--muted)]">No apps yet. Publish your first one below.</p>
        )}
      </div>

      {/* Create & Publish */}
      <form onSubmit={handlePublish} className="flex flex-col gap-3">
        <h4 className="text-sm font-bold text-[var(--accent)]">Create &amp; Publish</h4>
        <div>
          <label className="text-xs font-semibold mb-1 block text-[var(--muted)]">Unique ID — becomes your URL</label>
          <input
            name="id"
            placeholder="e.g. meditation-timer"
            required
            className={`p-2 rounded-lg border w-full font-mono bg-[var(--panel)] text-[var(--ink)] ${idError ? 'border-[var(--danger)]' : 'border-[var(--line)]'}`}
            onChange={(e) => { setIdValue(e.target.value); setIdError(validateId(e.target.value)) }}
          />
          {idError ? (
            <p className="text-xs mt-1 text-[var(--danger)]">{idError}</p>
          ) : idValue && (
            <p className="text-xs mt-1 font-mono text-[var(--success)]">{idValue}.freeappstore.online</p>
          )}
        </div>
        <select name="type" defaultValue="standalone" className={fieldCls}>
          <option value="standalone">Standalone (self-contained)</option>
          <option value="connected">Connected (uses the platform SDK)</option>
        </select>
        <select name="category" required defaultValue="" className={fieldCls}>
          <option value="" disabled>Choose a category…</option>
          {CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
        </select>
        <input name="oneliner" placeholder="One-line tagline, e.g. A calm meditation timer" required className={fieldCls} />
        <input name="description" placeholder="Longer description" required className={fieldCls} />
        <button
          type="submit"
          disabled={publishing || !!idError}
          className="p-3 rounded-lg font-semibold text-white bg-[var(--accent)]"
          style={{ opacity: publishing || idError ? 0.6 : 1 }}
        >
          {publishing ? 'Provisioning…' : 'Create & Publish'}
        </button>
      </form>

      {/* Result */}
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      {result && (
        <div className="flex flex-col gap-1 text-sm font-mono">
          {result.admin?.steps?.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className={s.status === 'ok' ? 'text-[var(--success)]' : s.status === 'skip' ? 'text-[var(--warning)]' : 'text-[var(--danger)]'}>●</span>
              <span className="text-[var(--ink)]"><strong>{s.name}</strong>{s.detail ? `: ${s.detail}` : ''}</span>
            </div>
          ))}
          <p className="mt-3 font-semibold text-[var(--success)]">
            Published! <a href={result.appUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)]">{result.appUrl}</a>
          </p>
        </div>
      )}
    </div>
  )
}
