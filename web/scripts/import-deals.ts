/**
 * One-time / command-line ViralVue import, same code as the Settings button.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY='sb_secret_...' \
 *   npx tsx scripts/import-deals.ts ~/Downloads/amazon-brand-deals.csv
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { importDeals } from '../src/lib/deals'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SECRET_KEY
const file = process.argv[2]
if (!url || !key || !file) {
  console.error('Usage: SUPABASE_URL=... SUPABASE_SECRET_KEY=... npx tsx scripts/import-deals.ts <export.csv>')
  process.exit(1)
}
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
importDeals(client, readFileSync(file, 'utf8')).then((s) => {
  console.log(JSON.stringify(s, null, 2))
  process.exit(s.errors.length ? 2 : 0)
})
