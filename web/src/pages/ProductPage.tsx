import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useProduct } from '../lib/data'
import { supabase } from '../lib/supabase'
import { mergeProducts } from '../lib/merge'
import {
  AVAILABILITY_LABEL, PLATFORM_LABEL, PLATFORM_ORDER, SOURCE_HELP, SOURCE_LABEL, SOURCE_ORDER,
  STATUS_HELP, STATUS_LABEL, STATUS_ORDER, driveFolderUrl,
  type Platform, type Post, type Product, type ProductSource, type ProductStatus,
} from '../lib/types'
import { deadlineText } from '../components/ProductRow'
import { Options, Sheet } from '../components/Sheet'
import { DealCard } from '../components/DealCard'

function fmtDate(d: string | null) {
  if (!d) return null
  return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
const today = () => new Date().toISOString().slice(0, 10)

type SheetKind =
  | { kind: 'status' }
  | { kind: 'source' }
  | { kind: 'post'; platform: Platform }
  | { kind: 'addPlatform' }
  | { kind: 'merge' }
  | null

export function ProductPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { detail, error, reload } = useProduct(id)
  const [sheet, setSheet] = useState<SheetKind>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const close = useCallback(() => setSheet(null), [])

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(true)
    setActionError(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setActionError(`${label} failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [reload])

  const checklist = useMemo(() => {
    if (!detail) return []
    const { listings, posts } = detail
    const planned = new Set<Platform>()
    for (const l of listings) if (l.availability !== 'not_listed') planned.add(l.platform)
    for (const po of posts) planned.add(po.platform)
    return PLATFORM_ORDER.filter((pl) => planned.has(pl)).map((pl) => {
      const mine = posts.filter((po) => po.platform === pl)
      return { platform: pl, posts: mine, posted: mine.some((po) => po.status === 'posted') }
    })
  }, [detail])

  if (error) return <main><Link to="/" className="back">‹ Home</Link><p className="error">{error}</p></main>
  if (!detail) return <main><Link to="/" className="back">‹ Home</Link><p className="muted">Loading…</p></main>

  const { product: p, listings, posts, jobs, deals } = detail
  const due = deadlineText(p.deadline)
  const totalViews = posts.reduce((n, po) => n + (po.views ?? 0), 0)
  const folderUrl = driveFolderUrl(p)
  const allPosted = checklist.length > 0 && checklist.every((c) => c.posted)

  const setStatus = (status: ProductStatus) =>
    run('Changing status', async () => {
      const { error } = await supabase.from('products').update({ status }).eq('id', p.id)
      if (error) throw error
      close()
    })

  const setSource = (source: ProductSource) =>
    run('Changing source', async () => {
      const { error } = await supabase.from('products').update({ source }).eq('id', p.id)
      if (error) throw error
      close()
    })

  /** After a post is saved: Done when every planned platform has a posted post. */
  const maybeDone = async () => {
    const { data } = await supabase.from('posts').select('platform,status').eq('product_id', p.id)
    const planned = new Set<Platform>(listings.filter((l) => l.availability !== 'not_listed').map((l) => l.platform))
    for (const po of data ?? []) planned.add(po.platform as Platform)
    const postedOn = new Set((data ?? []).filter((po) => po.status === 'posted').map((po) => po.platform))
    if (planned.size > 0 && [...planned].every((pl) => postedOn.has(pl)) && p.status !== 'done') {
      await supabase.from('products').update({ status: 'done' }).eq('id', p.id)
    }
  }

  const savePost = (platform: Platform, url: string, date: string, existing?: Post) =>
    run('Saving post', async () => {
      const row = { product_id: p.id, platform, status: 'posted' as const, url: url || null, posted_at: date || null }
      const { error } = existing
        ? await supabase.from('posts').update(row).eq('id', existing.id)
        : await supabase.from('posts').insert(row)
      if (error) throw error
      await maybeDone()
      close()
    })

  const removePost = (post: Post) =>
    run('Removing post', async () => {
      const { error } = await supabase.from('posts').delete().eq('id', post.id)
      if (error) throw error
    })

  const doMerge = (target: Product, keepName: string) =>
    run('Merge', async () => {
      await mergeProducts(p, target, keepName)
      close()
      navigate(`/product/${target.id}`, { replace: true })
    })

  return (
    <main>
      <Link to="/" className="back">‹ Home</Link>
      <header className="product-head">
        {p.product_image_url && <img src={p.product_image_url} alt="" className="product-img" />}
        <h1>{p.name}</h1>
        <div className="chips">
          <button className={`chip chip-btn status-${p.status}`} onClick={() => setSheet({ kind: 'status' })}>
            {STATUS_LABEL[p.status]} ▾
          </button>
          <button className={'chip chip-btn' + (p.source === 'unknown' ? ' chip-ask' : '')} onClick={() => setSheet({ kind: 'source' })}>
            {SOURCE_LABEL[p.source]} ▾
          </button>
          {due && <span className="chip chip-due">{due}</span>}
        </div>
        <dl className="facts">
          {p.brand && <><dt>Brand</dt><dd>{p.brand}</dd></>}
          {p.variant && <><dt>Variant</dt><dd>{p.variant}</dd></>}
          {p.upc && <><dt>Barcode</dt><dd>{p.upc}</dd></>}
          {p.received_at && <><dt>Received</dt><dd>{fmtDate(p.received_at)}</dd></>}
          {p.deadline && <><dt>Deadline</dt><dd>{fmtDate(p.deadline)}</dd></>}
          <dt>Drive folder</dt>
          <dd>{folderUrl ? <a href={folderUrl} target="_blank" rel="noreferrer">{p.drive_folder_name ?? 'Open in Drive'} ↗</a> : <span className="muted">No Drive folder yet</span>}</dd>
        </dl>
      </header>

      {actionError && <p className="error">{actionError}</p>}

      <section>
        <h2>Where it's posted <span className="count">{checklist.filter((c) => c.posted).length}/{checklist.length}</span></h2>
        {checklist.length === 0 ? (
          <p className="empty">No platform planned yet. Add one below.</p>
        ) : (
          <ul className="list">
            {checklist.map((c) => (
              <li key={c.platform}>
                <button className="row row-btn" onClick={() => setSheet({ kind: 'post', platform: c.platform })}>
                  <span className={'box' + (c.posted ? ' box-on' : '')} aria-hidden>{c.posted ? '✓' : ''}</span>
                  <span className="row-main">
                    <span className="row-title">{PLATFORM_LABEL[c.platform]}</span>
                    <span className="row-sub">
                      {c.posted
                        ? c.posts.filter((po) => po.status === 'posted').map((po) =>
                            [fmtDate(po.posted_at), po.views != null ? `${po.views.toLocaleString()} views` : null].filter(Boolean).join(' · ') || 'posted',
                          ).join(' / ')
                        : 'Not posted yet'}
                    </span>
                  </span>
                  <span className="chev" aria-hidden>›</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button className="secondary" onClick={() => setSheet({ kind: 'addPlatform' })}>Add a platform</button>
          {p.status !== 'done' && (
            <button className="secondary" onClick={() => setStatus('done')} disabled={busy}>
              {allPosted ? 'Mark as posted' : 'Mark as posted everywhere'}
            </button>
          )}
        </div>
        {totalViews > 0 && <p className="muted small">{totalViews.toLocaleString()} Amazon views in total</p>}
      </section>

      {deals.length > 0 && (
        <section>
          <h2>Brand deal{deals.length > 1 ? 's' : ''}</h2>
          <ul className="cards">{deals.map((d) => <li key={d.id}><DealCard deal={d} productSource={p.source} /></li>)}</ul>
        </section>
      )}

      <section>
        <h2>Listings <span className="count">{listings.length}</span></h2>
        {listings.length === 0 ? (
          <p className="empty">No platform listings recorded yet.</p>
        ) : (
          <ul className="cards">
            {listings.map((l) => (
              <li key={l.id} className="card">
                <div className="card-title">{PLATFORM_LABEL[l.platform]}</div>
                <div className="card-body">
                  {l.external_id && (
                    <div>{l.url ? <a href={l.url} target="_blank" rel="noreferrer">{l.external_id} ↗</a> : l.external_id}</div>
                  )}
                  <div className="muted small">
                    {AVAILABILITY_LABEL[l.availability]}
                    {l.availability_note ? ` · ${l.availability_note}` : ''}
                    {l.commission ? ` · ${l.commission}` : ''}
                    {l.checked_at ? ` · checked ${fmtDate(l.checked_at)}` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {jobs.length > 0 && (
        <section>
          <h2>Jobs</h2>
          <ul className="cards">
            {jobs.map((j) => (
              <li key={j.id} className="card">
                <div className="card-title">{j.type} <span className="muted small">· {j.status.replace('_', ' ')}</span></div>
                {j.question && <div className="card-body">{j.question}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.notes && (
        <section>
          <h2>Notes</h2>
          <p className="notes">{p.notes}</p>
        </section>
      )}

      <section>
        <h2>Housekeeping</h2>
        <div className="actions">
          <button className="secondary" onClick={() => setSheet({ kind: 'merge' })}>Merge into…</button>
        </div>
        <p className="muted small">Use Merge when the same product exists twice: everything moves to the one you pick and this copy is removed.</p>
      </section>

      {sheet?.kind === 'status' && (
        <Sheet title="Status" onClose={close}>
          <p className="muted small">Where this product is in the flow.</p>
          <Options
            options={STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s], help: STATUS_HELP[s] }))}
            value={p.status}
            onPick={setStatus}
          />
        </Sheet>
      )}

      {sheet?.kind === 'source' && (
        <Sheet title="Where did it come from?" onClose={close}>
          <p className="muted small">The source decides which platforms it must be posted on.</p>
          <Options
            options={SOURCE_ORDER.map((s) => ({ value: s, label: SOURCE_LABEL[s], help: SOURCE_HELP[s] }))}
            value={p.source === 'unknown' ? null : p.source}
            onPick={setSource}
          />
        </Sheet>
      )}

      {sheet?.kind === 'addPlatform' && (
        <Sheet title="Add a platform" onClose={close}>
          <Options
            options={PLATFORM_ORDER.filter((pl) => !checklist.some((c) => c.platform === pl)).map((pl) => ({ value: pl, label: PLATFORM_LABEL[pl] }))}
            value={null}
            onPick={(pl) => setSheet({ kind: 'post', platform: pl })}
          />
        </Sheet>
      )}

      {sheet?.kind === 'post' && (
        <PostSheet
          platform={sheet.platform}
          posts={posts.filter((po) => po.platform === sheet.platform)}
          busy={busy}
          onSave={(url, date, existing) => savePost(sheet.platform, url, date, existing)}
          onRemove={removePost}
          onClose={close}
        />
      )}

      {sheet?.kind === 'merge' && (
        <MergeSheet source={p} busy={busy} onMerge={doMerge} onClose={close} />
      )}
    </main>
  )
}

function PostSheet({ platform, posts, busy, onSave, onRemove, onClose }: {
  platform: Platform
  posts: Post[]
  busy: boolean
  onSave: (url: string, date: string, existing?: Post) => void
  onRemove: (post: Post) => void
  onClose: () => void
}) {
  const appPost = posts.find((po) => po.status === 'posted' && !po.external_id)
  const [url, setUrl] = useState(appPost?.url ?? '')
  const [date, setDate] = useState(appPost?.posted_at ?? today())
  const imported = posts.filter((po) => po.external_id)

  return (
    <Sheet title={`${PLATFORM_LABEL[platform]}`} onClose={onClose}>
      {imported.length > 0 && (
        <ul className="cards">
          {imported.map((po) => (
            <li key={po.id} className="card">
              <div className="card-title">{po.url ? <a href={po.url} target="_blank" rel="noreferrer">{po.title ?? 'Video'} ↗</a> : po.title ?? 'Video'}</div>
              <div className="muted small">
                {po.status === 'posted' ? 'Posted' : 'Planned'}{po.posted_at ? ` ${fmtDate(po.posted_at)}` : ''}
                {po.views != null ? ` · ${po.views.toLocaleString()} views` : ''}
              </div>
              <button className="link small" onClick={() => onRemove(po)} disabled={busy}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          onSave(url.trim(), date, appPost)
        }}
      >
        <label>
          Link to the post <span className="muted">(optional)</span>
          <input type="url" inputMode="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          Posted on
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button className="primary" type="submit" disabled={busy}>
          {appPost ? 'Save' : 'Mark as posted'}
        </button>
        {appPost && (
          <button type="button" className="link" onClick={() => onRemove(appPost)} disabled={busy}>Not posted after all</button>
        )}
      </form>
    </Sheet>
  )
}

function MergeSheet({ source, busy, onMerge, onClose }: {
  source: Product
  busy: boolean
  onMerge: (target: Product, keepName: string) => void
  onClose: () => void
}) {
  const [all, setAll] = useState<Product[] | null>(null)
  const [q, setQ] = useState('')
  const [target, setTarget] = useState<Product | null>(null)
  const [keep, setKeep] = useState<'target' | 'source'>('target')

  useEffect(() => {
    supabase.from('products').select('*').neq('id', source.id).order('name').then(({ data }) => setAll((data ?? []) as Product[]))
  }, [source.id])

  const hits = useMemo(() => {
    if (!all) return []
    const s = q.trim().toLowerCase()
    return (s ? all.filter((p) => p.name.toLowerCase().includes(s) || (p.brand ?? '').toLowerCase().includes(s)) : all).slice(0, 30)
  }, [all, q])

  if (target) {
    const keepName = keep === 'target' ? target.name : source.name
    return (
      <Sheet title="Merge" onClose={onClose}>
        <p>
          Everything on <b>{source.name}</b> (listings, clips, posts, jobs) moves to <b>{target.name}</b>, and this copy is removed.
        </p>
        <p className="muted small">Which name should the merged product keep?</p>
        <Options
          options={[
            { value: 'target' as const, label: target.name, help: `${STATUS_LABEL[target.status]}` },
            { value: 'source' as const, label: source.name, help: `${STATUS_LABEL[source.status]}` },
          ]}
          value={keep}
          onPick={setKeep}
        />
        <div className="actions">
          <button className="primary" onClick={() => onMerge(target, keepName)} disabled={busy}>
            {busy ? 'Merging…' : `Merge into "${keepName}"`}
          </button>
          <button className="link" onClick={() => setTarget(null)} disabled={busy}>Pick a different product</button>
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet title="Merge into…" onClose={onClose}>
      <input
        type="search"
        className="search"
        placeholder="Find the other copy"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
        autoCapitalize="none"
        autoCorrect="off"
      />
      {!all ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="list">
          {hits.map((p) => (
            <li key={p.id}>
              <button className="row row-btn" onClick={() => setTarget(p)}>
                <span className="row-main">
                  <span className="row-title">{p.name}</span>
                  <span className="row-sub">{STATUS_LABEL[p.status]}</span>
                </span>
                <span className="chev" aria-hidden>›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}
