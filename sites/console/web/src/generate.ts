/**
 * The Generate page's runner (#795): this browser generates community jobs for the store apps the
 * creator opted in to, with the SDK's shared Kokoro runner (@freeappstore/sdk/generation-kokoro,
 * also used by Books). The state lives here, not in the page, so moving around the console does
 * not stop a run; it stops with Stop, when there is no more work, or when the window closes.
 */
import { useSyncExternalStore } from 'react'
import { Generation, type FreeAppStore, type GenerationJob, type GenerationOpenApp } from '@freeappstore/sdk'
import {
  contributeKokoro,
  deleteKokoroModel,
  kokoroProblem,
  KokoroRunner,
  type KokoroDevice,
  type KokoroProgress,
} from '@freeappstore/sdk/generation-kokoro'
import { API_URL, authHeaders } from './builder/lib/api'

const OPT_IN_KEY = 'fas:generate-apps'
const MODEL_KEY = 'fas:generate-model'
const RUNS_KEY = 'fas:generate-runs'
/** Run records kept, newest first, and the input text each keeps (for the Activity detail). */
const MAX_RUNS = 200
const RUN_TEXT_CHARS = 4000

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {}
}

/** The apps this browser generates for (per-app opt-in). */
export function optedInApps(): string[] {
  try { return JSON.parse(read(OPT_IN_KEY) ?? '[]') as string[] } catch { return [] }
}
export function setOptIn(appId: string, on: boolean) {
  const apps = optedInApps().filter(a => a !== appId)
  write(OPT_IN_KEY, JSON.stringify(on ? [...apps, appId] : apps))
}

/** Whether the creator agreed to the model download and it completed in this browser. */
export const modelConsented = () => read(MODEL_KEY) === '1'

