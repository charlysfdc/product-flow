import { useEffect, type ReactNode } from 'react'

/** Bottom sheet for a quick choice or a small form. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="link" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Options<T extends string>({
  options, value, onPick,
}: { options: { value: T; label: string; help?: string }[]; value: T | null; onPick: (v: T) => void }) {
  return (
    <ul className="options">
      {options.map((o) => (
        <li key={o.value}>
          <button className={'option' + (o.value === value ? ' option-on' : '')} onClick={() => onPick(o.value)}>
            <span className="option-label">{o.label}</span>
            {o.help && <span className="option-help">{o.help}</span>}
            {o.value === value && <span className="tick" aria-label="current">✓</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}
