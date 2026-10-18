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

export function ProductRow({ product, detail, showStatus }: { product: Product; detail?: string | null; showStatus?: boolean }) {
  const due = deadlineText(product.deadline)
  const n = daysUntil(product.deadline)
  return (
    <li>
      <Link to={`/product/${product.id}`} className="row">
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
