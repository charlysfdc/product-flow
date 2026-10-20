// publish: Phase 4, the phone's side of posting. Signed-in Charly or Zanje only.
//   { action: 'copy', product_id, force? }   Claude writes the Amazon title + description and the TikTok caption
//                                            from the approved edit's transcript and plan; saved in products.post_copy
//   { action: 'ready_sync', product_id? }    My Drive/Ready to Post matches the database (one product, or all):
//                                            copies of finished files for what is edited but not posted yet
//   { action: 'file', product_id, kind }     a signed link (and size) for the finished vertical or horizontal, so the
//                                            phone can download it in pieces and hand it to the iOS share sheet
import Anthropic from 'npm:@anthropic-ai/sdk@0.135.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { HttpError, serve } from '../_shared/http.ts'
import { DRIVE, driveToken, gd } from '../_shared/google.ts'
import { signedMediaUrl } from '../_shared/worker.ts'
import { PLATFORM_LABEL } from '../_shared/labels.ts'
import { syncReady } from '../_shared/ready.ts'

const MODEL = 'claude-opus-5-5'
const AMAZON_TITLE_MAX = 60
const NO_AMAZON = /amazon|amzn|\bprime\b/i

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>

function anthropic(): Anthropic {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) throw new HttpError(500, 'Writing the text needs ANTHROPIC_API_KEY in the Supabase Edge Function secrets.')
  const workspace = Deno.env.get('ANTHROPIC_WORKSPACE_ID')
  return new Anthropic({ apiKey, ...(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}) })
}

/** Same as identify: on a 400, drop the newest option (server-side fallback, then the JSON format) and try again. */
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

function apiMessage(e: unknown): string {
  // deno-lint-ignore no-explicit-any
  const err = e as any
  return String(err?.error?.error?.message ?? err?.message ?? e).replace(/^\d{3}\s*/, '').slice(0, 220)
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['amazon_title', 'amazon_description', 'tiktok_caption', 'tiktok_hashtags'],
  properties: {
    amazon_title: { type: 'string' },
    amazon_description: { type: 'string' },
    tiktok_caption: { type: 'string' },
    tiktok_hashtags: { type: 'array', items: { type: 'string' } },
  },
}

const SYSTEM = `You write the text Charly pastes when posting a finished product review video. Charly is an Amazon Influencer and a TikTok Shop creator who films honest, first-person reviews of products they actually use (sometimes with their daughter Zanje or their mom).

Write three things from what is said in the video and the product details:

1. amazon_title: the Amazon video title, for shoppers browsing the product page. At most ${AMAZON_TITLE_MAX} characters. Pattern: what the product is in plain shopper words, a dash, then the honest payoff in Charly's voice, often ending with "!". Match the style of Charly's past titles listed below. No brand-stuffing, no emojis, no hashtags, no ALL CAPS words, no prices, no "review" filler unless it is the point.
2. amazon_description: 2 to 4 short sentences (under 500 characters) for the same shopper: what it is, what the video shows, who it suits, one honest limitation when the video mentions one. Plain text, first person, no hashtags, no links, no emojis, no prices, no medical or guaranteed-result claims.
3. tiktok_caption and tiktok_hashtags: a short, conversational TikTok caption in Charly's voice (one or two lines, under 150 characters) that makes people want to watch and tap the product, then 3 to 6 hashtags (without the # sign) that fit the product and TikTok Shop. The TikTok text must NEVER mention Amazon, Prime, or any other store or marketplace, in words or hashtags. The video on TikTok uses its original audio; do not mention music or sounds.

Only claim what the video says or the product details state. If the transcript is thin, stay general rather than invent features. Write in American English.`

function cutText(cuts: Row[] | undefined): string {
  return (cuts ?? []).map((c) => String(c.said ?? '').trim()).filter(Boolean).join(' ')
}

/** The edit the text is written from: the approved one, else the newest finished one. */
async function latestEdit(db: SupabaseClient, productId: string): Promise<Row | null> {
  const { data } = await db.from('jobs').select('id,status,output,created_at').eq('product_id', productId).eq('type', 'edit')
    .in('status', ['done', 'needs_review']).order('created_at', { ascending: false }).limit(10)
  const jobs = (data ?? []).filter((j) => j.output?.verdict !== 'redo')
  return jobs.find((j) => j.output?.verdict === 'approved') ?? jobs[0] ?? null
}

