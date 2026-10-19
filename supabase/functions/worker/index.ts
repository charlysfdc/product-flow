// worker: called only by the Modal edit worker, with "Authorization: Bearer <WORKER_SECRET>".
// Supabase keeps the Google and Anthropic credentials; the worker gets what one edit needs from here.
//   { action: 'claim', job_id }                 queued -> running; returns the product, clips, plan to redo, Drive token, finished folder, Claude key
//   { action: 'progress', job_id, step, pct, note, log }   live progress for the phone (jobs is on realtime)
//   { action: 'token' }                          a fresh Drive access token for a long job
//   { action: 'finish', job_id, result }         media rows for the finished files; job -> needs_review
//   { action: 'fail', job_id, error, log }       job -> failed; the product goes back to Filmed
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { admin, cors, HttpError, json } from '../_shared/http.ts'
import { driveToken, ensureFolder } from '../_shared/google.ts'
import { isWorker } from '../_shared/worker.ts'
import { PLATFORM_LABEL } from '../_shared/labels.ts'

const LOG_LIMIT = 20_000

async function loadJob(db: SupabaseClient, id: unknown) {
  const { data, error } = await db.from('jobs').select('*').eq('id', String(id ?? '')).maybeSingle()
  if (error || !data) throw new HttpError(404, 'No such job.')
  return data
}

function appendLog(old: string | null, lines: unknown): string {
  const add = (Array.isArray(lines) ? lines : lines ? [lines] : []).map((l) => `${new Date().toISOString().slice(11, 19)} ${String(l)}`)
  if (!add.length) return old ?? ''
  const all = [old ?? '', ...add].filter(Boolean).join('\n')
  return all.length > LOG_LIMIT ? all.slice(-LOG_LIMIT) : all
}

