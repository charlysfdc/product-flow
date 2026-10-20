/**
 * The product lists behind Home's tiles and the Products page, from one snapshot:
 * Answers needed (edit reviews + deal questions), Film, Edit, Post (by platform, TikTok Shop deadlines
 * first), ViralVue updates, All products. Also the Stats and Housekeeping numbers that come from it.
 */
import type { Snapshot } from './data'
import { suggestProducts } from './deals'
import { publishRows } from './publish'
import { PLATFORM_LABEL, PLATFORM_ORDER, type Deal, type Job, type Listing, type Platform, type Post, type Product } from './types'
import { daysUntil } from '../components/ProductRow'

export type DealAsk = { deal: Deal; suggestion: { id: string; name: string } | null }
export type PostGroup = { key: string; label: string; items: Product[] }

export const SAMPLE_SOURCES = ['amazon_sample', 'tiktok_sample', 'brand_direct'] as const
export const isSample = (p: Pick<Product, 'source'>) => (SAMPLE_SOURCES as readonly string[]).includes(p.source)

export function byDeadlineThenName(a: Product, b: Product) {
  const da = a.deadline ?? '9999', db = b.deadline ?? '9999'
  return da < db ? -1 : da > db ? 1 : a.name.localeCompare(b.name)
}

/** Platforms a product is planned for and not yet posted on. */
export function unposted(p: Product, listings: Listing[], posts: Post[]): Platform[] {
  return publishRows(p, listings, posts).filter((r) => r.state === 'open').map((r) => r.platform)
}

/** A TikTok Shop sample whose posting deadline is within 7 days (or past), not posted yet. */
export const tiktokDue = (p: Product) =>
  p.status !== 'done' && p.source === 'tiktok_sample' && Boolean(p.deadline) && (daysUntil(p.deadline) ?? 99) <= 7

export interface Flow {
  asks: DealAsk[]
  reviews: { job: Job; product: Product }[]
  answers: number
  film: Product[]
  edit: Product[]
  post: PostGroup[]
  postCount: number
  postDue: number                // ready products with a TikTok Shop deadline within 7 days (the Post badge)
  due: Product[]                 // TikTok Shop deadlines within 7 days, any stage
  editing: Map<string, Job>      // latest active edit job per product
  completed: { product: Product; lastPosted: string | null; platforms: Platform[] }[]   // done, newest posted first
  all: Product[]
}

