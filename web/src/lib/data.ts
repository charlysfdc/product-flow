import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { ACTIVE_DEAL_STATUSES, quietCutoffIso, type Deal, type Job, type Listing, type Media, type Post, type Product, type ViralVueReminder } from './types'
import { openReminders } from './viralvue'

export interface Snapshot {
  products: Product[]
  listings: Listing[]
  posts: Post[]
  jobs: Job[]
  deals: Deal[]          // received deals waiting for an answer
  waiting: number        // deals still waiting on the brand (shown)
  quiet: number          // waiting deals that went quiet (hidden)
  reminders: ViralVueReminder[]   // ticks to do by hand in ViralVue ([] before migration 0007)
}

/** PostgREST filter for "still waiting": brand is talking, or messaged within 30 days. */
export function stillWaitingFilter(): string {
  const cutoff = quietCutoffIso()
  return `status_raw.in.(${ACTIVE_DEAL_STATUSES.join(',')}),message_sent_at.gt.${cutoff},and(message_sent_at.is.null,deal_created_at.gt.${cutoff})`
}

/** Loads everything Home needs (a few hundred small rows) and refreshes when rows change. */
export function useSnapshot() {
  const [data, setData] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [p, l, po, j, d, w, wAll, vv] = await Promise.all([
      supabase.from('products').select('*').order('name'),
      supabase.from('listings').select('id,product_id,platform,external_id,url,commission,availability,availability_note,checked_at'),
      supabase.from('posts').select('id,product_id,platform,status,external_id,title,url,posted_at,views'),
      supabase.from('jobs').select('id,product_id,type,status,question,created_at,updated_at,progress:output->progress').in('status', ['needs_review', 'queued', 'running']),
      supabase.from('deals').select('*').eq('match_status', 'needs_review').order('deal_created_at', { ascending: false }),
      supabase.from('deals').select('id', { count: 'exact', head: true }).eq('match_status', 'waiting').or(stillWaitingFilter()),
      supabase.from('deals').select('id', { count: 'exact', head: true }).eq('match_status', 'waiting'),
      openReminders(supabase),
    ])
    // deals may not exist yet (migration 0002 pending): treat as empty
    const err = p.error ?? l.error ?? po.error ?? j.error
    if (err) {
      setError(err.message)
      return
    }
    setError(null)
    setData({
      products: (p.data ?? []) as Product[],
      listings: (l.data ?? []) as Listing[],
      posts: (po.data ?? []) as Post[],
      jobs: (j.data ?? []) as Job[],
      deals: (d.error ? [] : (d.data ?? [])) as Deal[],
      waiting: w.count ?? 0,
      quiet: Math.max(0, (wAll.count ?? 0) - (w.count ?? 0)),
      reminders: vv,
    })
  }, [])

  useEffect(() => {
    load()
    let timer: number | undefined
    const bump = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(load, 300)
    }
    const channel = supabase
      .channel('home')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deals' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'viralvue_reminders' }, bump)
      .subscribe()
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      supabase.removeChannel(channel)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearTimeout(timer)
    }
  }, [load])

  return { data, error, reload: load }
}

export interface ProductDetail {
  product: Product
  listings: Listing[]
  posts: Post[]
  jobs: Job[]
  deals: Deal[]
  media: Media[]
}

export function useProduct(id: string | undefined) {
  const [detail, setDetail] = useState<ProductDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])

  // live: the edit worker's progress, and the finished files it records
  useEffect(() => {
    if (!id) return
    let timer: number | undefined
    const bump = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(reload, 250)
    }
    const channel = supabase
      .channel(`product-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs', filter: `product_id=eq.${id}` }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products', filter: `id=eq.${id}` }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'posts', filter: `product_id=eq.${id}` }, bump)
      .subscribe()
    const onVisible = () => { if (document.visibilityState === 'visible') reload() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      supabase.removeChannel(channel)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearTimeout(timer)
    }
  }, [id, reload])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    ;(async () => {
      const [p, l, po, j, d, m] = await Promise.all([
        supabase.from('products').select('*').eq('id', id).single(),
        supabase.from('listings').select('*').eq('product_id', id).order('platform'),
        supabase.from('posts').select('*').eq('product_id', id).order('posted_at', { ascending: false }),
        supabase.from('jobs').select('*').eq('product_id', id).order('created_at', { ascending: false }),
        supabase.from('deals').select('*').eq('product_id', id).order('deal_created_at', { ascending: false }),
        supabase.from('media').select('*').eq('product_id', id).order('filename'),
      ])
      if (cancelled) return
      const err = p.error ?? l.error ?? po.error ?? j.error
      if (err) {
        setError(err.message)
        return
      }
      setDetail({
        product: p.data as Product,
        listings: (l.data ?? []) as Listing[],
        posts: (po.data ?? []) as Post[],
        jobs: (j.data ?? []) as Job[],
        deals: (d.error ? [] : (d.data ?? [])) as Deal[],
        media: (m.error ? [] : (m.data ?? [])) as Media[],
      })
    })()
    return () => {
      cancelled = true
    }
  }, [id, tick])

  return { detail, error, reload }
}
