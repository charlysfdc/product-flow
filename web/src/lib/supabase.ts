import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabaseConfigured = Boolean(url && anonKey)

// Dev only: /?demo=1 serves sample rows (lib/demo.ts) so screens can be checked without signing in.
function demoMode(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    const flag = new URLSearchParams(window.location.search).get('demo')
    if (flag !== null) localStorage.setItem('pf.demo', flag)
    return localStorage.getItem('pf.demo') === '1'
  } catch {
    return false
  }
}
const demo = demoMode()
// a dynamic import behind the DEV check keeps the sample data out of the production bundle
const demoMod = import.meta.env.DEV && demo ? await import('./demo') : null
demoMod?.seedDemoSession('pf-demo-auth')

export const supabase = createClient(url ?? 'https://not-configured.supabase.co', anonKey ?? 'missing', {
  auth: demo
    ? { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'pf-demo-auth' }
    : { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  ...(demoMod ? { global: { fetch: demoMod.demoFetch }, realtime: { params: { eventsPerSecond: 0 } } } : {}),
})
