import { supabase } from './supabase'

/**
 * Sets the day a product arrived by hand (null clears it). A date typed by Charly is never an
 * estimate, so the flag is cleared; before migration 0010 the date is saved without it.
 */
export async function saveReceived(productId: string, date: string | null) {
  let res = await supabase.from('products').update({ received_at: date, received_estimated: false }).eq('id', productId)
  if (res.error && /received_estimated/.test(res.error.message)) res = await supabase.from('products').update({ received_at: date }).eq('id', productId)
  return res
}
