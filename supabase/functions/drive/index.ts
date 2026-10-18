// drive: Google Drive on behalf of the app, with Charly's stored token.
//   { action: 'status' }                                   connected? which account?
//   { action: 'save_token', refresh_token }                after "Connect Google Drive" in Settings
//   { action: 'create_folder', product_id }                Content Library/Products/<name> with raw + finished
//   { action: 'upload', product_id, kind, filename, mime, data(base64), width, height }
//   { action: 'start_upload', product_id, filename, mime, size, origin }   opens a resumable session in <product>/raw
//   { action: 'upload_status', upload_url, size }                          how many bytes Drive has (for resuming)
//   { action: 'finish_upload', product_id, drive_file_id, ... }            checks the file in Drive, records the clip
//   { action: 'sync', product_id }                                         records files found in raw/ and finished/
// The phone uploads clip bytes straight to Drive with the session URL; it never sees the token.
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

const NOT_FOUND = "Couldn't find your Content Library. In Settings, tap Pick the Products folder."

interface DriveFile { id: string; name: string; parents?: string[]; mimeType?: string; trashed?: boolean }

const getFile = (token: string, id: string) =>
  g<DriveFile>(token, `${API}/files/${encodeURIComponent(id)}?fields=id,name,parents,mimeType,trashed&supportsAllDrives=true`)

/**
 * Where Content Library/Products is, without ever creating one: the folder that
 * holds the existing product folders (their drive_folder_id parents) wins; a name
 * search is only a fallback, and only when it finds exactly one candidate.
 */
async function locateLibrary(db: SupabaseClient, token: string): Promise<{ library: string | null; products: string } | null> {
  // 1. parents of known product folders, by majority
  const { data: known } = await db.from('products').select('drive_folder_id').not('drive_folder_id', 'is', null).limit(12)
  const votes = new Map<string, number>()
  for (const r of known ?? []) {
    try {
      const f = await getFile(token, r.drive_folder_id as string)
      if (f.trashed) continue
      for (const parent of f.parents ?? []) votes.set(parent, (votes.get(parent) ?? 0) + 1)
    } catch { /* deleted or not shared with this account: skip */ }
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]
  if (best) {
    const products = await getFile(token, best[0])
    return { products: products.id, library: products.parents?.[0] ?? null }
  }
  // 2. name search: every "Content Library" folder that has a "Products" child
  const query = `name = 'Content Library' and mimeType = '${FOLDER}' and trashed = false`
  const libs = await g<{ files: DriveFile[] }>(token, `${API}/files?q=${encodeURIComponent(query)}&fields=files(id,name,parents)&pageSize=20&supportsAllDrives=true&includeItemsFromAllDrives=true`)
  const candidates: { library: string; products: string }[] = []
  for (const lib of libs.files) {
    const products = await findFolder(token, 'Products', lib.id)
    if (products) candidates.push({ library: lib.id, products })
  }
  return candidates.length === 1 ? candidates[0] : null
}

/** The stored Products folder; found from the product folders when not stored yet. Never created. */
async function productsFolder(db: SupabaseClient, token: string, row: DriveRow): Promise<string> {
  if (row.products_folder_id) return row.products_folder_id
  const found = await locateLibrary(db, token)
  if (!found) throw new HttpError(409, NOT_FOUND)
  await db.from('google_drive').update({ content_library_id: found.library, products_folder_id: found.products, updated_at: new Date().toISOString() }).eq('id', true)
  return found.products
}

/** The product's folder (made under Products when it has none yet) and its raw subfolder. */
async function productFolders(db: SupabaseClient, token: string, row: DriveRow, p: { id: string; name: string; drive_folder_id: string | null }) {
  let folderId = p.drive_folder_id
  if (!folderId) {
    const parent = await productsFolder(db, token, row)
    const name = folderName(p.name)
    folderId = (await ensureFolder(token, name, parent)).id
    await ensureFolder(token, 'finished', folderId)
    await db.from('products').update({ drive_folder_id: folderId, drive_folder_name: name }).eq('id', p.id)
  }
  const raw = await ensureFolder(token, 'raw', folderId)
  return { folderId, rawId: raw.id }
}

async function loadProduct(db: SupabaseClient, id: unknown) {
  const { data: p, error } = await db.from('products').select('id,name,status,received_at,drive_folder_id').eq('id', String(id ?? '')).maybeSingle()
  if (error || !p) throw new HttpError(404, 'That product was not found.')
  return p as { id: string; name: string; status: string; received_at: string | null; drive_folder_id: string | null }
}

// Browser origins allowed to PUT clip bytes to an upload session (Google answers CORS for this origin only).
const ORIGINS = ['https://charlysfdc.github.io', 'http://localhost:5173', 'http://127.0.0.1:5173']

const UPLOAD_PREFIX = 'https://www.googleapis.com/upload/drive/v3/files'
const FILE_FIELDS = 'id,name,size,mimeType,parents,trashed,createdTime,videoMediaMetadata'

