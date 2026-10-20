// edit: the phone's side of Phase 3. Signed-in Charly or Zanje only.
//   { action: 'start', product_id, clip_ids?, note? }   queues an edit job, product -> Editing, wakes the Modal worker.
//                                                        From Ready it builds on the approved plan (like Redo) and the
//                                                        old cut moves to Earlier drafts when the new one is approved;
//                                                        from Posted it is an extra cut and the status stays
//   { action: 'retry', job_id }                          a failed or stuck job runs again
//   { action: 'approve', job_id }                        product -> Edited, not posted
//   { action: 'redo', job_id, note }                     this cut goes to finished/Earlier drafts; a new job adjusts its plan
//   { action: 'voiceover', job_id, choice }           footage without talking: 'voice' (write a script), 'music' (captions & music), 'cancel'
//   { action: 'approve_script', job_id, vertical, horizontal }   the (edited) lines are read in Charly's voice and rendered
//   { action: 'rewrite_script', job_id, note }        Claude writes the script again, adjusting it to the note
//   { action: 'review', job_id }                         signed links that play the finished files on the phone
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { HttpError, serve } from '../_shared/http.ts'
import { DRIVE, FOLDER, driveToken, ensureFolder, gd, moveFile } from '../_shared/google.ts'
import { signedMediaUrl, workerSecret } from '../_shared/worker.ts'
import { syncReady } from '../_shared/ready.ts'

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

/** Records the videos in the product's raw folder that the app doesn't know yet (same rows as drive 'sync'). */
async function recordRaw(db: SupabaseClient, productId: string, folderId: string): Promise<number> {
  const { token } = await driveToken(db)
  const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const find = await gd<{ files: { id: string }[] }>(token, `${DRIVE}/files?q=${encodeURIComponent(`name = 'raw' and mimeType = '${FOLDER}' and '${q(folderId)}' in parents and trashed = false`)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`)
  const raw = find.files[0]?.id
  if (!raw) return 0
  const list = await gd<{ files: { id: string; name: string; mimeType?: string; size?: string; createdTime?: string; videoMediaMetadata?: { width?: number; height?: number; durationMillis?: string } }[] }>(token,
    `${DRIVE}/files?q=${encodeURIComponent(`'${q(raw)}' in parents and trashed = false and mimeType != '${FOLDER}'`)}&fields=files(id,name,mimeType,size,createdTime,videoMediaMetadata)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`)
  const { data: known } = await db.from('media').select('drive_file_id').eq('product_id', productId)
  const have = new Set((known ?? []).map((m) => m.drive_file_id))
  let added = 0
  for (const f of list.files) {
    if (have.has(f.id) || !((f.mimeType ?? '').startsWith('video/') || /\.(mov|mp4|m4v)$/i.test(f.name))) continue
    const v = f.videoMediaMetadata
    const row: Record<string, unknown> = {
      product_id: productId, kind: 'raw_clip', drive_file_id: f.id, filename: f.name, uploaded_at: f.createdTime,
      width: v?.width ?? null, height: v?.height ?? null, duration_s: v?.durationMillis ? Math.round(Number(v.durationMillis) / 100) / 10 : null,
      size_bytes: f.size ? Number(f.size) : null,
    }
    let ins = await db.from('media').insert(row)
    if (ins.error && /size_bytes/.test(ins.error.message)) {
      delete row.size_bytes
      ins = await db.from('media').insert(row)
    }
    if (!ins.error) added++
  }
  return added
}

/** The same job runs again with more input (the voice-over steps), keeping its id and its place on the phone. */
async function requeue(db: SupabaseClient, job: Record<string, any>, more: Record<string, unknown>) {
  await db.from('jobs').update({
    status: 'queued', finished_at: null, question: null, input: { ...(job.input ?? {}), ...more },
    output: { progress: { step: 'Waiting for the worker', pct: 0 } },
  }).eq('id', job.id)
  return { job_id: job.id, warning: await wake(db, job.id) }
}

async function loadJob(db: SupabaseClient, id: unknown) {
  const { data } = await db.from('jobs').select('*').eq('id', String(id ?? '')).eq('type', 'edit').maybeSingle()
  if (!data) throw new HttpError(404, 'That edit was not found.')
  return data
}