export function buildFlow(data: Snapshot): Flow {
  const { products, listings, posts, jobs, deals } = data
  const byId = new Map(products.map((p) => [p.id, p]))
  const sorted = [...products].sort(byDeadlineThenName)

  const lite = products.map((p) => ({ id: p.id, name: p.name, brand: p.brand }))
  const asks: DealAsk[] = deals.map((deal) => {
    const s = suggestProducts(deal, lite, 1)[0]
    return { deal, suggestion: s ? { id: s.id, name: s.name } : null }
  })
  const reviews = jobs
    .filter((j) => j.status === 'needs_review' && j.type === 'edit')
    .map((j) => ({ job: j, product: j.product_id ? byId.get(j.product_id) : undefined }))
    .filter((x): x is { job: Job; product: Product } => Boolean(x.product))

  // Post: TikTok Shop deadlines first, then one group per platform the product still needs
  const ready = sorted.filter((p) => p.status === 'ready')
  const groups = new Map<string, Product[]>()
  const dueReady = ready.filter(tiktokDue)
  if (dueReady.length) groups.set('due', dueReady)
  for (const p of ready) {
    if (tiktokDue(p)) continue
    const plats = unposted(p, listings, posts)
    for (const k of plats.length ? plats : ['none']) {
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(p)
    }
  }
  const post = ['due', ...PLATFORM_ORDER, 'none']
    .filter((k) => groups.has(k))
    .map((k) => ({ key: k, label: k === 'due' ? 'TikTok Shop due soon' : k === 'none' ? 'No platform yet' : PLATFORM_LABEL[k as Platform], items: groups.get(k)! }))

  const editing = new Map<string, Job>()
  for (const j of jobs) {
    if (j.type !== 'edit' || !j.product_id) continue
    const have = editing.get(j.product_id)
    if (!have || have.created_at < j.created_at) editing.set(j.product_id, j)
  }

  // Completed: posted everywhere, newest post first, with where it is posted
  const postedOn = new Map<string, { last: string | null; platforms: Set<Platform> }>()
  for (const po of posts) {
    if (po.status !== 'posted') continue
    const e = postedOn.get(po.product_id) ?? { last: null, platforms: new Set<Platform>() }
    e.platforms.add(po.platform)
    if (po.posted_at && (!e.last || po.posted_at > e.last)) e.last = po.posted_at
    postedOn.set(po.product_id, e)
  }
  const completed = products.filter((p) => p.status === 'done')
    .map((p) => ({ product: p, lastPosted: postedOn.get(p.id)?.last ?? null, platforms: PLATFORM_ORDER.filter((pl) => postedOn.get(p.id)?.platforms.has(pl)) }))
    .sort((a, b) => (b.lastPosted ?? '').localeCompare(a.lastPosted ?? '') || a.product.name.localeCompare(b.product.name))

  return {
    asks, reviews, answers: asks.length + reviews.length, completed,
    film: sorted.filter((p) => p.status === 'received' || p.status === 'expected'),
    edit: sorted.filter((p) => p.status === 'filmed' || p.status === 'editing'),
    post, postCount: ready.length, postDue: dueReady.length,
    due: sorted.filter(tiktokDue),
    editing,
    all: [...products].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export const preview = (items: { name: string }[], n = 2) => {
  const names = items.slice(0, n).map((p) => p.name).join(', ')
  return items.length > n ? `${names}…` : names
}

export function editLabel(j: Job | undefined): string | null {
  if (!j) return null
  if (j.status === 'needs_review') return 'Review the edit'
  if (j.status === 'queued') return 'Waiting for the worker'
  if (j.status === 'running') return `Editing · ${j.progress?.pct ?? 0}%`
  return null
}

// ---- Housekeeping fix-ups --------------------------------------------------

export type FixKind = 'details' | 'price' | 'source' | 'drive' | 'dupes'

export const FIX_LABEL: Record<FixKind, { title: string; help: string }> = {
  details: { title: 'Missing details', help: 'No picture or no Amazon listing. Find on Amazon fills the picture, brand, price and ASIN; after each one it moves on to the next.' },
  price: { title: 'Missing a price', help: 'Tap one and add what it costs (US $) on its Product screen.' },
  source: { title: 'Missing a source', help: 'Where it came from decides where it must be posted; set it on the Product screen.' },
  drive: { title: 'No Drive folder', help: 'Open one and tap Make Drive folder.' },
  dupes: { title: 'Possible duplicates', help: 'Products sharing an Amazon ASIN. If two are the same, open one and Merge into the other.' },
}

/** Products for a fix-up list; duplicates come in groups sharing one ASIN. */
export function fixups(data: Snapshot): Record<FixKind, Product[]> & { dupeGroups: { asin: string; items: Product[] }[] } {
  const { products, listings } = data
  const byId = new Map(products.map((p) => [p.id, p]))
  const byAsin = new Map<string, Set<string>>()
  for (const l of listings) {
    if (l.platform !== 'amazon_us' || !l.external_id || !byId.has(l.product_id)) continue
    const k = l.external_id.toUpperCase()
    if (!byAsin.has(k)) byAsin.set(k, new Set())
    byAsin.get(k)!.add(l.product_id)
  }
  const dupeGroups = [...byAsin.entries()].filter(([, ids]) => ids.size > 1)
    .map(([asin, ids]) => ({ asin, items: [...ids].map((id) => byId.get(id)!).sort((a, b) => a.name.localeCompare(b.name)) }))
  const name = (a: Product, b: Product) => a.name.localeCompare(b.name)
  const onAmazon = new Set(listings.filter((l) => l.platform === 'amazon_us').map((l) => l.product_id))
  return {
    details: products.filter((p) => !p.product_image_url || !onAmazon.has(p.id)).sort(name),
    price: products.filter((p) => p.price == null).sort(name),
    source: products.filter((p) => p.source === 'unknown').sort(name),
    drive: products.filter((p) => !p.drive_folder_id).sort(name),
    dupes: dupeGroups.flatMap((g) => g.items),
    dupeGroups,
  }
}

// ---- Stats -------------------------------------------------------------------

export const yearStart = () => `${new Date().getFullYear()}-01-01`
export const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const moneyShort = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

const sum = (items: Product[]) => items.reduce((n, p) => n + (p.price != null ? Number(p.price) : 0), 0)

/**
 * Products of one kind (samples / bought) and their value: this year by received date, plus the ones
 * with no date ("Date unknown"), never dropped; earlier years kept apart. Gaps: no price, no date.
 */
export function valueOf(products: Product[], which: 'sample' | 'bought') {
  const y0 = yearStart()
  const all = products.filter((p) => (which === 'sample' ? isSample(p) : p.source === 'bought'))
  const year = all.filter((p) => p.received_at && p.received_at >= y0)
  const unknown = all.filter((p) => !p.received_at)
  const earlier = all.filter((p) => p.received_at && p.received_at < y0)
  const items = [...year, ...unknown]          // what the block counts: this year + date unknown
  return {
    all, year, unknown, earlier, items,
    value: sum(items), yearValue: sum(year), unknownValue: sum(unknown), earlierValue: sum(earlier),
    priced: items.filter((p) => p.price != null).length,
    unpriced: all.filter((p) => p.price == null),
    undated: unknown,
    estimated: all.filter((p) => p.received_estimated).length,
  }
}

/** Average days from arrival to the first post, over products that have both. */
export function daysToPosted(products: Product[], posts: Post[]): { avg: number | null; n: number } {
  const first = new Map<string, string>()
  for (const po of posts) {
    if (po.status !== 'posted' || !po.posted_at) continue
    const have = first.get(po.product_id)
    if (!have || po.posted_at < have) first.set(po.product_id, po.posted_at)
  }
  let sum = 0, n = 0
  for (const p of products) {
    const at = first.get(p.id)
    if (!p.received_at || !at || at < p.received_at) continue
    sum += (new Date(at + 'T00:00:00').getTime() - new Date(p.received_at + 'T00:00:00').getTime()) / 86400000
    n++
  }
  return { avg: n ? Math.round((sum / n) * 10) / 10 : null, n }
}
