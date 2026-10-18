import { useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Sheet } from './Sheet'
import type { Media } from '../lib/types'
import {
  CODEC_LABEL, addUploads, clearUploads, fmtBytes, fmtDuration, isActive, phoneName, retryUpload,
  setPhoneName, useUploads, wakeLockSupported, type UploadItem,
} from '../lib/upload'

/** One line under every Upload clips button: how to make the iPhone send the original file. */
export const ORIGINAL_TIP = 'For full quality: in the photo picker tap Options, then under Format pick Current.'

export const PHONE_SUGGESTIONS = ['Charly’s iPhone', 'Zanje’s iPhone']

/**
 * "Upload clips": opens the photo picker for several videos and queues them for
 * the product's raw folder. Asks once which phone this is (saved on this phone).
 */
export function UploadButton({ product, className, label = 'Upload clips', onStarted, disabled }: {
  product: { id: string; name: string }
  className?: string
  label?: string
  onStarted?: () => void
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [picked, setPicked] = useState<File[] | null>(null)
  const start = (files: File[]) => {
    addUploads(product, files)
    setPicked(null)
    onStarted?.()
  }
  return (
    <>
      <button className={className} disabled={disabled} onClick={() => input.current?.click()}>{label}</button>
      <input
        ref={input}
        type="file"
        accept="video/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (!files.length) return
          if (phoneName()) start(files)
          else setPicked(files)
        }}
      />
      {picked && (
        <PhoneSheet
          intro={`${picked.length} clip${picked.length === 1 ? '' : 's'} picked. Which phone is this? Asked once; each clip then says which phone filmed it.`}
          onClose={() => start(picked)}
          onPick={(name) => { setPhoneName(name); start(picked) }}
        />
      )}
    </>
  )
}

export function PhoneSheet({ intro, onPick, onClose }: { intro: string; onPick: (name: string) => void; onClose: () => void }) {
  const [custom, setCustom] = useState(phoneName())
  return (
    <Sheet title="This phone is…" onClose={onClose}>
      <p className="muted small">{intro}</p>
      <ul className="options">
        {PHONE_SUGGESTIONS.map((n) => (
          <li key={n}><button className="option" onClick={() => onPick(n)}><span className="option-label">{n}</span></button></li>
        ))}
      </ul>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) onPick(custom.trim()) }}>
        <label>Another name<input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. Charly’s old iPhone" /></label>
        <button className="primary" type="submit" disabled={!custom.trim()}>Save</button>
      </form>
    </Sheet>
  )
}

const pct = (sent: number, size: number) => (size ? Math.min(100, Math.floor((sent / size) * 100)) : 0)

function stateText(it: UploadItem): string {
  switch (it.state) {
    case 'waiting': return 'Waiting'
    case 'reading': return 'Reading the clip…'
    case 'uploading': return `${fmtBytes(it.sent)} of ${fmtBytes(it.size)}${it.resumed ? ' · resumed' : ''}`
    case 'retrying': return it.note ?? 'Trying again…'
    case 'saving': return 'Checking it in Drive…'
    case 'done': return `In Drive · ${fmtBytes(it.driveSize ?? it.size)}, same size as on the phone`
    case 'failed': return it.error ?? 'Failed'
  }
}

