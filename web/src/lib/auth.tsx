import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { callFunction } from './functions'

const DRIVE_FLAG = 'pf.drive-connect'
let driveSaving = false

/**
 * After "Connect Google Drive" Google comes back with a refresh token in the
 * session (only this once). Hand it to the drive function, which keeps it
 * server-side; the phone never stores Drive credentials.
 */
async function saveDriveToken(s: Session | null): Promise<string | null> {
  let pending = false
  try { pending = localStorage.getItem(DRIVE_FLAG) === '1' } catch { /* storage blocked */ }
  if (!pending || driveSaving || !s?.provider_refresh_token) return null
  driveSaving = true
  try { localStorage.removeItem(DRIVE_FLAG) } catch { /* storage blocked */ }
  try {
    const r = await callFunction<{ email: string | null; products_folder: string | null }>('drive', {
      action: 'save_token', refresh_token: s.provider_refresh_token,
    })
    return `Google Drive is connected${r.email ? ` (${r.email})` : ''}.${r.products_folder ? '' : ' Content Library/Products was not found; it will be created on first use.'}`
  } catch (e) {
    return `Drive did not connect: ${(e as Error).message}`
  } finally {
    driveSaving = false
  }
}

interface AuthState {
  session: Session | null
  loading: boolean
  error: string | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  connectDrive: () => Promise<void>
  notice: string | null
  clearNotice: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    // Google sends errors back in the URL hash or query (e.g. an account that is not allowed).
    const params = new URLSearchParams(window.location.hash.replace(/^#/, '') || window.location.search)
    const desc = params.get('error_description')
    if (desc) {
      setError(desc.includes('Database error') ? 'This Google account is not allowed to use Product Flow.' : desc)
      window.history.replaceState({}, '', window.location.pathname)
    }
    const afterSignIn = (s: Session | null) => saveDriveToken(s).then((msg) => msg && setNotice(msg))
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
      afterSignIn(data.session)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      // supabase-js asks not to await other calls inside this callback
      window.setTimeout(() => afterSignIn(s), 0)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const signIn = async () => {
    setError(null)
    const redirectTo = new URL(import.meta.env.BASE_URL, window.location.origin).toString()
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } })
    if (error) setError(error.message)
  }

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  /** Sign in again with Drive access added; Google asks once and returns a long-lived token. */
  const connectDrive = async () => {
    setError(null)
    try { localStorage.setItem(DRIVE_FLAG, '1') } catch { /* storage blocked: the token cannot be picked up */ }
    const redirectTo = new URL(import.meta.env.BASE_URL, window.location.origin).toString()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, scopes: 'https://www.googleapis.com/auth/drive', queryParams: { access_type: 'offline', prompt: 'consent' } },
    })
    if (error) setError(error.message)
  }

  return <AuthContext.Provider value={{ session, loading, error, signIn, signOut, connectDrive, notice, clearNotice: () => setNotice(null) }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
