/**
 * Publish: which platforms a product must be posted on, and recording the posts.
 * Planned = what the source requires (Amazon sample → Amazon US, TikTok Shop sample → TikTok Shop)
 * + every listing that isn't "not listed" (Amazon CA/UK/DE when listed) + every post row
 * (a "bought" product's picks are planned post rows). Done when each one is posted or skipped.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { PLATFORM_ORDER, type Deal, type Listing, type Platform, type Post, type PostStatus, type Product } from './types'
import { addReminders } from './viralvue'
import { tidyReady } from './functions'

export type RowState = 'open' | 'posted' | 'skipped'

export interface PublishRow {
  platform: Platform
  state: RowState
  posts: Post[]          // every post on this platform (imported videos too)
  mine: Post | null      // the app's own row for it (no external id): the one the toggle edits
  views: number
}

export const isAmazon = (pl: Platform) => pl.startsWith('amazon')

/** Platforms the source requires even before any listing is recorded. */
export function sourcePlatforms(source: Product['source']): Platform[] {
  if (source === 'amazon_sample') return ['amazon_us']
  if (source === 'tiktok_sample') return ['tiktok_shop']
  return []
}

export function publishRows(product: Pick<Product, 'id' | 'source'>, listings: Pick<Listing, 'product_id' | 'platform' | 'availability'>[], posts: Post[]): PublishRow[] {
  const mineL = listings.filter((l) => l.product_id === product.id)
  const mineP = posts.filter((po) => po.product_id === product.id)
  const planned = new Set<Platform>(sourcePlatforms(product.source))
  for (const l of mineL) if (l.availability !== 'not_listed') planned.add(l.platform)
  for (const po of mineP) planned.add(po.platform)
  return PLATFORM_ORDER.filter((pl) => planned.has(pl)).map((pl) => {
    const on = mineP.filter((po) => po.platform === pl)
    const state: RowState = on.some((po) => po.status === 'posted') ? 'posted' : on.some((po) => po.status === 'skipped') ? 'skipped' : 'open'
    return {
      platform: pl, state, posts: on,
      mine: on.find((po) => !po.external_id) ?? null,
      views: on.reduce((n, po) => n + (po.views ?? 0), 0),
    }
  })
}

export const allFinished = (rows: PublishRow[]) => rows.length > 0 && rows.every((r) => r.state !== 'open')

/** Done when every planned platform is posted or skipped (from the database, after a change). */
export async function settleProduct(client: SupabaseClient, product: Pick<Product, 'id' | 'source' | 'status'>, reopen = false): Promise<boolean> {
  const [{ data: listings }, { data: posts }] = await Promise.all([
    client.from('listings').select('product_id,platform,availability').eq('product_id', product.id),
    client.from('posts').select('*').eq('product_id', product.id),
  ])
  const rows = publishRows(product, (listings ?? []) as Listing[], (posts ?? []) as Post[])
  if (allFinished(rows) && product.status !== 'done') {
    const { error } = await client.from('products').update({ status: 'done' }).eq('id', product.id)
    if (error) throw new Error(error.message)
    tidyReady(product.id)   // all posted: its files leave Ready to Post
    return true
  }
  // a post taken back: a Posted product with an open row is "Edited, not posted" again
  if (reopen && product.status === 'done' && rows.some((r) => r.state === 'open')) {
    await client.from('products').update({ status: 'ready' }).eq('id', product.id)
  }
  tidyReady(product.id)   // a posted platform's files leave Ready to Post, a reopened one's come back
  return false
}

const today = () => new Date().toISOString().slice(0, 10)

async function setRow(client: SupabaseClient, productId: string, platform: Platform, mine: Post | null, patch: Partial<Post> & { status: PostStatus }) {
  const row = { product_id: productId, platform, ...patch }
  const { error } = mine
    ? await client.from('posts').update(row).eq('id', mine.id)
    : await client.from('posts').insert(row)
  if (error) {
    if (patch.status === 'skipped' && /invalid input value for enum/.test(error.message)) throw new Error('Skipping a platform needs the Phase 4 database update (migration 0007).')
    throw new Error(error.message)
  }
}

