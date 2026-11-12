import { useState } from 'react'
import { API_URL } from './builder/lib/api'

/**
 * Account actions need a first-party (console) session (#495): the SDK sends
 * apps here (`?delete-account=1`) instead of deleting from inside the app.
 */
export function AccountSettings({ getToken, onSignedOut }: { getToken: () => string | null; onSignedOut: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const fromApp = new URLSearchParams(location.search).get('delete-account') === '1'

  const signOutEverywhere = async () => {
    // Revokes every session of this account (all apps, all devices); then drop ours.
    await fetch(`${API_URL}/v1/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken() ?? ''}` },
    }).catch(() => {})
    onSignedOut()
  }

  const deleteAccount = async () => {
    if (!confirm('Delete your account? This permanently removes ALL your data across ALL apps. This cannot be undone.')) return
    if (!confirm('Are you absolutely sure? Last chance.')) return
    setPending(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/v1/auth/me`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      })
      if (!res.ok) throw new Error(String(res.status))
      onSignedOut()
    } catch {
      setError('Unable to delete your account. Please try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-panel p-6 space-y-4">
      <h3 className="text-sm font-semibold text-muted uppercase tracking-wide">Account</h3>
      {fromApp && (
        <p className="text-sm text-muted">An app sent you here to delete your account. Account deletion happens only from the console.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={signOutEverywhere}
          className="rounded-lg border border-[var(--line-strong)] px-4 py-2 text-sm font-medium text-muted hover:text-ink"
        >
          Sign out everywhere
        </button>
        <button
          onClick={deleteAccount}
          disabled={pending}
          className="rounded-lg border border-[var(--danger)] px-4 py-2 text-sm font-medium text-[var(--danger)] disabled:opacity-50"
        >
          {pending ? 'Deleting…' : 'Delete account'}
        </button>
      </div>
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
    </div>
  )
}
