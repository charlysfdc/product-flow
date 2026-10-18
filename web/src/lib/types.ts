export type ProductStatus = 'expected' | 'received' | 'filmed' | 'editing' | 'ready' | 'done'
export type ProductSource = 'amazon_sample' | 'tiktok_sample' | 'bought' | 'brand_direct' | 'unknown'
export type Platform =
  | 'amazon_us' | 'amazon_ca' | 'amazon_uk' | 'amazon_de' | 'amazon_nl'
  | 'tiktok_shop' | 'instagram' | 'facebook' | 'youtube' | 'pinterest'
export type Availability = 'exact' | 'similar_only' | 'not_listed' | 'unchecked'

export interface Product {
  id: string
  name: string
  brand: string | null
  variant: string | null
  upc: string | null
  source: ProductSource
  status: ProductStatus
  deadline: string | null
  drive_folder_id: string | null
  drive_folder_name: string | null
  product_image_url: string | null
  received_at: string | null
  notes: string | null
  updated_at: string
}

export interface Listing {
  id: string
  product_id: string
  platform: Platform
  external_id: string | null
  url: string | null
  commission: string | null
  availability: Availability
  availability_note: string | null
  checked_at: string | null
}

export interface Post {
  id: string
  product_id: string
  platform: Platform
  status: 'planned' | 'posted'
  external_id: string | null
  title: string | null
  url: string | null
  posted_at: string | null
  views: number | null
}

export interface Job {
  id: string
  product_id: string | null
  type: 'identify' | 'edit' | 'thumbnail'
  status: 'queued' | 'running' | 'needs_review' | 'done' | 'failed'
  question: string | null
  created_at: string
}

export function driveFolderUrl(p: Pick<Product, 'drive_folder_id' | 'drive_folder_name'>): string | null {
  if (p.drive_folder_id) return `https://drive.google.com/drive/folders/${p.drive_folder_id}`
  if (p.drive_folder_name) return `https://drive.google.com/drive/search?q=${encodeURIComponent(p.drive_folder_name)}`
  return null
}

export const STATUS_ORDER: ProductStatus[] = ['expected', 'received', 'filmed', 'editing', 'ready', 'done']

export const STATUS_LABEL: Record<ProductStatus, string> = {
  expected: 'On its way',
  received: 'Not filmed',
  filmed: 'Filmed, not edited',
  editing: 'Editing',
  ready: 'Edited, not posted',
  done: 'Posted',
}

export const STATUS_HELP: Record<ProductStatus, string> = {
  expected: 'A sample is coming but has not arrived.',
  received: 'It is here, nothing filmed yet.',
  filmed: 'Raw clips exist; no finished video yet.',
  editing: 'A cut is being made.',
  ready: 'A finished video exists, not posted everywhere yet.',
  done: 'Posted on every planned platform.',
}

export const SOURCE_ORDER: ProductSource[] = ['amazon_sample', 'tiktok_sample', 'bought', 'brand_direct']

export const SOURCE_LABEL: Record<ProductSource, string> = {
  amazon_sample: 'Amazon sample',
  tiktok_sample: 'TikTok Shop sample',
  bought: 'Bought',
  brand_direct: 'Brand direct',
  unknown: 'Where from? Tap to set',
}

export const SOURCE_HELP: Record<ProductSource, string> = {
  amazon_sample: 'Free sample from Amazon; it needs an Amazon video.',
  tiktok_sample: 'TikTok Shop sample; it needs a TikTok Shop video by the deadline.',
  bought: 'Bought with your own money; post it anywhere.',
  brand_direct: 'Sent by the brand; post wherever they asked.',
  unknown: 'Not recorded yet.',
}

export const PLATFORM_ORDER: Platform[] = [
  'amazon_us', 'amazon_ca', 'amazon_uk', 'amazon_de', 'amazon_nl',
  'tiktok_shop', 'instagram', 'facebook', 'youtube', 'pinterest',
]

export const PLATFORM_LABEL: Record<Platform, string> = {
  amazon_us: 'Amazon US',
  amazon_ca: 'Amazon CA',
  amazon_uk: 'Amazon UK',
  amazon_de: 'Amazon DE',
  amazon_nl: 'Amazon NL',
  tiktok_shop: 'TikTok Shop',
  instagram: 'Instagram',
  facebook: 'Facebook',
  youtube: 'YouTube',
  pinterest: 'Pinterest',
}

export const AVAILABILITY_LABEL: Record<Availability, string> = {
  exact: 'Exact product',
  similar_only: 'Similar only',
  not_listed: 'Not listed',
  unchecked: 'Not checked',
}
