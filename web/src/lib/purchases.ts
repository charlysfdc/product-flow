/**
 * Amazon purchases: Charly's own orders (Amazon Order History Reporter "items" CSV) → the purchases table.
 * A purchase whose ASIN is an app product's Amazon US listing is linked to it, and the product is fixed:
 * no deal behind it → source bought, the price paid, the order date as received date (each change recorded
 * in products.purchase_change for Undo). A product that also has a received deal is not changed; it gets a
 * "Sample or bought?" question. The rest are sorted into buckets: Amazon's category first, Claude for the rest.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseCsv } from './csv'
import { selectAll } from './deals'
import type { Product, ProductSource } from './types'

export type Bucket = 'review' | 'supplies' | 'household' | 'subscription' | 'unsorted'
export const BUCKET_LABEL: Record<Bucket, string> = {
  review: 'Review candidate', supplies: 'Supplies', household: 'Household', subscription: 'Subscription', unsorted: 'Unsorted',
}

export interface Purchase {
  id: string
  order_id: string
  order_date: string | null
  asin: string
  title: string | null
  quantity: number
  unit_price: number | null
  category: string | null
  bucket: Bucket
  bucket_by: string | null
  product_id: string | null
  link_kind: 'bought' | 'rebuy' | 'both' | null
  ask_product_id: string | null
}

export interface PurchaseLink { asin: string; via: 'exact' | 'same_as' | 'auto'; listing_id: string | null }

export interface PurchaseChange {
  at: string
  before: Partial<Pick<Product, 'source' | 'price' | 'received_at' | 'received_estimated'>>
  after: Partial<Pick<Product, 'source' | 'price' | 'received_at' | 'received_estimated'>>
  links?: PurchaseLink[]     // which order ASINs were linked, how, and the Amazon listing added for it
}

export const isPurchasesExport = (csvText: string) => {
  const first = csvText.replace(/^﻿/, '').split(/\r?\n/, 1)[0].toLowerCase()
  return first.includes('order id') && first.includes('asin') && first.includes('order date')
}

type Row = Omit<Purchase, 'id' | 'bucket' | 'bucket_by' | 'product_id' | 'link_kind' | 'ask_product_id'> & { subscribe_save: boolean }

const money = (s: string | undefined) => {
  const n = Number((s ?? '').replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && (s ?? '').trim() ? n : null
}

/** Item rows only (the SUBTOTAL row and blanks are skipped); the same ASIN twice in one order is one row. */
export function parsePurchases(csvText: string): Row[] {
  const out = new Map<string, Row>()
  for (const r of parseCsv(csvText)) {
    const asin = (r['ASIN'] ?? '').trim().toUpperCase()
    const order = (r['order id'] ?? '').trim()
    if (!/^[A-Z0-9]{10}$/.test(asin) || !order || order.startsWith('=')) continue
    const qty = Math.max(1, Number(r['quantity']) || 1)
    const price = money(r['price'])
    const key = `${order}|${asin}`
    const have = out.get(key)
    if (have) {
      // merge: quantities add up, the unit price is the average paid
      const total = (have.unit_price ?? 0) * have.quantity + (price ?? 0) * qty
      have.quantity += qty
      have.unit_price = have.unit_price == null && price == null ? null : Math.round((total / have.quantity) * 100) / 100
      continue
    }
    out.set(key, {
      order_id: order, order_date: /^\d{4}-\d{2}-\d{2}/.test(r['order date'] ?? '') ? r['order date'].slice(0, 10) : null,
      asin, title: r['description'] || null, quantity: qty, unit_price: price,
      subscribe_save: (r['subscribe & save'] ?? '0').trim() !== '0' && (r['subscribe & save'] ?? '').trim() !== '',
      category: r['category'] || null,
    })
  }
  return [...out.values()]
}

/** Amazon's own category decides when it clearly can; null = ask Claude. */
export function bucketFromCategory(p: Pick<Row, 'order_id' | 'category' | 'title'>): Bucket | null {
  if (p.order_id.startsWith('D01-')) return 'subscription'   // digital orders: Audible, Kindle, Music
  const top = (p.category ?? '').split('›')[0].trim()
  if (['Arts, Crafts & Sewing', 'Industrial & Scientific', 'Office Products'].includes(top)) return 'supplies'
  if (top === 'Grocery & Gourmet Food') return 'household'
  if (/audible|kindle|amazon music|prime video|subscription|membership/i.test(p.title ?? '') && !top) return 'subscription'
  return null
}

