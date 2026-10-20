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

export interface PurchaseChange {
  at: string
  before: Partial<Pick<Product, 'source' | 'price' | 'received_at' | 'received_estimated'>>
  after: Partial<Pick<Product, 'source' | 'price' | 'received_at' | 'received_estimated'>>
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
    total: Math.round(rows.reduce((n, r) => n + (r.unit_price ?? 0) * r.quantity, 0) * 100) / 100, sortedByClaude: 0, errors: [],
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
      if (hasDeal.has(product.id)) {
        // a sample deal AND an order: Charly decides (Sample / Bought / Both)
        const { error } = await client.from('purchases').update({ ask_product_id: product.id, bucket: 'review', bucket_by: 'match' }).in('id', open.map((b) => b.id))
        if (error) throw error
        s.questions++
        continue
      }
      const first = [...buys].sort((a, b) => (a.order_date ?? '9999').localeCompare(b.order_date ?? '9999'))[0]
      const before: PurchaseChange['before'] = {}
      const after: PurchaseChange['after'] = {}
      if (product.source === 'amazon_sample' || product.source === 'unknown') { before.source = product.source; after.source = 'bought' as ProductSource; s.changed.source++ }
      if (first.unit_price != null && Number(product.price ?? NaN) !== Number(first.unit_price)) { before.price = product.price ?? null; after.price = Number(first.unit_price); s.changed.price++ }
      if (first.order_date && (!product.received_at || product.received_estimated || product.received_at > first.order_date)) {
        if (product.received_at !== first.order_date || product.received_estimated) {
          before.received_at = product.received_at; before.received_estimated = Boolean(product.received_estimated)
          after.received_at = first.order_date; after.received_estimated = false
          s.changed.date++
        }
      }
      if (Object.keys(after).length) {
        // a second import keeps the first "before", so Undo always goes back to how it was
        const prev = product.purchase_change as PurchaseChange | null | undefined
        const change: PurchaseChange = { at: today(), before: { ...before, ...(prev?.before ?? {}) }, after: { ...(prev?.after ?? {}), ...after } }
        const { error } = await client.from('products').update({ ...after, purchase_change: change }).eq('id', product.id)
        if (error) throw error
        s.changed.products++
      }
      const { error } = await client.from('purchases').update({ product_id: product.id, link_kind: 'bought', bucket: 'review', bucket_by: 'match' }).in('id', open.map((b) => b.id))
      if (error) throw error
    } catch (e) {
      s.errors.push(`${product.name}: ${(e as Error).message}`)
    }
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
  // the orders stay with the product as re-buys, so a later import doesn't match and change it again
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