const fmt = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)} s`)

/** Back to Filmed when no other edit of this product is still on its way. */
async function releaseProduct(db: SupabaseClient, productId: string, exceptJob: string) {
  const { data: others } = await db.from('jobs').select('id').eq('product_id', productId).eq('type', 'edit')
    .in('status', ['queued', 'running', 'needs_review']).neq('id', exceptJob)
  if (!others?.length) await db.from('products').update({ status: 'filmed' }).eq('id', productId).eq('status', 'editing')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (!isWorker(req)) throw new HttpError(401, 'Not the worker.')
    const db = admin()
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

    switch (body.action) {
      case 'claim': {
        const { data: claimed } = await db.from('jobs')
          .update({ status: 'running', started_at: new Date().toISOString(), finished_at: null, output: { progress: { step: 'Starting', pct: 1 } } })
          .eq('id', String(body.job_id ?? '')).eq('status', 'queued').select('*')
        const job = claimed?.[0]
        if (!job) return json({ skip: 'This job is not waiting to run (already running, finished or gone).' })
        const input = (job.input ?? {}) as { clip_ids?: string[]; note?: string; redo_of?: string }
        const { data: product } = await db.from('products').select('id,name,brand,variant,source,notes,deadline,drive_folder_id').eq('id', job.product_id).single()
        const { data: listings } = await db.from('listings').select('platform,availability').eq('product_id', job.product_id)
        let clipsQ = db.from('media').select('id,drive_file_id,filename,duration_s,width,height,shot_on,size_bytes,codec')
          .eq('product_id', job.product_id).eq('kind', 'raw_clip').not('drive_file_id', 'is', null).order('filename')
        if (input.clip_ids?.length) clipsQ = clipsQ.in('id', input.clip_ids)
        const { data: clips, error: ce } = await clipsQ
        if (ce) throw new HttpError(500, ce.message)
        if (!clips?.length) throw new HttpError(409, 'The product has no raw clips in Drive.')
        if (!product?.drive_folder_id) throw new HttpError(409, 'The product has no Drive folder.')
        let previous_plan = null
        if (input.redo_of) {
          const { data: prev } = await db.from('jobs').select('output').eq('id', input.redo_of).maybeSingle()
          previous_plan = (prev?.output as { plan?: unknown } | null)?.plan ?? null
        }
        const { count } = await db.from('jobs').select('id', { count: 'exact', head: true })
          .eq('product_id', job.product_id).eq('type', 'edit').lte('created_at', job.created_at)
        const { token, expires_in } = await driveToken(db)
        const finished = await ensureFolder(token, 'finished', product.drive_folder_id)
        const key = Deno.env.get('ANTHROPIC_API_KEY')
        if (!key) throw new HttpError(500, 'ANTHROPIC_API_KEY is not set in the Supabase Edge Function secrets.')
        const platforms = [...new Set((listings ?? []).filter((l) => l.availability !== 'not_listed').map((l) => PLATFORM_LABEL[l.platform] ?? l.platform))]
        return json({
          job: { id: job.id, created_at: job.created_at },
          product: { ...product, platforms },
          clips, note: input.note ?? null, previous_plan, version: count ?? 1,
          drive: { access_token: token, expires_in, finished_folder_id: finished },
          anthropic: { api_key: key, workspace_id: Deno.env.get('ANTHROPIC_WORKSPACE_ID') ?? null },
        })
      }

      case 'progress': {
        const job = await loadJob(db, body.job_id)
        if (job.status !== 'running') return json({ ok: false, status: job.status })
        const output = { ...(job.output ?? {}), progress: { step: String(body.step ?? ''), pct: Number(body.pct) || 0, note: body.note ? String(body.note) : null, at: new Date().toISOString() } }
        await db.from('jobs').update({ output, log: appendLog(job.log, body.log) }).eq('id', job.id)
        return json({ ok: true })
      }

      case 'token': {
        const { token, expires_in } = await driveToken(db)
        return json({ access_token: token, expires_in })
      }

      case 'finish': {
        const job = await loadJob(db, body.job_id)
        const result = (body.result ?? {}) as Record<string, any>
        const files = (result.files ?? {}) as Record<string, { drive_file_id: string; filename: string; size_bytes?: number; duration_s?: number; width?: number; height?: number }>
        const media: Record<string, string> = {}
        for (const [kind, f] of Object.entries(files)) {
          if (!['finished_vertical', 'finished_horizontal', 'thumbnail'].includes(kind) || !f?.drive_file_id) continue
          const row = { product_id: job.product_id, kind, drive_file_id: f.drive_file_id, filename: f.filename, duration_s: f.duration_s ?? null, width: f.width ?? null, height: f.height ?? null, size_bytes: f.size_bytes ?? null }
          let ins = await db.from('media').insert(row).select('id').single()
          if (ins.error && /size_bytes/.test(ins.error.message)) {   // migration 0006 not applied
            const { size_bytes: _s, ...rest } = row
            ins = await db.from('media').insert(rest).select('id').single()
          }
          if (ins.error) throw new HttpError(500, ins.error.message)
          media[kind] = ins.data.id
        }
        const len = result.lengths ?? {}
        const question = `Review the edit: vertical ${fmt(len.vertical ?? 0)}, horizontal ${fmt(len.horizontal ?? 0)}, thumbnail.`
        await db.from('jobs').update({
          status: 'needs_review', finished_at: new Date().toISOString(), question,
          output: { ...result, media, progress: { step: 'Ready to review', pct: 100, at: new Date().toISOString() } },
          log: appendLog(job.log, body.log ?? 'Finished.'),
        }).eq('id', job.id)
        await db.from('products').update({ status: 'editing' }).eq('id', job.product_id).in('status', ['filmed', 'editing'])
        return json({ ok: true, media })
      }

      case 'fail': {
        const job = await loadJob(db, body.job_id)
        const error = String(body.error ?? 'The edit failed.').slice(0, 2000)
        await db.from('jobs').update({
          status: 'failed', finished_at: new Date().toISOString(), question: null,
          output: { ...(job.output ?? {}), error, progress: { step: 'Failed', pct: (job.output as any)?.progress?.pct ?? 0, note: error.slice(0, 300), at: new Date().toISOString() } },
          log: appendLog(job.log, [...(Array.isArray(body.log) ? body.log : []), `Failed: ${error}`]),
        }).eq('id', job.id)
        if (job.product_id) await releaseProduct(db, job.product_id, job.id)
        return json({ ok: true })
      }

      default:
        throw new HttpError(400, 'Unknown action.')
    }
  } catch (e) {
    console.error(e)
    return json({ error: (e as Error).message }, e instanceof HttpError ? e.status : 500)
  }
})
