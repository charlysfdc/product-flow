// identify: what is this box? One of three inputs per call:
//   { upc }                 barcode → UPC databases (name, brand, image, ASIN) → Amazon search by UPC for the ASIN
//   { image, media_type }   photo of the packaging → Claude reads brand, product, variant (and a printed UPC)
//   { url }                 Amazon or TikTok Shop link → page title, image, ASIN / product id
//   { search }              Find on Amazon: up to 5 Amazon US results for a product name (picture, title, price, ASIN)
// The Amazon page logic is ported from Influencer-Workflow-Engine-Main amazon_utils.py,
// including its r.jina.ai reader fallback for when Amazon shows a captcha.
import Anthropic from 'npm:@anthropic-ai/sdk@0.135.0'
import { HttpError, serve } from '../_shared/http.ts'

interface Identification {
  name: string | null
  brand: string | null
  variant: string | null
  upc: string | null
  asin: string | null
  title: string | null
  image_url: string | null
  url: string | null
  platform: 'amazon' | 'tiktok' | null
  tiktok_product_id: string | null
  confidence: 'high' | 'medium' | 'low' | null
  note: string | null
  price: number | null         // the listed price on the Amazon page (US dollars), when it could be read
}

const empty = (): Identification => ({
  name: null, brand: null, variant: null, upc: null, asin: null, title: null, image_url: null,
  url: null, platform: null, tiktok_product_id: null, confidence: null, note: null, price: null,
})

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
}

/** r.jina.ai works without a key; JINA_API_KEY (optional secret) avoids its anonymous limits. */
function jinaHeaders(): Record<string, string> {
  const key = Deno.env.get('JINA_API_KEY')
  return { 'X-Return-Format': 'markdown', ...(key ? { Authorization: `Bearer ${key}` } : {}) }
}

async function fetchText(url: string, init: RequestInit = {}, ms = 20000): Promise<{ text: string; finalUrl: string; status: number }> {
  const res = await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(ms) })
  return { text: await res.text(), finalUrl: res.url || url, status: res.status }
}

const unescape = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
const clean = (s: string | null | undefined) => (s ? unescape(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null : null)

/** "Nextorch P82C Flashlight" from "NEXTORCH P82C Rechargeable Flashlight, 1600 Lumens ... ". */
function shortName(title: string | null, brand: string | null): string | null {
  let t = clean(title)
  if (!t) return null
  for (const sep of [' - ', ' | ', ', ', ' (', ' with ', ' for ', ' – ']) {
    const i = t.indexOf(sep)
    if (i >= 18) t = t.slice(0, i)
  }
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '')
  if (brand && !t.toLowerCase().includes(brand.toLowerCase())) t = `${brand} ${t}`
  return t.replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// ---- Amazon page (port of amazon_utils.py) ----------------------------------

const looksLikeCaptcha = (html: string) =>
  ['api-services-support@amazon.com', 'Enter the characters you see below', 'To discuss automated access to Amazon data'].some((m) => html.includes(m))

const isAmazon = (url: string) => /^https?:\/\/([^/]+\.)?amazon\.[a-z.]+(\/|$)/i.test(url) || /^https?:\/\/(a\.co|amzn\.to|amzn\.eu)\//i.test(url)
const isTikTok = (url: string) => /^https?:\/\/([^/]+\.)?tiktok\.com\//i.test(url)

function asinFrom(url: string): string | null {
  const m = url.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?#]|$)/i)
  return m ? m[1].toUpperCase() : null
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))
  return m ? unescape(m[2] ?? m[3] ?? '') : null
}
function meta(html: string, prop: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${prop}["'][^>]*>`, 'i')
  const tag = html.match(re)?.[0]
  return tag ? attr(tag, 'content') : null
}

function amazonTitle(html: string): string | null {
  const t = clean(html.match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/i)?.[1])
  if (t) return t
  const og = clean(meta(html, 'og:title'))
  if (og) return og
  let tt = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1])
  if (!tt) return null
  tt = tt.replace(/^Amazon[^:]*:\s*/, '').replace(/\s*[:\-|]\s*Amazon\.[a-z.]+.*$/i, '')
  return tt || null
}

