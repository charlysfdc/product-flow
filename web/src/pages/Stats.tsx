import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useDealStats, useSnapshot } from '../lib/data'
import { buildFlow, daysToPosted, money, valueOf } from '../lib/flow'
import { SOURCE_LABEL, fmtPrice, type Post, type Product } from '../lib/types'
import { Thumb } from '../components/ProductRow'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmtDay = (d: string | null | undefined) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null)
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '–')

/** Value per month this year, January to this month. */
function byMonth(items: Product[]) {
  const now = new Date().getMonth()
  return MONTHS.slice(0, now + 1).map((label, i) => {
    const mm = String(i + 1).padStart(2, '0')
    const these = items.filter((p) => p.received_at?.slice(5, 7) === mm)
    return { label, key: mm, value: these.reduce((n, p) => n + (p.price != null ? Number(p.price) : 0), 0), count: these.length }
  })
}

function Bars({ months }: { months: { label: string; value: number }[] }) {
  const max = Math.max(1, ...months.map((m) => m.value))
  const top = months.reduce((a, b) => (b.value > a.value ? b : a), months[0])
  return (
    <div className="bars" role="img" aria-label={months.map((m) => `${m.label} ${money(m.value)}`).join(', ')}>
      {months.map((m) => (
        <span key={m.label} className="bar-col">
          <span className={'bar-v' + (m === top && m.value ? ' bar-top' : '') + (m.value ? '' : ' bar-zero')} style={{ height: m.value ? `${Math.max(6, (m.value / max) * 60)}px` : '2px' }} />
          <small>{m.label}</small>
        </span>
      ))}
    </div>
  )
}

const amazonViews = (posts: Post[]) => posts.filter((po) => po.platform.startsWith('amazon') && po.views != null)

/** Stats: what the samples are worth, bought value, the pipeline, brand deals, Amazon views. Live, no export. */
export function Stats() {
  const { data, error } = useSnapshot()
  const deals = useDealStats()
  const flow = useMemo(() => (data ? buildFlow(data) : null), [data])
  if (error) return <main><Link to="/" className="back">‹ Home</Link><p className="error">{error}</p></main>
  if (!data || !flow) return <main><Link to="/" className="back">‹ Home</Link><p className="muted">Loading…</p></main>

  const s = valueOf(data.products, 'sample')
  const b = valueOf(data.products, 'bought')
  const days = daysToPosted(data.products, data.posts)
  const posted = data.products.filter((p) => p.status === 'done').length
  const total = data.products.length || 1
  const views = amazonViews(data.posts)
  const top = [...views].sort((a, c) => (c.views ?? 0) - (a.views ?? 0)).slice(0, 3)
  const checked = views.reduce<string | null>((m, po) => (po.views_checked_at && (!m || po.views_checked_at > m) ? po.views_checked_at : m), null)
  const stages = [
    { label: 'Film', n: flow.film.length, color: '#e8a33a' },
    { label: 'Edit', n: flow.edit.length, color: '#3b6fd6' },
    { label: 'Post', n: flow.postCount, color: 'var(--accent)' },
    { label: 'Posted', n: posted, color: 'var(--done)' },
  ]

  return (
    <main>
      <Link to="/" className="back">‹ Home</Link>
      <h1>Stats</h1>
      <p className="muted page-sub">{new Date().getFullYear()} so far · values by received date</p>
      <div className="blocks">
        <Link to="/stats/sample" className="stat">
          <span className="stat-head"><b>Sample product value</b><span className="chev" aria-hidden>›</span></span>
          <span className="stat-big">{money(s.value)}</span>
          <small>{s.items.length} samples (Amazon, TikTok Shop, brand direct){s.items.length > s.priced ? ` · ${s.items.length - s.priced} without a price` : ''}</small>
          <Bars months={byMonth(s.items)} />
        </Link>
        <Link to="/stats/bought" className="stat">
          <span className="stat-head"><b>Bought product value</b><span className="chev" aria-hidden>›</span></span>
          <span className="stat-big stat-mid">{money(b.value)}</span>
          <small>{b.items.length} product{b.items.length === 1 ? '' : 's'} you paid for yourself{b.items.length > b.priced ? ` · ${b.items.length - b.priced} without a price` : ''}</small>
        </Link>
        <Link to="/stats/pipeline" className="stat">
          <span className="stat-head"><b>Pipeline</b><span className="chev" aria-hidden>›</span></span>
          <span className="stack" role="img" aria-label={stages.map((x) => `${x.n} ${x.label}`).join(', ')}>
            {stages.map((x) => <span key={x.label} style={{ width: `${(x.n / total) * 100}%`, background: x.color }} />)}
          </span>
          <span className="stat-four">{stages.map((x) => <span key={x.label}><b>{x.n}</b><small>{x.label}</small></span>)}</span>
          <small>{days.avg != null ? <><b className="ink">{days.avg} days</b> on average from arrival to posted</> : 'Not enough posts yet for an average.'}</small>
        </Link>
        <Link to="/stats/deals" className="stat">
          <span className="stat-head"><b>Brand deals</b><span className="chev" aria-hidden>›</span></span>
          {deals ? <>
            <span className="stat-row"><span className="stat-big stat-mid">{pct(deals.received, deals.messaged)}</span><small>reply rate: {deals.received.toLocaleString()} sent a product of {deals.messaged.toLocaleString()} messaged</small></span>
            <span className="stat-three">
              <span><b>{deals.published.toLocaleString()}</b><small>published</small></span>
              <span><b>{data.quiet.toLocaleString()}</b><small>went quiet</small></span>
              <span><b>{deals.declined.toLocaleString()}</b><small>declined</small></span>
            </span>
          </> : <small>Counting…</small>}
        </Link>
        <Link to="/stats/views" className="stat">
          <span className="stat-head"><b>Amazon video views</b><span className="chev" aria-hidden>›</span></span>
          <span className="stat-row"><span className="stat-big stat-mid">{views.reduce((n, po) => n + (po.views ?? 0), 0).toLocaleString()}</span><small>across {views.length} videos{checked ? ` · checked ${fmtDay(checked)}` : ''}</small></span>
          <span className="stat-top">{top.map((po) => <span key={po.id}><span>{po.title ?? 'Video'}</span><b>{(po.views ?? 0).toLocaleString()}</b></span>)}</span>
        </Link>
      </div>
    </main>
  )
}

