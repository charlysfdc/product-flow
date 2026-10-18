import { useState, type ReactNode } from 'react'

const KEY = 'pf.sections'

function readState(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}
  } catch {
    return {}
  }
}
function writeState(id: string, open: boolean) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readState(), [id]: open }))
  } catch {
    /* private mode or blocked storage: the tap still works for this view */
  }
}

/**
 * A Home section with a compact tappable header showing the count. Open/closed
 * is remembered per device. Long lists can show a preview of `preview` rows
 * with a "Show all N" link instead of collapsing.
 */
export function Section({ id, title, count, defaultOpen = true, preview, children, empty }: {
  id: string
  title: string
  count: number
  defaultOpen?: boolean
  preview?: number
  empty?: string
  children: (limit: number | undefined) => ReactNode
}) {
  const [open, setOpen] = useState<boolean>(() => readState()[id] ?? defaultOpen)
  const [all, setAll] = useState(false)
  const toggle = () => {
    setOpen(!open)
    writeState(id, !open)
  }
  const limit = preview && !all && count > preview ? preview : undefined
  return (
    <section className="sec">
      <button className="sec-head" onClick={toggle} aria-expanded={open}>
        <span className={'disc' + (open ? ' disc-open' : '')} aria-hidden>›</span>
        <span className="sec-title">{title}</span>
        <span className="count">{count}</span>
      </button>
      {open && (count === 0 && empty ? <p className="empty">{empty}</p> : (
        <>
          {children(limit)}
          {limit !== undefined && (
            <button className="link show-all" onClick={() => setAll(true)}>Show all {count}</button>
          )}
        </>
      ))}
    </section>
  )
}
