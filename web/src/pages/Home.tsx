import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useSnapshot } from '../lib/data'
import { supabase } from '../lib/supabase'
import type { Deal, Job, Listing, Platform, Post, Product, ProductStatus } from '../lib/types'
import { suggestProducts } from '../lib/deals'
import { PLATFORM_LABEL, PLATFORM_ORDER } from '../lib/types'
import { ProductRow, Thumb, daysUntil, deadlineText } from '../components/ProductRow'
import { Section } from '../components/Section'
import { IconCameraPlus, IconGear } from '../components/Icons'
import { UploadButton } from '../components/Clips'

/** Deal cards shown in "today" before the rest go to the Answer row. */
const ANSWER_CARDS = 2

type DealAsk = { deal: Deal; suggestion: { id: string; name: string } | null }

type View =
  | { kind: 'search'; search: Product[] }
  | {
      kind: 'lists'
      due: Product[]
      askCards: DealAsk[]
      askRest: DealAsk[]
      jobs: { job: Job; product: Product }[]
      film: Product[]
      edit: Product[]
      ready: { key: string; label: string; items: Product[] }[]
      readyCount: number
      waiting: number
      quiet: number
      counts: { total: number; done: number }
    }

function byDeadlineThenName(a: Product, b: Product) {
  const da = a.deadline ?? '9999', db = b.deadline ?? '9999'
  return da < db ? -1 : da > db ? 1 : a.name.localeCompare(b.name)
}

/** Platforms a product is planned for and not yet posted on. */
function unposted(p: Product, listings: Listing[], posts: Post[]): Platform[] {
  const postedOn = new Set(posts.filter((po) => po.product_id === p.id && po.status === 'posted').map((po) => po.platform))
  const planned = new Set(listings.filter((l) => l.product_id === p.id && l.availability !== 'not_listed').map((l) => l.platform))
  return PLATFORM_ORDER.filter((pl) => planned.has(pl) && !postedOn.has(pl))
}

const STEP: Record<ProductStatus, { verb: string; next: ProductStatus | null; button: string | null }> = {
  expected: { verb: 'Arriving', next: 'received', button: 'It arrived' },
  received: { verb: 'Film', next: 'filmed', button: 'I filmed it' },
  filmed: { verb: 'Edit', next: null, button: null },
  editing: { verb: 'Editing', next: null, button: null },
  ready: { verb: 'Post', next: null, button: null },
  done: { verb: 'Done', next: null, button: null },
}

function editLabel(j: Job | undefined): string {
  if (!j) return 'Open'
  if (j.status === 'needs_review') return 'Review the edit'
  if (j.status === 'queued') return 'Waiting for the worker'
  return `Editing · ${j.progress?.pct ?? 0}%`
}

const preview = (items: { name: string }[]) => {
  const names = items.slice(0, 2).map((p) => p.name).join(', ')
  return items.length > 2 ? `${names}…` : names
}

