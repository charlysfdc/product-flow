// Google Drive with Charly's stored refresh token (table google_drive, service role only).
// Used by worker, edit and media; the drive function keeps its own copy of the same calls.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { HttpError } from './http.ts'

export const DRIVE = 'https://www.googleapis.com/drive/v3'
export const FOLDER = 'application/vnd.google-apps.folder'

let cached: { token: string; until: number } | null = null

/** A Drive access token (about an hour), reused while this function instance lives. */
export async function driveToken(db: SupabaseClient): Promise<{ token: string; expires_in: number }> {
  if (cached && cached.until - Date.now() > 5 * 60_000) return { token: cached.token, expires_in: Math.round((cached.until - Date.now()) / 1000) }
  const { data, error } = await db.from('google_drive').select('refresh_token').eq('id', true).maybeSingle()
  if (error) throw new HttpError(500, error.message)
  if (!data) throw new HttpError(409, 'Google Drive is not connected yet. In Settings, tap Connect Google Drive.')
  const id = Deno.env.get('GOOGLE_CLIENT_ID'), secret = Deno.env.get('GOOGLE_CLIENT_SECRET')
  if (!id || !secret) throw new HttpError(500, 'Drive needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the Supabase Edge Function secrets.')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: data.refresh_token, grant_type: 'refresh_token' }),
  })
  const j = await res.json()
  if (!res.ok || !j.access_token) {
    if (j.error === 'invalid_grant') throw new HttpError(401, 'Google Drive access has expired or was removed. In Settings, tap Connect Google Drive again.')
    throw new HttpError(502, `Google refused the Drive token (${j.error ?? res.status}).`)
  }
  cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 }
  return { token: j.access_token, expires_in: Number(j.expires_in) || 3600 }
}

export async function gd<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new HttpError(502, `Google Drive: ${j?.error?.message ?? res.statusText}`)
  return j as T
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/** A subfolder by name, made when missing. */
export async function ensureFolder(token: string, name: string, parent: string): Promise<string> {
  const query = `name = '${q(name)}' and mimeType = '${FOLDER}' and '${q(parent)}' in parents and trashed = false`
  const r = await gd<{ files: { id: string }[] }>(token, `${DRIVE}/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true`)
  if (r.files[0]) return r.files[0].id
  const made = await gd<{ id: string }>(token, `${DRIVE}/files?fields=id&supportsAllDrives=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
  })
  return made.id
}

/** Moves a file from one folder to another (nothing is deleted). */
export async function moveFile(token: string, fileId: string, to: string): Promise<void> {
  const f = await gd<{ parents?: string[] }>(token, `${DRIVE}/files/${encodeURIComponent(fileId)}?fields=parents&supportsAllDrives=true`)
  const remove = (f.parents ?? []).join(',')
  await gd(token, `${DRIVE}/files/${encodeURIComponent(fileId)}?addParents=${encodeURIComponent(to)}&removeParents=${encodeURIComponent(remove)}&supportsAllDrives=true&fields=id`, { method: 'PATCH' })
}
