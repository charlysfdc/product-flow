/**
 * ViralVue brand-deal import. Shared by the Settings button (browser, user
 * session) and scripts/import-deals.ts (Node, secret key): same code, same rules.
 *
 * Rules: upsert deals by (platform, external_id); never duplicate; fill only
 * empty product fields; never overwrite what was set by hand. A deal whose
 * product never arrived stays a deal row only ("waiting"), with no product.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseCsv } from './csv'
import type { Deal, Product, ProductStatus } from './types'

export interface DealInput {
  platform: 'amazon_us'
  external_id: string
  brand: string | null
  asin: string | null
  title: string | null
  price: number | null
  fee: number | null
  image_url: string | null
  message_sent_at: string | null
  received_at: string | null
  video_created_at: string | null
  published_at: string | null
  deal_created_at: string | null
  deal_updated_at: string | null
  status_raw: string | null
}

export interface ImportSummary {
  total: number
  created: number
  updated: number
  matched: number
  needsReview: number
  waiting: number
  postsCreated: number
  errors: string[]
}

const epoch = (v: string | undefined): string | null => {
  const n = Number(v)
  return v && Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null
}
const money = (v: string | undefined): number | null => {
  if (!v) return null
  const n = Number(v.replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : null
}
const yes = (v: string | undefined) => (v ?? '').trim().toLowerCase() === 'yes'

/** Amazon thumbnail URLs carry a size suffix (._AC_US40_, ._SX38_SY50_CR,0,0,38,50_); drop it for the full image. */
export function fullSizeImage(url: string | null | undefined): string | null {
  if (!url) return null
  return url.replace(/\._[^./]*_\.(jpe?g|png|gif|webp)$/i, '.$1')
}

export function parseViralVueDeals(csvText: string): DealInput[] {
  return parseCsv(csvText)
    .filter((r) => r['Deal ID'])
    .map((r) => ({
      platform: 'amazon_us',
      external_id: r['Deal ID'],
      brand: r['Brand'] || null,
      asin: r['ASIN'] || r['Product ID'] || null,
      title: r['Product Title'] || null,
      price: money(r['Product Price']),
      fee: money(r['Fee']),
      image_url: fullSizeImage(r['Product Image']),
      message_sent_at: yes(r['Message Sent']) ? epoch(r['Message Sent At']) : null,
      received_at: yes(r['Product Received']) ? epoch(r['Product Received At']) : null,
      video_created_at: yes(r['Video Created']) ? epoch(r['Video Created At']) : null,
      published_at: yes(r['Video Published']) ? epoch(r['Video Published At']) : null,
      deal_created_at: epoch(r['Created At']),
      deal_updated_at: epoch(r['Last Updated At']),
      status_raw: r['Status'] || null,
    }))
}

const day = (ts: string | null) => (ts ? ts.slice(0, 10) : null)

function throwIf(step: string, error: { message: string } | null): void {
  if (error) throw new Error(`${step}: ${error.message}`)
}

/** Link a deal to a product: fill the product's empty fields, make sure the ASIN listing and (if published) an Amazon post exist. */
export async function linkDealToProduct(client: SupabaseClient, deal: Deal, product: Product): Promise<{ postCreated: boolean }> {
  const patch: Partial<Product> = {}
  if (product.source === 'unknown') patch.source = 'amazon_sample'
  if (!product.brand && deal.brand) patch.brand = deal.brand
  if (!product.received_at && deal.received_at) patch.received_at = day(deal.received_at)
  if (!product.product_image_url && deal.image_url) patch.product_image_url = deal.image_url
  if (Object.keys(patch).length) throwIf('update product', (await client.from('products').update(patch).eq('id', product.id)).error)

  if (deal.asin) {
    const { data: l, error } = await client.from('listings').select('id').eq('product_id', product.id).eq('platform', 'amazon_us').eq('external_id', deal.asin).limit(1)
    throwIf('read listing', error)
    if (!l?.length) {
      throwIf('add listing', (await client.from('listings').insert({
        product_id: product.id, platform: 'amazon_us', external_id: deal.asin,
        url: `https://www.amazon.com/dp/${deal.asin}`, availability: 'exact', checked_at: day(deal.deal_updated_at),
      })).error)
    }
  }

  let postCreated = false
  if (deal.published_at) {
    const { data: posts, error } = await client.from('posts').select('id').eq('product_id', product.id).eq('platform', 'amazon_us').eq('status', 'posted').limit(1)
    throwIf('read posts', error)
    if (!posts?.length) {
      throwIf('add post', (await client.from('posts').insert({
        product_id: product.id, platform: 'amazon_us', status: 'posted', posted_at: day(deal.published_at),
      })).error)
      postCreated = true
    }
  }

  throwIf('link deal', (await client.from('deals').update({ product_id: product.id, match_status: 'matched' }).eq('id', deal.id)).error)
  return { postCreated }
}

function nameFromTitle(title: string | null, asin: string | null): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return asin ? `Amazon ${asin}` : 'Unnamed product'
  if (t.length <= 70) return t
  const cut = t.slice(0, 70)
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).replace(/[,;:(\-\s]+$/, '')
}

function statusFromDeal(d: Pick<Deal, 'received_at' | 'video_created_at' | 'published_at'>): ProductStatus {
  if (d.published_at) return 'done'
  if (d.video_created_at) return 'ready'
  return 'received'
}

