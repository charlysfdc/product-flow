/**
 * Dev-only demo mode: `npm run dev`, then open /?demo=1 (and /?demo=0 to leave).
 * Serves sample rows in place of Supabase so screens can be checked without
 * signing in. Never part of the production build (only imported when DEV).
 */
const P = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, brand: null, variant: null, upc: null, source: 'amazon_sample', status: 'received', deadline: null,
  drive_folder_id: null, drive_folder_name: null, extra_drive_folders: [], product_image_url: null,
  received_at: '2026-10-16', notes: null, price: null, updated_at: '2026-10-18T09:00:00Z', ...extra,
})
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

const products = [
  P('p1', 'Coconut Curl Cream', { brand: 'Kitsch', status: 'ready', source: 'tiktok_sample', deadline: inDays(0), drive_folder_id: 'x1' }),
  P('p2', 'Wonderskin Brow Stain', { brand: 'Wonderskin', status: 'ready', source: 'tiktok_sample', deadline: inDays(1), drive_folder_id: 'x2' }),
  P('p3', 'Wonderskin Blush Stick', { brand: 'Wonderskin', status: 'filmed', source: 'tiktok_sample', deadline: inDays(2) }),
  P('p4', 'Baskbed comforter', { brand: 'Baskbed', status: 'received', source: 'tiktok_sample', deadline: inDays(3) }),
  P('p5', 'MR MIRYE shower steamers', { brand: 'MR MIRYE', status: 'received', received_at: '2026-10-09' }),
  P('p6', 'Nextorch P82C Flashlight', { brand: 'NEXTORCH', status: 'filmed', received_at: '2026-09-26', drive_folder_id: 'x6', drive_folder_name: 'Nextorch P82C Flashlight' }),
  P('p7', 'Plaud Notepen', { brand: 'Plaud', status: 'editing', drive_folder_id: 'x7' }),
  P('p8', 'Castor Oil', { brand: 'Sky Organics', status: 'editing', drive_folder_id: 'x8', deadline: inDays(1) }),
  P('p9', 'Flashforge AD5X', { brand: 'Flashforge', status: 'ready', source: 'bought', received_at: null, price: 289 }),
  P('p10', 'Eufy Robot Vacuum', { brand: 'Eufy', status: 'done', received_at: '2026-07-05', received_estimated: true }),
  P('p13', 'IMG_2231 kitchen', { status: 'ready', source: 'unknown', drive_folder_id: 'x13' }),
  P('p12', 'Blood Pressure Monitor', { brand: 'Omron', price: 39.99, status: 'ready', drive_folder_id: 'x12', received_at: '2026-10-02' }),
]
const listings = [
  { id: 'l1', product_id: 'p6', platform: 'amazon_us', external_id: null, url: null, commission: null, availability: 'unchecked', availability_note: null, checked_at: null },
  { id: 'l2', product_id: 'p6', platform: 'tiktok_shop', external_id: null, url: null, commission: null, availability: 'unchecked', availability_note: 'Not checked yet', checked_at: null },
  { id: 'l3', product_id: 'p1', platform: 'tiktok_shop', external_id: null, url: null, commission: '17% (~$5.10)', availability: 'exact', availability_note: 'Yes - Kitsch official', checked_at: '2026-10-17' },
  { id: 'l4', product_id: 'p1', platform: 'amazon_us', external_id: 'B0GJG8N8N7', url: 'https://www.amazon.com/dp/B0GJG8N8N7', commission: null, availability: 'exact', availability_note: null, checked_at: null },
  { id: 'l5', product_id: 'p9', platform: 'tiktok_shop', external_id: null, url: null, commission: null, availability: 'exact', availability_note: null, checked_at: null },
  ...['amazon_us', 'amazon_ca', 'amazon_uk', 'amazon_de'].map((pl, i) => ({ id: `l12${i}`, product_id: 'p12', platform: pl, external_id: 'B0BPM12345', url: null, commission: null, availability: 'exact', availability_note: null, checked_at: null })),
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
  deal('d5', 'Omron', 'Omron Platinum Blood Pressure Monitor, Upper Arm', { asin: 'B0BPM12345', product_id: 'p12', match_status: 'matched', received_at: '2026-10-02T00:00:00Z', message_sent_at: null }),
]
const reminders: Record<string, unknown>[] = [
  { id: 'r1', deal_id: 'd3', kind: 'received', created_at: '2026-10-18T10:00:00Z', done_at: null },
  { id: 'r2', deal_id: 'd5', kind: 'message', created_at: '2026-10-18T10:00:00Z', done_at: null },
]
const media = [
  { id: 'm1', product_id: 'p6', kind: 'raw_clip', drive_file_id: 'fx1', filename: 'IMG_4412.MOV', duration_s: 48.2, width: 1080, height: 1920, shot_on: 'Charly’s iPhone', uploaded_by: 'u', size_bytes: 412_000_000, codec: 'hevc', uploaded_at: '2026-10-11T10:00:00Z' },
  { id: 'm2', product_id: 'p6', kind: 'raw_clip', drive_file_id: 'fx2', filename: 'IMG_4413.MOV', duration_s: 131, width: 1920, height: 1080, shot_on: null, uploaded_by: null, size_bytes: 1_310_000_000, codec: null, uploaded_at: '2026-10-11T10:05:00Z' },
]
// Phase 3 demo: one edit running (p7), one waiting for review (p8). Review videos come from
// http://localhost:8788 (serve a folder with v.mp4, h.mp4, t.jpg there, e.g. python3 -m http.server 8788).
const now = new Date().toISOString()
const jobs: Record<string, unknown>[] = [
  // voice-over steps (the script is a real one from the Airplane Bluetooth Audio Adapter test, 20 Oct 2026)
  { id: 'j3', product_id: 'p3', type: 'edit', status: 'needs_review', question: 'No talking found in these clips. Create a voice-over?', created_at: now, updated_at: now, input: {}, log: null,
    output: { stage: 'ask_voiceover', speech: { words: 15, spoken_s: 4.1, footage_s: 30.6, background_only: true }, progress: { step: 'Waiting for your answer', pct: 100 } } },
  { id: 'j4', product_id: 'p4', type: 'edit', status: 'needs_review', question: 'Read the voice-over script.', created_at: now, updated_at: now, input: { voiceover: 'script' }, log: null,
    output: { stage: 'script', clips: {"c1": "IMG_2959.MOV"}, words: {"vertical": 95, "horizontal": 216}, progress: { step: 'Script ready to read', pct: 100 },
      vo_plan: {"hook": "Wireless earbuds on the airplane screen", "keys": ["earbuds", "airplane", "headphone", "buttons", "INCORIC", "upgrade"], "music": "", "footage": "One landscape clip filmed on a plane: the white INCORIC adapter plugged into the seat-back headphone jack, hanging and swinging, held in hand to show its buttons and lights, and wide shots of the seat-back screen with the adapter attached. Usable for showing what it is and where it plugs in, though a few moments are blurry or swinging and the clip never shows earbuds pairing or sound playing.", "concerns": "Only one clip. It never shows earbuds pairing, the sound actually playing, charging or TV use, so the script stays with what is visible. The start of the clip is blurry and some moments swing. The original audio is a pilot announcement and should be muted under the voice-over.", "vertical": [{"say": "Your wireless earbuds can work with the airplane screen.", "shots": [{"clip": "c1", "start": 16, "rotate": "none"}], "seconds": 3}, {"say": "This little white box plugs right into the headphone jack on the seat in front of you.", "shots": [{"clip": "c1", "start": 3.5, "rotate": "none"}, {"clip": "c1", "start": 25.5, "rotate": "none"}], "seconds": 5.7}, {"say": "Then it just hangs there, out of the way, while you watch your movie.", "shots": [{"clip": "c1", "start": 27.5, "rotate": "none"}, {"clip": "c1", "start": 18.5, "rotate": "none"}], "seconds": 4.7}, {"say": "No tangled cord across your lap, no cheap airline headphones.", "shots": [{"clip": "c1", "start": 6.5, "rotate": "none"}], "seconds": 3.3}, {"say": "It has proper buttons on the front, so you can feel your way around in the dark.", "shots": [{"clip": "c1", "start": 9.5, "rotate": "none"}, {"clip": "c1", "start": 12, "rotate": "none"}], "seconds": 5.7}, {"say": "Little lights show you it is on.", "shots": [{"clip": "c1", "start": 12.8, "rotate": "none"}], "seconds": 2.7}, {"say": "It's the INCORIC Bluetooth audio adapter, and it's small enough to live in any travel bag.", "shots": [{"clip": "c1", "start": 20, "rotate": "none"}, {"clip": "c1", "start": 28, "rotate": "none"}], "seconds": 4.7}, {"say": "Easiest seat upgrade there is.", "shots": [{"clip": "c1", "start": 28.5, "rotate": "none"}], "seconds": 2}], "thumbnail": {"clip": "c1", "text": "Your earbuds on planes", "time": 4.6, "text_position": "top"}, "horizontal": [{"say": "This is the INCORIC Bluetooth audio adapter, and I took it on a flight to try it out.", "shots": [{"clip": "c1", "start": 16, "rotate": "none"}, {"clip": "c1", "start": 3.5, "rotate": "none"}], "seconds": 6}, {"say": "It is a small white box with a short cord and a headphone plug on the end.", "shots": [{"clip": "c1", "start": 9.5, "rotate": "none"}, {"clip": "c1", "start": 4, "rotate": "none"}], "seconds": 5.7}, {"say": "The idea is simple. You plug it into the headphone jack on the seat-back screen, and it sends the sound to your wireless earbuds.", "shots": [{"clip": "c1", "start": 15.5, "rotate": "none"}, {"clip": "c1", "start": 26, "rotate": "none"}], "seconds": 8.3}, {"say": "That means you can watch the in-flight movies without a long cord running across your lap.", "shots": [{"clip": "c1", "start": 18, "rotate": "none"}, {"clip": "c1", "start": 25, "rotate": "none"}], "seconds": 5.3}, {"say": "Here you can see it plugged in and hanging from the seat in front of me.", "shots": [{"clip": "c1", "start": 3, "rotate": "none"}, {"clip": "c1", "start": 24.5, "rotate": "none"}], "seconds": 5.3}, {"say": "It is light, so it just dangles there and stays out of the way.", "shots": [{"clip": "c1", "start": 6.5, "rotate": "none"}, {"clip": "c1", "start": 26.5, "rotate": "none"}], "seconds": 4.7}, {"say": "On the front there are proper buttons you can press, so you are not hunting for a tiny switch in the dark.", "shots": [{"clip": "c1", "start": 9, "rotate": "none"}, {"clip": "c1", "start": 11.5, "rotate": "none"}], "seconds": 7.3}, {"say": "Little lights on it show you it is powered on.", "shots": [{"clip": "c1", "start": 12.8, "rotate": "none"}, {"clip": "c1", "start": 0.5, "rotate": "none"}], "seconds": 3.3}, {"say": "The listing says it is Bluetooth six point oh, and that it works as a transmitter or a receiver, so it is meant for a TV at home too.", "shots": [{"clip": "c1", "start": 19, "rotate": "none"}, {"clip": "c1", "start": 21.5, "rotate": "none"}], "seconds": 9.7}, {"say": "I only tested it on the plane, so that is what I can show you here.", "shots": [{"clip": "c1", "start": 22.5, "rotate": "none"}, {"clip": "c1", "start": 27.5, "rotate": "none"}], "seconds": 5.3}, {"say": "My honest verdict: if you hate airline headphones and want to use your own earbuds, this is a small, simple fix.", "shots": [{"clip": "c1", "start": 16.5, "rotate": "none"}, {"clip": "c1", "start": 4.5, "rotate": "none"}], "seconds": 7}, {"say": "It packs away easily, and I will be keeping it in my carry-on.", "shots": [{"clip": "c1", "start": 10, "rotate": "none"}, {"clip": "c1", "start": 26.5, "rotate": "none"}], "seconds": 4.3}], "product_label": "INCORIC Bluetooth Audio Adapter"} } },
  { id: 'j1', product_id: 'p7', type: 'edit', status: 'running', question: null, created_at: now, updated_at: now, input: {}, log: null,
    output: { progress: { step: 'Claude is planning the cut', pct: 45, note: null } } },
  { id: 'j2', product_id: 'p8', type: 'edit', status: 'needs_review', question: 'Review the edit: vertical 36 s, horizontal 1:16, thumbnail.', created_at: now, updated_at: now, input: {}, log: null,
    output: {
      progress: { step: 'Ready to review', pct: 100 }, lengths: { vertical: 36.5, horizontal: 76.4 },
      media: { finished_vertical: 'mv', finished_horizontal: 'mh', thumbnail: 'mt' },
      plan: { hook: 'My secret skincare ingredient', product_label: 'Pure Castor Oil', footage: 'Two phones filmed the same talk: c1 landscape, c3 portrait. Clear audio throughout.', concerns: 'The measuring part has long pauses and little to see; left out of both cuts.', keys: ['magic'], thumbnail: { text: 'My secret skincare oil' } },
      clips: { c1: 'IMG_4276 (2).MOV', c3: 'castor oil.MOV' },
      cuts: { vertical: [
        { clip: 'c3', a: 52.9, b: 54.5, why: 'Strongest line, says what it is', said: 'Castor oil is magic.', length: 1.6 },
        { clip: 'c3', a: 26.2, b: 34.4, why: 'Honest proof she uses it', said: 'I never even bothered taking the plastic off, but this has really been worth the investment. This is an incredible product.', length: 8.2 },
      ], horizontal: [] },
      skipped: ['IMG_4276.mov (same take as IMG_4276 (2).MOV)'], problems: [],
      cost: { cpu_seconds: 241, cpu_cores: 8, gpu_seconds: 21, modal_usd: 0.03, claude_usd: 0.19, total_usd: 0.22 },
    } },
]
media.push(
  { id: 'm7', product_id: 'p7', kind: 'raw_clip', drive_file_id: 'f7', filename: 'IMG_5001.MOV', duration_s: 95, width: 1080, height: 1920, shot_on: 'Zanje’s iPhone', uploaded_by: 'u', size_bytes: 800_000_000, codec: 'hevc', uploaded_at: now },
  { id: 'm8', product_id: 'p8', kind: 'raw_clip', drive_file_id: 'f8', filename: 'castor oil.MOV', duration_s: 179.7, width: 1080, height: 1920, shot_on: null, uploaded_by: null, size_bytes: 296_000_000, codec: null, uploaded_at: now },
)
jobs.push({ id: 'j3', product_id: 'p12', type: 'edit', status: 'done', question: null, created_at: now, updated_at: now, input: {}, log: null,
  output: { verdict: 'approved', media: { finished_vertical: 'mv12', finished_horizontal: 'mh12' }, plan: { hook: 'Is my blood pressure really that high?', product_label: 'Upper arm monitor', footage: '', concerns: '', keys: [], thumbnail: { text: 'Honest BP check' } },
    cuts: { vertical: [{ clip: 'c1', a: 0, b: 5, why: '', said: 'I finally checked my blood pressure at home and this thing is so easy.', length: 5 }], horizontal: [] } } })
