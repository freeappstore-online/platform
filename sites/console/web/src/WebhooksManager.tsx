import { useState, useEffect, useCallback } from 'react'

const API = 'https://api.freeappstore.online/v1'

interface Webhook {
  id: string
  event: string
  url: string
  active: number
  created_at: number
}

interface Props {
  appId: string
  getToken: () => string | null
}

export function WebhooksManager({ appId, getToken }: Props) {
  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [supportedEvents, setSupportedEvents] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ id: string; status: number; body: string } | null>(null)

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
      const res = await fetch(`${API}/apps/${appId}/webhooks`, { headers: headers() })
      if (res.ok) {
        const data = await res.json() as { webhooks: Webhook[]; supported_events: string[] }
        setWebhooks(data.webhooks ?? [])
        setSupportedEvents(data.supported_events ?? [])
      }
    } catch {
      setError('Failed to load webhooks')
    } finally {
      setLoading(false)
    }
  }, [appId, headers])

  useEffect(() => { load() }, [load])

  const deleteWebhook = async (id: string) => {
    if (!confirm('Remove this webhook?')) return
    const res = await fetch(`${API}/apps/${appId}/webhooks/${id}`, {
      method: 'DELETE', headers: headers(),
    })
    if (res.ok) load()
    else setError('Failed to delete webhook')
  }

  const testWebhook = async (id: string) => {
    setTesting(id)
    setTestResult(null)
    try {
      const res = await fetch(`${API}/apps/${appId}/webhooks/${id}/test`, {
        method: 'POST', headers: headers(),
      })
      if (res.ok) {
        const data = await res.json() as { status: number; body: string }
        setTestResult({ id, ...data })
      }
    } catch {
      setTestResult({ id, status: 0, body: 'Network error' })
    } finally {
      setTesting(null)
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5">
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide mb-3">Webhooks</h3>
        <p className="text-sm text-[var(--muted)]">Loading...</p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide">Webhooks ({webhooks.length}/5)</h3>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="text-xs font-semibold text-[var(--accent)] hover:underline min-h-[44px] px-2"
        >
          {showAdd ? 'Cancel' : '+ Add webhook'}
        </button>
      </div>

      {error && <p className="text-sm text-[var(--error)] mb-3">{error}</p>}

      <p className="text-xs text-[var(--muted)] mb-3">
        Receive HTTP POST when events fire. Each delivery is signed with HMAC-SHA256 (X-FAS-Signature header).
      </p>

      {showAdd && (
        <AddWebhookForm
          appId={appId}
          events={supportedEvents}
          headers={headers}
          onDone={() => { setShowAdd(false); load() }}
          onError={setError}
        />
      )}

      {webhooks.length === 0 && !showAdd && (
        <p className="text-sm text-[var(--muted)] py-2">No webhooks configured.</p>
      )}

      {webhooks.map((wh) => (
        <div key={wh.id} className="py-2.5 border-b border-[var(--line)] last:border-0">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <span className="inline-block rounded-full border border-[var(--line)] px-2 py-0.5 text-xs text-[var(--accent)] font-semibold mr-2">
                {wh.event}
              </span>
              <span className="text-sm text-[var(--ink)] font-mono truncate">{wh.url}</span>
            </div>
          </div>
          <div className="flex gap-2 mt-1.5">
            <button
              onClick={() => testWebhook(wh.id)}
              disabled={testing === wh.id}
              className="text-xs text-[var(--accent)] hover:underline min-h-[36px] px-2 disabled:opacity-50"
            >
              {testing === wh.id ? 'Sending...' : 'Test'}
            </button>
            <button
              onClick={() => deleteWebhook(wh.id)}
              className="text-xs text-[var(--error)] hover:underline min-h-[36px] px-2"
            >
              Remove
            </button>
          </div>
          {testResult?.id === wh.id && (
            <div className={`mt-1.5 rounded-lg border px-3 py-2 text-xs font-mono ${
              testResult.status >= 200 && testResult.status < 300
                ? 'border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]'
                : 'border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)]'
            }`}>
              HTTP {testResult.status} {testResult.body.slice(0, 200)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function AddWebhookForm({ appId, events, headers, onDone, onError }: {
  appId: string
  events: string[]
  headers: () => Record<string, string>
  onDone: () => void
  onError: (msg: string) => void
}) {
  const [event, setEvent] = useState(events[0] ?? '')
  const [url, setUrl] = useState('https://')
  const [saving, setSaving] = useState(false)
  const [secret, setSecret] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!event || !url) return
    setSaving(true)
    onError('')
    try {
      const res = await fetch(`${API}/apps/${appId}/webhooks`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ event, url }),
      })
      const data = await res.json() as { id?: string; secret?: string; ok?: boolean; error?: string }
      if (data.secret) {
        setSecret(data.secret)
      } else {
        onError(data.error ?? `Failed (${res.status})`)
      }
    } catch {
      onError('Network error')
    } finally {
      setSaving(false)
    }
  }

  if (secret) {
    return (
      <div className="mb-3 p-3 rounded-xl border border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_5%,transparent)]">
        <p className="text-sm text-[var(--ink)] font-semibold mb-1">Webhook created!</p>
        <p className="text-xs text-[var(--muted)] mb-2">Save this signing secret. It won't be shown again.</p>
        <code className="block text-xs font-mono bg-[var(--paper)] border border-[var(--line)] rounded p-2 break-all select-all">
          {secret}
        </code>
        <button
          onClick={() => { setSecret(''); onDone() }}
          className="mt-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white min-h-[44px]"
        >
          Done
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="mb-3 p-3 rounded-xl border border-[var(--line)] bg-[var(--paper)]">
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className="text-xs font-semibold text-[var(--muted)] block mb-1">Event</label>
          <select
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm text-[var(--ink)] min-h-[44px]"
          >
            {events.map(ev => <option key={ev} value={ev}>{ev}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-[var(--muted)] block mb-1">URL (HTTPS)</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/webhook"
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-mono text-[var(--ink)] min-h-[44px]"
          />
        </div>
      </div>
      <button
        type="submit"
        disabled={!event || !url || saving}
        className="mt-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 min-h-[44px]"
      >
        {saving ? 'Creating...' : 'Create webhook'}
      </button>
    </form>
  )
}
