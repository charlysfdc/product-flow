/** Dry look at a ViralVue export: which received deals match by ASIN, look like an existing product, or would be created. */
import { createClient } from '@supabase/supabase-js'
import { parseViralVueDeals, suggestProducts, selectAll } from '../src/lib/deals'
import { readFileSync } from 'node:fs'
async function main() {
  const c = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } })
  const products = await selectAll<any>((a, b) => c.from('products').select('id,name,brand').range(a, b))
  const listings = await selectAll<any>((a, b) => c.from('listings').select('product_id,external_id').eq('platform', 'amazon_us').range(a, b))
  const byAsin = new Map(listings.map((l: any) => [l.external_id, l.product_id]))
  const d = parseViralVueDeals(readFileSync(process.argv[2], 'utf8'))
  for (const x of d.filter((x) => x.received_at)) {
    const asinHit = byAsin.get(x.asin!)
    const s = suggestProducts(x, products, 3)
    console.log((asinHit ? 'ASIN  ' : s.length ? 'REVIEW' : 'CREATE') + ' | ' + x.brand + ' | ' + (x.title || '').slice(0, 40) + (s.length ? ' -> ' + s.map((p: any) => p.name).join(' / ') : ''))
  }
}
main()
