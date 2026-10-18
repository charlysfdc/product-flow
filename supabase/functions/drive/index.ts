// drive: Google Drive on behalf of the app, with Charly's stored token.
//   { action: 'status' }                                   connected? which account?
//   { action: 'save_token', refresh_token }                after "Connect Google Drive" in Settings
//   { action: 'create_folder', product_id }                Content Library/Products/<name> with raw + finished
//   { action: 'upload', product_id, kind, filename, mime, data(base64), width, height }
// The refresh token lives in the google_drive table (service role only).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { HttpError, serve } from '../_shared/http.ts'

const FOLDER = 'application/vnd.google-apps.folder'
const API = 'https://www.googleapis.com/drive/v3'

interface DriveRow {
  email: string | null
  refresh_token: string
  content_library_id: string | null
  products_folder_id: string | null
}

async function accessToken(refresh: string): Promise<string> {
  const id = Deno.env.get('GOOGLE_CLIENT_ID'), secret = Deno.env.get('GOOGLE_CLIENT_SECRET')
  if (!id || !secret) throw new HttpError(500, 'Drive needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the Supabase Edge Function secrets.')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }),
  })
  const j = await res.json()
  if (!res.ok || !j.access_token) {
    if (j.error === 'invalid_grant') throw new HttpError(401, 'Google Drive access has expired or was removed. In Settings, tap Connect Google Drive again.')
    throw new HttpError(502, `Google refused the Drive token (${j.error ?? res.status}).`)
  }
  return j.access_token as string
}

async function g<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = j?.error?.message ?? res.statusText
    if (res.status === 403 && /insufficient|scope/i.test(msg)) throw new HttpError(403, 'Drive was connected without folder access. In Settings, tap Connect Google Drive again and allow Drive.')
    throw new HttpError(502, `Google Drive: ${msg}`)
  }
  return j as T
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

async function findFolder(token: string, name: string, parent: string): Promise<string | null> {
  const query = `name = '${q(name)}' and mimeType = '${FOLDER}' and '${parent}' in parents and trashed = false`
  const r = await g<{ files: { id: string }[] }>(token, `${API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true`)
  return r.files[0]?.id ?? null
}

