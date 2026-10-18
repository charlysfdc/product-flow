import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { importDeals, type ImportSummary } from '../lib/deals'
import { driveStatus, type DriveStatus } from '../lib/functions'

export function Settings() {
  const { session, signOut, connectDrive, notice } = useAuth()
  const [drive, setDrive] = useState<DriveStatus | null>(null)
  const [driveError, setDriveError] = useState<string | null>(null)
  useEffect(() => {
    driveStatus().then(setDrive, (e: Error) => setDriveError(e.message))
  }, [notice])
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    setSummary(null)
    try {
      const text = await file.text()
      setSummary(await importDeals(supabase, text, setProgress))
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
        <h2>Google Drive</h2>
        <div className="card">
          <div className="card-title">{drive?.connected ? `Connected${drive.email ? ` as ${drive.email}` : ''}` : drive ? 'Not connected' : driveError ? 'Status unknown' : 'Checking…'}</div>
          <p className="muted small">
            Add product makes a folder in Content Library/Products for each new product and saves the photo of the box there.
            This needs your permission once; Google then asks nothing again.
          </p>
          {driveError && <p className="error small">{driveError}</p>}
          <button className={drive?.connected ? 'secondary' : 'primary'} onClick={connectDrive}>{drive?.connected ? 'Connect again' : 'Connect Google Drive'}</button>
        </div>
      </section>

      <section>
        <h2>Brand deals</h2>
        <div className="card">
          <div className="card-title">Import ViralVue export</div>
          <p className="muted small">
            In ViralVue export the Amazon brand deals as CSV, then pick that file here (from Files on the iPhone or from the Mac).
            Deals you imported before are updated, not duplicated; nothing you set by hand is overwritten.
          </p>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
          <button className="primary" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Importing…' : 'Choose CSV file'}</button>
          {progress && <p className="muted small">{progress}</p>}
          {error && <p className="error">{error}</p>}
          {summary && (
            <div className="summary">
              <p><b>{summary.total}</b> deals in the file: <b>{summary.created}</b> new, <b>{summary.updated}</b> updated, <b>{summary.needsReview.length}</b> need your answer.</p>
              <p className="muted small">
                {summary.matched} linked to a product ({summary.productsCreated.length} products created), {summary.waitingShown} waiting on the brand
                {summary.waitingHidden > 0 ? ` (+${summary.waitingHidden} went quiet)` : ''}, {summary.closed} declined, {summary.postsCreated} Amazon posts recorded.
                {summary.replyRate.messaged > 0 && ` Reply rate: ${summary.replyRate.received} of ${summary.replyRate.messaged} messaged brands sent a product.`}
              </p>
              {summary.needsReview.length > 0 && <p><Link to="/">Answer them on Home</Link></p>}
              {summary.errors.length > 0 && (
                <details><summary className="error">{summary.errors.length} rows failed</summary><ul>{summary.errors.map((e, i) => <li key={i} className="small">{e}</li>)}</ul></details>
              )}
            </div>
          )}
        </div>
      </section>

      <section>
        <h2>About</h2>
        <p className="muted small">Product Flow · data in Supabase, footage in Google Drive.</p>
      </section>
    </main>
  )
}
