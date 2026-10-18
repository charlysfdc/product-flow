import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { findWaitingDeals, receiveDeal, substituteDeal } from '../lib/deals'
import { callFunction, makeDriveFolder, uploadPhoto, type Identification } from '../lib/functions'
import { asinFromUrl, captureFrame, fileToPhoto, findByName, findExisting, looksLikeUrl, readBarcode, shortName, type Photo } from '../lib/intake'
import { SOURCE_LABEL, type Deal, type Product, type ProductSource } from '../lib/types'
import { Thumb } from '../components/ProductRow'
import { IconImage, IconLink, IconType } from '../components/Icons'
import { Sheet } from '../components/Sheet'

type Phase =
  | { k: 'camera' }
  | { k: 'working'; say: string }
  | { k: 'match' }
  | { k: 'confirm' }
  | { k: 'details' }
  | { k: 'saving'; say: string }
  | { k: 'drive'; productId: string; message: string }

type Choice = { deal: Deal; mode: 'sample' | 'bought' | 'substitute' }

const EMPTY_IDENT: Omit<Identification, 'via'> = {
  name: null, brand: null, variant: null, upc: null, asin: null, title: null, image_url: null,
  url: null, platform: null, tiktok_product_id: null, confidence: null, note: null,
}

const fmtDay = (ts: string | null) => (ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null)

const SOURCES: { value: ProductSource; label: string }[] = [
  { value: 'amazon_sample', label: 'Amazon sample' },
  { value: 'tiktok_sample', label: 'TikTok Shop sample' },
  { value: 'bought', label: 'I bought it' },
  { value: 'brand_direct', label: 'Brand sent it' },
]

/**
 * Add product: point the camera at the box. A barcode is read live; the shutter
 * takes a photo (read for a barcode first, then by Claude). Paste a link or type
 * a name instead. Waiting brand deals are checked first; with no deal the
 * identification goes to Confirm. Source and deadline are asked once, then the
 * product, its Drive folder and the intake photo are created.
 */
