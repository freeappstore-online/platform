/**
 * The Generate page's runner (#795): this browser generates community jobs for the store apps the
 * creator opted in to, with the SDK's shared Kokoro runner (@freeappstore/sdk/generation-kokoro,
 * also used by Books). The state lives here, not in the page, so moving around the console does
 * not stop a run; it stops with Stop, when there is no more work, or when the window closes.
 */
import { useSyncExternalStore } from 'react'
import { Generation, type FreeAppStore, type GenerationOpenApp } from '@freeappstore/sdk'
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
}

let state: GenerateState = { running: false, loading: null, current: null, submitted: 0, skipped: 0, message: null }
const listeners = new Set<() => void>()
function set(next: Partial<GenerateState>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
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
      createWorker: () => new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' }),
      encoder,
      device,
    })
    runnerKey = key
  }
  return runner
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
            else if (e.type === 'claimed') set({ loading: null, current: { appId: app.appId, key: e.job.key, progress: null } })
            else if (e.type === 'progress') set({ current: { appId: app.appId, key: e.job.key, progress: e.progress } })
            else if (e.type === 'submitted') {
              set({ submitted: state.submitted + 1, current: null })
              onSubmitted(app.appId)
            } else set({ skipped: state.skipped + 1, current: null })
          },
        })
      }
    }
    set({ message: signal.aborted ? 'Stopped.' : 'No more work for now.' })
  } catch (err) {
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