async function start(db: SupabaseClient, userId: string, productId: string, clipIds: string[] | undefined, note: string | null, redoOf: string | null, fromStatus?: string, extra: Record<string, unknown> = {}) {
  const { data: p } = await db.from('products').select('id,name,status,drive_folder_id').eq('id', productId).maybeSingle()
  if (!p) throw new HttpError(404, 'That product was not found.')
  if (!p.drive_folder_id) throw new HttpError(409, 'The product has no Drive folder yet.')
  let { count } = await db.from('media').select('id', { count: 'exact', head: true }).eq('product_id', p.id).eq('kind', 'raw_clip')
  // clips put in Drive's raw folder before the app knew about them (the seeded products): record them now
  if (!count) count = await recordRaw(db, p.id, p.drive_folder_id)
  if (!count) throw new HttpError(409, 'There are no videos in the raw folder in Drive. Upload clips first.')
  const { data: busy } = await db.from('jobs').select('id').eq('product_id', p.id).eq('type', 'edit').in('status', ACTIVE).limit(1)
  if (busy?.length) return { job_id: busy[0].id, already: true, warning: null }
  // going back from Ready: start from the approved cut's plan, the way Redo does
  if (!redoOf && p.status === 'ready') {
    const { data: approved } = await db.from('jobs').select('id,output').eq('product_id', p.id).eq('type', 'edit').eq('status', 'done')
      .order('created_at', { ascending: false }).limit(10)
    redoOf = approved?.find((j) => j.output?.verdict === 'approved' && j.output?.plan)?.id ?? null
  }
  const input: Record<string, unknown> = { from_status: fromStatus ?? p.status }
  if (clipIds?.length) input.clip_ids = clipIds
  if (note) input.note = note
  if (redoOf) input.redo_of = redoOf
  Object.assign(input, extra)
  const { data: job, error } = await db.from('jobs').insert({
    product_id: p.id, type: 'edit', status: 'queued', input, created_by: userId,
    output: { progress: { step: 'Waiting for the worker', pct: 0 } },
  }).select('id').single()
  if (error) throw new HttpError(500, error.message)
  // Editing while the cut is made (a Ready product too: it goes back to Ready on approve or failure);
  // an extra cut of a Posted product keeps its status
  await db.from('products').update({ status: 'editing' }).eq('id', p.id).in('status', ['received', 'filmed', 'editing', 'ready'])
  const warning = await wake(db, job.id)
  return { job_id: job.id, already: false, warning }
}

/** Moves a reviewed-and-replaced cut out of finished/ (into finished/Earlier drafts) and forgets its media rows. */
async function shelve(db: SupabaseClient, job: Record<string, any>) {
  await shelveMedia(db, job.product_id, Object.values((job.output?.media ?? {}) as Record<string, string>))
}

