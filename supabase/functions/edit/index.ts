// edit: the phone's side of Phase 3. Signed-in Charly or Zanje only.
//   { action: 'start', product_id, clip_ids?, note? }   queues an edit job, product -> Editing, wakes the Modal worker
//   { action: 'retry', job_id }                          a failed or stuck job runs again
//   { action: 'approve', job_id }                        product -> Edited, not posted
//   { action: 'redo', job_id, note }                     this cut goes to finished/Earlier drafts; a new job adjusts its plan
//   { action: 'review', job_id }                         signed links that play the finished files on the phone
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { HttpError, serve } from '../_shared/http.ts'
import { driveToken, ensureFolder, moveFile } from '../_shared/google.ts'
import { signedMediaUrl, workerSecret } from '../_shared/worker.ts'

const ACTIVE = ['queued', 'running']
const STUCK_MS = 20 * 60_000   // a running job with no progress for this long is treated as stuck

/** Asks Modal to run the job. The job stays queued (and says why) when the worker can't be reached. */
async function wake(db: SupabaseClient, jobId: string): Promise<string | null> {
  const url = Deno.env.get('MODAL_EDIT_URL')
  let problem: string | null = null
  if (!url) problem = 'The editing worker is not set up yet (MODAL_EDIT_URL is missing).'
  else {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${workerSecret()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId }),
        signal: AbortSignal.timeout(25_000),
      })
      if (!res.ok) problem = `The editing worker answered ${res.status}: ${(await res.text()).slice(0, 200)}`
    } catch (e) {
      problem = `The editing worker could not be reached: ${(e as Error).message}`
    }
  }
  if (problem) {
    const { data } = await db.from('jobs').select('output').eq('id', jobId).single()
    await db.from('jobs').update({ output: { ...(data?.output ?? {}), progress: { step: 'Waiting for the worker', pct: 0, note: problem } } }).eq('id', jobId)
  }
  return problem
}

async function loadJob(db: SupabaseClient, id: unknown) {
  const { data } = await db.from('jobs').select('*').eq('id', String(id ?? '')).eq('type', 'edit').maybeSingle()
  if (!data) throw new HttpError(404, 'That edit was not found.')
  return data
}

async function start(db: SupabaseClient, userId: string, productId: string, clipIds: string[] | undefined, note: string | null, redoOf: string | null) {
  const { data: p } = await db.from('products').select('id,name,status,drive_folder_id').eq('id', productId).maybeSingle()
  if (!p) throw new HttpError(404, 'That product was not found.')
  if (!p.drive_folder_id) throw new HttpError(409, 'The product has no Drive folder yet.')
  const { count } = await db.from('media').select('id', { count: 'exact', head: true }).eq('product_id', p.id).eq('kind', 'raw_clip')
  if (!count) throw new HttpError(409, 'There are no raw clips to edit. Upload clips or tap Sync from Drive first.')
  const { data: busy } = await db.from('jobs').select('id').eq('product_id', p.id).eq('type', 'edit').in('status', ACTIVE).limit(1)
  if (busy?.length) return { job_id: busy[0].id, already: true, warning: null }
  const input: Record<string, unknown> = {}
  if (clipIds?.length) input.clip_ids = clipIds
  if (note) input.note = note
  if (redoOf) input.redo_of = redoOf
  const { data: job, error } = await db.from('jobs').insert({
    product_id: p.id, type: 'edit', status: 'queued', input, created_by: userId,
    output: { progress: { step: 'Waiting for the worker', pct: 0 } },
  }).select('id').single()
  if (error) throw new HttpError(500, error.message)
  await db.from('products').update({ status: 'editing' }).eq('id', p.id)
  const warning = await wake(db, job.id)
  return { job_id: job.id, already: false, warning }
}