export function Home() {
  const { data, error } = useSnapshot()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

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
        .filter((p) => p.name.toLowerCase().includes(q) || (p.brand ?? '').toLowerCase().includes(q) || asinHits.has(p.id) || (p.upc ?? '').includes(q))
        .sort((a, b) => a.name.localeCompare(b.name))
      return { kind: 'search', search: results }
    }

    const due = products
      .filter((p) => p.status !== 'done' && p.deadline && (daysUntil(p.deadline) ?? 99) <= 7)
      .sort(byDeadlineThenName)
    const dueIds = new Set(due.map((p) => p.id))
    const rest = products.filter((p) => !dueIds.has(p.id)).sort(byDeadlineThenName)

    const lite = products.map((p) => ({ id: p.id, name: p.name, brand: p.brand }))
    const asks: DealAsk[] = deals.map((deal) => {
      const s = suggestProducts(deal, lite, 1)[0]
      return { deal, suggestion: s ? { id: s.id, name: s.name } : null }
    })
    const jobRows = jobs
      .filter((j) => j.status === 'needs_review')
      .map((j) => ({ job: j, product: j.product_id ? byId.get(j.product_id) : undefined }))
      .filter((x): x is { job: Job; product: Product } => Boolean(x.product))

    // Post: one entry per platform the product is planned for and not yet posted on.
    const readyGroups = new Map<string, Product[]>()
    const readyProducts = rest.filter((p) => p.status === 'ready')
    for (const p of readyProducts) {
      const plats = unposted(p, listings, posts)
      for (const k of plats.length ? plats : ['none']) {
        if (!readyGroups.has(k)) readyGroups.set(k, [])
        readyGroups.get(k)!.push(p)
      }
    }
    const ready = [...PLATFORM_ORDER, 'none']
      .filter((k) => readyGroups.has(k))
      .map((k) => ({ key: k, label: k === 'none' ? 'No platform yet' : PLATFORM_LABEL[k as Platform], items: readyGroups.get(k)! }))

    return {
      kind: 'lists',
      due,
      askCards: asks.slice(0, ANSWER_CARDS),
      askRest: asks.slice(ANSWER_CARDS),
      jobs: jobRows,
      film: rest.filter((p) => p.status === 'received' || p.status === 'expected'),
      edit: rest.filter((p) => p.status === 'filmed' || p.status === 'editing'),
      ready,
      readyCount: readyProducts.length,
      waiting,
      quiet,
      counts: { total: products.length, done: products.filter((p) => p.status === 'done').length },
    }
  }, [data, query])

  const advance = async (p: Product) => {
    const next = STEP[p.status].next
    if (!next) return navigate(`/product/${p.id}`)
    setBusy(p.id)
    setActionError(null)
    const patch: Partial<Product> = { status: next }
    if (next === 'received' && !p.received_at) patch.received_at = new Date().toISOString().slice(0, 10)
    const { error } = await supabase.from('products').update(patch).eq('id', p.id)
    if (error) setActionError(`Could not update ${p.name}: ${error.message}`)
    setBusy(null)
  }

  // the latest edit job per product, for progress on Edit rows and cards
  const editing = useMemo(() => {
    const m = new Map<string, Job>()
    for (const j of data?.jobs ?? []) {
      if (j.type !== 'edit' || !j.product_id) continue
      const have = m.get(j.product_id)
      if (!have || have.created_at < j.created_at) m.set(j.product_id, j)
    }
    return m
  }, [data])

  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  const things = view?.kind === 'lists' ? view.due.length + view.askCards.length : 0

  return (
    <main className="has-bar">
      <div className="today-top">
        <span className="date">{today}</span>
        <Link to="/settings" className="icon-btn" aria-label="Settings"><IconGear /></Link>
      </div>

      {view?.kind !== 'search' && (
        <h1 className="today-title">
          {!view ? 'Loading…' : things === 0 ? <>Nothing due <em>today</em></> : <>{things} thing{things === 1 ? '' : 's'} <em>today</em></>}
        </h1>
      )}

      <input
        type="search"
        className="search"
        placeholder="Search name, brand, ASIN or barcode"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
      />

      {error && <p className="error">Could not load: {error}</p>}
      {actionError && <p className="error">{actionError}</p>}

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
          <div className="feed" style={{ marginTop: 10 }}>
            {view.due.map((p) => {
              const step = STEP[p.status]
              return (
                <div className="act" key={p.id}>
                  <Link to={`/product/${p.id}`} className="act-top">
                    <Thumb src={p.product_image_url} name={p.name} />
                    <span>
                      <span className="verb">{step.verb} · {deadlineText(p.deadline)?.toLowerCase()}</span>
                      <span className="act-name">{p.name}</span>
                    </span>
                  </Link>
                  <div className="go">
                    {p.status === 'received'
                      ? <UploadButton product={p} className="pri" onStarted={() => navigate(`/product/${p.id}`)} />
                      : p.status === 'filmed'
                      ? <Link className="pri" to={`/product/${p.id}`} state={{ edit: true }}>Edit</Link>
                      : p.status === 'editing'
                      ? <Link className="pri" to={editing.get(p.id)?.status === 'needs_review' ? `/review/${editing.get(p.id)!.id}` : `/product/${p.id}`}>{editLabel(editing.get(p.id))}</Link>
                      : step.button
                      ? <button className="pri" disabled={busy === p.id} onClick={() => advance(p)}>{step.button}</button>
                      : <Link className="pri" to={`/product/${p.id}`}>{p.status === 'ready' ? 'Mark posted' : 'Open'}</Link>}
                    {step.button || !p.drive_folder_id
                      ? <Link to={`/product/${p.id}`}>Open</Link>
                      : <a href={`https://drive.google.com/drive/folders/${p.drive_folder_id}`} target="_blank" rel="noreferrer">Open Drive</a>}
                  </div>
                </div>
              )
            })}

            {view.askCards.map(({ deal, suggestion }) => (
              <div className="act" key={deal.id}>
                <Link to={`/deal/${deal.id}`} className="act-top">
                  <Thumb src={deal.image_url} name={deal.brand ?? deal.title ?? '?'} />
                  <span>
                    <span className="verb verb-ask">Answer · brand deal</span>
                    <span className="act-name">
                      {suggestion ? `Is the ${deal.brand ?? ''} deal your ${suggestion.name}?` : `Which product is the ${deal.brand ?? ''} deal?`}
                    </span>
                  </span>
                </Link>
                <div className="go">
                  {suggestion ? (
                    <>
                      <Link className="pri" to={`/deal/${deal.id}`} state={{ confirmId: suggestion.id }}>Yes, same</Link>
                      <Link to={`/deal/${deal.id}`}>No</Link>
                    </>
                  ) : <Link className="pri" to={`/deal/${deal.id}`}>Answer</Link>}
                </div>
              </div>
            ))}
          </div>

          <div className="later">
            <h2>{things ? 'After that' : 'Everything else'}</h2>

            <Section id="film" title="Film" sub={preview(view.film) || 'Nothing waiting to be filmed'} count={view.film.length} preview={8} empty="Nothing waiting to be filmed.">
              {(limit) => <ul className="list">{view.film.slice(0, limit).map((p) => <ProductRow key={p.id} product={p} detail={p.status === 'expected' ? 'On its way' : null} />)}</ul>}
            </Section>

            <Section id="edit" title="Edit" sub="Raw clips waiting in Drive" count={view.edit.length} preview={8} empty="No raw footage is waiting.">
              {(limit) => <ul className="list">{view.edit.slice(0, limit).map((p) => <ProductRow key={p.id} product={p} detail={p.status === 'editing' ? editLabel(editing.get(p.id)) : null} />)}</ul>}
            </Section>

            <Section id="post" title="Post" sub={view.ready.map((g) => g.label).join(', ') || 'Nothing finished is waiting'} count={view.readyCount} empty="Nothing finished is waiting to be posted.">
              {() => view.ready.map((g) => (
                <div key={g.key}>
                  <h3>{g.label}</h3>
                  <ul className="list">{g.items.map((p) => <ProductRow key={p.id} product={p} />)}</ul>
                </div>
              ))}
            </Section>

            {(view.askRest.length > 0 || view.jobs.length > 0) && (
              <Section id="answer" title="Answer" sub="More deals to match" count={view.askRest.length + view.jobs.length} preview={8}>
                {(limit) => (
                  <ul className="list">
                    {[...view.askRest.map(({ deal: d, suggestion }) => (
                      <li key={d.id}>
                        <Link to={`/deal/${d.id}`} className="row">
                          <Thumb src={d.image_url} name={d.brand ?? '?'} />
                          <div className="row-main">
                            <div className="row-title">{d.title ?? d.asin}</div>
                            <div className="row-sub"><span>Brand deal{d.brand ? ` · ${d.brand}` : ''}</span><span>{suggestion ? `Same as ${suggestion.name}?` : 'Which product is this?'}</span></div>
                          </div>
                          <span className="chev" aria-hidden>›</span>
                        </Link>
                      </li>
                    )), ...view.jobs.map(({ job, product }) => job.type === 'edit' ? (
                      <li key={job.id}>
                        <Link to={`/review/${job.id}`} className="row">
                          <Thumb src={product.product_image_url} name={product.name} />
                          <div className="row-main">
                            <div className="row-title">{product.name}</div>
                            <div className="row-sub"><span>{job.question ?? 'Review the edit'}</span></div>
                          </div>
                          <span className="chev" aria-hidden>›</span>
                        </Link>
                      </li>
                    ) : (
                      <ProductRow key={job.id} product={product} detail={job.question ?? `${job.type} needs review`} />
                    ))].slice(0, limit)}
                  </ul>
                )}
              </Section>
            )}

            <Link to="/deals/waiting" className="sec sec-head" style={{ display: 'flex' }}>
              <span className="sec-big">{view.waiting.toLocaleString()}</span>
              <span className="sec-title">Wait<span className="sec-sub">Brands haven’t sent yet{view.quiet ? ` · ${view.quiet.toLocaleString()} went quiet` : ''}</span></span>
              <span className="disc" aria-hidden>›</span>
            </Link>
          </div>

          <p className="muted small footer">
            {view.counts.total} products, {view.counts.done} posted everywhere.
          </p>
        </>
      )}

      <div className="arrived">
        <Link to="/add">
          <IconCameraPlus />
          <span><b>Something arrived?</b><small>Scan it, snap it or paste a link</small></span>
        </Link>
      </div>
    </main>
  )
}
