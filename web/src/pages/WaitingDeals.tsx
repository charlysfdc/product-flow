import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DEAL_STATE_LABEL, dealState, type Deal } from '../lib/types'

const fmt = (ts: string | null) => (ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')

/** Brand deals you messaged where nothing has arrived. "Went quiet" (30+ days) is hidden unless asked for. */
export function WaitingDeals() {
  const [deals, setDeals] = useState<Deal[] | null>(null)
  const [showQuiet, setShowQuiet] = useState(false)

  useEffect(() => {
    supabase.from('deals').select('*').eq('match_status', 'waiting').order('deal_created_at', { ascending: false })
      .then(({ data }) => setDeals((data ?? []) as Deal[]))
  }, [])

  const rows = useMemo(() => {
    if (!deals) return []
    return deals.map((d) => ({ d, state: dealState(d) })).filter((x) => showQuiet || x.state === 'waiting')
  }, [deals, showQuiet])
  const quiet = deals?.filter((d) => dealState(d) === 'went_quiet').length ?? 0

  return (
    <main>
      <Link to="/" className="back">‹ Home</Link>
      <h1>Waiting on brand</h1>
      <p className="muted small">Deals you messaged in ViralVue where nothing has arrived. Tap one when the box turns up.</p>
      {quiet > 0 && (
        <label className="toggle">
          <input type="checkbox" checked={showQuiet} onChange={(e) => setShowQuiet(e.target.checked)} /> Show the {quiet} that went quiet (no reply in 30 days)
        </label>
      )}
      {!deals ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="empty">Nothing waiting.</p> : (
        <ul className="list">
          {rows.map(({ d, state }) => (
            <li key={d.id}>
              <Link to={`/deal/${d.id}`} className="row">
                {d.image_url && <img src={d.image_url} alt="" className="thumb" />}
                <div className="row-main">
                  <div className="row-title">{d.brand ?? d.title}</div>
                  <div className="row-sub"><span>{d.title}</span></div>
                  <div className="row-sub"><span>{DEAL_STATE_LABEL[state]}{d.message_sent_at ? ` · messaged ${fmt(d.message_sent_at)}` : d.deal_created_at ? ` · since ${fmt(d.deal_created_at)}` : ''}</span></div>
                </div>
                <span className="chev" aria-hidden>›</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