/**
 * Something arrived for this deal: create its product (source Amazon sample,
 * brand, ASIN listing, full image), stamp received_at and link the deal.
 * Used by the deal screen's "It arrived" and, later, by Add product.
 */
export async function receiveDeal(client: SupabaseClient, deal: Deal, overrides: Partial<Pick<Product, 'name' | 'status'>> = {}): Promise<Product> {
  const received = deal.received_at ?? new Date().toISOString()
  if (!deal.received_at) {
    throwIf('stamp received', (await client.from('deals').update({ received_at: received }).eq('id', deal.id)).error)
    deal = { ...deal, received_at: received }
  }
  const base = overrides.name ?? nameFromTitle(deal.title, deal.asin)
  const row = {
    name: base,
    brand: deal.brand,
    source: 'amazon_sample',
    status: overrides.status ?? statusFromDeal(deal),
    received_at: day(received),
    product_image_url: deal.image_url,
    notes: `From the ViralVue brand deal${deal.title ? `: ${deal.title}` : ''}`,
  }
  let res = await client.from('products').insert(row).select('*').single()
  if (res.error?.code === '23505') res = await client.from('products').insert({ ...row, name: `${base} (${deal.asin ?? deal.external_id.slice(0, 8)})` }).select('*').single()
  throwIf('create product', res.error)
  const product = res.data as Product
  await linkDealToProduct(client, deal, product)
  return product
}

/** Create a product for a received deal that matched nothing (the review screen's "Create new product"). */
export const createProductFromDeal = receiveDeal

/**
 * Deals still waiting on the brand that might be the box in your hand:
 * exact ASIN first, then brand plus words from the title.
 */
export async function findWaitingDeals(client: SupabaseClient, hint: { asin?: string | null; brand?: string | null; title?: string | null }): Promise<Deal[]> {
  const { data, error } = await client.from('deals').select('*').eq('match_status', 'waiting').is('product_id', null)
  throwIf('read waiting deals', error)
  const deals = (data ?? []) as Deal[]
  if (hint.asin) {
    const exact = deals.filter((d) => d.asin && d.asin.toUpperCase() === hint.asin!.toUpperCase())
    if (exact.length) return exact
  }
  const words = (hint.title ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3)
  const brand = (hint.brand ?? '').toLowerCase()
  return deals
    .map((d) => {
      const text = `${d.brand ?? ''} ${d.title ?? ''}`.toLowerCase()
      let score = brand && (d.brand ?? '').toLowerCase().includes(brand) ? 3 : 0
      for (const w of words) if (text.includes(w)) score++
      return { d, score }
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.d)
}

export async function ignoreDeal(client: SupabaseClient, deal: Deal): Promise<void> {
  throwIf('ignore deal', (await client.from('deals').update({ match_status: 'ignored', product_id: null }).eq('id', deal.id)).error)
}

/** Import a ViralVue CSV export. Safe to run again with a newer export. */
export async function importDeals(client: SupabaseClient, csvText: string): Promise<ImportSummary> {
  const inputs = parseViralVueDeals(csvText)
  const summary: ImportSummary = { total: inputs.length, created: 0, updated: 0, matched: 0, needsReview: 0, waiting: 0, postsCreated: 0, errors: [] }
  if (!inputs.length) return summary

  const { data: existing, error: e1 } = await client.from('deals').select('external_id').eq('platform', 'amazon_us')
  throwIf('read deals', e1)
  const known = new Set((existing ?? []).map((d) => d.external_id as string))

  const { data: listings, error: e2 } = await client.from('listings').select('product_id,external_id').eq('platform', 'amazon_us')
  throwIf('read listings', e2)
  const byAsin = new Map<string, string>()
  for (const l of listings ?? []) if (l.external_id && !byAsin.has(l.external_id)) byAsin.set(l.external_id, l.product_id)

  for (const input of inputs) {
    try {
      const wasKnown = known.has(input.external_id)
      const { data: deal, error } = await client
        .from('deals')
        .upsert(input, { onConflict: 'platform,external_id' })
        .select('*')
        .single()
      throwIf('upsert deal', error)
      const d = deal as Deal
      wasKnown ? summary.updated++ : summary.created++

      if (d.match_status === 'ignored') continue

      let product: Product | null = null
      const productId = d.product_id ?? (d.asin ? byAsin.get(d.asin) : undefined)
      if (productId) {
        const { data: p, error: e3 } = await client.from('products').select('*').eq('id', productId).maybeSingle()
        throwIf('read product', e3)
        product = (p as Product | null) ?? null
      }

      if (product) {
        const { postCreated } = await linkDealToProduct(client, d, product)
        if (postCreated) summary.postsCreated++
        summary.matched++
      } else if (!d.received_at) {
        // nothing arrived: a deal row only, no product (brands often never reply)
        if (d.match_status !== 'waiting' || d.product_id) {
          throwIf('mark waiting', (await client.from('deals').update({ match_status: 'waiting', product_id: null }).eq('id', d.id)).error)
        }
        summary.waiting++
      } else {
        if (d.match_status !== 'needs_review' || d.product_id) {
          throwIf('flag deal', (await client.from('deals').update({ match_status: 'needs_review', product_id: null }).eq('id', d.id)).error)
        }
        summary.needsReview++
      }
    } catch (e) {
      summary.errors.push(`${input.brand ?? ''} ${input.asin ?? input.external_id}: ${(e as Error).message}`)
    }
  }
  return summary
}
