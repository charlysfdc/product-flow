import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useSnapshot, type Snapshot } from '../lib/data'
import { callFunction, makeDriveFolder } from '../lib/functions'
import { lookupLink } from '../lib/amazon'
import {
  BUCKET_LABEL, answerPurchase, byAsinGroups, importPurchases, isPurchasesExport, linkSameAs, matchContext, recheckMatches, setBucket, suggestFor, undoPurchaseChange,
  type Bucket, type MatchContext, type Purchase, type PurchasesSummary,
} from '../lib/purchases'
import { SOURCE_LABEL, fmtPrice, type Product } from '../lib/types'
import { money } from '../lib/flow'
import { Thumb } from '../components/ProductRow'

const fmtDay = (d: string | null | undefined) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '–')
const classify = (items: { asin: string; title: string | null; category: string | null }[]) =>
  callFunction<{ buckets: Record<string, Bucket> }>('identify', { classify: items }, 120_000).then((r) => r.buckets)

/** Housekeeping card: Import Amazon purchases, and the lists it feeds. */
export function PurchasesCard({ data, onDone }: { data: Snapshot | null; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [say, setSay] = useState<string | null>(null)
  const [summary, setSummary] = useState<PurchasesSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const purchases = data?.purchases ?? []
  const changed = data?.products.filter((p) => p.purchase_change).length ?? 0
  const notFilmed = new Set(purchases.filter((p) => p.bucket === 'review' && !p.product_id && !p.ask_product_id).map((p) => p.asin)).size
  const last = purchases.reduce<string | null>((m, p) => (p.order_date && (!m || p.order_date > m) ? p.order_date : m), null)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true); setError(null); setSummary(null)
    try {
      const text = await file.text()
      if (!isPurchasesExport(text)) throw new Error('This is not an Amazon order history CSV (expected the columns order id, order date, ASIN).')
      setSummary(await importPurchases(supabase, text, classify, setSay))
      onDone()
    } catch (e) {
      setError(/purchases/.test((e as Error).message) && /relation|schema cache|not find/i.test((e as Error).message) ? 'Purchases need the database update (migration 0011).' : (e as Error).message)
    } finally {
      setBusy(false); setSay(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <section>
      <div className="card">
        <div className="card-title">Import Amazon purchases</div>
        <p className="muted small">
          {purchases.length ? <>{purchases.length} orders imported, newest {fmtDay(last)}. </> : null}
          The Amazon Order History Reporter “items” CSV. Importing again adds only new orders. Products you bought get source Bought, the price you paid and the order date; nothing you set by hand on a product with a brand deal is changed.
        </p>
        <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
        <button className="primary" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Importing…' : 'Choose order history CSV'}</button>
        {say && <p className="muted small">{say}</p>}
        {error && <p className="error">{error}</p>}
        {summary && (
          <div className="summary">
            <p><b>{summary.rows}</b> orders ({money(summary.total)}): <b>{summary.added}</b> new, {summary.already} already imported.</p>
            <p className="muted small">
              {summary.matchedProducts} products matched by ASIN; {summary.changed.products} changed ({summary.changed.source} source → Bought, {summary.changed.price} price, {summary.changed.date} received date);
              {' '}{summary.questions} need “Sample or bought?”. Buckets: {(Object.keys(summary.buckets) as Bucket[]).filter((b) => summary.buckets[b]).map((b) => `${summary.buckets[b]} ${BUCKET_LABEL[b].toLowerCase()}`).join(', ')}
              {summary.sortedByClaude ? ` (${summary.sortedByClaude} items sorted by Claude)` : ''}; {summary.reviewCandidates} review candidates
              {summary.autoLinked ? `; ${summary.autoLinked} linked to a product under another ASIN` : ''}.
            </p>
            {summary.errors.length > 0 && <details><summary className="error">{summary.errors.length} problems</summary><ul>{summary.errors.map((e, i) => <li key={i} className="small">{e}</li>)}</ul></details>}
          </div>
        )}
      </div>
      <ul className="list" style={{ marginTop: 8 }}>
        <li><Link to="/housekeeping/changes" className="row"><div className="row-main"><div className="row-title">What the import changed</div><div className="row-sub"><span>Undo per product</span></div></div><b>{changed}</b><span className="chev" aria-hidden>›</span></Link></li>
        <li><Link to="/housekeeping/purchases?bucket=review" className="row"><div className="row-main"><div className="row-title">Bought, not filmed yet?</div><div className="row-sub"><span>Review candidates with no product</span></div></div><b>{notFilmed}</b><span className="chev" aria-hidden>›</span></Link></li>
        <li><Link to="/housekeeping/purchases" className="row"><div className="row-main"><div className="row-title">Purchases</div><div className="row-sub"><span>By bucket: supplies, household, subscriptions…</span></div></div><b>{purchases.length}</b><span className="chev" aria-hidden>›</span></Link></li>
      </ul>
    </section>
  )
}

const BUCKETS: Bucket[] = ['review', 'supplies', 'household', 'subscription', 'unsorted']

/** Short product name from an Amazon title. */
function nameFrom(title: string | null, asin: string) {
  const t = (title ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return `Amazon ${asin}`
  const cut = t.split(/ [|–-] |, | \(/)[0]
  return (cut.length > 70 ? cut.slice(0, 70).replace(/\s+\S*$/, '') : cut).trim()
}

/** Purchases by bucket, grouped by ASIN. The review bucket offers Make a product / Not for review. */
export function PurchasesPage() {
  const { data, error, reload } = useSnapshot()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const bucket = (params.get('bucket') as Bucket | null) ?? 'review'
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const byId = useMemo(() => new Map((data?.products ?? []).map((p) => [p.id, p])), [data])
  // look-alike products for orders with no product: names, folders, brands and deal titles
  const [ctx, setCtx] = useState<MatchContext | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => { matchContext(supabase).then(setCtx, () => setCtx(null)) }, [tick])
  const [confirm, setConfirm] = useState<{ asin: string; product: Product } | null>(null)
  if (error) return <main><Link to="/housekeeping" className="back">‹ Housekeeping</Link><p className="error">{error}</p></main>
  if (!data) return <main><Link to="/housekeeping" className="back">‹ Housekeeping</Link><p className="muted">Loading…</p></main>
  const reviewOnly = bucket === 'review'
  const pool = data.purchases.filter((p) => p.bucket === bucket && (!reviewOnly || (!p.product_id && !p.ask_product_id)))
  const groups = byAsinGroups(pool)
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, data.purchases.filter((p) => p.bucket === b && (b !== 'review' || (!p.product_id && !p.ask_product_id))).length]))

  const make = async (g: ReturnType<typeof byAsinGroups>[number]) => {
    setBusy(g.asin); setNote(null)
    try {
      const first = [...g.buys].sort((a, b) => (a.order_date ?? '9999').localeCompare(b.order_date ?? '9999'))[0]
      let image: string | null = null, brand: string | null = null
      try { const c = await lookupLink(g.asin); image = c.image_url; brand = c.brand } catch { /* no picture: Find on Amazon later */ }
      const base = nameFrom(g.title, g.asin)
      const row = { name: base, brand, source: 'bought', status: 'received', price: first.unit_price, received_at: first.order_date ?? new Date().toISOString().slice(0, 10), product_image_url: image, notes: g.title ? `Bought on Amazon: ${g.title}` : null }
      let ins = await supabase.from('products').insert(row).select('*').single()
      if (ins.error?.code === '23505') ins = await supabase.from('products').insert({ ...row, name: `${base} (${g.asin})` }).select('*').single()
      if (ins.error) throw new Error(ins.error.message)
      const p = ins.data as Product
      await supabase.from('listings').insert({ product_id: p.id, platform: 'amazon_us', external_id: g.asin, url: `https://www.amazon.com/dp/${g.asin}`, availability: 'exact', checked_at: new Date().toISOString().slice(0, 10) })
      const link = await supabase.from('purchases').update({ product_id: p.id, link_kind: 'bought', bucket: 'review', bucket_by: 'manual' }).in('id', g.buys.map((b) => b.id))
      if (link.error) throw new Error(link.error.message)
      makeDriveFolder(p.id).catch(() => { /* the Product screen offers Make Drive folder */ })
      reload()
      setNote(`Made “${p.name}”: Bought, ${fmtPrice(first.unit_price) ?? 'no price'}, arrived ${fmtDay(row.received_at)}.`)
      navigate(`/product/${p.id}`, { state: { from: '/housekeeping/purchases?bucket=review' } })
    } catch (e) {
      setNote(`Could not make it: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }
  const sameAs = async (asin: string, product: Product) => {
    setBusy(asin); setNote(null)
    try {
      const r = await linkSameAs(supabase, product, asin, ctx?.hasDeal.has(product.id) ?? false)
      setConfirm(null)
      setNote(r.question
        ? `Linked to ${product.name}. It also has a brand deal, so it waits under Answers needed: Sample or bought?`
        : `Linked to ${product.name}${r.changed.products ? ' and updated (see What the import changed, where Undo puts it back)' : ''}.`)
      reload(); setTick((t) => t + 1)
    } catch (e) { setNote(`Could not link it: ${(e as Error).message}`) } finally { setBusy(null) }
  }
  const recheck = async () => {
    setBusy('recheck'); setNote(null)
    try {
      const r = await recheckMatches(supabase)
      setNote(r.linked ? `Linked ${r.linked} order item${r.linked === 1 ? '' : 's'} to products that are clearly the same (${r.changed} updated, ${r.questions} now ask Sample or bought?). They are listed in What the import changed.` : 'No clear matches found; use Same as on a row.')
      reload(); setTick((t) => t + 1)
    } catch (e) { setNote((e as Error).message) } finally { setBusy(null) }
  }
  const move = async (asin: string, b: Bucket) => {
    setBusy(asin)
    try { await setBucket(supabase, asin, b); reload() } catch (e) { setNote((e as Error).message) } finally { setBusy(null) }
  }

  return (
    <main>
      <Link to="/housekeeping" className="back">‹ Housekeeping</Link>
      <h1>{reviewOnly ? 'Bought, not filmed yet?' : 'Purchases'}</h1>
      <p className="muted page-sub">{reviewOnly ? 'Things you bought that would make a review and have no product yet. Make a product, or move it out of review.' : 'Your Amazon orders by bucket, one row per item.'}</p>
      <div className="month-chips" role="group" aria-label="Bucket">
        {BUCKETS.filter((b) => counts[b] || b === bucket).map((b) => (
          <button key={b} aria-pressed={b === bucket} onClick={() => setParams({ bucket: b })}>{BUCKET_LABEL[b]} {counts[b]}</button>
        ))}
      </div>
      {(bucket === 'review' || bucket === 'unsorted') && (
        <div className="actions"><button className="secondary" disabled={busy === 'recheck'} onClick={recheck}>{busy === 'recheck' ? 'Checking…' : 'Re-check matches'}</button></div>
      )}
      {note && <p className="muted small page-sub">{note}</p>}
      {groups.length === 0 ? <p className="empty">Nothing here.</p> : (
        <ul className="list">
          {groups.map((g) => {
            const p = g.buys.find((b) => b.product_id)?.product_id
            const product = p ? byId.get(p) : null
            return (
              <li key={g.asin} className="gap-row">
                <div className="row">
                  <div className="row-main">
                    <div className="row-title amz-title">{g.title ?? g.asin}</div>
                    <div className="row-sub"><span>{g.count === 1 ? fmtDay(g.last) : `${g.count}× · last ${fmtDay(g.last)}`}</span><span>{money(g.total)}</span><span>{g.asin}</span></div>
                    {product && <div className="row-sub"><Link to={`/product/${product.id}`}>{product.name} ›</Link></div>}
                  </div>
                </div>
                {!product && ctx && (bucket === 'review' || bucket === 'unsorted') && (() => {
                  const sugg = suggestFor(g.title, ctx)
                  if (confirm?.asin === g.asin) {
                    const c = confirm.product
                    const deal = ctx.hasDeal.has(c.id)
                    return (
                      <div className="same-confirm">
                        <p className="small"><b>Same as {c.name}?</b> {deal
                          ? 'It has a brand deal, so it goes to Answers needed: Sample or bought?'
                          : `It becomes Bought with the price paid and the first order date; ${g.asin} is added as another Amazon listing. Undo is in What the import changed.`}</p>
                        <div className="gap-fix">
                          <button className="primary" disabled={busy === g.asin} onClick={() => sameAs(g.asin, c)}>{busy === g.asin ? 'Linking…' : 'Yes, same'}</button>
                          <button className="link" onClick={() => setConfirm(null)}>Cancel</button>
                        </div>
                      </div>
                    )
                  }
                  return sugg.length > 0 && (
                    <div className="gap-fix same-row">
                      {sugg.map((x) => (
                        <button key={x.product.id} className={'secondary same-btn' + (x.strong ? ' same-strong' : '')} onClick={() => setConfirm({ asin: g.asin, product: x.product })}>
                          Same as {x.product.name}?
                        </button>
                      ))}
                    </div>
                  )
                })()}
                <div className="gap-fix">
                  {reviewOnly ? (
                    <>
                      <button className="secondary" disabled={busy === g.asin} onClick={() => make(g)}>{busy === g.asin ? 'Making…' : 'Make a product'}</button>
                      <span className="small muted">Not a review product:</span>
                      <button className="secondary" disabled={busy === g.asin} onClick={() => move(g.asin, 'household')}>Household</button>
                      <button className="secondary" disabled={busy === g.asin} onClick={() => move(g.asin, 'supplies')}>Supplies</button>
                    </>
                  ) : !product ? (
                    <label className="small muted">Move to{' '}
                      <select value={bucket} disabled={busy === g.asin} onChange={(e) => move(g.asin, e.target.value as Bucket)}>
                        {BUCKETS.map((b) => <option key={b} value={b}>{BUCKET_LABEL[b]}</option>)}
                      </select>
                    </label>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}

const FIELD_LABEL: Record<string, string> = { source: 'Source', price: 'Price', received_at: 'Arrived', received_estimated: 'Estimated date' }
const show = (k: string, v: unknown) =>
  v == null || v === '' ? '–' : k === 'source' ? SOURCE_LABEL[v as Product['source']] ?? String(v) : k === 'price' ? fmtPrice(v as number) ?? String(v) : k === 'received_at' ? fmtDay(String(v)) : k === 'received_estimated' ? (v ? 'yes' : 'no') : String(v)

/** What the purchases import changed, product by product, with Undo. */
export function PurchaseChanges() {
  const { data, error, reload } = useSnapshot()
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const changed = (data?.products ?? []).filter((p) => p.purchase_change).sort((a, b) => a.name.localeCompare(b.name))
  const undo = async (p: Product) => {
    setBusy(p.id); setNote(null)
    try {
      const kept = await undoPurchaseChange(supabase, p)
      setNote(`${p.name} is back as it was${kept.length ? ` (kept your later change to ${kept.map((k) => FIELD_LABEL[k] ?? k).join(', ')})` : ''}.`)
      reload()
    } catch (e) { setNote((e as Error).message) } finally { setBusy(null) }
  }
  return (
    <main>
      <Link to="/housekeeping" className="back">‹ Housekeeping</Link>
      <h1>What the import changed</h1>
      <p className="muted page-sub">Products the Amazon purchases import set to Bought, gave the price paid or the order date. Undo puts one back.</p>
      {error && <p className="error">{error}</p>}
      {note && <p className="muted small page-sub">{note}</p>}
      {!data ? <p className="muted">Loading…</p> : changed.length === 0 ? <p className="empty">Nothing changed.</p> : (
        <ul className="list">
          {changed.map((p) => {
            const ch = p.purchase_change!
            return (
              <li key={p.id} className="gap-row">
                <Link to={`/product/${p.id}`} state={{ from: '/housekeeping/changes' }} className="row">
                  <Thumb src={p.product_image_url} name={p.name} />
                  <div className="row-main">
                    <div className="row-title">{p.name}</div>
                    {(ch.links ?? []).filter((l) => l.via !== 'exact').map((l) => (
                      <div key={l.asin} className="row-sub"><span>Order {l.asin} linked {l.via === 'auto' ? 'automatically (looks the same)' : 'by Same as'}</span></div>
                    ))}
                    {Object.keys(ch.after).filter((k) => k !== 'received_estimated').map((k) => (
                      <div key={k} className="row-sub"><span>{FIELD_LABEL[k] ?? k}: {show(k, ch.before[k])} → <b>{show(k, ch.after[k])}</b></span></div>
                    ))}
                  </div>
                </Link>
                <div className="gap-fix"><button className="secondary" disabled={busy === p.id} onClick={() => undo(p)}>{busy === p.id ? 'Undoing…' : 'Undo'}</button></div>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}

/** "Sample or bought?": a product with a received sample deal and an Amazon order of the same ASIN. */
export function PurchaseAsk() {
  const { productId } = useParams()
  const { data, reload } = useSnapshot()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [deal, setDeal] = useState<{ received_at: string | null; brand: string | null; title: string | null } | null | undefined>(undefined)
  const product = data?.products.find((p) => p.id === productId)
  const buys = (data?.purchases ?? []).filter((p) => p.ask_product_id === productId && !p.product_id)
  useEffect(() => {
    if (!productId) return
    supabase.from('deals').select('received_at,brand,title').eq('product_id', productId).order('received_at').limit(1)
      .then(({ data: d }) => setDeal((d?.[0] as typeof deal) ?? null))
  }, [productId])
  const answer = async (a: 'sample' | 'bought' | 'both') => {
    if (!product) return
    setBusy(true); setErr(null)
    try {
      await answerPurchase(supabase, product, buys as Purchase[], a)
      reload()
      navigate('/products/answers', { replace: true })
    } catch (e) { setErr((e as Error).message); setBusy(false) }
  }
  const back = <Link to="/products/answers" className="back">‹ Answers needed</Link>
  if (!data) return <main>{back}<p className="muted">Loading…</p></main>
  if (!product || !buys.length) return <main>{back}<p className="empty">Nothing to answer here any more.</p></main>
  const first = [...buys].sort((a, b) => (a.order_date ?? '9999').localeCompare(b.order_date ?? '9999'))[0]
  return (
    <main>
      {back}
      <div className="pn" style={{ paddingTop: 8 }}><Thumb src={product.product_image_url} name={product.name} /><div style={{ minWidth: 0 }}><h1>{product.name}</h1><small>{SOURCE_LABEL[product.source]}{product.price != null ? ` · ${fmtPrice(product.price)}` : ''}</small></div></div>
      <section className="next">
        <span className="eyebrow">Answer</span>
        <h2>Sample or bought?</h2>
        <p>There is a brand deal for it and you also ordered it on Amazon.</p>
        <dl className="facts facts-light">
          <dt>Brand deal</dt><dd>{deal === undefined ? '…' : deal ? `${deal.brand ?? 'Deal'} · received ${fmtDay(deal.received_at)}` : 'linked'}</dd>
          <dt>Amazon order</dt><dd>{buys.length === 1 ? '' : `${buys.length} orders, first `}{fmtDay(first.order_date)} · {fmtPrice(first.unit_price) ?? 'no price'}</dd>
        </dl>
        <button className="pri" disabled={busy} onClick={() => answer('sample')}>Sample (the order was a re-buy)</button>
        <div className="sub"><span>Paid for it, no sample?</span><button disabled={busy} onClick={() => answer('bought')}>Bought ›</button></div>
        <div className="sub"><span>Got the sample and bought more?</span><button disabled={busy} onClick={() => answer('both')}>Both ›</button></div>
        {err && <p className="edit-err">{err}</p>}
      </section>
    </main>
  )
}
