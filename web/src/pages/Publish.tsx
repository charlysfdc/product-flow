import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useProduct } from '../lib/data'
import { supabase } from '../lib/supabase'
import { writePostCopy } from '../lib/functions'
import {
  addPlatform, allFinished, defaultKind, isAmazon, markPosted, publishRows, skipPlatform, unmarkPosted, unskipPlatform,
  TIKTOK_APP_URL, platformList, type PostedInput, type PublishRow,
} from '../lib/publish'
import { PLATFORM_LABEL, PLATFORM_ORDER, type Media, type Platform, type PostCopy } from '../lib/types'
import { Thumb, deadlineText } from '../components/ProductRow'
import { Options, Sheet } from '../components/Sheet'
import { CopyButton, CopyField, SaveVideo } from '../components/PostBits'
import { ProductReminders, ViralVueLink } from '../components/ViralVue'
import { fmtBytes, fmtDuration } from '../lib/upload'

type Kind = 'finished_vertical' | 'finished_horizontal'
const KIND_LABEL: Record<Kind, string> = { finished_vertical: 'Vertical', finished_horizontal: 'Horizontal' }
const today = () => new Date().toISOString().slice(0, 10)
const fmtDay = (d: string | null) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')
const driveFile = (id: string) => `https://drive.google.com/file/d/${id}/view`
const EMPTY_COPY: PostCopy = { amazon_title: '', amazon_description: '', tiktok_caption: '' }