export interface PurchasesSummary {
  rows: number
  added: number
  already: number
  matchedProducts: number
  changed: { source: number; price: number; date: number; products: number }
  questions: number
  buckets: Record<Bucket, number>
  reviewCandidates: number
  total: number
  sortedByClaude: number
  autoLinked: number
  errors: string[]
}

const today = () => new Date().toISOString()

/** Claude's bucket for each ASIN (the app passes the identify function's classify action). */
export type Classify = (items: { asin: string; title: string | null; category: string | null }[]) => Promise<Record<string, Bucket>>

export async function importPurchases(client: SupabaseClient, csvText: string, classify: Classify, say: (m: string) => void = () => {}): Promise<PurchasesSummary> {
  const rows = parsePurchases(csvText)
  const s: PurchasesSummary = {
    rows: rows.length, added: 0, already: 0, matchedProducts: 0, changed: { source: 0, price: 0, date: 0, products: 0 },
    questions: 0, buckets: { review: 0, supplies: 0, household: 0, subscription: 0, unsorted: 0 }, reviewCandidates: 0,
    total: Math.round(rows.reduce((n, r) => n + (r.unit_price ?? 0) * r.quantity, 0) * 100) / 100, sortedByClaude: 0, autoLinked: 0, errors: [],
  }
  if (!rows.length) return s

  say('Saving the purchases…')
  const existing = await selectAll<Purchase>((a, b) => client.from('purchases').select('*').range(a, b))
  const known = new Set(existing.map((p) => `${p.order_id}|${p.asin}`))
  const fresh = rows.filter((r) => !known.has(`${r.order_id}|${r.asin}`))
  s.already = rows.length - fresh.length
  for (let i = 0; i < fresh.length; i += 200) {
    const { error } = await client.from('purchases').insert(fresh.slice(i, i + 200).map((r) => ({ ...r, platform: 'amazon_us' })))
    if (error) throw new Error(`Saving purchases: ${error.message}`)
    s.added += Math.min(200, fresh.length - i)
  }
  const all = await selectAll<Purchase>((a, b) => client.from('purchases').select('*').range(a, b))

  // exact matches: the ASIN is a product's Amazon US listing (hidden products are never touched)
  say('Matching products…')
  const listings = await selectAll<{ product_id: string; external_id: string | null }>((a, b) => client.from('listings').select('product_id,external_id').eq('platform', 'amazon_us').not('external_id', 'is', null).range(a, b))
  const products = await selectAll<Product>((a, b) => client.from('products').select('*').range(a, b))
  const byId = new Map(products.map((p) => [p.id, p]))
  const productFor = new Map<string, Product>()
  for (const l of listings) {
    const p = byId.get(l.product_id)
    if (p && !p.archived_at && !productFor.has(l.external_id!.toUpperCase())) productFor.set(l.external_id!.toUpperCase(), p)
  }
  const dealt = await selectAll<{ product_id: string; received_at: string | null }>((a, b) => client.from('deals').select('product_id,received_at').not('product_id', 'is', null).range(a, b))
  const hasDeal = new Set(dealt.map((d) => d.product_id))

  const byAsin = new Map<string, Purchase[]>()
  for (const p of all) {
    if (!byAsin.has(p.asin)) byAsin.set(p.asin, [])
    byAsin.get(p.asin)!.push(p)
  }

  for (const [asin, buys] of byAsin) {
    const product = productFor.get(asin)
    if (!product) continue
    const open = buys.filter((b) => !b.product_id && !b.ask_product_id && b.bucket_by !== 'manual')
    s.matchedProducts++
    if (!open.length) continue
    try {
      const r = await applyMatch(client, product, buys, open, hasDeal.has(product.id), { asin, via: 'exact', listing_id: null })
      if (r.question) s.questions++
      if (r.changed.products) { s.changed.products++; s.changed.source += r.changed.source; s.changed.price += r.changed.price; s.changed.date += r.changed.date }
    } catch (e) {
      s.errors.push(`${product.name}: ${(e as Error).message}`)
    }
  }

  // no exact ASIN: a strong look-alike (brand and 2+ title words, or the folder name) is linked too,
  // recorded so What the import changed can undo it
  say('Looking for the same product under another ASIN…')
  try {
    const auto = await recheckMatches(client)
    s.autoLinked = auto.linked
    s.questions += auto.questions
    s.changed.products += auto.changed
  } catch (e) {
    s.errors.push(`Look-alike matches: ${(e as Error).message}`)
  }

  // buckets for what matched nothing: Amazon's category, then Claude, one call per 120 ASINs
  say('Sorting the other purchases…')
  const fresh2 = await selectAll<Purchase>((a, b) => client.from('purchases').select('*').range(a, b))
  const unsorted = fresh2.filter((p) => !p.product_id && !p.ask_product_id && p.bucket === 'unsorted' && p.bucket_by !== 'manual')
  const byCategory = new Map<Bucket, string[]>()
  const ask = new Map<string, { asin: string; title: string | null; category: string | null }>()
  for (const p of unsorted) {
    const b = bucketFromCategory(p)
    if (b) {
      if (!byCategory.has(b)) byCategory.set(b, [])
      byCategory.get(b)!.push(p.id)
    } else if (!ask.has(p.asin)) ask.set(p.asin, { asin: p.asin, title: p.title, category: p.category })
  }
  for (const [b, ids] of byCategory) {
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await client.from('purchases').update({ bucket: b, bucket_by: 'category' }).in('id', ids.slice(i, i + 200))
      if (error) s.errors.push(`bucket ${b}: ${error.message}`)
    }
  }
  const items = [...ask.values()]
  for (let i = 0; i < items.length; i += 120) {
    say(`Asking Claude about ${Math.min(i + 120, items.length)} of ${items.length} items…`)
    try {
      const r = await classify(items.slice(i, i + 120))
      for (const [b, asins] of groupBy(Object.entries(r))) {
        const { error } = await client.from('purchases').update({ bucket: b, bucket_by: 'claude' }).in('asin', asins).eq('bucket', 'unsorted').is('product_id', null)
        if (error) s.errors.push(`bucket ${b}: ${error.message}`)
        else s.sortedByClaude += asins.length
      }
    } catch (e) {
      s.errors.push(`Claude sorting: ${(e as Error).message} (those stay Unsorted; importing again retries)`)
    }
  }

  const final = await selectAll<Pick<Purchase, 'bucket' | 'product_id' | 'ask_product_id' | 'asin'>>((a, b) => client.from('purchases').select('bucket,product_id,ask_product_id,asin').range(a, b))
  for (const p of final) s.buckets[p.bucket]++
  s.reviewCandidates = new Set(final.filter((p) => p.bucket === 'review' && !p.product_id && !p.ask_product_id).map((p) => p.asin)).size
  say('Done.')
  return s
}

