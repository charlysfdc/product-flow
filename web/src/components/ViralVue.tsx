import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { ViralVueReminder } from '../lib/types'
import { TASK_DONE, TASK_HELP, TASK_LABEL, VIRALVUE_DEALS_URL, copyForViralVue, markReminderDone, openReminders, undoReminder } from '../lib/viralvue'
import { Thumb } from './ProductRow'

/** Open ViralVue reminders for some deals (a product's), refreshed by `tick` and after Done. */
export function useReminders(dealIds: string[] | null, tick = 0) {
  const [items, setItems] = useState<ViralVueReminder[]>([])
  const key = dealIds?.join(',') ?? ''
  const load = useCallback(() => {
    if (dealIds === null) return
    openReminders(supabase, dealIds).then(setItems)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => { load() }, [load, tick])
  return { items, reload: load }
}

/** The copy-ASIN-and-open link. The tap copies (iOS allows it only inside the tap), the link opens ViralVue. */
export function ViralVueLink({ asin, fallback, className, children, onCopied }: {
  asin: string | null | undefined
  fallback?: string | null
  className?: string
  children?: React.ReactNode
  onCopied?: (ok: boolean, text: string) => void
}) {
  return (
    <a
      className={className}
      href={VIRALVUE_DEALS_URL}
      target="_blank"
      rel="noreferrer"
      onClick={() => { copyForViralVue(asin, fallback).then((ok) => onCopied?.(ok, (asin ?? fallback ?? '').trim())) }}
    >
      {children ?? (asin ? 'Copy ASIN & open ViralVue ↗' : 'Open ViralVue ↗')}
    </a>
  )
}

/** One reminder as a card: what to tick, the ASIN, copy-and-open, and Done in ViralVue (with undo). */
export function ReminderCard({ r, onChange }: { r: ViralVueReminder; onChange: () => void }) {
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const d = r.deal
  const finish = async () => {
    setBusy(true)
    try {
      await markReminderDone(supabase, r.id)
      setDone(true)
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const undo = async () => {
    setBusy(true)
    try {
      await undoReminder(supabase, r.id)
      setDone(false)
    } finally {
      setBusy(false)
    }
  }
  if (done) {
    return (
      <div className="vv vv-done">
        <span>✓ {TASK_DONE[r.kind]}</span>
        <span className="vv-done-acts">
          <button className="link" disabled={busy} onClick={undo}>Undo</button>
          <button className="link" onClick={onChange}>OK</button>
        </span>
      </div>
    )
  }
  return (
    <div className="vv">
      <span className="eyebrow">ViralVue</span>
      <b className="vv-title">{TASK_LABEL[r.kind]}</b>
      <p>{TASK_HELP[r.kind]} {d?.asin ? <>Search ViralVue for <b className="mono">{d.asin}</b>{d.brand ? ` (${d.brand})` : ''}.</> : d?.brand ? <>Find the {d.brand} deal.</> : null}</p>
      <div className="go">
        <ViralVueLink className="pri" asin={d?.asin} fallback={d?.brand} onCopied={(ok, text) => setNote(ok ? `${text} copied. In ViralVue, paste it into the search box.` : 'Could not copy; type the ASIN into ViralVue’s search.')} />
        <button disabled={busy} onClick={finish}>Done in ViralVue</button>
      </div>
      {note && <p className="vv-note">{note}</p>}
    </div>
  )
}

/** A product's open reminders, or nothing. */
export function ProductReminders({ dealIds, tick = 0 }: { dealIds: string[]; tick?: number }) {
  const { items, reload } = useReminders(dealIds, tick)
  if (!items.length) return null
  const order = { received: 0, published: 1, message: 2 }
  return <div className="vv-list">{[...items].sort((a, b) => order[a.kind] - order[b.kind]).map((r) => <ReminderCard key={r.id} r={r} onChange={reload} />)}</div>
}

/** Home: one row per open reminder, with its own copy-and-open and Done. */
export function ReminderRow({ r, productName, onDone }: { r: ViralVueReminder; productName: string | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const d = r.deal
  const name = productName ?? d?.title ?? d?.brand ?? 'Brand deal'
  return (
    <li className="vv-row">
      <div className="row">
        <Thumb src={d?.image_url} name={name} />
        <div className="row-main">
          {d?.product_id ? <Link to={`/product/${d.product_id}`} className="row-title">{name}</Link> : <span className="row-title">{name}</span>}
          <div className="row-sub"><span>{TASK_LABEL[r.kind].replace(' in ViralVue', '')}</span>{d?.asin && <span className="mono">{d.asin}</span>}{copied && <span>Copied</span>}</div>
        </div>
      </div>
      <div className="go vv-row-go">
        <ViralVueLink className="pri" asin={d?.asin} fallback={d?.brand} onCopied={(ok) => setCopied(ok)}>{d?.asin ? 'Copy ASIN & open' : 'Open ViralVue'}</ViralVueLink>
        <button disabled={busy} onClick={async () => { setBusy(true); try { await markReminderDone(supabase, r.id); onDone() } finally { setBusy(false) } }}>Done</button>
      </div>
    </li>
  )
}
