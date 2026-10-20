/**
 * ViralVue brand-deal import. Shared by the Settings button (browser, user
 * session) and scripts/import-deals.ts (Node, secret key): same code, same rules.
 *
 * Rules: upsert deals by (platform, external_id); never duplicate; fill only
 * empty product fields; never overwrite what was set by hand. A deal whose
 * product never arrived stays a deal row only ("waiting"), with no product.
 * Declined deals are ignored (hidden). A received deal with no product gets a
 * product automatically unless an existing product looks like the same thing,
 * in which case it waits for Charly's answer with that suggestion.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseCsv } from './csv'
import { dealState, type Deal, type LinkAdded, type Product, type ProductSource, type ProductStatus } from './types'
import { addReminders, closeReminders } from './viralvue'

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
  closed: number
  waitingShown: number
  waitingHidden: number
  needsReview: { title: string; suggestion: string | null }[]
  productsCreated: string[]
  postsCreated: number
  replyRate: { received: number; messaged: number }
  errors: string[]
  viralvue: { cleared: number; message: number }   // reminders the export ticked off; published deals still to message
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
const day = (ts: string | null) => (ts ? ts.slice(0, 10) : null)

function throwIf(step: string, error: { message: string } | null): void {
  if (error) throw new Error(`${step}: ${error.message}`)
}

/** PostgREST returns at most 1000 rows per request; page through. */
export async function selectAll<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, step = 1000): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += step) {
    const { data, error } = await make(from, from + step - 1)
    throwIf('read', error)
    out.push(...(data ?? []))
    if (!data || data.length < step) return out
  }
}

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

export const isClosedStatus = (raw: string | null | undefined) => /declin|cancel|reject|expire|closed/i.test(raw ?? '')

// ---- fuzzy "is this an existing product?" -------------------------------

const STOP = new Set(['with', 'from', 'that', 'this', 'pack', 'inch', 'inches', 'piece', 'pieces', 'pcs', 'size', 'large', 'small', 'women', 'men', 'kids', 'adult', 'adults', 'black', 'white', 'blue', 'gift', 'gifts', 'set', 'kit', 'new', 'and', 'the', 'for'])
const words = (s: string | null | undefined) => (s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w))

export type ProductLite = Pick<Product, 'id' | 'name' | 'brand'>

