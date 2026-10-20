import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useProduct } from '../lib/data'
import { supabase } from '../lib/supabase'
import { mergeProducts } from '../lib/merge'
import {
  AVAILABILITY_LABEL, PLATFORM_LABEL, PLATFORM_ORDER, SOURCE_HELP, SOURCE_LABEL, SOURCE_ORDER,
  ARCHIVE_REASON_LABEL, STATUS_HELP, STATUS_LABEL, STATUS_ORDER, driveFolderUrl,
  type Platform, type Post, type Product, type ProductSource, type ProductStatus,
} from '../lib/types'
import { Thumb, deadlineText } from '../components/ProductRow'
import { archiveProduct, makeDriveFolder, restoreProduct, syncFromDrive } from '../lib/functions'
import { ClipList, ORIGINAL_TIP, UploadButton, UploadPanel } from '../components/Clips'
import { useUploads } from '../lib/upload'
import { Options, Sheet } from '../components/Sheet'
import { DealCard } from '../components/DealCard'
import { EditSheet, EditStatus, latestEdit } from '../components/Edit'
import { unlinkDeal } from '../lib/deals'
import { markPosted, platformList, publishRows } from '../lib/publish'
import { ProductReminders } from '../components/ViralVue'
import { StageBar } from '../components/Stages'
import type { Deal } from '../lib/types'

function fmtDate(d: string | null) {
  if (!d) return null
  return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
const fmtShort = (d: string | null) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null)
const today = () => new Date().toISOString().slice(0, 10)

// Sync from Drive runs by itself when a product opens, at most this often per product.
const AUTO_SYNC_MS = 10 * 60 * 1000
function syncedRecently(id: string): boolean {
  try {
    const at = JSON.parse(localStorage.getItem('pf.synced') ?? '{}') as Record<string, number>
    if (Date.now() - (at[id] ?? 0) < AUTO_SYNC_MS) return true
    at[id] = Date.now()
    localStorage.setItem('pf.synced', JSON.stringify(at))
  } catch { /* storage blocked: sync anyway */ }
  return false
}

type SheetKind =
  | { kind: 'status' }
  | { kind: 'source' }
  | { kind: 'post'; platform: Platform }
  | { kind: 'addPlatform' }
  | { kind: 'merge' }
  | { kind: 'unlink'; deal: Deal }
  | { kind: 'edit' }
  | { kind: 'hide' }
  | { kind: 'film' }
  | null

