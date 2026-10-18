/**
 * Upload clips from the phone straight into Drive (Products/<product>/raw).
 *
 * The drive function opens a resumable upload session with Charly's token and
 * hands back only the session URL; the phone PUTs the file to it in 8 MiB
 * chunks. A dropped connection asks Drive how much arrived and carries on from
 * there. The queue lives at module level, so moving between screens doesn't
 * stop it; closing the app does (a home-screen web app can't upload in the
 * background), and picking the same file again resumes its session.
 */
import { useSyncExternalStore } from 'react'
import { callFunction } from './functions'

const CHUNK = 8 * 1024 * 1024          // a multiple of 256 KiB, as Drive requires
const MAX_TRIES = 12                   // per stretch without progress
const RESUME_KEY = 'pf.uploads'        // file → session URL, for picking the same file again
const PHONE_KEY = 'pf.phone'

export type UploadState = 'waiting' | 'reading' | 'uploading' | 'retrying' | 'saving' | 'done' | 'failed'

export interface UploadItem {
  id: string
  productId: string
  productName: string
  file: File
  name: string
  size: number
  sent: number
  state: UploadState
  error: string | null
  note: string | null          // e.g. "Connection dropped, trying again in 4 s"
  codec: string | null
  duration: number | null
  width: number | null
  height: number | null
  driveSize: number | null     // what Drive says it holds, once done
  resumed: boolean
}

/* ---------- this phone's name (shot_on) ---------- */

export function phoneName(): string {
  try { return localStorage.getItem(PHONE_KEY) ?? '' } catch { return '' }
}
export function setPhoneName(name: string) {
  try { localStorage.setItem(PHONE_KEY, name.trim()) } catch { /* private mode: asked again next time */ }
}

/* ---------- store ---------- */

let items: UploadItem[] = []
const listeners = new Set<() => void>()
const emit = () => { items = [...items]; listeners.forEach((l) => l()) }
const patch = (id: string, p: Partial<UploadItem>) => {
  items = items.map((it) => (it.id === id ? { ...it, ...p } : it))
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l) }

export function useUploads(): UploadItem[] {
  return useSyncExternalStore(subscribe, () => items)
}

export const isActive = (it: UploadItem) => it.state !== 'done' && it.state !== 'failed'

/** Queue files for a product; they upload one at a time. */
export function addUploads(product: { id: string; name: string }, files: File[]) {
  for (const file of files) {
    items.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, productId: product.id, productName: product.name, file,
      name: file.name, size: file.size, sent: 0, state: 'waiting', error: null, note: null,
      codec: null, duration: null, width: null, height: null, driveSize: null, resumed: false,
    })
  }
  emit()
  run()
}

export function retryUpload(id: string) {
  patch(id, { state: 'waiting', error: null, note: null })
  run()
}

/** Clear finished (and failed) rows for a product once they have been seen. */
export function clearUploads(productId: string) {
  items = items.filter((it) => it.productId !== productId || isActive(it))
  emit()
}

/* ---------- keep the screen on ---------- */

let lock: WakeLockSentinel | null = null
async function holdScreen() {
  try {
    if (lock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return
    lock = await navigator.wakeLock.request('screen')
    lock.addEventListener('release', () => { lock = null })
  } catch { /* not allowed here (Low Power Mode, older iOS): the note asks to keep the app open */ }
}
function releaseScreen() {
  lock?.release().catch(() => {})
  lock = null
}
export const wakeLockSupported = () => typeof navigator !== 'undefined' && 'wakeLock' in navigator

/* ---------- runner ---------- */

let running = false
let wake: (() => void) | null = null        // cuts a retry wait short when the app comes back

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (items.some(isActive)) holdScreen()
    wake?.()
  })
  window.addEventListener('online', () => wake?.())
  window.addEventListener('beforeunload', (e) => { if (items.some(isActive)) e.preventDefault() })
}

const sleep = (ms: number) => new Promise<void>((resolve) => {
  const t = window.setTimeout(done, ms)
  function done() { window.clearTimeout(t); wake = null; resolve() }
  wake = done
})

async function run() {
  if (running) return
  running = true
  holdScreen()
  try {
    for (let next = items.find((it) => it.state === 'waiting'); next; next = items.find((it) => it.state === 'waiting')) {
      await uploadOne(next.id)
    }
  } finally {
    running = false
    releaseScreen()
  }
}

const get = (id: string) => items.find((it) => it.id === id)!