media.push(
  { id: 'mv12', product_id: 'p12', kind: 'finished_vertical', drive_file_id: 'dv12', filename: 'Blood Pressure Monitor - vertical (auto v1).mp4', duration_s: 35.5, width: 1080, height: 1920, shot_on: null, uploaded_by: null, size_bytes: 48_000_000, codec: null, uploaded_at: now },
  { id: 'mh12', product_id: 'p12', kind: 'finished_horizontal', drive_file_id: 'dh12', filename: 'Blood Pressure Monitor - horizontal (auto v1).mp4', duration_s: 116, width: 1920, height: 1080, shot_on: null, uploaded_by: null, size_bytes: 152_000_000, codec: null, uploaded_at: now },
)
const purchases: Record<string, unknown>[] = [
  { id: 'pu1', order_id: '111-1', order_date: '2026-10-18', asin: 'B000MTST70', title: 'Red Bull Energy Drink, 8.4 fl oz, 24 cans', quantity: 2, unit_price: 38.18, category: 'Grocery & Gourmet Food', bucket: 'household', bucket_by: 'category', product_id: null, link_kind: null, ask_product_id: null },
  { id: 'pu2', order_id: '111-2', order_date: '2026-09-08', asin: 'B0DHVGDL2F', title: 'Rectangle 3" x 2" Thermal Labels', quantity: 1, unit_price: 9.99, category: 'Office Products', bucket: 'supplies', bucket_by: 'category', product_id: null, link_kind: null, ask_product_id: null },
  { id: 'pu3', order_id: '111-3', order_date: '2026-07-02', asin: 'B0DHVGDL2F', title: 'Rectangle 3" x 2" Thermal Labels', quantity: 1, unit_price: 9.99, category: 'Office Products', bucket: 'supplies', bucket_by: 'category', product_id: null, link_kind: null, ask_product_id: null },
  { id: 'pu4', order_id: '111-4', order_date: '2026-06-11', asin: 'B0EUFYCAM1', title: 'Eufy Robot Vacuum 11S MAX, Super Thin, Robotic Vacuum Cleaner', quantity: 1, unit_price: 199.99, category: 'Electronics', bucket: 'review', bucket_by: 'claude', product_id: null, link_kind: null, ask_product_id: null },
  { id: 'pu5', order_id: '111-5', order_date: '2026-05-03', asin: 'B0PLAUD001', title: 'PLAUD NotePen', quantity: 1, unit_price: 159, category: 'Electronics', bucket: 'review', bucket_by: 'match', product_id: null, link_kind: null, ask_product_id: 'p7' },
]
const tables: Record<string, Record<string, unknown>[]> = { products, listings, posts, deals, jobs, media, viralvue_reminders: reminders, purchases, profiles: [] }