function amazonImage(html: string): string | null {
  const tag = html.match(/<img[^>]*id="landingImage"[^>]*>/i)?.[0]
  if (tag) {
    const hires = attr(tag, 'data-old-hires')
    if (hires?.startsWith('http')) return hires
    const dyn = attr(tag, 'data-a-dynamic-image')
    if (dyn) {
      try {
        const urls = JSON.parse(dyn) as Record<string, [number, number]>
        const best = Object.entries(urls).sort((a, b) => b[1][0] * b[1][1] - a[1][0] * a[1][1])[0]
        if (best) return best[0]
      } catch { /* not JSON */ }
    }
    const src = attr(tag, 'src')
    if (src?.startsWith('http')) return src
  }
  const hi = html.match(/"hiRes"\s*:\s*"(https:\/\/[^"]+)"/)?.[1]
  if (hi) return hi
  const og = meta(html, 'og:image')
  return og?.startsWith('http') ? og : null
}

function amazonBrand(text: string): string | null {
  const byline = clean(text.match(/id="bylineInfo"[^>]*>([\s\S]*?)<\/a>/i)?.[1]) ?? text.match(/Visit the ([^\]\n]{2,40}?) Store/)?.[0] ?? null
  if (!byline) return null
  const m = byline.match(/Visit the (.+?) Store/i) ?? byline.match(/Brand:\s*(.+)/i)
  return clean(m ? m[1] : null)
}

/**
 * The listed price on an Amazon product page (HTML or the reader's text). Only the buy-box patterns,
 * so a price from "customers also bought" is never taken; null when unsure.
 */
function amazonPrice(text: string): number | null {
  const pick = (v: string | undefined) => {
    const n = v ? Number(v.replace(/,/g, '')) : NaN
    return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : null
  }
  return pick(text.match(/"priceAmount"\s*:\s*([\d.]+)/)?.[1])
    ?? pick(text.match(/id="corePrice[^"]*"[\s\S]{0,3000}?class="a-offscreen">\s*\$([\d,]+\.\d{2})/)?.[1])
    ?? pick(text.match(/id="priceblock_(?:our|deal|sale)price"[^>]*>\s*\$([\d,]+\.\d{2})/)?.[1])
    ?? pick(text.match(/(?:^|\n)\s*(?:-\d{1,2}%\s*)?\$([\d,]+\.\d{2})\s*(?:\n|$)[\s\S]{0,200}?(?:List Price|Typical price|FREE delivery|Ships from)/i)?.[1])
}

/** Large (1500 px) variant of an Amazon image URL. */
function hiResVariant(url: string): string {
  const m = url.match(/\/images\/I\/([A-Za-z0-9%+\-_]+?)(?:\._[^/]*)?\.(jpg|png)$/)
  return m ? `https://m.media-amazon.com/images/I/${m[1]}._AC_SL1500_.${m[2]}` : url
}

/** The page through the r.jina.ai reader proxy, which gets past Amazon's bot block. */
async function viaJina(url: string): Promise<{ title: string | null; image: string | null; brand: string | null; text: string; price: number | null }> {
  const { text } = await fetchText(`https://r.jina.ai/${url}`, { headers: jinaHeaders() }, 45000)
  if (looksLikeCaptcha(text)) return { title: null, image: null, brand: null, text: '', price: null }
  let title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? null
  if (title) title = title.replace(/^Amazon(\.[a-z.]+)?(\.com)?\s*:\s*/i, '').replace(/\s*[:\-|]\s*Amazon\.[a-z.]+.*$/i, '')
  const candidates = [...text.matchAll(/!\[([^\]]*)\]\((https:\/\/m\.media-amazon\.com\/images\/I\/[^)\s]+)\)/g)].map((m) => ({ alt: m[1], url: m[2] }))
  const norm = (s: string) => unescape(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  let image: string | null = null
  if (title) {
    const prefix = norm(title).slice(0, 40)
    for (const c of candidates) {
      const alt = norm(c.alt.replace(/^Image \d+:?\s*/, ''))
      if (alt.length > 10 && prefix.startsWith(alt.slice(0, 40).slice(0, prefix.length))) { image = c.url; break }
    }
  }
  if (!image) {
    // first reasonably sized product image: skip tiny sprites and banners
    image = candidates.find((c) => !/_(?:US|SR|SS|SX|SY|UL)(\d{1,2})[_,.]/.test(c.url) && c.url.includes('._AC_'))?.url ?? null
  }
  return { title, image, brand: amazonBrand(text), text, price: amazonPrice(text) }
}

