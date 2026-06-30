import { useState, useEffect, useCallback } from 'react'

const API_BASE = 'https://api.freeappstore.online/v1'

interface RoleAssignment {
  user_id: string
  role_name: string
  granted_by: string
  granted_at: string
}

interface Props {
  appId: string
  getToken: () => string | null
}

const BUILTIN_ROLES = ['moderator', 'editor', 'viewer'] as const
const ROLE_DESCRIPTIONS: Record<string, string> = {
  owner: 'Full control. Cannot be revoked.',
  moderator: 'Can moderate content and manage reports.',
  editor: 'Can edit app content and configuration.',
  viewer: 'Read-only access to app data and analytics.',
}

export function RolesManager({ appId, getToken }: Props) {
  const [roles, setRoles] = useState<RoleAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [userId, setUserId] = useState('')
  const [selectedRole, setSelectedRole] = useState<string>(BUILTIN_ROLES[0])
  const [customRole, setCustomRole] = useState('')
  const [useCustom, setUseCustom] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)

  const fetchRoles = useCallback(async () => {
    const token = getToken()
    if (!token) { setLoading(false); return }
    try {
      const res = await fetch(`${API_BASE}/apps/${encodeURIComponent(appId)}/roles`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`Failed to load roles (${res.status})`)
      const data = (await res.json()) as { roles: RoleAssignment[] }
      setRoles(data.roles ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load roles')
    } finally {
      setLoading(false)
    }
  }, [appId, getToken])

  useEffect(() => { fetchRoles() }, [fetchRoles])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const role = useCustom ? customRole.trim() : selectedRole
    if (!userId.trim() || !role) return
    const token = getToken()
    if (!token) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/apps/${encodeURIComponent(appId)}/roles`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userId.trim(), role }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `Failed to add role (${res.status})`)
      }
      setUserId('')
      setCustomRole('')
      await fetchRoles()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add role')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRevoke = async (targetUserId: string, roleName: string) => {
    const token = getToken()
    if (!token) return
    const key = `${targetUserId}:${roleName}`
    setRevoking(key)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/apps/${encodeURIComponent(appId)}/roles`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: targetUserId, role: roleName }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `Failed to revoke role (${res.status})`)
      }
      await fetchRoles()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke role')
    } finally {
      setRevoking(null)
    }
  }

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 sm:p-6">
      <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide mb-4">Roles</h3>

      {error && (
        <div className="mb-4 rounded-lg border border-[var(--error)] bg-[var(--error)]/10 px-3 py-2 text-sm text-[var(--error)]">
          {error}
        </div>
      )}

      {/* Role descriptions */}
      <div className="mb-5 grid gap-2 sm:grid-cols-2">
        {Object.entries(ROLE_DESCRIPTIONS).map(([role, desc]) => (
          <div key={role} className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2">
            <span className="text-xs font-semibold text-[var(--ink)] capitalize">{role}</span>
            <p className="text-xs text-[var(--muted)] mt-0.5">{desc}</p>
          </div>
        ))}
      </div>

      {/* Current assignments */}
      {loading ? (
        <p className="text-sm text-[var(--muted)]">Loading roles...</p>
      ) : roles.length === 0 ? (
        <p className="text-sm text-[var(--muted)] mb-4">No role assignments yet.</p>
      ) : (
        <div className="mb-5 space-y-1.5">
          {roles.map((r) => {
            const isOwner = r.role_name === 'owner'
            const key = `${r.user_id}:${r.role_name}`
            return (
              <div
                key={key}
                className="flex items-center justify-between gap-3 rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2"
              >
                <div className="min-w-0">
                  <span className="text-sm font-medium text-[var(--ink)] truncate block">{r.user_id}</span>
                  <span className="text-xs text-[var(--muted)]">
                    <span className="capitalize font-semibold">{r.role_name}</span>
                    {r.granted_by && <> &middot; granted by {r.granted_by}</>}
                    {r.granted_at && <> &middot; {new Date(r.granted_at).toLocaleDateString()}</>}
                  </span>
                </div>
                {isOwner ? (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)] flex-shrink-0">
                    Owner
                  </span>
                ) : (
                  <button
                    onClick={() => handleRevoke(r.user_id, r.role_name)}
                    disabled={revoking === key}
                    className="flex-shrink-0 rounded-lg border border-[var(--error)] px-3 py-1.5 text-xs font-medium text-[var(--error)] hover:bg-[var(--error)] hover:text-white disabled:opacity-50 min-h-[32px]"
                  >
                    {revoking === key ? 'Revoking...' : 'Revoke'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Add role form */}
      <form onSubmit={handleAdd} className="space-y-3">
        <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide">Add Role</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            placeholder="User ID (GitHub login)"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="flex-1 rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--muted)] min-h-[40px]"
          />
          {useCustom ? (
            <input
              type="text"
              placeholder="Custom role name"
              value={customRole}
              onChange={(e) => setCustomRole(e.target.value)}
              className="w-full sm:w-40 rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--muted)] min-h-[40px]"
            />
          ) : (
            <select
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value)}
              className="w-full sm:w-40 rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-3 py-2 text-sm text-[var(--ink)] min-h-[40px]"
            >
              {BUILTIN_ROLES.map((r) => (
                <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
              ))}
            </select>
          )}
          <button
            type="submit"
            disabled={submitting || !userId.trim() || (useCustom && !customRole.trim())}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 min-h-[40px] whitespace-nowrap"
          >
            {submitting ? 'Adding...' : 'Add Role'}
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--muted)] cursor-pointer">
          <input
            type="checkbox"
            checked={useCustom}
            onChange={(e) => setUseCustom(e.target.checked)}
            className="rounded"
          />
          Use custom role name
        </label>
      </form>
    </div>
  )
}