/** Phase 4: Claude's text and the finished file (a CORS + Range server on :8789 with v.mp4, h.mp4, 20 MB and 30 MB). */
function demoPublish(body: Record<string, unknown>): Response {
  if (body.action === 'copy') {
    const copy = { amazon_title: 'Blood Pressure Monitor - So Easy at Home!', amazon_description: 'An upper-arm monitor I use at home. The video shows the cuff going on, one button to start and the reading on the big screen. Good for anyone who wants a quick daily check; the cuff is snug on larger arms.', tiktok_caption: 'Checking my blood pressure at home is this easy now 🙌\n\n#bloodpressure #healthcheck #tiktokshopfinds #homehealth', job_id: 'j3', generated_at: new Date().toISOString() }
    const p = products.find((x) => x.id === body.product_id) as Record<string, unknown> | undefined
    if (p) p.post_copy = copy
    return json({ copy, cached: false, saved: true })
  }
  if (body.action === 'file') {
    const v = body.kind === 'finished_vertical'
    return json({ media_id: v ? 'mv12' : 'mh12', drive_file_id: v ? 'dv12' : 'dh12', filename: v ? 'demo vertical.mp4' : 'demo horizontal.mp4', size: v ? 20_000_000 : 30_000_000, mime: 'video/mp4', duration_s: 35, url: `http://localhost:8789/${v ? 'v' : 'h'}.mp4` })
  }
  return json({ error: 'unknown' }, { status: 400 })
}