/**
 * The rules for a purchase that is this product (exact ASIN, "Same as", or a strong look-alike): with a deal,
 * the "Sample or bought?" question; without, source Bought, the price paid and the earliest order date.
 * Every change and the link are recorded in purchase_change for Undo.
 */
export async function applyMatch(client: SupabaseClient, product: Product, buys: Purchase[], open: Purchase[], hasDeal: boolean, link: PurchaseLink) {
  const changed = { source: 0, price: 0, date: 0, products: 0 }
  const prev = product.purchase_change as PurchaseChange | null | undefined
  const links = [...(prev?.links ?? []).filter((l) => l.asin !== link.asin), link]
  if (hasDeal) {
    const { error } = await client.from('purchases').update({ ask_product_id: product.id, bucket: 'review', bucket_by: 'match' }).in('id', open.map((b) => b.id))
    if (error) throw new Error(error.message)
    if (link.via !== 'exact') {
      const { error: e2 } = await client.from('products').update({ purchase_change: { at: today(), before: prev?.before ?? {}, after: prev?.after ?? {}, links } }).eq('id', product.id)
      if (e2) throw new Error(e2.message)
    }
    return { question: true, changed }
  }
  const first = [...buys].sort((a, b) => (a.order_date ?? '9999').localeCompare(b.order_date ?? '9999'))[0]
  const before: PurchaseChange['before'] = {}
  const after: PurchaseChange['after'] = {}
  if (product.source === 'amazon_sample' || product.source === 'unknown') { before.source = product.source; after.source = 'bought' as ProductSource; changed.source++ }
  if (first.unit_price != null && Number(product.price ?? NaN) !== Number(first.unit_price)) { before.price = product.price ?? null; after.price = Number(first.unit_price); changed.price++ }
  if (first.order_date && (!product.received_at || product.received_estimated || product.received_at > first.order_date)) {
    if (product.received_at !== first.order_date || product.received_estimated) {
      before.received_at = product.received_at; before.received_estimated = Boolean(product.received_estimated)
      after.received_at = first.order_date; after.received_estimated = false
      changed.date++
    }
  }
  if (Object.keys(after).length || link.via !== 'exact') {
    // a later import keeps the first "before", so Undo always goes back to how it was
    const change: PurchaseChange = { at: today(), before: { ...before, ...(prev?.before ?? {}) }, after: { ...(prev?.after ?? {}), ...after }, links }
    const { error } = await client.from('products').update({ ...after, purchase_change: change }).eq('id', product.id)
    if (error) throw new Error(error.message)
    changed.products = 1
  }
  const { error } = await client.from('purchases').update({ product_id: product.id, link_kind: 'bought', bucket: 'review', bucket_by: link.via === 'exact' ? 'match' : link.via === 'auto' ? 'match' : 'manual' }).in('id', open.map((b) => b.id))
  if (error) throw new Error(error.message)
  return { question: false, changed }
}

