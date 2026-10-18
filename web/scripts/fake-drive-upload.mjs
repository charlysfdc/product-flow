// Dev only: a stand-in for Drive's resumable upload endpoint, for checking the
// clip uploader in demo mode (npm run dev, /?demo=1) without touching Drive.
//   node scripts/fake-drive-upload.mjs            listens on :8787
//   DROP=0.2 node scripts/fake-drive-upload.mjs   cuts 20% of chunk PUTs off half-way
//   EXPOSE=0 ...                                  hides the Range header from the browser
//   SLOW=500 ...                                  waits 500 ms before answering each chunk
//   HANG=0.2 ...                                  takes 20% of chunks and never answers
// Like Drive: 308 + Range while incomplete, 200 + the file at the end, bytes */N
// asks for status, and a cut-off chunk keeps what arrived in whole 256 KiB blocks.
import http from 'node:http'

const DROP = Number(process.env.DROP ?? 0)
const EXPOSE = process.env.EXPOSE !== '0'
const SLOW = Number(process.env.SLOW ?? 0)
const HANG = Number(process.env.HANG ?? 0)
const sessions = new Map()      // id → { size, received, name }
const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin ?? '*',
  'Access-Control-Allow-Methods': 'PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-range, content-type',
  ...(EXPOSE ? { 'Access-Control-Expose-Headers': 'range' } : {}),
})

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const h = cors(req.headers.origin)
  if (req.method === 'OPTIONS') return res.writeHead(204, h).end()
  if (req.method === 'POST' && url.pathname === '/start') {
    const id = Math.random().toString(36).slice(2)
    sessions.set(id, { size: Number(url.searchParams.get('size')), received: 0, name: url.searchParams.get('name') ?? 'clip' })
    return res.writeHead(200, { ...h, 'Content-Type': 'application/json' }).end(JSON.stringify({ url: `http://localhost:8787/upload/${id}` }))
  }
  const s = sessions.get(url.pathname.split('/')[2])
  if (req.method !== 'PUT' || !s) return res.writeHead(404, h).end('{"error":{"message":"no such session"}}')
  const range = /bytes (\*|(\d+)-(\d+))\/(\d+)/.exec(req.headers['content-range'] ?? '')
  const answer = () => {
    if (s.received >= s.size) return res.writeHead(200, { ...h, 'Content-Type': 'application/json' }).end(JSON.stringify({ id: `fake-${s.name}`, name: s.name, size: String(s.size) }))
    res.writeHead(308, s.received ? { ...h, Range: `bytes=0-${s.received - 1}` } : h).end()
  }
  if (!range || range[1] === '*') { req.resume(); return req.on('end', answer) }
  const start = Number(range[2])
  if (start !== s.received) { req.resume(); return req.on('end', answer) }
  let got = 0, cut = false
  const drop = Math.random() < DROP
  req.on('data', (b) => {
    if (cut) return
    got += b.length
    if (drop && got > 2 * 1024 * 1024) {
      s.received += Math.floor(got / (256 * 1024)) * 256 * 1024
      console.log(`drop at ${s.received}`)
      cut = true
      req.socket.destroy()
    }
  })
  req.on('end', () => {
    if (cut) return
    s.received += got
    console.log(`${s.name}: ${s.received}/${s.size}`)
    if (Math.random() < HANG) return console.log('hang')
    setTimeout(answer, SLOW)
  })
}).listen(8787, () => console.log(`fake Drive upload on :8787 (drop ${DROP}, expose Range ${EXPOSE})`))
