import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { Job, Listing, Post, Product } from './types'

export interface Snapshot {
  products: Product[]
  listings: Listing[]
  posts: Post[]
  jobs: Job[]
}

/** Loads everything Home needs (a few hundred small rows) and refreshes when rows change. */
export function useSnapshot() {
  const [data, setData] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [p, l, po, j] = await Promise.all([
      supabase.from('products').select('*').order('name'),
      supabase.from('listings').select('id,product_id,platform,external_id,url,commission,availability,availability_note,checked_at'),
      supabase.from('posts').select('id,product_id,platform,status,title,url,posted_at,views'),
      supabase.from('jobs').select('id,product_id,type,status,question,created_at').eq('status', 'needs_review'),
    ])
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
}

export function useProduct(id: string | undefined) {
  const [detail, setDetail] = useState<ProductDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    ;(async () => {
      const [p, l, po, j] = await Promise.all([
        supabase.from('products').select('*').eq('id', id).single(),
        supabase.from('listings').select('*').eq('product_id', id).order('platform'),
        supabase.from('posts').select('*').eq('product_id', id).order('posted_at', { ascending: false }),
        supabase.from('jobs').select('*').eq('product_id', id).order('created_at', { ascending: false }),
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
      })
    })()
    return () => {
      cancelled = true
    }
  }, [id, tick])

  return { detail, error, reload }
}