interface DriveMediaFile extends DriveFile {
  size?: string
  createdTime?: string
  videoMediaMetadata?: { width?: number; height?: number; durationMillis?: string }
}

/** First clip in: Not filmed (or On its way) becomes Filmed, not edited. Never moves a product back. */
async function markFilmed(db: SupabaseClient, p: { id: string; status: string; received_at: string | null }): Promise<boolean> {
  if (p.status !== 'received' && p.status !== 'expected') return false
  const patch: Record<string, unknown> = { status: 'filmed' }
  if (!p.received_at) patch.received_at = new Date().toISOString().slice(0, 10)
  const { data } = await db.from('products').update(patch).eq('id', p.id).in('status', ['received', 'expected']).select('id')
  return Boolean(data?.length)
}

/** Insert a media row, or fill the gaps of the one already recorded for this Drive file. */
async function recordMedia(db: SupabaseClient, row: Record<string, unknown>): Promise<{ id: string; added: boolean }> {
  const { data: have } = await db.from('media').select('id').eq('drive_file_id', row.drive_file_id as string).maybeSingle()
  const clean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined))
  const attempt = async (r: Record<string, unknown>) => have
    ? await db.from('media').update(r).eq('id', have.id).select('id').single()
    : await db.from('media').insert(r).select('id').single()
  let res = await attempt(clean)
  // migration 0006 (size_bytes, codec) may not be applied yet: save without those columns
  if (res.error && /size_bytes|codec/.test(res.error.message)) {
    const { size_bytes: _s, codec: _c, ...rest } = clean
    res = await attempt(rest)
  }
  if (res.error) throw new HttpError(500, res.error.message)
  return { id: res.data.id as string, added: !have }
}

async function listFiles(token: string, folderId: string): Promise<DriveMediaFile[]> {
  const out: DriveMediaFile[] = []
  let page: string | undefined
  do {
    const query = `'${q(folderId)}' in parents and trashed = false and mimeType != '${FOLDER}'`
    const r = await g<{ files: DriveMediaFile[]; nextPageToken?: string }>(token,
      `${API}/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(${FILE_FIELDS})&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${page ? `&pageToken=${page}` : ''}`)
    out.push(...r.files)
    page = r.nextPageToken
  } while (page)
  return out
}

