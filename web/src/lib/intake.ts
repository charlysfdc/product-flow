/**
 * Add product helpers: camera frames and photos, barcode reading (ZXing in
 * WebAssembly, since iOS Safari has no BarcodeDetector), link parsing and
 * duplicate checks. Pages stay free of canvas and wasm details.
 */
import { BarcodeDetector, prepareZXingModule } from 'barcode-detector/ponyfill'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { supabase } from './supabase'
import type { Product } from './types'

// Serve the ZXing binary from this app instead of a CDN, so scanning works from the home-screen app.
prepareZXingModule({
  overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
})

let detector: BarcodeDetector | null = null
function getDetector() {
  detector ??= new BarcodeDetector({ formats: ['ean_13', 'upc_a', 'upc_e', 'ean_8', 'code_128'] })
  return detector
}

/** First retail barcode in the image, digits only, or null. */
export async function readBarcode(source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap): Promise<string | null> {
  try {
    const found = await getDetector().detect(source)
    const hit = found.find((b) => /^\d{8,14}$/.test(b.rawValue))
    return hit ? hit.rawValue : null
  } catch {
    return null
  }
}

export interface Photo {
  base64: string    // JPEG without the data: prefix, for the edge functions
  dataUrl: string   // for showing it on screen
  width: number
  height: number
  canvas: HTMLCanvasElement
}

const MAX_SIDE = 1600

function toPhoto(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, srcW: number, srcH: number): Photo {
  const scale = Math.min(1, MAX_SIDE / Math.max(srcW, srcH))
  const w = Math.round(srcW * scale), h = Math.round(srcH * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  draw(canvas.getContext('2d')!, w, h)
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), dataUrl, width: w, height: h, canvas }
}

/** The current camera frame as a JPEG (longest side 1600 px). */
export function captureFrame(video: HTMLVideoElement): Photo {
  return toPhoto((ctx, w, h) => ctx.drawImage(video, 0, 0, w, h), video.videoWidth, video.videoHeight)
}

/** A photo from the file picker (camera or library), turned upright and scaled down. */
export async function fileToPhoto(file: File): Promise<Photo> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return toPhoto((ctx, w, h) => ctx.drawImage(img, 0, 0, w, h), img.naturalWidth, img.naturalHeight)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** ASIN from an Amazon product link (/dp/, /gp/product/, /product/), if it is in the URL itself. */
export function asinFromUrl(url: string): string | null {
  const m = url.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?#]|$)/i)
  return m ? m[1].toUpperCase() : null
}

export function looksLikeUrl(text: string): boolean {
  return /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/|$)/i.test(text.trim())
}

/** A product you already have with this barcode or ASIN, so the same box is not added twice. */
export async function findExisting(hint: { upc?: string | null; asin?: string | null }): Promise<Product | null> {
  if (hint.upc) {
    const variants = Array.from(new Set([hint.upc, hint.upc.replace(/^0/, ''), hint.upc.length === 12 ? `0${hint.upc}` : hint.upc]))
    const { data } = await supabase.from('products').select('*').in('upc', variants).limit(1)
    if (data?.length) return data[0] as Product
  }
  if (hint.asin) {
    const { data } = await supabase.from('listings').select('product_id').ilike('external_id', hint.asin).limit(1)
    if (data?.length) {
      const { data: p } = await supabase.from('products').select('*').eq('id', data[0].product_id).maybeSingle()
      if (p) return p as Product
    }
  }
  return null
}

export async function findByName(name: string): Promise<Product | null> {
  const { data } = await supabase.from('products').select('*').ilike('name', name.trim()).limit(1)
  return (data?.[0] as Product | undefined) ?? null
}

/** A short, folder-friendly name from a long listing title. */
export function shortName(title: string | null | undefined): string {
  let t = (title ?? '').replace(/\s+/g, ' ').trim()
  for (const sep of [' - ', ' | ', ', ', ' (', ' with ', ' for ']) {
    const i = t.indexOf(sep)
    if (i >= 18) t = t.slice(0, i)
  }
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '')
  return t.replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
}
