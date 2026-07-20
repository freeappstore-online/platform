export async function api<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...opts?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

// Types matching the admin worker API responses

export interface AppConfig {
  id: string
  name: string
  store: 'apps' | 'games'
  org: string
  domain: string
}

export interface PlatformStats {
  apps: number
  games: number
  users: number
  creators: number
  routes: number
  agentSessions: number
  traffic: {
    fas: { totals: { requests: number; pageViews: number; visitors: number } } | null
    fgs: { totals: { requests: number; pageViews: number; visitors: number } } | null
  } | null
}

export interface ProvisionStep {
  name: string
  status: 'ok' | 'skip' | 'fail'
  detail: string
}

export interface ProvisionResult {
  steps: ProvisionStep[]
  success: boolean
}

export interface DeprovisionResult {
  ok: boolean
  id: string
  steps: ProvisionStep[]
}

// Unified app from /api/apps/all
export interface UnifiedApp {
  id: string
  name: string
  store: string
  domain: string
  hostedOn: 'r2' | 'orphan' | string
  r2Prefix: string | null
  inRegistry: boolean
  owner: string | null
  ownerAvatar: string | null
  category: string | null
  type: string | null
  repo: string
  createdAt: number | null
  updatedAt: number | null
}

// /api/apps/deploy-status → { [appId]: DeployStatus } — latest GH Actions run.
export interface DeployStatus {
  status: string | null
  conclusion: string | null
  at: string | null
  sha: string | null
}
export type DeployStatusMap = Record<string, DeployStatus>

// Health check from /api/apps/:id/health
export interface AppHealth {
  id: string
  domain: string
  hostedOn: string
  hasRoute: boolean
  httpStatus: number
  reachable: boolean
  ghActions: GhRun[]
}

export interface GhRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  createdAt: string
  headSha: string
  commitMsg: string
}

// App sessions (inline on app detail page)
export interface AppSession {
  sessionId: string
  userId: string
  name: string
  deployed: boolean
  deployState: { phase: string } | null
  messages: AgentMessage[]
  createdAt: number
  updatedAt: number
}

// Agent sessions
export interface AgentSession {
  sessionId: string
  userId: string
  name: string
  appId: string | null
  appUrl: string | null
  deployed: boolean
  deployState: { phase: string } | null
  createdAt: number
  updatedAt: number
}

export interface AgentSessionDetail extends AgentSession {
  messages: AgentMessage[]
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: { name: string; input: Record<string, unknown> }[]
  toolResults?: { id: string; content: string }[]
}

export interface AgentSessionsResponse {
  sessions: AgentSession[]
  total: number
  page: number
  pages: number
}

export interface KeyProvider {
  id: string
  name: string
  docs_url: string | null
  key_prefix: string | null
}

export interface UserApiKey {
  provider: string
  label: string | null
  createdAt: number
  lastUsedAt: number | null
}

export interface ComplimentaryGrant {
  userId: string
  provider: string
  model: string
  grantedBy: string
  note: string | null
  createdAt: number
  expiresAt: string | null
}

export interface AdminUser {
  id: string
  githubLogin: string
  displayName: string | null
  avatarUrl: string | null
  createdAt: number | null
  keys: UserApiKey[]
  grant: ComplimentaryGrant | null
}

export interface KeyUsersResponse {
  users: AdminUser[]
}

export interface KeyProvidersResponse {
  providers: KeyProvider[]
}

export interface GrantsResponse {
  grants: ComplimentaryGrant[]
  funded: string[]
}