function demoEdit(body: Record<string, unknown>): Response {
  const media8 = 'http://localhost:8788'
  if (body.action === 'review') {
    return json({ files: {
      finished_vertical: { url: `${media8}/v.mp4`, drive_file_id: 'mv', filename: 'Castor Oil - vertical (auto v1).mp4', duration_s: 36.5 },
      finished_horizontal: { url: `${media8}/h.mp4`, drive_file_id: 'mh', filename: 'Castor Oil - horizontal (auto v1).mp4', duration_s: 76.4 },
      thumbnail: { url: `${media8}/t.jpg`, drive_file_id: 'mt', filename: 'Castor Oil - thumbnail (auto v1).jpg', duration_s: null },
    } })
  }
  if (body.action === 'start' || body.action === 'redo') {
    const productId = body.action === 'redo' ? String(jobs.find((j) => j.id === body.job_id)?.product_id) : String(body.product_id)
    const id = `j${Date.now()}`
    jobs.push({ id, product_id: productId, type: 'edit', status: 'queued', question: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), input: { note: body.note }, log: null,
      output: { progress: { step: 'Waiting for the worker', pct: 0, note: 'Demo: no worker here.' } } })
    const p = products.find((x) => x.id === productId)
    if (p) p.status = 'editing'
    return json({ job_id: id, warning: null })
  }
  if (body.action === 'approve') {
    const j = jobs.find((x) => x.id === body.job_id)
    if (j) { j.status = 'done'; const p = products.find((x) => x.id === j.product_id); if (p) p.status = 'ready' }
    return json({ ok: true })
  }
  return json({ job_id: body.job_id, warning: null })
}