async function writeCopy(db: SupabaseClient, productId: string, force: boolean) {
  const { data: p } = await db.from('products').select('*').eq('id', productId).maybeSingle()
  if (!p) throw new HttpError(404, 'That product was not found.')
  if (p.post_copy && !force) return { copy: p.post_copy, cached: true }

  const [{ data: listings }, { data: deals }, { data: past }, edit] = await Promise.all([
    db.from('listings').select('platform,external_id,availability,availability_note').eq('product_id', productId),
    db.from('deals').select('title,brand,asin').eq('product_id', productId),
    db.from('posts').select('title,views').in('platform', ['amazon_us', 'amazon_ca', 'amazon_uk', 'amazon_de', 'amazon_nl']).not('title', 'is', null).order('views', { ascending: false, nullsFirst: false }).limit(30),
    latestEdit(db, productId),
  ])
  const out = (edit?.output ?? {}) as Row
  const plan = (out.plan ?? {}) as Row
  const vertical = cutText(out.cuts?.vertical)
  const horizontal = cutText(out.cuts?.horizontal)
  const titles = [...new Set((past ?? []).map((x) => String(x.title).trim()).filter(Boolean))].slice(0, 25)

  const facts = [
    `Product: ${p.name}`,
    p.brand && `Brand: ${p.brand}`,
    p.variant && `Variant: ${p.variant}`,
    ...(deals ?? []).filter((d) => d.title).map((d) => `Amazon listing title: ${d.title}`),
    (listings ?? []).length ? `Listed on: ${[...new Set((listings ?? []).filter((l) => l.availability !== 'not_listed').map((l) => PLATFORM_LABEL[l.platform] ?? l.platform))].join(', ')}` : null,
    p.notes && `Notes: ${String(p.notes).slice(0, 600)}`,
  ].filter(Boolean).join('\n')
  const video = edit
    ? [
        plan.hook && `Hook on screen: ${plan.hook}`,
        plan.product_label && `Product label on screen: ${plan.product_label}`,
        plan.thumbnail?.text && `Thumbnail text: ${plan.thumbnail.text}`,
        horizontal && `What is said in the horizontal (longer) cut:\n${horizontal}`,
        vertical && `What is said in the vertical (short) cut:\n${vertical}`,
      ].filter(Boolean).join('\n\n')
    : 'No transcript is available for this video; write from the product details only and keep it general.'
  const prompt = `${facts}\n\n${video}\n\nCharly's past Amazon video titles (most viewed first), for style:\n${titles.map((t) => `- ${t}`).join('\n') || '- (none yet)'}\n\nReply with one JSON object with the keys amazon_title, amazon_description, tiktok_caption, tiktok_hashtags.`

  const client = anthropic()
  // deno-lint-ignore no-explicit-any
  const messages: any[] = [{ role: 'user', content: prompt }]
  let got: Row | null = null
  for (let round = 0; round < 2 && !got; round++) {
    let res
    try {
      res = await createRobust(client, {
        model: MODEL, max_tokens: 3000, system: SYSTEM, messages,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      })
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new HttpError(500, 'The Anthropic API key in the Supabase secrets was rejected.')
      if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'Claude is busy right now; try again in a minute.')
      if (e instanceof Anthropic.APIError) throw new HttpError(502, `Claude could not write the text (${e.status ?? 'error'}: ${apiMessage(e)}).`)
      throw e
    }
    if (res.stop_reason === 'refusal') throw new HttpError(422, 'Claude declined to write this text. Write it by hand.')
    // deno-lint-ignore no-explicit-any
    const text = (res.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('')
    let j: Row
    try {
      j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text)
    } catch {
      throw new HttpError(502, 'Claude’s answer could not be read. Tap Write again.')
    }
    const problems: string[] = []
    const tiktok = `${j.tiktok_caption ?? ''} ${(j.tiktok_hashtags ?? []).join(' ')}`
    if (NO_AMAZON.test(tiktok)) problems.push('The TikTok caption or hashtags mention Amazon or Prime; TikTok text must never do that.')
    if (String(j.amazon_title ?? '').length > AMAZON_TITLE_MAX) problems.push(`The Amazon title is ${String(j.amazon_title).length} characters; keep it to ${AMAZON_TITLE_MAX}.`)
    if (problems.length && round === 0) {
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Fix this and reply with the whole JSON again:\n- ${problems.join('\n- ')}` })
      continue
    }
    got = j
  }
  const j = got!
  // last guard: TikTok text never mentions Amazon, whatever came back
  const tags = (Array.isArray(j.tiktok_hashtags) ? j.tiktok_hashtags : [])
    .map((t: unknown) => String(t).replace(/^#+/, '').replace(/\s+/g, '').trim())
    .filter((t: string) => t && !NO_AMAZON.test(t))
    .slice(0, 6)
  const caption = String(j.tiktok_caption ?? '').replace(/\s*\b(on |from |at )?(amazon|amzn)\b[^.!?\n]*/gi, '').trim()
  let title = String(j.amazon_title ?? '').trim()
  if (title.length > AMAZON_TITLE_MAX) title = title.slice(0, AMAZON_TITLE_MAX).replace(/\s+\S*$/, '')
  const copy = {
    amazon_title: title,
    amazon_description: String(j.amazon_description ?? '').trim(),
    tiktok_caption: [caption, tags.map((t: string) => `#${t}`).join(' ')].filter(Boolean).join('\n\n'),
    job_id: edit?.id ?? null,
    generated_at: new Date().toISOString(),
  }
  const saved = await db.from('products').update({ post_copy: copy }).eq('id', productId)
  if (!saved.error) await syncReady(db, productId).catch((e) => console.error('Ready to Post:', e))   // the post text file
  return { copy, cached: false, saved: !saved.error }   // saved false: migration 0007 not applied yet
}