async function createFolder(token: string, name: string, parent: string): Promise<string> {
  const r = await g<{ id: string }>(token, `${API}/files?fields=id&supportsAllDrives=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
  })
  return r.id
}

async function ensureFolder(token: string, name: string, parent: string): Promise<{ id: string; created: boolean }> {
  const id = await findFolder(token, name, parent)
  return id ? { id, created: false } : { id: await createFolder(token, name, parent), created: true }
}

async function loadRow(db: SupabaseClient): Promise<DriveRow> {
  const { data, error } = await db.from('google_drive').select('email,refresh_token,content_library_id,products_folder_id').eq('id', true).maybeSingle()
  if (error) {
    if (/google_drive/.test(error.message)) throw new HttpError(500, 'The Drive table is missing: migration 0005 has not been applied yet.')
    throw new HttpError(500, error.message)
  }
  if (!data) throw new HttpError(409, 'Google Drive is not connected yet. In Settings, tap Connect Google Drive.')
  return data as DriveRow
}

/** My Drive/Content Library/Products, found once and remembered. */
async function productsFolder(db: SupabaseClient, token: string, row: DriveRow): Promise<string> {
  if (row.products_folder_id) return row.products_folder_id
  const library = row.content_library_id ?? (await ensureFolder(token, 'Content Library', 'root')).id
  const products = (await ensureFolder(token, 'Products', library)).id
  await db.from('google_drive').update({ content_library_id: library, products_folder_id: products, updated_at: new Date().toISOString() }).eq('id', true)
  return products
}

const folderName = (name: string) => name.replace(/[/\\]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120)

serve(async (body, { user, db }) => {
  switch (body.action) {
    case 'status': {
      const { data, error } = await db.from('google_drive').select('email,products_folder_id').eq('id', true).maybeSingle()
      if (error) return { connected: false, email: null, products_folder_id: null, note: 'Migration 0005 is not applied yet.' }
      return { connected: Boolean(data), email: data?.email ?? null, products_folder_id: data?.products_folder_id ?? null }
    }

    case 'save_token': {
      const refresh = String(body.refresh_token ?? '')
      if (!refresh) throw new HttpError(400, 'Google sent no refresh token. Try Connect Google Drive again.')
      const token = await accessToken(refresh)
      const about = await g<{ user?: { emailAddress?: string } }>(token, `${API}/about?fields=user(emailAddress)`)
      const row: DriveRow = { email: about.user?.emailAddress ?? user.email ?? null, refresh_token: refresh, content_library_id: null, products_folder_id: null }
      const { error } = await db.from('google_drive').upsert({ id: true, ...row, connected_by: user.id, updated_at: new Date().toISOString() })
      if (error) throw new HttpError(500, /google_drive/.test(error.message) ? 'The Drive table is missing: migration 0005 has not been applied yet.' : error.message)
      // Look for Content Library/Products now so Settings can say whether it was found.
      const library = await findFolder(token, 'Content Library', 'root')
      const products = library ? await findFolder(token, 'Products', library) : null
      if (library) await db.from('google_drive').update({ content_library_id: library, products_folder_id: products }).eq('id', true)
      return { email: row.email, products_folder: products }
    }

    case 'create_folder': {
      const { data: p, error } = await db.from('products').select('id,name,drive_folder_id').eq('id', String(body.product_id ?? '')).maybeSingle()
      if (error || !p) throw new HttpError(404, 'That product was not found.')
      const row = await loadRow(db)
      const token = await accessToken(row.refresh_token)
      const parent = await productsFolder(db, token, row)
      const name = folderName(p.name)
      const folder = p.drive_folder_id ? { id: p.drive_folder_id as string, created: false } : await ensureFolder(token, name, parent)
      await ensureFolder(token, 'raw', folder.id)
      await ensureFolder(token, 'finished', folder.id)
      if (!p.drive_folder_id) await db.from('products').update({ drive_folder_id: folder.id, drive_folder_name: name }).eq('id', p.id)
      return { folder_id: folder.id, folder_name: name, created: folder.created }
    }

    case 'upload': {
      const kind = String(body.kind ?? 'intake_photo')
      if (kind !== 'intake_photo') throw new HttpError(400, 'Only intake photos are uploaded here for now.')
      const { data: p } = await db.from('products').select('id,drive_folder_id').eq('id', String(body.product_id ?? '')).maybeSingle()
      if (!p) throw new HttpError(404, 'That product was not found.')
      if (!p.drive_folder_id) throw new HttpError(409, 'The product has no Drive folder yet.')
      const data = String(body.data ?? '')
      if (!data || data.length > 10_000_000) throw new HttpError(400, 'The photo is missing or too large.')
      const mime = String(body.mime ?? 'image/jpeg')
      const filename = String(body.filename ?? 'intake.jpg').replace(/[/\\]+/g, '-')
      const row = await loadRow(db)
      const token = await accessToken(row.refresh_token)

      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
      const boundary = `pf${crypto.randomUUID().replace(/-/g, '')}`
      const head = new TextEncoder().encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: filename, parents: [p.drive_folder_id] })}\r\n` +
        `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
      )
      const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`)
      const payload = new Uint8Array(head.length + bytes.length + tail.length)
      payload.set(head, 0)
      payload.set(bytes, head.length)
      payload.set(tail, head.length + bytes.length)
      const file = await g<{ id: string }>(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: payload,
      })
      const ins = await db.from('media').insert({
        product_id: p.id, kind: 'intake_photo', drive_file_id: file.id, filename,
        width: Number(body.width) || null, height: Number(body.height) || null, uploaded_by: user.id,
      }).select('id').single()
      if (ins.error) throw new HttpError(500, ins.error.message)
      return { media_id: ins.data.id, drive_file_id: file.id }
    }

    default:
      throw new HttpError(400, 'Unknown action.')
  }
})