/** Clip uploads in demo mode go to scripts/fake-drive-upload.mjs on :8787 (start it first). */
async function demoDrive(body: Record<string, unknown>): Promise<Response> {
  const fake = 'http://localhost:8787'
  try {
    if (body.action === 'start_upload') {
      const r = await fetch(`${fake}/start?size=${body.size}&name=${encodeURIComponent(String(body.filename))}`, { method: 'POST' })
      return json({ upload_url: (await r.json()).url, folder_id: 'demo', raw_folder_id: 'demo-raw' })
    }
    if (body.action === 'upload_status') {
      const r = await fetch(String(body.upload_url), { method: 'PUT', headers: { 'Content-Range': `bytes */${body.size}` } })
      if (r.status === 404) return json({ expired: true })
      if (r.ok) return json({ received: body.size, file: await r.json() })
      const range = r.headers.get('Range')
      return json({ received: range ? Number(range.split('-')[1]) + 1 : 0 })
    }
  } catch {
    return json({ error: 'Start the fake upload server: node scripts/fake-drive-upload.mjs' }, { status: 502 })
  }
  if (body.action === 'finish_upload') {
    media.push({ id: `m${Date.now()}`, product_id: String(body.product_id), kind: 'raw_clip', drive_file_id: String(body.drive_file_id), filename: String(body.drive_file_id).replace(/^fake-/, ''),
      duration_s: body.duration_s as number, width: body.width as number, height: body.height as number, shot_on: (body.shot_on as string) ?? null, uploaded_by: 'u', size_bytes: body.size as number, codec: (body.codec as string) ?? null, uploaded_at: new Date().toISOString() })
    const p = products.find((x) => x.id === body.product_id)
    const changed = p && (p.status === 'received' || p.status === 'expected')
    if (p && changed) p.status = 'filmed'
    return json({ media_id: 'm', size: body.size, status_changed: Boolean(changed) })
  }
  const raw = media.filter((m) => m.product_id === body.product_id && m.kind === 'raw_clip').length
  return json({ added: 0, raw, finished: 0, status_changed: false })
}