/**
 * The Claude client. A key that belongs to no workspace also needs the workspace
 * id (optional secret ANTHROPIC_WORKSPACE_ID); a workspace key works on its own.
 */
function anthropic(): Anthropic | null {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return null
  const workspace = Deno.env.get('ANTHROPIC_WORKSPACE_ID')
  return new Anthropic({ apiKey, ...(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}) })
}

/**
 * One Claude request that survives an option the API turns down: on a 400 it
 * drops the newest option first (server-side fallback, then the JSON format)
 * and tries again. The answer is asked for as JSON in the prompt as well, so the
 * plain request still parses.
 */
// deno-lint-ignore no-explicit-any
async function createRobust(client: Anthropic, params: any): Promise<any> {
  const { betas: _b, fallbacks: _f, ...plain } = params
  const { format: _fmt, ...outputConfig } = plain.output_config ?? {}
  const attempts = [
    () => client.beta.messages.create(params),
    () => client.messages.create(plain),
    () => client.messages.create({ ...plain, output_config: outputConfig }),
  ]
  let last: unknown
  for (const attempt of attempts) {
    try {
      return await attempt()
    } catch (e) {
      last = e
      if (!(e instanceof Anthropic.BadRequestError)) throw e
      console.error('Claude 400, trying a simpler request:', (e as Error).message)
    }
  }
  throw last
}

/** Claude's own words from an API error, short enough for the phone. */
function apiMessage(e: unknown): string {
  // deno-lint-ignore no-explicit-any
  const err = e as any
  const msg = err?.error?.error?.message ?? err?.message ?? String(e)
  return String(msg).replace(/^\d{3}\s*/, '').slice(0, 220)
}

/**
 * Last resort when Amazon and the reader proxy are both blocked: Claude with
 * web search answers a narrow question (an ASIN's title, a barcode's product).
 */
