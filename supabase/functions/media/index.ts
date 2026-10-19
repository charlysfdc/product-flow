// media: plays a finished video (or shows a thumbnail) from Drive on the phone's review screen.
// GET /functions/v1/media?f=<drive file id>&e=<expiry>&m=<mime>&s=<signature>, links made by edit 'review'.
// Range requests pass through to Drive so Safari can stream and seek; the phone never holds a Drive token.
import { admin, cors } from '../_shared/http.ts'
import { driveToken, DRIVE } from '../_shared/google.ts'
import { checkSignature } from '../_shared/worker.ts'

const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'range' } })
  const u = new URL(req.url)
  const f = u.searchParams.get('f') ?? '', e = u.searchParams.get('e') ?? '', m = u.searchParams.get('m') ?? '', s = u.searchParams.get('s') ?? ''
  if (!(await checkSignature(f, e, m, s))) return new Response('This link has expired. Go back and open the review again.', { status: 403 })
  try {
    const { token } = await driveToken(admin())
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    const range = req.headers.get('range')
    if (range) headers.Range = range
    const res = await fetch(`${DRIVE}/files/${encodeURIComponent(f)}?alt=media&supportsAllDrives=true`, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers })
    if (!res.ok && res.status !== 206) {
      await res.body?.cancel()
      return new Response(`Drive answered ${res.status}.`, { status: res.status === 404 ? 404 : 502 })
    }
    const out = new Headers({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, max-age=3600', 'Accept-Ranges': 'bytes' })
    for (const h of PASS) {
      const v = res.headers.get(h)
      if (v) out.set(h, v)
    }
    if (m) out.set('content-type', m)
    return new Response(res.body, { status: res.status, headers: out })
  } catch (err) {
    console.error(err)
    return new Response((err as Error).message, { status: 502 })
  }
})