const DETAIL_TITLE: Record<string, string> = { sample: 'Sample product value', bought: 'Bought product value', pipeline: 'Pipeline', deals: 'Brand deals', views: 'Amazon video views' }

/** One Stats block in full. */
export function StatDetail() {
  const { kind = 'sample' } = useParams()
  const { data, error } = useSnapshot()
  const deals = useDealStats()
  const flow = useMemo(() => (data ? buildFlow(data) : null), [data])
  const [month, setMonth] = useState<string>('all')

  const head = <><Link to="/stats" className="back">‹ Stats</Link><h1>{DETAIL_TITLE[kind] ?? 'Stats'}</h1></>
  if (error) return <main>{head}<p className="error">{error}</p></main>
  if (!data || !flow) return <main>{head}<p className="muted">Loading…</p></main>

  if (kind === 'sample' || kind === 'bought') {
    const v = valueOf(data.products, kind)
    const months = byMonth(v.items)
    const items = (month === 'all' ? v.items : v.items.filter((p) => p.received_at?.slice(5, 7) === month))
      .sort((a, b) => (b.price ?? -1) - (a.price ?? -1) || a.name.localeCompare(b.name))
    const value = items.reduce((n, p) => n + (p.price != null ? Number(p.price) : 0), 0)
    const unpriced = items.filter((p) => p.price == null).length
    return (
      <main>
        {head}
        <p className="stat-hero"><b>{money(value)}</b><span className="muted">{items.length} product{items.length === 1 ? '' : 's'}{unpriced ? `, ${unpriced} without a price` : ''}</span></p>
        <div className="month-chips" role="group" aria-label="Month">
          <button aria-pressed={month === 'all'} onClick={() => setMonth('all')}>All year</button>
          {months.map((m) => <button key={m.key} aria-pressed={month === m.key} className={m.count ? '' : 'chip-empty'} onClick={() => setMonth(m.key)}>{m.label}</button>)}
        </div>
        {items.length === 0 ? <p className="empty">Nothing arrived that month.</p> : (
          <ul className="list">
            {items.map((p) => (
              <li key={p.id}>
                <Link to={`/product/${p.id}`} className="row">
                  <Thumb src={p.product_image_url} name={p.name} />
                  <div className="row-main"><div className="row-title">{p.name}</div><div className="row-sub">{p.brand && <span>{p.brand}</span>}<span>{SOURCE_LABEL[p.source]}</span><span>arrived {fmtDay(p.received_at)}</span></div></div>
                  <b className={p.price == null ? 'price-missing' : 'price'}>{fmtPrice(p.price) ?? 'Add price'}</b>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small page-sub">Highest value first. Tap one to open it and fix its price or source.</p>
      </main>
    )
  }

  if (kind === 'pipeline') {
    const days = daysToPosted(data.products, data.posts)
    const rows = [
      { label: 'Answers needed', n: flow.answers, to: '/products/answers' },
      { label: 'Film', n: flow.film.length, to: '/products/film' },
      { label: 'Edit', n: flow.edit.length, to: '/products/edit' },
      { label: 'Post', n: flow.postCount, to: '/products/post' },
      { label: 'Posted everywhere', n: data.products.filter((p) => p.status === 'done').length, to: '/products/all' },
    ]
    return (
      <main>
        {head}
        <p className="stat-hero"><b>{days.avg != null ? `${days.avg} days` : '–'}</b><span className="muted">on average from arrival to the first post, over {days.n} products</span></p>
        <ul className="list">
          {rows.map((r) => (
            <li key={r.label}><Link to={r.to} className="row"><div className="row-main"><div className="row-title">{r.label}</div></div><b>{r.n.toLocaleString()}</b><span className="chev" aria-hidden>›</span></Link></li>
          ))}
        </ul>
      </main>
    )
  }

  if (kind === 'deals') {
    const rows = deals ? [
      { label: 'Messaged', n: deals.messaged },
      { label: 'Sent a product', n: deals.received },
      { label: 'Reply rate', text: pct(deals.received, deals.messaged) },
      { label: 'Video published', n: deals.published },
      { label: 'Waiting on brand', n: data.waiting, to: '/deals/waiting' },
      { label: 'Went quiet', n: data.quiet },
      { label: 'Declined', n: deals.declined },
      { label: 'All deals', n: deals.total },
    ] : []
    return (
      <main>
        {head}
        {!deals ? <p className="muted">Counting…</p> : (
          <ul className="list">
            {rows.map((r) => (
              <li key={r.label}>
                {r.to
                  ? <Link to={r.to} className="row"><div className="row-main"><div className="row-title">{r.label}</div></div><b>{r.n?.toLocaleString()}</b><span className="chev" aria-hidden>›</span></Link>
                  : <div className="row"><div className="row-main"><div className="row-title">{r.label}</div></div><b>{r.text ?? r.n?.toLocaleString()}</b></div>}
              </li>
            ))}
          </ul>
        )}
        <p className="muted small page-sub">From the ViralVue brand-deals imports. Went quiet: messaged more than 30 days ago with no answer.</p>
      </main>
    )
  }

  // views
  const byId = new Map(data.products.map((p) => [p.id, p]))
  const views = amazonViews(data.posts).sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
  return (
    <main>
      {head}
      <p className="stat-hero"><b>{views.reduce((n, po) => n + (po.views ?? 0), 0).toLocaleString()}</b><span className="muted">views across {views.length} Amazon videos</span></p>
      <ul className="list">
        {views.map((po) => {
          const p = byId.get(po.product_id)
          return (
            <li key={po.id}>
              <Link to={p ? `/product/${p.id}` : '#'} className="row">
                <div className="row-main"><div className="row-title">{po.title ?? 'Video'}</div><div className="row-sub">{p && <span>{p.name}</span>}{po.posted_at && <span>{fmtDay(po.posted_at)}</span>}</div></div>
                <b>{(po.views ?? 0).toLocaleString()}</b>
              </Link>
            </li>
          )
        })}
      </ul>
      <p className="muted small page-sub">Updated by Housekeeping → Import ViralVue with the Amazon videos export.</p>
    </main>
  )
}