async function webLookup(question: string): Promise<{ title: string | null; brand: string | null; asin: string | null } | null> {
  const client = anthropic()
  if (!client) return null
  // deno-lint-ignore no-explicit-any
  const messages: any[] = [{
    role: 'user',
    content: `${question}\nUse web search. Reply with one JSON object and nothing else: {"title": "...", "brand": "...", "asin": "..."}. Use "" for anything you could not confirm from a search result.`,
  }]
  try {
    // deno-lint-ignore no-explicit-any
    let res: any
    for (let i = 0; i < 3; i++) {
      // deno-lint-ignore no-explicit-any
      const params: any = {
        model: 'claude-opus-5-5', max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        output_config: { effort: 'low' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
        messages,
      }
      res = await createRobust(client, params)
      if (res.stop_reason !== 'pause_turn') break
      messages.push({ role: 'assistant', content: res.content })   // resume the paused server-side search
    }
    if (!res || res.stop_reason === 'refusal') return null
    // deno-lint-ignore no-explicit-any
    const text = (res.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('')
    const m = text.match(/\{[\s\S]*\}/g)?.pop()
    if (!m) return null
    const j = JSON.parse(m)
    const v = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null)
    const asin = v(j.asin)?.toUpperCase() ?? null
    return { title: v(j.title), brand: v(j.brand), asin: asin && /^[A-Z0-9]{10}$/.test(asin) ? asin : null }
  } catch (e) {
    console.error('web lookup failed', e)
    return null
  }
}

async function byAmazonUrl(url: string): Promise<Identification> {
  const out = { ...empty(), platform: 'amazon' as const, url }
  let title: string | null = null, image: string | null = null, brand: string | null = null, price: number | null = null
  let finalUrl = url
  try {
    const page = await fetchText(url, { headers: HEADERS }, 25000)
    finalUrl = page.finalUrl
    if (page.status < 400 && !looksLikeCaptcha(page.text)) {
      title = amazonTitle(page.text)
      image = amazonImage(page.text)
      brand = amazonBrand(page.text)
      price = amazonPrice(page.text)
    }
  } catch { /* blocked or timed out: try the reader */ }
  out.asin = asinFrom(finalUrl) ?? asinFrom(url)
  out.url = out.asin ? `https://www.amazon.com/dp/${out.asin}` : finalUrl
  if (!title || !image) {
    try {
      const j = await viaJina(out.url)
      title ??= j.title
      image ??= j.image
      brand ??= j.brand
      price ??= j.price
    } catch (e) {
      if (!title) out.note = `Amazon blocked the page and the reader fallback failed (${(e as Error).message}). Type the name instead.`
    }
  }
  if (!title && out.asin) {
    const w = await webLookup(`What product is listed on Amazon US with ASIN ${out.asin}?`)
    if (w?.title) {
      title = w.title
      brand ??= w.brand
      out.note = null
    }
  }
  out.title = title
  out.brand = brand
  out.price = price
  out.image_url = image ? hiResVariant(image) : null
  out.name = shortName(title, brand)
  out.confidence = title ? (image ? 'high' : 'medium') : null
  if (!title && !out.note) out.note = 'Could not read the product name from Amazon.'
  return out
}

async function byTikTokUrl(url: string): Promise<Identification> {
  const out = { ...empty(), platform: 'tiktok' as const, url }
  let html = ''
  try {
    const page = await fetchText(url, { headers: HEADERS }, 20000)
    out.url = page.finalUrl
    html = page.text
  } catch { /* fall through to the reader */ }
  const id = out.url!.match(/\/product\/(\d{6,})/)?.[1] ?? out.url!.match(/\/pdp\/[^/?#]*\/(\d{6,})/)?.[1] ?? out.url!.match(/(\d{15,})/)?.[1] ?? null
  out.tiktok_product_id = id
  let title = clean(meta(html, 'og:title')) ?? clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1])
  let image = meta(html, 'og:image')
  if (!title || /^TikTok/i.test(title)) {
    try {
      const { text } = await fetchText(`https://r.jina.ai/${out.url}`, { headers: jinaHeaders() }, 45000)
      title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? title
      image ??= text.match(/!\[[^\]]*\]\((https:\/\/[^)\s]+(?:jpe?g|png|webp|image)[^)\s]*)\)/i)?.[1] ?? null
    } catch { /* keep what we have */ }
  }
  title = title?.replace(/\s*[-|]\s*TikTok( Shop)?.*$/i, '').trim() || null
  out.title = title
  out.image_url = image
  out.name = shortName(title, null)
  out.confidence = title ? 'medium' : null
  if (!title) out.note = 'Could not read the TikTok Shop page. Type the name instead.'
  return out
}

