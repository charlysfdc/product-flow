import { supabase } from './supabase'
import { STATUS_ORDER, type Listing, type Product } from './types'

/**
 * Merge `source` into `target`: move listings, media, posts, jobs and deals
 * across, fill the target's empty fields from the source, keep both Drive
 * folders, keep the chosen name, then delete the source. Runs as a sequence
 * of small writes (two users, no races).
 */
export async function mergeProducts(source: Product, target: Product, keepName: string): Promise<void> {
  const fail = (step: string, e: { message: string } | null) => {
    if (e) throw new Error(`${step}: ${e.message}`)
  }

  // listings: skip ones the target already has (same platform + id)
  const { data: tl, error: e1 } = await supabase.from('listings').select('platform,external_id').eq('product_id', target.id)
  fail('read target listings', e1)
  const { data: sl, error: e2 } = await supabase.from('listings').select('id,platform,external_id').eq('product_id', source.id)
  fail('read source listings', e2)
  const have = new Set((tl ?? []).map((l) => `${l.platform}|${l.external_id ?? ''}`))
  for (const l of (sl ?? []) as Pick<Listing, 'id' | 'platform' | 'external_id'>[]) {
    if (have.has(`${l.platform}|${l.external_id ?? ''}`)) {
      fail('drop duplicate listing', (await supabase.from('listings').delete().eq('id', l.id)).error)
    } else {
      fail('move listing', (await supabase.from('listings').update({ product_id: target.id }).eq('id', l.id)).error)
    }
  }

  for (const table of ['media', 'posts', 'jobs', 'deals'] as const) {
    fail(`move ${table}`, (await supabase.from(table).update({ product_id: target.id }).eq('product_id', source.id)).error)
  }

  const pick = <K extends keyof Product>(k: K) => target[k] ?? source[k]
  const status = STATUS_ORDER.indexOf(source.status) > STATUS_ORDER.indexOf(target.status) ? source.status : target.status
  let notes = [target.notes, source.notes && `Merged from "${source.name}":\n${source.notes}`].filter(Boolean).join('\n\n') || null

  // both have a Drive folder: keep the source's as an extra link
  const extras = [...(target.extra_drive_folders ?? []), ...(source.extra_drive_folders ?? [])]
  if (target.drive_folder_id && source.drive_folder_id && source.drive_folder_id !== target.drive_folder_id) {
    extras.push({ id: source.drive_folder_id, name: source.drive_folder_name })
  }

  // delete the source first so the kept name cannot collide with it
  fail('delete duplicate', (await supabase.from('products').delete().eq('id', source.id)).error)

  const patch = {
    name: keepName,
    brand: pick('brand'),
    variant: pick('variant'),
    upc: pick('upc'),
    deadline: pick('deadline'),
    received_at: pick('received_at'),
    drive_folder_id: pick('drive_folder_id'),
    drive_folder_name: pick('drive_folder_name'),
    product_image_url: pick('product_image_url'),
    source: target.source === 'unknown' ? source.source : target.source,
    status,
    notes,
  }
  let res = await supabase.from('products').update({ ...patch, extra_drive_folders: extras }).eq('id', target.id)
  if (res.error?.code === 'PGRST204') {
    // migration 0004 not applied yet: keep the extra folder as a note instead
    if (extras.length) {
      notes = [notes, ...extras.map((f) => `Also in Drive folder: ${f.name ?? f.id} (https://drive.google.com/drive/folders/${f.id})`)].filter(Boolean).join('\n')
    }
    res = await supabase.from('products').update({ ...patch, notes }).eq('id', target.id)
  }
  fail('update kept product', res.error)
}