/** Publish: one card per platform with the file, the text to paste, how to post, and the Posted toggle. */
export function Publish() {
  const { id } = useParams()
  const { detail, error, reload } = useProduct(id)
  const navigate = useNavigate()
  const [copy, setCopy] = useState<PostCopy | null>(null)
  const [writing, setWriting] = useState(false)
  const [copyNote, setCopyNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sheet, setSheet] = useState<{ kind: 'details'; row: PublishRow } | { kind: 'add' } | null>(null)
  const [vvTick, setVvTick] = useState(0)
  const [kinds, setKinds] = useState<Partial<Record<Platform, Kind>>>({})
  const close = useCallback(() => setSheet(null), [])

  const product = detail?.product
  // the saved text, once
  useEffect(() => {
    if (product?.post_copy && copy === null) setCopy(product.post_copy)
  }, [product, copy])

  const write = useCallback(async (force: boolean) => {
    if (!id) return
    setWriting(true)
    setCopyNote(null)
    try {
      const r = await writePostCopy(id, force)
      setCopy(r.copy)
      if (r.saved === false) setCopyNote('Written, but not saved yet: the Phase 4 database update is still pending.')
    } catch (e) {
      setCopyNote(`Claude couldn’t write it: ${(e as Error).message}`)
      setCopy((c) => c ?? EMPTY_COPY)
    } finally {
      setWriting(false)
    }
  }, [id])

  const saveCopy = async () => {
    if (!product || !copy) return
    const next = { ...copy, edited_at: new Date().toISOString() }
    const { error } = await supabase.from('products').update({ post_copy: next }).eq('id', product.id)
    setCopyNote(error ? `Not saved: ${error.message}` : null)
  }

  const rows = useMemo(() => (detail ? publishRows(detail.product, detail.listings, detail.posts) : []), [detail])

  /** The finished file of a kind: the approved edit's, else the newest. */
  const mediaOf = useCallback((kind: Kind): Media | null => {
    if (!detail) return null
    const approved = detail.jobs.find((j) => j.type === 'edit' && j.output?.verdict === 'approved')
    const wanted = approved?.output?.media?.[kind]
    const all = detail.media.filter((m) => m.kind === kind && m.drive_file_id)
    return all.find((m) => m.id === wanted) ?? [...all].sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at))[0] ?? null
  }, [detail])

  if (error) return <main><Link to="/" className="back">‹ Home</Link><p className="error">{error}</p></main>
  if (!detail || !product) return <main><Link to="/" className="back">‹ Home</Link><p className="muted">Loading…</p></main>

  const p = product
  const deals = detail.deals
  const asin = detail.listings.find((l) => l.platform === 'amazon_us' && l.external_id)?.external_id ?? deals.find((d) => d.asin)?.asin ?? null
  const hasV = Boolean(mediaOf('finished_vertical')), hasH = Boolean(mediaOf('finished_horizontal'))
  const kindFor = (pl: Platform): Kind => {
    const want = kinds[pl] ?? defaultKind(pl)
    if (want === 'finished_vertical' && !hasV && hasH) return 'finished_horizontal'
    if (want === 'finished_horizontal' && !hasH && hasV) return 'finished_vertical'
    return want
  }
  const c = copy ?? EMPTY_COPY
  const open = rows.filter((r) => r.state === 'open')
  const finished = allFinished(rows)
  const due = p.source === 'tiktok_sample' ? deadlineText(p.deadline) : null
  const totalViews = rows.reduce((n, r) => n + r.views, 0)

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    setActionError(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const post = (rs: PublishRow[], extra: PostedInput = {}) => act(rs.map((r) => r.platform).join(','), async () => {
    const pl = rs[0].platform
    const m = mediaOf(kindFor(pl))
    const title = isAmazon(pl) || pl === 'youtube' || pl === 'pinterest' ? c.amazon_title : c.tiktok_caption.split('\n')[0]
    const r = await markPosted(supabase, p, rs, { title: title || null, media_id: m?.id ?? null, ...extra })
    if (r.done) setNotice(r.reminders ? 'Posted everywhere: the product is Done. Now tick it in ViralVue (below).' : 'Posted everywhere: the product is Done.')
    else if (r.reminders) setNotice('Amazon is posted. Next: tick it in ViralVue (above).')
    if (r.reminders) setVvTick((t) => t + 1)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })

  const amazonRows = rows.filter((r) => isAmazon(r.platform))
  const tiktok = rows.find((r) => r.platform === 'tiktok_shop')
  const others = rows.filter((r) => !isAmazon(r.platform) && r.platform !== 'tiktok_shop')
  // a TikTok Shop deadline goes first
  const tiktokFirst = Boolean(tiktok && due)

  const filePick = (pl: Platform) => {
    const k = kindFor(pl)
    const m = mediaOf(k)
    return (
      <div className="pub-file">
        {hasV && hasH ? (
          <div className="seg2" role="group" aria-label="Which video">
            {(['finished_vertical', 'finished_horizontal'] as Kind[]).map((x) => (
              <button key={x} aria-pressed={k === x} onClick={() => setKinds((s) => ({ ...s, [pl]: x }))}>{KIND_LABEL[x]}</button>
            ))}
          </div>
        ) : null}
        {m
          ? <span className="pub-fname">{m.filename}<small>{[fmtDuration(m.duration_s), m.size_bytes ? fmtBytes(m.size_bytes) : null].filter(Boolean).join(' · ')}</small></span>
          : <span className="pub-fname muted">No finished {KIND_LABEL[k].toLowerCase()} video yet{p.drive_folder_id ? ' (put one in the finished folder, then Sync on the Product screen)' : ''}.</span>}
      </div>
    )
  }

  const line = (r: PublishRow, label = PLATFORM_LABEL[r.platform]) => {
    const isBusy = busy?.split(',').includes(r.platform)
    const postedPost = r.posts.find((po) => po.status === 'posted')
    return (
      <div className={`pl pl-${r.state}`} key={r.platform}>
        <span className={'box' + (r.state === 'posted' ? ' box-on' : '')} aria-hidden>{r.state === 'posted' ? '✓' : r.state === 'skipped' ? '–' : ''}</span>
        <span className="pl-main">
          <b>{label}</b>
          <small>
            {r.state === 'posted'
              ? [`Posted ${fmtDay(postedPost?.posted_at ?? null)}`, r.views ? `${r.views.toLocaleString()} views` : null].filter(Boolean).join(' · ')
              : r.state === 'skipped' ? 'Not posting here' : 'Not posted yet'}
            {postedPost?.url && <> · <a href={postedPost.url} target="_blank" rel="noreferrer">open ↗</a></>}
          </small>
        </span>
        {r.state === 'open'
          ? <button className="pl-btn" disabled={isBusy} onClick={() => post([r])}>{isBusy ? 'Saving…' : 'Posted'}</button>
          : r.state === 'skipped'
          ? <button className="pl-more" disabled={isBusy} onClick={() => act(r.platform, () => unskipPlatform(supabase, p, r))}>Undo</button>
          : null}
        <button className="pl-more" aria-label={`More for ${label}`} onClick={() => setSheet({ kind: 'details', row: r })}>⋯</button>
      </div>
    )
  }

  const amazonCard = amazonRows.length > 0 && (
    <section className="pub" key="amazon">
      <div className="pub-head"><span className="pub-name">Amazon</span><span className="pub-where">ViralVue on the Mac</span></div>
      {filePick('amazon_us')}
      <ol className="pub-steps">
        <li>
          <span>On the Mac, open the video in Drive and download it (or copy the link here; it pastes on the Mac).</span>
          <span className="pub-acts">
            {mediaOf(kindFor('amazon_us'))?.drive_file_id && <>
              <a className="copy-btn" href={driveFile(mediaOf(kindFor('amazon_us'))!.drive_file_id!)} target="_blank" rel="noreferrer">Open in Drive ↗</a>
              <CopyButton text={driveFile(mediaOf(kindFor('amazon_us'))!.drive_file_id!)} label="Copy Drive link" />
            </>}
          </span>
        </li>
        <li>
          <span>In ViralVue, upload it to {amazonRows.map((r) => PLATFORM_LABEL[r.platform].replace('Amazon ', '')).join(', ')} with this title and description.</span>
          <span className="pub-acts"><CopyButton text={c.amazon_title} label="Copy title" /><CopyButton text={c.amazon_description} label="Copy description" /></span>
          {c.amazon_title && <q className="pub-q">{c.amazon_title}</q>}
        </li>
        {deals.length > 0 && (
          <li>
            <span>Add it to the brand deal: search ViralVue for the ASIN{asin ? ` ${asin}` : ''}.</span>
            <span className="pub-acts"><ViralVueLink className="copy-btn" asin={asin} fallback={deals[0]?.brand} /></span>
          </li>
        )}
      </ol>
      <div className="pls">{amazonRows.map((r) => line(r))}</div>
      {amazonRows.filter((r) => r.state === 'open').length > 1 && (
        <button className="primary" disabled={Boolean(busy)} onClick={() => post(amazonRows.filter((r) => r.state === 'open'))}>
          All {amazonRows.filter((r) => r.state === 'open').length} Amazon stores posted
        </button>
      )}
    </section>
  )

  const socialCard = (r: PublishRow) => {
    const tt = r.platform === 'tiktok_shop'
    const titled = r.platform === 'youtube' || r.platform === 'pinterest'
    return (
      <section className="pub" key={r.platform}>
        <div className="pub-head">
          <span className="pub-name">{PLATFORM_LABEL[r.platform]}</span>
          {tt && due && r.state === 'open' ? <span className="chip chip-due chip-sm">{due}</span> : <span className="pub-where">from the phone</span>}
        </div>
        {filePick(r.platform)}
        <ol className="pub-steps">
          <li>
            <span>Copy the {titled ? 'title and caption' : 'caption'}{tt ? ' (it never mentions Amazon)' : ''}.</span>
            <span className="pub-acts">
              {titled && <CopyButton text={c.amazon_title} label="Copy title" />}
              <CopyButton text={c.tiktok_caption} label="Copy caption" />
            </span>
          </li>
          <li>
            <span>Save the video to Photos.</span>
            <SaveVideo productId={p.id} kind={kindFor(r.platform)} />
          </li>
          <li>
            {tt
              ? <span>Open TikTok: + → Upload → the newest video → paste the caption → Add link → Products → this product. Keep the original sound.</span>
              : <span>Open {PLATFORM_LABEL[r.platform]}, post the newest video and paste the {titled ? 'title and caption' : 'caption'}.</span>}
            {tt && <span className="pub-acts"><a className="copy-btn" href={TIKTOK_APP_URL}>Open TikTok ↗</a></span>}
          </li>
        </ol>
        <div className="pls">{line(r)}</div>
      </section>
    )
  }

  const cards = [
    ...(tiktokFirst && tiktok ? [socialCard(tiktok)] : []),
    amazonCard,
    ...(!tiktokFirst && tiktok ? [socialCard(tiktok)] : []),
    ...others.map(socialCard),
  ]

  return (
    <main>
      <div className="pn">
        {/* back to wherever this screen was opened from; the Product screen when it was opened directly */}
        <button className="bk bk-btn" aria-label="Back" onClick={() => ((window.history.state?.idx ?? 0) > 0 ? navigate(-1) : navigate(`/product/${p.id}`))}>‹</button>
        <Link to={`/product/${p.id}`} className="pn-link">
          <Thumb src={p.product_image_url} name={p.name} />
          <div style={{ minWidth: 0 }}>
            <h1>{p.name}</h1>
            <small>Post it · {rows.filter((r) => r.state === 'posted').length}/{rows.length} posted{totalViews ? ` · ${totalViews.toLocaleString()} views` : ''}</small>
          </div>
        </Link>
        <Link to={`/product/${p.id}`} className="pn-details">Product details ›</Link>
      </div>

      {notice && <div className="notice"><span>{notice}</span><button onClick={() => setNotice(null)}>OK</button></div>}
      {actionError && <p className="error">{actionError}</p>}

      <section className="next">
        <span className="eyebrow">{finished ? 'All done' : 'Post'}</span>
        <h2>{finished ? 'Posted everywhere' : rows.length === 0 ? 'Pick where to post it' : `Post on ${platformList(open.map((r) => r.platform), (pl) => PLATFORM_LABEL[pl])}`}</h2>
        <p>
          {finished ? 'Every planned platform is posted or skipped; the product is Done.'
            : rows.length === 0 ? 'Bought products can go anywhere. Add the platforms you want.'
            : `Each card below has the video, the text to paste and a Posted tick.${due ? ` TikTok Shop: ${due.toLowerCase()}.` : ''}`}
        </p>
        {rows.length === 0 && <button className="pri" onClick={() => setSheet({ kind: 'add' })}>Add a platform</button>}
        {finished && <Link className="pri" to="/">Back to Home</Link>}
      </section>

      <div style={{ marginTop: 14 }}><ProductReminders dealIds={deals.map((d) => d.id)} tick={vvTick} /></div>

      <section className="pub">
        <div className="pub-head">
          <span className="pub-name">Text to paste</span>
          <span className="pub-where">{writing ? 'Claude is writing…' : copy?.generated_at ? 'Written by Claude, yours to edit' : ''}</span>
        </div>
        {!copy ? (
          <>
            <p className="muted small">{writing
              ? 'Claude is reading what was said in the edit and writing the Amazon title, description and TikTok caption…'
              : 'Claude writes the Amazon title and description and a TikTok caption from what was said in the edit. Nothing is written until you tap.'}</p>
            <button className="primary" disabled={writing} onClick={() => write(false)}>{writing ? 'Writing…' : 'Write the text'}</button>
            {!writing && <button className="link" onClick={() => setCopy(EMPTY_COPY)}>Write it myself</button>}
          </>
        ) : (
          <>
            <CopyField label="Amazon title" max={60} value={c.amazon_title} onChange={(v) => setCopy({ ...c, amazon_title: v })} onSave={saveCopy} />
            <CopyField label="Amazon description" rows={4} value={c.amazon_description} onChange={(v) => setCopy({ ...c, amazon_description: v })} onSave={saveCopy} />
            <CopyField label="TikTok caption" rows={4} value={c.tiktok_caption} onChange={(v) => setCopy({ ...c, tiktok_caption: v })} onSave={saveCopy}
              hint={/amazon/i.test(c.tiktok_caption) ? 'Take “Amazon” out: TikTok text never mentions it.' : undefined} />
          </>
        )}
        {copyNote && <p className="cf-hint">{copyNote}</p>}
        {copy && (
          <button className="link" disabled={writing} onClick={() => {
            if (copy.edited_at && !window.confirm('Write it again? Claude replaces the text, including your edits.')) return
            write(true)
          }}>{writing ? 'Writing…' : copy.generated_at ? 'Write it again' : 'Write it with Claude'}</button>
        )}
      </section>

      {cards}

      {rows.length > 0 && (
        <div className="actions">
          <button className="secondary" onClick={() => setSheet({ kind: 'add' })}>Post somewhere else too</button>
          <Link className="secondary link-btn" style={{ padding: '11px 14px' }} to={`/product/${p.id}`}>Product screen</Link>
        </div>
      )}

      {sheet?.kind === 'add' && (
        <Sheet title="Add a platform" onClose={close}>
          <Options
            options={PLATFORM_ORDER.filter((pl) => !rows.some((r) => r.platform === pl)).map((pl) => ({ value: pl, label: PLATFORM_LABEL[pl] }))}
            value={null}
            onPick={(pl) => act(pl, async () => { await addPlatform(supabase, p, pl); close() })}
          />
        </Sheet>
      )}

      {sheet?.kind === 'details' && (
        <DetailsSheet
          row={sheet.row}
          busy={Boolean(busy)}
          onClose={close}
          onSave={(url, date) => { post([sheet.row], { url, date }); close() }}
          onUnpost={() => act(sheet.row.platform, async () => { await unmarkPosted(supabase, p, sheet.row); close() })}
          onSkip={() => act(sheet.row.platform, async () => { if (await skipPlatform(supabase, p, sheet.row)) setNotice('Posted everywhere: the product is Done.'); close() })}
        />
      )}
    </main>
  )
}