export function AddProduct() {
  const navigate = useNavigate()
  const { session } = useAuth()
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const libraryRef = useRef<HTMLInputElement>(null)
  const extraPhotoRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const handlingRef = useRef(false)

  const [phase, setPhase] = useState<Phase>({ k: 'camera' })
  const [cameraState, setCameraState] = useState<'starting' | 'on' | 'off'>('starting')
  const [scanBarcodes, setScanBarcodes] = useState(true)
  const [sheet, setSheet] = useState<'link' | 'name' | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [photo, setPhoto] = useState<Photo | null>(null)
  const [ident, setIdent] = useState<Identification | null>(null)
  const [deals, setDeals] = useState<Deal[]>([])
  const [dealIdx, setDealIdx] = useState(0)
  const [existing, setExisting] = useState<Product | null>(null)
  const [choice, setChoice] = useState<Choice | null>(null)
  const [form, setForm] = useState({ name: '', brand: '', variant: '', asin: '' })
  const [source, setSource] = useState<ProductSource>('amazon_sample')
  const [deadline, setDeadline] = useState('')

  // ---- camera -------------------------------------------------------------

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  useEffect(() => {
    if (phase.k !== 'camera') return
    let cancelled = false
    ;(async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraState('off')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
          audio: false,
        })
        if (cancelled) return stream.getTracks().forEach((t) => t.stop())
        streamRef.current = stream
        const v = videoRef.current
        if (v) {
          v.srcObject = stream
          await v.play().catch(() => undefined)
        }
        setCameraState('on')
      } catch {
        if (!cancelled) setCameraState('off')
      }
    })()
    return () => {
      cancelled = true
      stopCamera()
    }
  }, [phase.k, stopCamera])

  // ---- what happens after a scan, photo, link or name ---------------------

  const fail = (message: string) => {
    setError(message)
    setPhase({ k: 'camera' })
    handlingRef.current = false
  }

  /** Waiting deals first; otherwise straight to Confirm. */
  const decide = async (id: Identification, hint: { asin?: string | null; brand?: string | null; title?: string | null }, preFound: Deal[] = []) => {
    setIdent(id)
    setForm({ name: id.name ?? shortName(id.title) ?? '', brand: id.brand ?? '', variant: id.variant ?? '', asin: id.asin ?? '' })
    let found = preFound
    if (!found.length && (hint.asin || hint.brand || hint.title)) {
      setPhase({ k: 'working', say: 'Checking your waiting deals…' })
      found = await findWaitingDeals(supabase, hint)
    }
    const dupe = await findExisting({ upc: id.upc, asin: id.asin ?? hint.asin })
    setExisting(dupe)
    setDeals(found)
    setDealIdx(0)
    setPhase({ k: found.length ? 'match' : 'confirm' })
    handlingRef.current = false
  }

  const onBarcode = async (code: string, shot: Photo | null) => {
    setPhoto(shot)
    setPhase({ k: 'working', say: `Looking up barcode ${code}…` })
    let id: Identification = { via: 'barcode', ...EMPTY_IDENT, upc: code }
    try {
      id = { ...id, ...(await callFunction<Identification>('identify', { upc: code })), via: 'barcode', upc: code }
    } catch (e) {
      id.note = (e as Error).message
    }
    if (!id.name && !id.title && !id.brand) {
      id.note ??= 'This barcode is not in the lookup databases. Take a photo of the front of the box and Claude will read it, or type the name.'
    }
    await decide(id, { asin: id.asin, brand: id.brand, title: id.title ?? id.name })
  }

  const onPhoto = async (shot: Photo) => {
    setPhoto(shot)
    setPhase({ k: 'working', say: 'Looking for a barcode…' })
    const code = scanBarcodes ? await readBarcode(shot.canvas) : null
    if (code) return onBarcode(code, shot)
    setPhase({ k: 'working', say: 'Reading the box…' })
    try {
      const id = { ...(await callFunction<Identification>('identify', { image: shot.base64, media_type: 'image/jpeg' })), via: 'photo' as const }
      await decide(id, { asin: id.asin, brand: id.brand, title: [id.name, id.variant].filter(Boolean).join(' ') })
    } catch (e) {
      fail(`Could not read the photo: ${(e as Error).message}`)
    }
  }

  const onLink = async (raw: string) => {
    const url = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`
    setPhase({ k: 'working', say: 'Opening the link…' })
    const asin = asinFromUrl(url)
    try {
      const [byAsin, looked] = await Promise.all([
        asin ? findWaitingDeals(supabase, { asin }) : Promise.resolve([] as Deal[]),
        callFunction<Identification>('identify', { url }).catch((e: Error) => ({ ...EMPTY_IDENT, note: e.message }) as Identification),
      ])
      const id: Identification = { ...EMPTY_IDENT, ...looked, via: 'link', url, asin: looked.asin ?? asin }
      await decide(id, { asin: id.asin, brand: id.brand, title: id.title ?? id.name }, byAsin)
    } catch (e) {
      fail(`Could not open the link: ${(e as Error).message}`)
    }
  }

  const onName = async (name: string) => {
    setPhase({ k: 'working', say: 'Checking your waiting deals…' })
    const id: Identification = { ...EMPTY_IDENT, via: 'name', name: name.trim() }
    try {
      await decide(id, { brand: name.trim().split(/\s+/)[0], title: name })
    } catch (e) {
      fail((e as Error).message)
    }
  }

  // live barcode scanning while the camera is up
  useEffect(() => {
    if (phase.k !== 'camera' || cameraState !== 'on' || !scanBarcodes || sheet) return
    const timer = window.setInterval(async () => {
      const v = videoRef.current
      if (!v || handlingRef.current || v.readyState < 2) return
      const code = await readBarcode(v)
      if (code && !handlingRef.current) {
        handlingRef.current = true
        navigator.vibrate?.(40)
        const shot = captureFrame(v)
        onBarcode(code, shot)
      }
    }, 350)
    return () => window.clearInterval(timer)
    // onBarcode is recreated each render; the interval only needs the phase and camera
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.k, cameraState, scanBarcodes, sheet])

  const shutter = () => {
    if (handlingRef.current) return
    const v = videoRef.current
    if (cameraState !== 'on' || !v || v.readyState < 2) return fileRef.current?.click()
    handlingRef.current = true
    setError(null)
    onPhoto(captureFrame(v))
  }

  const onFile = async (file: File | undefined, then: 'identify' | 'keep') => {
    if (!file) return
    try {
      const shot = await fileToPhoto(file)
      if (then === 'keep') return setPhoto(shot)
      handlingRef.current = true
      setError(null)
      onPhoto(shot)
    } catch (e) {
      setError(`Could not open that photo: ${(e as Error).message}`)
    }
  }

  const restart = (keepScanning = true) => {
    setPhoto(null); setIdent(null); setDeals([]); setChoice(null); setExisting(null); setError(null)
    setScanBarcodes(keepScanning)
    handlingRef.current = false
    setPhase({ k: 'camera' })
  }

  // ---- choosing ------------------------------------------------------------

  const deal = deals[dealIdx]
  const pickDeal = (mode: Choice['mode']) => {
    if (!deal) return
    setChoice({ deal, mode })
    if (mode === 'substitute') {
      setSource('amazon_sample')
      setPhase({ k: 'confirm' })
      return
    }
    setSource(mode === 'bought' ? 'bought' : 'amazon_sample')
    if (!ident?.name) setForm((f) => ({ ...f, name: shortName(deal.title) || f.name, brand: f.brand || deal.brand || '' }))
    setPhase({ k: 'details' })
  }

  // ---- saving ---------------------------------------------------------------

  const toDrive = async (productId: string) => {
    try {
      setPhase({ k: 'saving', say: 'Making the Drive folder…' })
      await makeDriveFolder(productId)
      if (photo) {
        setPhase({ k: 'saving', say: 'Saving the photo to Drive…' })
        await uploadPhoto(productId, photo)
      }
      navigate(`/product/${productId}`, { replace: true })
    } catch (e) {
      setPhase({ k: 'drive', productId, message: (e as Error).message })
    }
  }

  const save = async () => {
    const name = form.name.trim()
    if (!name) return setError('Give it a name first.')
    setError(null)
    setPhase({ k: 'saving', say: 'Adding the product…' })
    try {
      const sameName = await findByName(name)
      if (sameName) throw new Error(`You already have a product called "${sameName.name}". Change the name, or open that one.`)
      const today = new Date().toISOString().slice(0, 10)
      let product: Product
      if (choice && choice.mode !== 'substitute') {
        product = await receiveDeal(supabase, choice.deal, { name, status: 'received', source: choice.mode === 'bought' ? 'bought' : 'amazon_sample' })
      } else {
        const ins = await supabase.from('products').insert({
          name, brand: form.brand.trim() || null, variant: form.variant.trim() || null, upc: ident?.upc ?? null,
          source, status: 'received', received_at: today, deadline: deadline || null,
          product_image_url: ident?.image_url ?? null, added_by: session?.user.id ?? null,
          notes: ident?.title && ident.title !== name ? `Listing title: ${ident.title}` : null,
        }).select('*').single()
        if (ins.error) throw ins.error
        product = ins.data as Product
        const asin = form.asin.trim().toUpperCase()
        if (/^[A-Z0-9]{10}$/.test(asin)) {
          await supabase.from('listings').insert({ product_id: product.id, platform: 'amazon_us', external_id: asin, url: `https://www.amazon.com/dp/${asin}`, availability: 'exact', checked_at: today })
        }
        if (ident?.platform === 'tiktok' && ident.url) {
          await supabase.from('listings').insert({ product_id: product.id, platform: 'tiktok_shop', external_id: ident.tiktok_product_id, url: ident.url, availability: 'exact', checked_at: today })
        }
        if (choice?.mode === 'substitute') await substituteDeal(supabase, choice.deal, product, source === 'bought' ? 'bought' : undefined)
      }
      // what the deal path did not fill: barcode, variant, deadline, who added it
      const patch: Partial<Product> & { added_by?: string } = {}
      if (!product.upc && ident?.upc) patch.upc = ident.upc
      if (!product.variant && form.variant.trim()) patch.variant = form.variant.trim()
      if (!product.brand && form.brand.trim()) patch.brand = form.brand.trim()
      if (deadline && !product.deadline) patch.deadline = deadline
      if (!product.product_image_url && ident?.image_url) patch.product_image_url = ident.image_url
      if (choice && choice.mode !== 'substitute' && session) patch.added_by = session.user.id
      if (Object.keys(patch).length) await supabase.from('products').update(patch).eq('id', product.id)
      await toDrive(product.id)
    } catch (e) {
      setError((e as Error).message)
      setPhase({ k: 'details' })
    }
  }

  // ---- screens --------------------------------------------------------------

  const showCamera = phase.k === 'camera'
  const busySay = phase.k === 'working' || phase.k === 'saving' ? phase.say : null

  return (
    <div className="add">
      <div className="add-inner">
        <div className="add-top">
          {phase.k === 'camera' || phase.k === 'working'
            ? <Link to="/" replace>Close</Link>
            : <button onClick={() => restart()}>Start over</button>}
          <span className="pill">
            {showCamera ? (scanBarcodes ? 'Barcode, or tap to photograph' : 'Photograph the front of the box') : busySay ?? 'Add product'}
          </span>
        </div>

        {(showCamera || busySay || photo || ident?.image_url || choice?.deal.image_url) && <div className="view">
          {showCamera && <video ref={videoRef} playsInline muted autoPlay style={cameraState === 'on' ? undefined : { display: 'none' }} />}
          {!showCamera && photo && <img src={photo.dataUrl} alt="The box" />}
          {!showCamera && !photo && (ident?.image_url || choice?.deal.image_url) && <img src={(ident?.image_url ?? choice?.deal.image_url)!} alt="" style={{ objectFit: 'contain', background: '#fff' }} />}
          <span className="corner c1" /><span className="corner c2" /><span className="corner c3" /><span className="corner c4" />
          {showCamera && cameraState === 'on' && scanBarcodes && <span className="scanline" />}
          {showCamera && cameraState === 'starting' && <span className="hint">Starting the camera…</span>}
          {showCamera && cameraState === 'off' && <span className="hint">The camera is not available here. Tap the button to take or choose a photo.</span>}
          {busySay && <span className="spinner" aria-label={busySay} />}
        </div>}

        {showCamera && (
          <>
            <div className="modes">
              <button className="m" onClick={() => { setText(''); setSheet('link') }}><IconLink />Paste link</button>
              <button className="shutter" onClick={shutter} aria-label="Take a photo"><i /></button>
              <button className="m" onClick={() => { setText(''); setSheet('name') }}><IconType />Type name</button>
            </div>
            <p className="add-say">
              {error ?? (scanBarcodes ? 'Hold the barcode inside the frame. No barcode? Tap the white button.' : 'Show the front of the box: brand and product name.')}
            </p>
            <div style={{ textAlign: 'center', paddingBottom: 18 }}>
              <button className="link" style={{ color: '#b6b9cc', display: 'inline-flex', gap: 6, alignItems: 'center' }} onClick={() => libraryRef.current?.click()}>
                <span style={{ width: 18, height: 18, display: 'inline-flex' }}><IconImage /></span> Choose a photo
              </button>
            </div>
          </>
        )}

        {phase.k === 'working' && <p className="add-say" style={{ paddingTop: 18 }}>{phase.say}</p>}

        {existing && (phase.k === 'match' || phase.k === 'confirm') && (
          <div className="panel">
            <span className="eyebrow warn">Already here</span>
            <h2>You already have {existing.name}</h2>
            <p>Same {existing.upc && existing.upc === ident?.upc ? 'barcode' : 'ASIN'}. Open it instead of adding a second one?</p>
            <div className="two">
              <Link className="opt pri" to={`/product/${existing.id}`} replace>Open it</Link>
              <button className="opt" onClick={() => setExisting(null)}>It’s another one</button>
            </div>
          </div>
        )}

        {phase.k === 'match' && deal && (
          <div className="panel">
            <span className="eyebrow">{deals.length > 1 ? `${deals.length} waiting deals might match` : 'Match found'}</span>
            <div className="deal-row">
              <Thumb src={deal.image_url} name={deal.brand ?? '?'} />
              <h2>Is this the {deal.brand ?? ''} deal you messaged on {fmtDay(deal.message_sent_at ?? deal.deal_created_at) ?? 'ViralVue'}?</h2>
            </div>
            <p className="small">{deal.title ?? deal.asin}</p>
            <div className="opts">
              <div className="two">
                <button className="opt pri" onClick={() => pickDeal('sample')}>Free sample</button>
                <button className="opt pri" onClick={() => pickDeal('bought')}>I bought it</button>
              </div>
              <button className="opt" onClick={() => pickDeal('substitute')}>They sent something else</button>
              <button className="opt" onClick={() => (dealIdx + 1 < deals.length ? setDealIdx(dealIdx + 1) : setPhase({ k: 'confirm' }))}>
                {dealIdx + 1 < deals.length ? 'Not this deal' : 'None of these deals'}
              </button>
            </div>
            {deals.length > 1 && (
              <ul className="others">
                {deals.slice(0, 6).map((d, i) => i !== dealIdx && (
                  <li key={d.id}>
                    <button onClick={() => setDealIdx(i)}>
                      <Thumb src={d.image_url} name={d.brand ?? '?'} />
                      <span className="row-main"><span className="row-title">{d.brand}</span><span className="row-sub small">{(d.title ?? '').slice(0, 60)} · {fmtDay(d.message_sent_at ?? d.deal_created_at)}</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {phase.k === 'confirm' && (
          <div className="panel">
            <span className={'eyebrow' + (ident?.name || ident?.title ? '' : ' ask')}>
              {choice?.mode === 'substitute' ? `Instead of the ${choice.deal.brand ?? ''} deal` : ident?.name || ident?.title ? `Found by ${ident.via === 'photo' ? 'reading the box' : ident.via}` : 'Not found'}
            </span>
            <h2>{ident?.name || ident?.title ? 'Is this it?' : choice?.mode === 'substitute' ? 'What did they send?' : 'What is it?'}</h2>
            {ident?.note && <p className="small">{ident.note}</p>}
            {ident?.confidence === 'low' && <p className="small">Claude was not sure about this one; check the name.</p>}
            <div className="form">
              <label>Name <span className="muted small">(also the Drive folder)</span>
                <input id="f-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Nextorch P82C Flashlight" />
              </label>
              <label>Brand
                <input id="f-brand" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
              </label>
              <label>Variant <span className="muted small">(colour, size; optional)</span>
                <input id="f-variant" value={form.variant} onChange={(e) => setForm({ ...form, variant: e.target.value })} />
              </label>
              <label>Amazon ASIN <span className="muted small">(optional)</span>
                <input id="f-asin" value={form.asin} onChange={(e) => setForm({ ...form, asin: e.target.value })} autoCapitalize="characters" />
              </label>
            </div>
            <div className="opts">
              <button className="opt pri" disabled={!form.name.trim()} onClick={() => setPhase({ k: 'details' })}>Looks right</button>
              {!ident?.name && !ident?.title && ident?.via === 'barcode' && (
                <button className="opt" onClick={() => restart(false)}>Take a photo of the box instead</button>
              )}
              <button className="opt" onClick={() => restart()}>Not this one</button>
            </div>
          </div>
        )}

        {phase.k === 'details' && (
          <div className="panel">
            <span className="eyebrow">{choice && choice.mode !== 'substitute' ? `${choice.deal.brand ?? 'Brand'} deal · ${choice.mode === 'bought' ? 'I bought it' : 'Free sample'}` : 'Last step'}</span>
            <h2>{form.name || 'New product'}</h2>
            <div className="form">
              {choice && choice.mode !== 'substitute' && (
                <label>Name <span className="muted small">(also the Drive folder)</span>
                  <input id="d-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </label>
              )}
              {!(choice && choice.mode !== 'substitute') && (
                <div>
                  <p className="small" style={{ margin: '0 0 6px', color: 'var(--text)', fontWeight: 600 }}>Where did it come from?</p>
                  <div className="seg">
                    {(choice?.mode === 'substitute' ? SOURCES.filter((s) => s.value === 'amazon_sample' || s.value === 'bought') : SOURCES).map((s) => (
                      <button key={s.value} aria-pressed={source === s.value} onClick={() => setSource(s.value)}>{s.value === 'amazon_sample' && choice ? 'Free sample' : s.label}</button>
                    ))}
                  </div>
                </div>
              )}
              <label>Deadline <span className="muted small">{source === 'tiktok_sample' ? '(when the TikTok Shop video is due)' : '(optional)'}</span>
                <input id="d-deadline" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </label>
            </div>
            {photo
              ? <img src={photo.dataUrl} alt="Photo of the box" className="photo" />
              : <button className="opt" onClick={() => extraPhotoRef.current?.click()}>Add a photo of the box for Drive</button>}
            {error && <p className="error">{error}</p>}
            <button className="opt pri" onClick={save}>Add product</button>
            <p className="small">It goes on Home under Film, with a Drive folder in Content Library/Products{photo ? ' holding this photo' : ''}. {choice ? '' : `Source: ${SOURCE_LABEL[source]}.`}</p>
          </div>
        )}

        {phase.k === 'drive' && (
          <div className="panel">
            <span className="eyebrow warn">Product added, Drive did not work</span>
            <h2>The Drive folder could not be made</h2>
            <p className="small">{phase.message}</p>
            <div className="opts">
              <button className="opt pri" onClick={() => toDrive(phase.productId)}>Try again</button>
              <Link className="opt" to={`/product/${phase.productId}`} replace>Skip for now</Link>
            </div>
            {photo && <p className="small">Skipping drops the photo; the product page has a Make Drive folder button for later.</p>}
          </div>
        )}
      </div>

      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { onFile(e.target.files?.[0], 'identify'); e.target.value = '' }} />
      <input ref={libraryRef} type="file" accept="image/*" hidden onChange={(e) => { onFile(e.target.files?.[0], 'identify'); e.target.value = '' }} />
      <input ref={extraPhotoRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { onFile(e.target.files?.[0], 'keep'); e.target.value = '' }} />

      {sheet === 'link' && (
        <Sheet title="Paste a link" onClose={() => setSheet(null)}>
          <form className="form" onSubmit={(e) => { e.preventDefault(); if (!looksLikeUrl(text)) return; setSheet(null); handlingRef.current = true; onLink(text) }}>
            <label>Amazon or TikTok Shop link
              <input id="s-link" type="url" inputMode="url" autoFocus placeholder="https://www.amazon.com/dp/…" value={text}
                onChange={(e) => setText(e.target.value)} onPaste={(e) => setText(e.clipboardData.getData('text'))} />
            </label>
            <button className="primary" type="submit" disabled={!looksLikeUrl(text)}>Look it up</button>
          </form>
        </Sheet>
      )}
      {sheet === 'name' && (
        <Sheet title="Type a name" onClose={() => setSheet(null)}>
          <form className="form" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; setSheet(null); handlingRef.current = true; onName(text) }}>
            <label>Brand and product
              <input id="s-name" autoFocus placeholder="e.g. Baskbed comforter" value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <button className="primary" type="submit" disabled={!text.trim()}>Continue</button>
          </form>
        </Sheet>
      )}
    </div>
  )
}
