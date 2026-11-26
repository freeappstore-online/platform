// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RolesManager } from './RolesManager'

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
const row = (userId: string, roleName: string) => ({ userId, roleName, grantedBy: null, grantedAt: null })

// #822: the roles API is paged (#765); the page showed only the first page.
it('loads further pages of role rows with Show more', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    new Response(JSON.stringify(
      url.includes('offset=2')
        ? { roles: [row('gh:3', 'member')], nextOffset: null }
        : { roles: [row('gh:1', 'owner'), row('gh:2', 'member')], nextOffset: 2 },
    )),
  )
  vi.stubGlobal('fetch', fetchMock)

  await act(async () => root.render(<RolesManager appId="demo" getToken={getToken} />))
  await flush()
  expect(container.textContent).toContain('gh:2')
  expect(container.textContent).not.toContain('gh:3')

  await act(async () => button('Show more')!.click())
  await flush()
  expect(fetchMock.mock.calls.at(-1)![0]).toContain('/v1/apps/demo/roles?offset=2')
  expect(container.textContent).toContain('gh:1')
  expect(container.textContent).toContain('gh:3')
  expect(button('Show more')).toBeUndefined()
})
