import { useEffect, useRef, useState } from 'react'
import { copyText } from '../lib/viralvue'
import { canShareFile, downloadFinished, shareVideo, type Download } from '../lib/save'
import { fmtBytes } from '../lib/upload'

/** A one-tap Copy button with "Copied" feedback. */
export function CopyButton({ text, label = 'Copy', className = 'copy-btn' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = window.setTimeout(() => setState('idle'), 1800)
    return () => window.clearTimeout(t)
  }, [state])
  return (
    <button type="button" className={className} disabled={!text} onClick={() => copyText(text).then((ok) => setState(ok ? 'ok' : 'fail'))}>
      {state === 'ok' ? 'Copied ✓' : state === 'fail' ? 'Copy failed' : label}
    </button>
  )
}

/** Editable text with a Copy button; saves when the field loses focus. */
export function CopyField({ label, value, onChange, onSave, max, rows = 2, hint }: {
  label: string
  value: string
  onChange: (v: string) => void
  onSave: () => void
  max?: number
  rows?: number
  hint?: string
}) {
  const over = max != null && value.length > max
  return (
    <div className="cf">
      <div className="cf-head">
        <span className="cf-label">{label}</span>
        {max != null && <span className={'cf-count' + (over ? ' cf-over' : '')}>{value.length}/{max}</span>}
        <CopyButton text={value} />
      </div>
      <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} onBlur={onSave} />
      {hint && <p className="cf-hint">{hint}</p>}
    </div>
  )
}

type SaveState =
  | { at: 'idle' }
  | { at: 'loading'; d: Download | null }
  | { at: 'ready'; file: File }
  | { at: 'saved' }
  | { at: 'error'; message: string }

/**
 * Save video to phone: download from Drive with progress, then a second tap opens the share
 * sheet (Save Video). Where files can't be shared, a download link instead.
 */
export function SaveVideo({ productId, kind, label = 'Save video to phone', onSaved }: {
  productId: string
  kind: 'finished_vertical' | 'finished_horizontal'
  label?: string
  onSaved?: () => void
}) {
  const [s, setS] = useState<SaveState>({ at: 'idle' })
  const abort = useRef<AbortController | null>(null)
  const [href, setHref] = useState<string | null>(null)
  useEffect(() => () => { abort.current?.abort() }, [])
  useEffect(() => () => { if (href) URL.revokeObjectURL(href) }, [href])
  useEffect(() => { abort.current?.abort(); setS({ at: 'idle' }) }, [kind])

  const start = async () => {
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    setS({ at: 'loading', d: null })
    try {
      const file = await downloadFinished(productId, kind, (d) => !ac.signal.aborted && setS({ at: 'loading', d }), ac.signal)
      if (ac.signal.aborted) return
      if (!canShareFile(file)) setHref(URL.createObjectURL(file))
      setS({ at: 'ready', file })
    } catch (e) {
      if (!ac.signal.aborted) setS({ at: 'error', message: (e as Error).message })
    }
  }

  const share = async (file: File) => {
    try {
      const r = await shareVideo(file)
      if (r === 'shared') { setS({ at: 'saved' }); onSaved?.() }
      if (r === 'unsupported') setHref(URL.createObjectURL(file))
    } catch (e) {
      setS({ at: 'error', message: `The share sheet didn't open: ${(e as Error).message}` })
    }
  }

  if (s.at === 'loading') {
    const total = s.d?.file.size ?? 0
    const got = s.d?.received ?? 0
    const pct = total ? Math.floor((got / total) * 100) : 0
    return (
      <div className="sv">
        <div className="sv-head"><span>{s.d ? `Downloading ${s.d.file.filename}` : 'Finding the video in Drive…'}</span><span>{total ? `${pct}%` : ''}</span></div>
        <div className="bar"><i style={{ width: `${pct}%` }} /></div>
        <div className="sv-foot"><span>{total ? `${got ? fmtBytes(got) : '0 MB'} of ${fmtBytes(total)}` : ''}</span><button className="link" onClick={() => { abort.current?.abort(); setS({ at: 'idle' }) }}>Stop</button></div>
        {total > 400 * 1024 * 1024 && <p className="cf-hint">A big file: keep this screen open until it finishes.</p>}
      </div>
    )
  }
  if (s.at === 'ready') {
    return (
      <div className="sv">
        {href ? (
          <>
            <a className="sv-btn" href={href} download={s.file.name}>Download {s.file.name}</a>
            <p className="cf-hint">This browser can’t hand videos to the share sheet. Download it, then save it from Files to Photos.</p>
          </>
        ) : (
          <>
            <button className="sv-btn" onClick={() => share(s.file)}>Save to Photos…</button>
            <p className="cf-hint">{fmtBytes(s.file.size)} downloaded. In the share sheet tap <b>Save Video</b>.</p>
          </>
        )}
      </div>
    )
  }
  if (s.at === 'saved') {
    return (
      <div className="sv">
        <p className="sv-ok">✓ Saved. It’s the newest video in Photos.</p>
        <button className="link" onClick={() => setS({ at: 'idle' })}>Save it again</button>
      </div>
    )
  }
  return (
    <div className="sv">
      <button className="sv-btn" onClick={start}>{label}</button>
      {s.at === 'error' && <p className="error small">{s.message} <button className="link" onClick={start}>Try again</button></p>}
    </div>
  )
}
