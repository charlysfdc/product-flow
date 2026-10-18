/**
 * Dev-only demo mode: `npm run dev`, then open /?demo=1 (and /?demo=0 to leave).
 * Serves sample rows in place of Supabase so screens can be checked without
 * signing in. Never part of the production build (only imported when DEV).
 */
const P = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, brand: null, variant: null, upc: null, source: 'amazon_sample', status: 'received', deadline: null,
  drive_folder_id: null, drive_folder_name: null, extra_drive_folders: [], product_image_url: null,
  received_at: '2026-10-16', notes: null, updated_at: '2026-10-18T09:00:00Z', ...extra,
})
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

const products = [
  P('p1', 'Coconut Curl Cream', { brand: 'Kitsch', status: 'ready', source: 'tiktok_sample', deadline: inDays(0), drive_folder_id: 'x1' }),
  P('p2', 'Wonderskin Brow Stain', { brand: 'Wonderskin', status: 'ready', source: 'tiktok_sample', deadline: inDays(1), drive_folder_id: 'x2' }),
  P('p3', 'Wonderskin Blush Stick', { brand: 'Wonderskin', status: 'filmed', source: 'tiktok_sample', deadline: inDays(2) }),
  P('p4', 'Baskbed comforter', { brand: 'Baskbed', status: 'received' }),
  P('p5', 'MR MIRYE shower steamers', { brand: 'MR MIRYE', status: 'received', received_at: '2026-10-09' }),
  P('p6', 'Nextorch P82C Flashlight', { brand: 'NEXTORCH', status: 'filmed', received_at: '2026-09-26', drive_folder_id: 'x6', drive_folder_name: 'Nextorch P82C Flashlight' }),
  P('p7', 'Plaud Notepen', { brand: 'Plaud', status: 'filmed' }),
  P('p8', 'Nextorch P91 Flashlight', { brand: 'NEXTORCH', status: 'filmed' }),
  P('p9', 'Flashforge AD5X', { brand: 'Flashforge', status: 'ready' }),
  P('p10', 'Eufy Robot Vacuum', { brand: 'Eufy', status: 'done' }),
]
const listings = [
  { id: 'l1', product_id: 'p6', platform: 'amazon_us', external_id: null, url: null, commission: null, availability: 'unchecked', availability_note: null, checked_at: null },
  { id: 'l2', product_id: 'p6', platform: 'tiktok_shop', external_id: null, url: null, commission: null, availability: 'unchecked', availability_note: 'Not checked yet', checked_at: null },
  { id: 'l3', product_id: 'p1', platform: 'tiktok_shop', external_id: null, url: null, commission: '17% (~$5.10)', availability: 'exact', availability_note: 'Yes - Kitsch official', checked_at: '2026-10-17' },
  { id: 'l4', product_id: 'p1', platform: 'amazon_us', external_id: 'B0GJG8N8N7', url: 'https://www.amazon.com/dp/B0GJG8N8N7', commission: null, availability: 'exact', availability_note: null, checked_at: null },
  { id: 'l5', product_id: 'p9', platform: 'tiktok_shop', external_id: null, url: null, commission: null, availability: 'exact', availability_note: null, checked_at: null },
]
const posts = [
  { id: 'po1', product_id: 'p1', platform: 'amazon_us', status: 'posted', external_id: 'v1', title: 'Curl Hair Cream', url: null, posted_at: '2026-04-30', views: 1509 },
]
const deal = (id: string, brand: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, platform: 'amazon_us', external_id: id, product_id: null, brand, asin: 'B0TESTASIN', title, price: 39.99, fee: null, image_url: null,
  message_sent_at: '2026-09-03T12:00:00Z', received_at: null, video_created_at: null, published_at: null,
  deal_created_at: '2026-09-02T12:00:00Z', deal_updated_at: null, status_raw: 'awaiting_response', match_status: 'waiting', link_added: null, imported_at: '2026-10-18T00:00:00Z', ...extra,
})
const deals = [
  deal('d1', 'Baskbed', 'Baskbed Queen Comforter Set, Ultra Soft Down Alternative', { match_status: 'needs_review', received_at: '2026-10-10T00:00:00Z' }),
  deal('d2', 'Plaud', 'PLAUD NotePen AI Voice Recorder Pen', { match_status: 'needs_review', received_at: '2026-10-12T00:00:00Z' }),
  deal('d3', 'NEXTORCH', 'NEXTORCH P82C Rechargeable Flashlight 1600 Lumens', { product_id: 'p6', match_status: 'matched', received_at: '2026-09-26T00:00:00Z' }),
  deal('d4', 'Govee', 'Govee RGBIC Floor Lamp'),
]
const tables: Record<string, Record<string, unknown>[]> = { products, listings, posts, deals, jobs: [], media: [], profiles: [] }

