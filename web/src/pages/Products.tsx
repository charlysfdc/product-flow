import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useSnapshot } from '../lib/data'
import { buildFlow, editLabel, preview, unposted } from '../lib/flow'
import { PLATFORM_LABEL, STATUS_LABEL } from '../lib/types'
import { ProductRow, Thumb } from '../components/ProductRow'
import { ReminderRow } from '../components/ViralVue'
import { platformList } from '../lib/publish'

const fmtDay = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** Products: one block per list, in Charly's order; each opens its list. */
export function Products() {
  const { data, error } = useSnapshot()
  const flow = useMemo(() => (data ? buildFlow(data) : null), [data])
  const vv = data?.reminders ?? []
  const received = vv.filter((r) => r.kind === 'received').length
  const message = vv.filter((r) => r.kind === 'message').length
  const published = vv.filter((r) => r.kind === 'published').length

  return (
    <main>
      <Link to="/" className="back">‹ Home</Link>
      <h1>Products</h1>
      <p className="muted page-sub">{data ? `${data.products.length.toLocaleString()} in the flow · tap a block for its list` : 'Loading…'}</p>
      {error && <p className="error">Could not load: {error}</p>}
      {flow && data && (
        <div className="blocks">
          <Link to="/products/answers" className={'block' + (flow.answers ? ' block-ask' : '')}>
            <span className="block-big">{flow.answers}</span>
            <span className="block-main"><b>Answers needed</b><small>{flow.reviews.length} edit{flow.reviews.length === 1 ? '' : 's'} to review · {flow.asks.length} deal question{flow.asks.length === 1 ? '' : 's'}</small></span>
            <span className="chev" aria-hidden>›</span>
          </Link>
          <Link to="/products/film" className="block">
            <span className="block-big">{flow.film.length}</span>
            <span className="block-main"><b>Film</b><small>{preview(flow.film) || 'Nothing waiting to be filmed'}</small></span>
            <span className="chev" aria-hidden>›</span>
          </Link>
          <Link to="/products/edit" className="block">
            <span className="block-big">{flow.edit.length}</span>
            <span className="block-main"><b>Edit</b><small>{preview(flow.edit) || 'No raw footage is waiting'}</small></span>
            <span className="chev" aria-hidden>›</span>
          </Link>
          <Link to="/products/post" className="block">
            <span className="block-big">{flow.postCount}</span>
            <span className="block-main"><b>Post {flow.postDue > 0 && <i className="badge-due">{flow.postDue} TikTok due</i>}</b><small>{preview(flow.post.flatMap((g) => g.items).filter((p, i, a) => a.indexOf(p) === i)) || 'Nothing finished is waiting'}</small></span>
            <span className="chev" aria-hidden>›</span>
          </Link>
          <Link to="/products/completed" className="block">
            <span className="block-big">{flow.completed.length.toLocaleString()}</span>
            <span className="block-main"><b>Completed</b><small>{preview(flow.completed.map((c) => c.product)) || 'Nothing posted everywhere yet'}</small></span>
            <span className="chev" aria-hidden>›</span>
          </Link>
          <Link to="/products/viralvue" className="block">
            <span className="block-big">{vv.length}</span>
            <span className="block-main"><b>ViralVue updates</b><small>{vv.length ? [received && `${received} Tick Received`, published && `${published} Tick Video published`, message && `${message} Message the brand`].filter(Boolean).join(' · ') : 'Nothing to tick'}</small></span>
            <span className="chev" aria-hidden>›</span>
          </Link>
          <Link to="/deals/waiting" className="block">
            <span className="block-big">{data.waiting.toLocaleString()}</span>
            <span className="block-main"><b>Waiting on brand</b><small>Brands haven’t sent yet{data.quiet ? ` · ${data.quiet.toLocaleString()} went quiet` : ''}</small></span>
            <span className="chev" aria-hidden>›</span>
          </Link>
          <Link to="/products/all" className="block">
            <span className="block-big">{data.products.length.toLocaleString()}</span>
            <span className="block-main"><b>All products</b><small>Including {data.products.filter((p) => p.status === 'done').length} posted everywhere</small></span>
            <span className="chev" aria-hidden>›</span>
          </Link>
        </div>
      )}
    </main>
  )
}

const TITLES: Record<string, string> = { answers: 'Answers needed', film: 'Film', edit: 'Edit', post: 'Post', completed: 'Completed', viralvue: 'ViralVue updates', all: 'All products' }

