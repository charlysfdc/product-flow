import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useSnapshot } from '../lib/data'
import type { Product } from '../lib/types'
import { ProductRow } from '../components/ProductRow'
import { IconGear } from '../components/Icons'
import { tidyReady } from '../lib/functions'
import { buildFlow, fixups, moneyShort, valueOf, withPaidPrices } from '../lib/flow'

const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null)

/** Home: Add product and search, then three tiles: Products, Stats, Housekeeping. */
export function Home() {
  // Ready to Post catches up with anything changed elsewhere (ViralVue imports, the other phone): at most every 6 hours
  useEffect(() => {
    try {
      const last = Number(localStorage.getItem('pf.readySync') || 0)
      if (Date.now() - last < 6 * 3600_000) return
      localStorage.setItem('pf.readySync', String(Date.now()))
    } catch { return }
    tidyReady()
  }, [])

  const { data, error } = useSnapshot()
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const location = useLocation()
  const [notice, setNotice] = useState<string | null>(() => (location.state as { notice?: string } | null)?.notice ?? null)

  const flow = useMemo(() => (data ? buildFlow(data) : null), [data])
  const search = useMemo((): Product[] | null => {
    const q = query.trim().toLowerCase()
    if (!q || !data) return null
    const asinHits = new Set(data.listings.filter((l) => l.external_id && l.external_id.toLowerCase().includes(q)).map((l) => l.product_id))
    return (showHidden ? [...data.products, ...data.hidden] : data.products)
      .filter((p) => p.name.toLowerCase().includes(q) || (p.brand ?? '').toLowerCase().includes(q) || asinHits.has(p.id) || (p.upc ?? '').includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [data, query, showHidden])

  const samples = data ? valueOf(withPaidPrices(data.products, data.purchases), 'sample') : null
  const bought = data ? valueOf(withPaidPrices(data.products, data.purchases), 'bought') : null
  const missingPrice = data ? fixups(data).price.length : 0
  const things = flow ? flow.answers + flow.due.length : 0
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <main>
      <div className="today-top">
        <span className="date">{today}</span>
        <Link to="/housekeeping" className="icon-btn" aria-label="Housekeeping and settings"><IconGear /></Link>
      </div>

      {!search && (
        <h1 className="today-title">
          {!flow ? 'Loading…' : things === 0 ? <>Nothing due <em>today</em></> : <>{things} thing{things === 1 ? '' : 's'} <em>today</em></>}
        </h1>
      )}

      <Link to="/add" className="add-btn">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        <span><b>Add product</b><small>Scan it, snap it or paste a link</small></span>
      </Link>

      <input
        type="search"
        className="search"
        placeholder="Search name, brand, ASIN or barcode"
        aria-label="Search products"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
      />

      {error && <p className="error">Could not load: {error}</p>}
      {notice && <div className="notice"><span>{notice}</span><button onClick={() => setNotice(null)}>OK</button></div>}

      {search && (
        <section>
          <h2>{search.length} result{search.length === 1 ? '' : 's'}</h2>
          {(data?.hidden.length ?? 0) > 0 && (
            <label className="toggle"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden ({data!.hidden.length})</label>
          )}
          <ul className="list">{search.map((p) => <ProductRow key={p.id} product={p} showStatus />)}</ul>
        </section>
      )}

      {!search && flow && data && (
        <div className="tiles">
          <div className="tile-big">
            <Link to="/products" className="tile-head">
              <span className="tile-eyebrow">Products</span>
              <span className="tile-all">{data.products.length.toLocaleString()} ›</span>
            </Link>
            <div className="tile-grid">
              <Link to="/products/film" className="tile-cell"><b>{flow.film.length}</b><span>Film</span></Link>
              <Link to="/products/edit" className="tile-cell"><b>{flow.edit.length}</b><span>Edit</span></Link>
              <Link to="/products/post" className="tile-cell">
                <b>{flow.postCount}</b><span>Post</span>
                {flow.postDue > 0 && <i className="badge-due">{flow.postDue} due</i>}
              </Link>
              <Link to="/products/answers" className="tile-cell tile-cell-ask"><b>{flow.answers}</b><span>{flow.answers === 1 ? 'Needs an answer' : 'Need answers'}</span></Link>
            </div>
            <Link to="/products/completed" className="tile-done"><b>{flow.completed.length.toLocaleString()}</b><span>completed</span><span className="tile-done-chev" aria-hidden>›</span></Link>
          </div>

          <div className="tile-pair">
            <Link to="/stats" className="tile-half">
              <span className="tile-eyebrow tile-eyebrow-dark">Stats</span>
              <b>{moneyShort(samples!.value)}</b>
              <span>in samples this year (and undated)</span>
              <span className="tile-foot">Bought <b>{moneyShort(bought!.value)}</b></span>
            </Link>
            <Link to="/housekeeping" className="tile-half">
              <span className="tile-eyebrow tile-eyebrow-dark">Housekeeping</span>
              <b>{missingPrice.toLocaleString()}</b>
              <span>missing a price</span>
              <span className="tile-foot">Last ViralVue import <b>{fmtDay(data.lastImport) ?? 'never'}</b></span>
            </Link>
          </div>
        </div>
      )}
    </main>
  )
}
