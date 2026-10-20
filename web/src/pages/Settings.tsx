import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { importDeals, type ImportSummary } from '../lib/deals'
import { detectExport, importViews, type ViewsSummary } from '../lib/views'
import { driveStatus, listFolders, restoreProduct, setProductsFolder, type DriveStatus, type FolderListing } from '../lib/functions'
import { ARCHIVE_REASON_LABEL, type Product } from '../lib/types'
import { Thumb } from '../components/ProductRow'
import { Sheet } from '../components/Sheet'
import { PhoneSheet } from '../components/Clips'
import { phoneName, setPhoneName } from '../lib/upload'

export function Settings() {
  const { session, signOut, connectDrive, notice } = useAuth()
  const [drive, setDrive] = useState<DriveStatus | null>(null)
  const [driveError, setDriveError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [tick, setTick] = useState(0)
  const [phone, setPhone] = useState(phoneName())
  const [namingPhone, setNamingPhone] = useState(false)
  useEffect(() => {
    driveStatus().then(setDrive, (e: Error) => setDriveError(e.message))
  }, [notice, tick])
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
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const user = session?.user
  return (
    <main>
      <Link to="/" className="back">‹ Home</Link>
      <h1>Settings</h1>

      <section>
        <h2>Signed in</h2>
        <div className="card">
          <div className="card-title">{user?.user_metadata?.full_name ?? user?.email}</div>
          <div className="muted small">{user?.email}</div>
          <button className="link" onClick={signOut}>Sign out</button>
        </div>
      </section>

      <section>
        <h2>This phone</h2>
        <div className="card">
          <div className="card-title">{phone ? `This phone is: ${phone}` : 'This phone has no name yet'}</div>
          <p className="muted small">Clips uploaded from here are marked with this name, so you can tell which iPhone filmed them. Saved on this phone only.</p>
          <button className="secondary" onClick={() => setNamingPhone(true)}>{phone ? 'Change the name' : 'Name this phone'}</button>
        </div>
      </section>

      {namingPhone && (
        <PhoneSheet
          intro="Pick or type a name for the phone you are holding."
          onClose={() => setNamingPhone(false)}
          onPick={(name) => { setPhoneName(name); setPhone(name); setNamingPhone(false) }}
        />
      )}

      <section>
        <h2>Google Drive</h2>
        <div className="card">
          <div className="card-title">{drive?.connected ? `Connected${drive.email ? ` as ${drive.email}` : ''}` : drive ? 'Not connected' : driveError ? 'Status unknown' : 'Checking…'}</div>
          <p className="muted small">
            Add product makes a folder in Content Library/Products for each new product and saves the photo of the box there; Upload clips puts videos in its raw folder.
            This needs your permission once; Google then asks nothing again.
          </p>
          {driveError && <p className="error small">{driveError}</p>}
          {drive?.connected && !drive.products_folder_id && (
            <p className="flag">Your Content Library was not found. Pick the Products folder that holds your product folders, so new ones go next to them.</p>
          )}
          {drive?.connected && (
            <button className="secondary" style={{ marginBottom: 8 }} onClick={() => setPicking(true)}>
              {drive.products_folder_id ? 'Change the Products folder' : 'Pick the Products folder'}
            </button>
          )}
          <button className={drive?.connected ? 'secondary' : 'primary'} onClick={connectDrive}>{drive?.connected ? 'Connect again' : 'Connect Google Drive'}</button>
        </div>
      </section>

      {picking && <FolderPicker onClose={() => setPicking(false)} onPicked={() => { setPicking(false); setTick((t) => t + 1) }} />}

      <section>
        <h2>ViralVue</h2>
        <div className="card">
          <div className="card-title">Import ViralVue export</div>
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
              {summary.needsReview.length > 0 && <p><Link to="/">Answer them on Home</Link></p>}
              {summary.errors.length > 0 && (
                <details><summary className="error">{summary.errors.length} rows failed</summary><ul>{summary.errors.map((e, i) => <li key={i} className="small">{e}</li>)}</ul></details>
              )}
            </div>
          )}
        </div>
      </section>

      <HiddenProducts />

      <section>
        <h2>About</h2>
        <p className="muted small">Product Flow · data in Supabase, footage in Google Drive.</p>
      </section>
    </main>
  )
}

/** Browse Drive folders from My Drive and choose the one that holds the product folders. */
function FolderPicker({ onClose, onPicked }: { onClose: () => void; onPicked: () => void }) {
  const [at, setAt] = useState('root')
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    listFolders(at).then((l) => !cancelled && setListing(l), (e: Error) => !cancelled && setError(e.message))
    return () => { cancelled = true }
  }, [at])
  const open = (id: string) => { setListing(null); setError(null); setAt(id) }
  const choose = async () => {
    if (!listing) return
    setBusy(true)
    try {
      await setProductsFolder(listing.folder.id)
      onPicked()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title="Pick the Products folder" onClose={onClose}>
      <p className="muted small">Open My Drive → Content Library → Products, then tap Use this folder.</p>
      {listing && <p><b>{listing.folder.name}</b></p>}
      {error && <p className="error small">{error}</p>}
      {!listing && !error && <p className="muted">Loading…</p>}
      {listing && (
        <ul className="list">
          {listing.folder.parent && at !== 'root' && (
            <li><button className="row row-btn" onClick={() => open(listing.folder.parent!)}><span className="row-main"><span className="row-title">‹ Up</span></span></button></li>
          )}
          {listing.folders.slice(0, 60).map((f) => (
            <li key={f.id}>
              <button className="row row-btn" onClick={() => open(f.id)}>
                <span className="row-main"><span className="row-title">{f.name}</span></span>
                <span className="chev" aria-hidden>›</span>
              </button>
            </li>
          ))}
          {listing.folders.length > 60 && <li className="row muted small">{listing.folders.length - 60} more folders…</li>}
        </ul>
      )}
      <div className="actions">
        <button className="primary" disabled={!listing || at === 'root' || busy} onClick={choose}>
          {busy ? 'Saving…' : listing && at !== 'root' ? `Use “${listing.folder.name}”` : 'Use this folder'}
        </button>
      </div>
    </Sheet>
  )
}

/** Settings > Hidden: products taken out of the flow (Not a product review), with Restore. */
function HiddenProducts() {
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
    <section>
      <h2>Hidden <span className="count">{items?.length ?? '…'}</span></h2>
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
    </section>
  )
}