async function uploadOne(id: string) {
  const it = get(id)
  try {
    if (it.duration === null && it.codec === null) {
      patch(id, { state: 'reading' })
      const [meta, codec] = await Promise.all([readVideoMeta(it.file), sniffCodec(it.file)])
      patch(id, { ...meta, codec })
    }
    patch(id, { state: 'uploading', note: null })
    const file = await sendFile(id)
    patch(id, { state: 'saving', sent: it.size, driveSize: Number(file.size) })
    if (Number(file.size) !== it.size) throw new Error(`Drive got ${fmtBytes(Number(file.size))} of ${fmtBytes(it.size)}. Tap Try again.`)
    const cur = get(id)
    await withRetry(id, () => callFunction('drive', {
      action: 'finish_upload', product_id: it.productId, drive_file_id: file.id, size: it.size,
      duration_s: cur.duration, width: cur.width, height: cur.height, codec: cur.codec, shot_on: phoneName() || null,
    }))
    forgetSession(it.file)
    patch(id, { state: 'done', note: null })
  } catch (e) {
    patch(id, { state: 'failed', error: (e as Error).message, note: null })
  }
}

/** Retries a call through dropped connections, waiting longer each time. */
async function withRetry<T>(id: string, fn: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await fn()
    } catch (e) {
      if (tries >= MAX_TRIES || !isNetworkError(e)) throw e
      await backoff(id, tries)
    }
  }
}

async function backoff(id: string, tries: number) {
  const ms = Math.min(30000, 1000 * 2 ** (tries - 1))
  const why = navigator.onLine === false ? 'No connection' : 'Connection dropped'
  patch(id, { state: 'retrying', note: `${why}, trying again in ${Math.round(ms / 1000)} s` })
  await sleep(ms)
  patch(id, { state: 'uploading', note: null })
}

const isNetworkError = (e: unknown) => e instanceof NetError || /network|fetch|load failed|not reachable|timed out|502|503|504/i.test((e as Error)?.message ?? '')

class NetError extends Error {}
class ExpiredError extends Error {}

interface DriveFileResult { id: string; name: string; size: string }

/** Sends the whole file (resuming a stored session when there is one); returns Drive's file. */
async function sendFile(id: string): Promise<DriveFileResult> {
  const it = get(id)
  let url = storedSession(it.file, it.productId)
  let offset = 0
  if (url) {
    const st = await withRetry(id, () => status(url!, it.size)).catch(() => ({ expired: true } as Status))
    if (st.file) return st.file
    if (st.expired) { forgetSession(it.file); url = null }
    else { offset = st.received ?? 0; patch(id, { resumed: offset > 0, sent: offset }) }
  }
  if (!url) {
    const r = await withRetry(id, () => callFunction<{ upload_url: string }>('drive', {
      action: 'start_upload', product_id: it.productId, filename: it.name, size: it.size,
      mime: it.file.type || mimeFromName(it.name), origin: window.location.origin,
    }))
    url = r.upload_url
    rememberSession(it.file, it.productId, url)
  }

  let tries = 0, stalls = 0
  for (;;) {
    const end = Math.min(offset + CHUNK, it.size)
    try {
      const res = await putChunk(url, it.file, offset, end, it.size, (loaded) => patch(id, { sent: offset + loaded }))
      if (res.file) return res.file
      const before = offset
      offset = res.received ?? (await status(url, it.size)).received ?? 0
      // Drive took the chunk but reports no progress: stop rather than loop forever
      if (offset <= before && ++stalls >= 5) throw new Error('Drive stopped taking this file. Tap Try again.')
      if (offset > before) stalls = 0
      tries = 0
      patch(id, { sent: offset })
    } catch (e) {
      if (e instanceof ExpiredError) {
        // the session is gone (over a week old, or Drive dropped it): start again from the beginning
        forgetSession(it.file)
        return sendFile(id)
      }
      if (!(e instanceof NetError) || ++tries >= MAX_TRIES) throw e
      await backoff(id, tries)
      const st = await withRetry(id, () => status(url!, it.size))
      if (st.file) return st.file
      if (st.expired) { forgetSession(it.file); return sendFile(id) }
      offset = st.received ?? 0
      patch(id, { sent: offset })
    }
  }
}

interface Status { received?: number; file?: DriveFileResult; expired?: boolean }

/** How much of the file Drive has, asked through the function (it can always read Drive's Range header). */
const status = (url: string, size: number) => callFunction<Status>('drive', { action: 'upload_status', upload_url: url, size })