// ---- the same product under another ASIN ("Same as") -------------------------------

const STOP = new Set(['with', 'from', 'that', 'this', 'pack', 'inch', 'inches', 'piece', 'pieces', 'pcs', 'size', 'large', 'small', 'women', 'men', 'kids', 'adult', 'adults', 'black', 'white', 'blue', 'gift', 'gifts', 'set', 'kit', 'new', 'and', 'the', 'for', 'count', 'ounce', 'oz', 'fl', 'premium', 'professional', 'portable', 'upgraded', 'compatible', 'home', 'use'])
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const words = (s: string | null | undefined) => (s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w))

export interface MatchContext {
  products: Product[]                  // not hidden
  folderOf: Map<string, string[]>      // product id → its folder names (drive_folder_name + extras)
  dealTitles: Map<string, string[]>    // product id → titles of its brand deals
  hasDeal: Set<string>
}

export interface Suggestion { product: Product; score: number; strong: boolean; why: string }

/** Products that look like this purchase: brand + title words against names, folders, brands, deal titles. */
export function suggestFor(title: string | null, ctx: MatchContext, limit = 3): Suggestion[] {
  const t = (title ?? '').toLowerCase()
  const nt = norm(title ?? '')
  const tw = Array.from(new Set(words(title)))
  if (!t || !tw.length) return []
  const out: Suggestion[] = []
  for (const p of ctx.products) {
    const names = [p.name, ...(ctx.folderOf.get(p.id) ?? [])].map((x) => x.toLowerCase())
    const hay = new Set(words([...names, ...(ctx.dealTitles.get(p.id) ?? [])].join(' ')))
    const brand = (p.brand ?? '').toLowerCase().trim()
    const brandHit = brand.length >= 3 && new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)
    const hits = tw.filter((w) => hay.has(w)).length
    // the product's own name or folder inside the order title: as a phrase, or 3+ significant words all there
    const folderHit = names.some((n) => {
      const nn = norm(n), nw = words(n)
      return (nn.split(' ').length >= 2 && nw.length >= 2 && ` ${nt} `.includes(` ${nn} `)) || (nw.length >= 3 && nw.every((w) => tw.includes(w)))
    })
    const ok = folderHit || (brandHit && hits >= 1) || hits >= 2
    if (!ok) continue
    const strong = folderHit || (brandHit && hits >= 2)
    out.push({ product: p, score: (folderHit ? 20 : 0) + (brandHit ? 10 : 0) + hits, strong, why: folderHit ? 'same name' : brandHit ? `${p.brand} + ${hits} word${hits === 1 ? '' : 's'}` : `${hits} words` })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

export async function matchContext(client: SupabaseClient): Promise<MatchContext> {
  const products = (await selectAll<Product>((a, b) => client.from('products').select('*').range(a, b))).filter((p) => !p.archived_at)
  const deals = await selectAll<{ product_id: string; title: string | null }>((a, b) => client.from('deals').select('product_id,title').not('product_id', 'is', null).range(a, b))
  const folderOf = new Map(products.map((p) => [p.id, [p.drive_folder_name, ...(p.extra_drive_folders ?? []).map((f) => f.name)].filter((x): x is string => Boolean(x))]))
  const dealTitles = new Map<string, string[]>()
  for (const d of deals) {
    if (!dealTitles.has(d.product_id)) dealTitles.set(d.product_id, [])
    if (d.title) dealTitles.get(d.product_id)!.push(d.title)
  }
  return { products, folderOf, dealTitles, hasDeal: new Set(deals.map((d) => d.product_id)) }
}

/** "Same as <product>": link this ASIN's orders, add the ASIN as an extra Amazon US listing, then the usual rules. */
export async function linkSameAs(client: SupabaseClient, product: Product, asin: string, hasDeal: boolean, via: 'same_as' | 'auto' = 'same_as') {
  const { data: buys, error } = await client.from('purchases').select('*').eq('asin', asin)
  if (error) throw new Error(error.message)
  const open = ((buys ?? []) as Purchase[]).filter((b) => !b.product_id && !b.ask_product_id)
  if (!open.length) return { question: false, changed: { source: 0, price: 0, date: 0, products: 0 } }
  let listingId: string | null = null
  const { data: have } = await client.from('listings').select('id').eq('product_id', product.id).eq('platform', 'amazon_us').eq('external_id', asin).limit(1)
  if (!have?.length) {
    const ins = await client.from('listings').insert({
      product_id: product.id, platform: 'amazon_us', external_id: asin, url: `https://www.amazon.com/dp/${asin}`,
      availability: 'exact', availability_note: 'Another listing of it (Amazon order)', checked_at: new Date().toISOString().slice(0, 10),
    }).select('id').single()
    if (ins.error) throw new Error(ins.error.message)
    listingId = ins.data.id
  }
  // the product as it is now (an earlier link may have changed it)
  const { data: fresh } = await client.from('products').select('*').eq('id', product.id).single()
  return applyMatch(client, (fresh ?? product) as Product, buys as Purchase[], open, hasDeal, { asin, via, listing_id: listingId })
}

/**
 * Re-check matches: unlinked review and unsorted orders whose best look-alike is strong and clearly ahead of
 * the next are linked (never ones Charly sorted by hand).
 */
export async function recheckMatches(client: SupabaseClient): Promise<{ linked: number; questions: number; changed: number }> {
  const all = await selectAll<Purchase>((a, b) => client.from('purchases').select('*').range(a, b))
  const open = all.filter((p) => !p.product_id && !p.ask_product_id && p.bucket_by !== 'manual' && (p.bucket === 'review' || p.bucket === 'unsorted'))
  const res = { linked: 0, questions: 0, changed: 0 }
  if (!open.length) return res
  const ctx = await matchContext(client)
  const done = new Set<string>()
  for (const pu of open) {
    if (done.has(pu.asin)) continue
    done.add(pu.asin)
    const [best, next] = suggestFor(pu.title, ctx, 2)
    if (!best?.strong || (next && next.strong && next.score >= best.score - 2)) continue
    const r = await linkSameAs(client, best.product, pu.asin, ctx.hasDeal.has(best.product.id), 'auto')
    res.linked++
    if (r.question) res.questions++
    if (r.changed.products) res.changed++
  }
  return res
}

function groupBy(pairs: [string, Bucket][]): Map<Bucket, string[]> {
  const m = new Map<Bucket, string[]>()
  for (const [asin, b] of pairs) {
    if (!m.has(b)) m.set(b, [])
    m.get(b)!.push(asin)
  }
  return m
}

/**
 * Undo what an import changed on one product: each field goes back to its "before" value, unless it
 * was changed again since (then the newer value stays). Its orders stay linked as re-buys.
 */
export async function undoPurchaseChange(client: SupabaseClient, p: Product): Promise<string[]> {
  const ch = p.purchase_change as PurchaseChange | null | undefined
  if (!ch) return []
  const patch: Record<string, unknown> = { purchase_change: null }
  const kept: string[] = []
  for (const k of Object.keys(ch.after) as (keyof PurchaseChange['after'])[]) {
    const now = (p as unknown as Record<string, unknown>)[k]
    if (String(now ?? '') === String(ch.after[k] ?? '')) patch[k] = ch.before[k] ?? null
    else kept.push(k)
  }
  const { error } = await client.from('products').update(patch).eq('id', p.id)
  if (error) throw new Error(error.message)
  // "Same as" and look-alike links: the orders go back to the list (sorted by hand, so never auto-linked
  // again) and the Amazon listing added for them is removed
  for (const l of (ch.links ?? []).filter((x) => x.via !== 'exact')) {
    const un = await client.from('purchases').update({ product_id: null, ask_product_id: null, link_kind: null, bucket: 'review', bucket_by: 'manual' }).eq('asin', l.asin).or(`product_id.eq.${p.id},ask_product_id.eq.${p.id}`)
    if (un.error) throw new Error(un.error.message)
    if (l.listing_id) await client.from('listings').delete().eq('id', l.listing_id)
  }
  // exact matches: the orders stay with the product as re-buys, so a later import doesn't change it again
  const un = await client.from('purchases').update({ link_kind: 'rebuy', bucket: 'household', bucket_by: 'manual' }).eq('product_id', p.id).eq('link_kind', 'bought')
  if (un.error) throw new Error(un.error.message)
  return kept
}

/** "Sample or bought?": sample = keep it, the order is a re-buy; bought = source bought, price paid; both = keep the sample, link the order. */
export async function answerPurchase(client: SupabaseClient, product: Product, buys: Purchase[], answer: 'sample' | 'bought' | 'both'): Promise<void> {
  const ids = buys.map((b) => b.id)
  if (answer === 'bought') {
    const first = [...buys].sort((a, b) => (a.order_date ?? '9999').localeCompare(b.order_date ?? '9999'))[0]
    const before: PurchaseChange['before'] = { source: product.source, price: product.price ?? null }
    const after: PurchaseChange['after'] = { source: 'bought', ...(first.unit_price != null ? { price: Number(first.unit_price) } : {}) }
    const { error } = await client.from('products').update({ ...after, purchase_change: { at: today(), before, after } }).eq('id', product.id)
    if (error) throw new Error(error.message)
  }
  const { error } = await client.from('purchases').update({ product_id: product.id, ask_product_id: null, link_kind: answer === 'sample' ? 'rebuy' : answer, bucket: answer === 'bought' ? 'review' : 'household', bucket_by: 'manual' }).in('id', ids)
  if (error) throw new Error(error.message)
}

export async function setBucket(client: SupabaseClient, asin: string, bucket: Bucket): Promise<void> {
  const { error } = await client.from('purchases').update({ bucket, bucket_by: 'manual' }).eq('asin', asin).is('product_id', null)
  if (error) throw new Error(error.message)
}

/** Purchases grouped by ASIN: count, last date, total paid. */
export function byAsinGroups(list: Purchase[]) {
  const m = new Map<string, { asin: string; title: string | null; count: number; qty: number; last: string | null; total: number; buys: Purchase[] }>()
  for (const p of list) {
    const g = m.get(p.asin) ?? { asin: p.asin, title: p.title, count: 0, qty: 0, last: null, total: 0, buys: [] }
    g.count++
    g.qty += p.quantity
    g.total += (p.unit_price ?? 0) * p.quantity
    if (p.order_date && (!g.last || p.order_date > g.last)) g.last = p.order_date
    g.buys.push(p)
    m.set(p.asin, g)
  }
  return [...m.values()].sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''))
}