export interface PostedInput { url?: string | null; date?: string | null; title?: string | null; media_id?: string | null }

/**
 * Marks platforms posted. Amazon ones also add "Tick Video published in ViralVue" for the
 * product's brand deals that ViralVue doesn't show as published yet, and "Message the brand"
 * where no message was ever sent. Returns whether the product is now Done.
 */
export async function markPosted(client: SupabaseClient, product: Pick<Product, 'id' | 'source' | 'status'>, rows: PublishRow[], input: PostedInput = {}): Promise<{ done: boolean; reminders: number }> {
  for (const r of rows) {
    await setRow(client, product.id, r.platform, r.mine, {
      status: 'posted', url: input.url || r.mine?.url || null, posted_at: input.date || r.mine?.posted_at || today(),
      title: input.title ?? r.mine?.title ?? null, ...(input.media_id ? { media_id: input.media_id } : {}),
    })
  }
  let reminders = 0
  if (rows.some((r) => isAmazon(r.platform))) {
    const { data } = await client.from('deals').select('id,published_at,message_sent_at').eq('product_id', product.id).eq('platform', 'amazon_us')
    const deals = (data ?? []) as Pick<Deal, 'id' | 'published_at' | 'message_sent_at'>[]
    const toPublish = deals.filter((d) => !d.published_at).map((d) => d.id)
    const toMessage = deals.filter((d) => !d.message_sent_at).map((d) => d.id)
    await addReminders(client, toPublish, 'published')
    await addReminders(client, toMessage, 'message')
    reminders = toPublish.length + toMessage.length
  }
  return { done: await settleProduct(client, product), reminders }
}

/** "Not posted after all": the row goes back to planned (its link and date are kept off). */
export async function unmarkPosted(client: SupabaseClient, product: Pick<Product, 'id' | 'source' | 'status'>, row: PublishRow): Promise<void> {
  if (!row.mine) throw new Error('This post came from a ViralVue export; remove it on the Product screen.')
  const { error } = await client.from('posts').update({ status: 'planned', posted_at: null, url: null }).eq('id', row.mine.id)
  if (error) throw new Error(error.message)
  await settleProduct(client, product, true)
}

export async function skipPlatform(client: SupabaseClient, product: Pick<Product, 'id' | 'source' | 'status'>, row: PublishRow): Promise<boolean> {
  await setRow(client, product.id, row.platform, row.mine, { status: 'skipped' })
  return settleProduct(client, product)
}

export async function unskipPlatform(client: SupabaseClient, product: Pick<Product, 'id' | 'source' | 'status'>, row: PublishRow): Promise<void> {
  if (row.mine) {
    const { error } = await client.from('posts').update({ status: 'planned' }).eq('id', row.mine.id)
    if (error) throw new Error(error.message)
  }
  await settleProduct(client, product, true)
}

/** Charly picks a platform (a bought product, or somewhere extra): a planned post row. */
export async function addPlatform(client: SupabaseClient, product: Pick<Product, 'id' | 'status'>, platform: Platform): Promise<void> {
  const { error } = await client.from('posts').insert({ product_id: product.id, platform, status: 'planned' })
  if (error) throw new Error(error.message)
  if (product.status === 'done') await client.from('products').update({ status: 'ready' }).eq('id', product.id)
  tidyReady(product.id)
}

/** Which finished file each platform gets by default: Amazon the horizontal review, social the vertical. */
export const defaultKind = (pl: Platform): 'finished_vertical' | 'finished_horizontal' =>
  isAmazon(pl) || pl === 'youtube' ? 'finished_horizontal' : 'finished_vertical'

export const TIKTOK_APP_URL = 'tiktok://'

/** "Amazon US, CA, UK, DE, TikTok Shop": the Amazon stores read as one. */
export function platformList(pls: Platform[], label: (pl: Platform) => string): string {
  const az = pls.filter(isAmazon).map((pl) => label(pl).replace(/^Amazon /, ''))
  const rest = pls.filter((pl) => !isAmazon(pl)).map(label)
  return [...(az.length ? [`Amazon ${az.join(', ')}`] : []), ...rest].join(', ')
}
