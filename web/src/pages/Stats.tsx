import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useDealStats, useSnapshot } from '../lib/data'
import { buildFlow, daysToPosted, money, moneyShort, suppliesOf, valueOf, withPaidPrices } from '../lib/flow'
import { SOURCE_LABEL, fmtPrice, parsePrice, type Post, type Product } from '../lib/types'
import { supabase } from '../lib/supabase'
import { saveReceived } from '../lib/received'
import { FindAmazonSheet } from '../components/FindAmazon'
import { byAsinGroups } from '../lib/purchases'
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

type Value = ReturnType<typeof valueOf>

/** "$X this year · $Y date unknown (· $Z earlier years)". */
const splitLine = (v: Value) => [
  `${moneyShort(v.yearValue)} this year`,
  v.unknown.length ? `${moneyShort(v.unknownValue)} date unknown` : null,
  v.earlier.length ? `${moneyShort(v.earlierValue)} earlier years` : null,
].filter(Boolean).join(' · ')

/** "45 products · 42 without a price · 40 without a date", each gap a link to its list. */
function Gaps({ kind, v }: { kind: 'sample' | 'bought'; v: Value }) {
  return (
    <small className="gaps">
      {v.all.length} product{v.all.length === 1 ? '' : 's'}
      {v.unpriced.length > 0 && <> · <Link to={`/stats/${kind}/unpriced`}>{v.unpriced.length} without a price</Link></>}
      {v.undated.length > 0 && <> · <Link to={`/stats/${kind}/undated`}>{v.undated.length} without a date</Link></>}
      {v.estimated > 0 && <> · {v.estimated} date{v.estimated === 1 ? '' : 's'} estimated</>}
    </small>
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

  const s = valueOf(withPaidPrices(data.products, data.purchases), 'sample')
  const b = valueOf(withPaidPrices(data.products, data.purchases), 'bought')
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
        <div className="stat">
          <Link to="/stats/sample" className="stat-link">
            <span className="stat-head"><b>Sample product value</b><span className="chev" aria-hidden>›</span></span>
            <span className="stat-big">{money(s.value)}</span>
            <small>{splitLine(s)} · Amazon, TikTok Shop and brand-direct samples</small>
            <Bars months={[...byMonth(s.year), ...(s.unknown.length ? [{ label: '?', value: s.unknownValue }] : [])]} />
          </Link>
          <Gaps kind="sample" v={s} />
        </div>
        <div className="stat">
          <Link to="/stats/bought" className="stat-link">
            <span className="stat-head"><b>Bought product value</b><span className="chev" aria-hidden>›</span></span>
            <span className="stat-big stat-mid">{money(b.value)}</span>
            <small>{splitLine(b)} · paid for yourself</small>
          </Link>
          <Gaps kind="bought" v={b} />
        </div>
        {data.purchases.length > 0 && (() => {
          const sup = suppliesOf(data.purchases)
          const top = byAsinGroups(sup.items).sort((a, c) => c.count - a.count || c.total - a.total).slice(0, 3)
          return (
            <Link to="/stats/supplies" className="stat">
              <span className="stat-head"><b>Supplies</b><span className="chev" aria-hidden>›</span></span>
              <span className="stat-big stat-mid">{money(sup.total)}</span>
              <small>{sup.items.length} orders this year · craft, business and office supplies from your Amazon purchases</small>
              <Bars months={sup.months} />
              {top.length > 0 && <span className="stat-top">{top.map((g) => <span key={g.asin}><span>{g.title ?? g.asin}</span><b>{g.count}×</b></span>)}</span>}
            </Link>
          )
        })()}
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

const DETAIL_TITLE: Record<string, string> = { sample: 'Sample product value', bought: 'Bought product value', supplies: 'Supplies', pipeline: 'Pipeline', deals: 'Brand deals', views: 'Amazon video views' }

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
    const v = valueOf(withPaidPrices(data.products, data.purchases), kind)
    const months = byMonth(v.year)
    const pool = month === 'all' ? v.items : month === 'unknown' ? v.unknown : month === 'earlier' ? v.earlier : v.year.filter((p) => p.received_at?.slice(5, 7) === month)
    const items = [...pool]
      .sort((a, b) => (b.price ?? -1) - (a.price ?? -1) || a.name.localeCompare(b.name))
    const value = items.reduce((n, p) => n + (p.price != null ? Number(p.price) : 0), 0)
    const unpriced = items.filter((p) => p.price == null).length
    return (
      <main>
        {head}
        <p className="stat-hero"><b>{money(value)}</b><span className="muted">{items.length} product{items.length === 1 ? '' : 's'}{unpriced ? `, ${unpriced} without a price` : ''}</span></p>
        <p className="muted small page-sub">{splitLine(v)}</p>
        <p className="page-sub"><Gaps kind={kind} v={v} /></p>
        <div className="month-chips" role="group" aria-label="Month">
          <button aria-pressed={month === 'all'} onClick={() => setMonth('all')}>This year + unknown</button>
          {months.map((m) => <button key={m.key} aria-pressed={month === m.key} className={m.count ? '' : 'chip-empty'} onClick={() => setMonth(m.key)}>{m.label}</button>)}
          {v.unknown.length > 0 && <button aria-pressed={month === 'unknown'} onClick={() => setMonth('unknown')}>Date unknown</button>}
          {v.earlier.length > 0 && <button aria-pressed={month === 'earlier'} onClick={() => setMonth('earlier')}>Earlier years</button>}
        </div>
        {items.length === 0 ? <p className="empty">Nothing arrived that month.</p> : (
          <ul className="list">
            {items.map((p) => (
              <li key={p.id}>
                <Link to={`/product/${p.id}`} className="row">
                  <Thumb src={p.product_image_url} name={p.name} />
                  <div className="row-main"><div className="row-title">{p.name}</div><div className="row-sub">{p.brand && <span>{p.brand}</span>}<span>{SOURCE_LABEL[p.source]}</span><span>{p.received_at ? `arrived ${p.received_estimated ? '≈ ' : ''}${fmtDay(p.received_at)}` : 'date unknown'}</span></div></div>
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

  if (kind === 'supplies') {
    const sup = suppliesOf(data.purchases)
    const pool = month === 'all' ? sup.items : sup.items.filter((p) => p.order_date?.slice(5, 7) === month)
    const groups = byAsinGroups(pool).sort((a, b) => b.total - a.total)
    return (
      <main>
        {head}
        <p className="stat-hero"><b>{money(pool.reduce((n, p) => n + (p.unit_price ?? 0) * p.quantity, 0))}</b><span className="muted">{pool.length} order{pool.length === 1 ? "" : "s"} · {groups.length} different item{groups.length === 1 ? "" : "s"}</span></p>
        <div className="month-chips" role="group" aria-label="Month">
          <button aria-pressed={month === 'all'} onClick={() => setMonth('all')}>This year</button>
          {sup.months.map((m) => <button key={m.key} aria-pressed={month === m.key} className={m.count ? '' : 'chip-empty'} onClick={() => setMonth(m.key)}>{m.label}</button>)}
        </div>
        {groups.length === 0 ? <p className="empty">No supplies that month.</p> : (
          <ul className="list">
            {groups.map((g) => (
              <li key={g.asin} className="row">
                <div className="row-main"><div className="row-title">{g.title ?? g.asin}</div><div className="row-sub"><span>{g.count} order{g.count === 1 ? '' : 's'}{g.qty > g.count ? ` · ${g.qty} pieces` : ''}</span>{g.last && <span>last {fmtDay(g.last)}</span>}</div></div>
                <b className="price">{money(g.total)}</b>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small page-sub">From Housekeeping → Import Amazon purchases. Move a purchase to another bucket in Housekeeping → Purchases.</p>
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

/** A Stats gap: products of one kind without a price (Add price / Find on Amazon) or without a received date. */
export function StatGaps() {
  const { kind = 'sample', gap = 'unpriced' } = useParams()
  const { data, error, reload } = useSnapshot()
  const [amazon, setAmazon] = useState<Product | null>(null)
  const which = kind === 'bought' ? 'bought' : 'sample'
  const back = <><Link to={`/stats/${which}`} className="back">‹ {DETAIL_TITLE[which]}</Link><h1>{gap === 'undated' ? 'Without a date' : 'Without a price'}</h1></>
  if (error) return <main>{back}<p className="error">{error}</p></main>
  if (!data) return <main>{back}<p className="muted">Loading…</p></main>
  const v = valueOf(withPaidPrices(data.products, data.purchases), which)
  const items = (gap === 'undated' ? v.undated : v.unpriced).slice().sort((a, b) => a.name.localeCompare(b.name))
  return (
    <main>
      {back}
      <p className="muted page-sub">
        {items.length} {which === 'bought' ? `bought product${items.length === 1 ? '' : 's'}` : `sample${items.length === 1 ? '' : 's'}`}.{' '}
        {gap === 'undated' ? 'Set the day it arrived; it then counts in its month instead of Date unknown.' : 'Type the price, or Find on Amazon fills it with the picture and ASIN.'}
      </p>
      {items.length === 0 ? <p className="empty">Nothing missing.</p> : (
        <ul className="list">
          {items.map((p) => (
            <li key={p.id} className="gap-row">
              <Link to={`/product/${p.id}`} state={{ from: `/stats/${which}/${gap}` }} className="row">
                <Thumb src={p.product_image_url} name={p.name} />
                <div className="row-main"><div className="row-title">{p.name}</div><div className="row-sub">{p.brand && <span>{p.brand}</span>}<span>{SOURCE_LABEL[p.source]}</span></div></div>
              </Link>
              {gap === 'undated'
                ? <DateFix product={p} onSaved={reload} />
                : <PriceFix product={p} onSaved={reload} onAmazon={() => setAmazon(p)} />}
            </li>
          ))}
        </ul>
      )}
      {amazon && (
        <FindAmazonSheet product={amazon} hasAmazonListing={data.listings.some((l) => l.product_id === amazon.id && l.platform === 'amazon_us')}
          onClose={() => setAmazon(null)} onDone={reload} />
      )}
    </main>
  )
}

function PriceFix({ product, onSaved, onAmazon }: { product: Product; onSaved: () => void; onAmazon: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const value = parsePrice(text)
  const save = async () => {
    if (value == null) return
    setBusy(true)
    const { error } = await supabase.from('products').update({ price: value }).eq('id', product.id)
    setBusy(false)
    if (error) setErr(error.message)
    else onSaved()
  }
  return (
    <form className="gap-fix" onSubmit={(e) => { e.preventDefault(); save() }}>
      <input inputMode="decimal" placeholder="$" aria-label={`Price of ${product.name}`} value={text} onChange={(e) => setText(e.target.value)} />
      <button className="secondary" type="submit" disabled={busy || value == null}>Save</button>
      <button className="secondary" type="button" onClick={onAmazon}>Find on Amazon</button>
      {err && <span className="error small">{err}</span>}
    </form>
  )
}

function DateFix({ product, onSaved }: { product: Product; onSaved: () => void }) {
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const save = async () => {
    if (!date) return
    setBusy(true)
    const { error } = await saveReceived(product.id, date)
    setBusy(false)
    if (error) setErr(error.message)
    else onSaved()
  }
  return (
    <form className="gap-fix" onSubmit={(e) => { e.preventDefault(); save() }}>
      <input type="date" aria-label={`Day ${product.name} arrived`} value={date} onChange={(e) => setDate(e.target.value)} />
      <button className="secondary" type="submit" disabled={busy || !date}>Save</button>
      {err && <span className="error small">{err}</span>}
    </form>
  )
}