/** Existing products that look like this deal: a brand word in the name/brand, or 2+ significant title words in the name. */
export function suggestProducts(deal: Pick<Deal, 'brand' | 'title'>, products: ProductLite[], limit = 3): ProductLite[] {
  const brandWords = words(deal.brand).filter((w) => w.length > 3)
  const titleWords = Array.from(new Set(words(deal.title).filter((w) => !brandWords.includes(w))))
  if (!brandWords.length && titleWords.length < 2) return []
  return products
    .map((p) => {
      const name = p.name.toLowerCase()
      const pbrand = (p.brand ?? '').toLowerCase()
      const brandHit = brandWords.some((w) => name.includes(w) || pbrand.includes(w))
      const hits = titleWords.filter((w) => name.includes(w)).length
      const score = (brandHit ? 10 : 0) + hits
      return { p, score, ok: brandHit || hits >= 2 }
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p)
}

// ---- product side effects -------------------------------------------------

/**
 * Link a deal to a product: fill the product's empty fields, make sure the ASIN
 * listing and (if published) an Amazon post exist. The source is set only when
 * it is still unknown, unless `source` is given: that is an explicit choice
 * ("I bought it") and overrides, with the previous value kept for Unlink.
 */
export async function linkDealToProduct(client: SupabaseClient, deal: Deal, product: Product, extra: LinkAdded = {}, source?: ProductSource): Promise<{ postCreated: boolean }> {
  const added: LinkAdded = { ...extra }
  // "They sent something else": the deal's ASIN, brand and image belong to the product applied for, not the one that arrived
  const substituted = Boolean(extra.substituted)
  const patch: Partial<Product> = {}
  const before: NonNullable<LinkAdded['product_before']> = {}
  if (source && source !== product.source) { patch.source = source; before.source = product.source }
  else if (product.source === 'unknown') { patch.source = 'amazon_sample'; before.source = product.source }
  if (!substituted && !product.brand && deal.brand) { patch.brand = deal.brand; before.brand = product.brand }
  if (!product.received_at && deal.received_at) { patch.received_at = day(deal.received_at); before.received_at = product.received_at }
  if (!substituted && !product.product_image_url && deal.image_url) { patch.product_image_url = deal.image_url; before.product_image_url = product.product_image_url }
  if (Object.keys(patch).length) {
    throwIf('update product', (await client.from('products').update(patch).eq('id', product.id)).error)
    added.product_before = before
  }

  if (deal.asin && !substituted) {
    const { data: l, error } = await client.from('listings').select('id').eq('product_id', product.id).eq('platform', 'amazon_us').eq('external_id', deal.asin).limit(1)
    throwIf('read listing', error)
    if (!l?.length) {
      const ins = await client.from('listings').insert({
        product_id: product.id, platform: 'amazon_us', external_id: deal.asin,
        url: `https://www.amazon.com/dp/${deal.asin}`, availability: 'exact', checked_at: day(deal.deal_updated_at),
      }).select('id').single()
      throwIf('add listing', ins.error)
      added.listing_id = ins.data!.id
    }
  }

  let postCreated = false
  if (deal.published_at) {
    const { data: posts, error } = await client.from('posts').select('id').eq('product_id', product.id).eq('platform', 'amazon_us').eq('status', 'posted').limit(1)
    throwIf('read posts', error)
    if (!posts?.length) {
      const ins = await client.from('posts').insert({ product_id: product.id, platform: 'amazon_us', status: 'posted', posted_at: day(deal.published_at) }).select('id').single()
      throwIf('add post', ins.error)
      added.post_id = ins.data!.id
      postCreated = true
    }
  }

  let res = await client.from('deals').update({ product_id: product.id, match_status: 'matched', link_added: added }).eq('id', deal.id)
  if (res.error?.code === 'PGRST204') res = await client.from('deals').update({ product_id: product.id, match_status: 'matched' }).eq('id', deal.id) // migration 0003 not applied yet
  throwIf('link deal', res.error)
  return { postCreated }
}

/**
 * Undo a link: remove only what the link created (its listing, its post, the
 * product fields it filled, or the whole product if the deal created it) and
 * put the deal back to needs_review (received) or waiting.
 */
export async function unlinkDeal(client: SupabaseClient, deal: Deal): Promise<void> {
  const added = deal.link_added ?? {}
  if (deal.product_id) {
    if (added.created_product) {
      throwIf('remove product', (await client.from('products').delete().eq('id', deal.product_id)).error)
    } else {
      if (added.listing_id) throwIf('remove listing', (await client.from('listings').delete().eq('id', added.listing_id)).error)
      if (added.post_id) throwIf('remove post', (await client.from('posts').delete().eq('id', added.post_id)).error)
      if (added.product_before && Object.keys(added.product_before).length) {
        throwIf('restore product', (await client.from('products').update(added.product_before).eq('id', deal.product_id)).error)
      }
    }
  }
  const received_at = added.stamped_received ? null : deal.received_at
  throwIf('unlink deal', (await client.from('deals').update({
    product_id: null, link_added: null, received_at,
    match_status: received_at ? 'needs_review' : 'waiting',
  }).eq('id', deal.id)).error)
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
  if (d.video_created_at) return 'filmed'
  return 'received'
}

/** The brand sent a different product than the one applied for: link without copying the deal's ASIN, brand or image. */
export async function substituteDeal(client: SupabaseClient, deal: Deal, arrived: Product, source?: ProductSource): Promise<void> {
  let stamped = false
  if (!deal.received_at) {
    const received = new Date().toISOString()
    throwIf('stamp received', (await client.from('deals').update({ received_at: received }).eq('id', deal.id)).error)
    deal = { ...deal, received_at: received }
    stamped = true
  }
  await linkDealToProduct(client, deal, arrived, { substituted: true, stamped_received: stamped }, source)
  if (stamped) await addReminders(client, [deal.id], 'received')
}

/**
 * Something arrived for this deal: create its product (Amazon sample, brand,
 * ASIN listing, full image, received date), stamp received_at and link the deal.
 * Used by "It arrived", "Create new product", the import's auto-create and, later, Add product.
 */
export async function receiveDeal(client: SupabaseClient, deal: Deal, overrides: Partial<Pick<Product, 'name' | 'status' | 'source'>> = {}): Promise<Product> {
  const received = deal.received_at ?? new Date().toISOString()
  const stamped = !deal.received_at
  if (stamped) {
    throwIf('stamp received', (await client.from('deals').update({ received_at: received }).eq('id', deal.id)).error)
    deal = { ...deal, received_at: received }
  }
  const base = overrides.name ?? nameFromTitle(deal.title, deal.asin)
  const row = {
    name: base,
    brand: deal.brand,
    source: overrides.source ?? 'amazon_sample',   // "I bought it" passes 'bought'; a claimed deal on a bought product is fine
    status: overrides.status ?? statusFromDeal(deal),
    received_at: day(received),
    product_image_url: deal.image_url,
    notes: `From the ViralVue brand deal${deal.title ? `: ${deal.title}` : ''}`,
  }
  let res = await client.from('products').insert(row).select('*').single()
  if (res.error?.code === '23505') res = await client.from('products').insert({ ...row, name: `${base} (${deal.asin ?? deal.external_id.slice(0, 8)})` }).select('*').single()
  throwIf('create product', res.error)
  const product = res.data as Product
  await linkDealToProduct(client, deal, product, { created_product: true, stamped_received: stamped })
  // the app knows it arrived before ViralVue does: remind to tick Received there
  if (stamped) await addReminders(client, [deal.id], 'received')
  return product
}

export const createProductFromDeal = receiveDeal

export async function ignoreDeal(client: SupabaseClient, deal: Deal): Promise<void> {
  throwIf('ignore deal', (await client.from('deals').update({ match_status: 'ignored', product_id: null }).eq('id', deal.id)).error)
}

/**
 * Door matching: deals still waiting on the brand (including ones that went
 * quiet) that might be the box in your hand. Exact ASIN first, then brand.
 * Searches server-side so the whole waiting list never has to be loaded.
 */
export async function findWaitingDeals(client: SupabaseClient, hint: { asin?: string | null; brand?: string | null; title?: string | null }): Promise<Deal[]> {
  const base = () => client.from('deals').select('*').eq('match_status', 'waiting').is('product_id', null)
  if (hint.asin) {
    const { data, error } = await base().ilike('asin', hint.asin.trim()).limit(10)
    throwIf('search by ASIN', error)
    if (data?.length) return data as Deal[]
  }
  const brand = (hint.brand ?? '').trim()
  if (brand.length >= 3) {
    const { data, error } = await base().ilike('brand', `%${brand}%`).order('deal_created_at', { ascending: false }).limit(20)
    throwIf('search by brand', error)
    if (data?.length) return data as Deal[]
  }
  const tw = words(hint.title).slice(0, 3)
  if (tw.length) {
    const { data, error } = await base().or(tw.map((w) => `title.ilike.%${w}%`).join(',')).order('deal_created_at', { ascending: false }).limit(50)
    throwIf('search by title', error)
    const ranked = suggestProducts({ brand: hint.brand ?? null, title: hint.title ?? null }, (data ?? []).map((d) => ({ id: d.id, name: `${d.brand ?? ''} ${d.title ?? ''}`, brand: d.brand })), 10)
    const byId = new Map((data ?? []).map((d) => [d.id, d as Deal]))
    return ranked.map((r) => byId.get(r.id)!).filter(Boolean)
  }
  return []
}

// ---- the import -----------------------------------------------------------

type ExistingDeal = Pick<Deal, 'id' | 'external_id' | 'product_id' | 'match_status' | 'received_at'>

/** Import a ViralVue CSV export. Safe to run again with a newer export. */
export async function importDeals(client: SupabaseClient, csvText: string, onProgress?: (msg: string) => void): Promise<ImportSummary> {
  const say = (m: string) => onProgress?.(m)
  const inputs = parseViralVueDeals(csvText)
  const summary: ImportSummary = {
    total: inputs.length, created: 0, updated: 0, matched: 0, closed: 0, waitingShown: 0, waitingHidden: 0,
    needsReview: [], productsCreated: [], postsCreated: 0, replyRate: { received: 0, messaged: 0 }, errors: [], viralvue: { cleared: 0, message: 0 },
  }
  if (!inputs.length) return summary

  say('Reading what is already there…')
  const existing = new Map<string, ExistingDeal>()
  for (const d of await selectAll<ExistingDeal>((a, b) => client.from('deals').select('id,external_id,product_id,match_status,received_at').eq('platform', 'amazon_us').range(a, b))) existing.set(d.external_id, d)
  const listings = await selectAll<{ product_id: string; external_id: string | null }>((a, b) => client.from('listings').select('product_id,external_id').eq('platform', 'amazon_us').range(a, b))
  const byAsin = new Map<string, string>()
  for (const l of listings) if (l.external_id && !byAsin.has(l.external_id)) byAsin.set(l.external_id, l.product_id)
  const products = await selectAll<Product>((a, b) => client.from('products').select('*').range(a, b))
  const productById = new Map(products.map((p) => [p.id, p]))
  // hidden products (Not a product review) are never suggested as the box a deal sent
  const lite: ProductLite[] = products.filter((p) => !p.archived_at).map((p) => ({ id: p.id, name: p.name, brand: p.brand }))

  // decide each row in memory
  type Decision = { input: DealInput; product_id: string | null; match_status: Deal['match_status']; autoCreate: boolean; suggestion: ProductLite | null }
  const decisions: Decision[] = []
  for (const input of inputs) {
    const ex = existing.get(input.external_id)
    ex ? summary.updated++ : summary.created++
    if (ex && (ex.match_status === 'matched' || ex.match_status === 'ignored')) {
      decisions.push({ input, product_id: ex.product_id, match_status: ex.match_status, autoCreate: false, suggestion: null })
      continue
    }
    const pid = input.asin ? byAsin.get(input.asin) ?? null : null
    if (pid) decisions.push({ input, product_id: pid, match_status: 'matched', autoCreate: false, suggestion: null })
    else if (isClosedStatus(input.status_raw)) decisions.push({ input, product_id: null, match_status: 'ignored', autoCreate: false, suggestion: null })
    else if (!input.received_at) decisions.push({ input, product_id: null, match_status: 'waiting', autoCreate: false, suggestion: null })
    else {
      const s = suggestProducts(input, lite, 1)[0] ?? null
      decisions.push({ input, product_id: null, match_status: 'needs_review', autoCreate: !s, suggestion: s })
    }
  }

  // upsert deals in chunks, with the decided link state
  say(`Saving ${decisions.length} deals…`)
  const saved = new Map<string, Deal>()
  for (let i = 0; i < decisions.length; i += 500) {
    const rows = decisions.slice(i, i + 500).map((d) => ({
      ...d.input, product_id: d.product_id, match_status: d.match_status,
      // a box the app recorded as arrived stays arrived while ViralVue isn't ticked yet
      received_at: d.input.received_at ?? existing.get(d.input.external_id)?.received_at ?? null,
    }))
    const { data, error } = await client.from('deals').upsert(rows, { onConflict: 'platform,external_id' }).select('*')
    throwIf('save deals', error)
    for (const d of (data ?? []) as Deal[]) saved.set(d.external_id, d)
    say(`Saved ${Math.min(i + 500, decisions.length)} of ${decisions.length}…`)
  }

  // matched: fill empty product fields, listings, posts (only where needed)
  say('Linking products…')
  const postedOn = new Set(
    (await selectAll<{ product_id: string }>((a, b) => client.from('posts').select('product_id').eq('platform', 'amazon_us').eq('status', 'posted').range(a, b))).map((p) => p.product_id),
  )
  const listingKeys = new Set(listings.map((l) => `${l.product_id}|${l.external_id ?? ''}`))
  for (const d of decisions) {
    if (d.match_status !== 'matched' || !d.product_id) continue
    const deal = saved.get(d.input.external_id)
    const product = productById.get(d.product_id)
    if (!deal || !product) continue
    summary.matched++
    try {
      const patch: Partial<Product> = {}
      if (product.source === 'unknown') patch.source = 'amazon_sample'
      if (!product.brand && deal.brand) patch.brand = deal.brand
      if (!product.received_at && deal.received_at) patch.received_at = day(deal.received_at)
      if (!product.product_image_url && deal.image_url) patch.product_image_url = deal.image_url
      if (Object.keys(patch).length) {
        throwIf('update product', (await client.from('products').update(patch).eq('id', product.id)).error)
        Object.assign(product, patch)
      }
      if (deal.asin && !listingKeys.has(`${product.id}|${deal.asin}`)) {
        throwIf('add listing', (await client.from('listings').insert({ product_id: product.id, platform: 'amazon_us', external_id: deal.asin, url: `https://www.amazon.com/dp/${deal.asin}`, availability: 'exact', checked_at: day(deal.deal_updated_at) })).error)
        listingKeys.add(`${product.id}|${deal.asin}`)
      }
      if (deal.published_at && !postedOn.has(product.id)) {
        throwIf('add post', (await client.from('posts').insert({ product_id: product.id, platform: 'amazon_us', status: 'posted', posted_at: day(deal.published_at) })).error)
        postedOn.add(product.id)
        summary.postsCreated++
      }
    } catch (e) {
      summary.errors.push(`${deal.brand ?? ''} ${deal.asin ?? deal.external_id}: ${(e as Error).message}`)
    }
  }

  // received with no product and no look-alike: create the product
  const toCreate = decisions.filter((d) => d.autoCreate)
  say(`Creating ${toCreate.length} products…`)
  for (const d of toCreate) {
    const deal = saved.get(d.input.external_id)
    if (!deal) continue
    try {
      const p = await receiveDeal(client, deal)
      summary.productsCreated.push(p.name)
      summary.matched++
      lite.push({ id: p.id, name: p.name, brand: p.brand })
    } catch (e) {
      summary.errors.push(`${deal.brand ?? ''} ${deal.asin ?? deal.external_id}: ${(e as Error).message}`)
    }
  }

  for (const d of decisions) {
    if (d.match_status === 'needs_review' && !d.autoCreate) summary.needsReview.push({ title: `${d.input.brand ?? ''} · ${d.input.title ?? d.input.asin}`, suggestion: d.suggestion?.name ?? null })
    else if (d.match_status === 'ignored') summary.closed++
    else if (d.match_status === 'waiting') (dealState(d.input) === 'waiting' ? summary.waitingShown++ : summary.waitingHidden++)
  }
  // ViralVue reminders: ticks this export shows are done; published deals with no brand message need one
  say('Checking ViralVue reminders…')
  try {
    const idOf = (i: DealInput) => saved.get(i.external_id)?.id
    const ids = (f: (i: DealInput) => unknown) => inputs.filter(f).map(idOf).filter((x): x is string => Boolean(x))
    summary.viralvue.cleared += await closeReminders(client, ids((i) => i.received_at), 'received', 'import')
    summary.viralvue.cleared += await closeReminders(client, ids((i) => i.published_at), 'published', 'import')
    summary.viralvue.cleared += await closeReminders(client, ids((i) => i.message_sent_at), 'message', 'import')
    const unmessaged = ids((i) => i.published_at && !i.message_sent_at && !isClosedStatus(i.status_raw))
    await addReminders(client, unmessaged, 'message')
    summary.viralvue.message = unmessaged.length
  } catch (e) {
    summary.errors.push((e as Error).message)
  }
  summary.replyRate = { received: inputs.filter((i) => i.received_at).length, messaged: inputs.filter((i) => i.message_sent_at).length }
  say('Done.')
  return summary
}
