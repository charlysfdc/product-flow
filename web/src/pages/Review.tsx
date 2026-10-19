import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { approveEdit, redoEdit, reviewFiles, type ReviewFile } from '../lib/functions'
import { fmtDuration } from '../lib/upload'
import type { Job, Product } from '../lib/types'
import { Thumb } from '../components/ProductRow'
import { Sheet } from '../components/Sheet'

type Files = Partial<Record<'finished_vertical' | 'finished_horizontal' | 'thumbnail', ReviewFile>>
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const driveUrl = (id: string) => `https://drive.google.com/file/d/${id}/view`

/** Review edit: play both cuts, see the thumbnail, then Approve or Redo with a note. */
export function Review() {
  const { jobId } = useParams()
  const navigate = useNavigate()
  const [job, setJob] = useState<Job | null>(null)
  const [product, setProduct] = useState<Product | null>(null)
  const [files, setFiles] = useState<Files | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [redo, setRedo] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    ;(async () => {
      const { data: j, error: je } = await supabase.from('jobs').select('*').eq('id', jobId).single()
      if (cancelled) return
      if (je || !j) return setError(je?.message ?? 'That edit was not found.')
      setJob(j as Job)
      const { data: p } = await supabase.from('products').select('*').eq('id', (j as Job).product_id!).single()
      if (!cancelled) setProduct(p as Product)
      try {
        const r = await reviewFiles(jobId)
        if (!cancelled) setFiles(r.files)
      } catch (e) {
        if (!cancelled) setError(`Could not load the files: ${(e as Error).message}`)
      }
    })()
    return () => { cancelled = true }
  }, [jobId])

  const approve = async () => {
    if (!job) return
    setBusy(true)
    setError(null)
    try {
      await approveEdit(job.id)
      navigate(`/product/${job.product_id}`, { replace: true })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const sendRedo = async () => {
    if (!job || !note.trim()) return
    setBusy(true)
    setError(null)
    try {
      const r = await redoEdit(job.id, note.trim())
      navigate(`/product/${job.product_id}`, { replace: true, state: r.warning ? { notice: r.warning } : undefined })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  if (error && !job) return <main><Link to="/" className="back">‹ Home</Link><p className="error">{error}</p></main>
  if (!job || !product) return <main><Link to="/" className="back">‹ Home</Link><p className="muted">Loading…</p></main>

  const out = job.output ?? {}
  const plan = out.plan
  const reviewing = job.status === 'needs_review'
  const v = files?.finished_vertical, h = files?.finished_horizontal, t = files?.thumbnail

  return (
    <main className="has-bar">
      <div className="pn">
        <Link to={`/product/${product.id}`} className="bk" aria-label="Back to the product">‹</Link>
        <Thumb src={product.product_image_url} name={product.name} />
        <div style={{ minWidth: 0 }}>
          <h1>{reviewing ? 'Review the edit' : out.verdict === 'approved' ? 'Approved edit' : 'Edit'}</h1>
          <small>{product.name}</small>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <section className="rv">
        <div className="rv-head"><span className="eyebrow">Vertical · TikTok Shop, Reels</span><span>{fmtDuration(out.lengths?.vertical)}</span></div>
        {v ? <video className="rv-v" src={`${v.url}#t=0.3`} controls playsInline preload="metadata" /> : <div className="rv-v rv-wait">{files ? 'Not found in Drive' : 'Loading…'}</div>}
        {plan?.hook && <p className="rv-meta">Hook: “{plan.hook}” · ends on “{plan.product_label}”</p>}
        {v && <a className="rv-link" href={driveUrl(v.drive_file_id)} target="_blank" rel="noreferrer">Open in Drive ↗</a>}
      </section>

      <section className="rv">
        <div className="rv-head"><span className="eyebrow">Horizontal · Amazon review</span><span>{fmtDuration(out.lengths?.horizontal)}</span></div>
        {h ? <video className="rv-h" src={`${h.url}#t=0.3`} controls playsInline preload="metadata" /> : <div className="rv-h rv-wait">{files ? 'Not found in Drive' : 'Loading…'}</div>}
        {h && <a className="rv-link" href={driveUrl(h.drive_file_id)} target="_blank" rel="noreferrer">Open in Drive ↗</a>}
      </section>

      <section className="rv">
        <div className="rv-head"><span className="eyebrow">Thumbnail</span><span>1280×720</span></div>
        {t ? <img className="rv-h" src={t.url} alt={`Thumbnail: ${plan?.thumbnail?.text ?? ''}`} /> : <div className="rv-h rv-wait">{files ? 'Not found in Drive' : 'Loading…'}</div>}
      </section>

      {(plan?.footage || plan?.concerns || out.skipped?.length || out.problems?.length) && (
        <section>
          <h2>From the editor</h2>
          <div className="card rv-notes">
            {plan?.footage && <p>{plan.footage}</p>}
            {plan?.concerns && <p className="flag">{plan.concerns}</p>}
            {out.skipped?.map((s) => <p key={s} className="muted small">Skipped a duplicate: {s}</p>)}
            {out.problems?.map((s) => <p key={s} className="muted small">Note: {s}</p>)}
          </div>
        </section>
      )}

      {out.cuts && (
        <section>
          <h2>What’s in the vertical cut <span className="count">{out.cuts.vertical.length}</span></h2>
          <ol className="list rv-cuts">
            {out.cuts.vertical.map((c, i) => (
              <li key={i}><b>“{c.said.length > 110 ? c.said.slice(0, 110) + '…' : c.said || '(no words)'}”</b><small>{c.why} · {out.clips?.[c.clip] ?? c.clip} {clock(c.a)}–{clock(c.b)}</small></li>
            ))}
          </ol>
        </section>
      )}

      {out.cost && (
        <p className="muted small footer">
          Took {fmtDuration(out.cost.cpu_seconds)} · about ${out.cost.total_usd.toFixed(2)} (cloud ${out.cost.modal_usd.toFixed(2)}, Claude ${out.cost.claude_usd.toFixed(2)})
        </p>
      )}

      {reviewing && (
        <div className="arrived rv-actions">
          <button className="primary" disabled={busy || !files} onClick={approve}>{busy ? 'Saving…' : 'Approve'}</button>
          <button className="secondary" disabled={busy} onClick={() => setRedo(true)}>Redo…</button>
        </div>
      )}

      {redo && (
        <Sheet title="What should change?" onClose={() => setRedo(false)}>
          <p className="muted small">The next cut keeps what works and changes what you say. This one moves to finished/Earlier drafts.</p>
          <form className="form" onSubmit={(e) => { e.preventDefault(); sendRedo() }}>
            <label>
              Note
              <textarea rows={4} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Open on the pour. Cut the bit about the scale. Thumbnail text: Liquid gold." />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="primary" type="submit" disabled={busy || !note.trim()}>{busy ? 'Starting…' : 'Redo the edit'}</button>
          </form>
        </Sheet>
      )}
    </main>
  )
}
