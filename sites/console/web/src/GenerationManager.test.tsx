// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GenerationJobSummary, GenerationSetSummary } from '@freeappstore/sdk'
import { ArtifactPlayer, GenerationManager, metaUrlOf } from './GenerationManager'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const getToken = () => 'token'
const api = 'https://api.freeappstore.online/v1/apps/demo/generation'

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
const json = (body: unknown) => new Response(JSON.stringify(body))

const set: GenerationSetSummary = {
  id: 'set1', kind: 'tts', model: 'kokoro', modelVersion: '1.0', replicas: 1, requireAttestation: false,
  params: { voice: 'af_heart' }, formats: ['audio/mp4'], maxBytes: 1_000_000, createdAt: Date.now(),
  counts: { jobs: 4, open: 2, accepted: 2, leased: 1, pending: 1, rejected: 3, withdrawn: 0 },
}
const contributor = { id: 'u1', login: 'alice' }
const job = (key: string): GenerationJobSummary => ({
  id: `j-${key}`, key, status: 'accepted', inputPreview: 'Hello there. General Kenobi.', inputChars: 28,
  createdAt: 0,
  artifact: {
    url: `${api}/artifacts/j-${key}?v=abc`, submissionId: `s-${key}`, durationMs: 2500, bytes: 4096, contributor,
    acceptedAt: Date.now(), review: null,
  },
  submissions: [{
    id: `s-${key}`, contributor, deviceKind: 'web', attestation: 'unverified', status: 'rejected',
    reason: 'audio is too short for the text', durationMs: 2400, createdAt: Date.now(), decidedAt: Date.now(),
    report: { good: false, note: 'skips the second sentence', at: Date.now() },
    record: {
      runner: 'android', reason: 'submitted', appVersion: '1.4.0', device: 'Google Pixel 10a', os: 'Android 16',
      background: true, wallMs: 12_400, loadMs: 900, synthMs: 8200, cpuMs: 30_100, rtf: 0.35,
      batteryStart: 81, batteryEnd: 79, chargingStart: true, thermalStart: 'none', thermalEnd: 'light', createdAt: Date.now(),
    },
  }],
  attempts: [{ contributor, runner: 'browser', reason: 'user_stop', wallMs: 3000, createdAt: Date.now() }],
})

it('explains how to create a set when the app has none', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ sets: [] })))
  await act(async () => root.render(<GenerationManager appId="demo" getToken={getToken} />))
  await flush()
  expect(container.textContent).toContain('no generation sets yet')
  expect(container.querySelector('a')!.getAttribute('href')).toContain('docs/community-generation.md')
})

it('shows set progress, pages jobs by cursor with a status filter, and withdraws after an in-page confirm', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/generation/sets')) return json({ sets: [set] })
    if (init?.method === 'DELETE') return json({ withdrawn: 1 })
    const cursor = new URL(url).searchParams.get('cursor')
    return cursor ? json({ jobs: [job('b')], nextCursor: null }) : json({ jobs: [job('a')], nextCursor: 'a' })
  })
  vi.stubGlobal('fetch', fetchMock)
  const confirmSpy = vi.fn()
  vi.stubGlobal('confirm', confirmSpy)

  await act(async () => root.render(<GenerationManager appId="demo" getToken={getToken} />))
  await flush()
  expect(container.textContent).toContain('2 of 4 jobs accepted')
  expect(container.textContent).toContain('kokoro 1.0')

  act(() => button('Jobs')!.click())
  await flush()
  expect(container.textContent).toContain('audio is too short for the text')
  // The contributor's own report (#831), and the version is not reviewed yet
  expect(container.textContent).toContain('Not good')
  expect(container.textContent).toContain('skips the second sentence')
  expect(container.textContent).toContain('Not reviewed')
  expect(container.textContent).toContain('alice')
  // The device's attempt record (#827)
  expect(container.textContent).toContain('Google Pixel 10a · Android 16')
  expect(container.textContent).toContain('load 900 ms · synthesis 8.2 s')
  expect(container.textContent).toContain('CPU time30 s')
  expect(container.textContent).toContain('81% charging → 79%')
  expect(container.textContent).toContain('none → light')
  expect(container.textContent).toContain('Attempts without an upload')
  expect(container.textContent).toContain('user_stop')

  act(() => button('Load more')!.click())
  await flush()
  expect(fetchMock.mock.calls.map(([u]) => u)).toContain(`${api}/sets/set1/jobs?cursor=a`)
  expect(button('Load more')).toBeUndefined()
  expect(container.querySelectorAll('audio')).toHaveLength(2)

  act(() => button('Accepted')!.click())
  await flush()
  expect(fetchMock.mock.calls.map(([u]) => u)).toContain(`${api}/sets/set1/jobs?status=accepted`)

  act(() => button('Withdraw')!.click())
  expect(document.body.textContent).toContain('Withdraw artifact?')
  act(() => button('Cancel')!.click())
  expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false)

  act(() => button('Withdraw')!.click())
  const dialogButtons = [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Withdraw')
  await act(async () => dialogButtons.at(-1)!.click())
  await flush()
  expect(fetchMock).toHaveBeenCalledWith(`${api}/artifacts/j-a`, expect.objectContaining({ method: 'DELETE' }))
  expect(confirmSpy).not.toHaveBeenCalled()
})

