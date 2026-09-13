import { useCallback, useEffect, useState } from 'react'
import { setApiAuthToken } from './api.ts'

const API_BASE = 'https://api.freeappstore.online'
const STORAGE_KEY = 'fas:session'

export interface AdminUser {
  id: string
  login: string
  githubLogin?: string
  avatarUrl: string | null
  roles?: string[]
}

interface Session {
  token: string
  user: AdminUser
}

function readSession(): Session | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Session
  } catch {
    return null
  }
}

function writeSession(session: Session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  setApiAuthToken(session.token)
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY)
  setApiAuthToken(null)
}

async function fetchUser(token: string): Promise<AdminUser> {
  const res = await fetch(`${API_BASE}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error('Sign-in expired.')
  const user = (await res.json()) as AdminUser
  if (!Array.isArray(user.roles) || !user.roles.includes('admin')) {
    throw new Error('This FAS account is not an admin.')
  }
  return user
}

function signInUrl(): string {
  const here = new URL(window.location.href)
  here.hash = ''
  const url = new URL('/v1/auth/github/start', API_BASE)
  url.searchParams.set('app_id', 'fas-admin')
  url.searchParams.set('return_to', here.toString())
  return url.toString()
}

export function useAdminAuth() {
  const [user, setUser] = useState<AdminUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init() {
      let session = readSession()
      if (window.location.hash.startsWith('#fas_session=')) {
        const token = decodeURIComponent(window.location.hash.slice('#fas_session='.length))
        history.replaceState(null, '', window.location.pathname + window.location.search)
        session = { token, user: await fetchUser(token) }
        writeSession(session)
      }

      if (session) {
        setApiAuthToken(session.token)
        try {
          const freshUser = await fetchUser(session.token)
          if (!cancelled) {
            writeSession({ token: session.token, user: freshUser })
            setUser(freshUser)
          }
        } catch (err) {
          clearSession()
          if (!cancelled) setError(err instanceof Error ? err.message : 'Sign-in failed.')
        }
      }

      if (!cancelled) setLoading(false)
    }

    init().catch((err) => {
      clearSession()
      if (!cancelled) {
        setError(err instanceof Error ? err.message : 'Sign-in failed.')
        setLoading(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  const signIn = useCallback(() => {
    window.location.assign(signInUrl())
  }, [])

  const signOut = useCallback(() => {
    clearSession()
    setUser(null)
    setError(null)
  }, [])

  return { user, loading, error, signIn, signOut }
}
