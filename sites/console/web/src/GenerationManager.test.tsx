// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArtifactPlayer, GenerationManager, metaUrlOf, type GenerationJob, type GenerationSet } from './GenerationManager'

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

const set: GenerationSet = {
  id: 'set1', kind: 'tts', model: 'kokoro', modelVersion: '1.0', replicas: 1, requireAttestation: false,
  createdAt: Date.now(),
  counts: { jobs: 4, open: 2, accepted: 2, leased: 1, pending: 1, rejected: 3, withdrawn: 0 },
}
const contributor = { id: 'u1', login: 'alice' }
const job = (key: string): GenerationJob => ({
  id: `j-${key}`, key, status: 'accepted', inputPreview: 'Hello there. General Kenobi.', inputChars: 28,
  createdAt: 0,
  artifact: { url: `${api}/artifacts/j-${key}?v=abc`, durationMs: 2500, bytes: 4096, contributor, acceptedAt: Date.now() },
  submissions: [{
    id: `s-${key}`, contributor, deviceKind: 'web', attestation: 'unverified', status: 'rejected',
    reason: 'asr mismatch', wer: 0.42, durationMs: 2400, createdAt: Date.now(), decidedAt: Date.now(),
  }],
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
  expect(container.textContent).toContain('asr mismatch')
  expect(container.textContent).toContain('42%')
  expect(container.textContent).toContain('alice')

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

it('highlights the sentence being played from the meta segments', async () => {
  const url = `${api}/artifacts/j1?v=abc`
  const fetchMock = vi.fn(async () => json({ segments: [[0, 12, 0, 1], [13, 28, 1, 2], [29, 400, 2, 9]] }))
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<ArtifactPlayer url={url} preview="Hello there. General Kenobi." />))
  const audio = container.querySelector('audio')!
  await act(async () => { audio.dispatchEvent(new Event('play')) })
  await flush()
  expect(fetchMock).toHaveBeenCalledWith(`${api}/artifacts/j1/meta?v=abc`)

  const at = async (t: number) => {
    Object.defineProperty(audio, 'currentTime', { value: t, configurable: true })
    await act(async () => { audio.dispatchEvent(new Event('timeupdate')) })
  }
  await at(1.5)
  expect(container.querySelector('mark')!.textContent).toBe('General Kenobi.')
  await at(3)
  expect(container.querySelector('mark')).toBeNull()
  expect(container.textContent).toContain('Sentence 3 of 3')
})

it('derives the meta URL beside the artifact', () => {
  expect(metaUrlOf('https://a/x/artifacts/j?v=1')).toBe('https://a/x/artifacts/j/meta?v=1')
  expect(metaUrlOf('https://a/x/artifacts/j')).toBe('https://a/x/artifacts/j/meta')
})
