import { useCallback, useEffect, useState } from 'react'
import { Generation, type FreeAppStore, type GenerationOpenApp, type GenerationSubmission } from '@freeappstore/sdk'
import {
  isKokoroDownloaded,
  KOKORO_DOWNLOAD_BYTES,
  kokoroDevice,
  kokoroEncoder,
  kokoroProblem,
  type KokoroDevice,
} from '@freeappstore/sdk/generation-kokoro'
import { ConfirmDialog, ProgressBar } from '@freeappstore/sdk/ui'
import { API_URL } from './builder/lib/api'
import { formatTimeAgo } from './deploy-status'
import {
  deleteModel,
  downloadModel,
  fetchOpenWork,
  modelConsented,
  optedInApps,
  runnableSets,
  setOptIn,
  startGenerating,
  stopGenerating,
  useGenerate,
} from './generate'

const DOCS_URL = 'https://github.com/freeappstore-online/platform/blob/main/docs/community-generation.md'
const DEVICE_LABEL: Record<KokoroDevice, string> = { webgpu: 'WebGPU', wasm: 'WebAssembly' }
const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`

type Mine = GenerationSubmission & { appId: string }

const card = 'rounded-2xl border border-line bg-panel p-5 sm:p-6'
const heading = 'text-sm font-semibold text-muted uppercase tracking-wide mb-3'
const primary = 'rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 min-h-[44px]'
const secondary = 'rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-panel-hover min-h-[44px]'

/**
 * Generate (#795): any signed-in creator lends this desktop browser to the store's community
 * generation. It lists apps with open work, generates for the ones opted in to, with the SDK's
 * shared Kokoro runner, and shows the creator's own submissions.
 */
export function GeneratePage({ fas }: { fas: FreeAppStore }) {
  const [encoder, setEncoder] = useState<AudioEncoderConfig | null | undefined>(undefined)
  const [device, setDevice] = useState<KokoroDevice>('wasm')
  const [downloaded, setDownloaded] = useState(false)
  const [apps, setApps] = useState<GenerationOpenApp[] | null>(null)
  const [error, setError] = useState('')
  const [optIns, setOptIns] = useState(optedInApps)
  const [mine, setMine] = useState<Mine[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const run = useGenerate()

  useEffect(() => {
    kokoroEncoder().then(setEncoder)
    kokoroDevice().then(setDevice)
    isKokoroDownloaded().then(cached => setDownloaded(cached && modelConsented()))
  }, [])

  const loadApps = useCallback(async () => {
    setError('')
    try {
      setApps(await fetchOpenWork(fas.auth.token))
    } catch {
      setError("Couldn't load the apps with open work.")
    }
  }, [fas])

  const loadMine = useCallback(async (appIds: string[]) => {
    const lists = await Promise.all(appIds.map(appId =>
      new Generation(appId, API_URL, fas.auth).mySubmissions()
        .then(list => list.map(s => ({ ...s, appId })))
        .catch(() => [] as Mine[]),
    ))
    setMine(lists.flat().sort((a, b) => b.createdAt - a.createdAt).slice(0, 50))
  }, [fas])

  useEffect(() => { loadApps() }, [loadApps])
  useEffect(() => { loadMine(optIns) }, [loadMine, optIns])
  // The run ended: the open counts changed
  useEffect(() => { if (!run.running && run.message) loadApps() }, [run.running, run.message, loadApps])

  const toggle = (appId: string, on: boolean) => {
    setOptIn(appId, on)
    setOptIns(optedInApps())
  }

  if (encoder === null) {
    return (
      <div className="space-y-4">
        <Intro />
        <div className={card}>
          <p className="text-sm text-ink font-semibold">This browser can't generate.</p>
          <p className="mt-1 text-sm text-muted">
            Generating needs an AAC audio encoder (WebCodecs), which this browser doesn't have (Firefox,
            for example). Open the console in a desktop Chrome, Edge or Safari to generate.
          </p>
        </div>
      </div>
    )
  }

  const chosen = (apps ?? []).filter(a => optIns.includes(a.appId) && runnableSets(a).length > 0)
  const start = () => {
    if (!encoder) return
    startGenerating(fas, chosen, encoder, device, () => {
      setDownloaded(true)
      loadMine(optedInApps())
    }).then(() => setDownloaded(modelConsented()))
  }
  const download = async () => {
    if (!encoder) return
    await downloadModel(encoder, device)
    setDownloaded(modelConsented())
  }

  return (
    <div className="space-y-4">
      <Intro />

      <div className={card}>
        <h3 className={heading}>Model</h3>
        <p className="text-sm text-ink">
          Kokoro TTS v1.0 on {DEVICE_LABEL[device]} · {megabytes(KOKORO_DOWNLOAD_BYTES[device])}
        </p>
        {downloaded ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="text-sm text-success font-semibold">Downloaded and kept in this browser</span>
            <button onClick={() => setConfirmDelete(true)} className="text-sm text-danger hover:underline min-h-[44px] px-2">
              Delete model
            </button>
          </div>
        ) : (
          <div className="mt-3">
            <p className="text-sm text-muted">
              Generating downloads the model ({megabytes(KOKORO_DOWNLOAD_BYTES[device])}) from Hugging Face once and keeps it
              in this browser's storage until you delete it.
            </p>
            {run.loading !== null ? (
              <div className="mt-3"><ProgressBar value={Math.round(run.loading * 100)} max={100} label={`Downloading the model: ${Math.round(run.loading * 100)}%`} /></div>
            ) : (
              <button onClick={download} className={`${primary} mt-3`}>
                Download the model ({megabytes(KOKORO_DOWNLOAD_BYTES[device])})
              </button>
            )}
          </div>
        )}
        <ConfirmDialog
          open={confirmDelete}
          variant="danger"
          title="Delete the model?"
          message="Stops generating and frees the model's storage in this browser. You can download it again later."
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false)
            deleteModel().then(() => setDownloaded(false))
          }}
        />
      </div>

      <div className={card}>
        <h3 className={heading}>Apps with open work</h3>
        {error && <p className="text-sm text-danger mb-3">{error}</p>}
        {!apps && !error && <p className="text-sm text-muted">Loading…</p>}
        {apps?.length === 0 && <p className="text-sm text-muted">No app has open work for you right now.</p>}
        <div className="space-y-3">
          {apps?.map(app => (
            <AppRow key={app.appId} app={app} optedIn={optIns.includes(app.appId)} onToggle={on => toggle(app.appId, on)} />
          ))}
        </div>
      </div>

      <div className={card}>
        <h3 className={heading}>Generate</h3>
        <p className="text-sm text-muted">
          Generating runs only while this window stays open (install the console as an app to keep it in its own
          window). Each job is checked by the platform before anyone hears it.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {run.running ? (
            <button onClick={stopGenerating} className={secondary}>Stop</button>
          ) : (
            <button onClick={start} disabled={!downloaded || chosen.length === 0} className={primary}>Start</button>
          )}
          {!run.running && !downloaded && <span className="text-xs text-muted">Download the model first.</span>}
          {!run.running && downloaded && chosen.length === 0 && <span className="text-xs text-muted">Opt in to an app with work this browser can do.</span>}
        </div>
        <RunStatus />
      </div>

      <div className={card}>
        <h3 className={heading}>Your submissions</h3>
        {mine.length === 0 ? (
          <p className="text-sm text-muted">None yet{optIns.length ? '' : ': opt in to an app to see yours'}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="font-semibold pr-3 pb-1">App</th>
                  <th className="font-semibold pr-3 pb-1">Job</th>
                  <th className="font-semibold pr-3 pb-1">Status</th>
                  <th className="font-semibold pr-3 pb-1">Size</th>
                  <th className="font-semibold pr-3 pb-1">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {mine.map(s => (
                  <tr key={s.submissionId} className="border-t border-line align-top">
                    <td className="pr-3 py-1 text-ink">{s.appId}</td>
                    <td className="pr-3 py-1 text-ink font-mono break-all">{s.key}</td>
                    <td className="pr-3 py-1">
                      <span className={s.status === 'accepted' ? 'text-success' : s.status === 'rejected' ? 'text-danger' : 'text-ink'}>{s.status}</span>
                      {s.reason && <span className="block text-muted">{s.reason}</span>}
                    </td>
                    <td className="pr-3 py-1 text-ink">{Math.round(s.bytes / 1024)} KB</td>
                    <td className="pr-3 py-1 text-muted whitespace-nowrap">{formatTimeAgo(new Date(s.createdAt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function Intro() {
  return (
    <div>
      <h2 className="display-font text-2xl font-bold text-ink">Generate</h2>
      <p className="mt-1 text-sm text-muted">
        Lend this computer to apps that pregenerate content with a local model (today: narration). Your browser
        generates a job, the platform verifies it, and everyone gets it.{' '}
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">How it works</a>
      </p>
    </div>
  )
}

function AppRow({ app, optedIn, onToggle }: { app: GenerationOpenApp; optedIn: boolean; onToggle: (on: boolean) => void }) {
  const runnable = runnableSets(app).length > 0
  return (
    <div className="rounded-xl border border-line bg-paper p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink truncate">{app.appId}</p>
          {app.oneliner && <p className="text-xs text-muted truncate">{app.oneliner}</p>}
        </div>
        <label className={`flex items-center gap-2 text-xs font-semibold min-h-[44px] ${runnable ? 'text-ink' : 'text-muted'}`}>
          <input type="checkbox" checked={optedIn} disabled={!runnable} onChange={e => onToggle(e.currentTarget.checked)} className="size-4 accent-accent" />
          Generate for this app
        </label>
      </div>
      <ul className="mt-2 space-y-1">
        {app.sets.map(s => {
          const problem = kokoroProblem(s)
          return (
            <li key={s.setId} className="text-xs text-muted">
              <span className="text-ink">{s.kind.toUpperCase()} · {s.model} {s.modelVersion}</span> · {s.open} open
              {problem && <span> · this browser can't run it ({problem})</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function RunStatus() {
  const { running, loading, current, submitted, skipped, message } = useGenerate()
  const p = current?.progress
  return (
    <div role="status" className="mt-3 space-y-2 text-sm">
      {running && loading !== null && (
        <ProgressBar value={Math.round(loading * 100)} max={100} label={`Loading the model: ${Math.round(loading * 100)}%`} />
      )}
      {running && !current && loading === null && <p className="text-muted">Claiming a job…</p>}
      {current && (
        <div>
          <p className="text-ink">
            <span className="font-semibold">{current.appId}</span> · <span className="font-mono break-all">{current.key}</span>
          </p>
          {p ? (
            <>
              <div className="mt-2"><ProgressBar value={p.chars} max={Math.max(1, p.totalChars)} label={`Sentence ${p.sentence} of ${p.sentences}`} /></div>
              <p className="mt-1 text-xs text-muted">{p.charsPerSecond.toFixed(1)} characters per second · {p.chars.toLocaleString()} of {p.totalChars.toLocaleString()}</p>
            </>
          ) : <p className="text-xs text-muted">Starting…</p>}
        </div>
      )}
      {(submitted > 0 || skipped > 0) && (
        <p className="text-xs text-muted">This session: {submitted} submitted{skipped ? `, ${skipped} skipped (this browser couldn't do them exactly)` : ''}.</p>
      )}
      {!running && message && <p className="text-muted">{message}</p>}
    </div>
  )
}
