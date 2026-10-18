import { Link, useParams } from 'react-router-dom'
import { useProduct } from '../lib/data'
import { AVAILABILITY_LABEL, PLATFORM_LABEL, SOURCE_LABEL, STATUS_LABEL } from '../lib/types'
import { deadlineText } from '../components/ProductRow'

function fmtDate(d: string | null) {
  if (!d) return null
  return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function ProductPage() {
  const { id } = useParams()
  const { detail, error } = useProduct(id)

  if (error) return <main><Link to="/" className="back">‹ Home</Link><p className="error">{error}</p></main>
  if (!detail) return <main><Link to="/" className="back">‹ Home</Link><p className="muted">Loading…</p></main>

  const { product: p, listings, posts, jobs } = detail
  const due = deadlineText(p.deadline)
  const totalViews = posts.reduce((n, po) => n + (po.views ?? 0), 0)

  return (
    <main>
      <Link to="/" className="back">‹ Home</Link>
      <header className="product-head">
        {p.product_image_url && <img src={p.product_image_url} alt="" className="product-img" />}
        <h1>{p.name}</h1>
        <div className="chips">
          <span className={`chip status-${p.status}`}>{STATUS_LABEL[p.status]}</span>
          <span className="chip">{SOURCE_LABEL[p.source]}</span>
          {due && <span className="chip chip-due">{due}</span>}
        </div>
        <dl className="facts">
          {p.brand && <><dt>Brand</dt><dd>{p.brand}</dd></>}
          {p.variant && <><dt>Variant</dt><dd>{p.variant}</dd></>}
          {p.upc && <><dt>Barcode</dt><dd>{p.upc}</dd></>}
          {p.received_at && <><dt>Received</dt><dd>{fmtDate(p.received_at)}</dd></>}
          {p.deadline && <><dt>Deadline</dt><dd>{fmtDate(p.deadline)}</dd></>}
          {p.drive_folder_name && <><dt>Drive folder</dt><dd>Products / {p.drive_folder_name}</dd></>}
        </dl>
      </header>

      <section>
        <h2>Listings <span className="count">{listings.length}</span></h2>
        {listings.length === 0 ? (
          <p className="empty">No platform listings recorded yet.</p>
        ) : (
          <ul className="cards">
            {listings.map((l) => (
              <li key={l.id} className="card">
                <div className="card-title">{PLATFORM_LABEL[l.platform]}</div>
                <div className="card-body">
                  {l.external_id && (
                    <div>
                      {l.url ? <a href={l.url} target="_blank" rel="noreferrer">{l.external_id}</a> : l.external_id}
                    </div>
                  )}
                  <div className="muted small">
                    {AVAILABILITY_LABEL[l.availability]}
                    {l.availability_note && l.availability_note !== l.availability ? ` · ${l.availability_note}` : ''}
                    {l.commission ? ` · ${l.commission}` : ''}
                    {l.checked_at ? ` · checked ${fmtDate(l.checked_at)}` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Posts <span className="count">{posts.length}</span></h2>
        {posts.length === 0 ? (
          <p className="empty">Not posted anywhere yet.</p>
        ) : (
          <>
            {totalViews > 0 && <p className="muted small">{totalViews.toLocaleString()} views in total</p>}
            <ul className="cards">
              {posts.map((po) => (
                <li key={po.id} className="card">
                  <div className="card-title">
                    {PLATFORM_LABEL[po.platform]} <span className="muted small">· {po.status === 'posted' ? 'posted' : 'planned'}</span>
                  </div>
                  <div className="card-body">
                    {po.title && <div>{po.url ? <a href={po.url} target="_blank" rel="noreferrer">{po.title}</a> : po.title}</div>}
                    <div className="muted small">
                      {po.posted_at ? fmtDate(po.posted_at) : ''}
                      {po.views != null ? ` · ${po.views.toLocaleString()} views` : ''}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {jobs.length > 0 && (
        <section>
          <h2>Jobs</h2>
          <ul className="cards">
            {jobs.map((j) => (
              <li key={j.id} className="card">
                <div className="card-title">{j.type} <span className="muted small">· {j.status.replace('_', ' ')}</span></div>
                {j.question && <div className="card-body">{j.question}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.notes && (
        <section>
          <h2>Notes</h2>
          <p className="notes">{p.notes}</p>
        </section>
      )}
    </main>
  )
}
