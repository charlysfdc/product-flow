import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useSnapshot } from '../lib/data'
import { importDeals, type ImportSummary } from '../lib/deals'
import { detectExport, importViews, type ViewsSummary } from '../lib/views'
import { restoreProduct } from '../lib/functions'
import { FIX_LABEL, fixups, type FixKind } from '../lib/flow'
import { ARCHIVE_REASON_LABEL, type Product } from '../lib/types'
import { ProductRow, Thumb } from '../components/ProductRow'
import { FindAmazonSheet } from '../components/FindAmazon'
import { PurchasesCard } from './Purchases'

const fmtDay = (d: string | null | undefined) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'never')

/** Housekeeping: imports, fix-ups, hidden items and settings. */
export function Housekeeping() {
  const { data, error, reload } = useSnapshot()
  const fix = useMemo(() => (data ? fixups(data) : null), [data])
  const lastViews = data?.posts.reduce<string | null>((m, po) => (po.views_checked_at && (!m || po.views_checked_at > m) ? po.views_checked_at : m), null) ?? null
  return (
    <main>
      <Link to="/" className="back">‹ Home</Link>
      <h1>Housekeeping</h1>
      {error && <p className="error">Could not load: {error}</p>}

      <ImportCard lastDeals={data?.lastImport ?? null} lastViews={lastViews} onDone={reload} />

      <PurchasesCard data={data} onDone={reload} />

      <section>
        <h2>Fix-ups</h2>
        <ul className="list">
          {(Object.keys(FIX_LABEL) as FixKind[]).map((k) => (
            <li key={k}>
              <Link to={`/housekeeping/fix/${k}`} className="row">
                <div className="row-main"><div className="row-title">{FIX_LABEL[k].title}</div>{k === 'dupes' && <div className="row-sub"><span>Same ASIN on two products</span></div>}</div>
                <b className={fix && (k === 'dupes' ? fix.dupeGroups.length : fix[k].length) ? 'fix-n' : 'muted'}>{fix ? (k === 'dupes' ? fix.dupeGroups.length : fix[k].length).toLocaleString() : '…'}</b>
                <span className="chev" aria-hidden>›</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <ul className="list" style={{ marginTop: 14 }}>
          <li>
            <Link to="/housekeeping/hidden" className="row">
              <div className="row-main"><div className="row-title">Hidden items</div><div className="row-sub"><span>Not a product review · footage in AiA Life</span></div></div>
              <b>{data ? data.hidden.length : '…'}</b>
              <span className="chev" aria-hidden>›</span>
            </Link>
          </li>
        </ul>
      </section>

      <section>
        <h2>Settings</h2>
        <ul className="list">
          <li><Link to="/settings" className="row"><div className="row-main"><div className="row-title">Google Drive, this phone, who can sign in</div><div className="row-sub"><span>Sign out is there too</span></div></div><span className="chev" aria-hidden>›</span></Link></li>
        </ul>
      </section>
    </main>
  )
}

/** Import ViralVue: one file picker for either export (brand deals, or Amazon videos with views). */
function ImportCard({ lastDeals, lastViews, onDone }: { lastDeals: string | null; lastViews: string | null; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [views, setViews] = useState<ViewsSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    setSummary(null)
    setViews(null)
    try {
      const text = await file.text()
      const kind = detectExport(text)
      if (kind === 'videos') setViews(await importViews(supabase, text, setProgress))
      else if (kind === 'deals') setSummary(await importDeals(supabase, text, setProgress))
      else throw new Error('This file is not a ViralVue export: expected the Amazon brand deals (Deal ID column) or the Amazon videos (video_id, views_count columns).')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      setProgress(null)
      onDone()
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
      <section>
        <div className="card">
          <div className="card-title">Import ViralVue</div>
          <p className="muted small">Brand deals: last import <b>{fmtDay(lastDeals)}</b> · Amazon video views: last check <b>{fmtDay(lastViews)}</b></p>
          <p className="muted small">
            Either export works; the app tells them apart. <b>Amazon brand deals</b> (CSV): deals are updated, not duplicated, and ticks ViralVue already shows clear their reminders.
            <b> Amazon videos</b> (CSV): updates the views on every Amazon post. Pick the file from Files on the iPhone or from the Mac; nothing you set by hand is overwritten.
          </p>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
          <button className="primary" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Importing…' : 'Choose CSV file'}</button>
          {progress && <p className="muted small">{progress}</p>}
          {error && <p className="error">{error}</p>}
          {views && (
            <div className="summary">
              <p><b>{views.total}</b> Amazon videos, <b>{views.views.toLocaleString()}</b> views in all.</p>
              <p className="muted small">
                {views.byId + views.byTitle + views.byAsin} posts updated ({views.byId} by video id, {views.byTitle} by title, {views.byAsin} by ASIN)
                {views.created ? `, ${views.created} videos recorded that the app didn’t know` : ''}{views.done ? `, ${views.done} products now Done` : ''}.
              </p>
              {views.unmatched.length > 0 && (
                <details><summary>{views.unmatched.length} videos matched no product</summary><ul>{views.unmatched.map((t, i) => <li key={i} className="small">{t}</li>)}</ul></details>
              )}
              {views.errors.length > 0 && (
                <details><summary className="error">{views.errors.length} rows failed</summary><ul>{views.errors.map((e, i) => <li key={i} className="small">{e}</li>)}</ul></details>
              )}
            </div>
          )}
          {summary && (
            <div className="summary">
              <p><b>{summary.total}</b> deals in the file: <b>{summary.created}</b> new, <b>{summary.updated}</b> updated, <b>{summary.needsReview.length}</b> need your answer.</p>
              <p className="muted small">
                {summary.matched} linked to a product ({summary.productsCreated.length} products created), {summary.waitingShown} waiting on the brand
                {summary.waitingHidden > 0 ? ` (+${summary.waitingHidden} went quiet)` : ''}, {summary.closed} declined, {summary.postsCreated} Amazon posts recorded.
                {summary.replyRate.messaged > 0 && ` Reply rate: ${summary.replyRate.received} of ${summary.replyRate.messaged} messaged brands sent a product.`}
              </p>
              {(summary.viralvue.cleared > 0 || summary.viralvue.message > 0) && (
                <p className="muted small">ViralVue: {summary.viralvue.cleared} reminder{summary.viralvue.cleared === 1 ? '' : 's'} cleared by this export{summary.viralvue.message ? `; ${summary.viralvue.message} published deal${summary.viralvue.message === 1 ? '' : 's'} with no brand message` : ''}.</p>
              )}
              {summary.needsReview.length > 0 && <p><Link to="/products/answers">Answer them</Link></p>}
              {summary.errors.length > 0 && (
                <details><summary className="error">{summary.errors.length} rows failed</summary><ul>{summary.errors.map((e, i) => <li key={i} className="small">{e}</li>)}</ul></details>
              )}
            </div>
          )}
        </div>
      </section>
  )
}

/** One fix-up list; each row opens the Product screen to fix it. */
export function FixList() {
  const { kind = 'price' } = useParams()
  const { data, error, reload } = useSnapshot()
  const fix = useMemo(() => (data ? fixups(data) : null), [data])
  const k = (kind in FIX_LABEL ? kind : 'price') as FixKind
  // Missing details: work through the list; after each one the sheet opens the next
  const [queue, setQueue] = useState<{ ids: string[]; at: number } | null>(null)
  const current = queue && data ? data.products.find((p) => p.id === queue.ids[queue.at]) ?? null : null
  const next = () => setQueue((q) => (q && q.at + 1 < q.ids.length ? { ...q, at: q.at + 1 } : null))
  return (
    <main>
      <Link to="/housekeeping" className="back">‹ Housekeeping</Link>
      <h1>{FIX_LABEL[k].title}</h1>
      <p className="muted page-sub">{FIX_LABEL[k].help}</p>
      {error && <p className="error">Could not load: {error}</p>}
      {!fix ? <p className="muted">Loading…</p> : k === 'dupes' ? (
        fix.dupeGroups.length === 0 ? <p className="empty">No two products share an ASIN.</p> : fix.dupeGroups.map((g) => (
          <section key={g.asin} className="list-group">
            <h2>ASIN {g.asin}</h2>
            <ul className="list">{g.items.map((p) => <ProductRow key={p.id} product={p} showStatus />)}</ul>
          </section>
        ))
      ) : fix[k].length === 0 ? <p className="empty">Nothing to fix.</p> : k === 'details' ? (
        <ul className="list">
          {fix.details.map((p, i) => {
            const onAmazon = data!.listings.some((l) => l.product_id === p.id && l.platform === 'amazon_us')
            return (
              <li key={p.id} className="fix-row">
                <Link to={`/product/${p.id}`} state={{ from: '/housekeeping/fix/details' }} className="row">
                  <Thumb src={p.product_image_url} name={p.name} />
                  <div className="row-main"><div className="row-title">{p.name}</div><div className="row-sub">{[!p.product_image_url && 'No picture', !onAmazon && 'No Amazon listing'].filter(Boolean).map((t) => <span key={String(t)}>{t}</span>)}</div></div>
                </Link>
                <button className="secondary fix-btn" onClick={() => setQueue({ ids: fix.details.map((x) => x.id), at: i })}>Find on Amazon</button>
              </li>
            )
          })}
        </ul>
      ) : (
        <ul className="list">{fix[k].map((p) => <ProductRow key={p.id} product={p} showStatus />)}</ul>
      )}
      {current && queue && (
        <FindAmazonSheet
          key={current.id}
          product={current}
          hasAmazonListing={data!.listings.some((l) => l.product_id === current.id && l.platform === 'amazon_us')}
          onClose={() => setQueue(null)}
          onDone={reload}
          onNext={next}
          nextLabel={queue.at + 1 < queue.ids.length ? 'Next product' : 'Finish'}
        />
      )}
    </main>
  )
}

/** Housekeeping > Hidden: products taken out of the flow (Not a product review), with Restore. */
export function HiddenPage() {
  const [items, setItems] = useState<Product[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const load = () => {
    supabase.from('products').select('*').not('archived_at', 'is', null).order('archived_at', { ascending: false })
      .then(({ data, error }) => setItems(error ? [] : (data ?? []) as Product[]))
  }
  useEffect(load, [])
  const restore = async (p: Product) => {
    setBusy(p.id)
    setNote(null)
    try {
      const r = await restoreProduct(p.id)
      setNote(`${p.name} is back in the flow.${r.moved_back ? ' Its footage is back in Products.' : ''}${r.note ? ` ${r.note}` : ''}`)
      load()
    } catch (e) {
      setNote(`Restore failed: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }
  return (
    <main>
      <Link to="/housekeeping" className="back">‹ Housekeeping</Link>
      <h1>Hidden <span className="count">{items?.length ?? '…'}</span></h1>
      <p className="muted page-sub">Not a product review: left out of every list, count and search. Restore puts it back (and its footage back in Products).</p>
      {note && <p className="muted small" style={{ margin: '0 4px 8px' }}>{note}</p>}
      {items && items.length === 0 ? (
        <p className="empty">Nothing hidden. On a Product screen, Housekeeping → Not a product review takes random footage out of the flow.</p>
      ) : (
        <ul className="list">
          {(items ?? []).map((p) => (
            <li key={p.id}>
              <div className="row">
                <Thumb src={p.product_image_url} name={p.name} />
                <Link to={`/product/${p.id}`} className="row-main" style={{ color: 'inherit' }}>
                  <span className="row-title">{p.name}</span>
                  <span className="row-sub">
                    <span>{ARCHIVE_REASON_LABEL[p.archived_reason ?? ''] ?? 'Hidden'}</span>
                    {p.archived_move?.moved?.length ? <span>footage in AiA Life</span> : null}
                  </span>
                </Link>
                <button className="secondary" disabled={busy === p.id} onClick={() => restore(p)}>{busy === p.id ? 'Restoring…' : 'Restore'}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