/** One list from the Products page. Every product row opens the Product screen. */
export function ProductList() {
  const { list = 'all' } = useParams()
  const { data, error, reload } = useSnapshot()
  const flow = useMemo(() => (data ? buildFlow(data) : null), [data])
  const [q, setQ] = useState('')

  const body = (() => {
    if (!flow || !data) return <p className="muted">Loading…</p>
    switch (list) {
      case 'answers':
        return flow.answers === 0 ? <p className="empty">Nothing needs an answer.</p> : (
          <ul className="list">
            {flow.reviews.map(({ job, product }) => (
              <li key={job.id}>
                <Link to={`/review/${job.id}`} className="row">
                  <Thumb src={product.product_image_url} name={product.name} />
                  <div className="row-main"><div className="row-title">{product.name}</div><div className="row-sub"><span>{job.question ?? 'Review the edit'}</span></div></div>
                  <span className="chev" aria-hidden>›</span>
                </Link>
              </li>
            ))}
            {flow.asks.map(({ deal: d, suggestion }) => (
              <li key={d.id}>
                <Link to={`/deal/${d.id}`} className="row" state={suggestion ? { confirmId: suggestion.id } : undefined}>
                  <Thumb src={d.image_url} name={d.brand ?? '?'} />
                  <div className="row-main"><div className="row-title">{d.title ?? d.asin}</div><div className="row-sub"><span>Brand deal{d.brand ? ` · ${d.brand}` : ''}</span><span>{suggestion ? `Same as ${suggestion.name}?` : 'Which product is this?'}</span></div></div>
                  <span className="chev" aria-hidden>›</span>
                </Link>
              </li>
            ))}
          </ul>
        )
      case 'film':
        return flow.film.length === 0 ? <p className="empty">Nothing waiting to be filmed.</p>
          : <ul className="list">{flow.film.map((p) => <ProductRow key={p.id} product={p} detail={p.status === 'expected' ? 'On its way' : null} />)}</ul>
      case 'edit':
        return flow.edit.length === 0 ? <p className="empty">No raw footage is waiting.</p>
          : <ul className="list">{flow.edit.map((p) => <ProductRow key={p.id} product={p} detail={editLabel(flow.editing.get(p.id))} />)}</ul>
      case 'post':
        return flow.post.length === 0 ? <p className="empty">Nothing finished is waiting to be posted.</p> : (
          <>
            {flow.postDue === 0 && <p className="muted small page-sub">No TikTok Shop deadline in the next 7 days.</p>}
            {flow.post.map((g) => (
              <section key={g.key} className="list-group">
                <h2 className={g.key === 'due' ? 'h-due' : undefined}>{g.label} <span className="count">{g.items.length}</span></h2>
                <ul className="list">{g.items.map((p) => <ProductRow key={p.id} product={p} detail={g.key === 'due' ? unposted(p, data.listings, data.posts).map((pl) => PLATFORM_LABEL[pl]).join(', ') : null} />)}</ul>
              </section>
            ))}
          </>
        )
      case 'completed':
        return flow.completed.length === 0 ? <p className="empty">Nothing is posted everywhere yet.</p> : (
          <>
            <p className="muted small page-sub">{flow.completed.length.toLocaleString()} posted everywhere · newest post first</p>
            <ul className="list">
              {flow.completed.map(({ product: p, lastPosted, platforms }) => (
                <ProductRow key={p.id} product={p} detail={[platformList(platforms, (pl) => PLATFORM_LABEL[pl]) || 'No post recorded', lastPosted ? `posted ${fmtDay(lastPosted)}` : null].filter(Boolean).join(' · ')} />
              ))}
            </ul>
          </>
        )
      case 'viralvue':
        return data.reminders.length === 0 ? <p className="empty">Nothing to tick in ViralVue.</p> : (
          <>
            <p className="muted small page-sub">Copy the ASIN, paste it in ViralVue’s search, tick it there, then tap Done.</p>
            <ul className="list">{data.reminders.map((r) => <ReminderRow key={r.id} r={r} productName={data.products.find((p) => p.id === r.deal?.product_id)?.name ?? null} onDone={reload} />)}</ul>
          </>
        )
      default: {
        const s = q.trim().toLowerCase()
        const items = s ? flow.all.filter((p) => p.name.toLowerCase().includes(s) || (p.brand ?? '').toLowerCase().includes(s)) : flow.all
        return (
          <>
            <input type="search" className="search" placeholder="Filter by name or brand" aria-label="Filter products" value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="none" autoCorrect="off" />
            <p className="muted small page-sub">{items.length.toLocaleString()} products · {Object.entries(STATUS_LABEL).map(([k, label]) => [flow.all.filter((p) => p.status === k).length, label] as const).filter(([n]) => n > 0).map(([n, label]) => `${n} ${label.toLowerCase()}`).join(' · ')}</p>
            <ul className="list">{items.map((p) => <ProductRow key={p.id} product={p} showStatus />)}</ul>
          </>
        )
      }
    }
  })()

  return (
    <main>
      <Link to="/products" className="back">‹ Products</Link>
      <h1>{TITLES[list] ?? 'Products'}</h1>
      {error && <p className="error">Could not load: {error}</p>}
      <div style={{ marginTop: 10 }}>{body}</div>
    </main>
  )
}
