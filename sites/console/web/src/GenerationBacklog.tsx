import { useEffect, useState } from 'react'
import { API_URL } from './builder/lib/api'

interface Backlog {
  jobs: { id: string; appId: string; key: string; inputPreview: string; inputChars: number; model: string; modelVersion: string }[]
  hasMore: boolean
}
export function GenerationBacklog({ token }: { token: string | null }) {
  const [value, setValue] = useState<Backlog | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true); setError(''); setValue(null)
    fetch(`${API_URL}/v1/generation/backlog`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
    }).then(async response => {
      if (!response.ok) throw new Error('Could not load backlog')
      return await response.json() as Backlog
    }).then(data => { if (active) setValue(data) }, () => {
      if (active) setError("Couldn't load awaiting jobs. Try Refresh.")
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [token, refresh])
  return <section className="min-w-0 rounded-2xl border border-line bg-panel p-5 sm:p-6" aria-label="Up next">
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <h3 className="font-semibold">Up next · awaiting generation</h3>
      <button type="button" disabled={loading} onClick={() => setRefresh(n => n + 1)} className="max-w-full rounded-lg border border-line px-4 py-2 min-h-[44px] disabled:opacity-50">Refresh backlog</button>
    </div>
    <p className="text-sm text-muted my-3">Up to 100 jobs available to your account, oldest first. Only enabled apps run; other devices may take these jobs, so the order can change.</p>
    {loading && <p role="status">Loading awaiting jobs…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && value && <>
      <p className="text-sm text-muted">{value.jobs.length ? `Showing ${value.jobs.length}${value.hasMore ? ' of more than 100' : ''} awaiting jobs.` : 'No jobs are awaiting generation for your account.'}</p>
      <ol className="divide-y divide-line">
        {value.jobs.map((job, i) => <li key={job.id} className="min-w-0 py-3 wrap-anywhere">
          <div className="font-semibold">{i + 1}. {job.appId} · {job.key}</div>
          <div className="text-sm text-muted">{job.model} {job.modelVersion} · {job.inputChars.toLocaleString()} characters</div>
          <p className="text-sm my-1">{job.inputPreview}</p>
        </li>)}
      </ol>
    </>}
  </section>
}
