import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { createProductFromDeal, ignoreDeal, linkDealToProduct, receiveDeal } from '../lib/deals'
import { STATUS_LABEL, type Deal, type Product } from '../lib/types'
import { DealCard } from '../components/DealCard'
import { Sheet } from '../components/Sheet'

/** A brand deal that matched no product: Charly says which product it is, or creates one. */
export function DealPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [deal, setDeal] = useState<Deal | null>(null)
  const [linked, setLinked] = useState<Product | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [all, setAll] = useState<Product[] | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    if (!id) return
    supabase.from('deals').select('*').eq('id', id).single().then(async ({ data, error }) => {
      if (error) return setError(error.message)
      setDeal(data as Deal)
      if (data?.product_id) {
        const { data: p } = await supabase.from('products').select('*').eq('id', data.product_id).maybeSingle()
        setLinked((p as Product | null) ?? null)
      }
    })
  }, [id])

  useEffect(() => {
    if (!picking || all) return
    supabase.from('products').select('*').order('name').then(({ data }) => setAll((data ?? []) as Product[]))
  }, [picking, all])

  const hits = useMemo(() => {
    if (!all) return []
    const s = q.trim().toLowerCase()
    return (s ? all.filter((p) => p.name.toLowerCase().includes(s) || (p.brand ?? '').toLowerCase().includes(s)) : all).slice(0, 30)
  }, [all, q])

  const run = useCallback(async (label: string, fn: () => Promise<string | void>) => {
    setBusy(true)
    setError(null)
    try {
      const to = await fn()
      if (to) navigate(to, { replace: true })
    } catch (e) {
      setError(`${label} failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [navigate])

  if (error && !deal) return <main><Link to="/" className="back">‹ Home</Link><p className="error">{error}</p></main>
  if (!deal) return <main><Link to="/" className="back">‹ Home</Link><p className="muted">Loading…</p></main>

  return (
    <main>
      <Link to="/" className="back">‹ Home</Link>
      <h1>Brand deal</h1>
      {error && <p className="error">{error}</p>}
      <DealCard deal={deal} />

      {linked ? (
        <section>
          <h2>Linked product</h2>
          <ul className="list"><li><Link to={`/product/${linked.id}`} className="row"><span className="row-main"><span className="row-title">{linked.name}</span><span className="row-sub">{STATUS_LABEL[linked.status]}</span></span><span className="chev">›</span></Link></li></ul>
        </section>
      ) : deal.match_status === 'ignored' ? (
        <section><p className="muted">Ignored. It stays out of the lists.</p></section>
      ) : deal.match_status === 'waiting' ? (
        <section>
          <h2>Nothing has arrived yet</h2>
          <p className="muted small">When the box turns up, tap "It arrived": that creates the product with the brand, ASIN and image from the deal.</p>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => run('It arrived', async () => {
              const p = await receiveDeal(supabase, deal)
              return `/product/${p.id}`
            })}>It arrived</button>
            <button className="secondary" onClick={() => setPicking(true)} disabled={busy}>It is a product I already have…</button>
            <button className="link" disabled={busy} onClick={() => run('Ignore', async () => {
              await ignoreDeal(supabase, deal)
              return '/'
            })}>Ignore this deal</button>
          </div>
        </section>
      ) : (
        <section>
          <h2>Which product is this?</h2>
          <p className="muted small">The ASIN did not match any product. Most often it is a colour or size of one you already have.</p>
          <div className="actions">
            <button className="primary" onClick={() => setPicking(true)} disabled={busy}>Same as… (search products)</button>
            <button className="secondary" disabled={busy} onClick={() => run('Create product', async () => {
              const p = await createProductFromDeal(supabase, deal)
              return `/product/${p.id}`
            })}>Create new product</button>
            <button className="link" disabled={busy} onClick={() => run('Ignore', async () => {
              await ignoreDeal(supabase, deal)
              return '/'
            })}>Ignore this deal</button>
          </div>
        </section>
      )}

      {picking && (
        <Sheet title="Same as which product?" onClose={() => setPicking(false)}>
          <input type="search" className="search" placeholder="Search name or brand" value={q} onChange={(e) => setQ(e.target.value)} autoFocus autoCapitalize="none" autoCorrect="off" />
          {!all ? <p className="muted">Loading…</p> : (
            <ul className="list">
              {hits.map((p) => (
                <li key={p.id}>
                  <button className="row row-btn" disabled={busy} onClick={() => run('Link', async () => {
                    await linkDealToProduct(supabase, deal, p)
                    return `/product/${p.id}`
                  })}>
                    <span className="row-main"><span className="row-title">{p.name}</span><span className="row-sub">{STATUS_LABEL[p.status]}</span></span>
                    <span className="chev" aria-hidden>›</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Sheet>
      )}
    </main>
  )
}
