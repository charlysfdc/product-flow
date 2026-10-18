// Shared by the edge functions: CORS, JSON replies, and the sign-in check.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2.118.0'

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

/** Service-role client: bypasses RLS, so every handler checks the caller first. */
export function admin(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')
  if (!key) throw new HttpError(500, 'The function has no service key.')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

/** The signed-in caller, who must be on allowed_emails (Charly, Zanje). */
export async function requireAllowed(req: Request, db: SupabaseClient): Promise<User> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) throw new HttpError(401, 'Sign in first.')
  const { data, error } = await db.auth.getUser(token)
  if (error || !data.user) throw new HttpError(401, 'Your sign-in has expired. Sign in again.')
  const email = (data.user.email ?? '').toLowerCase()
  const { data: row } = await db.from('allowed_emails').select('email').ilike('email', email).maybeSingle()
  if (!row) throw new HttpError(403, 'This account is not allowed to use Product Flow.')
  return data.user
}

/** Wraps a handler with CORS preflight, the sign-in check and error replies. */
export function serve(handler: (body: Record<string, unknown>, ctx: { user: User; db: SupabaseClient }) => Promise<unknown>) {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
    try {
      const db = admin()
      const user = await requireAllowed(req, db)
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      return json(await handler(body, { user, db }))
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      console.error(e)
      return json({ error: (e as Error).message }, status)
    }
  })
}