async function byUrl(url: string): Promise<Identification> {
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, 'That is not a link.')
  let target = url
  if (!isAmazon(url) && !isTikTok(url)) {
    // short links (a.co, amzn.to, vm.tiktok.com) are resolved first
    try { target = (await fetchText(url, { headers: HEADERS }, 15000)).finalUrl } catch { /* keep the original */ }
  }
  if (isAmazon(target)) return byAmazonUrl(target)
  if (isTikTok(target)) return byTikTokUrl(target)
  const out = { ...empty(), url: target }
  try {
    const { text } = await fetchText(target, { headers: HEADERS }, 20000)
    out.title = clean(meta(text, 'og:title')) ?? clean(text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1])
    out.image_url = meta(text, 'og:image')
    out.name = shortName(out.title, null)
    out.confidence = out.title ? 'medium' : null
  } catch (e) {
    out.note = `Could not open the link (${(e as Error).message}).`
  }
  return out
}

// ---- barcode ------------------------------------------------------------------

async function upcItemDb(code: string): Promise<Partial<Identification> | null> {
  try {
    const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) })
    if (!res.ok) return null
    const j = await res.json()
    const it = j?.items?.[0]
    if (!it?.title) return null
    const variant = [it.color, it.size].filter(Boolean).join(', ') || null
    return { title: clean(it.title), brand: clean(it.brand), variant, asin: it.asin || null, image_url: it.images?.[0] ?? null }
  } catch {
    return null
  }
}

/** Open Products Facts / Open Beauty Facts: free, no key, decent for beauty and household. */
async function openFacts(code: string): Promise<Partial<Identification> | null> {
  for (const host of ['world.openbeautyfacts.org', 'world.openproductsfacts.org', 'world.openfoodfacts.org']) {
    try {
      const res = await fetch(`https://${host}/api/v2/product/${code}.json?fields=product_name,brands,image_front_url,quantity`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) continue
      const j = await res.json()
      const p = j?.product
      if (j?.status === 1 && p?.product_name) {
        return { title: clean(p.product_name), brand: clean(String(p.brands ?? '').split(',')[0]), variant: clean(p.quantity), image_url: p.image_front_url ?? null }
      }
    } catch { /* next source */ }
  }
  return null
}

/** First Amazon search result for the barcode digits, through the reader proxy. */
async function amazonSearch(code: string): Promise<{ asin: string; title: string } | null> {
  try {
    const { text } = await fetchText(`https://r.jina.ai/https://www.amazon.com/s?k=${code}`, { headers: jinaHeaders() }, 45000)
    if (looksLikeCaptcha(text)) return null
    for (const m of text.matchAll(/\[([^\]]{15,300})\]\((https:\/\/www\.amazon\.com\/[^)\s]*?\/dp\/([A-Z0-9]{10})[^)\s]*)\)/g)) {
      const title = clean(m[1].replace(/^!\[[^\]]*\]\([^)]*\)\s*/, ''))
      if (title && !/sponsored/i.test(title) && !/^image/i.test(title)) return { asin: m[3], title }
    }
  } catch { /* no result */ }
  return null
}

// ---- search by name (Find on Amazon) ---------------------------------------------

export interface Candidate { asin: string; title: string; brand: string | null; image_url: string | null; price: number | null; url: string }

/** Result blocks of an Amazon search page (HTML, straight or through the reader): organic first, one per ASIN. */
function parseSearch(html: string): Candidate[] {
  const blocks = html.split(/(?=<div[^>]+data-component-type="s-search-result")/).slice(1)
  const seen = new Map<string, Candidate & { sponsored: boolean }>()
  for (const b of blocks) {
    const asin = b.match(/data-asin="([A-Z0-9]{10})"/)?.[1]
    if (!asin) continue
    const sponsored = /Sponsored/.test(b.slice(0, 4000))
    const heads = [...b.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => clean(m[1])).filter((t): t is string => Boolean(t))
    const alt = clean(b.match(/<img[^>]+class="s-image"[^>]*alt="([^"]*)"/)?.[1] ?? b.match(/<img[^>]+alt="([^"]*)"[^>]+class="s-image"/)?.[1])
    // the product picture's alt text is the listing title; headings later in a block can belong to a carousel
    const title = (alt && alt.length > 10 ? alt : [...heads.slice(0, 2)].sort((x, y) => y.length - x.length)[0]) || null
    if (!title) continue
    const brand = heads.length > 1 && heads[0].length < 40 ? heads[0] : null
    const img = b.match(/<img[^>]+class="s-image"[^>]+src="([^"]+)"/)?.[1] ?? b.match(/<img[^>]+src="([^"]+)"[^>]+class="s-image"/)?.[1] ?? null
    const pr = b.match(/<span class="a-offscreen">\$([\d,]+\.\d{2})<\/span>/)?.[1]
    const price = pr ? Number(pr.replace(/,/g, '')) : null
    const c = { asin, title, brand, image_url: img ? hiResVariant(img) : null, price, url: `https://www.amazon.com/dp/${asin}`, sponsored }
    const have = seen.get(asin)
    if (!have || (have.sponsored && !sponsored)) seen.set(asin, c)
  }
  return [...seen.values()].sort((a, b) => Number(a.sponsored) - Number(b.sponsored)).map(({ sponsored: _s, ...c }) => c)
}

