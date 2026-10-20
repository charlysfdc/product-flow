import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { driveStatus, listFolders, setProductsFolder, type DriveStatus, type FolderListing } from '../lib/functions'
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
  const user = session?.user
  return (
    <main>
      <Link to="/housekeeping" className="back">‹ Housekeeping</Link>
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

      <WhoCanSignIn />

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


/** Who can sign in: the Google accounts on allowed_emails (added in the Supabase SQL editor). */
function WhoCanSignIn() {
  const [rows, setRows] = useState<{ email: string; note: string | null }[] | null>(null)
  useEffect(() => {
    supabase.from('allowed_emails').select('email,note').order('created_at').then(({ data }) => setRows((data ?? []) as { email: string; note: string | null }[]))
  }, [])
  return (
    <section>
      <h2>Who can sign in <span className="count">{rows?.length ?? '…'}</span></h2>
      <ul className="list">
        {(rows ?? []).map((r) => (
          <li key={r.email} className="row"><div className="row-main"><div className="row-title">{r.note ?? r.email}</div><div className="row-sub"><span>{r.email}</span></div></div></li>
        ))}
      </ul>
      <p className="muted small" style={{ margin: '6px 4px 0' }}>Only these Google accounts can open Product Flow. Adding someone is done once in the Supabase SQL editor.</p>
    </section>
  )
}
