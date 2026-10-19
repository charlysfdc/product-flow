import { Link } from 'react-router-dom'
import type { Product } from '../lib/types'
import { STATUS_LABEL } from '../lib/types'

export function daysUntil(date: string | null): number | null {
  if (!date) return null
  const d = new Date(date + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - today.getTime()) / 86400000)
}

export function deadlineText(date: string | null): string | null {
  const n = daysUntil(date)
  if (n === null) return null
  if (n < 0) return `${-n} day${n === -1 ? '' : 's'} overdue`
  if (n === 0) return 'Due today'
  if (n === 1) return 'Due tomorrow'
  return `Due in ${n} days`
}

/** Product photo, or its initials on a tinted tile when there is none. */
export function Thumb({ src, name, className = 'thumb' }: { src: string | null | undefined; name: string; className?: string }) {
  if (src) return <img src={src} alt="" className={className} loading="lazy" />
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')
  return <span className={className === 'thumb' ? 'thumb-ph' : `thumb-ph ${className}`} aria-hidden>{initials}</span>
}

export function ProductRow({ product, detail, showStatus, to }: { product: Product; detail?: string | null; showStatus?: boolean; to?: string }) {
  const due = deadlineText(product.deadline)
  const n = daysUntil(product.deadline)
  return (
    <li>
      <Link to={to ?? `/product/${product.id}`} className="row">
        <Thumb src={product.product_image_url} name={product.name} />
        <div className="row-main">
          <div className="row-title">{product.name}</div>
          <div className="row-sub">
            {product.brand && <span>{product.brand}</span>}
            {detail && <span>{detail}</span>}
            {showStatus && <span>{STATUS_LABEL[product.status]}</span>}
          </div>
        </div>
        {due && <span className={'due' + (n !== null && n <= 2 ? ' due-hot' : '')}>{due}</span>}
        <span className="chev" aria-hidden>›</span>
      </Link>
    </li>
  )
}