async function shelveMedia(db: SupabaseClient, productId: string, ids: string[]) {
  if (!ids.length) return
  const { data: rows } = await db.from('media').select('id,drive_file_id').in('id', ids)
  const { data: p } = await db.from('products').select('drive_folder_id').eq('id', productId).single()
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
      // "Add a voice-over" on the Edit sheet: Claude writes a script first, whatever is said in the clips
      return await start(db, user.id, String(body.product_id ?? ''), clipIds, note || null, null, undefined, body.voiceover ? { voiceover: 'script' } : {})
    }

    case 'voiceover': {
      const job = await loadJob(db, body.job_id)
      if (job.status !== 'needs_review' || job.output?.stage !== 'ask_voiceover') throw new HttpError(409, 'This edit is not waiting for that answer.')
      const choice = String(body.choice ?? '')
      if (choice === 'cancel') {
        await db.from('jobs').update({ status: 'done', question: null, output: { ...(job.output ?? {}), verdict: 'cancelled', reviewed_by: user.email, reviewed_at: new Date().toISOString() } }).eq('id', job.id)
        await db.from('products').update({ status: job.input?.from_status === 'ready' ? 'ready' : 'filmed' }).eq('id', job.product_id).eq('status', 'editing')
        return { ok: true }
      }
      if (choice !== 'voice' && choice !== 'music') throw new HttpError(400, 'Pick voice, music or cancel.')
      return await requeue(db, job, { voiceover: choice === 'voice' ? 'script' : 'music' })
    }

    case 'approve_script': {
      const job = await loadJob(db, body.job_id)
      const plan = job.output?.vo_plan
      if (job.status !== 'needs_review' || job.output?.stage !== 'script' || !plan) throw new HttpError(409, 'There is no script waiting to be read.')
      // Charly's edits replace the words of each line; the shots stay as planned
      const said = (lines: unknown, old: { say: string }[]) => old.map((l, i) => ({ ...l, say: Array.isArray(lines) && typeof lines[i] === 'string' ? String(lines[i]).trim().slice(0, 600) : l.say }))
        .filter((l) => l.say)
      const vo_plan = { ...plan, vertical: said(body.vertical, plan.vertical), horizontal: said(body.horizontal, plan.horizontal) }
      if (!vo_plan.vertical.length || !vo_plan.horizontal.length) throw new HttpError(400, 'Both scripts need at least one line.')
      return await requeue(db, job, { voiceover: 'render', vo_plan })
    }

    case 'rewrite_script': {
      const job = await loadJob(db, body.job_id)
      if (job.status !== 'needs_review' || job.output?.stage !== 'script') throw new HttpError(409, 'There is no script waiting to be read.')
      const note = String(body.note ?? '').trim().slice(0, 1000)
      if (!note) throw new HttpError(400, 'Say what to change in the script.')
      return await requeue(db, job, { voiceover: 'script', previous_vo_plan: job.output?.vo_plan ?? null, script_note: note })
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
      if (job.output?.stage === 'ask_voiceover' || job.output?.stage === 'script') throw new HttpError(409, 'There is no cut to approve yet.')
      await db.from('jobs').update({ status: 'done', question: null, output: { ...(job.output ?? {}), verdict: 'approved', reviewed_by: user.email, reviewed_at: new Date().toISOString() } }).eq('id', job.id)
      // a new cut of a Ready product replaces the old one: earlier finished files go to finished/Earlier drafts
      if (job.input?.from_status === 'ready') {
        const mine = new Set(Object.values((job.output?.media ?? {}) as Record<string, string>))
        const { data: old } = await db.from('media').select('id').eq('product_id', job.product_id)
          .in('kind', ['finished_vertical', 'finished_horizontal', 'thumbnail'])
        await shelveMedia(db, job.product_id, (old ?? []).map((m) => m.id).filter((id) => !mine.has(id)))
        const { data: earlier } = await db.from('jobs').select('id,output').eq('product_id', job.product_id).eq('type', 'edit').neq('id', job.id)
        for (const e of earlier ?? []) {
          if (e.output?.media && Object.keys(e.output.media).length) {
            await db.from('jobs').update({ output: { ...e.output, media: {}, replaced_by: job.id } }).eq('id', e.id)
          }
        }
      }
      await db.from('products').update({ status: 'ready' }).eq('id', job.product_id).in('status', ['filmed', 'editing'])
      // copies into My Drive/Ready to Post, which the Mac keeps offline; a failure here never blocks the approval
      const ready = await syncReady(db, job.product_id).catch((e) => { console.error('Ready to Post:', e); return null })
      return { ok: true, ready_to_post: ready ? ready.copied : null }
    }

    case 'redo': {
      const job = await loadJob(db, body.job_id)
      if (job.status !== 'needs_review' && job.status !== 'done') throw new HttpError(409, 'Only a finished edit can be redone.')
      const note = String(body.note ?? '').trim().slice(0, 1000)
      if (!note) throw new HttpError(400, 'Say what to change, so the next cut can fix it.')
      await shelve(db, job)
      await db.from('jobs').update({ status: 'done', question: null, output: { ...(job.output ?? {}), media: {}, verdict: 'redo', redo_note: note, reviewed_by: user.email, reviewed_at: new Date().toISOString() } }).eq('id', job.id)
      const clipIds = (job.input?.clip_ids as string[] | undefined) ?? undefined
      // a voiced cut goes back to its script: Claude adjusts it to the note and Charly reads it again.
      // "Switch to a voice-over" on the Redo sheet does the same for a cut made from the clips' own audio:
      // the original-audio editor may never add a voice, so the note alone could not ask for one.
      const extra = job.output?.voiceover === 'voice'
        ? { voiceover: 'script', previous_vo_plan: job.output?.vo_plan ?? null, script_note: note }
        : body.voiceover ? { voiceover: 'script', script_note: note }
        : job.output?.voiceover === 'music' ? { voiceover: 'music' } : {}
      return await start(db, user.id, job.product_id, clipIds, note, job.id, job.input?.from_status, extra)
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