function applyFilters(rows: Record<string, unknown>[], params: URLSearchParams) {
  let out = rows
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'or'].includes(k)) continue
    const [op, ...rest] = v.split('.')
    const val = rest.join('.')
    if (op === 'eq') out = out.filter((r) => String(r[k]) === val)
    else if (op === 'neq') out = out.filter((r) => String(r[k]) !== val)
    else if (op === 'is' && val === 'null') out = out.filter((r) => r[k] == null)
    else if (op === 'not' && val === 'is.null') out = out.filter((r) => r[k] != null)
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
    if (url.pathname.endsWith('/identify') && body.search) return json({ via: 'amazon', note: null, candidates: [
      { asin: 'B0FRRQL4R8', title: 'SVA Rosehip Seed Carrier Oil, Huge Bottle, Large Size, 16 Fl Oz (473 ml)', brand: null, image_url: 'https://m.media-amazon.com/images/I/61KuiOq16JL._AC_SL1500_.jpg', price: 29.99, url: 'https://www.amazon.com/dp/B0FRRQL4R8' },
      { asin: 'B071ZMQ3X8', title: 'SVA Rosehip Seed Carrier Oil, Glass Bottle with Dropper, 4 Fl Oz (118 ml)', brand: null, image_url: 'https://m.media-amazon.com/images/I/61DmZDzSPQL._AC_SL1500_.jpg', price: 9.99, url: 'https://www.amazon.com/dp/B071ZMQ3X8' },
    ] })
    if (url.pathname.endsWith('/identify') && body.url) return json({ name: 'SVA Rosehip Seed Carrier Oil', brand: 'SVA ORGANICS', variant: null, upc: null, asin: String(body.url).match(/dp\/([A-Z0-9]{10})/)?.[1] ?? 'B0FRRQL4R8', title: 'SVA Rosehip Seed Carrier Oil, Huge Bottle, 16 Fl Oz', image_url: 'https://m.media-amazon.com/images/I/61KuiOq16JL._AC_SL1500_.jpg', url: body.url, platform: 'amazon', tiktok_product_id: null, confidence: 'high', note: null, price: 29.99 })
    if (url.pathname.endsWith('/identify')) return json({ name: 'Nextorch P91 Flashlight', brand: 'NEXTORCH', variant: 'Black', upc: body.upc ?? null, asin: null, title: 'NEXTORCH P91 Tactical Flashlight', image_url: null, url: body.url ?? null, platform: null, tiktok_product_id: null, confidence: 'high', note: null })
    if (url.pathname.endsWith('/edit')) return demoEdit(body)
    if (url.pathname.endsWith('/publish')) return demoPublish(body)
    if (body.action === 'status') return json({ connected: false, email: null, products_folder_id: null })
    if (body.action === 'archive' || body.action === 'restore') {
      const p = products.find((x) => x.id === body.product_id) as Record<string, unknown> | undefined
      const moved = body.action === 'archive' && body.move && p?.drive_folder_id ? [{ id: String(p.drive_folder_id), name: String(p.name), from: 'products', to: 'aia' }] : []
      if (p) Object.assign(p, body.action === 'archive'
        ? { archived_at: new Date().toISOString(), archived_reason: body.reason, archived_move: { moved, note: null } }
        : { archived_at: null, archived_reason: null, archived_move: null })
      return json(body.action === 'archive' ? { moved: moved.length, folders: moved.length, note: null } : { moved_back: 1, note: null })
    }
    if (body.action?.endsWith('upload') || body.action === 'upload_status' || body.action === 'sync') return demoDrive(body)
    return json({ folder_id: 'demo', folder_name: 'demo', created: true, media_id: 'm', drive_file_id: 'f' })
  }
  const m = url.pathname.match(/\/rest\/v1\/(\w+)/)
  if (!m) return json({})
  const table = tables[m[1]] ?? []
  if (method === 'GET' || method === 'HEAD') {
    let rows = applyFilters(table, url.searchParams)
    if (m[1] === 'viralvue_reminders') rows = rows.map((r) => ({ ...r, deal: deals.find((d) => d.id === r.deal_id) ?? null }))
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
    const body = JSON.parse(String(init?.body ?? '{}'))
    const added = (Array.isArray(body) ? body : [body]).map((b, i) => ({ id: `new${Date.now()}${i}`, created_at: new Date().toISOString(), ...b }))
    for (const row of added) {
      // upsert on (deal_id, kind), ignoring duplicates, as the reminders use it
      if (m[1] === 'viralvue_reminders' && table.some((r) => r.deal_id === row.deal_id && r.kind === row.kind)) continue
      table.push(row)
    }
    return (headers.get('Accept') ?? '').includes('vnd.pgrst.object') ? json(added[0]) : json(added)
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
