/**
 * Save video to phone: download a finished video from Drive (through the signed media link) in
 * 8 MiB Range pieces, each retried on its own, then hand it to the iOS share sheet (Save Video),
 * or offer a plain download where sharing files isn't supported. The share must be a fresh tap:
 * iOS forgets the first tap while a big file downloads.
 */
import { finishedFile, type FinishedFile } from './functions'

const PIECE = 8 * 1024 * 1024
const TRIES = 4

export interface Download {
  file: FinishedFile
  received: number
  done: File | null
}

// the last finished download, so leaving the screen and coming back doesn't fetch it again
let kept: { key: string; file: File; meta: FinishedFile } | null = null

export function keptDownload(key: string): { file: File; meta: FinishedFile } | null {
  return kept?.key === key ? kept : null
}

async function piece(url: string, from: number, to: number, signal: AbortSignal): Promise<ArrayBuffer> {
  let last: unknown
  for (let t = 0; t < TRIES; t++) {
    if (t) await new Promise((r) => setTimeout(r, 800 * 2 ** t))
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal })
      if (res.status === 403) throw Object.assign(new Error('expired'), { fatal: true })
      if (res.status !== 206 && res.status !== 200) throw new Error(`The download answered ${res.status}.`)
      const buf = await res.arrayBuffer()
      // a server that ignores Range sends the whole file: take the part we asked for
      if (res.status === 200 && buf.byteLength > to - from + 1) return buf.slice(from, to + 1)
      return buf
    } catch (e) {
      if (signal.aborted || (e as { fatal?: boolean }).fatal) throw e
      last = e
    }
  }
  throw last instanceof Error ? last : new Error('The download stopped.')
}

/** Downloads the file in pieces; onProgress(received, total). Throws on abort. */
export async function downloadFinished(
  productId: string, kind: 'finished_vertical' | 'finished_horizontal',
  onProgress: (d: Download) => void, signal: AbortSignal,
): Promise<File> {
  let meta = await finishedFile(productId, kind)
  const key = `${productId}:${meta.drive_file_id}`
  const have = keptDownload(key)
  if (have) {
    onProgress({ file: meta, received: meta.size, done: have.file })
    return have.file
  }
  const parts: ArrayBuffer[] = []
  let received = 0
  onProgress({ file: meta, received, done: null })
  const total = meta.size
  let lock: WakeLockSentinel | null = null
  try {
    lock = 'wakeLock' in navigator ? await navigator.wakeLock.request('screen').catch(() => null) : null
    if (!total) {
      // size unknown (rare): one plain download
      const res = await fetch(meta.url, { signal })
      if (!res.ok) throw new Error(`The download answered ${res.status}.`)
      parts.push(await res.arrayBuffer())
      received = parts[0].byteLength
    }
    while (received < total) {
      const to = Math.min(received + PIECE, total) - 1
      let buf: ArrayBuffer
      try {
        buf = await piece(meta.url, received, to, signal)
      } catch (e) {
        if ((e as Error).message !== 'expired') throw e
        meta = await finishedFile(productId, kind)   // link older than 6 hours: a new one, same file
        continue
      }
      if (!buf.byteLength) throw new Error('The download stopped.')
      parts.push(buf)
      received += buf.byteLength
      onProgress({ file: meta, received, done: null })
    }
  } finally {
    lock?.release().catch(() => {})
  }
  const name = /\.(mp4|mov|m4v)$/i.test(meta.filename) ? meta.filename : `${meta.filename}.mp4`
  const file = new File(parts, name, { type: meta.mime || 'video/mp4' })
  kept = { key, file, meta }
  onProgress({ file: meta, received, done: file })
  return file
}

export const canShareFile = (file: File) => {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
  } catch {
    return false
  }
}

/** Opens the share sheet with the video (iOS: Save Video). False when sharing files isn't possible here. */
export async function shareVideo(file: File, text?: string): Promise<'shared' | 'cancelled' | 'unsupported'> {
  if (!canShareFile(file)) return 'unsupported'
  try {
    await navigator.share({ files: [file], ...(text ? { text } : {}) })
    return 'shared'
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'cancelled'
    throw e
  }
}
