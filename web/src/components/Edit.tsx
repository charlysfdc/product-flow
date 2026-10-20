import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Sheet } from './Sheet'
import { retryEdit, startEdit } from '../lib/functions'
import { fmtDuration } from '../lib/upload'
import type { Job, Media } from '../lib/types'

/** The product's latest edit job, if any. */
export const latestEdit = (jobs: Job[]): Job | undefined =>
  jobs.filter((j) => j.type === 'edit').sort((a, b) => b.created_at.localeCompare(a.created_at))[0]

const STUCK_MS = 20 * 60_000

/** "Edit": pick the clips (all by default) and add an optional note, then the worker takes over. */
export function EditSheet({ productId, clips, mode = 'first', onClose, onStarted }: {
  productId: string
  clips: Media[]
  mode?: 'first' | 'again' | 'extra'   // again: a Ready product, builds on the approved cut; extra: a Posted product
  onClose: () => void
  onStarted: (jobId: string, warning: string | null) => void
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(clips.map((c) => c.id)))
  const [note, setNote] = useState('')
  const [voiceover, setVoiceover] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })
  const total = clips.filter((c) => picked.has(c.id)).reduce((n, c) => n + (c.duration_s ?? 0), 0)

  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      const all = picked.size === clips.length
      const r = await startEdit(productId, all ? undefined : [...picked], note.trim() || undefined, voiceover || undefined)
      onStarted(r.job_id, r.warning)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Sheet title={mode === 'again' ? 'Edit it again' : mode === 'extra' ? 'Make an extra cut' : 'Edit it'} onClose={onClose}>
      {mode === 'again' ? (
        <p className="muted small">
          A new cut that starts from the one you approved, changed by your note. The product shows as Editing until you
          review it; when you approve, the old cut moves to finished/Earlier drafts and it is ready to post again.
          If the new cut fails, nothing changes.
        </p>
      ) : mode === 'extra' ? (
        <p className="muted small">
          It’s already posted, so the status stays Posted and the finished videos stay; the new cut is added next to them.
        </p>
      ) : (
        <p className="muted small">
          A vertical cut (30–37 s, for TikTok Shop and Reels), a horizontal review for Amazon (1–2 min) and a thumbnail,
          made from your real audio and put in the finished folder. It takes a few minutes; you can leave this screen.
        </p>
      )}
      {clips.length === 0 && <p className="card">Every video in the product’s raw folder in Drive will be used.</p>}
      {clips.length > 0 && <ul className="options">
        {clips.map((c) => (
          <li key={c.id}>
            <button className={'option' + (picked.has(c.id) ? ' option-on' : '')} onClick={() => toggle(c.id)}>
              <span className="option-label clip-name">{c.filename}</span>
              <span className="option-help">{[fmtDuration(c.duration_s), c.shot_on].filter(Boolean).join(' · ') || 'Raw clip'}</span>
              <span className="tick" aria-hidden>{picked.has(c.id) ? '✓' : ''}</span>
            </button>
          </li>
        ))}
      </ul>}
      <form className="form" onSubmit={(e) => { e.preventDefault(); go() }}>
        <label>
          {mode === 'again' ? 'What should change?' : 'Anything to know?'} <span className="muted">(optional)</span>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'again' ? 'e.g. Shorter intro. Use the close-up of the bottle.' : "e.g. Start on the reveal. Zanje's take is the better one."} />
        </label>
        <label className="vo-switch">
          <input type="checkbox" checked={voiceover} onChange={(e) => setVoiceover(e.target.checked)} />
          <span><b>Add a voice-over</b><small>For footage without talking or with bad sound: Claude writes a script in your words, you read and approve it, then your voice reads it.</small></span>
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit" disabled={busy || (clips.length > 0 && picked.size === 0)}>
          {busy ? 'Starting…' : clips.length === 0 ? 'Edit all clips' : `Edit ${picked.size} clip${picked.size === 1 ? '' : 's'}${total ? ` · ${fmtDuration(total)}` : ''}`}
        </button>
      </form>
    </Sheet>
  )
}

/** Live state of an edit inside the Next step card: progress, a review button, or what went wrong. */
export function EditStatus({ job, onEdit }: { job: Job; onEdit: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const p = job.output?.progress ?? job.progress ?? null
  const stuck = job.status === 'running' && job.updated_at && Date.now() - new Date(job.updated_at).getTime() > STUCK_MS
  const retry = async () => {
    setBusy(true)
    setError(null)
    try {
      await retryEdit(job.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (job.status === 'needs_review') {
    const stage = job.output?.stage
    return <Link className="pri" to={stage === 'script' ? `/script/${job.id}` : `/review/${job.id}`}>
      {stage === 'ask_voiceover' ? 'No talking found: answer' : stage === 'script' ? 'Read the voice-over script' : 'Review the edit'}
    </Link>
  }
  if (job.status === 'failed' || stuck) {
    return (
      <>
        <p className="edit-err">{stuck ? 'The edit stopped reporting progress.' : job.output?.error ?? 'The edit failed.'}</p>
        {error && <p className="edit-err">{error}</p>}
        <button className="pri" disabled={busy} onClick={retry}>{busy ? 'Starting…' : 'Try again'}</button>
        <div className="sub"><span>Change the clips or add a note?</span><button onClick={onEdit}>Edit again ›</button></div>
      </>
    )
  }
  const pct = Math.max(2, Math.min(100, p?.pct ?? 0))
  const waiting = job.status === 'queued'
  return (
    <div className="edit-progress" aria-live="polite">
      <div className="ep-head"><b>{p?.step ?? (waiting ? 'Waiting for the worker' : 'Starting')}</b><span>{pct}%</span></div>
      <div className="bar bar-light"><i style={{ width: `${pct}%` }} /></div>
      {p?.note && <small>{p.note}</small>}
      {waiting && p?.note && (
        <button className="link-light" disabled={busy} onClick={retry}>{busy ? 'Trying…' : 'Try again'}</button>
      )}
      {error && <small className="edit-err">{error}</small>}
    </div>
  )
}
