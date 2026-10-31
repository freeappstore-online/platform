import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const now = 1793404800000
const user = {
  id: 'fixture-admin',
  login: 'reviewer',
  githubLogin: 'reviewer',
  roles: ['admin'],
  avatarUrl: null,
}
const app = {
  id: 'demo',
  name: 'Demo App',
  store: 'apps',
  domain: 'demo.freeappstore.online',
  hostedOn: 'r2',
  inRegistry: true,
  owner: 'reviewer',
  repo: 'freeappstore-online/demo',
  category: 'utilities',
  type: 'connected',
  createdAt: now,
}
const messages = [
  { role: 'user', content: 'Build a simple timer.' },
  {
    role: 'assistant',
    content: 'The timer is ready to use.',
    toolCalls: [{ name: 'write_file', input: { path: 'src/App.tsx' } }],
    toolResults: [{ id: 'tool-1', content: 'File saved.' }],
  },
]
const session = {
  sessionId: 'fixture-session',
  userId: user.id,
  name: 'Demo timer',
  appId: 'demo',
  appUrl: 'https://demo.freeappstore.online',
  deployed: true,
  createdAt: now,
  updatedAt: now,
  messages,
}
const fixtures: Record<string, unknown> = {
  '/api/stats': {
    apps: 26,
    games: 4,
    routes: 30,
    users: 120,
    creators: 12,
    agentSessions: 8,
    traffic: {
      fas: { totals: { requests: 12000, pageViews: 2400, visitors: 800 } },
      fgs: null,
    },
  },
  '/api/apps/all': Array.from({ length: 26 }, (_, i) =>
    i === 0 ? app : { ...app, id: `demo-${i}`, name: `Demo App ${i}` },
  ),
  '/api/apps/deploy-status': {
    demo: { status: 'completed', conclusion: 'failure' },
  },
  '/api/apps/demo/health': {
    id: 'demo',
    domain: app.domain,
    hostedOn: 'r2',
    hasRoute: true,
    httpStatus: 200,
    reachable: true,
    ghActions: [
      {
        id: 1,
        conclusion: 'success',
        status: 'completed',
        headSha: 'abc1234',
        commitMsg: 'Update timer',
        createdAt: new Date(now).toISOString(),
      },
    ],
  },
  '/api/apps/demo/sessions': [session],
  '/api/agent/sessions': { sessions: [session], total: 2, page: 1, pages: 2 },
  '/api/agent/sessions/fixture-session': session,
  '/api/ai-grants/users': {
    users: [
      {
        ...user,
        displayName: 'Review Admin',
        keys: [
          { provider: 'anthropic', lastUsedAt: now },
          { provider: 'openai', lastUsedAt: null },
        ],
        grant: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          expiresAt: null,
        },
      },
    ],
  },
  '/api/ai-grants': { funded: ['anthropic'], grants: [] },
  '/api/content/kv': {
    entries: [
      { app_id: 'demo', user_id: user.id, key: 'preferences', size: 32 },
    ],
  },
  '/api/content/kv/value': { value: { theme: 'dark' } },
  '/api/content/collections': {
    documents: [
      {
        id: 'document-1',
        app_id: 'demo',
        collection: 'notes',
        owner_id: user.id,
        data: { title: 'Example note' },
      },
    ],
  },
  '/api/content/counters': {
    counters: [{ app_id: 'demo', name: 'visits', value: 42 }],
  },
}

