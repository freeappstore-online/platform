import { useState } from 'react'
import type { ProvisionResult, ProvisionStep } from './api.ts'
import { api } from './api.ts'
import { StatusBadge } from './AppList.tsx'

export function ProvisionForm({ navigate }: { navigate: (h: string) => void }) {
  const [form, setForm] = useState({
    store: 'apps' as const,
    id: '',
    name: '',
    category: '',
    icon: '',
    iconBg: '#f0f9ff',
    description: '',
    creatorGithub: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<ProvisionResult | null>(null)

  const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setResult(null)
    try {
      const body = { ...form }
      const res = await api<ProvisionResult>('/api/provision', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setResult(res)
    } catch (err: unknown) {
      setResult({
        success: false,
        steps: [{ name: 'Error', status: 'fail', detail: err instanceof Error ? err.message : String(err) }],
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <button
        onClick={() => navigate('/')}
        className="text-sm font-medium mb-4 inline-flex items-center gap-1"
        style={{ color: 'var(--muted)' }}
      >
        &larr; Back
      </button>

      <h1 className="text-2xl font-bold mb-6">Provision New App</h1>

      <form onSubmit={handleSubmit} className="max-w-lg space-y-4">
        <Field label="ID" hint="Lowercase, letters/numbers/dashes only">
          <input
            value={form.id}
            aria-label="App ID"
            onChange={set('id')}
            required
            pattern="^[a-z][a-z0-9-]*[a-z0-9]$"
            placeholder="e.g. calendar"
            className="w-full rounded-lg px-3 py-2 text-sm"
            style={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}
          />
        </Field>

        <Field label="Display Name">
          <input
            value={form.name}
            aria-label="Display name"
            onChange={set('name')}
            required
            placeholder="e.g. Calendar"
            className="w-full rounded-lg px-3 py-2 text-sm"
            style={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}
          />
        </Field>

        <Field label="Category">
          <input
            value={form.category}
            aria-label="Category"
            onChange={set('category')}
            required
            placeholder="e.g. utilities"
            className="w-full rounded-lg px-3 py-2 text-sm"
            style={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Icon (HTML entity)">
            <input
              value={form.icon}
              aria-label="Icon"
              onChange={set('icon')}
              required
              placeholder="&#128197;"
              className="w-full rounded-lg px-3 py-2 text-sm"
              style={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}
            />
          </Field>
          <Field label="Icon Background">
            <input
              value={form.iconBg}
              aria-label="Icon background"
              onChange={set('iconBg')}
              placeholder="#f0f9ff"
              className="w-full rounded-lg px-3 py-2 text-sm"
              style={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}
            />
          </Field>
        </div>

        <Field label="Description">
          <input
            value={form.description}
            aria-label="Description"
            onChange={set('description')}
            required
            placeholder="Short description"
            className="w-full rounded-lg px-3 py-2 text-sm"
            style={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}
          />
        </Field>

        <Field label="Creator GitHub" hint="Gets push access to the repo">
          <input
            value={form.creatorGithub}
            aria-label="Creator GitHub username"
            onChange={set('creatorGithub')}
            placeholder="github-username"
            className="w-full rounded-lg px-3 py-2 text-sm"
            style={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}
          />
        </Field>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold"
          style={{ background: 'var(--accent)', color: '#fff', opacity: submitting ? 0.6 : 1 }}
        >
          {submitting ? 'Provisioning...' : 'Provision'}
        </button>
      </form>

      {result && (
        <div className="mt-6 max-w-lg">
          <StepList steps={result.steps} />
          <p
            className="mt-4 text-sm font-semibold"
            style={{ color: result.success ? 'var(--success)' : 'var(--error)' }}
          >
            {result.success ? 'Provisioned successfully!' : 'Some steps failed.'}
          </p>
          {result.success && (
            <button
              onClick={() => navigate(`/apps/${form.id}`)}
              className="mt-3 text-sm font-medium underline"
              style={{ color: 'var(--accent)' }}
            >
              View app details
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function StepList({ steps }: { steps: ProvisionStep[] }) {
  return (
    <div className="space-y-2">
      {steps.map((s, i) => (
        <div key={i} className="flex items-start gap-2 text-sm">
          <StatusBadge status={s.status} />
          <span className="font-medium" style={{ color: 'var(--ink)' }}>{s.name}</span>
          <span style={{ color: 'var(--muted)' }}>{s.detail}</span>
        </div>
      ))}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1" style={{ color: 'var(--ink)' }}>
        {label}
        {hint && <span className="font-normal ml-1" style={{ color: 'var(--muted)' }}>({hint})</span>}
      </label>
      {children}
    </div>
  )
}
