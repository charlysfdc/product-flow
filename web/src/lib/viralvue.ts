/**
 * ViralVue reminders: ticks to do by hand in ViralVue, which has no API and no page per deal.
 * Its brand-deals list finds a deal by ASIN, so every reminder copies the ASIN and opens that list.
 * Shared by the app and scripts/import-deals.ts (the import clears ticks ViralVue already shows).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ViralVueReminder, ViralVueTask } from './types'

export const VIRALVUE_DEALS_URL = 'https://app.viralvue.com/my-amazon/brand-deals'

export const TASK_LABEL: Record<ViralVueTask, string> = {
  received: 'Tick Received in ViralVue',
  published: 'Tick Video published in ViralVue',
  message: 'Message the brand in ViralVue',
}

export const TASK_DONE: Record<ViralVueTask, string> = {
  received: 'Received ticked in ViralVue',
  published: 'Video published ticked in ViralVue',
  message: 'Brand messaged in ViralVue',
}

export const TASK_HELP: Record<ViralVueTask, string> = {
  received: 'The box is here; ViralVue still shows it as not received.',
  published: 'The Amazon video is up; add it to the brand deal.',
  message: 'The video is published but the brand was never messaged.',
}

/** The table is missing until migration 0007 is applied: treat as no reminders. */
const missing = (e: { code?: string; message?: string } | null) =>
  Boolean(e && (e.code === '42P01' || e.code === 'PGRST205' || /viralvue_reminders/.test(e.message ?? '')))

/** Adds a reminder unless one for this deal and tick exists (done or not). */
export async function addReminders(client: SupabaseClient, dealIds: string[], kind: ViralVueTask): Promise<void> {
  if (!dealIds.length) return
  const { error } = await client.from('viralvue_reminders')
    .upsert(dealIds.map((deal_id) => ({ deal_id, kind })), { onConflict: 'deal_id,kind', ignoreDuplicates: true })
  if (error && !missing(error)) throw new Error(`ViralVue reminder: ${error.message}`)
}

/** Ticks done: by hand ("Done in ViralVue") or because an export shows them. */
export async function closeReminders(client: SupabaseClient, dealIds: string[], kind: ViralVueTask, how: 'manual' | 'import', userId?: string | null): Promise<number> {
  let closed = 0
  for (let i = 0; i < dealIds.length; i += 200) {
    const { data, error } = await client.from('viralvue_reminders')
      .update({ done_at: new Date().toISOString(), done_how: how, ...(userId ? { done_by: userId } : {}) })
      .in('deal_id', dealIds.slice(i, i + 200)).eq('kind', kind).is('done_at', null).select('id')
    if (error) {
      if (missing(error)) return 0
      throw new Error(`ViralVue reminder: ${error.message}`)
    }
    closed += data?.length ?? 0
  }
  return closed
}

export async function markReminderDone(client: SupabaseClient, id: string): Promise<void> {
  const { data } = await client.auth.getUser()
  const { error } = await client.from('viralvue_reminders')
    .update({ done_at: new Date().toISOString(), done_how: 'manual', done_by: data.user?.id ?? null }).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function undoReminder(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('viralvue_reminders').update({ done_at: null, done_how: null, done_by: null }).eq('id', id)
  if (error) throw new Error(error.message)
}

const SELECT = 'id,deal_id,kind,created_at,done_at,deal:deals(id,asin,brand,title,image_url,product_id)'

/** Open reminders, oldest first; [] before migration 0007. */
export async function openReminders(client: SupabaseClient, dealIds?: string[]): Promise<ViralVueReminder[]> {
  if (dealIds && !dealIds.length) return []
  let q = client.from('viralvue_reminders').select(SELECT).is('done_at', null).order('created_at')
  if (dealIds) q = q.in('deal_id', dealIds)
  const { data, error } = await q
  if (error) return []
  return (data ?? []) as unknown as ViralVueReminder[]
}

/**
 * Copies the ASIN (what ViralVue's search finds a deal by). Call it straight from the tap,
 * so iOS lets the page write to the clipboard; the link itself opens ViralVue.
 */
export function copyForViralVue(asin: string | null | undefined, fallback?: string | null): Promise<boolean> {
  const text = (asin ?? fallback ?? '').trim()
  if (!text) return Promise.resolve(false)
  return copyText(text)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // older iOS or no permission: the hidden-textarea copy still works inside a tap
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      ta.setSelectionRange(0, text.length)
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
