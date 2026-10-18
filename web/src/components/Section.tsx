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
 * A Home row in the "After that" list: a big count, a verb and a one-line hint;
 * tapping opens the products underneath. Open/closed is remembered per device.
 * Long lists show a preview of `preview` rows with a "Show all N" link.
 */
export function Section({ id, title, sub, count, defaultOpen = false, preview, children, empty }: {
  id: string
  title: string
  sub?: string | null
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
        <span className="sec-big">{count.toLocaleString()}</span>
        <span className="sec-title">{title}{sub && <span className="sec-sub">{sub}</span>}</span>
        <span className={'disc' + (open ? ' disc-open' : '')} aria-hidden>›</span>
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