function DetailsSheet({ row, busy, onClose, onSave, onUnpost, onSkip }: {
  row: PublishRow
  busy: boolean
  onClose: () => void
  onSave: (url: string, date: string) => void
  onUnpost: () => void
  onSkip: () => void
}) {
  const [url, setUrl] = useState(row.mine?.url ?? '')
  const [date, setDate] = useState(row.mine?.posted_at ?? today())
  const imported = row.posts.filter((po) => po.external_id)
  return (
    <Sheet title={PLATFORM_LABEL[row.platform]} onClose={onClose}>
      {imported.length > 0 && (
        <ul className="cards">
          {imported.map((po) => (
            <li key={po.id} className="card">
              <div className="card-title">{po.url ? <a href={po.url} target="_blank" rel="noreferrer">{po.title ?? 'Video'} ↗</a> : po.title ?? 'Video'}</div>
              <div className="muted small">From the ViralVue export{po.posted_at ? ` · ${fmtDay(po.posted_at)}` : ''}{po.views != null ? ` · ${po.views.toLocaleString()} views` : ''}{po.views_checked_at ? ` (checked ${fmtDay(po.views_checked_at)})` : ''}</div>
            </li>
          ))}
        </ul>
      )}
      <form className="form" onSubmit={(e) => { e.preventDefault(); onSave(url.trim(), date) }}>
        <label>
          Link to the post <span className="muted">(optional)</span>
          <input type="url" inputMode="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          Posted on
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button className="primary" type="submit" disabled={busy}>{row.state === 'posted' ? 'Save' : 'Mark as posted'}</button>
        {row.state === 'posted' && row.mine && <button type="button" className="link" disabled={busy} onClick={onUnpost}>Not posted after all</button>}
        {row.state === 'open' && <button type="button" className="link" disabled={busy} onClick={onSkip}>Not posting here</button>}
      </form>
    </Sheet>
  )
}