function applyFilters(rows: Record<string, unknown>[], params: URLSearchParams) {
  let out = rows
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'or'].includes(k)) continue
    const [op, ...rest] = v.split('.')
    const val = rest.join('.')
    if (op === 'eq') out = out.filter((r) => String(r[k]) === val)
    else if (op === 'neq') out = out.filter((r) => String(r[k]) !== val)
    else if (op === 'is' && val === 'null') out = out.filter((r) => r[k] == null)
    else if (op === 'in') { const set = val.replace(/^\(|\)$/g, '').split(','); out = out.filter((r) => set.includes(String(r[k]))) }
    else if (op === 'ilike') { const re = new RegExp('^' + val.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*') + '$', 'i'); out = out.filter((r) => re.test(String(r[k] ?? ''))) }
  }
  const limit = Number(params.get('limit'))
  return limit ? out.slice(0, limit) : out
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } })

export const demoFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const method = (init?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers)
  if (url.pathname.startsWith('/functions/v1/')) {
    await new Promise((r) => setTimeout(r, 900))
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (url.pathname.endsWith('/identify')) return json({ name: 'Nextorch P91 Flashlight', brand: 'NEXTORCH', variant: 'Black', upc: body.upc ?? null, asin: null, title: 'NEXTORCH P91 Tactical Flashlight', image_url: null, url: body.url ?? null, platform: null, tiktok_product_id: null, confidence: 'high', note: null })
    if (body.action === 'status') return json({ connected: false, email: null, products_folder_id: null })
    return json({ folder_id: 'demo', folder_name: 'demo', created: true, media_id: 'm', drive_file_id: 'f' })
  }
  const m = url.pathname.match(/\/rest\/v1\/(\w+)/)
  if (!m) return json({})
  const table = tables[m[1]] ?? []
  if (method === 'GET' || method === 'HEAD') {
    const rows = applyFilters(table, url.searchParams)
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `0-0/${m[1] === 'deals' ? (url.searchParams.get('or') ? 201 : 4271) : rows.length}` } })
    if ((headers.get('Accept') ?? '').includes('vnd.pgrst.object')) return rows[0] ? json(rows[0]) : json({ message: 'not found' }, { status: 406 })
    return json(rows)
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(String(init?.body ?? '{}'))
    for (const r of applyFilters(table, url.searchParams)) Object.assign(r, patch)
    return json([])
  }
  if (method === 'POST') {
    const row = { id: `new${Date.now()}`, ...JSON.parse(String(init?.body ?? '{}')) }
    table.push(row)
    return (headers.get('Accept') ?? '').includes('vnd.pgrst.object') ? json(row) : json([row])
  }
  return json([])
}

/** A signed-in-looking session in local storage so the app skips the sign-in screen. */
export function seedDemoSession(storageKey: string) {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400
  const user = { id: '00000000-0000-0000-0000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'demo@example.com', user_metadata: { full_name: 'Charly Demo' }, app_metadata: {}, created_at: '2026-10-18T00:00:00Z' }
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, exp, role: 'authenticated', email: user.email })}.demo`
  localStorage.setItem(storageKey, JSON.stringify({ access_token: token, refresh_token: 'demo', token_type: 'bearer', expires_in: 30 * 86400, expires_at: exp, user }))
}
