// The shared secret between the Supabase functions and the Modal worker (WORKER_SECRET), and the
// short-lived signed links the review screen plays finished videos from.

export function workerSecret(): string {
  const s = Deno.env.get('WORKER_SECRET')
  if (!s) throw new Error('WORKER_SECRET is not set in the Supabase Edge Function secrets.')
  return s
}

/** Constant-time check of "Authorization: Bearer <WORKER_SECRET>". */
export function isWorker(req: Request): boolean {
  const got = new TextEncoder().encode((req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, ''))
  const want = new TextEncoder().encode(Deno.env.get('WORKER_SECRET') ?? '')
  if (!want.length || got.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i]
  return diff === 0
}

const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function hmac(text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('media:' + workerSecret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))
}

/** A link to /functions/v1/media that plays one Drive file for `hours`, without the phone holding any token. */
export async function signedMediaUrl(fileId: string, mime: string, hours = 6): Promise<string> {
  const e = Math.floor(Date.now() / 1000) + hours * 3600
  const s = await hmac(`${fileId}.${e}.${mime}`)
  const base = Deno.env.get('SUPABASE_URL')!
  return `${base}/functions/v1/media?f=${encodeURIComponent(fileId)}&e=${e}&m=${encodeURIComponent(mime)}&s=${s}`
}

export async function checkSignature(fileId: string, e: string, mime: string, s: string): Promise<boolean> {
  if (!fileId || !e || !s || Number(e) < Date.now() / 1000) return false
  return (await hmac(`${fileId}.${e}.${mime}`)) === s
}
