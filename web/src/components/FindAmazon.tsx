import { useState } from 'react'
import { Sheet } from './Sheet'
import { applyCandidate, enrich, lookupLink, searchAmazon, wouldFill, type Candidate } from '../lib/amazon'
import { fmtPrice, type Product } from '../lib/types'

type Step =
  | { at: 'start' }
  | { at: 'busy'; say: string }
  | { at: 'pick'; candidates: Candidate[] }
  | { at: 'confirm'; c: Candidate; from: Candidate[] | null }
  | { at: 'done'; filled: string[] }

/**
 * Find on Amazon: paste a link (amazon.com, a.co, or an ASIN) or search by name, pick the right product,
 * confirm. Fills the picture, brand, price and Amazon US listing only where they are empty.
 * `onNext` (the Missing details list) moves on to the next product after it's done.
 */
export function FindAmazonSheet({ product: p, hasAmazonListing, onClose, onDone, onNext, nextLabel }: {
  product: Product
  hasAmazonListing: boolean
  onClose: () => void
  onDone: () => void
  onNext?: () => void
  nextLabel?: string
}) {
  const [step, setStep] = useState<Step>({ at: 'start' })
  const [link, setLink] = useState('')
  const [query, setQuery] = useState([p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? p.brand : null, p.name].filter(Boolean).join(' '))
  const [error, setError] = useState<string | null>(null)

  const run = async (say: string, fn: () => Promise<void>) => {
    setError(null)
    const back = step
    setStep({ at: 'busy', say })
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
      setStep(back.at === 'busy' ? { at: 'start' } : back)
    }
  }

  const byLink = () => run('Opening the Amazon page…', async () => {
    const c = await lookupLink(link)
    setStep({ at: 'confirm', c, from: null })
  })
  const byName = () => run('Searching Amazon…', async () => {
    const r = await searchAmazon(query)
    if (!r.candidates.length) throw new Error(r.note ?? 'Amazon found nothing for that name. Try fewer words, or paste the link.')
    setStep({ at: 'pick', candidates: r.candidates })
  })
  const pick = (c: Candidate, from: Candidate[]) => run('Reading the product page…', async () => {
    setStep({ at: 'confirm', c: await enrich(c), from })
  })
  const confirm = (c: Candidate) => run('Saving…', async () => {
    const filled = await applyCandidate(p, c)
    onDone()
    setStep({ at: 'done', filled })
  })

  return (
    <Sheet title="Find on Amazon" onClose={onClose}>
      <p className="muted small"><b>{p.name}</b>{p.brand ? ` · ${p.brand}` : ''}. Fills only what is empty: picture, brand, price and the Amazon US listing.</p>
      {error && <p className="error small">{error}</p>}

      {step.at === 'start' && (
        <>
          <form className="form" onSubmit={(e) => { e.preventDefault(); if (link.trim()) byLink() }}>
            <label>Paste an Amazon link or ASIN
              <input inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="amazon.com/dp/…, a.co/… or B0…" value={link} onChange={(e) => setLink(e.target.value)} />
            </label>
            <button className="primary" type="submit" disabled={!link.trim()}>Look it up</button>
          </form>
          <form className="form" onSubmit={(e) => { e.preventDefault(); if (query.trim()) byName() }}>
            <label>Or search Amazon by name
              <input autoCapitalize="none" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <button className="secondary" type="submit" disabled={query.trim().length < 3}>Search by name</button>
          </form>
        </>
      )}

      {step.at === 'busy' && <p className="muted">{step.say}</p>}

      {step.at === 'pick' && (
        <>
          <p className="small">Tap the one that is your product.</p>
          <ul className="list">
            {step.candidates.map((c) => (
              <li key={c.asin}>
                <button className="row row-btn" onClick={() => pick(c, step.candidates)}>
                  {c.image_url ? <img src={c.image_url} alt="" className="thumb thumb-lg" /> : <span className="thumb-ph thumb-lg" aria-hidden>?</span>}
                  <span className="row-main"><span className="row-title amz-title">{c.title}</span><span className="row-sub"><span>{fmtPrice(c.price) ?? 'No price shown'}</span><span>{c.asin}</span></span></span>
                </button>
              </li>
            ))}
          </ul>
          <button className="link" onClick={() => setStep({ at: 'start' })}>None of these</button>
        </>
      )}

      {step.at === 'confirm' && (() => {
        const c = step.c
        const f = wouldFill(p, hasAmazonListing, c)
        const any = f.listing || f.picture || f.brand || f.price
        return (
          <>
            <div className="amz-pick">
              {c.image_url && <img src={c.image_url} alt="" className="product-img" />}
              <b>{c.title}</b>
              <span className="muted small">{[c.brand, fmtPrice(c.price), c.asin].filter(Boolean).join(' · ')} · <a href={c.url} target="_blank" rel="noreferrer">open on Amazon ↗</a></span>
            </div>
            <p className="small"><b>Is this the same product?</b> {any ? 'Confirming fills:' : 'Everything is already filled; nothing would change.'}</p>
            {any && (
              <ul className="amz-fills">
                {f.listing && <li>Amazon US listing {c.asin}</li>}
                {f.picture && <li>the picture</li>}
                {f.brand && <li>brand {c.brand}</li>}
                {f.price && <li>price {fmtPrice(c.price)}</li>}
              </ul>
            )}
            {hasAmazonListing && <p className="muted small">It already has an Amazon US listing; that stays as it is.</p>}
            <div className="actions">
              <button className="primary" disabled={!any} onClick={() => confirm(c)}>Yes, use this one</button>
              <button className="link" onClick={() => setStep(step.from ? { at: 'pick', candidates: step.from } : { at: 'start' })}>{step.from ? 'Back to the results' : 'Not this one'}</button>
            </div>
          </>
        )
      })()}

      {step.at === 'done' && (
        <>
          <p className="sv-ok">✓ Filled: {step.filled.length ? step.filled.join(', ') : 'nothing new'}.</p>
          <div className="actions">
            {onNext ? <button className="primary" onClick={onNext}>{nextLabel ?? 'Next product'}</button> : <button className="primary" onClick={onClose}>Done</button>}
            {onNext && <button className="link" onClick={onClose}>Stop here</button>}
          </div>
        </>
      )}
      {onNext && step.at !== 'done' && step.at !== 'busy' && <button className="link" onClick={onNext}>Skip this product</button>}
    </Sheet>
  )
}
