import { DEAL_STATE_LABEL, dealState, type Deal, type ProductSource } from '../lib/types'

const fmt = (ts: string | null) =>
  ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null

/** The four ViralVue steps of a brand deal as a checklist, with a warning when a video went live before the brand heard from you. */
export function DealCard({ deal, productSource, children }: { deal: Deal; productSource?: ProductSource; children?: React.ReactNode }) {
  const steps: { label: string; at: string | null }[] = [
    { label: 'Message sent to the brand', at: deal.message_sent_at },
    { label: 'Product received', at: deal.received_at },
    { label: 'Video filmed and made', at: deal.video_created_at },
    { label: 'Video published on Amazon', at: deal.published_at },
  ]
  const noMessage = Boolean(deal.published_at && !deal.message_sent_at)
  const state = dealState(deal)
  return (
    <div className="card deal">
      <div className="deal-head">
        {deal.image_url && <img src={deal.image_url} alt="" className="thumb thumb-lg" />}
        <div>
          <div className="card-title">{deal.brand ?? 'Brand deal'} <span className={`chip chip-sm deal-${state}`}>{DEAL_STATE_LABEL[state]}</span></div>
          <div className="small">{deal.title}</div>
          <div className="muted small">
            {deal.asin && <a href={`https://www.amazon.com/dp/${deal.asin}`} target="_blank" rel="noreferrer">{deal.asin} ↗</a>}
            {deal.price != null ? ` · $${deal.price.toFixed(2)}` : ''}
            {deal.fee ? ` · fee $${deal.fee.toFixed(2)}` : ''}
            {deal.deal_created_at ? ` · deal ${fmt(deal.deal_created_at)}` : ''}
          </div>
        </div>
      </div>
      <ul className="steps">
        {steps.map((s) => (
          <li key={s.label} className={s.at ? 'step-on' : ''}>
            <span className={'box box-sm' + (s.at ? ' box-on' : '')} aria-hidden>{s.at ? '✓' : ''}</span>
            <span className="step-label">{s.label}</span>
            <span className="muted small">{fmt(s.at) ?? 'not yet'}</span>
          </li>
        ))}
      </ul>
      {productSource === 'bought' && <p className="muted small">Brand deal claimed, bought myself.</p>}
      {noMessage && <p className="flag">Published, but no message was sent to the brand. Send one in ViralVue.</p>}
      {children}
    </div>
  )
}
