import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { approveScript, rewriteScript } from '../lib/functions'
import type { Job, Product, ScriptLine } from '../lib/types'
import { Thumb } from '../components/ProductRow'
import { Sheet } from '../components/Sheet'

const words = (lines: string[]) => lines.reduce((n, l) => n + l.split(/\s+/).filter(Boolean).length, 0)
const seconds = (n: number) => Math.round(n / 2.6)

/** Voice-over script: Charly reads and edits what their cloned voice will say, line by line, before any audio exists. */
export function Script() {
  const { jobId } = useParams()
  const navigate = useNavigate()
  const [job, setJob] = useState<Job | null>(null)
  const [product, setProduct] = useState<Product | null>(null)
  const [vertical, setVertical] = useState<string[]>([])
  const [horizontal, setHorizontal] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [again, setAgain] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    ;(async () => {
      const { data: j, error: je } = await supabase.from('jobs').select('*').eq('id', jobId).single()
      if (cancelled) return
      if (je || !j) return setError(je?.message ?? 'That edit was not found.')
      const job = j as Job
      setJob(job)
      setVertical((job.output?.vo_plan?.vertical ?? []).map((l: ScriptLine) => l.say))
      setHorizontal((job.output?.vo_plan?.horizontal ?? []).map((l: ScriptLine) => l.say))
      const { data: p } = await supabase.from('products').select('*').eq('id', job.product_id!).single()
      if (!cancelled) setProduct(p as Product)
    })()
    return () => { cancelled = true }
  }, [jobId])

  const back = (warning: string | null) => navigate(`/product/${job!.product_id}`, { replace: true, state: warning ? { notice: warning } : undefined })

  const approve = async () => {
    if (!job) return
    setBusy(true)
    setError(null)
    try {
      back((await approveScript(job.id, vertical, horizontal)).warning)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const rewrite = async () => {
    if (!job || !note.trim()) return
    setBusy(true)
    setError(null)
    try {
      back((await rewriteScript(job.id, note.trim())).warning)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  if (error && !job) return <main><Link to="/" className="back">‹ Home</Link><p className="error">{error}</p></main>
  if (!job || !product) return <main><Link to="/" className="back">‹ Home</Link><p className="muted">Loading…</p></main>

  const plan = job.output?.vo_plan
  const waiting = job.status === 'needs_review' && job.output?.stage === 'script'
  if (!plan) return <main><Link to={`/product/${product.id}`} className="back">‹ {product.name}</Link><p className="muted">This edit has no script.</p></main>

  const block = (title: string, sub: string, lines: string[], set: (l: string[]) => void, planned: ScriptLine[]) => (
    <section className="rv">
      <div className="rv-head"><span className="eyebrow">{title}</span><span>{words(lines)} words · about {seconds(words(lines))} s</span></div>
      <p className="rv-meta">{sub}</p>
      {lines.map((l, i) => (
        <label key={i} className="sc-line">
          <textarea rows={Math.max(2, Math.ceil(l.length / 38))} value={l} disabled={!waiting || busy}
            onChange={(e) => set(lines.map((x, k) => (k === i ? e.target.value : x)))} />
          <small>Over {planned[i]?.shots.map((s) => `${job.output?.clips?.[s.clip] ?? s.clip} at ${Math.round(s.start)} s`).join(', ') || 'the footage'}</small>
        </label>
      ))}
    </section>
  )

  return (
    <main>
      <div className="pn">
        <Link to={`/product/${product.id}`} className="bk" aria-label="Back to the product">‹</Link>
        <Thumb src={product.product_image_url} name={product.name} />
        <div style={{ minWidth: 0 }}><h1>Voice-over script</h1><small>{product.name}</small></div>
      </div>
      {error && <p className="error">{error}</p>}

      {waiting && (
        <div className="rv-decide">
          <button className="primary" disabled={busy} onClick={approve}>{busy ? 'Starting…' : 'Approve script'}</button>
          <button className="secondary" disabled={busy} onClick={() => setAgain(true)}>Write it again</button>
        </div>
      )}
      <p className="muted small" style={{ margin: '6px 4px 0' }}>
        Change any words you like; each line keeps the shots it plays over. Your voice ({'Charly South African'}) reads it only after you approve.
        Hook on screen: “{plan.hook}”. Name at the end: “{plan.product_label}”.
      </p>

      {block('Vertical · TikTok Shop, Reels', 'Aim for 65–95 words (30–35 s). Never mention Amazon.', vertical, setVertical, plan.vertical)}
      {block('Horizontal · Amazon review', 'Aim for 150–290 words (1–2 min). No prices, shipping or links.', horizontal, setHorizontal, plan.horizontal)}

      {(plan.footage || plan.concerns) && (
        <section>
          <h2>From the editor</h2>
          <div className="card rv-notes">
            {plan.footage && <p>{plan.footage}</p>}
            {plan.concerns && <p className="flag">{plan.concerns}</p>}
          </div>
        </section>
      )}

      {waiting && (
        <div className="rv-decide rv-end">
          <button className="primary" disabled={busy} onClick={approve}>{busy ? 'Starting…' : 'Approve script'}</button>
          <button className="secondary" disabled={busy} onClick={() => setAgain(true)}>Write it again</button>
        </div>
      )}

      {again && (
        <Sheet title="Write it again" onClose={() => setAgain(false)}>
          <p className="muted small">Claude rewrites both scripts with your note and keeps what you don’t mention.</p>
          <form className="form" onSubmit={(e) => { e.preventDefault(); rewrite() }}>
            <label>
              Note
              <textarea rows={4} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Funnier. Say it worked on the whole 10-hour flight. Shorter intro." />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="primary" type="submit" disabled={busy || !note.trim()}>{busy ? 'Starting…' : 'Write it again'}</button>
          </form>
        </Sheet>
      )}
    </main>
  )
}
