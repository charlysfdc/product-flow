import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useSnapshot } from '../lib/data'
import type { Deal, Job, Platform, Product } from '../lib/types'
import { suggestProducts } from '../lib/deals'
import { PLATFORM_LABEL, PLATFORM_ORDER } from '../lib/types'
import { ProductRow, daysUntil } from '../components/ProductRow'

type View =
  | { kind: 'search'; search: Product[] }
  | {
      kind: 'lists'
      dueSoon: Product[]
      received: Product[]
      needsAnswer: { job: Job; product: Product }[]
      dealsToAnswer: { deal: Deal; suggestion: string | null }[]
      waiting: number
      quiet: number
      filmed: Product[]
      ready: { key: string; label: string; items: Product[] }[]
      counts: { total: number; done: number }
    }

function byDeadlineThenName(a: Product, b: Product) {
  const da = a.deadline ?? '9999', db = b.deadline ?? '9999'
  return da < db ? -1 : da > db ? 1 : a.name.localeCompare(b.name)
}

export function Home() {
  const { session } = useAuth()
  const { data, error } = useSnapshot()
  const [query, setQuery] = useState('')

  const view = useMemo((): View | null => {
    if (!data) return null
    const { products, listings, posts, jobs, deals, waiting, quiet } = data
    const byId = new Map(products.map((p) => [p.id, p]))

    const q = query.trim().toLowerCase()
    if (q) {
      const asinHits = new Set(
        listings.filter((l) => l.external_id && l.external_id.toLowerCase().includes(q)).map((l) => l.product_id),
      )
      const results = products
        .filter((p) => p.name.toLowerCase().includes(q) || (p.brand ?? '').toLowerCase().includes(q) || asinHits.has(p.id))
        .sort((a, b) => a.name.localeCompare(b.name))
      return { kind: 'search', search: results }
    }

    const dueSoon = products
      .filter((p) => p.status !== 'done' && p.deadline && (daysUntil(p.deadline) ?? 99) <= 7)
      .sort(byDeadlineThenName)
    const dueIds = new Set(dueSoon.map((p) => p.id))

    const received = products
      .filter((p) => (p.status === 'received' || p.status === 'expected') && !dueIds.has(p.id))
      .sort(byDeadlineThenName)

    const needsAnswer = jobs
      .map((j) => ({ job: j, product: j.product_id ? byId.get(j.product_id) : undefined }))
      .filter((x): x is { job: Job; product: Product } => Boolean(x.product))

    const lite = products.map((p) => ({ id: p.id, name: p.name, brand: p.brand }))
    const dealsToAnswer = deals.map((deal) => ({ deal, suggestion: suggestProducts(deal, lite, 1)[0]?.name ?? null }))
    const filmed = products.filter((p) => p.status === 'filmed' && !dueIds.has(p.id)).sort(byDeadlineThenName)

    // Ready to post: one entry per platform the product is listed on and not yet posted to.
    const postedOn = new Set(posts.filter((po) => po.status === 'posted').map((po) => `${po.product_id}|${po.platform}`))
    const readyGroups = new Map<string, Product[]>()
    for (const p of products.filter((p) => p.status === 'ready')) {
      const plats = Array.from(new Set(listings.filter((l) => l.product_id === p.id && l.availability !== 'not_listed').map((l) => l.platform)))
        .filter((pl) => !postedOn.has(`${p.id}|${pl}`))
      const keys = plats.length ? plats : ['none']
      for (const k of keys) {
        if (!readyGroups.has(k)) readyGroups.set(k, [])
        readyGroups.get(k)!.push(p)
      }
    }
    const ready = [...PLATFORM_ORDER, 'none']
      .filter((k) => readyGroups.has(k))
      .map((k) => ({ key: k, label: k === 'none' ? 'No platform yet' : PLATFORM_LABEL[k as Platform], items: readyGroups.get(k)!.sort(byDeadlineThenName) }))

    const counts = {
      total: products.length,
      done: products.filter((p) => p.status === 'done').length,
    }
    return { kind: 'lists', dueSoon, received, needsAnswer, dealsToAnswer, waiting, quiet, filmed, ready, counts }
  }, [data, query])

  const name = session?.user.user_metadata?.full_name?.split(' ')[0] ?? session?.user.email ?? ''

  return (
    <main>
      <header className="top">
        <div>
          <h1>Product Flow</h1>
          <div className="muted small">{name}</div>
        </div>
        <Link to="/settings" className="link-btn">Settings</Link>
      </header>

      <input
        type="search"
        className="search"
        placeholder="Search name, brand or ASIN"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
      />

      {error && <p className="error">Could not load: {error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}

      {view && view.kind === 'search' && (
        <section>
          <h2>{view.search.length} result{view.search.length === 1 ? '' : 's'}</h2>
          <ul className="list">
            {view.search.map((p) => <ProductRow key={p.id} product={p} showStatus />)}
          </ul>
        </section>
      )}

      {view && view.kind === 'lists' && (
        <>
          {view.dueSoon.length > 0 && (
            <section>
              <h2>Due soon <span className="count">{view.dueSoon.length}</span></h2>
              <ul className="list">{view.dueSoon.map((p) => <ProductRow key={p.id} product={p} showStatus />)}</ul>
            </section>
          )}

          <section>
            <h2>Received, not filmed <span className="count">{view.received.length}</span></h2>
            {view.received.length === 0 ? (
              <p className="empty">Nothing waiting to be filmed.</p>
            ) : (
              <ul className="list">{view.received.map((p) => <ProductRow key={p.id} product={p} detail={p.status === 'expected' ? 'Expected' : null} />)}</ul>
            )}
          </section>

          <section>
            <h2>Needs your answer <span className="count">{view.needsAnswer.length + view.dealsToAnswer.length}</span></h2>
            {view.needsAnswer.length + view.dealsToAnswer.length === 0 ? (
              <p className="empty">Nothing is waiting on you.</p>
            ) : (
              <ul className="list">
                {view.dealsToAnswer.map(({ deal: d, suggestion }) => (
                  <li key={d.id}>
                    <Link to={`/deal/${d.id}`} className="row">
                      {d.image_url && <img src={d.image_url} alt="" className="thumb" />}
                      <div className="row-main">
                        <div className="row-title">{d.title ?? d.asin}</div>
                        <div className="row-sub"><span>Brand deal{d.brand ? ` · ${d.brand}` : ''}</span><span>{suggestion ? `Same as ${suggestion}?` : 'Which product is this?'}</span></div>
                      </div>
                      <span className="chev" aria-hidden>›</span>
                    </Link>
                  </li>
                ))}
                {view.needsAnswer.map(({ job, product }) => (
                  <ProductRow key={job.id} product={product} detail={job.question ?? `${job.type} needs review`} />
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2>Ready to post <span className="count">{view.ready.reduce((n, g) => n + g.items.length, 0)}</span></h2>
            {view.ready.length === 0 ? (
              <p className="empty">Nothing finished is waiting to be posted.</p>
            ) : (
              view.ready.map((g) => (
                <div key={g.key}>
                  <h3>{g.label}</h3>
                  <ul className="list">{g.items.map((p) => <ProductRow key={p.id} product={p} />)}</ul>
                </div>
              ))
            )}
          </section>

          <section>
            <h2>Filmed, needs an edit <span className="count">{view.filmed.length}</span></h2>
            {view.filmed.length === 0 ? (
              <p className="empty">No raw footage is waiting.</p>
            ) : (
              <ul className="list">{view.filmed.map((p) => <ProductRow key={p.id} product={p} />)}</ul>
            )}
          </section>

          {(view.waiting > 0 || view.quiet > 0) && (
            <section>
              <ul className="list">
                <li>
                  <Link to="/deals/waiting" className="row">
                    <div className="row-main">
                      <div className="row-title">Waiting on brand <span className="count">{view.waiting}</span></div>
                      <div className="row-sub"><span>Deals you messaged, nothing arrived yet</span>{view.quiet > 0 && <span>{view.quiet} went quiet</span>}</div>
                    </div>
                    <span className="chev" aria-hidden>›</span>
                  </Link>
                </li>
              </ul>
            </section>
          )}

          <p className="muted small footer">
            {view.counts.total} products, {view.counts.done} done. Search to find any of them.
          </p>
        </>
      )}
    </main>
  )
}
