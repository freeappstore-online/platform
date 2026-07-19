import { useEffect, useMemo, useState } from 'react'
import type { AdminUser, GrantsResponse, KeyUsersResponse } from './api.ts'
import { api } from './api.ts'
import { ErrorBox, Loading } from './Overview.tsx'

const GRANT_MODELS: Record<string, { value: string; label: string }[]> = {
  anthropic: [
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4 Mini' },
  ],
  google: [
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
}

// Providers you can paste a key for (stored in the user's encrypted vault).
// `id` must match the backend key_providers table EXACTLY (note google-ai, not
// google) or the paste 400s. The label shows the required key prefix so admins
// don't paste a mismatched/truncated key (the backend enforces the prefix).
const KEY_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic — key starts sk-ant-' },
  { id: 'openai', label: 'OpenAI — key starts sk-' },
  { id: 'google-ai', label: 'Google AI — key starts AI' },
  { id: 'openrouter', label: 'OpenRouter — key starts sk-or-' },
]

export function AIKeys() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [funded, setFunded] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedUser, setSelectedUser] = useState('')
  const [provider, setProvider] = useState('anthropic')
  const [model, setModel] = useState(GRANT_MODELS.anthropic![0]!.value)
  const [note, setNote] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [keyProvider, setKeyProvider] = useState('anthropic')
  const [keyValue, setKeyValue] = useState('')
  const [keySaving, setKeySaving] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [userData, grantData] = await Promise.all([
        api<KeyUsersResponse>('/api/ai-grants/users'),
        api<GrantsResponse>('/api/ai-grants'),
      ])
      setUsers(userData.users)
      setFunded(grantData.funded)
      setSelectedUser((current) => current || userData.users[0]?.id || '')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return users
    return users.filter((user) =>
      user.id.toLowerCase().includes(q) ||
      user.githubLogin.toLowerCase().includes(q) ||
      (user.displayName ?? '').toLowerCase().includes(q) ||
      (user.grant?.provider ?? '').toLowerCase().includes(q) ||
      user.keys.some((key) => key.provider.toLowerCase().includes(q)),
    )
  }, [search, users])

  const activeUser = users.find((user) => user.id === selectedUser) ?? null
  const models = GRANT_MODELS[provider] ?? []

  function setGrantProvider(nextProvider: string) {
    setProvider(nextProvider)
    setModel(GRANT_MODELS[nextProvider]?.[0]?.value ?? '')
  }

  async function grantUser() {
    if (!selectedUser || !provider || !model) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await api('/api/ai-grants', {
        method: 'POST',
        body: JSON.stringify({
          userId: selectedUser,
          provider,
          model,
          note: note.trim() || null,
          expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59Z`).toISOString() : null,
        }),
      })
      setNotice(`Granted ${provider} to ${activeUser?.githubLogin || selectedUser}.`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function revokeGrant(userId: string) {
    if (!window.confirm(`Revoke complimentary AI access for ${userId}?`)) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await api('/api/ai-grants/delete', {
        method: 'POST',
        body: JSON.stringify({ userId }),
      })
      setNotice(`Revoked grant for ${userId}.`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function saveUserKey() {
    if (!selectedUser || !keyProvider || !keyValue.trim()) return
    setKeySaving(true)
    setError(null)
    setNotice(null)
    try {
      await api('/api/ai-keys/userkey', {
        method: 'POST',
        body: JSON.stringify({ userId: selectedUser, provider: keyProvider, key: keyValue.trim() }),
      })
      setNotice(`Saved ${keyProvider} key for ${activeUser?.githubLogin || selectedUser}.`)
      setKeyValue('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setKeySaving(false)
    }
  }

  if (loading) return <Loading />

  return (
    <div>
      <div className="flex items-start justify-between mb-5 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">AI Grants</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            Grant selected users complimentary VibeCode builds on platform-funded provider keys.
          </p>
        </div>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search users..."
          aria-label="Search users"
          className="px-3 py-2 rounded-lg text-sm"
          style={{ border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--ink)', width: 240 }}
        />
      </div>

      {error && <ErrorBox message={error} />}
      {notice && (
        <div className="rounded-lg px-4 py-3 mb-4 text-sm" style={{ border: '1px solid rgba(47, 143, 87, 0.22)', background: 'rgba(47, 143, 87, 0.08)', color: 'var(--success)' }}>
          {notice}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--line)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--panel)', borderBottom: '1px solid var(--line)' }}>
                <th className="text-left px-4 py-3 font-semibold" style={{ color: 'var(--muted)' }}>User</th>
                <th className="text-left px-4 py-3 font-semibold hidden md:table-cell" style={{ color: 'var(--muted)' }}>Grant</th>
                <th className="text-left px-4 py-3 font-semibold hidden sm:table-cell" style={{ color: 'var(--muted)' }}>Vault Keys</th>
                <th className="text-right px-4 py-3 font-semibold" style={{ color: 'var(--muted)' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((user) => (
                <tr key={user.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td className="px-4 py-3">
                    <button onClick={() => setSelectedUser(user.id)} className="text-left">
                      <p className="font-medium" style={{ color: 'var(--ink)' }}>{user.displayName || user.githubLogin || user.id}</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{user.githubLogin ? `@${user.githubLogin} - ${user.id}` : user.id}</p>
                    </button>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    {user.grant ? (
                      <div>
                        <p className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>{user.grant.provider} / {user.grant.model}</p>
                        <p className="text-xs" style={{ color: 'var(--muted)' }}>{user.grant.expiresAt ? `expires ${new Date(user.grant.expiresAt).toLocaleDateString()}` : 'no expiry'}</p>
                      </div>
                    ) : (
                      <span className="text-xs" style={{ color: 'var(--muted)' }}>none</span>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <VaultChips user={user} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setSelectedUser(user.id)}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                        style={{ background: selectedUser === user.id ? 'var(--accent)' : 'var(--accent-soft)', color: selectedUser === user.id ? '#fff' : 'var(--accent)' }}
                      >
                        Select
                      </button>
                      {user.grant && (
                        <button
                          onClick={() => revokeGrant(user.id)}
                          disabled={saving}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                          style={{ border: '1px solid var(--line)', color: 'var(--danger)', opacity: saving ? 0.5 : 1 }}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="py-12 text-center" style={{ color: 'var(--muted)' }}>
              No users found.
            </div>
          )}
        </div>

        <aside className="rounded-xl p-4 h-fit" style={{ border: '1px solid var(--line)', background: 'var(--panel)' }}>
          <h2 className="text-base font-bold mb-3">Grant Access</h2>
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
            Funded providers: {funded.length ? funded.join(', ') : 'none configured'}
          </p>

          <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>User</label>
          <select
            value={selectedUser}
            onChange={(event) => setSelectedUser(event.target.value)}
            className="w-full px-3 py-2 rounded-lg text-sm mb-3"
            style={{ border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)' }}
          >
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.githubLogin || user.id}
              </option>
            ))}
          </select>

          <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>Provider</label>
          <select
            value={provider}
            onChange={(event) => setGrantProvider(event.target.value)}
            className="w-full px-3 py-2 rounded-lg text-sm mb-3"
            style={{ border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)' }}
          >
            {Object.keys(GRANT_MODELS).map((item) => (
              <option key={item} value={item}>
                {item}{funded.includes(item) ? '' : ' (unfunded)'}
              </option>
            ))}
          </select>

          <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>Model</label>
          <select
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className="w-full px-3 py-2 rounded-lg text-sm mb-3"
            style={{ border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)' }}
          >
            {models.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>

          <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>Expires</label>
          <input
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            type="date"
            className="w-full px-3 py-2 rounded-lg text-sm mb-3"
            style={{ border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)' }}
          />

          <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>Note</label>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="w-full px-3 py-2 rounded-lg text-sm mb-4"
            style={{ border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)' }}
          />

          <button
            onClick={grantUser}
            disabled={saving || !selectedUser || !provider || !model}
            className="w-full px-4 py-2 rounded-lg text-sm font-semibold"
            style={{ background: 'var(--accent)', color: '#fff', opacity: saving || !selectedUser || !model ? 0.55 : 1 }}
          >
            {saving ? 'Saving...' : funded.includes(provider) ? 'Save Grant' : 'Save Grant (unfunded)'}
          </button>

          <div className="mt-5 pt-4" style={{ borderTop: '1px solid var(--line)' }}>
            <h2 className="text-base font-bold mb-1">Paste API Key</h2>
            <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
              Store a provider key in <strong>{activeUser?.githubLogin || selectedUser || 'the selected user'}</strong>'s encrypted vault — their VibeCode builds pick it up automatically. This works without funding a grant.
            </p>

            <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>Provider</label>
            <select
              value={keyProvider}
              onChange={(event) => setKeyProvider(event.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm mb-3"
              style={{ border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)' }}
            >
              {KEY_PROVIDERS.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>

            <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>API key</label>
            <input
              type="password"
              value={keyValue}
              onChange={(event) => setKeyValue(event.target.value)}
              placeholder="sk-…  (stored encrypted, never shown again)"
              autoComplete="off"
              className="w-full px-3 py-2 rounded-lg text-sm mb-3"
              style={{ border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)' }}
            />

            <button
              onClick={saveUserKey}
              disabled={keySaving || !selectedUser || !keyValue.trim()}
              className="w-full px-4 py-2 rounded-lg text-sm font-semibold"
              style={{ background: 'var(--accent)', color: '#fff', opacity: keySaving || !keyValue.trim() ? 0.55 : 1 }}
            >
              {keySaving ? 'Saving...' : 'Save Key'}
            </button>
          </div>
        </aside>
      </div>
    </div>
  )
}

function VaultChips({ user }: { user: AdminUser }) {
  if (user.keys.length === 0) return <span className="text-xs" style={{ color: 'var(--muted)' }}>none</span>
  return (
    <div className="flex flex-wrap gap-2">
      {user.keys.map((key) => (
        <span key={key.provider} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          {key.provider}
        </span>
      ))}
    </div>
  )
}
