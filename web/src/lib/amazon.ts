/**
 * Find on Amazon: bring a product without a deal (bought, brand direct, older ones) up to the detail
 * a ViralVue product has: picture, brand, ASIN listing, price. Fills only what is empty.
 */
import { supabase } from './supabase'
import { callFunction, type Identification } from './functions'
import type { Product } from './types'

export interface Candidate { asin: string; title: string; brand: string | null; image_url: string | null; price: number | null; url: string }

/** Up to 5 Amazon US results for a name; a note instead when Amazon blocks the search. */
export const searchAmazon = (query: string) =>
  callFunction<{ candidates: Candidate[]; note: string | null; via: string | null }>('identify', { search: query }, 70_000)

/** An ASIN in a pasted link (amazon.com/dp/…, /gp/product/…) or a bare ASIN. */
export function asinIn(text: string): string | null {
  const t = text.trim()
  if (/^[A-Z0-9]{10}$/i.test(t)) return t.toUpperCase()
  return t.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?#]|$)/i)?.[1]?.toUpperCase() ?? null
}

/** A pasted link, short link (a.co, amzn.to) or ASIN → one candidate, from the product page. */
export async function lookupLink(text: string): Promise<Candidate> {
  const t = text.trim()
  const asin = asinIn(t)
  const url = asin ? `https://www.amazon.com/dp/${asin}` : /^https?:\/\//i.test(t) ? t : `https://${t}`
  const r = await callFunction<Identification>('identify', { url }, 70_000)
  const found = r.asin ?? asin
  if (!found) throw new Error(r.note ?? 'No Amazon product was found at that link.')
  if (!r.title && !r.image_url) throw new Error(r.note ?? 'Amazon did not show that product page right now; try again in a minute.')
  return { asin: found, title: r.title ?? found, brand: r.brand, image_url: r.image_url, price: r.price ?? null, url: `https://www.amazon.com/dp/${found}` }
}

/** The brand (and price) from the product page, for a search result that lacked them; never throws. */
export async function enrich(c: Candidate): Promise<Candidate> {
  if (c.brand && c.price != null) return c
  try {
    const r = await callFunction<Identification>('identify', { url: c.url }, 45_000)
    return { ...c, brand: c.brand ?? r.brand, price: c.price ?? r.price ?? null, image_url: c.image_url ?? r.image_url }
  } catch {
    return c
  }
}

/** What applying a candidate would fill on this product (only empty fields; the listing only if none). */
export function wouldFill(p: Product, hasAmazonListing: boolean, c: Candidate) {
  return {
    listing: !hasAmazonListing,
    picture: !p.product_image_url && Boolean(c.image_url),
    brand: !p.brand && Boolean(c.brand),
    price: p.price == null && c.price != null,
  }
}

/** Applies a confirmed candidate. Returns the labels of what was filled. */
export async function applyCandidate(p: Product, c: Candidate): Promise<string[]> {
  const { data: have, error: le } = await supabase.from('listings').select('id').eq('product_id', p.id).eq('platform', 'amazon_us').limit(1)
  if (le) throw new Error(le.message)
  const filled: string[] = []
  if (!have?.length) {
    const { error } = await supabase.from('listings').insert({
      product_id: p.id, platform: 'amazon_us', external_id: c.asin, url: c.url,
      availability: 'exact', availability_note: 'Found on Amazon', checked_at: new Date().toISOString().slice(0, 10),
    })
    if (error) throw new Error(error.message)
    filled.push(`Amazon US listing ${c.asin}`)
  }
  const patch: Partial<Product> = {}
  if (!p.product_image_url && c.image_url) { patch.product_image_url = c.image_url; filled.push('picture') }
  if (!p.brand && c.brand) { patch.brand = c.brand; filled.push(`brand ${c.brand}`) }
  if (p.price == null && c.price != null) { patch.price = c.price; filled.push(`price $${c.price.toFixed(2)}`) }
  if (Object.keys(patch).length) {
    const { error } = await supabase.from('products').update(patch).eq('id', p.id)
    if (error) throw new Error(error.message)
  }
  return filled
}