/** Progress for a product's uploads: overall, then one row per clip. */
export function UploadPanel({ productId }: { productId: string }) {
  const all = useUploads().filter((it) => it.productId === productId)
  if (!all.length) return null
  const active = all.filter(isActive)
  const size = all.reduce((n, it) => n + it.size, 0)
  const sent = all.reduce((n, it) => n + (it.state === 'done' ? it.size : it.sent), 0)
  const done = all.filter((it) => it.state === 'done').length
  const failed = all.filter((it) => it.state === 'failed').length
  const converted = all.filter((it) => it.state === 'done' && it.codec === 'h264')

  return (
    <section className="up card">
      <div className="up-head">
        <b>{active.length ? `Uploading ${done + 1} of ${all.length}` : failed ? `${failed} clip${failed === 1 ? '' : 's'} didn’t upload` : `${done} clip${done === 1 ? '' : 's'} in Drive`}</b>
        <span>{active.length ? `${pct(sent, size)}%` : <button className="link" onClick={() => clearUploads(productId)}>OK</button>}</span>
      </div>
      <div className="bar"><i style={{ width: `${pct(sent, size)}%` }} /></div>
      {active.length > 0 && (
        <p className="up-note">
          Keep the app open until this finishes: it stops if you switch apps or lock the phone, and carries on when you come back.
          {wakeLockSupported() ? ' The screen stays on meanwhile.' : ''}
        </p>
      )}
      <ul className="up-list">
        {all.map((it) => (
          <li key={it.id} className={`up-${it.state}`}>
            <div className="up-row">
              <span className="up-name">{it.name}</span>
              <span className="up-meta">{[fmtDuration(it.duration), it.codec ? CODEC_LABEL[it.codec] ?? it.codec : null].filter(Boolean).join(' · ')}</span>
            </div>
            {isActive(it) && <div className="bar bar-sm"><i style={{ width: `${pct(it.sent, it.size)}%` }} /></div>}
            <div className="up-state">
              <span>{stateText(it)}</span>
              {it.state === 'failed' && <button className="link" onClick={() => retryUpload(it.id)}>Try again</button>}
            </div>
          </li>
        ))}
      </ul>
      {converted.length > 0 && (
        <p className="flag">
          {converted.length === 1 ? 'This clip came' : `${converted.length} clips came`} through as H.264, so the photo picker probably made a smaller copy
          (unless the camera is set to Most Compatible). Next time: {ORIGINAL_TIP.replace(/^For full quality: /, '')}
        </p>
      )}
    </section>
  )
}

/** A small bar on other screens while clips are uploading, linking back to the product. */
export function UploadBar() {
  const items = useUploads()
  const { pathname } = useLocation()
  const active = items.filter(isActive)
  if (!active.length) return null
  const productId = active[0].productId
  if (pathname.endsWith(`/product/${productId}`)) return null
  const size = items.filter((it) => it.productId === productId).reduce((n, it) => n + it.size, 0)
  const sent = items.filter((it) => it.productId === productId).reduce((n, it) => n + (it.state === 'done' ? it.size : it.sent), 0)
  return (
    <Link to={`/product/${productId}`} className="upbar">
      <span><b>Uploading {active.length} clip{active.length === 1 ? '' : 's'} · {pct(sent, size)}%</b><small>{active[0].productName} · keep the app open</small></span>
      <span aria-hidden>›</span>
    </Link>
  )
}

const driveFileUrl = (id: string) => `https://drive.google.com/file/d/${id}/view`

/** Clips (or finished videos) recorded for a product, each opening in Drive. */
export function ClipList({ media, empty }: { media: Media[]; empty: string }) {
  if (!media.length) return <p className="empty">{empty}</p>
  return (
    <ul className="list">
      {media.map((m) => (
        <li key={m.id}>
          <a className="row" href={m.drive_file_id ? driveFileUrl(m.drive_file_id) : '#'} target="_blank" rel="noreferrer">
            <span className="row-main" style={{ minWidth: 0 }}>
              <span className="row-title clip-name">{m.filename}</span>
              <span className="row-sub">
                {[
                  fmtDuration(m.duration_s),
                  m.kind === 'finished_horizontal' ? 'Horizontal' : m.kind === 'finished_vertical' ? 'Vertical' : null,
                  m.kind === 'raw_clip' ? (m.shot_on ?? (m.uploaded_by ? null : 'Added in Drive')) : null,
                  fmtBytes(m.size_bytes),
                  m.codec ? CODEC_LABEL[m.codec] ?? m.codec : null,
                ].filter(Boolean).map((t, i) => <span key={i}>{t}</span>)}
              </span>
            </span>
            <span className="chev" aria-hidden>↗</span>
          </a>
        </li>
      ))}
    </ul>
  )
}