it('the owner marks the exact version Reviewed or Needs changes with a note (#787, #831)', async () => {
  const review = { status: 'needs_changes', note: 'wrong tone on 妈', by: 'alice', at: Date.now() }
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/generation/sets')) return json({ sets: [set] })
    if (init?.method === 'PUT') return json({ review })
    return json({ jobs: [job('a')], nextCursor: null })
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GenerationManager appId="demo" getToken={getToken} />))
  await flush()
  act(() => button('Jobs')!.click())
  await flush()
  const note = container.querySelector('textarea[aria-label="Review note (optional)"]') as HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'wrong tone on 妈')
    note.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Needs changes')!.click())
  await flush()
  const put = fetchMock.mock.calls.find(([, i]) => i?.method === 'PUT')!
  expect(put[0]).toBe(`${api}/artifacts/j-a/review`)
  expect(JSON.parse(put[1]!.body as string)).toEqual({ submissionId: 's-a', status: 'needs_changes', note: 'wrong tone on 妈' })
  expect(container.textContent).toContain('Needs changes')
  expect(container.textContent).toContain('by alice')
  expect(container.textContent).not.toContain('Not reviewed')
})

it('blocks a contributor after confirming', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/generation/sets')) return json({ sets: [set] })
    if (init?.method === 'POST') return json({ blocked: true, withdrawn: 1 })
    return json({ jobs: [job('a')], nextCursor: null })
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GenerationManager appId="demo" getToken={getToken} />))
  await flush()
  act(() => button('Jobs')!.click())
  await flush()
  act(() => button('Block')!.click())
  expect(document.body.textContent).toContain('alice can no longer contribute')
  const confirmButtons = [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Block')
  await act(async () => confirmButtons.at(-1)!.click())
  await flush()
  expect(fetchMock).toHaveBeenCalledWith(`${api}/contributors/u1/block`, expect.objectContaining({ method: 'POST' }))
})

it('highlights the sentence being played in the whole text, from the meta segments', async () => {
  const url = `${api}/artifacts/j1?v=abc`
  const long = `Hello there. General Kenobi. ${'x'.repeat(300)}.`
  const fetchMock = vi.fn(async () => json({ segments: [[0, 12, 0, 1], [13, 28, 1, 2], [29, 330, 2, 9]] }))
  vi.stubGlobal('fetch', fetchMock)
  const loadText = vi.fn(async () => long)
  await act(async () => root.render(<ArtifactPlayer url={url} preview={long.slice(0, 200)} loadText={loadText} />))
  const audio = container.querySelector('audio')!
  await act(async () => { audio.dispatchEvent(new Event('play')) })
  await flush()
  expect(fetchMock).toHaveBeenCalledWith(`${api}/artifacts/j1/meta?v=abc`)
  expect(loadText).toHaveBeenCalledOnce()

  const at = async (t: number) => {
    Object.defineProperty(audio, 'currentTime', { value: t, configurable: true })
    await act(async () => { audio.dispatchEvent(new Event('timeupdate')) })
  }
  await at(1.5)
  expect(container.querySelector('mark')!.textContent).toBe('General Kenobi.')
  // Past the 200-character preview, from the whole text
  await at(3)
  expect(container.querySelector('mark')!.textContent).toBe(long.slice(29))
})

it('falls back to the preview and the sentence number when the whole text cannot load', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ segments: [[0, 12, 0, 1], [13, 28, 1, 2], [29, 400, 2, 9]] })))
  const loadText = vi.fn(async () => { throw new Error('HTTP 500') })
  await act(async () => root.render(<ArtifactPlayer url={`${api}/artifacts/j1`} preview="Hello there. General Kenobi." loadText={loadText} />))
  const audio = container.querySelector('audio')!
  await act(async () => { audio.dispatchEvent(new Event('play')) })
  await flush()
  Object.defineProperty(audio, 'currentTime', { value: 3, configurable: true })
  await act(async () => { audio.dispatchEvent(new Event('timeupdate')) })
  expect(container.querySelector('mark')).toBeNull()
  expect(container.textContent).toContain('Sentence 3 of 3')
})

it('loads the whole text of a listed job from the owner endpoint', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/generation/sets')) return json({ sets: [set] })
    if (url.endsWith('/jobs/j-a')) return json({ job: { ...job('a'), input: { text: 'Hello there. General Kenobi.' } } })
    if (url.includes('/meta')) return json({ segments: [[0, 12, 0, 1]] })
    return json({ jobs: [job('a')], nextCursor: null })
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GenerationManager appId="demo" getToken={getToken} />))
  await flush()
  act(() => button('Jobs')!.click())
  await flush()
  await act(async () => { container.querySelector('audio')!.dispatchEvent(new Event('play')) })
  await flush()
  expect(fetchMock).toHaveBeenCalledWith(`${api}/sets/set1/jobs/j-a`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }))
})

it('derives the meta URL beside the artifact', () => {
  expect(metaUrlOf('https://a/x/artifacts/j?v=1')).toBe('https://a/x/artifacts/j/meta?v=1')
  expect(metaUrlOf('https://a/x/artifacts/j')).toBe('https://a/x/artifacts/j/meta')
})
