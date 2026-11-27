import { useCallback, useEffect, useState } from 'react'
import type { GenerationContributor, GenerationJobDetail, GenerationReport, GenerationReview } from '@freeappstore/sdk'
import { ArtifactPlayer } from './GenerationManager'
import { authHeaders } from './builder/lib/api'

/** One unreviewed artifact of the owner's review queue (`GET …/generation/review`, #842). */
export interface QueueItem {
  jobId: string
  setId: string
  key: string
  submissionId: string
  url: string
  metaUrl: string | null
  bytes: number
  durationMs: number | null
  acceptedAt: number
  contributor: GenerationContributor | null
  report: GenerationReport | null
  inputPreview: string
  inputChars: number
}

/** A contributor's numbers in the app (`GET …/generation/contributors`, #842). */
export interface ContributorStats {
  contributor: GenerationContributor
  submissions: number
  accepted: number
  judged: number
  good: number
  goodRate: number | null
  reviewed: number
  needsChanges: number
  reportedGood: number
  reportedNotGood: number
  blocked: boolean
}

const percent = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`)

/**
 * Plays the unreviewed artifacts one after another (#842), device-reported Not good first: G marks
 * the version Reviewed, B Needs changes (with the note), N skips to the next. People judge, no AI (#831).
 */
export function ReviewQueue({ base, getToken }: { base: string; getToken: () => string | null }) {
  const [items, setItems] = useState<QueueItem[] | null>(null)
  const [index, setIndex] = useState(0)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch(`${base}/review`, { headers: authHeaders(getToken()) })
      if (!res.ok) { setError(`Couldn't load the review queue (HTTP ${res.status}).`); return }
      setItems(((await res.json()) as { items: QueueItem[] }).items)
      setIndex(0)
    } catch {
      setError("Couldn't load the review queue.")
    }
  }, [base, getToken])

  useEffect(() => { load() }, [load])

  const item = items?.[index] ?? null
  const next = useCallback(() => {
    setNote('')
    setError('')
    if (items && index + 1 < items.length) setIndex(index + 1)
    else load()
  }, [items, index, load])

  const judge = useCallback(async (status: GenerationReview['status']) => {
    if (!item || saving) return
    setSaving(true)
    try {
      const res = await fetch(`${base}/artifacts/${encodeURIComponent(item.jobId)}/review`, {
        method: 'PUT',
        headers: { ...authHeaders(getToken()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId: item.submissionId, status, note: note.trim() || undefined }),
      })
      // 409: the artifact was replaced meanwhile; the new version is in a later queue.
      if (!res.ok && res.status !== 409) { setError(`Couldn't save the review (HTTP ${res.status}).`); return }
      next()
    } catch {
      setError("Couldn't save the review.")
    } finally {
      setSaving(false)
    }
  }, [item, saving, base, getToken, note, next])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof Element && e.target.closest('textarea, input, select')
      if (e.metaKey || e.ctrlKey || e.altKey || typing) return
      const key = e.key.toLowerCase()
      if (key === 'g') judge('reviewed')
      else if (key === 'b') judge('needs_changes')
      else if (key === 'n') next()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [judge, next])

  const loadText = async () => {
    const res = await fetch(`${base}/sets/${encodeURIComponent(item!.setId)}/jobs/${encodeURIComponent(item!.jobId)}`, {
      headers: authHeaders(getToken()),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return ((await res.json()) as { job: GenerationJobDetail }).job.input.text
  }

  return (
    <div className="rounded-xl border border-line bg-paper p-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h4 className="text-sm font-semibold text-ink">Review queue</h4>
        {items && items.length > 0 && <span className="text-xs text-muted">{Math.min(index + 1, items.length)} of {items.length}</span>}
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {!items && !error && <p className="mt-2 text-sm text-muted">Loading…</p>}
      {items?.length === 0 && <p className="mt-2 text-sm text-muted">Nothing to review: every accepted version is reviewed.</p>}
      {item && (
        <div className="mt-3">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="text-sm font-mono text-ink break-all">{item.key}</span>
            <span className="text-muted">by {item.contributor?.login ?? 'deleted account'}</span>
            {item.report ? (
              <span className={`rounded-full border px-2 py-0.5 font-semibold ${item.report.good ? 'border-success text-success' : 'border-danger text-danger'}`}>
                Device says {item.report.good ? 'Good' : 'Not good'}
              </span>
            ) : <span className="text-muted">No device report</span>}
          </div>
          {item.report?.note && <p className="mt-1 text-xs text-ink break-words">{item.report.note}</p>}
          <div className="mt-2">
            <ArtifactPlayer
              key={item.submissionId}
              url={item.url}
              metaUrl={item.metaUrl}
              preview={item.inputPreview}
              loadText={loadText}
              autoPlay
            />
          </div>
          <textarea
            aria-label="Review note (optional)"
            value={note}
            maxLength={500}
            rows={2}
            onChange={e => setNote(e.currentTarget.value)}
            placeholder="Note (optional), e.g. wrong stress on a word"
            className="mt-2 w-full rounded-lg border border-line bg-paper px-2 py-1 text-xs text-ink"
          />
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <button onClick={() => judge('reviewed')} disabled={saving} className="text-xs font-semibold text-success hover:underline disabled:opacity-50 min-h-[36px] px-2">
              Good <kbd className="ml-1 text-muted">G</kbd>
            </button>
            <button onClick={() => judge('needs_changes')} disabled={saving} className="text-xs font-semibold text-danger hover:underline disabled:opacity-50 min-h-[36px] px-2">
              Bad <kbd className="ml-1 text-muted">B</kbd>
            </button>
            <button onClick={next} disabled={saving} className="text-xs font-semibold text-accent hover:underline disabled:opacity-50 min-h-[36px] px-2">
              Next <kbd className="ml-1 text-muted">N</kbd>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Each contributor's good rate (#842): their judged submissions, the owner's review where there is
 * one, else their device's own report; and the owner's auto-block threshold.
 */
export function Contributors({ base, getToken }: { base: string; getToken: () => string | null }) {
  const [data, setData] = useState<{ autoBlockBelow: number | null; autoBlockMinJudged: number; contributors: ContributorStats[] } | null>(null)
  const [threshold, setThreshold] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch(`${base}/contributors`, { headers: authHeaders(getToken()) })
      if (!res.ok) { setError(`Couldn't load contributors (HTTP ${res.status}).`); return }
      const body = (await res.json()) as NonNullable<typeof data>
      setData(body)
      setThreshold(body.autoBlockBelow === null ? '' : String(Math.round(body.autoBlockBelow * 100)))
    } catch {
      setError("Couldn't load contributors.")
    }
  }, [base, getToken])

  useEffect(() => { load() }, [load])

  const save = async (below: number | null) => {
    setError('')
    const res = await fetch(`${base}/settings`, {
      method: 'PUT',
      headers: { ...authHeaders(getToken()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoBlockBelow: below }),
    }).catch(() => null)
    if (!res?.ok) { setError("Couldn't save the auto-block threshold."); return }
    load()
  }
  const value = Number(threshold)
  const valid = threshold.trim() !== '' && value >= 0 && value <= 100

  return (
    <div className="rounded-xl border border-line bg-paper p-4">
      <h4 className="text-sm font-semibold text-ink">Contributors</h4>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {!data && !error && <p className="mt-2 text-sm text-muted">Loading…</p>}
      {data && (
        <>
          <form
            className="mt-2 flex items-center gap-2 flex-wrap text-xs"
            onSubmit={e => { e.preventDefault(); if (valid) save(value / 100) }}
          >
            <label htmlFor="auto-block" className="text-muted">Auto-block below a good rate of</label>
            <input
              id="auto-block"
              type="number"
              min={0}
              max={100}
              value={threshold}
              onChange={e => setThreshold(e.currentTarget.value)}
              placeholder="off"
              className="w-16 rounded-lg border border-line bg-paper px-2 py-1 text-ink"
            />
            <span className="text-muted">%</span>
            <button type="submit" disabled={!valid} className="font-semibold text-accent hover:underline disabled:opacity-50 min-h-[36px] px-2">Save</button>
            {data.autoBlockBelow !== null && (
              <button type="button" onClick={() => save(null)} className="font-semibold text-muted hover:underline min-h-[36px] px-2">Turn off</button>
            )}
          </form>
          <p className="mt-1 text-xs text-muted">
            {data.autoBlockBelow === null
              ? 'Off.'
              : `On: a contributor with at least ${data.autoBlockMinJudged} judged submissions and a good rate under ${percent(data.autoBlockBelow)} is blocked, and everything they contributed is withdrawn.`}
          </p>
          {data.contributors.length === 0 ? <p className="mt-2 text-sm text-muted">No contributions yet.</p> : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="font-semibold pr-3 pb-1">Contributor</th>
                    <th className="font-semibold pr-3 pb-1">Good rate</th>
                    <th className="font-semibold pr-3 pb-1">Your reviews</th>
                    <th className="font-semibold pr-3 pb-1">Device says</th>
                    <th className="font-semibold pr-3 pb-1">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {data.contributors.map(r => (
                    <tr key={r.contributor.id} className="border-t border-line">
                      <td className="pr-3 py-1 text-ink">
                        {r.contributor.login ?? r.contributor.id}
                        {r.blocked && <span className="ml-2 text-danger font-semibold">blocked</span>}
                      </td>
                      <td className="pr-3 py-1 text-ink">{percent(r.goodRate)} <span className="text-muted">of {r.judged}</span></td>
                      <td className="pr-3 py-1 text-ink">{r.reviewed} good · {r.needsChanges} bad</td>
                      <td className="pr-3 py-1 text-ink">{r.reportedGood} good · {r.reportedNotGood} not good</td>
                      <td className="pr-3 py-1 text-ink">{r.submissions} <span className="text-muted">({r.accepted} accepted)</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
