import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { stillWaitingFilter } from '../lib/data'
import { DEAL_STATE_LABEL, dealState, type Deal } from '../lib/types'

const PAGE = 50
const fmt = (ts: string | null) => (ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')

/**
 * Brand deals you messaged where nothing has arrived. By default only the live
 * ones (brand is talking, or messaged within 30 days); a toggle adds the ones
 * that went quiet and the declined ones. Pages of 50, searchable.
 */
export function WaitingDeals() {
  const [rows, setRows] = useState<Deal[]>([])
  const [count, setCount] = useState<number | null>(null)
  const [page, setPage] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setPage(0)
  }, [showAll, q])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const t = window.setTimeout(async () => {
      let query = supabase.from('deals').select('*', { count: 'exact' }).is('product_id', null)
      query = showAll ? query.in('match_status', ['waiting', 'ignored']) : query.eq('match_status', 'waiting').or(stillWaitingFilter())
      const s = q.trim().replace(/[%,()]/g, ' ').trim()
      if (s) query = query.or(`brand.ilike.%${s}%,title.ilike.%${s}%,asin.ilike.%${s}%`)
      const { data, count } = await query.order('deal_created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1)
      if (cancelled) return
      setRows((data ?? []) as Deal[])
      setCount(count ?? 0)
      setLoading(false)
    }, q ? 250 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [page, showAll, q])

  const pages = useMemo(() => Math.max(1, Math.ceil((count ?? 0) / PAGE)), [count])

  return (
    <main>
      <Link to="/products" className="back">‹ Products</Link>
      <h1>Waiting on brand</h1>
      <p className="muted small">Deals you messaged in ViralVue where nothing has arrived. Tap one when the box turns up.</p>
      <input type="search" className="search" placeholder="Search brand, product or ASIN" value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="none" autoCorrect="off" />
      <label className="toggle">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Include the ones that went quiet or were declined
      </label>
      <p className="muted small">{count === null ? '' : `${count.toLocaleString()} deal${count === 1 ? '' : 's'}`}{loading ? ' · loading…' : ''}</p>
      {!loading && rows.length === 0 ? <p className="empty">Nothing here.</p> : (
        <ul className="list">
          {rows.map((d) => {
            const state = dealState(d)
            return (
              <li key={d.id}>
                <Link to={`/deal/${d.id}`} className="row">
                  {d.image_url && <img src={d.image_url} alt="" className="thumb" />}
                  <div className="row-main">
                    <div className="row-title">{d.brand ?? d.title}</div>
                    <div className="row-sub"><span>{d.title}</span></div>
                    <div className="row-sub"><span>{DEAL_STATE_LABEL[state]}{d.status_raw ? ` · ${d.status_raw.replace('_', ' ')}` : ''}{d.message_sent_at ? ` · messaged ${fmt(d.message_sent_at)}` : d.deal_created_at ? ` · since ${fmt(d.deal_created_at)}` : ''}</span></div>
                  </div>
                  <span className="chev" aria-hidden>›</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      {pages > 1 && (
        <div className="pager">
          <button className="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Newer</button>
          <span className="muted small">{page + 1} / {pages}</span>
          <button className="secondary" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Older ›</button>
        </div>
      )}
    </main>
  )
}