for (const theme of ['light', 'dark']) {
  test(`admin screens and interaction states (${theme})`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.clock.install({ time: now })
    await page.route('https://api.freeappstore.online/**', (route) =>
      route.fulfill({ json: user }),
    )
    await page.route('**/api/**', (route) => {
      const key = new URL(route.request().url()).pathname
      expect(fixtures, `Unmocked API: ${key}`).toHaveProperty(key)
      return route.fulfill({ json: fixtures[key] })
    })
    await page.route('https://avatars.githubusercontent.com/**', (route) =>
      route.abort(),
    )
    await page.addInitScript(
      ({ theme, user }) => {
        new MutationObserver(() => {
          if (document.documentElement)
            document.documentElement.dataset.theme = theme
        }).observe(document, { childList: true, subtree: true })
        localStorage.setItem(
          'fas:session',
          JSON.stringify({ token: 'local-fixture-only', user }),
        )
      },
      { theme, user },
    )
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready)
      const folder = process.env.ADMIN_SCREENSHOTS
      if (folder) {
        await mkdir(folder, { recursive: true })
        await page.screenshot({
          path: path.join(folder, `${name}-${theme}.png`),
          fullPage: true,
          animations: 'disabled',
        })
      }
      expect(errors).toEqual([])
      if (!process.env.ADMIN_BASELINE) {
        // Playwright's caret hiding can leave an empty style attribute on inputs.
        expect(
          await page
            .locator('#root [style]')
            .evaluateAll((nodes) =>
              nodes
                .filter((node) => node.getAttribute('style')?.trim())
                .map((node) => node.outerHTML),
            ),
        ).toEqual([])
        await expect(page.locator('header')).toHaveCSS(
          'background-color',
          theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(18, 18, 18)',
        )
        await expect(page.locator('header')).toHaveCSS(
          'border-bottom-color',
          theme === 'light'
            ? 'rgba(0, 0, 0, 0.08)'
            : 'rgba(255, 255, 255, 0.08)',
        )
      }
    }
    const visit = async (hash: string, title: string) => {
      await page.goto(`/#${hash}`)
      await expect(
        page.getByRole('heading', { name: title, exact: true }),
      ).toBeVisible()
    }
    await visit('/', 'Platform Overview')
    await expect(page.getByText('12.0K', { exact: true })).toBeVisible()
    await capture('overview')
    await visit('/apps', 'Apps')
    await expect(page.getByText('Demo App', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Prev/ })).toBeDisabled()
    if (!process.env.ADMIN_BASELINE) {
      await expect(page.getByRole('button', { name: /Prev/ })).toHaveCSS(
        'opacity',
        '0.4',
      )
      await expect(
        page.getByRole('textbox', { name: 'Search apps' }),
      ).toHaveCSS('width', '220px')
      const row = page
        .getByRole('row')
        .filter({ has: page.getByText('Demo App', { exact: true }) })
      await row.hover()
      await expect(row).toHaveCSS(
        'background-color',
        theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(18, 18, 18)',
      )
      await page.mouse.move(0, 0)
    }
    await capture('apps')
    await page.getByRole('button', { name: /1 failing/ }).click()
    await expect(page.getByText('Demo App 1', { exact: true })).toHaveCount(0)
    if (!process.env.ADMIN_BASELINE)
      await expect(page.getByRole('button', { name: /1 failing/ })).toHaveCSS(
        'color',
        'rgb(255, 255, 255)',
      )
    await visit('/apps/demo', 'Demo App')
    await page.getByRole('button', { name: /Demo timer/ }).click()
    await expect(
      page.getByText('Build a simple timer.', { exact: true }),
    ).toBeVisible()
    await capture('app-detail')
    await page.getByRole('button', { name: 'Deprovision', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Deprovision "demo"' }),
    ).toBeVisible()
    await capture('deprovision')
    await visit('/provision', 'Provision New App')
    await capture('provision')
    await visit('/ai-keys', 'AI Grants')
    await expect(page.getByText('Review Admin', { exact: true })).toBeVisible()
    if (!process.env.ADMIN_BASELINE) {
      const dot = page.locator('span[aria-hidden]')
      await expect(dot).toHaveCSS('width', '6px')
      await expect(dot).toHaveCSS('height', '6px')
      await expect(page.getByRole('button', { name: 'Save Key' })).toHaveCSS(
        'opacity',
        '0.55',
      )
    }
    await capture('ai-grants')
    await visit('/content-data', 'Content Data')
    await expect(page.getByText('preferences', { exact: true })).toBeVisible()
    await capture('content-kv')
    await page.getByRole('button', { name: 'Collections', exact: true }).click()
    await expect(page.getByText('document-1', { exact: true })).toBeVisible()
    await capture('content-collections')
    await page.getByRole('button', { name: 'Counters', exact: true }).click()
    await expect(page.getByText('visits', { exact: true })).toBeVisible()
    await capture('content-counters')
    await visit('/agent', 'VibeCode Sessions')
    await expect(page.getByText('Demo timer', { exact: true })).toBeVisible()
    await capture('agent-sessions')
    await visit('/agent/fixture-session', 'Demo timer')
    await capture('agent-session')
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Sign in with GitHub' }),
    ).toBeVisible()
    // Sign-in has no header.
    if (process.env.ADMIN_SCREENSHOTS)
      await page.screenshot({
        path: path.join(process.env.ADMIN_SCREENSHOTS, `sign-in-${theme}.png`),
        fullPage: true,
      })
  })
}