export function ProductPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { detail, error, reload } = useProduct(id)
  // Home's Edit button opens this screen with the Edit sheet up
  const [sheet, setSheet] = useState<SheetKind>(() => ((location.state as { edit?: boolean } | null)?.edit ? { kind: 'edit' } : null))
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(() => (location.state as { notice?: string } | null)?.notice ?? null)
  const close = useCallback(() => setSheet(null), [])
  const [syncing, setSyncing] = useState(false)
  const [syncNote, setSyncNote] = useState<string | null>(null)

  // reload when one of this product's uploads lands
  const uploads = useUploads()
  const landed = uploads.filter((u) => u.productId === id && u.state === 'done').length
  useEffect(() => { if (landed) reload() }, [landed, reload])

  const sync = useCallback(async (manual: boolean) => {
    if (!id) return
    setSyncing(true)
    if (manual) setSyncNote(null)
    try {
      const r = await syncFromDrive(id)
      if (r.added || r.status_changed) reload()
      if (manual || r.added) {
        setSyncNote(r.note ?? (r.added
          ? `Found ${r.added} new file${r.added === 1 ? '' : 's'} in Drive.`
          : `Nothing new: ${r.raw} clip${r.raw === 1 ? '' : 's'} in raw, ${r.finished} in finished.`))
      }
    } catch (e) {
      if (manual) setSyncNote(`Sync failed: ${(e as Error).message}`)
    } finally {
      setSyncing(false)
    }
  }, [id, reload])

  const folderId = detail?.product.drive_folder_id
  useEffect(() => {
    if (id && folderId && !syncedRecently(id)) sync(false)
  }, [id, folderId, sync])

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

  const checklistRows = useMemo(() => (detail ? publishRows(detail.product, detail.listings, detail.posts) : []), [detail])
  const checklist = useMemo(() => {
    return checklistRows
      .map((r) => ({ platform: r.platform, posts: r.posts, posted: r.state !== 'open', skipped: r.state === 'skipped' }))
  }, [checklistRows])

  if (error) return <main><Link to="/" className="back">‹ Home</Link><p className="error">{error}</p></main>
  if (!detail) return <main><Link to="/" className="back">‹ Home</Link><p className="muted">Loading…</p></main>

  const { product: p, listings, posts, jobs, deals, media } = detail
  const due = deadlineText(p.deadline)
  const totalViews = posts.reduce((n, po) => n + (po.views ?? 0), 0)
  // only a real folder id: products without one get the Make Drive folder button
  const folderUrl = p.drive_folder_id ? driveFolderUrl({ drive_folder_id: p.drive_folder_id }) : null
  const allPosted = checklist.length > 0 && checklist.every((c) => c.posted)

  const setStatus = (status: ProductStatus) =>
    run('Changing status', async () => {
      const patch: Partial<Product> = { status }
      if (status === 'received' && !p.received_at) patch.received_at = today()
      const { error } = await supabase.from('products').update(patch).eq('id', p.id)
      if (error) throw error
      close()
    })

  const setSource = (source: ProductSource) =>
    run('Changing source', async () => {
      const { error } = await supabase.from('products').update({ source }).eq('id', p.id)
      if (error) throw error
      close()
    })

  const savePost = (platform: Platform, url: string, date: string, existing?: Post) =>
    run('Saving post', async () => {
      // same path as the Publish screen: Amazon posts also add the ViralVue "Video published" tick
      const row = checklistRows.find((r) => r.platform === platform) ?? { platform, state: 'open' as const, posts: [], mine: null, views: 0 }
      await markPosted(supabase, p, [{ ...row, mine: existing ?? row.mine }], { url, date })
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

  const makeFolder = () =>
    run('Making the Drive folder', async () => {
      await makeDriveFolder(p.id)
    })

  const statusAt = STATUS_ORDER.indexOf(p.status)
  const reached = (s: ProductStatus) => statusAt >= STATUS_ORDER.indexOf(s)
  const unposted = checklist.filter((c) => !c.posted)
  const plannedAmazon = unposted.some((c) => c.platform.startsWith('amazon'))
  const messaged = deals.find((d) => d.message_sent_at)
  const intake = media.filter((m) => m.kind === 'intake_photo')
  const clips = media.filter((m) => m.kind === 'raw_clip')
  const finished = media.filter((m) => m.kind === 'finished_vertical' || m.kind === 'finished_horizontal')
  const edit = latestEdit(jobs)
  const openEdit = () => setSheet({ kind: 'edit' })
  const editButton = clips.length || p.drive_folder_id
    ? <button className="pri" onClick={openEdit}>Edit</button>
    : folderLinkFallback()
  function folderLinkFallback() {
    return folderUrl
      ? <a className="pri" href={folderUrl} target="_blank" rel="noreferrer">Open raw clips ↗</a>
      : <button className="pri" disabled={busy} onClick={makeFolder}>{busy ? 'Making the folder…' : 'Make the Drive folder'}</button>
  }

  // One next step, from the status. Each has one main button and one smaller action.
  const next: { eyebrow: string; title: string; body: string; main: React.ReactNode; subLabel?: string; sub?: React.ReactNode; moreLabel?: string; more?: React.ReactNode } = (() => {
    const deadline = due ? ` ${p.source === 'tiktok_sample' ? 'TikTok Shop deadline' : 'Deadline'}: ${due.toLowerCase()}.` : ''
    switch (p.status) {
      case 'expected':
        return { eyebrow: 'Next step', title: 'Wait for it to arrive', body: `Tap when the box is here.${deadline}`,
          main: <button className="pri" disabled={busy} onClick={() => setStatus('received')}>It arrived</button> }
      case 'received':
        return { eyebrow: 'Next step', title: 'Film it', body: `Then upload the clips from Photos; they go straight into the raw folder in Drive.${deadline}`,
          main: <><UploadButton product={p} className="pri" /><p className="tip">{ORIGINAL_TIP}</p></>,
          subLabel: 'Clips already in Drive?', sub: <button disabled={syncing} onClick={() => sync(true)}>{syncing ? 'Looking…' : 'Sync from Drive ›'}</button> }
      case 'filmed':
        return { eyebrow: 'Next step', title: plannedAmazon ? 'Edit it and upload to Amazon' : 'Edit it',
          body: edit?.status === 'failed'
            ? `The last edit didn't finish.${deadline}`
            : `${clips.length ? `${clips.length} raw clip${clips.length === 1 ? ' is' : 's are'}` : 'Raw clips are'} in Drive. Edit makes a vertical cut, a horizontal review and a thumbnail.${deadline}`,
          main: edit?.status === 'failed' ? <EditStatus job={edit} onEdit={openEdit} /> : editButton,
          moreLabel: 'More to film?', more: <UploadButton product={p} label="Upload more clips ›" />,
          subLabel: 'Already edited?', sub: <button disabled={busy} onClick={() => setStatus('ready')}>Mark as edited ›</button> }
      case 'editing': {
        const review = edit?.status === 'needs_review'
        return { eyebrow: review ? 'Ready to review' : 'Being edited',
          title: review ? 'Review the edit' : edit?.status === 'failed' ? 'The edit stopped' : 'Editing',
          body: review
            ? `${edit?.question ?? 'A vertical cut, a horizontal review and a thumbnail are in finished.'}${deadline}`
            : edit ? `You can leave this screen; it carries on in the cloud.${deadline}` : `Raw clips are in Drive.${deadline}`,
          main: edit ? <EditStatus job={edit} onEdit={openEdit} /> : editButton,
          subLabel: 'Already edited?', sub: <button disabled={busy} onClick={() => setStatus('ready')}>Mark as edited ›</button> }
      }
      case 'ready':
        return unposted.length
          ? { eyebrow: 'Next step', title: `Post it on ${platformList(unposted.map((c) => c.platform), (pl) => PLATFORM_LABEL[pl])}`, body: `Text to paste, the video and a Posted tick per platform.${deadline}`,
              main: <Link className="pri" to={`/publish/${p.id}`}>Post it</Link>,
              subLabel: 'Finished video', sub: folderUrl ? <a href={folderUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit', fontWeight: 700 }}>Open in Drive ↗</a> : undefined }
          : { eyebrow: 'Next step', title: 'Pick where to post it', body: 'No platform is planned yet.',
              main: <Link className="pri" to={`/publish/${p.id}`}>Pick platforms</Link> }
      case 'done':
        return { eyebrow: 'All done', title: 'Posted everywhere', body: totalViews > 0 ? `${totalViews.toLocaleString()} Amazon views so far.` : 'Every planned platform has a post.',
          main: <Link className="pri" to={`/publish/${p.id}`}>Post somewhere else too</Link> }
    }
  })()

  type Step = { key: string; label: string; detail?: string | null; when?: string | null; ok: boolean; onTap?: () => void }
  const steps: Step[] = [
    ...(messaged ? [{ key: 'msg', label: `Messaged ${messaged.brand ?? 'the brand'}`, detail: 'through ViralVue', when: fmtShort(messaged.message_sent_at), ok: true }] : []),
    { key: 'arrived', label: p.status === 'expected' ? 'Arrives' : 'Arrived', detail: SOURCE_LABEL[p.source] === SOURCE_LABEL.unknown ? null : SOURCE_LABEL[p.source], when: fmtShort(p.received_at), ok: reached('received'), onTap: () => setSheet({ kind: 'status' }) },
    { key: 'filmed', label: 'Filmed', detail: reached('filmed') ? null : 'Clips go in /raw', ok: reached('filmed'), onTap: () => setSheet({ kind: 'status' }) },
    { key: 'edited', label: 'Edited', detail: reached('ready') ? null : 'Finished video goes in /finished', ok: reached('ready'), onTap: () => setSheet({ kind: 'status' }) },
    ...checklist.map((c) => {
      const done = c.posts.filter((po) => po.status === 'posted')
      const views = done.reduce((n, po) => n + (po.views ?? 0), 0)
      return {
        key: c.platform, label: `Posted on ${PLATFORM_LABEL[c.platform]}`, ok: c.posted,
        detail: c.skipped ? 'Not posting here' : c.posted ? (views ? `${views.toLocaleString()} views` : null) : 'Not posted yet',
        when: c.posted ? fmtShort(done[0]?.posted_at ?? null) : null,
        onTap: () => setSheet({ kind: 'post', platform: c.platform }),
      }
    }),
  ]
  const nowIndex = steps.findIndex((s) => !s.ok)

  return (
    <main>
      <div className="pn">
        <Link to="/" className="bk" aria-label="Home">‹</Link>
        <Thumb src={p.product_image_url} name={p.name} />
        <div style={{ minWidth: 0 }}>
          <h1>{p.name}</h1>
          <small>{[p.brand, p.variant].filter(Boolean).join(' · ') || STATUS_LABEL[p.status]}</small>
        </div>
      </div>

      <StageBar
        product={p}
        jobs={jobs}
        clips={clips.length}
        posted={{ done: checklist.filter((c) => c.posted).length, of: checklist.length }}
        onFilm={() => setSheet({ kind: 'film' })}
        onEdit={() => {
          const busyJob = jobs.find((j) => j.type === 'edit' && (j.status === 'queued' || j.status === 'running'))
          const waiting = jobs.find((j) => j.type === 'edit' && j.status === 'needs_review')
          if (busyJob) window.scrollTo({ top: 0, behavior: 'smooth' })   // its progress is in the Next step card
          else if (waiting) navigate(`/review/${waiting.id}`)
          else openEdit()
        }}
      />

      {actionError && <p className="error">{actionError}</p>}

      {p.archived_at && (
        <div className="vv">
          <span className="eyebrow">Hidden</span>
          <b className="vv-title">{ARCHIVE_REASON_LABEL[p.archived_reason ?? ''] ?? 'Hidden from the flow'}</b>
          <p>Left out of Home, Post, search and the ViralVue reminders{p.archived_move?.moved?.length ? `; its footage was moved to AiA Life` : ''}.{p.archived_move?.note ? ` ${p.archived_move.note}` : ''}</p>
          <div className="go">
            <button className="pri" disabled={busy} onClick={() => run('Restore', async () => {
              const r = await restoreProduct(p.id)
              setActionError(r.note ? `Restored. ${r.note}` : r.moved_back ? 'Restored; the footage is back in Products.' : null)
            })}>{busy ? 'Restoring…' : 'Restore'}</button>
          </div>
        </div>
      )}

      <section className="next">
        <span className="eyebrow">{next.eyebrow}</span>
        <h2>{next.title}</h2>
        <p>{next.body}</p>
        {next.main}
        {next.more && <div className="sub"><span>{next.moreLabel}</span>{next.more}</div>}
        {(next.subLabel || next.sub) && <div className="sub"><span>{next.subLabel}</span>{next.sub}</div>}
        {p.status === 'received' && syncNote && <p>{syncNote}</p>}
      </section>

      <div style={{ marginTop: 14 }}><ProductReminders dealIds={deals.map((d) => d.id)} /></div>

      <UploadPanel productId={p.id} />

      <div className="chips">
        <button className={`chip chip-btn status-${p.status}`} onClick={() => setSheet({ kind: 'status' })}>{STATUS_LABEL[p.status]} ▾</button>
        <button className={'chip chip-btn' + (p.source === 'unknown' ? ' chip-ask' : '')} onClick={() => setSheet({ kind: 'source' })}>{SOURCE_LABEL[p.source]} ▾</button>
        {due && <span className="chip chip-due">{due}</span>}
        {totalViews > 0 && <span className="chip">{totalViews.toLocaleString()} views</span>}
        {folderUrl
          ? <a className="chip" href={folderUrl} target="_blank" rel="noreferrer">{p.drive_folder_name ?? 'Drive folder'} ↗</a>
          : <button className="chip chip-btn" disabled={busy} onClick={makeFolder}>Make Drive folder</button>}
        {(p.extra_drive_folders ?? []).map((f, i) => (
          <a key={i} className="chip" href={driveFolderUrl(f) ?? '#'} target="_blank" rel="noreferrer">{f.name ?? 'Second folder'} ↗</a>
        ))}
      </div>

      <section className="tl">
        <h2>So far <span className="count">{checklist.filter((c) => c.posted).length}/{checklist.length} posted</span></h2>
        {steps.map((s, i) => (
          <button key={s.key} className="st" onClick={s.onTap}>
            <span className={'dot' + (s.ok ? ' dot-ok' : i === nowIndex ? ' dot-now' : '')} aria-hidden>{s.ok ? '✓' : ''}</span>
            <span><b>{s.label}</b>{s.detail && <small>{s.detail}</small>}</span>
            <span className="w">{s.when ?? ''}</span>
          </button>
        ))}
        <div className="actions">
          {(p.status === 'ready' || p.status === 'done') && <Link className="secondary link-btn" style={{ padding: '11px 14px' }} to={`/publish/${p.id}`}>Publish screen</Link>}
          <button className="secondary" onClick={() => setSheet({ kind: 'addPlatform' })}>Add a platform</button>
          {p.status !== 'done' && checklist.length > 0 && (
            <button className="secondary" onClick={() => setStatus('done')} disabled={busy}>
              {allPosted ? 'Mark as done' : 'Posted everywhere'}
            </button>
          )}
        </div>
      </section>

      <section>
        <h2>Clips <span className="count">{clips.length}</span></h2>
        <ClipList media={clips} empty={p.status === 'received' || p.status === 'expected' ? 'Nothing filmed yet.' : 'No clips recorded in the app. If they are in Drive, tap Sync from Drive.'} />
        <div className="actions">
          <UploadButton product={p} className="secondary" label={clips.length ? 'Upload more clips' : 'Upload clips'} />
          <button className="secondary" disabled={syncing} onClick={() => sync(true)}>{syncing ? 'Looking in Drive…' : 'Sync from Drive'}</button>
          {clips.length > 0 && (p.status === 'ready' || p.status === 'done') && (
            edit && (edit.status === 'queued' || edit.status === 'running')
              ? <span className="muted small" style={{ alignSelf: 'center' }}>Editing · {edit.output?.progress?.pct ?? 0}%</span>
              : edit?.status === 'needs_review'
              ? <Link className="secondary link-btn" to={`/review/${edit.id}`} style={{ padding: '11px 14px' }}>Review the edit</Link>
              : <button className="secondary" onClick={openEdit}>Make an edit</button>
          )}
        </div>
        {p.status !== 'received' && syncNote && <p className="sync-note">{syncNote}</p>}
        {p.status !== 'received' && <p className="tip">{ORIGINAL_TIP}</p>}
      </section>

      {finished.length > 0 && (
        <section>
          <h2>Finished videos <span className="count">{finished.length}</span></h2>
          <ClipList media={finished} empty="" />
        </section>
      )}

      {(p.product_image_url || intake.length > 0) && (
        <section>
          <h2>Photos</h2>
          {p.product_image_url && <img src={p.product_image_url} alt="" className="product-img" />}
          {intake.length > 0 && (
            <ul className="list">
              {intake.map((m) => (
                <li key={m.id}>
                  <a className="row" href={m.drive_file_id ? `https://drive.google.com/file/d/${m.drive_file_id}/view` : '#'} target="_blank" rel="noreferrer">
                    <span className="row-main"><span className="row-title">Photo of the box</span><span className="row-sub">{fmtDate(m.uploaded_at.slice(0, 10))} · in Drive</span></span>
                    <span className="chev" aria-hidden>↗</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {deals.length > 0 && (
        <section>
          <h2>Brand deal{deals.length > 1 ? 's' : ''}</h2>
          <ul className="cards">
            {deals.map((d) => (
              <li key={d.id}>
                <DealCard deal={d} productSource={p.source} productName={p.name}>
                  <div className="actions"><Link to={`/deal/${d.id}`} className="link-btn">Open deal</Link><button className="link" onClick={() => setSheet({ kind: 'unlink', deal: d })}>Unlink (wrong product)</button></div>
                </DealCard>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Details</h2>
        <div className="card">
          <dl className="facts">
            {p.brand && <><dt>Brand</dt><dd>{p.brand}</dd></>}
            {p.variant && <><dt>Variant</dt><dd>{p.variant}</dd></>}
            {p.upc && <><dt>Barcode</dt><dd>{p.upc}</dd></>}
            {p.received_at && <><dt>Received</dt><dd>{fmtDate(p.received_at)}</dd></>}
            {p.deadline && <><dt>Deadline</dt><dd>{fmtDate(p.deadline)}</dd></>}
            <dt>Status</dt><dd>{STATUS_HELP[p.status]}</dd>
          </dl>
        </div>
      </section>

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
                <div className="card-title">{j.type === 'edit' ? 'Edit' : j.type} <span className="muted small">· {j.output?.verdict === 'redo' ? 'redone' : j.output?.verdict === 'approved' ? 'approved' : j.status.replace('_', ' ')} · {fmtShort(j.created_at)}</span></div>
                {j.question && <div className="card-body">{j.question}</div>}
                {j.type === 'edit' && j.output?.redo_note && <div className="card-body muted small">Redo note: {j.output.redo_note}</div>}
                {j.type === 'edit' && j.output?.cost && <div className="muted small">{Math.round(j.output.cost.cpu_seconds / 60 * 10) / 10} min · about ${j.output.cost.total_usd.toFixed(2)}</div>}
                {j.type === 'edit' && (j.status === 'needs_review' || (j.status === 'done' && j.output?.verdict === 'approved')) && <Link to={`/review/${j.id}`} className="link-btn">{j.status === 'needs_review' ? 'Review' : 'See the edit'}</Link>}
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
          {!p.archived_at && <button className="secondary" onClick={() => setSheet({ kind: 'hide' })}>Not a product review</button>}
        </div>
        <p className="muted small" style={{ margin: '0 4px' }}>Use Merge when the same product exists twice: everything moves to the one you pick and this copy is removed.</p>
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

      {sheet?.kind === 'unlink' && (
        <Sheet title="Unlink this deal?" onClose={close}>
          <p>
            {sheet.deal.link_added?.created_product
              ? <>This product was created from the deal and will be removed; the deal goes back to the list.</>
              : <>Only what the link added is removed (its ASIN listing, post and the fields it filled). Nothing set earlier is touched.</>}
          </p>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => run('Unlink', async () => {
              const created = sheet.deal.link_added?.created_product
              await unlinkDeal(supabase, sheet.deal)
              close()
              if (created) navigate('/', { replace: true })
            })}>Unlink</button>
            <button className="link" onClick={close}>Cancel</button>
          </div>
        </Sheet>
      )}

      {sheet?.kind === 'edit' && (
        <EditSheet
          productId={p.id}
          clips={clips}
          mode={p.status === 'ready' ? 'again' : p.status === 'done' ? 'extra' : 'first'}
          onClose={close}
          onStarted={(_job, warning) => { close(); if (warning) setActionError(warning); reload() }}
        />
      )}

      {sheet?.kind === 'film' && (
        <Sheet title="Film" onClose={close}>
          <p className="muted small">
            {clips.length ? `${clips.length} clip${clips.length === 1 ? '' : 's'} in the raw folder. ` : 'Nothing filmed yet. '}
            Upload more from Photos, or record clips dropped into Drive by hand. {p.status === 'received' || p.status === 'expected' ? 'The product moves to Filmed once a clip is in.' : 'This doesn’t change the status.'}
          </p>
          <div className="actions">
            <UploadButton product={p} className="primary" label={clips.length ? 'Upload more clips' : 'Upload clips'} onStarted={close} />
            <button className="secondary" disabled={syncing} onClick={() => sync(true)}>{syncing ? 'Looking in Drive…' : 'Sync from Drive'}</button>
          </div>
          {syncNote && <p className="sync-note">{syncNote}</p>}
          <p className="tip">{ORIGINAL_TIP}</p>
        </Sheet>
      )}

      {sheet?.kind === 'hide' && (
        <HideSheet
          product={p}
          busy={busy}
          onClose={close}
          onHide={(move) => run('Hiding', async () => {
            const r = await archiveProduct(p.id, move)
            close()
            navigate('/', { replace: true, state: { notice: `${p.name} is hidden.${r.moved ? ` Footage moved to AiA Life (${r.moved} folder${r.moved === 1 ? '' : 's'}).` : ''}${r.note ? ` ${r.note}` : ''}` } })
          })}
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

function HideSheet({ product, busy, onHide, onClose }: { product: Product; busy: boolean; onHide: (move: boolean) => void; onClose: () => void }) {
  const folders = (product.drive_folder_id ? 1 : 0) + (product.extra_drive_folders ?? []).filter((f) => f.id).length
  const [move, setMove] = useState(folders > 0)
  return (
    <Sheet title="Not a product review?" onClose={onClose}>
      <p><b>{product.name}</b> leaves Home, Post, Due soon, the counts and search, and its ViralVue reminders stop showing. Nothing is deleted; Settings → Hidden can restore it.</p>
      <label className="toggle">
        <input type="checkbox" checked={move} disabled={!folders} onChange={(e) => setMove(e.target.checked)} />
        <span>Also move the footage to AiA Life{folders > 1 ? ` (${folders} folders)` : ''}{!folders ? ' (no Drive folder)' : ''}</span>
      </label>
      <p className="muted small">The folder goes from Content Library/Products to Content Library/AiA Life. If there's no AiA Life folder there, the footage stays put.</p>
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => onHide(move)}>{busy ? 'Hiding…' : 'Hide it'}</button>
        <button className="link" onClick={onClose}>Cancel</button>
      </div>
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
