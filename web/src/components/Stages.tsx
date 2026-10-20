import { Link } from 'react-router-dom'
import { STATUS_ORDER, type Job, type Product, type ProductStatus } from '../lib/types'

export type Stage = 'film' | 'edit' | 'review' | 'post'
type State = 'done' | 'next' | 'todo' | 'off'

const reached = (p: Product, s: ProductStatus) => STATUS_ORDER.indexOf(p.status) >= STATUS_ORDER.indexOf(s)

/** The next stage, from the status and the edit jobs: received → Film, filmed → Edit, editing → Edit or Review, ready → Post. */
export function nextStage(p: Product, active: Job | undefined, review: Job | undefined): Stage | null {
  switch (p.status) {
    case 'expected':
    case 'received': return 'film'
    case 'filmed': return 'edit'
    case 'editing': return review && !active ? 'review' : 'edit'
    case 'ready': return active ? 'edit' : review ? 'review' : 'post'
    case 'done': return active ? 'edit' : review ? 'review' : null
  }
}

/**
 * Film · Edit · Review · Post, always all four. The next step is filled; the others stay tappable
 * (to go back and film or edit more); finished ones carry a tick. Review is off when no edit waits.
 */
export function StageBar({ product: p, jobs, clips, posted, onFilm, onEdit }: {
  product: Product
  jobs: Job[]
  clips: number
  posted: { done: number; of: number }
  onFilm: () => void
  onEdit: () => void
}) {
  const edits = jobs.filter((j) => j.type === 'edit').sort((a, b) => b.created_at.localeCompare(a.created_at))
  const active = edits.find((j) => j.status === 'queued' || j.status === 'running')
  const review = edits.find((j) => j.status === 'needs_review')
  const next = nextStage(p, active, review)
  const pct = active?.output?.progress?.pct ?? active?.progress?.pct ?? 0

  const state = (s: Stage, done: boolean): State => (s === next ? 'next' : done ? 'done' : 'todo')
  const film = state('film', reached(p, 'filmed') || clips > 0)
  const edit = state('edit', !active && (reached(p, 'ready') || Boolean(review)))
  const rev: State = review ? (next === 'review' ? 'next' : 'todo') : reached(p, 'ready') && !active ? 'done' : 'off'
  const post = state('post', p.status === 'done')

  const cls = (st: State) => `stg stg-${st}`
  const mark = (st: State, n: number) => <span className="stg-dot" aria-hidden>{st === 'done' ? '✓' : n}</span>

  return (
    <nav className="stages" aria-label="Stages">
      <button className={cls(film)} onClick={onFilm} aria-current={film === 'next' ? 'step' : undefined}>
        {mark(film, 1)}<b>Film</b><small>{clips ? `${clips} clip${clips === 1 ? '' : 's'}` : film === 'next' ? 'Next' : film === 'done' ? 'Done' : 'No clips'}</small>
      </button>
      <button className={cls(edit)} onClick={onEdit} aria-current={edit === 'next' ? 'step' : undefined}>
        {mark(edit, 2)}<b>Edit</b><small>{active ? (active.status === 'queued' ? 'Waiting' : `${pct}%`) : edit === 'next' ? 'Next' : edit === 'done' ? 'Edit more' : ''}</small>
      </button>
      {review ? (
        <Link className={cls(rev)} to={`/review/${review.id}`} aria-current={rev === 'next' ? 'step' : undefined}>
          {mark(rev, 3)}<b>Review</b><small>{rev === 'next' ? 'Next' : 'Waiting'}</small>
        </Link>
      ) : (
        <span className={cls(rev)} aria-disabled="true" title="No edit is waiting for review">
          {mark(rev, 3)}<b>Review</b><small>{rev === 'done' ? 'Approved' : 'No edit waiting'}</small>
        </span>
      )}
      <Link className={cls(post)} to={`/publish/${p.id}`} aria-current={post === 'next' ? 'step' : undefined}>
        {mark(post, 4)}<b>Post</b><small>{posted.of ? `${posted.done}/${posted.of}` : post === 'next' ? 'Next' : ''}</small>
      </Link>
    </nav>
  )
}