const isVideo = (f: DriveMediaFile) => (f.mimeType ?? '').startsWith('video/') || /\.(mov|mp4|m4v|hevc)$/i.test(f.name)
const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

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
      // Find Content Library/Products now so Settings can say whether it was found.
      const found = await locateLibrary(db, token)
      if (found) await db.from('google_drive').update({ content_library_id: found.library, products_folder_id: found.products }).eq('id', true)
      return { email: row.email, products_folder: found?.products ?? null }
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

    case 'start_upload': {
      const p = await loadProduct(db, body.product_id)
      const size = Number(body.size)
      if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, 'The file is empty.')
      const origin = String(body.origin ?? '')
      if (!ORIGINS.includes(origin)) throw new HttpError(400, `Uploads are only allowed from the app (${origin || 'no origin'}).`)
      const filename = String(body.filename ?? 'clip.mov').replace(/[/\\]+/g, '-').slice(0, 200)
      const mime = String(body.mime || 'video/quicktime')
      const row = await loadRow(db)
      const token = await accessToken(row.refresh_token)
      const { folderId, rawId } = await productFolders(db, token, row, p)
      const res = await fetch(`${UPLOAD_PREFIX}?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mime,
          'X-Upload-Content-Length': String(size),
          // Google sends CORS headers for this origin on the session URL, so the phone can PUT to it.
          Origin: origin,
        },
        body: JSON.stringify({ name: filename, parents: [rawId] }),
      })
      const url = res.headers.get('Location')
      if (!res.ok || !url) {
        const j = await res.json().catch(() => ({}))
        throw new HttpError(502, `Google Drive would not start the upload: ${j?.error?.message ?? res.status}`)
      }
      return { upload_url: url, folder_id: folderId, raw_folder_id: rawId }
    }

    case 'upload_status': {
      // Asked when the phone cannot read the Range header itself: how much of the file Drive already has.
      const url = String(body.upload_url ?? '')
      if (!url.startsWith(UPLOAD_PREFIX)) throw new HttpError(400, 'Not a Drive upload session.')
      const size = Number(body.size)
      const res = await fetch(url, { method: 'PUT', redirect: 'manual', headers: { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' } })
      if (res.status === 308) {
        const range = res.headers.get('Range')
        await res.body?.cancel()
        return { received: range ? Number(range.split('-')[1]) + 1 : 0 }
      }
      if (res.ok) return { received: size, file: await res.json() }
      await res.body?.cancel()
      if (res.status === 404 || res.status === 410) return { expired: true }
      throw new HttpError(502, `Google Drive upload status: ${res.status}`)
    }

    case 'finish_upload': {
      const p = await loadProduct(db, body.product_id)
      const fileId = String(body.drive_file_id ?? '')
      const row = await loadRow(db)
      const token = await accessToken(row.refresh_token)
      const f = await g<DriveMediaFile>(token, `${API}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}&supportsAllDrives=true`)
      const expected = num(body.size)
      if (expected !== null && Number(f.size) !== expected) {
        throw new HttpError(409, `Drive has ${Number(f.size).toLocaleString()} bytes of ${f.name} but the phone sent ${expected.toLocaleString()}. Upload it again.`)
      }
      const media = await recordMedia(db, {
        product_id: p.id, kind: 'raw_clip', drive_file_id: f.id, filename: f.name,
        duration_s: num(body.duration_s), width: num(body.width), height: num(body.height),
        shot_on: body.shot_on ? String(body.shot_on).slice(0, 60) : null, codec: body.codec ? String(body.codec).slice(0, 20) : null,
        size_bytes: num(f.size), uploaded_by: user.id,
      })
      const filmed = await markFilmed(db, p)
      return { media_id: media.id, size: Number(f.size), status_changed: filmed }
    }

    case 'sync': {
      // Fallback for clips dropped into raw/ (or finished/) with the Google Drive app or the Mac.
      const p = await loadProduct(db, body.product_id)
      if (!p.drive_folder_id) return { added: 0, raw: 0, finished: 0, status_changed: false, note: 'No Drive folder yet.' }
      const row = await loadRow(db)
      const token = await accessToken(row.refresh_token)
      const rawId = await findFolder(token, 'raw', p.drive_folder_id)
      const finishedId = await findFolder(token, 'finished', p.drive_folder_id)
      const raw = rawId ? (await listFiles(token, rawId)).filter(isVideo) : []
      const finished = finishedId ? (await listFiles(token, finishedId)).filter(isVideo) : []
      const { data: known } = await db.from('media').select('drive_file_id,duration_s,width,height').eq('product_id', p.id).not('drive_file_id', 'is', null)
      const have = new Map((known ?? []).map((m) => [m.drive_file_id as string, m]))
      let added = 0
      const meta = (f: DriveMediaFile) => {
        const v = f.videoMediaMetadata
        return { width: num(v?.width), height: num(v?.height), duration_s: v?.durationMillis ? Math.round(Number(v.durationMillis) / 100) / 10 : null }
      }
      const groups = [
        { files: raw, kind: () => 'raw_clip' },
        // finished: landscape by Drive's video size, else vertical (most of these are)
        { files: finished, kind: (f: DriveMediaFile) => { const { width, height } = meta(f); return width && height && width > height ? 'finished_horizontal' : 'finished_vertical' } },
      ]
      for (const { files, kind } of groups) {
        for (const f of files) {
          const m = meta(f)
          const old = have.get(f.id)
          if (old) {
            // fill duration/size Drive worked out after the upload; never overwrite what the phone measured
            if (old.duration_s == null && m.duration_s != null) await recordMedia(db, { drive_file_id: f.id, product_id: p.id, ...m, size_bytes: num(f.size) })
            continue
          }
          await recordMedia(db, {
            product_id: p.id, kind: kind(f), drive_file_id: f.id, filename: f.name, ...m,
            size_bytes: num(f.size), uploaded_at: f.createdTime ?? undefined,
          })
          added++
        }
      }
      const filmed = raw.length > 0 ? await markFilmed(db, p) : false
      return { added, raw: raw.length, finished: finished.length, status_changed: filmed }
    }

    case 'list_folders': {
      // For the "Pick the Products folder" browser in Settings: subfolders of a folder (My Drive when none).
      const row = await loadRow(db)
      const token = await accessToken(row.refresh_token)
      const parent = String(body.parent ?? 'root')
      const query = `'${q(parent)}' in parents and mimeType = '${FOLDER}' and trashed = false`
      const r = await g<{ files: DriveFile[] }>(token, `${API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&orderBy=name&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`)
      const here = parent === 'root' ? { id: 'root', name: 'My Drive', parents: [] } : await getFile(token, parent)
      return { folder: { id: here.id, name: here.name, parent: here.parents?.[0] ?? null }, folders: r.files.map((f) => ({ id: f.id, name: f.name })) }
    }

    case 'set_products_folder': {
      const row = await loadRow(db)
      const token = await accessToken(row.refresh_token)
      const f = await getFile(token, String(body.folder_id ?? ''))
      if (f.mimeType !== FOLDER || f.trashed) throw new HttpError(400, 'That is not a folder.')
      await db.from('google_drive').update({ products_folder_id: f.id, content_library_id: f.parents?.[0] ?? null, updated_at: new Date().toISOString() }).eq('id', true)
      return { products_folder_id: f.id, name: f.name }
    }

    default:
      throw new HttpError(400, 'Unknown action.')
  }
})