/** The finished file to post: the approved edit's, else the newest of that kind (also ones dropped in by hand). */
async function finishedFile(db: SupabaseClient, productId: string, kind: string) {
  if (kind !== 'finished_vertical' && kind !== 'finished_horizontal') throw new HttpError(400, 'Pick the vertical or the horizontal video.')
  const edit = await latestEdit(db, productId)
  const wanted = (edit?.output?.media ?? {})[kind] as string | undefined
  let row: Row | null = null
  if (wanted) row = (await db.from('media').select('*').eq('id', wanted).maybeSingle()).data
  if (!row) {
    const { data } = await db.from('media').select('*').eq('product_id', productId).eq('kind', kind).not('drive_file_id', 'is', null)
      .order('uploaded_at', { ascending: false }).limit(1)
    row = data?.[0] ?? null
  }
  if (!row) throw new HttpError(404, kind === 'finished_vertical' ? 'There is no finished vertical video yet.' : 'There is no finished horizontal video yet.')
  const { token } = await driveToken(db)
  const meta = await gd<{ size?: string; name?: string; mimeType?: string }>(token, `${DRIVE}/files/${encodeURIComponent(row.drive_file_id)}?fields=size,name,mimeType&supportsAllDrives=true`)
  const mime = meta.mimeType?.startsWith('video/') ? meta.mimeType : 'video/mp4'
  return {
    media_id: row.id,
    drive_file_id: row.drive_file_id,
    filename: meta.name ?? row.filename,
    size: Number(meta.size ?? row.size_bytes ?? 0),
    mime,
    duration_s: row.duration_s,
    url: await signedMediaUrl(row.drive_file_id, mime, 6),
  }
}

serve(async (body, { db }) => {
  switch (body.action) {
    case 'copy':
      return await writeCopy(db, String(body.product_id ?? ''), Boolean(body.force))
    case 'ready_sync':
      return await syncReady(db, body.product_id ? String(body.product_id) : undefined)
    case 'file':
      return await finishedFile(db, String(body.product_id ?? ''), String(body.kind ?? 'finished_vertical'))
    default:
      throw new HttpError(400, 'Unknown action.')
  }
})