/**
 * Amazon US search for a product name: the page itself, else through the reader (HTML mode, which keeps
 * the result blocks). Says so when Amazon blocks both rather than guessing.
 */
async function searchAmazon(query: string): Promise<{ candidates: Candidate[]; note: string | null; via: string | null }> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 150)
  if (q.length < 3) throw new HttpError(400, 'Type a few words of the product name.')
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(q)}`
  const tries: [string, () => Promise<string>][] = [
    ['amazon', async () => {
      const page = await fetchText(url, { headers: HEADERS }, 20000)
      return page.status < 400 ? page.text : ''
    }],
    ['reader', async () => (await fetchText(`https://r.jina.ai/${url}`, { headers: { ...jinaHeaders(), 'X-Return-Format': 'html' } }, 45000)).text],
  ]
  const blocked: string[] = []
  for (const [via, get] of tries) {
    try {
      const html = await get()
      if (!html || looksLikeCaptcha(html)) { blocked.push(via); continue }
      const candidates = parseSearch(html).slice(0, 5)
      if (candidates.length) return { candidates, note: null, via }
      blocked.push(via)
    } catch (e) {
      console.error('search', via, (e as Error).message)
      blocked.push(via)
    }
  }
  return { candidates: [], via: null, note: 'Amazon blocked the search right now. Paste the product’s Amazon link instead (Share → Copy Link in the Amazon app).' }
}

async function byUpc(raw: string): Promise<Identification> {
  const code = raw.replace(/\D/g, '')
  if (code.length < 8) throw new HttpError(400, 'That barcode is too short.')
  const out = { ...empty(), upc: code }
  // UPC-A is often read as EAN-13 with a leading 0; try both forms
  const forms = Array.from(new Set([code, code.length === 13 && code.startsWith('0') ? code.slice(1) : code]))
  let hit: Partial<Identification> | null = null
  for (const f of forms) {
    hit = (await upcItemDb(f)) ?? (await openFacts(f))
    if (hit) break
  }
  if (hit) Object.assign(out, hit)
  if (!out.asin) {
    const s = await amazonSearch(forms[forms.length - 1])
    if (s) {
      out.asin = s.asin
      if (!out.title) {
        out.title = s.title
        out.note = 'Found through an Amazon search for the barcode; check it is the same product.'
        out.confidence = 'low'
      }
    }
  }
  if (!out.title) {
    const w = await webLookup(`Which product has the UPC/EAN barcode ${code}? If it is sold on Amazon US, include its ASIN.`)
    if (w?.title) {
      out.title = w.title
      out.brand ??= w.brand
      out.asin ??= w.asin
      out.note = 'Found through a web search for the barcode; check it is the same product.'
      out.confidence = 'low'
    }
  }
  out.name = shortName(out.title, out.brand)
  out.confidence ??= out.title ? 'high' : null
  return out
}

// ---- photo → Claude -----------------------------------------------------------------

