/**
 * ViralVue's Amazon videos export ("<store>_Video_Data.csv": video_id, title, views_count,
 * upload_date, tagged_asins…, headers with a leading space) → views on the Amazon posts.
 * A video is matched to a post by its video id, else by title, else by a tagged ASIN on a
 * product's Amazon listing; a matched post remembers the video id for next time. A video of a
 * known product that has no post yet gets one (it is on Amazon, so it was posted).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseCsv } from './csv'
import { selectAll } from './deals'
import { settleProduct } from './publish'
import type { Post, Product } from './types'

export type ExportKind = 'deals' | 'videos'

/** Which ViralVue export a CSV is, from its header row. */
export function detectExport(csvText: string): ExportKind | null {
  const first = csvText.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? ''
  const cols = first.split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase())
  if (cols.includes('deal id')) return 'deals'
  if (cols.includes('video_id') && cols.includes('views_count')) return 'videos'
  return null
}

export interface VideoRow {
  video_id: string
  title: string
  views: number
  uploaded: string | null
  checked: string | null
  asins: string[]
}

export function parseVideos(csvText: string): VideoRow[] {
  return parseCsv(csvText)
    .filter((r) => r['video_id'])
    .map((r) => ({
      video_id: r['video_id'],
      title: r['title'] ?? '',
      views: Number(r['views_count']) || 0,
      uploaded: /^\d{4}-\d{2}-\d{2}/.test(r['upload_date'] ?? '') ? r['upload_date'].slice(0, 10) : null,
      checked: /^\d{4}-\d{2}-\d{2}/.test(r['last_updated'] ?? '') ? r['last_updated'].slice(0, 10) : null,
      asins: [...new Set(`${r['tagged_asins'] ?? ''}_${r['associated_asins'] ?? ''}`.split(/[_\s,;]+/).filter((a) => /^[A-Z0-9]{10}$/.test(a)))],
    }))
}

export interface ViewsSummary {
  total: number
  byId: number
  byTitle: number
  byAsin: number
  created: number
  unmatched: string[]
  views: number
  done: number
  errors: string[]
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export async function importViews(client: SupabaseClient, csvText: string, onProgress?: (msg: string) => void): Promise<ViewsSummary> {
  const say = (m: string) => onProgress?.(m)
  const videos = parseVideos(csvText)
  const s: ViewsSummary = { total: videos.length, byId: 0, byTitle: 0, byAsin: 0, created: 0, unmatched: [], views: 0, done: 0, errors: [] }
  if (!videos.length) return s

  say('Reading the Amazon posts…')
  const amazon = ['amazon_us', 'amazon_ca', 'amazon_uk', 'amazon_de', 'amazon_nl']
  const posts = await selectAll<Post>((a, b) => client.from('posts').select('*').in('platform', amazon).range(a, b))
  const listings = await selectAll<{ product_id: string; external_id: string | null }>((a, b) => client.from('listings').select('product_id,external_id').in('platform', amazon).not('external_id', 'is', null).range(a, b))
  const byVideo = new Map(posts.filter((p) => p.external_id).map((p) => [p.external_id!, p]))
  const free = posts.filter((p) => !p.external_id && p.platform === 'amazon_us')   // the app's own posts, no video id yet
  const productsByAsin = new Map<string, Set<string>>()
  for (const l of listings) {
    const k = l.external_id!.toUpperCase()
    if (!productsByAsin.has(k)) productsByAsin.set(k, new Set())
    productsByAsin.get(k)!.add(l.product_id)
  }
  const claimed = new Set<string>()
  const touched = new Set<string>()

  const updates: { id: string; patch: Partial<Post> }[] = []
  const inserts: Partial<Post>[] = []
  const checkedFallback = new Date().toISOString().slice(0, 10)

  for (const v of videos) {
    s.views += v.views
    const base = { views: v.views, views_checked_at: v.checked ?? checkedFallback }
    const hit = byVideo.get(v.video_id)
    if (hit) {
      s.byId++
      updates.push({ id: hit.id, patch: { ...base, ...(hit.title ? {} : { title: v.title || null }), ...(hit.posted_at ? {} : { posted_at: v.uploaded }) } })
      continue
    }
    const t = norm(v.title)
    let post = t ? free.find((p) => !claimed.has(p.id) && norm(p.title) === t) : undefined
    if (post) s.byTitle++
    let productId: string | null = post?.product_id ?? null
    if (!post) {
      const ids = new Set<string>()
      for (const a of v.asins) for (const id of productsByAsin.get(a) ?? []) ids.add(id)
      if (ids.size === 1) {
        productId = [...ids][0]
        post = free.find((p) => !claimed.has(p.id) && p.product_id === productId)
        if (post) s.byAsin++
      }
    }
    if (post) {
      claimed.add(post.id)
      updates.push({ id: post.id, patch: { ...base, external_id: v.video_id, status: 'posted', ...(post.title ? {} : { title: v.title || null }), ...(post.posted_at ? {} : { posted_at: v.uploaded }) } })
      if (post.status !== 'posted') touched.add(post.product_id)
    } else if (productId) {
      inserts.push({ product_id: productId, platform: 'amazon_us', status: 'posted', external_id: v.video_id, title: v.title || null, posted_at: v.uploaded, ...base })
      touched.add(productId)
    } else {
      s.unmatched.push(`${v.title || v.video_id}${v.asins.length ? ` (${v.asins.join(', ')})` : ''} · ${v.views.toLocaleString()} views`)
    }
  }

  say(`Updating ${updates.length} posts…`)
  let doneN = 0
  const pool = async (work: (() => Promise<void>)[], n = 8) => {
    let i = 0
    await Promise.all(Array.from({ length: n }, async () => {
      while (i < work.length) await work[i++]()
    }))
  }
  await pool(updates.map((u) => async () => {
    const { error } = await client.from('posts').update(u.patch).eq('id', u.id)
    if (error) s.errors.push(`${u.patch.title ?? u.id}: ${error.message}`)
    if (++doneN % 25 === 0) say(`Updated ${doneN} of ${updates.length}…`)
  }))
  if (inserts.length) {
    say(`Recording ${inserts.length} videos the app didn't know…`)
    for (let i = 0; i < inserts.length; i += 200) {
      const { error } = await client.from('posts').insert(inserts.slice(i, i + 200))
      if (error) s.errors.push(`new posts: ${error.message}`)
      else s.created += Math.min(200, inserts.length - i)
    }
  }

  // a product waiting only on its Amazon post is Done now
  if (touched.size) {
    const { data } = await client.from('products').select('id,source,status').in('id', [...touched])
    for (const p of (data ?? []) as Pick<Product, 'id' | 'source' | 'status'>[]) {
      if (p.status !== 'ready') continue
      try {
        if (await settleProduct(client, p)) s.done++
      } catch (e) {
        s.errors.push(`${p.id}: ${(e as Error).message}`)
      }
    }
  }
  say('Done.')
  return s
}