/** One chunk PUT. XHR rather than fetch: fetch can't report upload progress. */
function putChunk(url: string, file: File, start: number, end: number, total: number, onProgress: (loaded: number) => void): Promise<Status> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.timeout = 5 * 60 * 1000
    xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${total}`)
    xhr.upload.onprogress = (e) => onProgress(e.loaded)
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        try { resolve({ file: JSON.parse(xhr.responseText) as DriveFileResult }) } catch { reject(new NetError('Drive sent an unreadable answer')) }
      } else if (xhr.status === 308) {
        const range = xhr.getResponseHeader('Range')
        // without a readable Range header, ask the function rather than assume the chunk arrived
        resolve(range ? { received: Number(range.split('-')[1]) + 1 } : {})
      } else if (xhr.status === 404 || xhr.status === 410) {
        reject(new ExpiredError('The upload session expired'))
      } else if (xhr.status >= 500 || xhr.status === 429 || xhr.status === 0) {
        reject(new NetError(`Drive answered ${xhr.status}`))
      } else {
        let msg = `Drive refused the upload (${xhr.status})`
        try { msg = JSON.parse(xhr.responseText)?.error?.message ?? msg } catch { /* keep */ }
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => reject(new NetError('network error'))
    xhr.ontimeout = () => reject(new NetError('timed out'))
    xhr.send(file.slice(start, end))
  })
}

/* ---------- sessions remembered per file (valid about a week at Drive) ---------- */

const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`
function sessions(): Record<string, { url: string; product: string; at: number }> {
  try { return JSON.parse(localStorage.getItem(RESUME_KEY) ?? '{}') } catch { return {} }
}
function saveSessions(s: ReturnType<typeof sessions>) {
  const week = Date.now() - 6 * 86400000
  try { localStorage.setItem(RESUME_KEY, JSON.stringify(Object.fromEntries(Object.entries(s).filter(([, v]) => v.at > week)))) } catch { /* ignore */ }
}
function storedSession(f: File, product: string): string | null {
  const s = sessions()[fileKey(f)]
  return s && s.product === product && s.at > Date.now() - 6 * 86400000 ? s.url : null
}
function rememberSession(f: File, product: string, url: string) {
  const s = sessions()
  s[fileKey(f)] = { url, product, at: Date.now() }
  saveSessions(s)
}
function forgetSession(f: File) {
  const s = sessions()
  delete s[fileKey(f)]
  saveSessions(s)
}

/* ---------- reading the clip before it goes ---------- */

function mimeFromName(name: string) {
  if (/\.mov$/i.test(name)) return 'video/quicktime'
  if (/\.(mp4|m4v)$/i.test(name)) return 'video/mp4'
  return 'application/octet-stream'
}

/** Duration and display size, from a video element (rotation already applied). */
function readVideoMeta(file: File): Promise<{ duration: number | null; width: number | null; height: number | null }> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    const url = URL.createObjectURL(file)
    const done = (r: { duration: number | null; width: number | null; height: number | null }) => {
      window.clearTimeout(t)
      URL.revokeObjectURL(url)
      v.removeAttribute('src')
      v.load()
      resolve(r)
    }
    const t = window.setTimeout(() => done({ duration: null, width: null, height: null }), 10000)
    v.preload = 'metadata'
    v.muted = true
    v.onloadedmetadata = () => done({
      duration: Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : null,
      width: v.videoWidth || null,
      height: v.videoHeight || null,
    })
    v.onerror = () => done({ duration: null, width: null, height: null })
    v.src = url
  })
}

const SAMPLE_ENTRIES: [string, string][] = [
  ['hvc1', 'hevc'], ['hev1', 'hevc'], ['dvh1', 'hevc'], ['dvhe', 'hevc'],
  ['avc1', 'h264'], ['avc3', 'h264'],
  ['apch', 'prores'], ['apcn', 'prores'], ['apcs', 'prores'], ['apco', 'prores'], ['ap4h', 'prores'], ['ap4x', 'prores'],
]

/**
 * The video codec, from the first sample entry in the file's moov box. The
 * iPhone records HEVC (or ProRes); an H.264 file from it means the picker converted it.
 */
async function sniffCodec(file: File): Promise<string | null> {
  try {
    const u32 = (b: DataView, o: number) => b.getUint32(o)
    let offset = 0
    for (let n = 0; n < 64 && offset + 8 <= file.size; n++) {
      const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer())
      let size = u32(head, 0)
      const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7))
      if (size === 1) size = Number(head.getBigUint64(8))
      else if (size === 0) size = file.size - offset
      if (size < 8) return null
      if (type === 'moov') {
        const bytes = new Uint8Array(await file.slice(offset, offset + Math.min(size, 4 * 1024 * 1024)).arrayBuffer())
        const text = new TextDecoder('latin1').decode(bytes)
        let best: { at: number; codec: string } | null = null
        for (const [tag, codec] of SAMPLE_ENTRIES) {
          const at = text.indexOf(tag)
          if (at >= 0 && (!best || at < best.at)) best = { at, codec }
        }
        return best?.codec ?? null
      }
      offset += size
    }
  } catch { /* unreadable: leave unknown */ }
  return null
}

/* ---------- formatting ---------- */

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return ''
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(n / 1e3))} KB`
}

export function fmtDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return ''
  const m = Math.floor(s / 60), sec = Math.round(s % 60)
  return m ? `${m}:${String(sec).padStart(2, '0')}` : `${Math.max(1, sec)} s`
}

export const CODEC_LABEL: Record<string, string> = { hevc: 'HEVC', h264: 'H.264', prores: 'ProRes' }