const PHOTO_SCHEMA = {
  type: 'object',
  properties: {
    brand: { type: 'string', description: 'Brand as printed on the packaging, or empty' },
    product: { type: 'string', description: 'Model and product type, e.g. "P82C Flashlight", or empty' },
    variant: { type: 'string', description: 'Colour, size, scent or count if printed, or empty' },
    name: { type: 'string', description: 'Short folder name: brand, model, product type, at most 6 words' },
    upc: { type: 'string', description: 'Barcode digits only if they are clearly legible in the photo, else empty' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    note: { type: 'string', description: 'One short sentence if something is unclear, else empty' },
  },
  required: ['brand', 'product', 'variant', 'name', 'upc', 'confidence', 'note'],
  additionalProperties: false,
}

const PHOTO_SYSTEM = `You identify products from a photo of their packaging for a product reviewer who logs every box that arrives.
Read only what is printed on the box or label. Leave a field empty rather than guessing; never invent a brand that is not printed.
The name is how the product's folder will be called: brand, then model or product line, then what the product is, with no marketing words. Examples: "Nextorch P82C Flashlight", "Plaud Notepen", "Baskbed Comforter", "Wonderskin Brow Stain".`

async function byPhoto(image: string, mediaType: string): Promise<Identification> {
  const client = anthropic()
  if (!client) throw new HttpError(500, 'Reading photos needs the Anthropic API key in the Supabase Edge Function secrets (ANTHROPIC_API_KEY).')
  if (image.length > 7_000_000) throw new HttpError(400, 'That photo is too large.')
  // deno-lint-ignore no-explicit-any
  const params: any = {
    model: 'claude-opus-5-5',
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: PHOTO_SCHEMA } },
    system: PHOTO_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType === 'image/png' ? 'image/png' : 'image/jpeg', data: image } },
        { type: 'text', text: 'What product is this? Reply with one JSON object with the keys brand, product, variant, name, upc, confidence (high, medium or low) and note; use "" for anything not visible.' },
      ],
    }],
  }
  let res
  try {
    res = await createRobust(client, params)
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(500, 'The Anthropic API key in the Supabase secrets was rejected.')
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'Claude is busy right now; try again in a minute.')
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `Claude could not read the photo (${e.status ?? 'error'}: ${apiMessage(e)}).`)
    throw e
  }
  if (res.stop_reason === 'refusal') throw new HttpError(422, 'Claude declined to read this photo. Type the name instead.')
  // deno-lint-ignore no-explicit-any
  const text = (res.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('')
  let got: Record<string, string>
  try {
    got = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text)
  } catch {
    throw new HttpError(502, 'Claude’s answer could not be read. Try the photo again.')
  }
  const v = (s: string | undefined) => (s && s.trim() ? s.trim() : null)
  const out: Identification = {
    ...empty(),
    brand: v(got.brand),
    variant: v(got.variant),
    name: v(got.name) ?? shortName([got.brand, got.product].filter(Boolean).join(' '), null),
    title: [v(got.brand), v(got.product)].filter(Boolean).join(' ') || null,
    upc: v(got.upc)?.replace(/\D/g, '') || null,
    confidence: (got.confidence as Identification['confidence']) ?? null,
    note: v(got.note),
  }
  // a legible barcode on the photo: add the ASIN and image from the UPC lookup
  if (out.upc && out.upc.length >= 8) {
    try {
      const u = await byUpc(out.upc)
      out.asin = u.asin
      out.image_url = u.image_url
    } catch { /* keep Claude's reading */ }
  }
  return out
}

serve(async (body) => {
  if (typeof body.search === 'string') return searchAmazon(body.search)
  if (typeof body.upc === 'string' && body.upc) return byUpc(body.upc)
  if (typeof body.url === 'string' && body.url) return byUrl(body.url.trim())
  if (typeof body.image === 'string' && body.image) return byPhoto(body.image, String(body.media_type ?? 'image/jpeg'))
  throw new HttpError(400, 'Send a barcode, a photo or a link.')
})