/** Apps with open work for this creator (a console session sees every store app). */
export async function fetchOpenWork(token: string | null): Promise<GenerationOpenApp[]> {
  const res = await fetch(`${API_URL}/v1/generation/open`, { headers: authHeaders(token) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return ((await res.json()) as { apps: GenerationOpenApp[] }).apps
}

/** The app's sets this runner can generate exactly (Kokoro v1.0, audio/mp4, voice/speed). */
export const runnableSets = (app: GenerationOpenApp) => app.sets.filter(s => !kokoroProblem(s))

/**
 * A job this browser tried (#820): kept in localStorage so Activity can list the jobs that never
 * reached the server (skipped, stopped, failed) and show an uploaded job's text and timing.
 */
export interface RunRecord {
  appId: string
  setId: string
  jobId: string
  key: string
  /** When the job was claimed (ms epoch). */
  at: number
  outcome: 'submitted' | 'skipped' | 'stopped' | 'failed'
  reason: string | null
  /** Wall time from claim to upload or give-up. */
  ms: number
  /** The input, cut at RUN_TEXT_CHARS; `chars` is its whole length. */
  text: string
  chars: number
}

function loadRuns(): RunRecord[] {
  try {
    const runs = JSON.parse(read(RUNS_KEY) ?? '[]')
    return Array.isArray(runs) ? (runs as RunRecord[]) : []
  } catch { return [] }
}

export interface GenerateState {
  running: boolean
  /** Model download progress (0-1) while loading, else null. */
  loading: number | null
  /** The job being generated. */
  current: { appId: string; key: string; progress: KokoroProgress | null } | null
  submitted: number
  skipped: number
  /** How the last run ended, or why it failed. */
  message: string | null
  /** This browser's run records, newest first. */
  runs: RunRecord[]
}

let state: GenerateState = {
  running: false, loading: null, current: null, submitted: 0, skipped: 0, message: null, runs: loadRuns(),
}
const listeners = new Set<() => void>()
function set(next: Partial<GenerateState>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

/** Re-read the run records (another console tab may have added some). */
export function reloadRuns() {
  if (!state.running) set({ runs: loadRuns() })
}

export function useGenerate(): GenerateState {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => state,
    () => state,
  )
}

let runner: KokoroRunner | null = null
let runnerKey = ''
function getRunner(encoder: AudioEncoderConfig, device: KokoroDevice): KokoroRunner {
  const key = JSON.stringify([encoder, device])
  if (!runner || key !== runnerKey) {
    runner?.dispose()
    runner = new KokoroRunner({
      createWorker: () => new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module' }),
      encoder,
      device,
    })
    runnerKey = key
  }
  return runner
}

function record(appId: string, job: GenerationJob, at: number, outcome: RunRecord['outcome'], reason: string | null) {
  const run: RunRecord = {
    appId, setId: job.setId, jobId: job.id, key: job.key, at, outcome, reason, ms: Date.now() - at,
    text: job.input.text.slice(0, RUN_TEXT_CHARS), chars: job.input.text.length,
  }
  const runs = [run, ...state.runs].slice(0, MAX_RUNS)
  write(RUNS_KEY, JSON.stringify(runs))
  set({ runs })
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Download (unless cached) and load the model, after the creator agreed to its size. */
export async function downloadModel(encoder: AudioEncoderConfig, device: KokoroDevice) {
  set({ loading: 0, message: null })
  try {
    await getRunner(encoder, device).load(progress => set({ loading: progress }))
    write(MODEL_KEY, '1')
  } catch (err) {
    set({ message: `The model didn't download: ${errorText(err)}` })
  } finally {
    set({ loading: null })
  }
}

/** Free the model's memory and storage. */
export async function deleteModel() {
  stopGenerating()
  runner?.dispose()
  runner = null
  write(MODEL_KEY, null)
  await deleteKokoroModel()
}

let controller: AbortController | null = null

/** Generate for the opted-in apps' runnable sets, one set after another, until no work or Stop. */
export async function startGenerating(
  fas: FreeAppStore,
  apps: GenerationOpenApp[],
  encoder: AudioEncoderConfig,
  device: KokoroDevice,
  onSubmitted: (appId: string) => void,
) {
  if (state.running) return
  controller = new AbortController()
  const { signal } = controller
  set({ running: true, current: null, message: null })
  // A screen that turns off would put the window to sleep
  const wakeLock = await navigator.wakeLock?.request('screen').catch(() => null) ?? null
  const work = getRunner(encoder, device)
  // The job in hand, recorded when it ends however it ends
  let pending: { appId: string; job: GenerationJob; at: number } | null = null
  const finish = (outcome: RunRecord['outcome'], reason: string | null) => {
    if (pending) record(pending.appId, pending.job, pending.at, outcome, reason)
    pending = null
  }
  try {
    for (const app of apps) {
      const generation = new Generation(app.appId, API_URL, fas.auth)
      for (const s of runnableSets(app)) {
        if (signal.aborted) break
        await contributeKokoro(generation, {
          runner: work,
          setId: s.setId,
          signal,
          onEvent: e => {
            if (e.type === 'loading') set({ loading: e.progress })
            else if (e.type === 'claimed') {
              // A job still in hand at the next claim was abandoned when its lease ran out
              finish('stopped', 'the lease ran out before it finished')
              pending = { appId: app.appId, job: e.job, at: Date.now() }
              set({ loading: null, current: { appId: app.appId, key: e.job.key, progress: null } })
            } else if (e.type === 'progress') set({ current: { appId: app.appId, key: e.job.key, progress: e.progress } })
            else if (e.type === 'submitted') {
              finish('submitted', null)
              set({ submitted: state.submitted + 1, current: null })
              onSubmitted(app.appId)
            } else {
              if (pending?.job.id !== e.job.id) pending = { appId: app.appId, job: e.job, at: Date.now() }
              finish('skipped', e.reason)
              set({ skipped: state.skipped + 1, current: null })
            }
          },
        })
      }
    }
    finish('stopped', 'stopped before it finished')
    set({ message: signal.aborted ? 'Stopped.' : 'No more work for now.' })
  } catch (err) {
    if (signal.aborted) finish('stopped', 'stopped before it finished')
    else finish('failed', errorText(err))
    set({ message: signal.aborted ? 'Stopped.' : `Stopped on an error: ${errorText(err)}` })
  } finally {
    wakeLock?.release().catch(() => {})
    controller = null
    set({ running: false, loading: null, current: null })
  }
}

export function stopGenerating() {
  controller?.abort(new DOMException('Stopped', 'AbortError'))
}
