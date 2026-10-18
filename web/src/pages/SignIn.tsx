import { useAuth } from '../lib/auth'
import { supabaseConfigured } from '../lib/supabase'

export function SignIn() {
  const { signIn, error } = useAuth()
  return (
    <main className="signin">
      <img src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" width={96} height={96} className="logo" />
      <h1>Product Flow</h1>
      <p className="muted">Products from the box to posted.</p>
      {!supabaseConfigured && (
        <p className="error">The app is not connected to Supabase yet (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).</p>
      )}
      {error && <p className="error">{error}</p>}
      <button className="primary" onClick={signIn} disabled={!supabaseConfigured}>
        Sign in with Google
      </button>
    </main>
  )
}