/** Moves a reviewed-and-replaced cut out of finished/ (into finished/Earlier drafts) and forgets its media rows. */
async function shelve(db: SupabaseClient, job: Record<string, any>) {
  const media = (job.output?.media ?? {}) as Record<string, string>
  const ids = Object.values(media)
  if (!ids.length) return
  const { data: rows } = await db.from('media').select('id,drive_file_id').in('id', ids)
  const { data: p } = await db.from('products').select('drive_folder_id').eq('id', job.product_id).single()
  if (rows?.length && p?.drive_folder_id) {
    const { token } = await driveToken(db)
    const finished = await ensureFolder(token, 'finished', p.drive_folder_id)
    const drafts = await ensureFolder(token, 'Earlier drafts', finished)
    for (const r of rows) if (r.drive_file_id) await moveFile(token, r.drive_file_id, drafts).catch((e) => console.error('move', e))
  }
  await db.from('media').delete().in('id', ids)
}

serve(async (body, { user, db }) => {
  switch (body.action) {
    case 'start': {
      const note = body.note ? String(body.note).trim().slice(0, 1000) : null
      const clipIds = Array.isArray(body.clip_ids) ? body.clip_ids.map(String) : undefined
      return await start(db, user.id, String(body.product_id ?? ''), clipIds, note || null, null)
    }

    case 'retry': {
      const job = await loadJob(db, body.job_id)
      const stuck = job.status === 'running' && Date.now() - new Date(job.updated_at).getTime() > STUCK_MS
      if (job.status !== 'failed' && job.status !== 'queued' && !stuck) throw new HttpError(409, `This edit is ${job.status.replace('_', ' ')}; nothing to retry.`)
      await db.from('jobs').update({ status: 'queued', finished_at: null, output: { progress: { step: 'Waiting for the worker', pct: 0 } } }).eq('id', job.id)
      await db.from('products').update({ status: 'editing' }).eq('id', job.product_id).in('status', ['filmed', 'editing'])
      return { job_id: job.id, warning: await wake(db, job.id) }
    }

    case 'approve': {
      const job = await loadJob(db, body.job_id)
      if (job.status !== 'needs_review') throw new HttpError(409, 'This edit is not waiting for review.')
      await db.from('jobs').update({ status: 'done', question: null, output: { ...(job.output ?? {}), verdict: 'approved', reviewed_by: user.email, reviewed_at: new Date().toISOString() } }).eq('id', job.id)
      await db.from('products').update({ status: 'ready' }).eq('id', job.product_id).in('status', ['filmed', 'editing'])
      return { ok: true }
    }

    case 'redo': {
      const job = await loadJob(db, body.job_id)
      if (job.status !== 'needs_review' && job.status !== 'done') throw new HttpError(409, 'Only a finished edit can be redone.')
      const note = String(body.note ?? '').trim().slice(0, 1000)
      if (!note) throw new HttpError(400, 'Say what to change, so the next cut can fix it.')
      await shelve(db, job)
      await db.from('jobs').update({ status: 'done', question: null, output: { ...(job.output ?? {}), media: {}, verdict: 'redo', redo_note: note, reviewed_by: user.email, reviewed_at: new Date().toISOString() } }).eq('id', job.id)
      const clipIds = (job.input?.clip_ids as string[] | undefined) ?? undefined
      return await start(db, user.id, job.product_id, clipIds, note, job.id)
    }

    case 'review': {
      const job = await loadJob(db, body.job_id)
      const media = (job.output?.media ?? {}) as Record<string, string>
      const ids = Object.values(media)
      const { data: rows } = ids.length ? await db.from('media').select('id,kind,drive_file_id,filename,duration_s').in('id', ids) : { data: [] }
      const out: Record<string, { url: string; drive_file_id: string; filename: string; duration_s: number | null }> = {}
      for (const r of rows ?? []) {
        if (!r.drive_file_id) continue
        const mime = r.kind === 'thumbnail' ? 'image/jpeg' : 'video/mp4'
        out[r.kind] = { url: await signedMediaUrl(r.drive_file_id, mime), drive_file_id: r.drive_file_id, filename: r.filename, duration_s: r.duration_s }
      }
      return { files: out }
    }

    default:
      throw new HttpError(400, 'Unknown action.')
  }
})
