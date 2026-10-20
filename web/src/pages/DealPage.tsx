import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { createProductFromDeal, ignoreDeal, linkDealToProduct, receiveDeal, selectAll, substituteDeal, suggestProducts, unlinkDeal } from '../lib/deals'
import { parsePrice, SOURCE_HELP, SOURCE_LABEL, SOURCE_ORDER, STATUS_LABEL, type Deal, type Product, type ProductSource } from '../lib/types'
import { DealCard } from '../components/DealCard'
import { Options, Sheet } from '../components/Sheet'

/** A brand deal that matched no product: Charly says which product it is, or creates one. */
export function DealPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [deal, setDeal] = useState<Deal | null>(null)
  const [linked, setLinked] = useState<Product | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState<false | 'same' | 'substitute'>(false)
  const [substitute, setSubstitute] = useState<Product | null>(null)
  const [substituteSource, setSubstituteSource] = useState<'amazon_sample' | 'bought'>('amazon_sample')
  const [arrived, setArrived] = useState(false)
  const [paid, setPaid] = useState<string | null>(null)   // "I bought it": what Charly paid (null until picked)
  const [confirm, setConfirm] = useState<Product | null>(null)
  const [confirmSource, setConfirmSource] = useState<'amazon_sample' | 'bought'>('amazon_sample')
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  const [sourceSheet, setSourceSheet] = useState(false)
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
    if (all || !deal || deal.product_id || deal.match_status === 'ignored') return
    selectAll<Product>((a, b) => supabase.from('products').select('*').order('name').range(a, b)).then((rows) => setAll(rows.filter((x) => !x.archived_at)))
  }, [all, deal])

  // Home's "Yes, same" opens straight on the confirm step for the suggested product
  const location = useLocation()
  const confirmId = (location.state as { confirmId?: string } | null)?.confirmId
  const [usedConfirmId, setUsedConfirmId] = useState(false)
  useEffect(() => {
    if (usedConfirmId || !confirmId || !all || !deal || deal.product_id) return
    const p = all.find((x) => x.id === confirmId)
    if (p) setConfirm(p)
    setUsedConfirmId(true)
  }, [confirmId, usedConfirmId, all, deal])

  const suggestions = useMemo(() => (all && deal ? suggestProducts(deal, all, 3).map((s) => all.find((p) => p.id === s.id)!) : []), [all, deal])

  const hits = useMemo(() => {
    if (!all) return []
    const s = q.trim().toLowerCase()
    if (s) return all.filter((p) => p.name.toLowerCase().includes(s) || (p.brand ?? '').toLowerCase().includes(s)).slice(0, 30)
    if (picking === 'substitute' && deal?.brand) {
      // same-brand products first: that is usually what the brand sent instead
      const b = deal.brand.toLowerCase()
      const same = all.filter((p) => (p.brand ?? '').toLowerCase().includes(b) || p.name.toLowerCase().includes(b))
      const rest = all.filter((p) => !same.includes(p))
      return [...same, ...rest].slice(0, 30)
    }
    return all.slice(0, 30)
  }, [all, q, picking, deal])

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

  if (error && !deal) return <main><Link to="/products" className="back">‹ Products</Link><p className="error">{error}</p></main>
  if (!deal) return <main><Link to="/products" className="back">‹ Products</Link><p className="muted">Loading…</p></main>

  return (
    <main>
      <Link to="/products" className="back">‹ Products</Link>
      <h1>Brand deal</h1>
      {error && <p className="error">{error}</p>}
      <DealCard deal={deal} productSource={linked?.source} productName={linked?.name} />

      {linked ? (
        <section>
          <h2>Linked product</h2>
          <ul className="list"><li><Link to={`/product/${linked.id}`} className="row"><span className="row-main"><span className="row-title">{linked.name}</span><span className="row-sub">{STATUS_LABEL[linked.status]}</span></span><span className="chev">›</span></Link></li></ul>
          <div className="chips">
            <button className={'chip chip-btn' + (linked.source === 'unknown' ? ' chip-ask' : '')} onClick={() => setSourceSheet(true)}>{SOURCE_LABEL[linked.source]} ▾</button>
          </div>
          <div className="actions"><button className="link" disabled={busy} onClick={() => setConfirmUnlink(true)}>Unlink (wrong product)</button></div>
        </section>
      ) : deal.match_status === 'ignored' ? (
        <section><p className="muted">Ignored. It stays out of the lists.</p></section>
      ) : deal.match_status === 'waiting' ? (
        <section>
          <h2>Nothing has arrived yet</h2>
          <p className="muted small">When the box turns up, tap "It arrived": that creates the product with the brand, ASIN and image from the deal.</p>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => setArrived(true)}>It arrived</button>
            <button className="secondary" onClick={() => setPicking('same')} disabled={busy}>It is a product I already have…</button>
            <button className="secondary" onClick={() => setPicking('substitute')} disabled={busy}>They sent something else…</button>
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
          {suggestions.length > 0 && (
            <ul className="list">
              {suggestions.map((p) => (
                <li key={p.id}>
                  <button className="row row-btn" disabled={busy} onClick={() => setConfirm(p)}>
                    <span className="row-main"><span className="row-title">Same as {p.name}?</span><span className="row-sub">{STATUS_LABEL[p.status]}{p.brand ? ` · ${p.brand}` : ''}</span></span>
                    <span className="chev" aria-hidden>›</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="actions">
            <button className="primary" onClick={() => setPicking('same')} disabled={busy}>Same as… (search products)</button>
            <button className="secondary" disabled={busy} onClick={() => run('Create product', async () => {
              const p = await createProductFromDeal(supabase, deal)
              return `/product/${p.id}`
            })}>Create new product</button>
            <button className="secondary" disabled={busy} onClick={() => run('Create product', async () => {
              const p = await createProductFromDeal(supabase, deal, { source: 'bought' })
              return `/product/${p.id}`
            })}>Create new — I bought it</button>
            <button className="secondary" disabled={busy} onClick={() => setPicking('substitute')}>They sent something else…</button>
            <button className="link" disabled={busy} onClick={() => run('Ignore', async () => {
              await ignoreDeal(supabase, deal)
              return '/'
            })}>Ignore this deal</button>
          </div>
        </section>
      )}

      {confirm && (
        <Sheet title="Link this deal?" onClose={() => setConfirm(null)}>
          <p>Link <b>{deal.brand ?? deal.title}</b> to <b>{confirm.name}</b>?</p>
          <p className="muted small">The product gets this deal's ASIN listing and, where empty, its brand, image and received date. You can unlink later.</p>
          <Options
            options={[
              { value: 'amazon_sample' as const, label: 'Free sample', help: 'The brand sent it through the deal.' },
              { value: 'bought' as const, label: 'I bought it', help: 'Paid for it yourself; the product is marked Bought.' },
            ]}
            value={confirmSource}
            onPick={setConfirmSource}
          />
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => run('Link', async () => {
              await linkDealToProduct(supabase, deal, confirm, {}, confirmSource === 'bought' ? 'bought' : undefined)
              return `/product/${confirm.id}`
            })}>Yes, link</button>
            <button className="link" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </Sheet>
      )}

      {substitute && (
        <Sheet title="They sent something else" onClose={() => setSubstitute(null)}>
          <p>Applied for <b>{deal.title ?? deal.asin}</b>; they sent <b>{substitute.name}</b>?</p>
          <p className="muted small">The deal is linked to {substitute.name} for the record. Its ASIN, brand and image stay as they are.</p>
          <Options
            options={[
              { value: 'amazon_sample' as const, label: 'Free sample', help: 'The brand sent it through the deal.' },
              { value: 'bought' as const, label: 'I bought it', help: 'Paid for it yourself; the product is marked Bought.' },
            ]}
            value={substituteSource}
            onPick={setSubstituteSource}
          />
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => run('Link', async () => {
              await substituteDeal(supabase, deal, substitute, substituteSource === 'bought' ? 'bought' : undefined)
              return `/product/${substitute.id}`
            })}>Yes, link to {substitute.name}</button>
            <button className="link" onClick={() => setSubstitute(null)}>Cancel</button>
          </div>
        </Sheet>
      )}

      {sourceSheet && linked && (
        <Sheet title="Where did it come from?" onClose={() => setSourceSheet(false)}>
          <p className="muted small">Changes the source on {linked.name}.</p>
          <Options
            options={SOURCE_ORDER.map((v) => ({ value: v, label: SOURCE_LABEL[v], help: SOURCE_HELP[v] }))}
            value={linked.source === 'unknown' ? null : linked.source}
            onPick={(source: ProductSource) => run('Changing source', async () => {
              const { error } = await supabase.from('products').update({ source }).eq('id', linked.id)
              if (error) throw error
              setLinked({ ...linked, source })
              setSourceSheet(false)
            })}
          />
        </Sheet>
      )}

      {confirmUnlink && linked && (
        <Sheet title="Unlink this deal?" onClose={() => setConfirmUnlink(false)}>
          <p>
            {deal.link_added?.created_product
              ? <>The product <b>{linked.name}</b> was created from this deal and will be removed.</>
              : <>Only what the link added to <b>{linked.name}</b> is removed (its ASIN listing, post and fields it filled). Nothing set earlier is touched.</>}
          </p>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => run('Unlink', async () => {
              await unlinkDeal(supabase, deal)
              setLinked(null)
              setDeal({ ...deal, product_id: null, link_added: null, match_status: deal.received_at && !deal.link_added?.stamped_received ? 'needs_review' : 'waiting' })
              setConfirmUnlink(false)
            })}>Unlink</button>
            <button className="link" onClick={() => setConfirmUnlink(false)}>Cancel</button>
          </div>
        </Sheet>
      )}

      {arrived && (
        <Sheet title="It arrived: how did you get it?" onClose={() => { setArrived(false); setPaid(null) }}>
          <p className="muted small">This creates the product with the brand, ASIN and image from the deal.</p>
          <Options
            options={[
              { value: 'amazon_sample' as const, label: 'Free sample', help: 'The brand sent it through the deal.' },
              { value: 'bought' as const, label: 'I bought it', help: 'Paid for it yourself; the deal stays linked for the record.' },
            ]}
            value={paid !== null ? 'bought' : null}
            onPick={(source) => source === 'bought'
              ? setPaid(deal.price != null ? Number(deal.price).toFixed(2) : '')
              : run('It arrived', async () => {
                const p = await receiveDeal(supabase, deal, { source })
                return `/product/${p.id}`
              })}
          />
          {paid !== null && (
            <form className="form" onSubmit={(e) => { e.preventDefault(); run('It arrived', async () => {
              const price = parsePrice(paid)
              const p = await receiveDeal(supabase, deal, { source: 'bought', ...(price != null ? { price } : {}) })
              return `/product/${p.id}`
            }) }}>
              <label>What did you pay? <span className="muted">(optional, US $)</span>
                <input inputMode="decimal" autoFocus placeholder="e.g. 27.99" value={paid} onChange={(e) => setPaid(e.target.value)} />
              </label>
              <button className="primary" type="submit" disabled={busy}>It arrived</button>
            </form>
          )}
        </Sheet>
      )}

      {picking && (
        <Sheet title={picking === 'substitute' ? 'What did they send?' : 'Same as which product?'} onClose={() => setPicking(false)}>
          {picking === 'substitute' && <p className="muted small">Pick the product that actually arrived. The deal's own ASIN, title and image are not copied onto it.</p>}
          <input type="search" className="search" placeholder="Search name or brand" value={q} onChange={(e) => setQ(e.target.value)} autoFocus autoCapitalize="none" autoCorrect="off" />
          {!all ? <p className="muted">Loading…</p> : (
            <ul className="list">
              {hits.map((p) => (
                <li key={p.id}>
                  <button className="row row-btn" disabled={busy} onClick={() => { const mode = picking; setPicking(false); mode === 'substitute' ? setSubstitute(p) : setConfirm(p) }}>
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
