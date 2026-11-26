// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WebhooksManager } from './WebhooksManager'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const getToken = () => 'token'

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)

// #756: the one-time secret survived only inside the add form, so the header
// "Cancel" discarded it, and the list was not reloaded.
it('keeps the new signing secret visible after the form closes and reloads the list', async () => {
  let listed: unknown[] = []
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      listed = [{ id: 'w1', event: 'user.signup', url: 'https://example.com/h', active: 1, created_at: 0 }]
      return new Response(JSON.stringify({ id: 'w1', secret: 'whsec_123' }))
    }
    return new Response(JSON.stringify({ webhooks: listed, supported_events: ['user.signup'] }))
  })
  vi.stubGlobal('fetch', fetchMock)

  await act(async () => root.render(<WebhooksManager appId="demo" getToken={getToken} />))
  await flush()
  act(() => button('+ Add webhook')!.click())
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await flush()

  expect(container.textContent).toContain('whsec_123')
  expect(container.textContent).toContain('Webhooks (1/5)')
  expect(button('Cancel')).toBeUndefined()

  act(() => button('Done')!.click())
  expect(container.textContent).not.toContain('whsec_123')
})
