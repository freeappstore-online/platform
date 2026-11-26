// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AuthContext } from './useAuth'
import { type Agent, useAgent } from './useAgent'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
let agent: Agent
const user = { id: 'u1', login: 'creator', avatarUrl: null }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })

function Probe() {
  agent = useAgent()
  return null
}

function deferred() {
  let resolve!: (r: Response) => void
  const promise = new Promise<Response>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  localStorage.setItem('fas:session', JSON.stringify({ token: 't', user }))
  localStorage.setItem('fas_current_project', 'A')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount(route: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/v1/agent/sessions?limit=')) {
      return json({ sessions: [
        { id: 'A', name: 'Alpha', deployed: false, createdAt: 1, updatedAt: 2 },
        { id: 'B', name: 'Beta', deployed: false, createdAt: 1, updatedAt: 1 },
      ] })
    }
    return route(url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(
    <AuthContext.Provider value={{ user, loading: false, signIn: () => {}, signOut: () => {} }}>
      <Probe />
    </AuthContext.Provider>,
  ))
  await flush()
  return fetchMock
}

const history = (text: string) => json({ messages: [{ role: 'user', content: text }, { role: 'assistant', content: `re: ${text}` }] })

it("drops a slow history response for the project the user already left (#755)", async () => {
  const slowA = deferred()
  const fetchMock = await mount((url) => {
    if (url.endsWith('/session/A/history')) return slowA.promise
    if (url.endsWith('/session/B/history')) return history('build B')
    return json({})
  })
  act(() => agent.switchProject('B'))
  await flush()
  expect(agent.messages.map((m) => m.content)).toContain('build B')

  slowA.resolve(history('build A'))
  await flush()
  expect(agent.messages.map((m) => m.content)).toContain('build B')
  expect(agent.messages.map((m) => m.content)).not.toContain('build A')
  expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes('/sessions/B/messages') && i?.method === 'PUT')).toBe(false)
})

it('reports a history error when the evicted DO is empty and the D1 copy fails (#755)', async () => {
  await mount((url) => {
    if (url.endsWith('/session/A/history')) return json({ messages: [] })
    if (url.endsWith('/v1/agent/sessions/A')) return json({ error: 'boom' }, 500)
    return json({})
  })
  expect(agent.historyError).toBe(true)
})
