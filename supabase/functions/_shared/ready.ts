// "Ready to Post": a folder in Charly's My Drive holding copies of the finished files of every product that is
// edited but not posted yet, named by product and platform. Drive for desktop keeps that one folder available
// offline on the Mac, so the files are already there when Charly uploads them (the rest of Drive is streamed and
// downloads only when opened, which made uploads slow). All of this runs in the cloud; the Mac only syncs.
//
// syncReady makes the folder match the database for one product (or every product): it copies what is missing
// and moves to the bin what is no longer needed (posted, skipped, or replaced by a newer approved edit).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { DRIVE, driveToken, ensureFolder, gd } from './google.ts'

export const READY_FOLDER = 'Ready to Post'

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>
type Want = { name: string; from?: string; text?: string }

const clean = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120)
const prefix = (p: Row) => `${clean(p.name)} - `

/** The approved edit's files, else the newest of each kind (also ones dropped into finished/ by hand). */
async function finished(db: SupabaseClient, productId: string): Promise<Record<string, Row>> {
  const { data: jobs } = await db.from('jobs').select('output,created_at').eq('product_id', productId).eq('type', 'edit')
    .in('status', ['done', 'needs_review']).order('created_at', { ascending: false }).limit(10)
  const approved = (jobs ?? []).find((j) => j.output?.verdict === 'approved')
  const ids = Object.values((approved?.output?.media ?? {}) as Record<string, string>)
  const { data: media } = await db.from('media').select('id,kind,drive_file_id,uploaded_at').eq('product_id', productId)
    .in('kind', ['finished_vertical', 'finished_horizontal', 'thumbnail']).not('drive_file_id', 'is', null)
    .order('uploaded_at', { ascending: false })
  const out: Record<string, Row> = {}
  for (const m of media ?? []) if (ids.includes(m.id)) out[m.kind] = m
  for (const m of media ?? []) out[m.kind] ??= m
  return out
}

function postText(p: Row): string | undefined {
  const c = p.post_copy
  if (!c || (!c.amazon_title && !c.tiktok_caption)) return undefined
  return [
    `${p.name}`, '',
    'AMAZON TITLE', c.amazon_title ?? '', '',
    'AMAZON DESCRIPTION', c.amazon_description ?? '', '',
    'TIKTOK CAPTION', c.tiktok_caption ?? '', '',
  ].join('\n')
}

/** What one product should have in the folder right now. */
async function wanted(db: SupabaseClient, p: Row): Promise<Want[]> {
  if (p.archived_at || p.status !== 'ready') return []
  const { data: posts } = await db.from('posts').select('platform,status').eq('product_id', p.id).in('status', ['posted', 'skipped'])
  const settled = new Set((posts ?? []).map((x) => x.platform as string))
  const amazonDone = [...settled].some((pl) => pl.startsWith('amazon'))
  const verticalDone = settled.has('tiktok_shop')
  const files = await finished(db, p.id)
  const pre = prefix(p)
  const out: Want[] = []
  if (!verticalDone && files.finished_vertical) out.push({ name: `${pre}TikTok + Reels (vertical).mp4`, from: files.finished_vertical.drive_file_id })
  if (!amazonDone && files.finished_horizontal) out.push({ name: `${pre}Amazon (horizontal).mp4`, from: files.finished_horizontal.drive_file_id })
  if (!amazonDone && files.thumbnail) out.push({ name: `${pre}Amazon thumbnail.jpg`, from: files.thumbnail.drive_file_id })
  const text = out.length ? postText(p) : undefined
  if (text) out.push({ name: `${pre}post text.txt`, text })
  return out
}

type DriveFile = { id: string; name: string; description?: string; size?: string }

async function listFolder(token: string, folder: string): Promise<DriveFile[]> {
  const all: DriveFile[] = []
  let page = ''
  do {
    const q = encodeURIComponent(`'${folder}' in parents and trashed = false`)
    const r = await gd<{ files: DriveFile[]; nextPageToken?: string }>(token,
      `${DRIVE}/files?q=${q}&fields=nextPageToken,files(id,name,description,size)&pageSize=1000${page ? `&pageToken=${page}` : ''}`)
    all.push(...r.files)
    page = r.nextPageToken ?? ''
  } while (page)
  return all
}

async function textTag(text: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return 'text:' + [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function writeText(token: string, folder: string, name: string, text: string, tag: string, existing?: DriveFile) {
  const boundary = 'pf' + crypto.randomUUID()
  const meta = existing ? { name, description: tag } : { name, parents: [folder], mimeType: 'text/plain', description: tag }
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`
  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&fields=id`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`
  await gd(token, url, { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })
}

/**
 * Makes Ready to Post match the database, for one product or (no id) every product.
 * Copies carry their source file id in the description, so a newer approved edit replaces the old copy.
 * Removed copies go to the Drive bin (recoverable for 30 days), never deleted outright.
 */
export async function syncReady(db: SupabaseClient, productId?: string): Promise<{ copied: number; removed: number; folder: string }> {
  const { token } = await driveToken(db)
  const folder = await ensureFolder(token, READY_FOLDER, 'root')
  const sel = db.from('products').select('id,name,status,archived_at,post_copy')
  const { data: products } = productId ? await sel.eq('id', productId) : await sel.in('status', ['ready', 'done', 'editing', 'filmed'])
  const present = await listFolder(token, folder)
  let copied = 0, removed = 0
  for (const p of products ?? []) {
    const want = await wanted(db, p)
    const pre = prefix(p)
    const mine = present.filter((f) => f.name.startsWith(pre))
    for (const w of want) {
      const have = mine.find((f) => f.name === w.name)
      if (w.from) {
        const tag = `source:${w.from}`
        if (have?.description === tag) continue
        if (have) { await gd(token, `${DRIVE}/files/${have.id}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); removed++ }
        await gd(token, `${DRIVE}/files/${encodeURIComponent(w.from)}/copy?fields=id&supportsAllDrives=true`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: w.name, parents: [folder], description: tag }),
        })
        copied++
      } else if (w.text !== undefined) {
        const tag = await textTag(w.text)
        if (have?.description !== tag) await writeText(token, folder, w.name, w.text, tag, have)
      }
    }
    for (const f of mine) {
      // another product whose name starts the same way ("Shoe Shine Kit" vs "Shoe Shine Kit Deluxe") keeps its files
      const ours = /^(TikTok \+ Reels \(vertical\)\.mp4|Amazon \(horizontal\)\.mp4|Amazon thumbnail\.jpg|post text\.txt)$/.test(f.name.slice(pre.length))
      if (!ours || want.some((w) => w.name === f.name)) continue
      await gd(token, `${DRIVE}/files/${f.id}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) })
      removed++
    }
  }
  return { copied, removed, folder }
}
